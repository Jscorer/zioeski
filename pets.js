// Dog + cat breeding minigame: own pets, breed them through heats/windows,
// sell semen, buy breeder seed, self-breed potions, a quadrillion-dollar lab
// that crosses cats x dogs into ultra-rare hybrids, a pound + pet store to get
// new pets, a marketplace, animated races + shows, and pet attacks.
//
// Money lives in economy.js (wallet/addWallet/fmt). All PET data is persisted
// here in ./data/pets.json so it survives restarts independently.

const fs = require("fs");
const path = require("path");
const { EmbedBuilder } = require("discord.js");
const economy = require("./economy");
const pb = require("./petbreeds");
const h = require("./gamehelpers");

const PREFIX = h.PREFIX;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Rarity keys usable with `!petsell <rarity>` (common…mythical).
const RARITY_KEYS = Object.keys(pb.RARITY);

// ── Timings (real-time, per owner spec) ───────────────────────────
const HOUR = 60 * 60 * 1000;
const PUPPY_MS = 1 * HOUR;           // < 1h = puppy (cannot breed/race/attack)
const FERTILE_END_MS = 72 * HOUR;    // 24h..72h = adult fertile window ("2 days")
const SEED_FERTILE_END_MS = 24 * HOUR + 7 * 24 * HOUR; // females w/ seed: 1 week
const GESTATION_MIN = 30 * 60 * 1000;
const GESTATION_MAX = 60 * 60 * 1000;
const HEAT_CYCLE_MS = 60 * 60 * 1000; // heat every other 30 min
const HEAT_ON_MS = 30 * 60 * 1000;
const NEGLECT_MS = 48 * HOUR;         // mature pet unfed/unwalked this long = runs away
const LAB_DURATION_MS = 24 * HOUR;

// ── Cooldowns ─────────────────────────────────────────
const ATTACK_CD_MS = 15 * 60 * 1000;
const POUND_CD_MS = 5 * 60 * 1000; // pound cooldown, tracked PER SPECIES (1 dog + 1 cat per 5 min)
const RACE_CD_MS = 60 * 1000;
const SHOW_CD_MS = 60 * 1000;
const SEMEN_CD_MS = 60 * 60 * 1000;  // per male, once per hour

// ── Costs / caps ─────────────────────────────────────
const MAX_PETS = 50;
const POUND_COST = 50000;
const RENAME_COST = 100000;
const STORE_SIZE = 12;
const STORE_REFRESH_MS = 5 * 60 * 1000;
const POTION_MIN = 10e9;   // 10 billion
const POTION_MAX = 100e9;  // 100 billion
const LAB_COST = 1e15;        // 1 quadrillion to build the lab
const LAB_BREED_COST = 1e15;  // 1 quadrillion per dog-cat procedure

const SEED_GRADES = {
  standard: { key: "standard", label: "Standard", price: 250000, size: 8, rarity: "uncommon" },
  premium: { key: "premium", label: "Premium", price: 5000000, size: 13, rarity: "rare" },
  elite: { key: "elite", label: "Elite", price: 250000000, size: 17, rarity: "legendary" },
};

// Race/show prizes by the racing pet's rarity [1st,2nd,3rd].
const RACE_PRIZES = {
  common: [20000, 10000, 5000],
  uncommon: [200000, 100000, 50000],
  rare: [2000000, 1000000, 500000],
  legendary: [2000000000, 1000000000, 500000000],
  mythical: [20000000000, 10000000000, 5000000000],
};

const PAW = "\uD83D\uDC3E";
const HEART = "\uD83D\uDC95";
const TROPHY = "\uD83C\uDFC6";
const RUN = "\uD83C\uDFC3";
const BABY = "\uD83C\uDF7C";
const FLAG = "\uD83C\uDFC1";
const BOT_NAMES = ["Rex", "Bella", "Max", "Luna", "Duke", "Daisy", "Zeus", "Coco", "Rocky", "Milo", "Shadow", "Buddy", "Ace", "Nala", "Bear", "Gizmo"];

// ── Persistence (own JSON store) ─────────────────────────────
const DATA_DIR = path.join(__dirname, "data");
const FILE = path.join(DATA_DIR, "pets.json");
let state = { users: {}, market: { listings: {}, seq: 0 }, store: { items: [], refreshAt: 0 } };
let saveTimer = null;

function load() {
  try {
    if (fs.existsSync(FILE)) {
      const p = JSON.parse(fs.readFileSync(FILE, "utf8"));
      state = {
        users: p.users || {},
        market: p.market && typeof p.market === "object" ? p.market : { listings: {}, seq: 0 },
        store: p.store && typeof p.store === "object" ? p.store : { items: [], refreshAt: 0 },
      };
    }
  } catch (e) {
    console.error("[pets] failed to load, starting fresh:", e.message);
    state = { users: {}, market: { listings: {}, seq: 0 }, store: { items: [], refreshAt: 0 } };
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
    console.error("[pets] save failed:", e.message);
  }
}
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 200);
}
for (const sig of ["SIGINT", "SIGTERM", "beforeExit"]) {
  process.on(sig, () => { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; saveNow(); } });
}

function ensure(id) {
  if (!state.users[id]) {
    state.users[id] = { pets: [], selected: null, seeds: [], potions: 0, hasLab: false, labJob: null, lastAttack: 0, lastRace: 0, lastShow: 0, poundCd: {}, seq: 0 };
  }
  const u = state.users[id];
  if (!Array.isArray(u.pets)) u.pets = [];
  if (!Array.isArray(u.seeds)) u.seeds = [];
  if (typeof u.potions !== "number") u.potions = 0;
  if (typeof u.seq !== "number") u.seq = 0;
  if (typeof u.poundCd !== "object" || !u.poundCd) u.poundCd = {};
  if (!u.station || typeof u.station !== "object") u.station = { owned: false, tier: 0, species: null, male: null, females: [], lastCycle: 0, pending: 0, cyclesRun: 0 };
  if (!Array.isArray(u.station.females)) u.station.females = [];
  if (typeof u.station.tier !== "number") u.station.tier = 0;
  if (typeof u.station.pending !== "number") u.station.pending = 0;
  return u;
}

// ── Money helpers (route through economy) ───────────────────────
function walletOf(id) { return economy.getUser(id).wallet; }
function spend(id, cost) {
  if (walletOf(id) < cost) return false;
  economy.addWallet(id, -cost);
  return true;
}
function pay(id, amt) { return economy.addWallet(id, amt); }
function money(n) { return h.money(n); }

// ── Pet identity / lifecycle ───────────────────────────────
function newIid(u) { u.seq = (u.seq || 0) + 1; return "p" + u.seq.toString(36) + Date.now().toString(36).slice(-3); }
function ageMs(pet) { return Date.now() - (pet.bornAt || 0); }
function stageOf(pet) {
  const a = ageMs(pet);
  if (a < PUPPY_MS) return "puppy";
  if (a < FERTILE_END_MS) return "adult";
  return "mature";
}
function isPuppy(pet) { return stageOf(pet) === "puppy"; }
function inHeat(pet) { return (ageMs(pet) % HEAT_CYCLE_MS) < HEAT_ON_MS; }
// Female fertile if within her window (natural to 72h, or 1 week if seed used now).
function femaleFertile(pet, withSeed) {
  const a = ageMs(pet);
  return a >= PUPPY_MS && a <= (withSeed ? SEED_FERTILE_END_MS : FERTILE_END_MS);
}
// Males can sire for life once adult.
function maleFertile(pet) { return ageMs(pet) >= PUPPY_MS; }

function breedName(pet) {
  if (pet.species === "hybrid") return pet.mixLabel || "Dog-Cat";
  if (pet.mixed) return pet.mixLabel || "Mixed Breed";
  const b = pb.getBreed(pet.breedKey);
  return b ? b.name : "Mutt";
}
function speciesEmoji(pet) { return pb.SPECIES_EMOJI[pet.species] || PAW; }
function rarTag(pet) { const r = pb.RARITY[pet.rarity]; return r ? `${r.emoji} ${r.label}` : pet.rarity; }
function petValue(pet) { if (pet.value != null) return pet.value; return pet.species === "hybrid" ? pb.HYBRID_MIN : pb.valueOf(pet); }
function sexSym(pet) { return pet.sex === "male" ? "\u2642" : "\u2640"; }

function fmtDur(ms) {
  if (ms <= 0) return "now";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  if (d) return `${d}d ${hh}h`;
  if (hh) return `${hh}h ${m}m`;
  if (m) return `${m}m ${ss}s`;
  return `${ss}s`;
}

// ── Pet creation ──────────────────────────────────────
function makePetFromBreed(u, breed, opts) {
  opts = opts || {};
  const size = opts.size != null ? opts.size : pb.rollSize();
  const stats = pb.rollStats(opts.rarity || breed.rarity, size);
  return {
    iid: newIid(u),
    species: breed.species,
    breedKey: breed.key,
    mixed: false,
    name: opts.name || breed.name,
    sex: opts.sex || (Math.random() < 0.5 ? "male" : "female"),
    size,
    weight: pb.weightForSize(breed, size),
    rarity: opts.rarity || breed.rarity,
    purebred: opts.purebred != null ? opts.purebred : breed.purebred,
    stats,
    bornAt: opts.bornAt != null ? opts.bornAt : Date.now(),
    image: null,
    pregnant: null,
    lastFed: Date.now(),
    lastWalked: Date.now(),
    lastSemen: 0,
  };
}

function capLeft(u) { return MAX_PETS - u.pets.length; }

// ── Lazy resolution: reap neglected pets, deliver litters + lab jobs ─────
function resolve(id) {
  const u = ensure(id);
  const events = [];
  // 1) neglect: mature pets unfed OR unwalked beyond NEGLECT_MS run away
  const now = Date.now();
  const kept = [];
  for (const p of u.pets) {
    if (stageOf(p) === "mature") {
      const starved = now - (p.lastFed || p.bornAt || now) > NEGLECT_MS;
      const unwalked = now - (p.lastWalked || p.bornAt || now) > NEGLECT_MS;
      if (starved || unwalked) {
        events.push(`${RUN} **${p.name}** (${breedName(p)}) ran away \u2014 neglected too long.`);
        if (u.selected === p.iid) u.selected = null;
        continue;
      }
    }
    kept.push(p);
  }
  u.pets = kept;
  // 2) pregnancies due
  for (const p of u.pets) {
    if (p.pregnant && now >= p.pregnant.dueAt) {
      const litter = birth(u, p);
      const preg = p.pregnant;
      p.pregnant = null;
      if (litter.length) {
        events.push(`${BABY} **${p.name}** gave birth to **${litter.length}** ${litter.length === 1 ? "baby" : "babies"}! (${litter.map((x) => x.name + " " + sexSym(x)).join(", ")})`);
      } else {
        events.push(`${BABY} **${p.name}**'s litter had nowhere to go \u2014 your home is full (${MAX_PETS}).`);
      }
      if (preg.viaPotion) events[events.length - 1] += " \u2728 purebred via potion!";
    }
  }
  // 3) lab job done
  if (u.hasLab && u.labJob && now >= u.labJob.dueAt) {
    const job = u.labJob;
    u.labJob = null;
    if (capLeft(u) > 0) {
      const hyb = makeHybrid(u, job);
      u.pets.push(hyb);
      events.push(`${pb.SPECIES_EMOJI.hybrid} THE LAB IS DONE \u2014 your dog-cat **${hyb.name}** was born, valued at **${money(hyb.value)}**!`);
    } else {
      events.push(`${pb.SPECIES_EMOJI.hybrid} your lab finished but your home is full (${MAX_PETS}) \u2014 make room and it'll be waiting.`);
      u.labJob = job; // keep until there's room
      u.labJob.dueAt = now; // already due
    }
  }
  if (events.length) scheduleSave();
  return events;
}

function birth(u, mom) {
  const preg = mom.pregnant;
  const momBreed = pb.getBreed(mom.breedKey);
  const sireBreedKey = preg.sireBreedKey;
  const sireBreed = sireBreedKey ? pb.getBreed(sireBreedKey) : momBreed;
  const avgSize = ((mom.size || 0) + (preg.sireSize || mom.size || 0)) / 2;
  // litter size 1-4 by avg size (bigger parents -> bigger litters)
  let litterN = 1 + Math.round((Math.min(pb.MAX_NATURAL_SIZE, avgSize) / pb.MAX_NATURAL_SIZE) * 3);
  litterN = Math.max(1, Math.min(4, litterN + (Math.random() < 0.5 ? 0 : (Math.random() < 0.5 ? -1 : 1))));
  if (preg.viaPotion) litterN = 1 + (Math.random() < 0.3 ? 1 : 0); // potion litters are small
  const out = [];
  for (let i = 0; i < litterN; i++) {
    if (capLeft(u) <= 0) break;
    const sameBreed = sireBreed && momBreed && sireBreed.key === momBreed.key;
    const purebred = preg.viaPotion ? true : !!(sameBreed && momBreed.purebred && sireBreed.purebred);
    let breed = momBreed;
    let mixed = false, mixLabel = null, rarity = momBreed ? momBreed.rarity : "common";
    if (!preg.viaPotion && !sameBreed && sireBreed && momBreed) {
      mixed = true;
      breed = Math.random() < 0.5 ? momBreed : sireBreed;
      mixLabel = `${sireBreed.name} \u00d7 ${momBreed.name} Mix`;
      // mixes lean toward the lower parent rarity
      const ri = Math.min(pb.RARITY_ORDER.indexOf(sireBreed.rarity), pb.RARITY_ORDER.indexOf(momBreed.rarity));
      rarity = pb.RARITY_ORDER[Math.max(0, ri)];
    }
    // puppy size from parents +/- variance (potion uses the boosted roll)
    let size;
    if (preg.viaPotion) size = pb.rollPotionSize();
    else size = Math.max(0, Math.min(pb.MAX_NATURAL_SIZE, avgSize + (Math.random() * 4 - 2)));
    size = Math.round(size * 10) / 10;
    const stats = pb.rollStats(rarity, size);
    out.push({
      iid: newIid(u),
      species: mom.species,
      breedKey: breed ? breed.key : mom.breedKey,
      mixed, mixLabel,
      name: mixed ? mixLabel : (breed ? breed.name : "Pup"),
      sex: Math.random() < 0.5 ? "male" : "female",
      size,
      weight: pb.weightForSize(breed, size),
      rarity,
      purebred,
      stats,
      bornAt: Date.now(),
      image: null,
      pregnant: null,
      lastFed: Date.now(),
      lastWalked: Date.now(),
      lastSemen: 0,
    });
  }
  for (const pup of out) u.pets.push(pup);
  return out;
}

function makeHybrid(u, job) {
  const value = pb.hybridValue(Math.random, job.dogOverall, job.catOverall);
  const size = Math.round((10 + Math.random() * 20) * 10) / 10;
  const stats = pb.rollStats("mythical", Math.min(pb.MAX_NATURAL_SIZE, size));
  const label = `${job.dogName} \u00d7 ${job.catName}`;
  return {
    iid: newIid(u),
    species: "hybrid",
    breedKey: null,
    mixed: true,
    mixLabel: label,
    name: label,
    sex: Math.random() < 0.5 ? "male" : "female",
    size,
    weight: Math.round(15 + Math.random() * 40),
    rarity: "mythical",
    purebred: false,
    stats,
    bornAt: Date.now(),
    image: null,
    pregnant: null,
    lastFed: Date.now(),
    lastWalked: Date.now(),
    lastSemen: 0,
    value,
  };
}

// ── Resolution helpers for index -> pet ─────────────────────────
function resolvePet(id, token, filter) {
  const u = ensure(id);
  const list = filter ? u.pets.filter(filter) : u.pets;
  if (!u.pets.length) return { error: `you don't have any pets yet \u2014 hit the pound: \`${PREFIX}pound dog\` or \`${PREFIX}pound cat\`` };
  const n = parseInt(token, 10);
  if (!Number.isInteger(n) || n < 1 || n > u.pets.length) {
    return { error: `pick a pet number between 1 and ${u.pets.length} (see \`${PREFIX}pets\`)` };
  }
  return { pet: u.pets[n - 1], u };
}

function notice(events) { return events && events.length ? events.join("\n") + "\n\n" : ""; }

// ── Display helpers ───────────────────────────────────────
const CB = String.fromCharCode(96); // backtick for inline code in messages
function code(s) { return CB + s + CB; }

function parsePrice(s) {
  if (!s) return null;
  s = String(s).trim().toLowerCase().replace(/,/g, "");
  const m = s.match(/^([0-9]*\.?[0-9]+)\s*([kmbtq]?)$/);
  if (!m) return null;
  const mult = { "": 1, k: 1e3, m: 1e6, b: 1e9, t: 1e12, q: 1e15 };
  return Math.floor(parseFloat(m[1]) * mult[m[2]]);
}

function bar(v) {
  v = Math.max(0, Math.min(100, Math.round(v || 0)));
  const f = Math.round(v / 10);
  return "\u2588".repeat(f) + "\u2591".repeat(10 - f) + " " + v;
}

function stageLabel(pet) {
  const a = ageMs(pet);
  if (a < PUPPY_MS) return "Puppy \u00b7 grows up in " + fmtDur(PUPPY_MS - a);
  if (a < FERTILE_END_MS) return "Adult \u00b7 fertile (" + fmtDur(FERTILE_END_MS - a) + " of window left)";
  return "Mature pet \u00b7 needs feeding & walks";
}

function activePet(u) { return u.pets.find((p) => p.iid === u.selected) || u.pets[0] || null; }

function petCard(pet) {
  const r = pb.RARITY[pet.rarity] || pb.RARITY.common;
  const e = new EmbedBuilder()
    .setColor(r.color)
    .setTitle(speciesEmoji(pet) + " " + pet.name + " " + sexSym(pet))
    .setDescription(breedName(pet) + " \u00b7 " + r.emoji + " " + r.label + (pet.purebred ? " \u00b7 \uD83C\uDF96 purebred" : ""));
  const st = pet.stats || {};
  e.addFields(
    { name: "Stage", value: stageLabel(pet), inline: false },
    { name: "Size", value: String(pet.size), inline: true },
    { name: "Weight", value: pet.weight + " lb", inline: true },
    { name: "Value", value: money(petValue(pet)), inline: true },
    { name: "Speed", value: bar(st.speed), inline: true },
    { name: "Stamina", value: bar(st.stamina), inline: true },
    { name: "Temperament", value: bar(st.temperament), inline: true },
  );
  if (pet.pregnant) {
    e.addFields({ name: "\uD83E\uDD30 Expecting", value: "due in " + fmtDur(pet.pregnant.dueAt - Date.now()) + (pet.pregnant.viaPotion ? " (potion purebred)" : ""), inline: false });
  } else if (pet.sex === "female" && !isPuppy(pet) && femaleFertile(pet, false)) {
    e.addFields({ name: "Breeding", value: inHeat(pet) ? "\uD83D\uDD25 in heat now" : "window open (not in heat \u2014 ~90% lower odds)", inline: false });
  }
  if (pet.image) e.setThumbnail(pet.image);
  return e;
}

function reply(message, pre, payload) {
  if (typeof payload === "string") return message.reply((pre || "") + payload);
  if (pre) payload.content = (payload.content || "") + "";
  if (pre) payload.content = pre + (payload.content || "");
  return message.reply(payload);
}

function breedChance(male, female) {
  const wMax = Math.max(male.weight || 1, female.weight || 1) || 1;
  const weightPen = Math.abs((male.weight || 0) - (female.weight || 0)) / wMax;
  const sameBreed = male.breedKey && female.breedKey && male.breedKey === female.breedKey && !male.mixed && !female.mixed;
  const sizeBonus = ((male.size || 0) / pb.MAX_NATURAL_SIZE) * 0.4;
  let c = 0.55 + (sameBreed ? 0.25 : 0) - 0.35 * weightPen + sizeBonus;
  c = Math.max(0.05, Math.min(0.95, c));
  if (female.iid && !inHeat(female)) c *= 0.10; // heats: ~90% lower outside heat
  return c;
}

function refreshStore() {
  const now = Date.now();
  if (state.store.items.length && now < state.store.refreshAt) return;
  state.store.items = [];
  for (let i = 0; i < STORE_SIZE; i++) {
    const species = Math.random() < 0.5 ? "dog" : "cat";
    const breed = pb.rollBreed(species);
    const size = pb.rollSize();
    const proto = { species: breed.species, breedKey: breed.key, rarity: breed.rarity, purebred: breed.purebred, size, weight: pb.weightForSize(breed, size), stats: pb.rollStats(breed.rarity, size) };
    const price = Math.max(POUND_COST, Math.floor(pb.valueOf(proto) * 2));
    state.store.items.push({ breedKey: breed.key, species: breed.species, sex: Math.random() < 0.5 ? "male" : "female", size, price });
  }
  state.store.refreshAt = now + STORE_REFRESH_MS;
  scheduleSave();
}

// ── Handlers ─────────────────────────────────────────
async function cmdPets(message) {
  const id = message.author.id;
  const pre = notice(resolve(id));
  const u = ensure(id);
  if (!u.pets.length) return message.reply(pre + "You have no pets. Adopt at the pound (" + code(PREFIX + "pound dog") + " / " + code(PREFIX + "pound cat") + ") or buy from " + code(PREFIX + "petstore") + ".");
  const lines = u.pets.map((p, i) => {
    const sel = u.selected === p.iid ? "\u2B50" : "";
    const st = stageOf(p);
    const tag = st === "puppy" ? "\uD83C\uDF7C" : st === "adult" ? "\u2764\uFE0F" : "\uD83D\uDC15";
    let extra = "";
    // Show each puppy's own grow-up countdown so same-breed pets are easy to
    // tell apart (a newborn shows ~1h; a near-adult shows a few minutes).
    if (st === "puppy") extra = " \u00b7 \uD83C\uDF7C grows up in " + fmtDur(PUPPY_MS - ageMs(p));
    else if (p.pregnant) extra = " \uD83E\uDD30 due " + fmtDur(p.pregnant.dueAt - Date.now());
    else if (p.sex === "female" && femaleFertile(p, false)) extra = inHeat(p) ? " \uD83D\uDD25in heat" : " (window open)";
    const re = pb.RARITY[p.rarity] ? pb.RARITY[p.rarity].emoji : "";
    return "**" + (i + 1) + ".** " + sel + speciesEmoji(p) + tag + " **" + p.name + "** " + sexSym(p) + " \u00b7 " + breedName(p) + " " + re + " \u00b7 sz " + p.size + " \u00b7 " + money(petValue(p)) + extra;
  });
  // Paginate so big collections don't blow past Discord's 4096-char embed limit.
  const PAGE_SIZE = 25;
  const pageCount = Math.ceil(lines.length / PAGE_SIZE);
  for (let pg = 0; pg < pageCount; pg++) {
    const slice = lines.slice(pg * PAGE_SIZE, (pg + 1) * PAGE_SIZE);
    let title = PAW + " " + message.author.username + "'s Pets (" + u.pets.length + "/" + MAX_PETS + ")";
    if (pageCount > 1) title += " \u2014 page " + (pg + 1) + "/" + pageCount;
    const e = new EmbedBuilder().setColor(0xe67e22).setTitle(title).setDescription(slice.join("\n"));
    if (pg === pageCount - 1) e.setFooter({ text: PREFIX + "pet <#> for details \u00b7 " + PREFIX + "pethelp for all commands" });
    const payload = { embeds: [e] };
    if (pg === 0 && pre) payload.content = pre;
    if (pg === 0) await message.reply(payload);
    else await message.channel.send(payload);
  }
}

async function cmdPet(message, args) {
  const id = message.author.id;
  const pre = notice(resolve(id));
  const u = ensure(id);
  const sub = (args[0] || "").toLowerCase();
  if (sub === "select") {
    const r = resolvePet(id, args[1]); if (r.error) return message.reply(pre + r.error);
    if (isPuppy(r.pet)) return message.reply(pre + "Puppies can't compete yet.");
    u.selected = r.pet.iid; scheduleSave();
    return message.reply(pre + "\u2B50 **" + r.pet.name + "** is now your active pet for races, shows & attacks.");
  }
  if (sub === "name") return cmdRename(message, args.slice(1));
  if (sub === "image") return cmdImage(message, args.slice(1));
  const token = args[0];
  if (!token) {
    const sel = activePet(u);
    if (!sel) return message.reply(pre + "No pets yet. " + code(PREFIX + "pound dog"));
    const payload = { embeds: [petCard(sel)] }; if (pre) payload.content = pre; return message.reply(payload);
  }
  const r = resolvePet(id, token); if (r.error) return message.reply(pre + r.error);
  const payload = { embeds: [petCard(r.pet)] }; if (pre) payload.content = pre; return message.reply(payload);
}

async function cmdRename(message, args) {
  const id = message.author.id; const pre = notice(resolve(id));
  const r = resolvePet(id, args[0]); if (r.error) return message.reply(pre + r.error);
  const name = args.slice(1).join(" ").trim();
  if (!name) return message.reply(pre + "Usage: " + code(PREFIX + "petname <#> <new name>") + " (costs " + money(RENAME_COST) + ")");
  if (name.length > 32) return message.reply(pre + "Keep names under 32 characters.");
  if (!h.lock(id)) return message.reply("\u23F3 finish your other action first.");
  try {
    if (!spend(id, RENAME_COST)) return message.reply(pre + "Renaming costs " + money(RENAME_COST) + " \u2014 not enough.");
    const old = r.pet.name; r.pet.name = name; scheduleSave();
    return message.reply(pre + "Renamed **" + old + "** \u2192 **" + name + "**.");
  } finally { h.unlock(id); }
}

async function cmdImage(message, args) {
  const id = message.author.id; const pre = notice(resolve(id));
  const r = resolvePet(id, args[0]); if (r.error) return message.reply(pre + r.error);
  const url = (args[1] || "").trim();
  if (!url) return message.reply(pre + "Usage: " + code(PREFIX + "petimage <#> <image url>") + " (shows on the info card, races & market)");
  if (!/^https?:\/\/.+/i.test(url) || !/(png|jpe?g|gif|webp)(\?|$)/i.test(url)) return message.reply(pre + "Give a direct image URL ending in png/jpg/gif/webp.");
  r.pet.image = url; scheduleSave();
  const payload = { embeds: [petCard(r.pet)] }; if (pre) payload.content = pre; return message.reply(payload);
}

async function cmdPound(message, args) {
  const id = message.author.id; const pre = notice(resolve(id)); const u = ensure(id);
  const sp = (args[0] || "").toLowerCase();
  const species = sp.startsWith("cat") ? "cat" : sp.startsWith("dog") ? "dog" : null;
  if (!species) return message.reply(pre + PAW + " **The Pound** \u2014 " + money(POUND_COST) + " for a random rescue (mutt up to purebred legend). Usage: " + code(PREFIX + "pound dog") + " or " + code(PREFIX + "pound cat"));
  if (capLeft(u) <= 0) return message.reply(pre + "Your home is full (" + MAX_PETS + "). Sell or rehome some pets first.");
  const cdLast = (u.poundCd && u.poundCd[species]) || 0;
  const cdLeft = POUND_CD_MS - (Date.now() - cdLast);
  if (cdLeft > 0) {
    const other = species === "cat" ? "dog" : "cat";
    const otherReady = (Date.now() - ((u.poundCd && u.poundCd[other]) || 0)) >= POUND_CD_MS;
    return message.reply(pre + "\u23F3 The **" + species + " pound** is cooling down \u2014 back in **" + fmtDur(cdLeft) + "**." + (otherReady ? " (Your **" + other + "** pull is ready \u2014 " + code(PREFIX + "pound " + other) + ".)" : ""));
  }
  if (!h.lock(id)) return message.reply("\u23F3 finish your other action first.");
  try {
    if (!spend(id, POUND_COST)) return message.reply(pre + "You need " + money(POUND_COST) + " to adopt.");
    const poundVal = pb.poundValue();
    const poundRarity = pb.rarityForValue(poundVal);
    const pet = makePetFromBreed(u, pb.rollBreed(species, Math.random, poundRarity), { bornAt: Date.now(), rarity: poundRarity });
    pet.value = poundVal; // pound rescues carry a fixed, grind-friendly value
    if (!u.poundCd) u.poundCd = {};
    u.poundCd[species] = Date.now(); // start this species' 5-min cooldown
    u.pets.push(pet); scheduleSave();
    const e = petCard(pet).setTitle(PAW + " You adopted: " + pet.name + " " + sexSym(pet));
    const payload = { embeds: [e] }; if (pre) payload.content = pre; return message.reply(payload);
  } finally { h.unlock(id); }
}

async function cmdPetStore(message, args) {
  const id = message.author.id; const pre = notice(resolve(id)); const u = ensure(id);
  refreshStore();
  const sub = (args[0] || "").toLowerCase();
  if (sub === "buy") {
    const n = parseInt(args[1], 10);
    if (!Number.isInteger(n) || n < 1 || n > state.store.items.length) return message.reply(pre + "Pick a stock number 1\u2013" + state.store.items.length + ".");
    if (capLeft(u) <= 0) return message.reply(pre + "Home full (" + MAX_PETS + ").");
    if (!h.lock(id)) return message.reply("\u23F3 finish your other action first.");
    try {
      const item = state.store.items[n - 1]; if (!item) return message.reply(pre + "That one's gone.");
      if (!spend(id, item.price)) return message.reply(pre + "That costs " + money(item.price) + " \u2014 not enough.");
      const pet = makePetFromBreed(u, pb.getBreed(item.breedKey), { sex: item.sex, size: item.size, bornAt: Date.now() - PUPPY_MS });
      u.pets.push(pet); state.store.items.splice(n - 1, 1); scheduleSave();
      const e = petCard(pet).setTitle(speciesEmoji(pet) + " Purchased: " + pet.name + " " + sexSym(pet));
      const payload = { embeds: [e] }; if (pre) payload.content = pre; return message.reply(payload);
    } finally { h.unlock(id); }
  }
  const lines = state.store.items.map((it, i) => {
    const b = pb.getBreed(it.breedKey); const r = pb.RARITY[b.rarity];
    return "**" + (i + 1) + ".** " + pb.SPECIES_EMOJI[it.species] + " " + b.name + " " + (it.sex === "male" ? "\u2642" : "\u2640") + " \u00b7 " + r.emoji + (b.purebred ? " \uD83C\uDF96" : "") + " \u00b7 size " + it.size + " \u2014 **" + money(it.price) + "**";
  });
  const e = new EmbedBuilder().setColor(0x9b59b6).setTitle(PAW + " Pet Store").setDescription(lines.join("\n") || "Sold out \u2014 check back soon.").setFooter({ text: "Refreshes in " + fmtDur(state.store.refreshAt - Date.now()) + " \u00b7 " + PREFIX + "petstore buy <#>" });
  const payload = { embeds: [e] }; if (pre) payload.content = pre; return message.reply(payload);
}

async function cmdBreed(message, args) {
  const id = message.author.id; const pre = notice(resolve(id)); const u = ensure(id);
  const a0 = args[0] || ""; const sub = (args[1] || "").toLowerCase();
  if (!a0) return message.reply(pre + "Usage: " + code(PREFIX + "breed <male#> <female#>") + ", " + code(PREFIX + "breed <female#> seed") + ", or " + code(PREFIX + "breed <pet#> potion") + ".");
  if (!h.lock(id)) return message.reply("\u23F3 finish your other action first.");
  try {
    if (sub === "potion") {
      const r = resolvePet(id, a0); if (r.error) return message.reply(pre + r.error);
      const pet = r.pet;
      if (pet.species === "hybrid") return message.reply(pre + "Hybrids can't breed.");
      if (isPuppy(pet)) return message.reply(pre + pet.name + " is still a baby.");
      if (pet.pregnant) return message.reply(pre + pet.name + " is already expecting.");
      if (u.potions < 1) return message.reply(pre + "You have no potions. Buy one: " + code(PREFIX + "potion buy"));
      u.potions -= 1;
      const g = GESTATION_MIN + Math.random() * (GESTATION_MAX - GESTATION_MIN);
      pet.pregnant = { dueAt: Date.now() + g, viaPotion: true, sireBreedKey: pet.breedKey, sireSize: pet.size };
      scheduleSave();
      return message.reply(pre + "\u2728 Used a **Self-Breed Potion** on **" + pet.name + "**. A **purebred** " + breedName(pet) + " arrives in ~" + fmtDur(g) + ".");
    }
    if (sub === "seed") {
      const r = resolvePet(id, a0); if (r.error) return message.reply(pre + r.error);
      const fem = r.pet;
      if (fem.species === "hybrid" || fem.sex !== "female") return message.reply(pre + "Seed can only be used on a female dog or cat.");
      if (isPuppy(fem)) return message.reply(pre + fem.name + " is still a baby.");
      if (fem.pregnant) return message.reply(pre + fem.name + " is already expecting.");
      if (!femaleFertile(fem, true)) return message.reply(pre + fem.name + " is past her breeding window.");
      if (!u.seeds.length) return message.reply(pre + "You have no breeder seed. Shop: " + code(PREFIX + "seedshop"));
      u.seeds.sort((x, y) => (SEED_GRADES[y.grade] ? SEED_GRADES[y.grade].size : 0) - (SEED_GRADES[x.grade] ? SEED_GRADES[x.grade].size : 0));
      const seed = u.seeds.shift(); const grade = SEED_GRADES[seed.grade] || SEED_GRADES.standard;
      const fb = pb.getBreed(fem.breedKey) || {};
      const synthMale = { weight: pb.weightForSize(fb, grade.size), size: grade.size, breedKey: fem.breedKey, mixed: false };
      const chance = breedChance(synthMale, fem);
      if (Math.random() < chance) {
        const g = GESTATION_MIN + Math.random() * (GESTATION_MAX - GESTATION_MIN);
        fem.pregnant = { dueAt: Date.now() + g, sireBreedKey: fem.breedKey, sireSize: grade.size, viaSeed: true };
        scheduleSave();
        return message.reply(pre + "\u2705 The **" + grade.label + "** breeder seed took! **" + fem.name + "** is pregnant \u2014 due in ~" + fmtDur(g) + ".");
      }
      scheduleSave();
      return message.reply(pre + "\u274C The **" + grade.label + "** seed didn't take (chance " + Math.round(chance * 100) + "%). " + (inHeat(fem) ? "" : "She's not in heat \u2014 try during a heat."));
    }
    // natural
    const b0 = args[1];
    if (!b0 || isNaN(parseInt(b0, 10))) return message.reply(pre + "Breed two pets: " + code(PREFIX + "breed <male#> <female#>"));
    const ra = resolvePet(id, a0); if (ra.error) return message.reply(pre + ra.error);
    const rb = resolvePet(id, b0); if (rb.error) return message.reply(pre + rb.error);
    if (ra.pet === rb.pet) return message.reply(pre + "Pick two different pets.");
    const p1 = ra.pet, p2 = rb.pet;
    if (p1.species === "hybrid" || p2.species === "hybrid") return message.reply(pre + "Hybrids can't breed. (Use the lab for cross-species.)");
    if (p1.species !== p2.species) return message.reply(pre + "Different species can't breed naturally \u2014 build a " + code(PREFIX + "lab") + " to cross a dog with a cat.");
    const male = p1.sex === "male" ? p1 : (p2.sex === "male" ? p2 : null);
    const female = p1.sex === "female" ? p1 : (p2.sex === "female" ? p2 : null);
    if (!male || !female) return message.reply(pre + "You need one male and one female.");
    if (isPuppy(male) || isPuppy(female)) return message.reply(pre + "Babies can't breed yet (must be 24h+).");
    if (female.pregnant) return message.reply(pre + female.name + " is already expecting.");
    if (!femaleFertile(female, false)) return message.reply(pre + female.name + " is past her natural window (try " + code(PREFIX + "seedshop") + " for an extended window).");
    const chance = breedChance(male, female);
    if (Math.random() < chance) {
      const g = GESTATION_MIN + Math.random() * (GESTATION_MAX - GESTATION_MIN);
      female.pregnant = { dueAt: Date.now() + g, sireBreedKey: male.breedKey, sireSize: male.size, sirePurebred: male.purebred, sireRarity: male.rarity };
      scheduleSave();
      return message.reply(pre + HEART + " **" + male.name + "** \u00d7 **" + female.name + "** \u2014 it worked! Babies due in ~" + fmtDur(g) + ". (chance " + Math.round(chance * 100) + "%)");
    }
    return message.reply(pre + "\uD83D\uDC94 **" + male.name + "** \u00d7 **" + female.name + "** didn't take (chance " + Math.round(chance * 100) + "%). " + (inHeat(female) ? "" : "She's not in heat \u2014 odds are ~90% lower outside heat."));
  } finally { h.unlock(id); }
}

async function cmdSemen(message, args) {
  const id = message.author.id; const pre = notice(resolve(id));
  const r = resolvePet(id, args[0]); if (r.error) return message.reply(pre + r.error);
  const m = r.pet;
  if (m.species === "hybrid" || m.sex !== "male") return message.reply(pre + "Only male dogs/cats can sell semen.");
  if (isPuppy(m)) return message.reply(pre + m.name + " is too young.");
  const sinceMs = Date.now() - (m.lastSemen || 0);
  if (sinceMs < SEMEN_CD_MS) return message.reply(pre + m.name + " needs to recover \u2014 " + fmtDur(SEMEN_CD_MS - sinceMs) + " left.");
  if (!h.lock(id)) return message.reply("\u23F3 finish your other action first.");
  try {
    const rr = pb.RARITY[m.rarity] || pb.RARITY.common;
    const val = Math.floor(rr.base * 0.1 * (0.5 + m.size / pb.MAX_NATURAL_SIZE) * (0.5 + ((m.stats.overall) || 50) / 100) * (m.purebred ? 1.6 : 1));
    m.lastSemen = Date.now();
    const nw = pay(id, val); scheduleSave();
    return message.reply(pre + "\uD83E\uDDEA Sold a sample from **" + m.name + "** for **" + money(val) + "**. (wallet: " + money(nw) + ")");
  } finally { h.unlock(id); }
}

async function cmdSeedShop(message, args) {
  const id = message.author.id; const pre = notice(resolve(id)); const u = ensure(id);
  const sub = (args[0] || "").toLowerCase();
  if (sub !== "buy") {
    const lines = Object.values(SEED_GRADES).map((g) => "\u2022 **" + g.label + "** \u2014 " + money(g.price) + " (sire size ~" + g.size + ", " + g.rarity + ")");
    return message.reply(pre + HEART + " **Breeder Seed Shop** \u2014 lets a female breed WITHOUT a male and extends her window to **1 week**.\n" + lines.join("\n") + "\nBuy: " + code(PREFIX + "seedshop buy <standard|premium|elite>") + ". You hold **" + u.seeds.length + "** seed(s). Use: " + code(PREFIX + "breed <female#> seed"));
  }
  const gk = (args[1] || "").toLowerCase(); const g = SEED_GRADES[gk];
  if (!g) return message.reply(pre + "Pick a grade: standard, premium, or elite.");
  if (!h.lock(id)) return message.reply("\u23F3 finish your other action first.");
  try {
    if (!spend(id, g.price)) return message.reply(pre + "**" + g.label + "** seed costs " + money(g.price) + " \u2014 not enough.");
    u.seeds.push({ grade: g.key, boughtAt: Date.now() }); scheduleSave();
    return message.reply(pre + "Bought **" + g.label + "** breeder seed for " + money(g.price) + ". Seeds held: **" + u.seeds.length + "**.");
  } finally { h.unlock(id); }
}

async function cmdPotion(message, args) {
  const id = message.author.id; const pre = notice(resolve(id)); const u = ensure(id);
  const sub = (args[0] || "").toLowerCase();
  if (sub !== "buy") {
    return message.reply(pre + "\u2728 **Self-Breed Potion** \u2014 lets ONE pet breed with itself for a guaranteed **purebred** (size up to " + pb.MAX_POTION_SIZE + "; past " + pb.MAX_NATURAL_SIZE + " gets exponentially rarer & more valuable). You have **" + u.potions + "**.\nBuy (price varies " + money(POTION_MIN) + "\u2013" + money(POTION_MAX) + "): " + code(PREFIX + "potion buy") + ". Then " + code(PREFIX + "breed <pet#> potion") + ".");
  }
  if (!h.lock(id)) return message.reply("\u23F3 finish your other action first.");
  try {
    const cost = Math.floor(POTION_MIN + Math.random() * (POTION_MAX - POTION_MIN));
    if (walletOf(id) < cost) return message.reply(pre + "This batch costs **" + money(cost) + "** \u2014 you can't afford it.");
    spend(id, cost); u.potions += 1; scheduleSave();
    return message.reply(pre + "\u2728 Bought a **Self-Breed Potion** for **" + money(cost) + "**. You now have **" + u.potions + "**. Use: " + code(PREFIX + "breed <pet#> potion"));
  } finally { h.unlock(id); }
}

async function cmdLab(message, args) {
  const id = message.author.id; const pre = notice(resolve(id)); const u = ensure(id);
  const sub = (args[0] || "").toLowerCase();
  if (sub === "buy") {
    if (u.hasLab) return message.reply(pre + "You already own a Gene Lab.");
    if (!h.lock(id)) return message.reply("\u23F3 finish your other action first.");
    try {
      if (walletOf(id) < LAB_COST) return message.reply(pre + "The Gene Lab costs **" + money(LAB_COST) + "** (1 quadrillion). You're not there yet.");
      spend(id, LAB_COST); u.hasLab = true; scheduleSave();
      return message.reply(pre + pb.SPECIES_EMOJI.hybrid + " You built a **Gene Lab**! Cross a dog \u00d7 cat for **" + money(LAB_BREED_COST) + "** per procedure (24h). Each dog-cat sells for **5\u2013500 quadrillion**. " + code(PREFIX + "lab breed <dog#> <cat#>"));
    } finally { h.unlock(id); }
  }
  if (sub === "breed") {
    if (!u.hasLab) return message.reply(pre + "You need a Gene Lab first: " + code(PREFIX + "lab buy") + " (" + money(LAB_COST) + ").");
    if (u.labJob) return message.reply(pre + "The lab is busy \u2014 " + fmtDur(u.labJob.dueAt - Date.now()) + " left.");
    const rd = resolvePet(id, args[1]); if (rd.error) return message.reply(pre + rd.error);
    const rc = resolvePet(id, args[2]); if (rc.error) return message.reply(pre + rc.error);
    const dog = rd.pet, cat = rc.pet;
    if (dog.species !== "dog" || cat.species !== "cat") return message.reply(pre + "Order matters: " + code(PREFIX + "lab breed <dog#> <cat#>") + " (a dog first, then a cat).");
    if (isPuppy(dog) || isPuppy(cat)) return message.reply(pre + "Both must be 24h+ (no babies).");
    if (!h.lock(id)) return message.reply("\u23F3 finish your other action first.");
    try {
      if (walletOf(id) < LAB_BREED_COST) return message.reply(pre + "The procedure costs **" + money(LAB_BREED_COST) + "** \u2014 not enough.");
      spend(id, LAB_BREED_COST);
      u.labJob = { dueAt: Date.now() + LAB_DURATION_MS, dogOverall: dog.stats.overall, catOverall: cat.stats.overall, dogName: breedName(dog), catName: breedName(cat) };
      scheduleSave();
      return message.reply(pre + pb.SPECIES_EMOJI.hybrid + " Procedure started: **" + breedName(dog) + " \u00d7 " + breedName(cat) + "**. Ready in **24h**. Better parent stats \u2192 higher payout. Check " + code(PREFIX + "lab") + ".");
    } finally { h.unlock(id); }
  }
  const lines = [pb.SPECIES_EMOJI.hybrid + " **Gene Lab** " + (u.hasLab ? "\u2705 owned" : "\u274C not built")];
  if (!u.hasLab) lines.push("Build it for **" + money(LAB_COST) + "** (1 quadrillion): " + code(PREFIX + "lab buy"));
  else {
    lines.push("Procedure: **" + money(LAB_BREED_COST) + "** \u00b7 24h \u00b7 yields a dog-cat worth **5\u2013500 quadrillion**");
    if (u.labJob) lines.push("\u23F3 In progress: **" + u.labJob.dogName + " \u00d7 " + u.labJob.catName + "** \u2014 " + fmtDur(u.labJob.dueAt - Date.now()) + " left");
    else lines.push("Idle \u2014 " + code(PREFIX + "lab breed <dog#> <cat#>"));
  }
  return message.reply(pre + lines.join("\n"));
}

async function cmdMarket(message, args) {
  const id = message.author.id; const pre = notice(resolve(id)); const u = ensure(id);
  const sub = (args[0] || "").toLowerCase();
  if (sub === "sell") {
    const r = resolvePet(id, args[1]); if (r.error) return message.reply(pre + r.error);
    const price = parsePrice(args[2]);
    if (!Number.isInteger(price) || price < 1) return message.reply(pre + "Set a price: " + code(PREFIX + "petmarket sell <#> <price>") + " (supports k/m/b/t/q).");
    if (!h.lock(id)) return message.reply("\u23F3 finish your other action first.");
    try {
      const idx = u.pets.indexOf(r.pet); if (idx < 0) return message.reply(pre + "Pet not found.");
      if (u.selected === r.pet.iid) u.selected = null;
      u.pets.splice(idx, 1);
      state.market.seq = (state.market.seq || 0) + 1; const lid = "m" + state.market.seq;
      state.market.listings[lid] = { lid, sellerId: id, price, pet: r.pet, listedAt: Date.now() };
      scheduleSave();
      return message.reply(pre + "Listed **" + r.pet.name + "** (" + breedName(r.pet) + ") for **" + money(price) + "** as " + code(lid) + ". Unlist: " + code(PREFIX + "petmarket unlist " + lid));
    } finally { h.unlock(id); }
  }
  if (sub === "buy") {
    const lid = (args[1] || "").toLowerCase(); const L = state.market.listings[lid];
    if (!L) return message.reply(pre + "No listing with that ID.");
    if (L.sellerId === id) return message.reply(pre + "That's your own listing.");
    if (capLeft(u) <= 0) return message.reply(pre + "Home full (" + MAX_PETS + ").");
    if (!h.lock(id)) return message.reply("\u23F3 finish your other action first.");
    try {
      const cur = state.market.listings[lid]; if (!cur) return message.reply(pre + "Already sold.");
      if (!spend(id, cur.price)) return message.reply(pre + "You need " + money(cur.price) + ".");
      const pet = cur.pet; pet.iid = newIid(u); u.pets.push(pet);
      pay(cur.sellerId, cur.price); delete state.market.listings[lid]; scheduleSave();
      const e = petCard(pet).setTitle(speciesEmoji(pet) + " Bought: " + pet.name + " " + sexSym(pet));
      const payload = { embeds: [e] }; if (pre) payload.content = pre; return message.reply(payload);
    } finally { h.unlock(id); }
  }
  if (sub === "unlist") {
    const lid = (args[1] || "").toLowerCase(); const L = state.market.listings[lid];
    if (!L || L.sellerId !== id) return message.reply(pre + "That's not your listing.");
    if (capLeft(u) <= 0) return message.reply(pre + "Home full \u2014 make room to reclaim it.");
    const pet = L.pet; pet.iid = newIid(u); u.pets.push(pet); delete state.market.listings[lid]; scheduleSave();
    return message.reply(pre + "Unlisted **" + pet.name + "** \u2014 back in your home.");
  }
  if (sub === "mine") {
    const mine = Object.values(state.market.listings).filter((L) => L.sellerId === id);
    if (!mine.length) return message.reply(pre + "You have no active listings.");
    return message.reply(pre + mine.map((L) => code(L.lid) + " " + speciesEmoji(L.pet) + " " + L.pet.name + " (" + breedName(L.pet) + ") \u2014 " + money(L.price)).join("\n"));
  }
  const all = Object.values(state.market.listings).sort((a, b) => a.price - b.price).slice(0, 20);
  if (!all.length) return message.reply(pre + "The marketplace is empty. List one: " + code(PREFIX + "petmarket sell <#> <price>"));
  const e = new EmbedBuilder().setColor(0x1abc9c).setTitle(PAW + " Pet Marketplace").setDescription(all.map((L) => {
    const p = L.pet; const r = pb.RARITY[p.rarity];
    return code(L.lid) + " " + speciesEmoji(p) + " **" + p.name + "** " + sexSym(p) + " \u00b7 " + breedName(p) + " " + (r ? r.emoji : "") + " \u00b7 sz " + p.size + " \u2014 **" + money(L.price) + "**";
  }).join("\n")).setFooter({ text: PREFIX + "petmarket buy <id> \u00b7 " + PREFIX + "petmarket sell <#> <price>" });
  const payload = { embeds: [e] }; if (pre) payload.content = pre; return message.reply(payload);
}

async function cmdPetSell(message, args) {
  const id = message.author.id; const pre = notice(resolve(id)); const u = ensure(id);
  const a0 = (args[0] || "").toLowerCase();
  if (!a0) return message.reply(pre + "Sell to the shelter for cash: " + code(PREFIX + "petsell <#>") + ", " + code(PREFIX + "petsell 1 3 5") + ", " + code(PREFIX + "petsell all") + ", by rarity (e.g. " + code(PREFIX + "petsell common") + "), or by breed (e.g. " + code(PREFIX + "petsell golden retriever") + ").");
  if (!h.lock(id)) return message.reply("\u23F3 finish your other action first.");
  try {
    // Sell all
    if (a0 === "all") {
      if (!u.pets.length) return message.reply(pre + "No pets to sell.");
      let total = 0, n = 0;
      for (const p of u.pets) { total += petValue(p); n++; }
      u.pets = []; u.selected = null; pay(id, total); scheduleSave();
      return message.reply(pre + "Sold **" + n + "** pets for **" + money(total) + "**.");
    }
    // Sell by rarity, e.g. !petsell common
    if (RARITY_KEYS.includes(a0) && args.length === 1) {
      const rl = pb.RARITY[a0];
      const matches = u.pets.filter((p) => p.rarity === a0);
      if (!matches.length) return message.reply(pre + "You have no " + rl.emoji + " " + rl.label + " pets to sell.");
      const ids = new Set(matches.map((p) => p.iid));
      let total = 0;
      for (const p of matches) total += petValue(p);
      u.pets = u.pets.filter((p) => !ids.has(p.iid));
      if (u.selected && !u.pets.some((p) => p.iid === u.selected)) u.selected = null;
      pay(id, total); scheduleSave();
      return message.reply(pre + "Sold **" + matches.length + "** " + rl.emoji + " " + rl.label + " pet" + (matches.length === 1 ? "" : "s") + " for **" + money(total) + "**.");
    }
    // Sell by breed name (all args joined), e.g. !petsell golden retriever
    const breedQuery = args.join(" ").toLowerCase();
    const matchedBreed = pb.allBreeds().find((b) => b.name.toLowerCase() === breedQuery);
    if (matchedBreed) {
      const matches = u.pets.filter((p) => p.breedKey === matchedBreed.key);
      if (!matches.length) return message.reply(pre + "You have no **" + matchedBreed.name + "** pets to sell.");
      const iids = new Set(matches.map((p) => p.iid));
      let total = 0;
      for (const p of matches) total += petValue(p);
      u.pets = u.pets.filter((p) => !iids.has(p.iid));
      if (u.selected && !u.pets.some((p) => p.iid === u.selected)) u.selected = null;
      pay(id, total); scheduleSave();
      return message.reply(pre + "Sold **" + matches.length + "** **" + matchedBreed.name + "** pet" + (matches.length === 1 ? "" : "s") + " for **" + money(total) + "**.");
    }
    // Sell multiple by index, e.g. !petsell 1 3 5
    if (args.length > 1 && args.every((a) => /^\d+$/.test(a))) {
      const indices = [...new Set(args.map((a) => parseInt(a, 10)))];
      const toSell = [];
      const bad = [];
      for (const n of indices) {
        const r = resolvePet(id, String(n));
        if (r.error) bad.push(n);
        else if (!toSell.some((p) => p.iid === r.pet.iid)) toSell.push(r.pet);
      }
      if (!toSell.length) return message.reply(pre + "None of those numbers match pets you own.");
      const iids = new Set(toSell.map((p) => p.iid));
      let total = 0;
      for (const p of toSell) total += petValue(p);
      u.pets = u.pets.filter((p) => !iids.has(p.iid));
      if (u.selected && !u.pets.some((p) => p.iid === u.selected)) u.selected = null;
      pay(id, total); scheduleSave();
      const soldLine = toSell.map((p) => "**" + p.name + "** (" + breedName(p) + ")").join(", ");
      const warn = bad.length ? " (skipped #" + bad.join(", #") + " — not found)" : "";
      return message.reply(pre + "Sold " + soldLine + " for **" + money(total) + "**" + warn + ".");
    }
    // Sell single by index
    const r = resolvePet(id, a0); if (r.error) return message.reply(pre + r.error);
    const val = petValue(r.pet); const idx = u.pets.indexOf(r.pet);
    u.pets.splice(idx, 1); if (u.selected === r.pet.iid) u.selected = null;
    pay(id, val); scheduleSave();
    return message.reply(pre + "Sold **" + r.pet.name + "** (" + breedName(r.pet) + ") for **" + money(val) + "**.");
  } finally { h.unlock(id); }
}

async function cmdPetRace(message) {
  const id = message.author.id; const pre = notice(resolve(id)); const u = ensure(id);
  const pet = activePet(u);
  if (!pet) return message.reply(pre + "Get a pet first (" + code(PREFIX + "pound dog") + ").");
  if (isPuppy(pet)) return message.reply(pre + pet.name + " is too young to race.");
  const since = Date.now() - (u.lastRace || 0);
  if (since < RACE_CD_MS) return message.reply(pre + "Your racer needs a breather \u2014 " + fmtDur(RACE_CD_MS - since) + ".");
  u.lastRace = Date.now(); scheduleSave();
  const TRACK = 20;
  const racers = [{ name: pet.name, emoji: speciesEmoji(pet), spd: pet.stats.speed, sta: pet.stats.stamina, you: true, pos: 0 }];
  const used = new Set();
  for (let i = 0; i < 3; i++) {
    let nm; do { nm = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)]; } while (used.has(nm));
    used.add(nm);
    racers.push({ name: nm, emoji: Math.random() < 0.5 ? pb.SPECIES_EMOJI.dog : pb.SPECIES_EMOJI.cat, spd: 30 + Math.random() * 60, sta: 30 + Math.random() * 60, pos: 0 });
  }
  const render = () => racers.map((r) => {
    const f = Math.min(TRACK, Math.round(r.pos));
    return ".".repeat(f) + r.emoji + ".".repeat(Math.max(0, TRACK - f)) + FLAG + " " + (r.you ? "**" + r.name + "**" : r.name);
  }).join("\n");
  const msg = await message.reply(pre + TROPHY + " **Pet Race!**\n" + render());
  let winner = null;
  for (let tick = 0; tick < 40 && !winner; tick++) {
    await sleep(1100);
    for (const r of racers) {
      const fatigue = 1 - (tick / 60) * (1 - r.sta / 100);
      r.pos += Math.max(0.2, (r.spd / 100) * 2.2 * fatigue * (0.5 + Math.random()));
      if (r.pos >= TRACK) { r.pos = TRACK; if (!winner) winner = r; }
    }
    try { await msg.edit(TROPHY + " **Pet Race!**\n" + render()); } catch (e) {}
  }
  const order = racers.slice().sort((a, b) => b.pos - a.pos);
  const place = order.indexOf(racers.find((r) => r.you)) + 1;
  const prizes = RACE_PRIZES[pet.rarity] || RACE_PRIZES.common;
  let payout = 0, res;
  if (place === 1) { payout = prizes[0]; res = TROPHY + " **" + pet.name + " WON!**"; }
  else if (place === 2) { payout = prizes[1]; res = "\uD83E\uDD48 " + pet.name + " took 2nd."; }
  else if (place === 3) { payout = prizes[2]; res = "\uD83E\uDD49 " + pet.name + " took 3rd."; }
  else { res = pet.name + " finished " + place + "th \u2014 no prize."; }
  if (payout > 0) pay(id, payout);
  try { await msg.edit(TROPHY + " **Pet Race \u2014 Finish!**\n" + render() + "\n\n" + res + (payout > 0 ? " Won **" + money(payout) + "**." : "")); } catch (e) {}
  return;
}

async function cmdPetShow(message) {
  const id = message.author.id; const pre = notice(resolve(id)); const u = ensure(id);
  const pet = activePet(u);
  if (!pet) return message.reply(pre + "Get a pet first.");
  if (isPuppy(pet)) return message.reply(pre + pet.name + " is too young for the show ring.");
  const since = Date.now() - (u.lastShow || 0);
  if (since < SHOW_CD_MS) return message.reply(pre + "The judges need a moment \u2014 " + fmtDur(SHOW_CD_MS - since) + ".");
  u.lastShow = Date.now();
  const judge = 40 + Math.random() * 55;
  const score = (pet.stats.temperament * 0.5 + pet.stats.overall * 0.5) * (0.8 + Math.random() * 0.4);
  const rr = pb.RARITY[pet.rarity] || pb.RARITY.common;
  if (score >= judge) {
    const prize = Math.floor(rr.base * 0.5 * (pet.stats.overall / 100) * (1 + Math.random()));
    pay(id, prize); scheduleSave();
    return message.reply(pre + TROPHY + " **" + pet.name + "** dazzled the judges (" + score.toFixed(0) + " vs " + judge.toFixed(0) + ") and won **" + money(prize) + "**!");
  }
  scheduleSave();
  return message.reply(pre + pet.name + " showed well (" + score.toFixed(0) + " vs " + judge.toFixed(0) + ") but didn't place.");
}

async function cmdAttack(message, args) {
  const id = message.author.id; const pre = notice(resolve(id)); const u = ensure(id);
  const target = h.firstMentionUser(message);
  if (!target) return message.reply(pre + "Tag who to sic your pet on: " + code(PREFIX + "petattack @user"));
  if (target.bot) return message.reply(pre + "Can't attack a bot.");
  if (target.id === id) return message.reply(pre + "Your pet won't attack you.");
  const pet = activePet(u);
  if (!pet) return message.reply(pre + "You need a pet first.");
  if (isPuppy(pet)) return message.reply(pre + pet.name + " is just a baby \u2014 can't attack yet.");
  const since = Date.now() - (u.lastAttack || 0);
  if (since < ATTACK_CD_MS) return message.reply(pre + pet.name + " is resting \u2014 " + fmtDur(ATTACK_CD_MS - since) + " until the next attack.");
  const victim = economy.getUser(target.id);
  if (victim.away) return message.reply(pre + target.username + " is away \u2014 your pet refuses.");
  if (!h.lock(id)) return message.reply("\u23F3 finish your other action first.");
  try {
    u.lastAttack = Date.now(); scheduleSave();
    const chance = Math.max(0.2, Math.min(0.85, 0.3 + ((pet.stats.overall) || 50) / 200));
    if (Math.random() < chance) {
      const vw = economy.getUser(target.id).wallet;
      const steal = Math.floor(vw * (0.1 + Math.random() * 0.2));
      if (steal <= 0) return message.reply(pre + pet.name + " attacked " + target.username + " but their wallet was empty!");
      economy.addWallet(target.id, -steal); pay(id, steal);
      return message.reply(pre + speciesEmoji(pet) + "\uD83D\uDCA5 **" + pet.name + "** mauled " + target.username + " and made off with **" + money(steal) + "**!");
    }
    const ow = economy.getUser(id).wallet; const comp = Math.floor(ow * 0.05);
    if (comp > 0) { economy.addWallet(id, -comp); pay(target.id, comp); }
    return message.reply(pre + target.username + " fought off **" + pet.name + "**!" + (comp > 0 ? " You paid **" + money(comp) + "** in vet bills." : ""));
  } finally { h.unlock(id); }
}

async function cmdFeed(message, args) {
  const id = message.author.id; const pre = notice(resolve(id));
  const r = resolvePet(id, args[0]); if (r.error) return message.reply(pre + r.error);
  r.pet.lastFed = Date.now(); scheduleSave();
  return message.reply(pre + BABY + " Fed **" + r.pet.name + "**. Happy and healthy.");
}

async function cmdWalk(message, args) {
  const id = message.author.id; const pre = notice(resolve(id));
  const r = resolvePet(id, args[0]); if (r.error) return message.reply(pre + r.error);
  r.pet.lastWalked = Date.now(); scheduleSave();
  return message.reply(pre + RUN + " Walked **" + r.pet.name + "**. Good exercise!");
}

async function cmdCareAll(message) {
  const id = message.author.id; const pre = notice(resolve(id));
  const u = ensure(id);
  if (!u.pets.length) return message.reply(pre + "You have no pets to care for yet \u2014 " + code(PREFIX + "pound dog") + ".");
  const now = Date.now();
  for (const p of u.pets) { p.lastFed = now; p.lastWalked = now; }
  scheduleSave();
  const n = u.pets.length;
  return message.reply(pre + BABY + RUN + " Fed **and** walked all **" + n + "** of your pet" + (n === 1 ? "" : "s") + " \u2014 everyone's happy, healthy, and exercised! Their neglect timers are reset for another 48h.");
}

async function cmdPetHelp(message) {
  const lines = [
    "**Get pets**",
    code(PREFIX + "pound dog|cat") + " adopt a random rescue (" + money(POUND_COST) + ") \u00b7 5-min cooldown per animal",
    code(PREFIX + "petstore") + " browse the refreshing shop \u00b7 " + code(PREFIX + "petstore buy <#>"),
    "",
    "**Manage**",
    code(PREFIX + "pets") + " your pets \u00b7 " + code(PREFIX + "pet <#>") + " info card",
    code(PREFIX + "pet select <#>") + " set racer/fighter",
    code(PREFIX + "petname <#> <name>") + " rename (" + money(RENAME_COST) + ") \u00b7 " + code(PREFIX + "petimage <#> <url>"),
    code(PREFIX + "feed <#>") + " \u00b7 " + code(PREFIX + "walk <#>") + " \u00b7 " + code(PREFIX + "care") + " feed + walk ALL pets at once (neglect = they run away!)",
    "",
    "**Breed** (1h\u2192adult, fertile to 72h, females have heats every other 30m)",
    code(PREFIX + "breed <male#> <female#>") + " natural",
    code(PREFIX + "seedshop") + " + " + code(PREFIX + "breed <female#> seed") + " (no male, 1-week window)",
    code(PREFIX + "semen <male#>") + " sell a sample for cash",
    code(PREFIX + "potion") + " + " + code(PREFIX + "breed <pet#> potion") + " self-breed a purebred",
    "",
    "**Breeding Station** (automate breeding \u2014 litters auto-sell every hour)",
    code(PREFIX + "station buy") + " build one (" + money(STATION_COST) + ") \u00b7 " + code(PREFIX + "station") + " view status",
    code(PREFIX + "station male <#>") + " set the stud \u00b7 " + code(PREFIX + "station add <#> [#...]") + " add females (same species, dogs/cats only \u2014 no hybrids)",
    code(PREFIX + "station remove male|<#>|all") + " take pets back out \u00b7 inside they're frozen (no aging/feeding/walking)",
    code(PREFIX + "station collect") + " bank the auto-sold litter earnings",
    code(PREFIX + "station upgrade") + " raise the female limit (10\u219250\u2192100\u2192500\u2192\u221E)",
    "",
    "**Late game**",
    code(PREFIX + "lab buy") + " Gene Lab (" + money(LAB_COST) + ") \u2192 " + code(PREFIX + "lab breed <dog#> <cat#>") + " = dog-cat worth 5\u2013500 quadrillion",
    "",
    "**Earn / fight**",
    code(PREFIX + "petrace") + " animated race \u00b7 " + code(PREFIX + "petshow") + " dog/cat show",
    code(PREFIX + "petattack @user") + " rob with your pet (15m cd)",
    code(PREFIX + "petmarket") + " buy/sell with players \u00b7 " + code(PREFIX + "petsell <#>|all|<rarity>"),
  ];
  // Split on blank lines into sections; send ONE embed per section so we never
  // blow past Discord's 4096-char embed limit (which makes help silently fail).
  const sections = [];
  let cur = null;
  for (const line of lines) {
    if (line === "") { if (cur) sections.push(cur); cur = null; continue; }
    if (!cur) cur = { header: line, body: [] };
    else cur.body.push(line);
  }
  if (cur) sections.push(cur);
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    const m = s.header.match(/\*\*(.+?)\*\*/);
    const title = PAW + " Pets \u2014 " + (m ? m[1] : "Commands");
    const extra = s.header.replace(/\*\*.+?\*\*/, "").replace(/^[\s\u2014\-]+/, "").trim();
    const descLines = [];
    if (extra) descLines.push("*" + extra + "*");
    descLines.push(...s.body);
    const desc = (descLines.join("\n") || "\u200b").slice(0, 4000);
    const e = new EmbedBuilder().setColor(0xe67e22).setTitle(title).setDescription(desc);
    if (i === 0) await message.reply({ embeds: [e], allowedMentions: { repliedUser: false } });
    else await message.channel.send({ embeds: [e] });
  }
}

// Admin: wipe a user's pets by species ("dog" | "cat" | "all"/"pets"). Returns count removed.
function wipePets(id, species) {
  const u = ensure(id);
  const before = u.pets.length;
  if (species === "all" || species === "pets") u.pets = [];
  else u.pets = u.pets.filter((p) => p.species !== species);
  if (u.selected && !u.pets.some((p) => p.iid === u.selected)) u.selected = null;
  scheduleSave();
  return before - u.pets.length;
}

// Summary of a user's animal holdings (for the leaderboard / !top).
function summaryOf(id) {
  const u = ensure(id);
  let dogs = 0, cats = 0, hybrids = 0, value = 0;
  for (const p of u.pets) {
    if (p.species === "dog") dogs++;
    else if (p.species === "cat") cats++;
    else if (p.species === "hybrid") hybrids++;
    value += petValue(p);
  }
  // Breeding-station & lab worth so they count toward net worth / leaderboard.
  const stationOwned = !!(u.station && u.station.owned);
  const stationPets = stationOwned ? ((u.station.male ? 1 : 0) + (u.station.females ? u.station.females.length : 0)) : 0;
  const stationInv = stationInvested(u);        // 1T buy + every upgrade paid
  const stationPetsVal = stationPetsValue(u);   // shelter value of pets inside
  const labInv = u.hasLab ? LAB_COST : 0;       // 1Q sunk into the gene lab
  return {
    dogs, cats, hybrids,
    count: u.pets.length,
    value,
    hasLab: !!u.hasLab,
    labBusy: !!u.labJob,
    stationOwned,
    stationPets,
    stationInvested: stationInv,
    stationPetsValue: stationPetsVal,
    labInvested: labInv,
    // Everything pet-related that should count toward net worth.
    netWorth: value + stationInv + stationPetsVal + labInv,
  };
}

// ── Breeding Station ──────────────────────────────────────────
// Buy a station, drop in ONE male + many females of the SAME species (dogs OR
// cats; lab dog-cat hybrids are NOT allowed and hybrids can't be created here).
// Every in-game hour each female delivers a litter (normal birth mechanics)
// that is auto-sold at shelter value; earnings bank to `pending` and you cash
// out with `!station collect`. Pets inside are frozen — they don't age out,
// run away, or need feeding/walking (they're not in your pet menu while inside).
const STATION = "\uD83C\uDFED";
const STATION_COST = 1e12; // 1 trillion to buy
// tier 0 = base (right after buying). Each later tier is a paid upgrade.
const STATION_TIERS = [
  { limit: 10,       cost: 0 },
  { limit: 50,       cost: 5e12 },
  { limit: 100,      cost: 10e12 },
  { limit: 500,      cost: 20e12 },
  { limit: Infinity, cost: 100e12 },
];

function stationTier(u) { return STATION_TIERS[Math.min(u.station.tier || 0, STATION_TIERS.length - 1)]; }
function stationLimit(u) { return stationTier(u).limit; }
function stationLimitLabel(u) { const l = stationLimit(u); return l === Infinity ? "\u221E" : String(l); }
function stationCanHoldSpecies(u, species) { return !u.station.species || u.station.species === species; }

// Total goy-bucks sunk into the station (1T purchase + every upgrade bought) —
// counts toward net worth, like factory/business investment does.
function stationInvested(u) {
  if (!u.station || !u.station.owned) return 0;
  let v = STATION_COST;
  for (let i = 1; i <= (u.station.tier || 0) && i < STATION_TIERS.length; i++) v += STATION_TIERS[i].cost;
  return v;
}
// Live shelter value of the pets currently locked inside the station.
function stationPetsValue(u) {
  if (!u.station) return 0;
  let v = 0;
  if (u.station.male) v += petValue(u.station.male);
  for (const f of u.station.females || []) v += petValue(f);
  return v;
}

function sampleArray(arr, n) {
  if (arr.length <= n) return arr;
  const copy = arr.slice(); const out = [];
  for (let i = 0; i < n && copy.length; i++) out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  return out;
}

// Value of one litter (auto-sold at shelter value). Mirrors birth() litter
// generation but just sums petValue instead of creating real pets.
function simLitterValue(male, female) {
  const momBreed = pb.getBreed(female.breedKey);
  const sireBreed = pb.getBreed(male.breedKey) || momBreed;
  if (!momBreed) return 0;
  const avgSize = ((female.size || 0) + (male.size || female.size || 0)) / 2;
  let litterN = 1 + Math.round((Math.min(pb.MAX_NATURAL_SIZE, avgSize) / pb.MAX_NATURAL_SIZE) * 3);
  litterN = Math.max(1, Math.min(4, litterN + (Math.random() < 0.5 ? 0 : (Math.random() < 0.5 ? -1 : 1))));
  let total = 0;
  for (let i = 0; i < litterN; i++) {
    const sameBreed = sireBreed && momBreed && sireBreed.key === momBreed.key;
    let breed = momBreed, mixed = false, rarity = momBreed.rarity;
    if (!sameBreed && sireBreed && momBreed) {
      mixed = true;
      breed = Math.random() < 0.5 ? momBreed : sireBreed;
      const ri = Math.min(pb.RARITY_ORDER.indexOf(sireBreed.rarity), pb.RARITY_ORDER.indexOf(momBreed.rarity));
      rarity = pb.RARITY_ORDER[Math.max(0, ri)];
    }
    const purebred = !!(sameBreed && momBreed.purebred && sireBreed && sireBreed.purebred);
    let size = Math.max(0, Math.min(pb.MAX_NATURAL_SIZE, avgSize + (Math.random() * 4 - 2)));
    size = Math.round(size * 10) / 10;
    const stats = pb.rollStats(rarity, size);
    total += petValue({ species: female.species, breedKey: breed ? breed.key : female.breedKey, mixed, rarity, size, stats, weight: pb.weightForSize(breed, size), purebred });
  }
  return total;
}

// Lazy accrual: bank one hour's worth of auto-sold litters per elapsed hour.
function accrueStation(u) {
  const st = u.station;
  if (!st || !st.owned) return 0;
  const now = Date.now();
  if (!st.lastCycle) st.lastCycle = now;
  if (!st.male || !st.females.length) { st.lastCycle = now; return 0; }
  const cycles = Math.floor((now - st.lastCycle) / HOUR);
  if (cycles <= 0) return 0;
  // Bound the work for huge herds / long offline gaps by sampling, then scale.
  const sampleCycles = Math.min(cycles, 12);
  const femList = st.females.length > 150 ? sampleArray(st.females, 150) : st.females;
  let sampled = 0;
  for (let c = 0; c < sampleCycles; c++) for (const f of femList) sampled += simLitterValue(st.male, f);
  const femScale = st.females.length / femList.length;
  const earned = Math.round((sampled / sampleCycles) * femScale * cycles);
  st.pending = (st.pending || 0) + earned;
  st.cyclesRun = (st.cyclesRun || 0) + cycles;
  st.lastCycle = st.lastCycle + cycles * HOUR; // carry the sub-hour remainder
  scheduleSave();
  return earned;
}

async function cmdStation(message, args) {
  const id = message.author.id;
  const pre = notice(resolve(id));
  const u = ensure(id);
  accrueStation(u);
  const st = u.station;
  const sub = (args[0] || "").toLowerCase();

  // ── BUY ──
  if (sub === "buy") {
    if (st.owned) return message.reply(pre + "You already own a breeding station. See " + code(PREFIX + "station") + ".");
    if (!spend(id, STATION_COST)) return message.reply(pre + "A breeding station costs " + money(STATION_COST) + " \u2014 you can't afford it.");
    st.owned = true; st.tier = 0; st.lastCycle = Date.now(); scheduleSave();
    return message.reply(pre + STATION + " You built a **Breeding Station**! Drop in a male with " + code(PREFIX + "station male <#>") + ", then fill it with females via " + code(PREFIX + "station add <#> [#...]") + ". Female limit: **" + stationLimitLabel(u) + "**.");
  }

  if (!st.owned) return message.reply(pre + STATION + " You don't own a breeding station yet. Buy one for **" + money(STATION_COST) + "** with " + code(PREFIX + "station buy") + ".");

  // ── UPGRADE ──
  if (sub === "upgrade" || sub === "up") {
    const nextTier = (st.tier || 0) + 1;
    if (nextTier >= STATION_TIERS.length) return message.reply(pre + "Your station is already at the **final** tier (female limit " + stationLimitLabel(u) + ").");
    const cost = STATION_TIERS[nextTier].cost;
    if (!spend(id, cost)) return message.reply(pre + "Upgrade #" + nextTier + " costs " + money(cost) + " \u2014 you can't afford it.");
    st.tier = nextTier; scheduleSave();
    const isFinal = nextTier === STATION_TIERS.length - 1;
    let msg = "\u2B06\uFE0F Upgraded your station! Female limit is now **" + stationLimitLabel(u) + "**.";
    if (isFinal) msg += " (max tier)";
    else { const nn = STATION_TIERS[nextTier + 1]; msg += " Next upgrade: " + money(nn.cost) + " \u2192 limit " + (nn.limit === Infinity ? "\u221E" : nn.limit) + "."; }
    return message.reply(pre + msg);
  }

  // ── COLLECT ──
  if (sub === "collect" || sub === "claim") {
    if ((st.pending || 0) <= 0) return message.reply(pre + STATION + " Nothing to collect yet. " + (st.male && st.females.length ? "Litters auto-sell every hour \u2014 check back later." : "Add a male + females to start breeding."));
    const amt = Math.floor(st.pending); st.pending = 0;
    const nw = pay(id, amt); scheduleSave();
    return message.reply(pre + STATION + " Collected **" + money(amt) + "** from auto-sold litters! (wallet: " + money(nw) + ")");
  }

  // ── ADD MALE ──
  if (sub === "male" || sub === "addmale" || sub === "sire" || sub === "stud") {
    const r = resolvePet(id, args[1]); if (r.error) return message.reply(pre + r.error);
    const pet = r.pet;
    if (pet.species === "hybrid") return message.reply(pre + "Lab dog-cat hybrids can't go in the breeding station \u2014 dogs and cats only.");
    if (pet.sex !== "male") return message.reply(pre + "**" + pet.name + "** isn't male. Use " + code(PREFIX + "station add <#>") + " for females.");
    if (isPuppy(pet)) return message.reply(pre + "**" + pet.name + "** is still a baby \u2014 only fertile adults can go in.");
    if (st.male) return message.reply(pre + "There's already a male in the station (**" + st.male.name + "**). Remove it first with " + code(PREFIX + "station remove male") + ".");
    if (!stationCanHoldSpecies(u, pet.species)) return message.reply(pre + "Your station is set up for **" + st.species + "s** right now \u2014 only one species at a time. Empty it before switching.");
    u.pets = u.pets.filter((p) => p.iid !== pet.iid);
    if (u.selected === pet.iid) u.selected = null;
    st.male = pet; st.species = pet.species;
    if (!st.lastCycle) st.lastCycle = Date.now();
    scheduleSave();
    return message.reply(pre + STATION + " **" + pet.name + "** " + sexSym(pet) + " is now the stud (" + breedName(pet) + "). Add females with " + code(PREFIX + "station add <#> [#...]") + ".");
  }

  // ── ADD FEMALES (bulk) ──
  if (sub === "add" || sub === "addfemale" || sub === "female" || sub === "fill") {
    if (!st.male) return message.reply(pre + "Add a male first: " + code(PREFIX + "station male <#>") + ".");
    const idxTokens = args.slice(1).filter((t) => /^\d+$/.test(t));
    if (!idxTokens.length) return message.reply(pre + "Usage: " + code(PREFIX + "station add <#> [#...]") + " \u2014 add one or more females by their " + code(PREFIX + "pets") + " number.");
    const seen = new Set(); const targets = []; const problems = [];
    for (const t of idxTokens) {
      const n = parseInt(t, 10);
      if (seen.has(n)) continue; seen.add(n);
      if (n < 1 || n > u.pets.length) { problems.push("#" + n + " (no such pet)"); continue; }
      targets.push(u.pets[n - 1]);
    }
    const limit = stationLimit(u); const added = [];
    for (const pet of targets) {
      if (st.females.length + added.length >= limit) { problems.push(pet.name + " (limit " + stationLimitLabel(u) + " reached)"); continue; }
      if (pet.species === "hybrid") { problems.push(pet.name + " (no hybrids)"); continue; }
      if (pet.species !== st.species) { problems.push(pet.name + " (not a " + st.species + ")"); continue; }
      if (pet.sex !== "female") { problems.push(pet.name + " (not female)"); continue; }
      if (isPuppy(pet)) { problems.push(pet.name + " (still a baby)"); continue; }
      if (!femaleFertile(pet, false)) { problems.push(pet.name + " (past her fertile window)"); continue; }
      added.push(pet);
    }
    if (added.length) {
      const addedIids = new Set(added.map((p) => p.iid));
      u.pets = u.pets.filter((p) => !addedIids.has(p.iid));
      if (u.selected && addedIids.has(u.selected)) u.selected = null;
      for (const p of added) st.females.push(p);
      if (!st.lastCycle) st.lastCycle = Date.now();
      scheduleSave();
    }
    let msg = added.length ? (STATION + " Added **" + added.length + "** female" + (added.length === 1 ? "" : "s") + " to the station (" + st.females.length + "/" + stationLimitLabel(u) + " " + st.species + "s).") : "No females added.";
    if (problems.length) msg += "\n\u26A0\uFE0F Skipped: " + problems.join(", ");
    return message.reply(pre + msg);
  }

  // ── REMOVE / WITHDRAW ──
  if (sub === "remove" || sub === "take" || sub === "out" || sub === "withdraw") {
    const what = (args[1] || "").toLowerCase();
    if (!what) return message.reply(pre + "Usage: " + code(PREFIX + "station remove male") + ", " + code(PREFIX + "station remove <#> [#...]") + " (female slot numbers), or " + code(PREFIX + "station remove all") + ".");
    if (what === "male" || what === "sire" || what === "stud") {
      if (!st.male) return message.reply(pre + "There's no male in the station.");
      if (capLeft(u) <= 0) return message.reply(pre + "Your pet inventory is full (" + MAX_PETS + ") \u2014 make room first.");
      const m = st.male; st.male = null;
      m.lastFed = Date.now(); m.lastWalked = Date.now();
      u.pets.push(m);
      if (!st.females.length) st.species = null;
      scheduleSave();
      return message.reply(pre + STATION + " Took **" + m.name + "** out of the station and back to your pets.");
    }
    if (what === "all") {
      const queue = []; if (st.male) queue.push(st.male); for (const f of st.females) queue.push(f);
      const toMove = []; for (const p of queue) { if (capLeft(u) - toMove.length > 0) toMove.push(p); }
      const moveSet = new Set(toMove.map((p) => p.iid));
      for (const p of toMove) { p.lastFed = Date.now(); p.lastWalked = Date.now(); u.pets.push(p); }
      if (st.male && moveSet.has(st.male.iid)) st.male = null;
      st.females = st.females.filter((f) => !moveSet.has(f.iid));
      if (!st.male && !st.females.length) st.species = null;
      scheduleSave();
      let msg = STATION + " Withdrew **" + toMove.length + "** pet" + (toMove.length === 1 ? "" : "s") + " from the station.";
      const remaining = (st.male ? 1 : 0) + st.females.length;
      if (remaining) msg += " (" + remaining + " left \u2014 inventory full at " + MAX_PETS + ")";
      return message.reply(pre + msg);
    }
    const idxTokens = args.slice(1).filter((t) => /^\d+$/.test(t));
    if (!idxTokens.length) return message.reply(pre + "Pick female slot numbers (see " + code(PREFIX + "station") + ").");
    const seen = new Set(); const targets = []; const problems = [];
    for (const t of idxTokens) {
      const n = parseInt(t, 10);
      if (seen.has(n)) continue; seen.add(n);
      if (n < 1 || n > st.females.length) { problems.push("#" + n + " (no such slot)"); continue; }
      targets.push(st.females[n - 1]);
    }
    const moved = [];
    for (const f of targets) { if (capLeft(u) - moved.length <= 0) { problems.push(f.name + " (inventory full)"); continue; } moved.push(f); }
    if (moved.length) {
      const movedIids = new Set(moved.map((p) => p.iid));
      st.females = st.females.filter((f) => !movedIids.has(f.iid));
      for (const f of moved) { f.lastFed = Date.now(); f.lastWalked = Date.now(); u.pets.push(f); }
      if (!st.male && !st.females.length) st.species = null;
      scheduleSave();
    }
    let msg = moved.length ? (STATION + " Took **" + moved.length + "** female" + (moved.length === 1 ? "" : "s") + " back to your pets.") : "No females withdrawn.";
    if (problems.length) msg += "\n\u26A0\uFE0F Skipped: " + problems.join(", ");
    return message.reply(pre + msg);
  }

  // ── STATUS (default) ──
  const e = new EmbedBuilder().setColor(0x9b59b6).setTitle(STATION + " " + message.author.username + "'s Breeding Station");
  const lines = [];
  lines.push("**Tier " + (st.tier || 0) + "** \u00b7 female limit **" + stationLimitLabel(u) + "**");
  if (st.male) lines.push("**Stud:** " + speciesEmoji(st.male) + " " + st.male.name + " " + sexSym(st.male) + " \u00b7 " + breedName(st.male));
  else lines.push("**Stud:** _none_ \u2014 add one with " + code(PREFIX + "station male <#>"));
  lines.push("**Females:** " + st.females.length + (st.species ? " " + st.species + "s" : "") + " / " + stationLimitLabel(u));
  if (st.females.length) {
    const show = st.females.slice(0, 15).map((f, i) => (i + 1) + ". " + f.name + " " + sexSym(f) + " \u00b7 " + breedName(f) + " \u00b7 sz " + f.size);
    lines.push(show.join("\n") + (st.females.length > 15 ? "\n\u2026 +" + (st.females.length - 15) + " more" : ""));
  }
  lines.push("");
  if (st.male && st.females.length) lines.push("\uD83C\uDF7C Producing litters every hour, auto-sold at shelter value.");
  else lines.push("\uD83D\uDCA4 Idle \u2014 needs **1 male + at least 1 female** to breed.");
  lines.push("**Uncollected earnings:** " + money(Math.floor(st.pending || 0)) + " \u2014 " + code(PREFIX + "station collect"));
  if ((st.tier || 0) + 1 < STATION_TIERS.length) {
    const nt = STATION_TIERS[(st.tier || 0) + 1];
    lines.push("**Next upgrade:** " + money(nt.cost) + " \u2192 limit " + (nt.limit === Infinity ? "\u221E" : nt.limit) + " (" + code(PREFIX + "station upgrade") + ")");
  } else lines.push("_Max tier reached._");
  e.setDescription(lines.join("\n").slice(0, 4000));
  e.setFooter({ text: PREFIX + "station male/add/remove/collect/upgrade \u00b7 " + PREFIX + "pethelp" });
  const payload = { embeds: [e] };
  if (pre) payload.content = pre;
  return message.reply(payload);
}

module.exports = {
  cmdPets, cmdPet, cmdRename, cmdImage, cmdPound, cmdPetStore, cmdBreed,
  cmdSemen, cmdSeedShop, cmdPotion, cmdLab, cmdMarket, cmdPetSell,
  cmdPetRace, cmdPetShow, cmdAttack, cmdFeed, cmdWalk, cmdCareAll, cmdPetHelp,
  cmdStation,
  wipePets, summaryOf,
  resolve, ensure, __state: () => state,
};
