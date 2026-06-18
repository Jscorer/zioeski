// Deterministic breed catalog generator for the pets (dog + cat breeding)
// minigame. Produces breeds.json (frozen breed defs) so the set of breeds is
// stable between restarts. Per-pet stats/values are rolled live in
// petbreeds.js; a breed def here only carries species/name/rarity/size-group/
// weight-range. All names are REAL breeds.
//
// Run once with:  node gen-pets.js

const fs = require("fs");
const path = require("path");

// ---- deterministic RNG (identical output every run) ----
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

const RARITY_ORDER = ["common", "uncommon", "rare", "legendary", "mythical"];

// Weight range (lbs) per size group, per species.
const SIZE_WEIGHTS = {
  dog: { toy: [2, 12], small: [12, 25], medium: [25, 55], large: [55, 90], giant: [90, 200] },
  cat: { toy: [4, 7], small: [7, 10], medium: [10, 14], large: [14, 20], giant: [20, 30] },
};

// Bigger groups skew rarer (a purebred giant is a jackpot; a small mutt is common).
const GROUP_RARITY_WEIGHTS = {
  toy: { common: 50, uncommon: 30, rare: 15, legendary: 4, mythical: 1 },
  small: { common: 45, uncommon: 30, rare: 18, legendary: 5, mythical: 2 },
  medium: { common: 30, uncommon: 30, rare: 28, legendary: 8, mythical: 4 },
  large: { common: 18, uncommon: 27, rare: 35, legendary: 13, mythical: 7 },
  giant: { common: 10, uncommon: 22, rare: 38, legendary: 20, mythical: 10 },
};

// ---- REAL dog breeds [name, sizeGroup] (100) ----
const DOGS = [
  ["Chihuahua", "toy"], ["Pomeranian", "toy"], ["Yorkshire Terrier", "toy"], ["Toy Poodle", "toy"],
  ["Maltese", "toy"], ["Papillon", "toy"], ["Miniature Pinscher", "toy"], ["Shih Tzu", "toy"],
  ["Pekingese", "toy"], ["Bichon Frise", "toy"], ["Italian Greyhound", "toy"], ["Brussels Griffon", "toy"],
  ["Japanese Chin", "toy"], ["Affenpinscher", "toy"], ["Lowchen", "toy"], ["Havanese", "toy"],
  ["Toy Fox Terrier", "toy"], ["Russian Toy", "toy"], ["Chinese Crested", "toy"], ["Pug", "toy"],
  ["Beagle", "small"], ["Dachshund", "small"], ["Boston Terrier", "small"], ["French Bulldog", "small"],
  ["Cocker Spaniel", "small"], ["Miniature Schnauzer", "small"], ["Jack Russell Terrier", "small"],
  ["Cairn Terrier", "small"], ["West Highland White Terrier", "small"], ["Scottish Terrier", "small"],
  ["Shetland Sheepdog", "small"], ["Pembroke Welsh Corgi", "small"], ["Cardigan Welsh Corgi", "small"],
  ["Lhasa Apso", "small"], ["Tibetan Spaniel", "small"], ["Norfolk Terrier", "small"], ["Rat Terrier", "small"],
  ["Wire Fox Terrier", "small"], ["Cavalier King Charles Spaniel", "small"], ["Coton de Tulear", "small"],
  ["Border Collie", "medium"], ["Bulldog", "medium"], ["Australian Shepherd", "medium"], ["Brittany", "medium"],
  ["English Springer Spaniel", "medium"], ["Staffordshire Bull Terrier", "medium"], ["American Pit Bull Terrier", "medium"],
  ["Shar Pei", "medium"], ["Chow Chow", "medium"], ["Basset Hound", "medium"], ["Bull Terrier", "medium"],
  ["Soft Coated Wheaten Terrier", "medium"], ["Vizsla", "medium"], ["Portuguese Water Dog", "medium"],
  ["Standard Schnauzer", "medium"], ["Keeshond", "medium"], ["Finnish Spitz", "medium"], ["Whippet", "medium"],
  ["Australian Cattle Dog", "medium"], ["American Staffordshire Terrier", "medium"],
  ["Labrador Retriever", "large"], ["Golden Retriever", "large"], ["German Shepherd", "large"],
  ["Doberman Pinscher", "large"], ["Boxer", "large"], ["Weimaraner", "large"], ["Rhodesian Ridgeback", "large"],
  ["Belgian Malinois", "large"], ["Old English Sheepdog", "large"], ["Dalmatian", "large"],
  ["German Shorthaired Pointer", "large"], ["Gordon Setter", "large"], ["Irish Setter", "large"],
  ["Bloodhound", "large"], ["Greyhound", "large"], ["Saluki", "large"], ["Borzoi", "large"],
  ["Afghan Hound", "large"], ["Collie", "large"], ["Siberian Husky", "large"],
  ["Great Dane", "giant"], ["Saint Bernard", "giant"], ["Mastiff", "giant"], ["Newfoundland", "giant"],
  ["Irish Wolfhound", "giant"], ["Great Pyrenees", "giant"], ["Leonberger", "giant"], ["Tibetan Mastiff", "giant"],
  ["Cane Corso", "giant"], ["Dogue de Bordeaux", "giant"], ["Anatolian Shepherd", "giant"], ["Kangal", "giant"],
  ["Bernese Mountain Dog", "giant"], ["Scottish Deerhound", "giant"], ["Bullmastiff", "giant"],
  ["Neapolitan Mastiff", "giant"], ["Caucasian Shepherd Dog", "giant"], ["Black Russian Terrier", "giant"],
  ["Boerboel", "giant"], ["Komondor", "giant"],
];

// ---- REAL cat breeds [name, sizeGroup] (100) ----
const CATS = [
  ["Singapura", "toy"], ["Munchkin", "toy"], ["Devon Rex", "toy"], ["Cornish Rex", "toy"],
  ["American Curl", "toy"], ["Napoleon", "toy"], ["Minskin", "toy"], ["Lambkin", "toy"],
  ["Skookum", "toy"], ["Dwelf", "toy"], ["Bambino", "toy"], ["Kinkalow", "toy"],
  ["Genetta", "toy"], ["Toybob", "toy"], ["Foldex", "toy"], ["Lykoi", "toy"],
  ["Sphynx", "toy"], ["Cyprus", "toy"], ["Korn Ja", "toy"], ["Sam Sawet", "toy"],
  ["Siamese", "small"], ["Abyssinian", "small"], ["Oriental Shorthair", "small"], ["Russian Blue", "small"],
  ["Korat", "small"], ["Tonkinese", "small"], ["Balinese", "small"], ["Javanese", "small"],
  ["Ocicat", "small"], ["Egyptian Mau", "small"], ["Peterbald", "small"], ["Bombay", "small"],
  ["Havana Brown", "small"], ["Colorpoint Shorthair", "small"], ["Snowshoe", "small"], ["Suphalak", "small"],
  ["Khao Manee", "small"], ["Arabian Mau", "small"], ["Asian Shorthair", "small"], ["Australian Mist", "small"],
  ["Bengal", "medium"], ["British Shorthair", "medium"], ["Scottish Fold", "medium"], ["American Shorthair", "medium"],
  ["Manx", "medium"], ["Selkirk Rex", "medium"], ["Birman", "medium"], ["Turkish Angora", "medium"],
  ["Somali", "medium"], ["Nebelung", "medium"], ["Cymric", "medium"], ["Chartreux", "medium"],
  ["American Wirehair", "medium"], ["European Shorthair", "medium"], ["Aegean", "medium"], ["Kurilian Bobtail", "medium"],
  ["Pixie-bob", "medium"], ["LaPerm", "medium"], ["Burmese", "medium"], ["Burmilla", "medium"],
  ["Japanese Bobtail", "medium"], ["Mekong Bobtail", "medium"], ["Tiffanie", "medium"], ["Dragon Li", "medium"],
  ["German Rex", "medium"], ["Ojos Azules", "medium"], ["Sokoke", "medium"], ["Serengeti", "medium"],
  ["Norwegian Forest Cat", "large"], ["Ragdoll", "large"], ["Siberian", "large"], ["Turkish Van", "large"],
  ["British Longhair", "large"], ["American Bobtail", "large"], ["Highlander", "large"], ["Ragamuffin", "large"],
  ["Brazilian Shorthair", "large"], ["Donskoy", "large"], ["Ukrainian Levkoy", "large"], ["Thai", "large"],
  ["Himalayan", "large"], ["Persian", "large"], ["Exotic Shorthair", "large"], ["Toyger", "large"],
  ["Oriental Longhair", "large"], ["Chantilly-Tiffany", "large"], ["California Spangled", "large"], ["Kanaani", "large"],
  ["Maine Coon", "giant"], ["Savannah", "giant"], ["Chausie", "giant"], ["Cheetoh", "giant"],
  ["Aphrodite Giant", "giant"], ["Ragapotamus", "giant"], ["Norwegian Lynx", "giant"], ["Bristol", "giant"],
  ["Owyhee Bob", "giant"], ["Serrade Petit", "giant"], ["Karelian Bobtail", "giant"], ["Mojave Bob", "giant"],
];

function slug(species, name) {
  return species + "_" + String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function rollRarity(rng, group) {
  const w = GROUP_RARITY_WEIGHTS[group];
  const total = RARITY_ORDER.reduce((a, k) => a + w[k], 0);
  let target = rng() * total, acc = 0;
  for (const k of RARITY_ORDER) {
    acc += w[k];
    if (target < acc) return k;
  }
  return "common";
}

function build(species, list) {
  const out = [];
  const seen = new Set();
  for (const [name, group] of list) {
    const key = slug(species, name);
    if (seen.has(key)) continue;
    seen.add(key);
    const rng = mulberry32(hashStr(key));
    const rarity = rollRarity(rng, group);
    const [wMin, wMax] = SIZE_WEIGHTS[species][group];
    out.push({
      key,
      species,
      name,
      sizeGroup: group,
      weightMin: wMin,
      weightMax: wMax,
      rarity,
      purebred: rarity !== "common",
    });
  }
  return out;
}

const breeds = build("dog", DOGS).concat(build("cat", CATS));
fs.writeFileSync(path.join(__dirname, "breeds.json"), JSON.stringify(breeds, null, 0));

const byRar = {};
for (const b of breeds) byRar[b.species + ":" + b.rarity] = (byRar[b.species + ":" + b.rarity] || 0) + 1;
console.log("dogs=" + breeds.filter((b) => b.species === "dog").length + " cats=" + breeds.filter((b) => b.species === "cat").length + " total=" + breeds.length);
console.log("rarity spread:", JSON.stringify(byRar));
