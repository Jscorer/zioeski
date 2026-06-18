// Crime system. Each crime has its own 30s cooldown (you can spam all three,
// one at a time). Failing a crime raises the Police Heat Bar (0-3); at max
// heat is maxed you can't commit any crimes until it cools back down.

const { EmbedBuilder } = require("discord.js");
const economy = require("./economy");
const h = require("./gamehelpers");

const PREFIX = h.PREFIX;
const money = h.money;

const CRIMES = {
  shoplift: { key: "shoplift", name: "Shoplift", emoji: "\uD83D\uDED2", chance: 0.6, min: 200, max: 500 },
  skim: { key: "skim", name: "Card Skim", emoji: "\uD83D\uDCB3", chance: 0.5, min: 500, max: 2000 },
  sellfent: { key: "sellfent", name: "Sell Fent", emoji: "\uD83D\uDC8A", chance: 0.3, min: 5000, max: 5000 },
};

const SUCCESS_LINES = {
  shoplift: ["walked out with pockets full", "security was sleeping, easy lick", "five finger discount sorted"],
  skim: ["cloned the card clean", "got the pin, cashed out", "machine never knew"],
  sellfent: ["moved the whole batch", "corner was busy tonight", "plug came through"],
};
const FAIL_LINES = {
  shoplift: ["alarm went off, had to leg it", "got spotted on cctv", "guard clocked you"],
  skim: ["reader jammed, someone saw", "card got declined and flagged", "feds pinged the atm"],
  sellfent: ["buyer was an undercover", "got jumped mid deal", "someone snitched"],
};

function randInt(a, b) {
  return Math.floor(Math.random() * (b - a + 1)) + a;
}
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Visual heat bar, e.g. 🔴🔴⚪
 function heatBar(heat, max) {
  return "\uD83D\uDD34".repeat(heat) + "\u26AA".repeat(Math.max(0, max - heat));
}

async function doCrime(message, key) {
  const def = CRIMES[key];
  const id = message.author.id;

  // Heat maxed → too hot to commit crimes until it cools down.
  if (economy.isHeatMaxed(id)) {
    const st = economy.getHeatStatus(id);
    return message.reply(`\uD83D\uDEA8 too much heat \u2014 lay low. cools down 1 in ${economy.formatDuration(st.nextDecayMs)}`);
  }

  const cd = economy.crimeCooldownRemaining(id, key);
  if (cd > 0) {
    return message.reply(`lay low \u2014 \`${PREFIX}${key}\` is on cooldown for ${economy.formatDuration(cd)}`);
  }
  economy.markCrime(id, key);

  const success = Math.random() < def.chance;
  if (success) {
    const amount = randInt(def.min, def.max);
    economy.addWallet(id, amount);
    const u = economy.getUser(id);
    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle(`${def.emoji} ${def.name} \u2014 success`)
      .setDescription(`${pick(SUCCESS_LINES[key])}\nyou made **${money(amount)}**`)
      .setFooter({ text: `wallet: ${economy.fmt(u.wallet)}` });
    return message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
  }

  // Failure → +1 heat. If that maxes the bar, crimes lock until it cools.
  const res = economy.addHeat(id, 1);
  if (res.maxed) {
    const embed = new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle(`\uD83D\uDEA8 ${def.name} failed \u2014 HEAT MAXED`)
      .setDescription(
        `${pick(FAIL_LINES[key])}\n\n` +
          `heat: ${heatBar(res.heat, res.maxHeat)} (${res.heat}/${res.maxHeat})\n` +
          `too hot \u2014 **no more crimes until your heat cools down** (1 every 5 min)`
      );
    return message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
  }

  const embed = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle(`${def.emoji} ${def.name} \u2014 failed`)
    .setDescription(`${pick(FAIL_LINES[key])}\nheat: ${heatBar(res.heat, res.maxHeat)} (${res.heat}/${res.maxHeat})`)
    .setFooter({ text: "heat cools 1 every 5 min \u2014 max it out and crimes lock til it drops" });
  return message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
}

async function cmdHeat(message) {
  const id = message.author.id;
  const st = economy.getHeatStatus(id);
  const embed = new EmbedBuilder().setColor(st.maxed ? 0xe74c3c : 0x3498db).setTitle("\uD83D\uDEA8 Police Heat");
  let desc = `${heatBar(st.heat, st.maxHeat)}  (${st.heat}/${st.maxHeat})`;
  if (st.maxed) {
    desc += `\n\n\uD83D\uDEA8 **MAXED** \u2014 too hot to commit crimes. cools down 1 in ${economy.formatDuration(st.nextDecayMs)}`;
  } else if (st.heat > 0) {
    desc += `\n\ncools down 1 in ${economy.formatDuration(st.nextDecayMs)}`;
  } else {
    desc += `\n\nyou're clean`;
  }
  embed.setDescription(desc);
  return message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
}

module.exports = {
  shoplift: (m) => doCrime(m, "shoplift"),
  skim: (m) => doCrime(m, "skim"),
  sellfent: (m) => doCrime(m, "sellfent"),
  cmdHeat,
  heatBar,
  CRIMES,
};
