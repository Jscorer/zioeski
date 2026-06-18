// Shared helpers for economy commands + gambling games.
// No dependency on commands.js or games.js, so there are no circular requires.

const economy = require("./economy");
const config = require("./config");

const PREFIX = config.COMMAND_PREFIX || "!";
const CUR = config.CURRENCY_NAME || "goy bucks";
const EMOJI = config.CURRENCY_EMOJI || "\uD83D\uDCB0"; // 💰

function money(n) {
  return `${EMOJI} ${economy.fmt(n)} ${CUR}`;
}

// Parse a bet/amount arg. Supports: plain numbers, commas, k/m/b suffixes,
// and the keywords all / max / half (relative to `max`).
function parseAmount(arg, max) {
  if (arg === undefined || arg === null) return NaN;
  const a = String(arg).toLowerCase().replace(/,/g, "").trim();
  if (a === "all" || a === "max") return Math.floor(max);
  if (a === "half") return Math.floor(max / 2);
  const m = a.match(/^(\d*\.?\d+)\s*([kmb]?)$/);
  if (!m) return NaN;
  let v = parseFloat(m[1]);
  const suf = m[2];
  if (suf === "k") v *= 1e3;
  else if (suf === "m") v *= 1e6;
  else if (suf === "b") v *= 1e9;
  return Math.floor(v);
}

function firstMentionUser(message) {
  // Ignore a leading mention that is the bot itself (in case of reply pings)
  return message.mentions.users.filter((u) => u.id !== message.client.user.id).first() || null;
}

// Validate a solo bet against the player's wallet.
function validateBet(userId, rawAmount) {
  const u = economy.getUser(userId);
  if (u.away) {
    // Hard override: no gambling while away. This is the single chokepoint every
    // game routes its bet through, so blocking here blocks every game at once.
    return { ok: false, error: `\uD83D\uDE34 you can't gamble while away \u2014 toggle \`${PREFIX}away\` off first` };
  }
  const amount = parseAmount(rawAmount, u.wallet);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: `give me a real amount. e.g. \`${PREFIX}coinflip 500\` (or \`all\`, \`half\`, \`1k\`)` };
  }
  if (amount > u.wallet) {
    return { ok: false, error: `you've only got ${money(u.wallet)} in your wallet` };
  }
  return { ok: true, amount };
}

// ── Card / deck helpers ────────────────────────────────────────
const SUITS = ["\u2660", "\u2665", "\u2666", "\u2663"]; // ♠ ♥ ♦ ♣
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

function drawCard() {
  return {
    rank: RANKS[Math.floor(Math.random() * RANKS.length)],
    suit: SUITS[Math.floor(Math.random() * SUITS.length)],
  };
}
function cardStr(c) {
  return `\`${c.rank}${c.suit}\``;
}
function handStr(cards) {
  return cards.map(cardStr).join(" ");
}
// Higher/lower numeric value (A=1 .. K=13)
function hlValue(c) {
  if (c.rank === "A") return 1;
  if (c.rank === "J") return 11;
  if (c.rank === "Q") return 12;
  if (c.rank === "K") return 13;
  return parseInt(c.rank, 10);
}
// Blackjack base value (Aces resolved in handTotal)
function bjValue(c) {
  if (c.rank === "A") return 11;
  if (["J", "Q", "K"].includes(c.rank)) return 10;
  return parseInt(c.rank, 10);
}
function handTotal(cards) {
  let total = cards.reduce((a, c) => a + bjValue(c), 0);
  let aces = cards.filter((c) => c.rank === "A").length;
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

// ── Per-user game lock (prevents double-spending the same wallet) ──────────
const busy = new Set();
function lock(id) {
  if (busy.has(id)) return false;
  busy.add(id);
  return true;
}
function unlock(id) {
  busy.delete(id);
}

module.exports = {
  PREFIX,
  CUR,
  EMOJI,
  money,
  parseAmount,
  firstMentionUser,
  validateBet,
  drawCard,
  cardStr,
  handStr,
  hlValue,
  bjValue,
  handTotal,
  lock,
  unlock,
};
