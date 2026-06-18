// Pure mines math — no Discord deps. Provably fair by construction: the only
// randomness is WHERE the mines are placed (a uniform shuffle). The payout
// multiplier after k safe picks is exactly the house edge (RTP) divided by the
// real probability of having survived k picks, so the expected value of every
// single pick is RTP × stake no matter how many mines you choose or when you
// cash out. No rigging, no tracking the player.
//
// Grid is 20 tiles (5 wide × 4 tall) so a Cash Out button fits within Discord's
// 5-row component limit.

const TILES = 20;
const RTP = 0.97; // 3% house edge

// Fisher–Yates shuffle to place M mines uniformly at random among TILES.
function makeBoard(mines, rng = Math.random) {
  const idx = Array.from({ length: TILES }, (_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return new Set(idx.slice(0, mines)); // positions that are mines
}

// Total return multiplier after revealing k safe tiles with `mines` mines.
// = RTP * product_{i=0}^{k-1} (TILES - i) / (TILES - mines - i)
function multiplier(mines, k) {
  let m = RTP;
  for (let i = 0; i < k; i++) {
    m *= (TILES - i) / (TILES - mines - i);
  }
  return m;
}

// Probability the NEXT pick is safe given k already revealed safe.
function nextSafeChance(mines, k) {
  const remaining = TILES - k;
  const safeRemaining = TILES - mines - k;
  return safeRemaining / remaining;
}

function maxSafe(mines) {
  return TILES - mines;
}

module.exports = { TILES, RTP, makeBoard, multiplier, nextSafeChance, maxSafe };
