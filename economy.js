// Persistent economy store. Atomic JSON file under ./data/economy.json so
// everything (wallets, banks, police heat, jail, crime cooldowns, owned
// businesses + houses, passive income) survives bot restarts / crashes.

const fs = require("fs");
const path = require("path");
const catalog = require("./catalog");
const stocks = require("./stocks");
const cars = require("./cars");

const DATA_DIR = path.join(__dirname, "data");
const FILE = path.join(DATA_DIR, "economy.json");

// ── Tunables ──────────────────────────────────────────────────
const DAILY_AMOUNT = 15000;

// Loans: borrow up to 2x your net worth; charged 5% interest every 5 minutes.
const LOAN_MAX_MULTIPLIER = 2;
const LOAN_INTEREST_RATE = 0.05;
const LOAN_INTEREST_PERIOD_MS = 5 * 60 * 1000;
const LOAN_COOLDOWN_MS = 12 * 60 * 60 * 1000; // must wait 12h from taking a loan before taking another
const DAY_MS = 24 * 60 * 60 * 1000;
const ROB_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes
const ROB_SUCCESS_CHANCE = 0.5;
const AWAY_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between ENTERING away mode (leaving is free)
const AUTO_AWAY_MS = 12 * 60 * 60 * 1000; // auto-away after 12h with no messages
const RACE_COOLDOWN_MS = 60 * 1000;     // 60s between AI races (!race <type>)
const MAX_CARS = 25;                      // garage cap (sell cars to make room)
const MAX_PER_BUSINESS = 10;              // you can own at most 10 of each business

// Factory / goyslop. A player can own ONE factory and upgrade it. Instead of
// money it produces "goyslop" (a resource), which is sold for cash.
const FACTORY_BASE_COST = 100000;    // cost to buy the factory (level 1)
const FACTORY_BASE_RATE = 5;         // goyslop/sec at level 1
const FACTORY_UPGRADE_MULT = 1.6;    // output x this per upgrade (cost doubles, so ROI tapers off)
const FACTORY_MAX_LEVEL = 50;        // hard cap to keep numbers sane / prevent overflow
const GOYSLOP_PRICE = 110;            // each goyslop sells for this much

// !work — quick active income with a short cooldown
const WORK_COOLDOWN_MS = 60 * 1000;  // 60s between shifts
const WORK_MIN = 700;
const WORK_MAX = 2000;
const WORK_SUCCESS_CHANCE = 0.7;     // 70% you get paid, 30% you get fired

// Largest balance we'll ever store — keeps math finite so huge numbers can't
// become Infinity/NaN and corrupt the save file.
const MAX_MONEY = 1e24; // raised for quadrillion+ late-game (lab dog-cat hybrids). JS doubles are exact up to 2^53 (~9 quadrillion); above that, balances are approximate (rounded to ~15-16 sig figs) but never overflow to Infinity/NaN or corrupt the save.

// Crime / police heat
const MAX_HEAT = 3;
const HEAT_DECAY_MS = 5 * 60 * 1000;    // heat drops 1 every 5 minutes
const CRIME_COOLDOWN_MS = 30 * 1000;    // per-crime 30s cooldown

let state = { users: {}, market: {}, bookface: { listings: {}, seq: 0 } };
let saveTimer = null;

function load() {
  try {
    if (fs.existsSync(FILE)) {
      const raw = fs.readFileSync(FILE, "utf8");
      const parsed = JSON.parse(raw);
      state = { users: parsed.users || {}, market: parsed.market || {}, bookface: parsed.bookface && typeof parsed.bookface === "object" ? parsed.bookface : { listings: {}, seq: 0 } };
    }
  } catch (e) {
    console.error("[economy] failed to load, starting fresh:", e.message);
    state = { users: {}, market: {}, bookface: { listings: {}, seq: 0 } };
  }
}
load();

function saveNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error("[economy] save failed:", e.message);
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 200);
}

// Flush on exit so an unexpected stop still persists the last change.
for (const sig of ["SIGINT", "SIGTERM", "beforeExit"]) {
  process.on(sig, () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      saveNow();
    }
  });
}

// ── Internal helpers (operate on the live user object) ─────────
function businessRate(u) {
  let r = 0;
  for (const b of u.businesses || []) {
    const def = catalog.BUSINESSES[b.key];
    if (def) r += def.rate;
  }
  return r;
}

// Accrue passive income from owned businesses. Computed lazily from elapsed
// real time, so income keeps adding up even while the bot was offline.
function accrueIncome(u) {
  const now = Date.now();
  if (!u.lastIncome) {
    u.lastIncome = now;
    return 0;
  }
  if (u.away) {
    // While away, businesses pause. Advance the clock so the away period is
    // never paid out retroactively when the player returns.
    u.lastIncome = now;
    return 0;
  }
  const rate = businessRate(u);
  if (rate <= 0) {
    u.lastIncome = now;
    return 0;
  }
  const elapsedSec = Math.floor((now - u.lastIncome) / 1000);
  if (elapsedSec <= 0) return 0;
  const income = rate * elapsedSec;
  u.wallet += income;
  u.lastIncome += elapsedSec * 1000;
  scheduleSave();
  return income;
}

// ── Factory / goyslop helpers ─────────────────────────────────
// Cost to go from `level` -> level+1. Buying (0->1) is FACTORY_BASE_COST, the
// first upgrade (1->2) is double that (100k), and it doubles every time after.
function factoryUpgradeCost(level) {
  return FACTORY_BASE_COST * Math.pow(2, level);
}

// Total cash sunk into the factory (purchase + every upgrade) — used for net worth.
function factoryInvested(u) {
  if (!u.factory) return 0;
  let total = FACTORY_BASE_COST;
  for (let lvl = 1; lvl < u.factory.level; lvl++) total += factoryUpgradeCost(lvl);
  return total;
}

// Goyslop produced per second at the factory's current level.
function factoryRate(u) {
  if (!u.factory) return 0;
  // Rounded to a whole number so goyslop always accrues in integers (no long
  // floats bloating the save file).
  return Math.round(FACTORY_BASE_RATE * Math.pow(FACTORY_UPGRADE_MULT, u.factory.level - 1));
}

// Accrue goyslop from the factory lazily from elapsed real time, so it keeps
// producing even while the bot was offline. Stored as a float; floored on use.
function accrueSlop(u) {
  if (!u.factory) return 0;
  const now = Date.now();
  if (!u.factory.lastSlop) {
    u.factory.lastSlop = now;
    return 0;
  }
  if (u.away) {
    // While away, the factory pauses. Advance the clock so no goyslop is
    // back-produced for the away period on return.
    u.factory.lastSlop = now;
    return 0;
  }
  const rate = factoryRate(u);
  const elapsedSec = Math.floor((now - u.factory.lastSlop) / 1000);
  if (elapsedSec <= 0) return 0;
  const gained = rate * elapsedSec;
  u.goyslop = (u.goyslop || 0) + gained;
  u.factory.lastSlop += elapsedSec * 1000;
  scheduleSave();
  return gained;
}

// ── Stock market ───────────────────────────────────────────────
// The market is global + shared by all players. Prices advance lazily from
// elapsed real time on access, so the first access in a new tick moves the
// price and everyone afterwards sees the same value (until the next tick).
function ensureMarket() {
  if (!state.market || typeof state.market !== "object") state.market = {};
  const now = Date.now();
  let changed = false;
  for (const key of stocks.tickerKeys()) {
    const def = stocks.STOCKS[key];
    let m = state.market[key];
    if (!m || typeof m !== "object") {
      m = { price: def.base, prev: def.base, lastTick: now };
      state.market[key] = m;
      changed = true;
    }
    if (typeof m.price !== "number" || !(m.price > 0)) m.price = def.base;
    if (typeof m.prev !== "number") m.prev = m.price;
    if (typeof m.lastTick !== "number") m.lastTick = now;
    if (!Array.isArray(m.history)) m.history = [{ t: m.lastTick, p: m.price }];
    const elapsedTicks = Math.floor((now - m.lastTick) / stocks.TICK_MS);
    if (elapsedTicks > 0) {
      const steps = Math.min(elapsedTicks, stocks.MAX_CATCHUP_TICKS);
      const newLastTick = m.lastTick + elapsedTicks * stocks.TICK_MS;
      let price = m.price;
      let prevBefore = m.price;
      const pushed = [];
      for (let i = 0; i < steps; i++) {
        prevBefore = price;
        price = stocks.stepPrice(def, price);
        pushed.push(price);
      }
      m.prev = prevBefore;            // price one tick ago, for change %
      m.price = price;
      m.lastTick = newLastTick;
      // Record per-tick price history (timestamps spaced one tick apart,
      // ending at lastTick) so !stock can show hourly/daily averages & change.
      for (let i = 0; i < pushed.length; i++) {
        m.history.push({ t: newLastTick - (pushed.length - 1 - i) * stocks.TICK_MS, p: pushed[i] });
      }
      // Keep ~24h of history; prune old points and hard-cap the array length.
      const cutoff = now - 24 * 60 * 60 * 1000 - stocks.TICK_MS;
      if (m.history.length > 4000 || (m.history[0] && m.history[0].t < cutoff)) {
        m.history = m.history.filter((h) => h && h.t >= cutoff);
        if (m.history.length > 3000) m.history = m.history.slice(m.history.length - 3000);
      }
      changed = true;
    }
  }
  if (changed) scheduleSave();
}

// Current market snapshot for all stocks (advances prices first).
function getMarket() {
  ensureMarket();
  return stocks.tickerKeys().map((key) => {
    const def = stocks.STOCKS[key];
    const m = state.market[key];
    const changePct = m.prev > 0 ? ((m.price - m.prev) / m.prev) * 100 : 0;
    return { ticker: def.ticker, name: def.name, risk: def.risk, blurb: def.blurb, price: m.price, prev: m.prev, changePct };
  });
}

function getStockPrice(ticker) {
  ensureMarket();
  const def = stocks.findStock(ticker);
  if (!def) return null;
  return state.market[def.ticker].price;
}

// Hourly/daily average price + % change for one stock, computed from the
// recorded per-tick history. Used by the `!stock <ticker>` info card.
function getStockStats(ticker) {
  ensureMarket();
  const def = stocks.findStock(ticker);
  if (!def) return null;
  const m = state.market[def.ticker];
  const now = Date.now();
  const cur = m.price;
  const hist = Array.isArray(m.history) ? m.history.filter((h) => h && typeof h.p === "number") : [];
  function windowStats(ms) {
    const cutoff = now - ms;
    const pts = hist.filter((h) => h.t >= cutoff);
    if (pts.length < 2) return { avg: cur, changePct: 0, hasData: false, samples: pts.length };
    let sum = 0;
    for (const h of pts) sum += h.p;
    const avg = sum / pts.length;
    const first = pts[0].p;
    const changePct = first > 0 ? ((cur - first) / first) * 100 : 0;
    return { avg, changePct, hasData: true, samples: pts.length };
  }
  const lastTickPct = m.prev > 0 ? ((m.price - m.prev) / m.prev) * 100 : 0;
  return {
    ticker: def.ticker, name: def.name, risk: def.risk, blurb: def.blurb,
    price: cur, lastTickPct,
    hour: windowStats(60 * 60 * 1000),
    day: windowStats(24 * 60 * 60 * 1000),
  };
}

// Buy a whole number of shares at the current price (charged wallet-then-bank).
function buyStock(id, tickerInput, sharesInput) {
  ensureMarket();
  const def = stocks.findStock(tickerInput);
  if (!def) return { ok: false, reason: "no such stock" };
  const u = ensure(id);
  const price = state.market[def.ticker].price;
  const shares = Math.floor(Number(sharesInput));
  if (!Number.isFinite(shares) || shares <= 0) return { ok: false, reason: "invalid shares" };
  const cost = Math.ceil(price * shares);
  const c = charge(id, cost);
  if (!c.ok) return { ok: false, reason: "insufficient", cost, price };
  const hpos = u.stocks[def.ticker] || { shares: 0, cost: 0 };
  hpos.shares += shares;
  hpos.cost += cost;
  u.stocks[def.ticker] = hpos;
  scheduleSave();
  return { ok: true, ticker: def.ticker, name: def.name, shares, price, cost, owned: hpos.shares };
}

// Sell shares (or "all") at the current price. Tracks proportional cost basis
// so we can report realized profit/loss.
function sellStock(id, tickerInput, sharesInput) {
  ensureMarket();
  const def = stocks.findStock(tickerInput);
  if (!def) return { ok: false, reason: "no such stock" };
  const u = ensure(id);
  if (u.away) return { ok: false, reason: "away" }; // hard override: no selling while away
  const hpos = u.stocks[def.ticker];
  if (!hpos || hpos.shares <= 0) return { ok: false, reason: "not owned" };
  let shares;
  if (sharesInput === "all" || sharesInput === undefined || sharesInput === null || sharesInput === "max") shares = hpos.shares;
  else shares = Math.floor(Number(sharesInput));
  if (!Number.isFinite(shares) || shares <= 0) return { ok: false, reason: "invalid shares" };
  if (shares > hpos.shares) return { ok: false, reason: "too many", owned: hpos.shares };
  const price = state.market[def.ticker].price;
  const proceeds = Math.floor(price * shares);
  const costBasis = Math.round(hpos.cost * (shares / hpos.shares));
  hpos.cost -= costBasis;
  hpos.shares -= shares;
  if (hpos.shares <= 0) delete u.stocks[def.ticker];
  u.wallet += proceeds;
  scheduleSave();
  return { ok: true, ticker: def.ticker, name: def.name, shares, price, proceeds, costBasis, pl: proceeds - costBasis, owned: hpos.shares > 0 ? hpos.shares : 0, wallet: u.wallet };
}

// A player's full portfolio with live value + profit/loss per position.
function getPortfolio(id) {
  ensureMarket();
  const u = ensure(id);
  const positions = [];
  let totalValue = 0, totalCost = 0;
  for (const key of Object.keys(u.stocks || {})) {
    const def = stocks.STOCKS[key];
    const m = state.market[key];
    const hpos = u.stocks[key];
    if (!def || !m || !hpos || hpos.shares <= 0) continue;
    const value = Math.floor(m.price * hpos.shares);
    const changePct = m.prev > 0 ? ((m.price - m.prev) / m.prev) * 100 : 0;
    const pl = value - hpos.cost;
    const plPct = hpos.cost > 0 ? (pl / hpos.cost) * 100 : 0;
    positions.push({
      ticker: def.ticker, name: def.name, risk: def.risk,
      shares: hpos.shares, price: m.price, avgCost: hpos.cost / hpos.shares,
      value, cost: hpos.cost, pl, plPct, changePct,
    });
    totalValue += value;
    totalCost += hpos.cost;
  }
  positions.sort((a, b) => b.value - a.value);
  return {
    positions, totalValue, totalCost,
    totalPl: totalValue - totalCost,
    totalPlPct: totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : 0,
  };
}

// Live market value of a user's holdings (used for net worth / leaderboard).
function stocksValue(u) {
  if (!state.market) return 0;
  let total = 0;
  for (const key of Object.keys(u.stocks || {})) {
    const m = state.market[key];
    const hpos = u.stocks[key];
    if (!m || !hpos) continue;
    total += Math.floor(m.price * hpos.shares);
  }
  return total;
}

// Lower police heat over time (1 per HEAT_DECAY_MS).
function applyHeatDecay(u) {
  if (!u.heat || u.heat <= 0) return;
  const now = Date.now();
  if (!u.lastHeatDecay) {
    u.lastHeatDecay = now;
    return;
  }
  const steps = Math.floor((now - u.lastHeatDecay) / HEAT_DECAY_MS);
  if (steps > 0) {
    u.heat = Math.max(0, u.heat - steps);
    u.lastHeatDecay += steps * HEAT_DECAY_MS;
    scheduleSave();
  }
}

function ensure(id) {
  if (!state.users[id]) state.users[id] = {};
  const u = state.users[id];
  if (typeof u.wallet !== "number") u.wallet = 0;
  if (typeof u.bank !== "number") u.bank = 0;
  if (typeof u.lastDaily !== "number") u.lastDaily = 0;
  if (typeof u.lastRob !== "number") u.lastRob = 0;
  if (typeof u.heat !== "number") u.heat = 0;
  if (typeof u.lastHeatDecay !== "number") u.lastHeatDecay = 0;
  if (typeof u.crimeCd !== "object" || u.crimeCd === null) u.crimeCd = {};
  if (!Array.isArray(u.businesses)) u.businesses = [];
  if (!Array.isArray(u.houses)) u.houses = [];
  if (typeof u.loan !== "object") u.loan = null; // { principal, takenAt, lastInterest, totalInterest, borrowed } or null
  if (typeof u.lastLoanAt !== "number") u.lastLoanAt = 0; // timestamp of last loan taken (12h cooldown)
  if (typeof u.lastIncome !== "number") u.lastIncome = 0;
  if (typeof u.goyslop !== "number") u.goyslop = 0;
  if (typeof u.stocks !== "object" || u.stocks === null) u.stocks = {};
  if (typeof u.away !== "boolean") u.away = false;
  if (typeof u.lastAwayToggle !== "number") u.lastAwayToggle = 0;
  if (typeof u.lastActive !== "number") u.lastActive = Date.now();
  if (typeof u.lastWork !== "number") u.lastWork = 0;
  if (!Array.isArray(u.cars)) u.cars = [];
  if (u.selectedCar !== null && typeof u.selectedCar !== "string") u.selectedCar = null;
  if (typeof u.lastRace !== "number") u.lastRace = 0;
  u.cars = u.cars.filter((c) => c && typeof c.iid === "string" && cars.carById(c.carId));
  if (u.selectedCar && !u.cars.some((c) => c.iid === u.selectedCar)) u.selectedCar = u.cars.length ? u.cars[0].iid : null;
  if (u.factory && typeof u.factory === "object") {
    if (typeof u.factory.level !== "number" || u.factory.level < 1) u.factory.level = 1;
    if (u.factory.level > FACTORY_MAX_LEVEL) u.factory.level = FACTORY_MAX_LEVEL;
    if (typeof u.factory.lastSlop !== "number") u.factory.lastSlop = Date.now();
  } else {
    u.factory = null;
  }
  // Sanitize balances so legacy floats / overflowed values can't corrupt saves.
  u.wallet = clampMoney(u.wallet);
  u.bank = clampMoney(u.bank);
  u.goyslop = clampMoney(u.goyslop || 0);
  // Keep derived state current on every access.
  applyHeatDecay(u);
  accrueIncome(u);
  accrueSlop(u);
  accrueLoanInterest(u);
  return u;
}

// ── Balances ───────────────────────────────────────────────────
function getUser(id) {
  const u = ensure(id);
  return {
    wallet: u.wallet,
    bank: u.bank,
    lastDaily: u.lastDaily,
    lastRob: u.lastRob,
    heat: u.heat,
    businesses: u.businesses.map((b) => b.key),
    houses: u.houses.map((h) => h.key),
    incomePerSec: businessRate(u),
    goyslop: Math.floor(u.goyslop || 0),
    factoryLevel: u.factory ? u.factory.level : 0,
    slopPerSec: factoryRate(u),
    away: u.away === true,
  };
}

function clampMoney(n) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  return Math.min(MAX_MONEY, Math.floor(n));
}

function addWallet(id, amount) {
  const u = ensure(id);
  u.wallet = clampMoney(u.wallet + amount);
  scheduleSave();
  return u.wallet;
}

function setWallet(id, amount) {
  ensure(id).wallet = Math.max(0, Math.floor(amount));
  scheduleSave();
}

// Charge a cost from wallet first, then bank. Used for purchases.
function charge(id, amount) {
  const u = ensure(id);
  amount = Math.floor(Number(amount));
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "invalid amount" };
  if (u.wallet + u.bank < amount) return { ok: false, reason: "insufficient" };
  if (u.wallet >= amount) {
    u.wallet -= amount;
  } else {
    const remainder = amount - u.wallet;
    u.wallet = 0;
    u.bank -= remainder;
  }
  scheduleSave();
  return { ok: true };
}

function deposit(id, amount) {
  const u = ensure(id);
  if (amount === "all") amount = u.wallet;
  amount = Math.floor(Number(amount));
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "invalid amount" };
  if (u.wallet < amount) return { ok: false, reason: "not enough in wallet" };
  u.wallet -= amount;
  u.bank += amount;
  scheduleSave();
  return { ok: true, deposited: amount, wallet: u.wallet, bank: u.bank };
}

function withdraw(id, amount) {
  const u = ensure(id);
  if (amount === "all") amount = u.bank;
  amount = Math.floor(Number(amount));
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "invalid amount" };
  if (u.bank < amount) return { ok: false, reason: "not enough in bank" };
  u.bank -= amount;
  u.wallet += amount;
  scheduleSave();
  return { ok: true, withdrawn: amount, wallet: u.wallet, bank: u.bank };
}

function daily(id) {
  const u = ensure(id);
  const now = Date.now();
  const elapsed = now - u.lastDaily;
  if (elapsed < DAY_MS) {
    return { ok: false, remaining: DAY_MS - elapsed };
  }
  u.wallet += DAILY_AMOUNT;
  u.lastDaily = now;
  scheduleSave();
  return { ok: true, amount: DAILY_AMOUNT, wallet: u.wallet };
}

function rob(robberId, victimId) {
  if (robberId === victimId) return { ok: false, reason: "You can't rob yourself." };
  const r = ensure(robberId);
  const v = ensure(victimId);
  const now = Date.now();
  const since = now - r.lastRob;
  if (since < ROB_COOLDOWN_MS) {
    return { ok: false, reason: "cooldown", remaining: ROB_COOLDOWN_MS - since };
  }
  if (v.away) {
    return { ok: false, reason: "Target is away right now and can't be robbed." };
  }
  const victimWallet = Math.max(0, Math.floor(v.wallet || 0));
  const victimSlop = Math.max(0, Math.floor(v.goyslop || 0));
  if (victimWallet <= 0 && victimSlop <= 0) {
    return { ok: false, reason: "Target has nothing in their wallet or factory to rob." };
  }
  r.lastRob = now;
  if (Math.random() < ROB_SUCCESS_CHANCE) {
    // Success: take EVERY dollar in the victim's wallet (bank is safe) plus ALL
    // their goyslop. clampMoney guards the additions so nothing is ever lost.
    v.wallet = 0;
    v.goyslop = Math.max(0, (v.goyslop || 0) - victimSlop);
    r.wallet = clampMoney(r.wallet + victimWallet);
    r.goyslop = clampMoney((r.goyslop || 0) + victimSlop);
    scheduleSave();
    return { ok: true, success: true, stolen: victimWallet, stolenSlop: victimSlop };
  }
  // Failure: robber pays the victim a quarter of the ROBBER's wallet as
  // compensation (no goyslop changes hands).
  const comp = Math.floor(Math.max(0, r.wallet) * 0.25);
  if (comp > 0) {
    r.wallet = clampMoney(r.wallet - comp);
    v.wallet = clampMoney(v.wallet + comp);
  }
  scheduleSave();
  return { ok: true, success: false, comp };
}

// Atomic wallet-to-wallet transfer used by PvP game payouts and !give.
function transferWallet(fromId, toId, amount) {
  amount = Math.floor(Number(amount));
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "invalid amount" };
  const f = ensure(fromId);
  const t = ensure(toId);
  if (f.wallet < amount) return { ok: false, reason: "not enough" };
  f.wallet -= amount;
  t.wallet += amount;
  scheduleSave();
  return { ok: true };
}

// Combined value of a user's owned businesses + houses, valued at current
// catalogue price (falling back to what they paid if a catalogue entry was
// removed). This is the "assets" portion of net worth.
function assetsValue(u) {
  let businesses = 0;
  for (const b of u.businesses || []) {
    const def = catalog.BUSINESSES[b.key];
    businesses += def ? def.price : (b.paid || 0);
  }
  let houses = 0;
  for (const hh of u.houses || []) {
    const def = catalog.HOUSES[hh.key];
    houses += def ? def.price : (hh.paid || 0);
  }
  const factory = factoryInvested(u);
  const goyslop = Math.floor((u.goyslop || 0) * GOYSLOP_PRICE);
  const stocksVal = stocksValue(u);
  let carsVal = 0;
  for (const c of u.cars || []) {
    const def = cars.carById(c.carId);
    if (def) carsVal += def.price;
  }
  return { businesses, houses, factory, goyslop, stocks: stocksVal, cars: carsVal, total: businesses + houses + factory + goyslop + stocksVal + carsVal };
}

// Total net worth = liquid cash (wallet + bank) + value of owned assets
// (businesses + houses).
// ── Loans ──────────────────────────────────────────────────────
// Charge 5% interest on the outstanding loan every 5 minutes, lazily from
// elapsed real time (so interest keeps mounting even while the bot was
// offline). Interest is pulled from wallet then bank; anything the player
// can't cover is rolled into what they owe (so it compounds).
function accrueLoanInterest(u) {
  if (!u.loan || !(u.loan.principal > 0)) return 0;
  const now = Date.now();
  if (!u.loan.lastInterest) {
    u.loan.lastInterest = now;
    return 0;
  }
  let periods = Math.floor((now - u.loan.lastInterest) / LOAN_INTEREST_PERIOD_MS);
  if (periods <= 0) return 0;
  if (periods > 100000) periods = 100000; // safety cap for very long offline gaps
  let charged = 0;
  for (let i = 0; i < periods; i++) {
    const interest = Math.ceil(u.loan.principal * LOAN_INTEREST_RATE);
    if (interest <= 0) break;
    const pool = u.wallet + u.bank;
    if (pool >= interest) {
      if (u.wallet >= interest) {
        u.wallet -= interest;
      } else {
        const rem = interest - u.wallet;
        u.wallet = 0;
        u.bank -= rem;
      }
      charged += interest;
    } else {
      // Can't fully pay: drain what they have and roll the rest into the debt.
      const unpaid = interest - pool;
      charged += pool;
      u.wallet = 0;
      u.bank = 0;
      u.loan.principal = clampMoney(u.loan.principal + unpaid);
    }
  }
  u.loan.lastInterest += periods * LOAN_INTEREST_PERIOD_MS;
  u.loan.totalInterest = clampMoney((u.loan.totalInterest || 0) + charged);
  u.wallet = clampMoney(u.wallet);
  u.bank = clampMoney(u.bank);
  scheduleSave();
  return charged;
}

// How much this player can borrow right now: 10x their current net worth.
function loanCap(id) {
  const nw = netWorth(id).total;
  return Math.max(0, Math.floor(nw * LOAN_MAX_MULTIPLIER));
}

function getLoan(id) {
  const u = ensure(id);
  if (!u.loan || !(u.loan.principal > 0)) return null;
  const now = Date.now();
  const nextInMs = Math.max(0, u.loan.lastInterest + LOAN_INTEREST_PERIOD_MS - now);
  return {
    principal: u.loan.principal,
    interestPerPeriod: Math.ceil(u.loan.principal * LOAN_INTEREST_RATE),
    nextInMs,
    totalInterest: u.loan.totalInterest || 0,
    borrowed: u.loan.borrowed || u.loan.principal,
    takenAt: u.loan.takenAt || 0,
  };
}

function loanCooldownLeft(id) {
  const u = ensure(id);
  return Math.max(0, LOAN_COOLDOWN_MS - (Date.now() - (u.lastLoanAt || 0)));
}

function takeLoan(id, amount) {
  const u = ensure(id);
  if (u.loan && u.loan.principal > 0) return { ok: false, reason: "active", principal: u.loan.principal };
  const cdLeft = LOAN_COOLDOWN_MS - (Date.now() - (u.lastLoanAt || 0));
  if (cdLeft > 0) return { ok: false, reason: "cooldown", waitMs: cdLeft };
  amount = Math.floor(Number(amount));
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "invalid" };
  const cap = loanCap(id);
  if (cap <= 0) return { ok: false, reason: "no_networth" };
  if (amount > cap) return { ok: false, reason: "too_big", cap };
  const now = Date.now();
  u.lastLoanAt = now;
  u.loan = { principal: amount, borrowed: amount, takenAt: now, lastInterest: now, totalInterest: 0 };
  u.wallet = clampMoney(u.wallet + amount);
  scheduleSave();
  return { ok: true, amount, principal: u.loan.principal, cap, wallet: u.wallet };
}

function payLoan(id, amount) {
  const u = ensure(id);
  if (!u.loan || !(u.loan.principal > 0)) return { ok: false, reason: "noloan" };
  const owed = u.loan.principal;
  if (amount === "all") amount = Math.min(owed, u.wallet + u.bank);
  amount = Math.floor(Number(amount));
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "invalid" };
  if (amount > owed) amount = owed;
  if (u.wallet + u.bank < amount) return { ok: false, reason: "insufficient", owed, have: u.wallet + u.bank };
  if (u.wallet >= amount) {
    u.wallet -= amount;
  } else {
    const rem = amount - u.wallet;
    u.wallet = 0;
    u.bank -= rem;
  }
  u.loan.principal -= amount;
  let cleared = false;
  let remaining = u.loan.principal;
  if (u.loan.principal <= 0) {
    u.loan = null;
    cleared = true;
    remaining = 0;
  }
  u.wallet = clampMoney(u.wallet);
  u.bank = clampMoney(u.bank);
  scheduleSave();
  return { ok: true, paid: amount, remaining, cleared, wallet: u.wallet, bank: u.bank };
}

function netWorth(id) {
  ensureMarket();
  const u = ensure(id);
  const assets = assetsValue(u);
  return {
    wallet: u.wallet,
    bank: u.bank,
    businesses: assets.businesses,
    houses: assets.houses,
    factory: assets.factory,
    goyslop: assets.goyslop,
    stocks: assets.stocks,
    cars: assets.cars,
    assets: assets.total,
    total: u.wallet + u.bank + assets.total,
  };
}

function leaderboard(limit = 10) {
  ensureMarket();
  return Object.keys(state.users)
    .map((id) => {
      const u = ensure(id);
      const assets = assetsValue(u);
      return {
        id,
        total: u.wallet + u.bank + assets.total,
        wallet: u.wallet,
        bank: u.bank,
        businesses: assets.businesses,
        houses: assets.houses,
        factory: assets.factory,
        goyslop: assets.goyslop,
        stocks: assets.stocks,
        cars: assets.cars,
        assets: assets.total,
      };
    })
    .filter((x) => x.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

// ── Police heat ────────────────────────────────────────────────
function getHeatStatus(id) {
  const u = ensure(id);
  const now = Date.now();
  return {
    heat: u.heat,
    maxHeat: MAX_HEAT,
    maxed: u.heat >= MAX_HEAT,
    nextDecayMs: u.heat > 0 ? Math.max(0, HEAT_DECAY_MS - (now - u.lastHeatDecay)) : 0,
  };
}

// True when heat is maxed out — crime commands are blocked until it cools.
function isHeatMaxed(id) {
  return ensure(id).heat >= MAX_HEAT;
}

// Add police heat (on a failed crime), capped at MAX_HEAT. When heat hits max
// the player can't commit crimes until it cools down (1 every HEAT_DECAY_MS).
function addHeat(id, n = 1) {
  const u = ensure(id);
  u.heat = Math.min(MAX_HEAT, u.heat + n);
  if (!u.lastHeatDecay) u.lastHeatDecay = Date.now();
  scheduleSave();
  return { heat: u.heat, maxHeat: MAX_HEAT, maxed: u.heat >= MAX_HEAT };
}

function crimeCooldownRemaining(id, key) {
  const u = ensure(id);
  const last = (u.crimeCd && u.crimeCd[key]) || 0;
  const since = Date.now() - last;
  return since >= CRIME_COOLDOWN_MS ? 0 : CRIME_COOLDOWN_MS - since;
}

function markCrime(id, key) {
  const u = ensure(id);
  u.crimeCd[key] = Date.now();
  scheduleSave();
}

// ── Businesses ─────────────────────────────────────────────────
function buyBusiness(id, key, qty = 1) {
  const def = catalog.BUSINESSES[key];
  if (!def) return { ok: false, reason: "no such business" };
  qty = Math.floor(Number(qty));
  if (!Number.isFinite(qty) || qty <= 0) qty = 1;
  const u = ensure(id);
  // Per-business ownership cap.
  const have = u.businesses.filter((b) => b.key === key).length;
  if (have >= MAX_PER_BUSINESS) {
    return { ok: false, reason: "cap", cap: MAX_PER_BUSINESS, have, def };
  }
  if (have + qty > MAX_PER_BUSINESS) {
    qty = MAX_PER_BUSINESS - have; // buy as many as the cap allows
  }
  const totalCost = def.price * qty;
  const c = charge(id, totalCost);
  if (!c.ok) return { ok: false, reason: "insufficient", price: def.price, qty, totalCost };
  for (let i = 0; i < qty; i++) u.businesses.push({ key: def.key, paid: def.price });
  scheduleSave();
  return { ok: true, def, qty, totalCost, capped: have + qty >= MAX_PER_BUSINESS };
}

function sellBusiness(id, key) {
  const def = catalog.BUSINESSES[key];
  if (!def) return { ok: false, reason: "no such business" };
  const u = ensure(id);
  const idx = u.businesses.findIndex((b) => b.key === key);
  if (idx === -1) return { ok: false, reason: "not owned" };
  const owned = u.businesses.splice(idx, 1)[0];
  const refund = Math.floor((owned.paid || def.price) * 0.8);
  u.wallet += refund;
  scheduleSave();
  return { ok: true, def, refund };
}

function giveBusiness(fromId, toId, key) {
  const def = catalog.BUSINESSES[key];
  if (!def) return { ok: false, reason: "no such business" };
  const f = ensure(fromId);
  const t = ensure(toId);
  const idx = f.businesses.findIndex((b) => b.key === key);
  if (idx === -1) return { ok: false, reason: "not owned" };
  // Respect the per-business cap on the receiving end too.
  const tHave = t.businesses.filter((b) => b.key === key).length;
  if (tHave >= MAX_PER_BUSINESS) return { ok: false, reason: "target_cap", cap: MAX_PER_BUSINESS };
  const owned = f.businesses.splice(idx, 1)[0];
  t.businesses.push(owned);
  scheduleSave();
  return { ok: true, def };
}

function listBusinesses(id) {
  return ensure(id).businesses.map((b) => b.key);
}

// ── Houses (status only, no income) ────────────────────────────
function buyHouse(id, key) {
  const def = catalog.HOUSES[key];
  if (!def) return { ok: false, reason: "no such house" };
  const u = ensure(id);
  // Unique houses (e.g. the Private Island) can only be owned once.
  if (def.unique && u.houses.some((hh) => hh.key === key)) {
    return { ok: false, reason: "already owned", def };
  }
  const c = charge(id, def.price);
  if (!c.ok) return { ok: false, reason: "insufficient", price: def.price };
  u.houses.push({ key: def.key, paid: def.price });
  scheduleSave();
  return { ok: true, def };
}

function sellHouse(id, key) {
  const def = catalog.HOUSES[key];
  if (!def) return { ok: false, reason: "no such house" };
  if (def.noSell) return { ok: false, reason: "nosell", def };
  const u = ensure(id);
  const idx = u.houses.findIndex((hh) => hh.key === key);
  if (idx === -1) return { ok: false, reason: "not owned" };
  const owned = u.houses.splice(idx, 1)[0];
  const refund = Math.floor((owned.paid || def.price) * 0.8);
  u.wallet += refund;
  scheduleSave();
  return { ok: true, def, refund };
}

function giveHouse(fromId, toId, key) {
  const def = catalog.HOUSES[key];
  if (!def) return { ok: false, reason: "no such house" };
  if (def.noSell || def.unique) return { ok: false, reason: "nosell", def };
  const f = ensure(fromId);
  const t = ensure(toId);
  const idx = f.houses.findIndex((hh) => hh.key === key);
  if (idx === -1) return { ok: false, reason: "not owned" };
  const owned = f.houses.splice(idx, 1)[0];
  t.houses.push(owned);
  scheduleSave();
  return { ok: true, def };
}

function listHouses(id) {
  return ensure(id).houses.map((hh) => hh.key);
}

// ── Private Island channel binding ─────────────────────────────
function ownsHouse(id, key) {
  return ensure(id).houses.some((hh) => hh.key === key);
}
function getIslandChannel(id) {
  const u = ensure(id);
  return typeof u.islandChannelId === "string" ? u.islandChannelId : null;
}
function setIslandChannel(id, channelId) {
  const u = ensure(id);
  u.islandChannelId = channelId || null;
  scheduleSave();
  return u.islandChannelId;
}
function clearIslandChannel(id) {
  const u = ensure(id);
  u.islandChannelId = null;
  scheduleSave();
}

// ── Factory / goyslop ──────────────────────────────────────────
function buyFactory(id) {
  const u = ensure(id);
  if (u.factory) return { ok: false, reason: "owned", level: u.factory.level };
  const c = charge(id, FACTORY_BASE_COST);
  if (!c.ok) return { ok: false, reason: "insufficient", cost: FACTORY_BASE_COST };
  u.factory = { level: 1, lastSlop: Date.now() };
  scheduleSave();
  return { ok: true, cost: FACTORY_BASE_COST, rate: factoryRate(u) };
}

function upgradeFactory(id) {
  const u = ensure(id);
  if (!u.factory) return { ok: false, reason: "none", buyCost: FACTORY_BASE_COST };
  if (u.factory.level >= FACTORY_MAX_LEVEL) return { ok: false, reason: "max", level: u.factory.level };
  const cost = factoryUpgradeCost(u.factory.level);
  const oldRate = factoryRate(u);
  const c = charge(id, cost);
  if (!c.ok) return { ok: false, reason: "insufficient", cost };
  u.factory.level += 1;
  scheduleSave();
  return { ok: true, cost, level: u.factory.level, oldRate, rate: factoryRate(u) };
}

function factoryInfo(id) {
  const u = ensure(id);
  if (!u.factory) {
    return { owned: false, buyCost: FACTORY_BASE_COST, baseRate: FACTORY_BASE_RATE };
  }
  const maxed = u.factory.level >= FACTORY_MAX_LEVEL;
  return {
    owned: true,
    level: u.factory.level,
    rate: factoryRate(u),
    maxed,
    maxLevel: FACTORY_MAX_LEVEL,
    nextCost: maxed ? null : factoryUpgradeCost(u.factory.level),
    nextRate: maxed ? null : Math.round(FACTORY_BASE_RATE * Math.pow(FACTORY_UPGRADE_MULT, u.factory.level)),
    invested: factoryInvested(u),
    goyslop: Math.floor(u.goyslop || 0),
  };
}

function getGoyslop(id) {
  return Math.floor(ensure(id).goyslop || 0);
}

function sellGoyslop(id) {
  const u = ensure(id);
  const amount = Math.floor(u.goyslop || 0);
  if (amount <= 0) return { ok: false, reason: "none" };
  const value = amount * GOYSLOP_PRICE;
  u.goyslop = (u.goyslop || 0) - amount; // keep any fractional remainder
  u.wallet = clampMoney(u.wallet + value);
  scheduleSave();
  return { ok: true, sold: amount, value, wallet: u.wallet, pricePer: GOYSLOP_PRICE };
}

// ── Work (quick active income, 70% pay / 30% nothing) ─────────
function work(id) {
  const u = ensure(id);
  const now = Date.now();
  const since = now - (u.lastWork || 0);
  if (since < WORK_COOLDOWN_MS) {
    return { ok: false, reason: "cooldown", remaining: WORK_COOLDOWN_MS - since };
  }
  u.lastWork = now;
  const success = Math.random() < WORK_SUCCESS_CHANCE;
  let amount = 0;
  if (success) {
    amount = WORK_MIN + Math.floor(Math.random() * (WORK_MAX - WORK_MIN + 1));
    addWallet(id, amount);
  }
  scheduleSave();
  return { ok: true, success, amount, wallet: ensure(id).wallet };
}

// ── Away mode ──────────────────────────────────────────────────
// While away the player can't be robbed, but their businesses stop paying out
// and their factory pauses (handled in accrueIncome / accrueSlop), and they
// can't sell stocks (hard override in sellStock).
function isAway(id) {
  return ensure(id).away === true;
}

function toggleAway(id) {
  const u = ensure(id); // ensure() settles income/goyslop up to now first
  const now = Date.now();
  if (!u.away) {
    // Entering away mode is the ONLY direction that has a cooldown.
    const since = now - (u.lastAwayToggle || 0);
    if (since < AWAY_COOLDOWN_MS) {
      return { ok: false, reason: "cooldown", remaining: AWAY_COOLDOWN_MS - since };
    }
    u.away = true;
    u.lastAwayToggle = now;
    u.lastActive = now;
    // Reset accrual clocks so the away period is never back-paid on return.
    u.lastIncome = now;
    if (u.factory) u.factory.lastSlop = now;
    scheduleSave();
    return { ok: true, away: true };
  }
  // Leaving away mode is always allowed — no cooldown.
  u.away = false;
  u.lastActive = now;
  u.lastIncome = now;
  if (u.factory) u.factory.lastSlop = now;
  scheduleSave();
  return { ok: true, away: false };
}

// Mark a user as active right now (resets their 12h auto-away timer). Used for
// messages that shouldn't auto-leave away (e.g. the !away command itself).
function markActive(id) {
  const u = ensure(id);
  u.lastActive = Date.now();
  scheduleSave();
  return { away: u.away === true };
}

// Pull a user out of away mode because they did something (typed a message).
// Always resets the activity timer. Leaving has NO cooldown. Returns true only
// if they were actually away (so the caller can react/notify).
function leaveAway(id) {
  const u = ensure(id);
  const now = Date.now();
  u.lastActive = now;
  if (!u.away) {
    scheduleSave();
    return false;
  }
  u.away = false;
  // Don't back-pay the away period.
  u.lastIncome = now;
  if (u.factory) u.factory.lastSlop = now;
  scheduleSave();
  return true;
}

// Sweep every user and auto-enable away mode for anyone idle >= AUTO_AWAY_MS.
// Idempotent: users already away are skipped (no error, no re-toggle). Missing
// timestamps are initialised to "now" so pre-existing players aren't instantly
// marked away on first run. Returns the ids that were newly set to away.
function applyAutoAway() {
  const now = Date.now();
  const newlyAway = [];
  let changed = false;
  for (const id of Object.keys(state.users)) {
    const u = state.users[id];
    if (!u) continue;
    if (typeof u.lastActive !== "number") {
      u.lastActive = now; // initialise; never punish a player we haven't seen yet
      changed = true;
      continue;
    }
    if (u.away === true) continue; // already away — do nothing
    if (now - u.lastActive >= AUTO_AWAY_MS) {
      u.away = true;
      // Reset accrual clocks so the away period is never back-paid on return.
      u.lastIncome = now;
      if (u.factory) u.factory.lastSlop = now;
      newlyAway.push(id);
      changed = true;
    }
  }
  if (changed) scheduleSave();
  return newlyAway;
}

// ── Formatting ────────────  ─   ──────────────────────────────────
function fmt(n) {
  return Math.floor(Number(n) || 0).toLocaleString("en-US");
}

function formatDuration(ms) {
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// ── Cars / racing ──────────────────────────────────────
let carSeq = 0;
function newIid() {
  carSeq = (carSeq + 1) % 1000000;
  return Date.now().toString(36) + "-" + carSeq.toString(36) + "-" + Math.floor(Math.random() * 46656).toString(36);
}

function addCar(id, carId) {
  const def = cars.carById(carId);
  if (!def) return null;
  const u = ensure(id);
  if (u.cars.length >= MAX_CARS) return null;
  const inst = { iid: newIid(), carId: def.id, at: Date.now() };
  u.cars.push(inst);
  if (!u.selectedCar) u.selectedCar = inst.iid;
  scheduleSave();
  return { iid: inst.iid, car: def };
}

function removeCarInstance(u, iid) {
  const idx = u.cars.findIndex((c) => c.iid === iid);
  if (idx < 0) return null;
  const [inst] = u.cars.splice(idx, 1);
  if (u.selectedCar === iid) u.selectedCar = u.cars.length ? u.cars[0].iid : null;
  return inst;
}

function listCars(id) {
  const u = ensure(id);
  return u.cars
    .map((c) => ({ iid: c.iid, car: cars.carById(c.carId), selected: c.iid === u.selectedCar }))
    .filter((x) => x.car);
}

function getOwnedCar(id, iid) {
  const u = ensure(id);
  const c = u.cars.find((x) => x.iid === iid);
  if (!c) return null;
  const def = cars.carById(c.carId);
  return def ? { iid: c.iid, car: def } : null;
}

function selectCar(id, iid) {
  const u = ensure(id);
  const c = u.cars.find((x) => x.iid === iid);
  if (!c) return { ok: false, reason: "not_owned" };
  u.selectedCar = iid;
  scheduleSave();
  return { ok: true, car: cars.carById(c.carId) };
}

function getSelectedCar(id) {
  const u = ensure(id);
  if (!u.selectedCar) return null;
  const c = u.cars.find((x) => x.iid === u.selectedCar);
  if (!c) { u.selectedCar = null; return null; }
  const def = cars.carById(c.carId);
  return def ? { iid: c.iid, car: def } : null;
}

function destroyCar(id, iid) {
  const u = ensure(id);
  const inst = removeCarInstance(u, iid);
  if (!inst) return null;
  scheduleSave();
  return cars.carById(inst.carId);
}

function openLootbox(id, type, count) {
  const meta = cars.TYPES[type];
  if (!meta) return { ok: false, reason: "bad_type" };
  count = Math.max(1, Math.min(10, Math.floor(count || 1)));
  const u = ensure(id);
  const slots = MAX_CARS - u.cars.length;
  if (slots <= 0) return { ok: false, reason: "full", max: MAX_CARS };
  if (count > slots) count = slots;
  const cost = meta.lootbox * count;
  if (u.wallet < cost) return { ok: false, reason: "insufficient", cost, have: u.wallet };
  u.wallet = clampMoney(u.wallet - cost);
  const results = [];
  for (let i = 0; i < count; i++) {
    const car = cars.openBox(type);
    if (!car) continue;
    const inst = { iid: newIid(), carId: car.id, at: Date.now() };
    u.cars.push(inst);
    if (!u.selectedCar) u.selectedCar = inst.iid;
    results.push({ iid: inst.iid, car });
  }
  scheduleSave();
  return { ok: true, cost, results, type };
}

function ensureBookface() {
  if (!state.bookface || typeof state.bookface !== "object") state.bookface = { listings: {}, seq: 0 };
  if (!state.bookface.listings || typeof state.bookface.listings !== "object") state.bookface.listings = {};
  if (typeof state.bookface.seq !== "number") state.bookface.seq = 0;
  return state.bookface;
}

function listCarForSale(id, iid, price) {
  price = Math.floor(price);
  if (!Number.isFinite(price) || price <= 0) return { ok: false, reason: "bad_price" };
  if (price > MAX_MONEY) return { ok: false, reason: "too_high" };
  const u = ensure(id);
  const inst = u.cars.find((c) => c.iid === iid);
  if (!inst) return { ok: false, reason: "not_owned" };
  const def = cars.carById(inst.carId);
  if (!def) return { ok: false, reason: "not_owned" };
  removeCarInstance(u, iid);
  const bf = ensureBookface();
  bf.seq += 1;
  const listingId = "L" + bf.seq;
  bf.listings[listingId] = { id: listingId, sellerId: id, carId: def.id, price, at: Date.now() };
  scheduleSave();
  return { ok: true, listingId, car: def, price };
}

function getListings() {
  const bf = ensureBookface();
  return Object.values(bf.listings)
    .map((l) => Object.assign({}, l, { car: cars.carById(l.carId) }))
    .filter((l) => l.car)
    .sort((a, b) => a.price - b.price);
}

function getListing(listingId) {
  const bf = ensureBookface();
  const l = bf.listings[listingId];
  if (!l) return null;
  const car = cars.carById(l.carId);
  return car ? Object.assign({}, l, { car }) : null;
}

function getUserListings(id) {
  return getListings().filter((l) => l.sellerId === id);
}

function buyListing(buyerId, listingId) {
  const bf = ensureBookface();
  const l = bf.listings[listingId];
  if (!l) return { ok: false, reason: "not_found" };
  const def = cars.carById(l.carId);
  if (!def) { delete bf.listings[listingId]; return { ok: false, reason: "not_found" }; }
  if (l.sellerId === buyerId) return { ok: false, reason: "own" };
  const b = ensure(buyerId);
  if (b.cars.length >= MAX_CARS) return { ok: false, reason: "full", max: MAX_CARS };
  if (b.wallet < l.price) return { ok: false, reason: "insufficient", price: l.price, have: b.wallet };
  b.wallet = clampMoney(b.wallet - l.price);
  const s = ensure(l.sellerId);
  s.wallet = clampMoney(s.wallet + l.price);
  const inst = { iid: newIid(), carId: def.id, at: Date.now() };
  b.cars.push(inst);
  if (!b.selectedCar) b.selectedCar = inst.iid;
  delete bf.listings[listingId];
  scheduleSave();
  return { ok: true, car: def, price: l.price, sellerId: l.sellerId, iid: inst.iid };
}

function unlistCar(id, listingId) {
  const bf = ensureBookface();
  const l = bf.listings[listingId];
  if (!l) return { ok: false, reason: "not_found" };
  if (l.sellerId !== id) return { ok: false, reason: "not_yours" };
  const u = ensure(id);
  if (u.cars.length >= MAX_CARS) return { ok: false, reason: "full", max: MAX_CARS };
  const def = cars.carById(l.carId);
  delete bf.listings[listingId];
  if (def) {
    const inst = { iid: newIid(), carId: def.id, at: Date.now() };
    u.cars.push(inst);
    if (!u.selectedCar) u.selectedCar = inst.iid;
  }
  scheduleSave();
  return { ok: true, car: def };
}

function raceCooldownRemaining(id) {
  const u = ensure(id);
  const left = RACE_COOLDOWN_MS - (Date.now() - u.lastRace);
  return left > 0 ? left : 0;
}

function markRace(id) {
  const u = ensure(id);
  u.lastRace = Date.now();
  scheduleSave();
}

// ── Admin wipes ───────────────────────────────────────────
function wipeBusinesses(id) {
  const u = ensure(id); const n = u.businesses.length; u.businesses = []; scheduleSave(); return n;
}
function wipeFactory(id) {
  const u = ensure(id); const had = !!u.factory; u.factory = null; scheduleSave(); return had;
}
function wipeCars(id) {
  const u = ensure(id); const n = u.cars.length; u.cars = []; u.selectedCar = null; scheduleSave(); return n;
}
function wipeHouses(id) {
  const u = ensure(id); const n = u.houses.length; const hadIsland = ownsHouse(id, "island"); u.houses = []; scheduleSave(); return { count: n, hadIsland };
}

module.exports = {
  getUser,
  addWallet,
  setWallet,
  charge,
  deposit,
  withdraw,
  daily,
  rob,
  transferWallet,
  leaderboard,
  netWorth,
  loanCap,
  getLoan,
  takeLoan,
  payLoan,
  loanCooldownLeft,
  LOAN_MAX_MULTIPLIER,
  LOAN_INTEREST_RATE,
  LOAN_COOLDOWN_MS,
  // heat / jail
  getHeatStatus,
  isHeatMaxed,
  addHeat,
  crimeCooldownRemaining,
  markCrime,
  // businesses
  buyBusiness,
  sellBusiness,
  giveBusiness,
  listBusinesses,
  // houses
  buyHouse,
  sellHouse,
  giveHouse,
  listHouses,
  ownsHouse,
  getIslandChannel,
  setIslandChannel,
  clearIslandChannel,
  wipeBusinesses,
  wipeFactory,
  wipeCars,
  wipeHouses,
  MAX_PER_BUSINESS,
  // factory / goyslop
  buyFactory,
  upgradeFactory,
  factoryInfo,
  getGoyslop,
  sellGoyslop,
  // stocks
  getMarket,
  getStockPrice,
  getStockStats,
  buyStock,
  sellStock,
  getPortfolio,
  // away
  toggleAway,
  isAway,
  markActive,
  leaveAway,
  applyAutoAway,
  // cars / racing
  addCar,
  MAX_CARS,
  listCars,
  getOwnedCar,
  selectCar,
  getSelectedCar,
  destroyCar,
  openLootbox,
  listCarForSale,
  getListings,
  getListing,
  getUserListings,
  buyListing,
  unlistCar,
  raceCooldownRemaining,
  markRace,
  // work
  work,
  // util
  fmt,
  formatDuration,
  saveNow,
  // constants
  DAILY_AMOUNT,
  ROB_SUCCESS_CHANCE,
  ROB_COOLDOWN_MS,
  AWAY_COOLDOWN_MS,
  AUTO_AWAY_MS,
  RACE_COOLDOWN_MS,
  DAY_MS,
  MAX_HEAT,
  HEAT_DECAY_MS,
  CRIME_COOLDOWN_MS,
  FACTORY_BASE_COST,
  FACTORY_BASE_RATE,
  FACTORY_UPGRADE_MULT,
  FACTORY_MAX_LEVEL,
  GOYSLOP_PRICE,
  WORK_COOLDOWN_MS,
};
