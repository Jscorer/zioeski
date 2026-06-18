// Shared catalogues for businesses + houses. No dependencies so both
// economy.js (for passive income rates) and business.js (for commands) can
// require it without circular imports.

const BUSINESSES = {
  goyslop: {
    key: "goyslop",
    name: "Goyslop Restaurant",
    price: 100000,
    rate: 10,
    aliases: ["goyslop", "restaurant", "goy", "slop", "resto", "food"],
  },
  jewishbank: {
    key: "jewishbank",
    name: "Jewish Bank",
    price: 1000000,
    rate: 107,
    aliases: ["jewishbank", "jbank", "jewish", "jew", "jewbank"],
  },
  israelitech: {
    key: "israelitech",
    name: "Israeli Tech Companies",
    price: 5000000,
    rate: 567,
    aliases: ["israelitech", "israeli", "israelitechcompanies", "techcompanies", "tech", "israel"],
  },
  saudioil: {
    key: "saudioil",
    name: "Saudi Oil Investment",
    price: 10000000,
    rate: 1167,
    aliases: ["saudioil", "saudi", "saudioilinvestment", "oilinvestment", "oil"],
  },
  kissthewall: {
    key: "kissthewall",
    name: "Kiss The Wall",
    price: 100000000,
    rate: 12000,
    aliases: ["kissthewall", "kiss", "wall", "kisswall", "wailingwall"],
  },
  tripisland: {
    key: "tripisland",
    name: "Trip to the Island",
    price: 1000000000, // 1 billion
    rate: 130000, // 130k/sec
    aliases: ["tripisland", "trip", "triptotheisland", "islandtrip", "epstein"],
  },
  smallafrica: {
    key: "smallafrica",
    name: "Small Country in Africa",
    price: 50000000000, // 50 billion
    rate: 6000000, // 6 million/sec
    aliases: ["smallafrica", "smallcountry", "smallcountryinafrica", "country", "africasmall"],
  },
  ownafrica: {
    key: "ownafrica",
    name: "Own Africa",
    price: 1000000000000, // 1 trillion
    rate: 130000000, // 130 million/sec
    aliases: ["ownafrica", "africa", "allofafrica"],
  },
  owneurope: {
    key: "owneurope",
    name: "Own Europe",
    price: 50000000000000, // 50 trillion
    rate: 6500000000, // 6.5 billion/sec
    aliases: ["owneurope", "europe", "allofeurope", "eu"],
  },
  ownisrael: {
    key: "ownisrael",
    name: "Own Israel",
    price: 1000000000000000, // 1 quadrillion
    rate: 130000000000, // 130 billion/sec
    aliases: ["ownisrael", "allofisrael", "theholyland", "holyland", "zion"],
  },
};

const HOUSES = {
  rv: { key: "rv", name: "RV", price: 10000, aliases: ["rv", "caravan", "van"] },
  shack: { key: "shack", name: "Shack", price: 30000, aliases: ["shack", "hut"] },
  apartment: { key: "apartment", name: "Apartment", price: 70000, aliases: ["apartment", "apt", "flat"] },
  house: { key: "house", name: "House", price: 150000, aliases: ["house", "home"] },
  mansion: { key: "mansion", name: "Mansion", price: 1000000, aliases: ["mansion", "manor"] },
  island: { key: "island", name: "Private Island", price: 10000000, unique: true, noSell: true, aliases: ["island", "privateisland", "private", "isle"] },
};

function normalize(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Resolve a catalogue entry from raw command args (array). Mention tokens
// like "<@123>" are ignored so `give <business> @user` still resolves.
function resolve(table, args) {
  const tokens = (Array.isArray(args) ? args : [args])
    .filter((a) => a && !String(a).startsWith("<@") && !String(a).startsWith("<#"));
  const norm = normalize(tokens.join(" "));
  if (!norm) return null;
  // 1) exact alias / name match
  for (const def of Object.values(table)) {
    if (normalize(def.name) === norm) return def;
    if (def.aliases.some((a) => normalize(a) === norm)) return def;
  }
  // 2) partial / contains match (handles "indian taxi", "jewish", etc.)
  for (const def of Object.values(table)) {
    const nameNorm = normalize(def.name);
    if (norm.length >= 3 && (nameNorm.includes(norm) || norm.includes(nameNorm))) return def;
    if (def.aliases.some((a) => norm.length >= 3 && normalize(a).includes(norm))) return def;
  }
  return null;
}

function findBusiness(args) {
  return resolve(BUSINESSES, args);
}
function findHouse(args) {
  return resolve(HOUSES, args);
}

module.exports = { BUSINESSES, HOUSES, findBusiness, findHouse, normalize };
