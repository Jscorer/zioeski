// Business + house commands. Businesses generate passive income (handled in
// economy.js); houses are pure status. Both share buy / sell / give / list.

const { EmbedBuilder } = require("discord.js");
const economy = require("./economy");
const catalog = require("./catalog");
const island = require("./island");
const h = require("./gamehelpers");

const PREFIX = h.PREFIX;
const money = h.money;

function businessCatalogText() {
  return Object.values(catalog.BUSINESSES)
    .map((b) => `\u2022 **${b.name}** \u2014 ${money(b.price)} \u2014 earns ${money(b.rate)}/sec`)
    .join("\n");
}
function houseCatalogText() {
  return Object.values(catalog.HOUSES)
    .map((hh) => `\u2022 **${hh.name}** \u2014 ${money(hh.price)}`)
    .join("\n");
}

function countOwned(keys) {
  const counts = {};
  for (const k of keys) counts[k] = (counts[k] || 0) + 1;
  return counts;
}

// ── Businesses ─────────────────────────────────────────────
async function showBusinesses(message) {
  const u = economy.getUser(message.author.id);
  const counts = countOwned(u.businesses);
  const owned = Object.keys(counts).length
    ? Object.entries(counts)
        .map(([k, n]) => `\u2022 ${catalog.BUSINESSES[k]?.name || k}${n > 1 ? ` x${n}` : ""}`)
        .join("\n")
    : "_none yet_";
  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle("\uD83C\uDFE2 Businesses")
    .addFields(
      { name: "For sale", value: businessCatalogText() },
      { name: "You own", value: owned },
      { name: "Your income", value: `${money(u.incomePerSec)}/sec \u2192 auto-paid into your wallet` }
    )
    .setFooter({ text: `${PREFIX}business buy|sell|give <name> [@user]` });
  return message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
}

async function handleBusiness(message, args) {
  const sub = (args[0] || "").toLowerCase();
  const rest = args.slice(1);
  if (!sub || sub === "list" || sub === "info" || sub === "shop") return showBusinesses(message);

  if (sub === "buy") {
    // Optional trailing quantity, e.g. `buy kiss the wall 5`.
    let qty = 1;
    let nameArgs = rest;
    if (rest.length > 1 && /^\d+$/.test(rest[rest.length - 1])) {
      qty = parseInt(rest[rest.length - 1], 10);
      nameArgs = rest.slice(0, -1);
    }
    const def = catalog.findBusiness(nameArgs);
    if (!def) return message.reply(`which business?\n${businessCatalogText()}`);
    if (!Number.isFinite(qty) || qty <= 0) qty = 1;
    const res = economy.buyBusiness(message.author.id, def.key, qty);
    if (!res.ok) {
      if (res.reason === "cap") return message.reply(`\uD83D\uDED1 you already own the max **${res.cap}** \u00D7 ${def.name}. That's the cap per business.`);
      if (res.reason === "insufficient") return message.reply(`you need ${money(res.totalCost)} (wallet + bank) to buy ${res.qty} \u00D7 ${def.name}`);
      return message.reply("couldn't buy that");
    }
    const label = res.qty > 1 ? `${res.qty} \u00D7 ${def.name}` : def.name;
    const capNote = res.capped ? ` (you've hit the cap of ${economy.MAX_PER_BUSINESS})` : "";
    return message.reply(`\uD83C\uDFE2 bought **${label}** for ${money(res.totalCost)} \u2014 +${money(def.rate * res.qty)}/sec income${capNote}`);
  }

  if (sub === "sell") {
    const def = catalog.findBusiness(rest);
    if (!def) return message.reply(`which business?\n${businessCatalogText()}`);
    const res = economy.sellBusiness(message.author.id, def.key);
    if (!res.ok) return message.reply(res.reason === "not owned" ? `you don't own a ${def.name}` : "couldn't sell that");
    return message.reply(`\uD83D\uDCB8 sold **${def.name}** for ${money(res.refund)} (80% of what you paid)`);
  }

  if (sub === "give") {
    const target = h.firstMentionUser(message);
    if (!target) return message.reply(`usage: \`${PREFIX}business give <business> @user\``);
    if (target.bot) return message.reply("can't give a business to a bot");
    const def = catalog.findBusiness(rest);
    if (!def) return message.reply(`which business?\n${businessCatalogText()}`);
    const res = economy.giveBusiness(message.author.id, target.id, def.key);
    if (!res.ok) return message.reply(res.reason === "not owned" ? `you don't own a ${def.name}` : "couldn't give that");
    return message.reply(`\uD83E\uDD1D gave **${def.name}** to <@${target.id}>`, { allowedMentions: { users: [] } });
  }

  return message.reply(`usage: \`${PREFIX}business buy|sell|give|list <name>\``);
}

// ── Houses ────────────────────────────────────────────────
async function showHouses(message) {
  const u = economy.getUser(message.author.id);
  const counts = countOwned(u.houses);
  const owned = Object.keys(counts).length
    ? Object.entries(counts)
        .map(([k, n]) => `\u2022 ${catalog.HOUSES[k]?.name || k}${n > 1 ? ` x${n}` : ""}`)
        .join("\n")
    : "_none yet_";
  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle("\uD83C\uDFE0 Houses")
    .addFields(
      { name: "For sale", value: houseCatalogText() },
      { name: "You own", value: owned }
    )
    .setFooter({ text: `${PREFIX}house buy|sell|give <name> [@user]` });
  return message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
}

async function handleHouse(message, args) {
  const sub = (args[0] || "").toLowerCase();
  const rest = args.slice(1);
  if (!sub || sub === "list" || sub === "info" || sub === "shop") return showHouses(message);

  if (sub === "buy") {
    const def = catalog.findHouse(rest);
    if (!def) return message.reply(`which house?\n${houseCatalogText()}`);
    const res = economy.buyHouse(message.author.id, def.key);
    if (!res.ok) {
      if (res.reason === "already owned") return message.reply(`you can only own **one** ${def.name}. You've already got it.`);
      if (res.reason === "insufficient") return message.reply(`you need ${money(def.price)} (wallet + bank) to buy a ${def.name}`);
      return message.reply("couldn't buy that");
    }
    // The Private Island spins up a personal locked channel.
    if (def.key === "island") {
      const made = await island.ensureIslandChannel(message).catch(() => ({ ok: false }));
      if (made && made.ok) {
        return message.reply(
          `\uD83C\uDFDD\uFE0F bought your **${def.name}** for ${money(def.price)} \u2014 your private channel is <#${made.channel.id}>!\n` +
            `it's locked to just you (and admins). \`${PREFIX}island rename <name>\` \u00b7 \`${PREFIX}island perms give @user\``,
          { allowedMentions: { repliedUser: false } }
        );
      }
      return message.reply(
        `\uD83C\uDFDD\uFE0F bought your **${def.name}** for ${money(def.price)}! \u26A0\uFE0F but I couldn't create your channel \u2014 make sure I have **Manage Channels** permission, then run \`${PREFIX}island\` to build it.`
      );
    }
    return message.reply(`\uD83C\uDFE0 bought a **${def.name}** for ${money(def.price)}`);
  }

  if (sub === "sell") {
    const def = catalog.findHouse(rest);
    if (!def) return message.reply(`which house?\n${houseCatalogText()}`);
    const res = economy.sellHouse(message.author.id, def.key);
    if (!res.ok) {
      if (res.reason === "nosell") return message.reply(`\uD83C\uDFDD\uFE0F you can't sell your **${def.name}** \u2014 it's yours for life.`);
      return message.reply(res.reason === "not owned" ? `you don't own a ${def.name}` : "couldn't sell that");
    }
    return message.reply(`\uD83D\uDCB8 sold your **${def.name}** for ${money(res.refund)} (80%)`);
  }

  if (sub === "give") {
    const target = h.firstMentionUser(message);
    if (!target) return message.reply(`usage: \`${PREFIX}house give <house> @user\``);
    if (target.bot) return message.reply("can't give a house to a bot");
    const def = catalog.findHouse(rest);
    if (!def) return message.reply(`which house?\n${houseCatalogText()}`);
    const res = economy.giveHouse(message.author.id, target.id, def.key);
    if (!res.ok) {
      if (res.reason === "nosell") return message.reply(`\uD83C\uDFDD\uFE0F you can't give away your **${def.name}** \u2014 it's bound to you.`);
      return message.reply(res.reason === "not owned" ? `you don't own a ${def.name}` : "couldn't give that");
    }
    return message.reply(`\uD83E\uDD1D gave your **${def.name}** to <@${target.id}>`, { allowedMentions: { users: [] } });
  }

  return message.reply(`usage: \`${PREFIX}house buy|sell|give|list <name>\``);
}

module.exports = { handleBusiness, handleHouse, showBusinesses, showHouses };
