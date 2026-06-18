// Stock market catalog + price engine. PURE module (no discord deps), like
// catalog.js. Prices evolve on a fast tick — this is NOT a realistic market
// sim, it's a fun Discord game that imitates one at high speed.
//
// Each stock has a personality:
//   - low risk    -> tiny volatility, gentle upward drift (boring but reliable)
//   - medium risk -> moderate swings, decent drift
//   - high risk   -> wild volatility + random spikes/crashes (meme stocks)

const TICK_MS = 30 * 1000;        // price updates every 30s (fast-paced)
const MAX_CATCHUP_TICKS = 240;    // cap lazy catch-up so long downtime can't loop forever
const MIN_PRICE = 0.5;            // prices never drop below this

// vol       = stddev of the per-tick % move (higher = swingier)
// drift     = average per-tick % move (positive = trends up over time)
// reversion = pull back toward `base` so prices don't run away forever
// jumpChance/jumpSize = chance & magnitude of a sudden spike/crash (meme stocks)
const STOCKS = {
  // ── Boring blue-chips: slow, steady, profitable long-term ──
  VAULT: { ticker: "VAULT", name: "Vault Savings & Trust", risk: "low", base: 2500, vol: 0.010, drift: 0.0009, reversion: 0.020, blurb: "slow, safe, sleeps fine at night" },
  MONO:  { ticker: "MONO",  name: "Monolith Utilities",    risk: "low", base: 1800, vol: 0.012, drift: 0.0008, reversion: 0.020, blurb: "keeps the lights on, boring on purpose" },

  // ── Medium risk: moderate swings, solid drift ──
  OMNI: { ticker: "OMNI", name: "OmniCorp Holdings", risk: "medium", base: 800, vol: 0.030, drift: 0.0011, reversion: 0.015, blurb: "a little bit of everything" },
  APEX: { ticker: "APEX", name: "Apex Logistics",   risk: "medium", base: 450, vol: 0.035, drift: 0.0010, reversion: 0.015, blurb: "moves boxes and your money" },
  GIGA: { ticker: "GIGA", name: "Giga Foods",       risk: "medium", base: 300, vol: 0.028, drift: 0.0009, reversion: 0.015, blurb: "everyone's gotta eat" },

  // ── High risk meme stocks: huge volatility, random spikes & crashes ──
  MOON:  { ticker: "MOON",  name: "MoonShot Ventures",     risk: "high", base: 120, vol: 0.090, drift: 0.0013, reversion: 0.010, jumpChance: 0.05, jumpSize: 0.35, blurb: "to the moon or the basement" },
  HYPE:  { ticker: "HYPE",  name: "HypeChain Labs",        risk: "high", base: 40,  vol: 0.110, drift: 0.0000, reversion: 0.010, jumpChance: 0.06, jumpSize: 0.40, blurb: "pure hype, zero fundamentals" },
  DOGE2: { ticker: "DOGE2", name: "DogeCoin 2 Industries", risk: "high", base: 5,   vol: 0.130, drift: 0.0000, reversion: 0.008, jumpChance: 0.07, jumpSize: 0.50, blurb: "such stock, very volatile, wow" },
  YOLO:  { ticker: "YOLO",  name: "YOLO Capital",          risk: "high", base: 75,  vol: 0.100, drift: 0.0006, reversion: 0.010, jumpChance: 0.05, jumpSize: 0.35, blurb: "diamond hands only \uD83D\uDC8E\uD83D\uDE4C" },
  BUST:  { ticker: "BUST",  name: "BubbleTech",            risk: "high", base: 30,  vol: 0.120, drift: -0.0004, reversion: 0.008, jumpChance: 0.06, jumpSize: 0.45, blurb: "the bigger they are..." },
};

// Standard normal via Box-Muller.
function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Advance one price by a single tick.
function stepPrice(def, price) {
  let p = price;
  // random walk: drift + volatility shock
  let pct = def.drift + def.vol * gauss();
  // mean reversion toward base keeps prices in a sane range over time
  pct += def.reversion * ((def.base - p) / def.base);
  p = p * (1 + pct);
  // meme stocks occasionally spike or crash hard
  if (def.jumpChance && Math.random() < def.jumpChance) {
    const dir = Math.random() < 0.5 ? -1 : 1;
    p = p * (1 + dir * def.jumpSize * (0.5 + Math.random() * 0.5));
  }
  if (p < MIN_PRICE) p = MIN_PRICE;
  return Math.round(p * 100) / 100; // 2 decimals
}

function tickerKeys() {
  return Object.keys(STOCKS);
}

// Resolve user input (case-insensitive ticker) to a stock def.
function findStock(input) {
  if (!input) return null;
  const t = String(input).toUpperCase().trim();
  return STOCKS[t] || null;
}

module.exports = { STOCKS, TICK_MS, MAX_CATCHUP_TICKS, MIN_PRICE, gauss, stepPrice, tickerKeys, findStock };
