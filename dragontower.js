// Pure dragon-tower math — no Discord deps. Provably fair by construction:
// on each row a fixed number of safe tiles (eggs) and dragons are placed
// uniformly at random. Climbing one row multiplies your stake by (tiles/safe),
// scaled by the RTP house edge — so the expected value of every step is
// RTP × stake regardless of difficulty or when you cash out.
//
// Pick a tile on each row; an egg lets you climb, a dragon ends the run.

const RTP = 0.98; // 2% house edge
const ROWS = 9;   // height of the tower

// tiles = columns per row, safe = how many are eggs (rest are dragons).
const DIFFICULTY = {
  easy:   { tiles: 4, safe: 3, label: "Easy" },     // 1 dragon  (3/4 per row)
  medium: { tiles: 3, safe: 2, label: "Medium" },   // 1 dragon  (2/3 per row)
  hard:   { tiles: 2, safe: 1, label: "Hard" },     // 1 dragon  (1/2 per row)
  expert: { tiles: 3, safe: 1, label: "Expert" },   // 2 dragons (1/3 per row)
  master: { tiles: 4, safe: 1, label: "Master" },   // 3 dragons (1/4 per row)
};

function resolveDifficulty(name) {
  const key = String(name || "medium").toLowerCase();
  const aliases = { e: "easy", m: "medium", h: "hard", x: "expert", exp: "expert", nightmare: "master", insane: "master" };
  return DIFFICULTY[key] || DIFFICULTY[aliases[key]] || null;
}

// Build the safe-tile layout for the whole tower: rows[r] = Set of safe column
// indices for that row. Dragons are every column not in the set.
function makeTower(diff, rng = Math.random) {
  const rows = [];
  for (let r = 0; r < ROWS; r++) {
    const cols = Array.from({ length: diff.tiles }, (_, i) => i);
    for (let i = cols.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [cols[i], cols[j]] = [cols[j], cols[i]];
    }
    rows.push(new Set(cols.slice(0, diff.safe)));
  }
  return rows;
}

// Total return multiplier after safely climbing `level` rows.
// = RTP * (tiles/safe)^level
function multiplier(diff, level) {
  if (level <= 0) return 1; // cashing out before climbing returns the stake
  return RTP * Math.pow(diff.tiles / diff.safe, level);
}

function stepMultiplier(diff) {
  return diff.tiles / diff.safe;
}

module.exports = { RTP, ROWS, DIFFICULTY, resolveDifficulty, makeTower, multiplier, stepMultiplier };
