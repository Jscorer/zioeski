// Factory + goyslop commands. A player owns ONE factory that produces goyslop
// (a resource) over time. Upgrades double in cost but multiply output by 1.6x.
// Goyslop is sold for cash via `!goyslop sell`.

const { EmbedBuilder } = require("discord.js");
const economy = require("./economy");
const h = require("./gamehelpers");

const PREFIX = h.PREFIX;
const money = h.money;
const SLOP = "\uD83E\uDD63"; // 🥣 bowl of slop

// round a goyslop/sec rate for display (keeps a couple decimals)
function rateStr(r) {
  const rounded = Math.round(r * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

async function showFactory(message) {
  const info = economy.factoryInfo(message.author.id);
  if (!info.owned) {
    const embed = new EmbedBuilder()
      .setColor(0x95a5a6)
      .setTitle("\uD83C\uDFED Goyslop Factory")
      .setDescription(
        `you don't own a factory yet.\n\nbuy one with \`${PREFIX}factory buy\` for **${money(info.buyCost)}**.\n` +
          `it starts producing **${info.baseRate} ${SLOP}/sec**, and you can upgrade it to crank that up.`
      )
      .setFooter({ text: `sell goyslop with ${PREFIX}goyslop sell \u2022 ${money(economy.GOYSLOP_PRICE)} each` });
    return message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
  }
  const embed = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle("\uD83C\uDFED Your Goyslop Factory")
    .addFields(
      { name: "Level", value: `${info.level}${info.maxed ? " (MAX)" : ""}`, inline: true },
      { name: "Production", value: `${rateStr(info.rate)} ${SLOP}/sec`, inline: true },
      { name: "Stockpile", value: `${money(info.goyslop)} ${SLOP}`, inline: true },
      {
        name: "Next upgrade",
        value: info.maxed
          ? `fully upgraded \u2014 this factory is maxed out`
          : `${money(info.nextCost)} \u2192 **${rateStr(info.nextRate)} ${SLOP}/sec** (x${economy.FACTORY_UPGRADE_MULT})`,
      }
    )
    .setFooter({ text: `${PREFIX}factory upgrade \u2022 ${PREFIX}goyslop sell (${money(economy.GOYSLOP_PRICE)} each)` });
  return message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
}

async function handleFactory(message, args) {
  const sub = (args[0] || "").toLowerCase();
  if (!sub || sub === "info" || sub === "status" || sub === "list") return showFactory(message);

  if (sub === "buy") {
    const res = economy.buyFactory(message.author.id);
    if (!res.ok) {
      if (res.reason === "owned")
        return message.reply(`you already own a factory (level ${res.level}) \u2014 upgrade it with \`${PREFIX}factory upgrade\``);
      if (res.reason === "insufficient")
        return message.reply(`you need ${money(res.cost)} (wallet + bank) to buy a factory`);
      return message.reply("couldn't buy that");
    }
    return message.reply(
      `\uD83C\uDFED bought your **Goyslop Factory** for ${money(res.cost)} \u2014 now producing **${rateStr(res.rate)} ${SLOP}/sec**. sell with \`${PREFIX}goyslop sell\``
    );
  }

  if (sub === "upgrade" || sub === "up") {
    const res = economy.upgradeFactory(message.author.id);
    if (!res.ok) {
      if (res.reason === "none")
        return message.reply(`you don't own a factory yet \u2014 buy one with \`${PREFIX}factory buy\` for ${money(res.buyCost)}`);
      if (res.reason === "max")
        return message.reply(`your factory is already maxed out at level ${res.level} \u2014 can't upgrade further`);
      if (res.reason === "insufficient")
        return message.reply(`you need ${money(res.cost)} (wallet + bank) for the next upgrade`);
      return message.reply("couldn't upgrade that");
    }
    return message.reply(
      `\u2B06\uFE0F upgraded your factory to **level ${res.level}** for ${money(res.cost)} \u2014 production ${rateStr(res.oldRate)} \u2192 **${rateStr(res.rate)} ${SLOP}/sec**`
    );
  }

  return message.reply(`usage: \`${PREFIX}factory buy|upgrade|info\``);
}

async function handleGoyslop(message, args) {
  const sub = (args[0] || "").toLowerCase();

  if (sub === "sell") {
    const res = economy.sellGoyslop(message.author.id);
    if (!res.ok) return message.reply(`you've got no goyslop to sell \u2014 build a factory with \`${PREFIX}factory buy\``);
    return message.reply(
      `\uD83D\uDCB0 sold **${money(res.sold)} ${SLOP}** for ${money(res.value)} (${money(res.pricePer)} each). wallet: ${money(res.wallet)}`
    );
  }

  // default: display goyslop balance + production
  const info = economy.factoryInfo(message.author.id);
  const bal = economy.getGoyslop(message.author.id);
  const lines = [`you have **${money(bal)} ${SLOP}** goyslop (worth ${money(bal * economy.GOYSLOP_PRICE)})`];
  if (info.owned) lines.push(`factory level ${info.level} \u2022 producing ${rateStr(info.rate)} ${SLOP}/sec`);
  else lines.push(`no factory yet \u2014 buy one with \`${PREFIX}factory buy\``);
  lines.push(`sell it all with \`${PREFIX}goyslop sell\` (${money(economy.GOYSLOP_PRICE)} each)`);
  const embed = new EmbedBuilder().setColor(0xe67e22).setTitle(`${SLOP} Goyslop`).setDescription(lines.join("\n"));
  return message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
}

module.exports = { handleFactory, handleGoyslop, showFactory };
