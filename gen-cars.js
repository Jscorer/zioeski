// Deterministic car catalog generator. Produces cars.json (frozen data) so
// every car's stats are PERMANENT and never change between bot restarts.
// Run once with: node gen-cars.js  (re-run only if you change the pools).
//
// Names are funny mimics of real cars, ordered junky -> godly within each type.
// Stats (horsepower/handling/reliability, 0-100) and price scale by type+rarity.

const fs = require("fs");
const path = require("path");

// ---- deterministic RNG (so output is identical every run) ----
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seeded(seed) { return mulberry32(hashStr(seed)); }

const TYPE_ORDER = ["shitbox", "beater", "street", "sports", "super", "hyper", "hovercar"];
const RARITY_ORDER = ["common", "uncommon", "rare", "legendary", "mythical"];

// overall stat band per rarity (min,max). Higher rarity = faster cars.
const BAND = {
  common: [28, 44],
  uncommon: [44, 57],
  rare: [57, 69],
  legendary: [70, 84],
  mythical: [85, 99],
};

// price range per type [min,max] in goybucks (geometric scaling within).
const PRICE = {
  shitbox: [1e3, 1e4],
  beater: [1e4, 1e5],
  street: [1e5, 1e6],
  sports: [1e6, 1e7],
  super: [1e7, 1e8],
  hyper: [1e8, 1e9],
  hovercar: [1e9, 1e10],
};

// Ordered name pools per type+rarity (junky -> godly).
const POOLS = {
  shitbox: {
    common: ["Reliant Throbbin", "Daewho Taco", "Lata Reeva", "Hugo GV", "Geo Metrosexual", "Fiata Panda", "Peroduh Pencil", "Hyundo Atos", "Citroan 2Cheap", "Skoduh Favorit", "Maruti Ate-Hundred", "Trabbant P50"],
    uncommon: ["Nissan Mowcra", "Forz Kaa", "Toyoda Aygho", "Proton Wirey", "Suzuki Altoid", "Vaux-hall Corsabish", "Chevvy Sprintt", "Reno Twango", "Seata Marbella", "Dacio Sandero"],
    rare: ["Smart ForTwoo", "Mini Moke-ish", "Fiata Cinquecento", "Polski Fiate 126p", "Tata Nanobot", "Subaroo Justy", "Mitsubitchy Mirage-ish", "Honda Todayish"],
    legendary: ["Honda Beatbox", "Suzuki Cappuccinoo", "Autozam AZ-Wun", "Toyoda Sera-ish", "Fiata Bambino GT", "Mini Coopa S Classic"],
    mythical: ["Reliant Throbbin GTI", "Goyota Shitbox Type-R", "Trabant Turdo S", "Lada Riva Hyper-Beater"],
  },
  beater: {
    common: ["Toyoda Carolla", "Hondda Civac", "Nissan Sentrah", "Forz Focaccia", "Chevvy Cavaweir", "Pontihack Sunfire", "Saturn S-Elle", "Dodgy Neon", "Hyundo Excell", "Kia Sephlibrary", "Mazduh Protege-ish", "Mitsubitchy Lancir"],
    uncommon: ["Honda Accordion", "Toyoda Camrui", "Nissan Altimuh", "Forz Mondaybeo", "VW Jettlag", "Subaroo Imprezza", "Volvno 240", "Opal Astrabish", "Reno Megane-ish", "Peugeo 306ish"],
    rare: ["BMdub 3-Seriesish", "Mercedez C-Classish", "Audo A4-ish", "Lexis IS200ish", "Saab 9-Through", "Alpha Romeio 156", "Honda Prelewd", "Acuruh Integruh"],
    legendary: ["Nissan Skylimit R33", "Toyoda Supratrooper Mk3", "Mazduh RX-Late", "Subaroo WRecks", "Mitsubitchy Evo IV-ish", "Honda Civac Type-Argh"],
    mythical: ["Nissan Skylimit GT-Argh R34", "Toyoda Supratrooper Mk4-ish", "Mazduh RX-Late FD3S", "BMdub M3 E36ish"],
  },
  street: {
    common: ["Volkswughen Golf GTit", "Forz Fiestas ST", "Honda Civac Si", "Mini Coopa S-ish", "Reno Clio RSish", "Peugeo 208 GTit", "Seata Leon Cupruh", "Mazduh 3 MPS-ish", "Hyundo i30 N-ish", "Suzuki Swiftish Sport", "Fiata 500 Abarthish", "Opal Corsa VXARGH"],
    uncommon: ["Subaroo WRecks STI", "Mitsubitchy Evo IX-ish", "Forz Focaccia RS", "Audo S3-ish", "BMdub M135ish", "Mercedez A45 AMGish", "VW Golf Rrr", "Honda Civac Type-Argh FK8", "Toyoda GR Yarisish", "Nissan 350Zee"],
    rare: ["Nissan 370Zee Nismo", "Toyoda GT-Aighty-Six", "Subaroo BRZ-ish", "BMdub M2-ish", "Audo RS3-ish", "Mercedez CLA45ish", "Forz Mustanggish GT", "Chevvy Camarno SS"],
    legendary: ["Nissan Skylimit GT-Argh R35", "Toyoda Supratrooper A90", "BMdub M4 Compish", "Audo RS5-ish", "Mercedez C63 AMGish", "Dodgy Challengerish Hellargh"],
    mythical: ["Nissan GT-Argh R35 Nismoish", "Dodgy Demonish 170", "Chevvy Camarno ZL-Wun", "BMdub M4 GTSish"],
  },
  sports: {
    common: ["Porsha Boxterish", "Audo TT-ish", "BMdub Z4-ish", "Mercedez SLCish", "Jaguh F-Typish", "Chevvy Corvettish C5", "Nissan 370Zee Touring", "Lotsus Elise-ish", "Alpine A110ish", "Toyoda Supratrooper Base", "Forz Mustanggish GT500", "Mazduh RX-ATE"],
    uncommon: ["Porsha Caymanish GTS", "Chevvy Corvettish C7", "Jaguh F-Typish R", "Mercedez AMG GTish", "BMdub M8-ish", "Audo R8-ish V8", "Nissan GT-Argh Base", "Lotsus Evora-ish", "Aston Martian Vantageish", "Maseroti GranTurismoish"],
    rare: ["Porsha 911 Turdo", "Audo R8-ish V10", "Chevvy Corvettish Z06", "Mercedez AMG GT-Rish", "Aston Martian DB11ish", "Jaguh XKR-ish", "Lexis LFA-ish lite", "Nissan GT-Argh Nismo"],
    legendary: ["Porsha 911 GT3-ish RS", "Lamborgreeny Huracanish", "Ferrori 488-ish", "McLoren 570S-ish", "Audo R8-ish V10 Plusish", "Aston Martian Vantage AMRish"],
    mythical: ["Ferrori 488 Pistuhish", "Lamborgreeny Huracan STOish", "McLoren 600LT-ish", "Porsha 911 GT2-ish RS"],
  },
  super: {
    common: ["Lamborgreeny Gallarghdoh", "Ferrori F430ish", "McLoren 12C-ish", "Audo R8-ish LMX", "Maseroti MC12ish lite", "Forz GT-ish 05", "Lexis LFA-ish", "Aston Martian Vanquishish", "Mercedez SLR-ish", "Porsha Carrera GT-ish lite", "Honda NSX-ish New", "Nissan GT-Argh50ish"],
    uncommon: ["Lamborgreeny Aventadong", "Ferrori 458ish", "McLoren 650S-ish", "Audo R8-ish GT", "Aston Martian DBSish", "Maseroti MC20ish", "Lexis LFA Nurbish", "Mercedez AMG GT Black-ish", "Forz GT-ish 17", "Porsha 918ish lite"],
    rare: ["Lamborgreeny Aventadong SVJ", "Ferrori 812ish", "McLoren 720S-ish", "Porsha 918 Spyderish", "Ferrori F12tdfish", "Lamborgreeny Centenarioish lite", "McLoren 765LT-ish", "Aston Martian Oneish-77"],
    legendary: ["Ferrori LaFerroriish", "McLoren P1-ish", "Porsha 918 Spyder Weissish", "Lamborgreeny Veneno-ish", "Koenigsegg Agera-ish", "Pogani Huayrah"],
    mythical: ["Ferrori LaFerrori Apertaish", "McLoren P1 GTRish", "Lamborgreeny Venenoish Roadster", "Pogani Huayrah BCish"],
  },
  hyper: {
    common: ["Bugutti Veyronish", "Koenigsegg CCXish", "Pogani Zonduh", "McLoren P1-lite", "Ferrori Enzoish", "Lamborgreeny Reventonish", "SSC Ultimate Aerobish", "Saleen S7ish", "Aston Martian Valkyrish lite", "Noble M600ish", "Zenvo ST1ish", "Gumpert Apolloish"],
    uncommon: ["Bugutti Veyron SuperSportish", "Koenigsegg Ageruh RS lite", "Pogani Huayrah Roadster", "Rimick Conceptish One", "Lotus Evijuh lite", "Ferrori SF90ish", "McLoren Speedtailish", "Lamborgreeny Sianish", "Aston Martian Valkyrish", "Mercedez-AMG Wun lite"],
    rare: ["Bugutti Chiranish", "Koenigsegg Jezkoish", "Pogani Huayrah BC Roadsterish", "Rimick Neveruh", "Lotus Evijuh", "Mercedez-AMG Wun", "McLoren Speedtail Highish", "Aston Martian Valkyrish AMR"],
    legendary: ["Bugutti Chiranish SuperSport 300", "Koenigsegg Jezko Absolutish", "Rimick Neveruh Timeattackish", "Pogani Huayrah Imolah", "Bugutti Divoish", "Koenigsegg Geminuhra"],
    mythical: ["Bugutti La Voiture Noirish", "Bugutti Bolidish", "Koenigsegg Jezko Absolut Maxish", "Pogani Codalungish"],
  },
  hovercar: {
    common: ["Spaze Glider-X1", "Aereon Flyer-Lite", "Gravcorp Hoverwagon", "Skyline Commuter", "FloatCo Econoskim", "HoverTech Breezebox", "Antigrav Shuttlish", "LevitaCorp Drifter", "Quantuum Skimmer-Lite", "StarFleet Cruisuh", "VoidRide Scoutish", "Astro Glide-Cheap"],
    uncommon: ["Spaze Runner X3", "Gravcorp Interceptish", "HoverTech Streakish", "Aereon Speedskim", "FloatCo Turdo", "Quantuum Swiftish", "VoidRide Blazerish", "LevitaCorp Racer-Lite", "Skyline Rapid", "Nebulo Dashish"],
    rare: ["Spaze Phantom X7", "Quantuum Prismuh", "HoverTech Vortex-R", "Gravcorp Strikewing", "VoidRide Pulsar", "Aereon Hyperwing", "LevitaCorp Apex-Lite", "Nebulo Spectrix"],
    legendary: ["Spaze Sovereignish", "Quantuum Singularitish", "VoidRide Eclipz", "Gravcorp Zenithron", "HoverTech Omegalift", "Aereon Celestialis"],
    mythical: ["Spaze Infinity-Wun", "Quantuum Eternalis", "VoidRide Obsidianis", "Gravcorp Ultimatus Maxish"],
  },
};

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function roundSig(n, sig) {
  if (n <= 0) return 0;
  const mag = Math.floor(Math.log10(n));
  const f = Math.pow(10, mag - (sig - 1));
  return Math.round(n / f) * f;
}

function slug(type, name) {
  return (type + "_" + name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

const cars = [];
const seenIds = new Set();

for (const type of TYPE_ORDER) {
  const [pmin, pmax] = PRICE[type];
  for (let ri = 0; ri < RARITY_ORDER.length; ri++) {
    const rarity = RARITY_ORDER[ri];
    const names = POOLS[type][rarity];
    const n = names.length;
    const [blo, bhi] = BAND[rarity];
    for (let i = 0; i < n; i++) {
      const name = names[i];
      const frac = n > 1 ? i / (n - 1) : 0.5; // position within bucket (0=worst)
      const rng = seeded(type + ":" + name);
      const target = blo + (bhi - blo) * frac;
      // three stats jittered around target, deterministic per (car,stat)
      const jit = (k) => Math.round((seeded(type + ":" + name + ":" + k)() * 2 - 1) * 9);
      const hp = clamp(Math.round(target + jit("hp") + 1), 1, 100);
      const handling = clamp(Math.round(target + jit("hd")), 1, 100);
      const reliability = clamp(Math.round(target + jit("rl") - 1), 1, 100);
      const overall = Math.round((hp + handling + reliability) / 3);
      // price: geometric across the type's range by global premium
      const premium = (ri + frac) / RARITY_ORDER.length;
      let price = pmin * Math.pow(pmax / pmin, premium);
      price = roundSig(price, 3);
      price = clamp(price, pmin, pmax);
      // within-tier pull weight: better cars (higher frac) are rarer
      const weight = +(1 - 0.8 * frac).toFixed(3);
      let id = slug(type, name);
      while (seenIds.has(id)) id = id + "_x";
      seenIds.add(id);
      cars.push({ id, name, type, rarity, hp, handling, reliability, overall, price, weight });
    }
  }
}

fs.writeFileSync(path.join(__dirname, "cars.json"), JSON.stringify(cars, null, 1));
console.log("generated", cars.length, "cars");
// quick per-type/rarity summary
for (const type of TYPE_ORDER) {
  const t = cars.filter((c) => c.type === type);
  const byR = RARITY_ORDER.map((r) => `${r[0]}:${t.filter((c) => c.rarity === r).length}`).join(" ");
  const ov = RARITY_ORDER.map((r) => { const a = t.filter((c) => c.rarity === r); return a.length ? Math.round(a.reduce((s, c) => s + c.overall, 0) / a.length) : 0; });
  console.log(type.padEnd(8), "n=" + t.length, byR, "avgOverall[c/u/r/l/m]=" + ov.join("/"), "price", t[0].price, "->", t[t.length - 1].price);
}
