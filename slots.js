// Pure slots math — no Discord deps, so the paytable can be unit-tested and
// the RTP (return-to-player) simulated. The game is provably fair: every reel
// is an INDEPENDENT weighted random pick (no "near miss" rigging, no tracking
// of who's betting), and payouts come from a fixed published paytable.
//
// 3-reel slot with:
//   • Wilds (🃏) that substitute for any paying symbol
//   • Scatters (⭐) that pay anywhere + trigger free spins
//   • Free spins bonus with a 2x win multiplier (and re-triggers)
//   • A wild jackpot

const REELS = 3;

// Each reel uses this same weighted strip. Weights only affect how often a
// symbol shows up — every spin is independent.
const SYMBOLS = [
  { key: "seven",   emoji: "7\uFE0F\u20E3",  weight: 3 },
  { key: "diamond", emoji: "\uD83D\uDC8E", weight: 6 },
  { key: "bell",    emoji: "\uD83D\uDD14", weight: 10 },
  { key: "lemon",   emoji: "\uD83C\uDF4B", weight: 16 },
  { key: "cherry",  emoji: "\uD83C\uDF52", weight: 22 },
  { key: "wild",    emoji: "\uD83C\uDCCF", weight: 4 },
  { key: "scatter", emoji: "\u2B50",        weight: 5 },
];

const EMOJI = Object.fromEntries(SYMBOLS.map((s) => [s.key, s.emoji]));

// 3-of-a-kind payouts (total return multiplier of the bet, 0 = no win).
const THREE = { seven: 45, diamond: 20, bell: 9, lemon: 4, cherry: 2 };
// Three wilds = jackpot.
const WILD3 = 180;
// Two of a kind (wild counts toward the pair). Rare symbols pay a real profit;
// common symbols pay a small consolation so most spins give something back.
const TWO = { seven: 3, diamond: 2, bell: 1, lemon: 0.4, cherry: 0.3 };
// Scatter pays by how many land anywhere on the 3 reels — 2+ now award free spins.
const SCATTER2 = 2;          // 2 scatters → 2x + a few free spins
const SCATTER3 = 8;          // 3 scatters → 8x + a big batch of free spins
const FREE_SPINS_2 = 3;      // free spins awarded by 2 scatters
const FREE_SPINS_3 = 10;     // free spins awarded by 3 scatters
const FREE_SPINS = FREE_SPINS_3; // backwards-compatible alias (exported)
const FREE_SPIN_MULT = 2;    // wins during free spins are doubled
const FREE_SPIN_CAP = 40;    // safety cap on re-triggered free spins

const TOTAL_WEIGHT = SYMBOLS.reduce((a, s) => a + s.weight, 0);

function spinReel(rng = Math.random) {
  let r = rng() * TOTAL_WEIGHT;
  for (const s of SYMBOLS) {
    if (r < s.weight) return s.key;
    r -= s.weight;
  }
  return SYMBOLS[SYMBOLS.length - 1].key;
}

function spinGrid(rng = Math.random) {
  return [spinReel(rng), spinReel(rng), spinReel(rng)];
}

// Evaluate one grid of 3 symbols. Returns { mult, freeSpins, label }.
function evaluate(grid) {
  const scatters = grid.filter((s) => s === "scatter").length;
  const wilds = grid.filter((s) => s === "wild").length;
  const core = grid.filter((s) => s !== "wild" && s !== "scatter");

  let lineMult = 0;
  let label = "";

  if (wilds === REELS) {
    lineMult = WILD3;
    label = "\uD83C\uDCCF\uD83C\uDCCF\uD83C\uDCCF WILD JACKPOT";
  } else if (scatters === 0 && core.length > 0 && core.every((s) => s === core[0])) {
    lineMult = THREE[core[0]] || 0;
    if (lineMult > 0) label = `${EMOJI[core[0]].repeat(3)} three of a kind`;
  } else {
    const counts = {};
    for (const s of core) counts[s] = (counts[s] || 0) + 1;
    let best = 0;
    let bestSym = null;
    for (const sym in counts) {
      if (counts[sym] + wilds >= 2 && (TWO[sym] || 0) > best) {
        best = TWO[sym];
        bestSym = sym;
      }
    }
    lineMult = best;
    if (best > 0) label = `${EMOJI[bestSym]}${EMOJI[bestSym]} pair`;
  }

  let scatterMult = 0;
  let freeSpins = 0;
  if (scatters >= 3) {
    scatterMult = SCATTER3;
    freeSpins = FREE_SPINS_3;
    label = label ? `${label} + ⭐⭐⭐ FREE SPINS` : "\u2B50\u2B50\u2B50 FREE SPINS";
  } else if (scatters === 2) {
    scatterMult = SCATTER2;
    freeSpins = FREE_SPINS_2;
    label = label ? `${label} + ⭐⭐ FREE SPINS` : "\u2B50\u2B50 scatter \u2014 FREE SPINS";
  }

  return { mult: lineMult + scatterMult, freeSpins, label, scatters, wilds };
}

// Play a full round: one paid base spin, plus any free spins it triggers.
function play(rng = Math.random) {
  const grid = spinGrid(rng);
  const base = evaluate(grid);
  let totalMult = base.mult;
  const freeRounds = [];

  let spinsLeft = base.freeSpins;
  let awarded = base.freeSpins;
  while (spinsLeft > 0) {
    spinsLeft--;
    const fgrid = spinGrid(rng);
    const fres = evaluate(fgrid);
    const fmult = fres.mult * FREE_SPIN_MULT;
    totalMult += fmult;
    if (fres.freeSpins > 0 && awarded < FREE_SPIN_CAP) {
      const add = Math.min(fres.freeSpins, FREE_SPIN_CAP - awarded);
      spinsLeft += add;
      awarded += add;
    }
    freeRounds.push({ grid: fgrid, mult: fmult, label: fres.label });
  }

  return { grid, base, totalMult, freeRounds, freeSpinsAwarded: awarded };
}

module.exports = {
  REELS, SYMBOLS, EMOJI, THREE, WILD3, TWO, SCATTER2, SCATTER3,
  FREE_SPINS, FREE_SPIN_MULT, TOTAL_WEIGHT,
  spinReel, spinGrid, evaluate, play,
};
