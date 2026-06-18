// ============================================================
//  ADMIN COMMANDS — hidden owner-only tools
// ============================================================
//  Only the user whose Discord ID matches OWNER_ID (config.js or a
//  .env line OWNER_ID=...) can use ANY of these. To everyone else the
//  !admin command is completely invisible (no reply at all).
//  These commands are intentionally NOT listed in !help — see !admin help.
// ============================================================

const economy = require("./economy");
const pets = require("./pets");
const config = require("./config");
const { PREFIX, money, firstMentionUser } = require("./gamehelpers");

const OWNER_ID = String(process.env.OWNER_ID || config.OWNER_ID || "").trim();
const BIG = Number.MAX_SAFE_INTEGER;

function isOwner(id) {
  return OWNER_ID.length > 0 && String(id) === OWNER_ID;
}

// Parse the first token that looks like a money amount (123, 1k, 2.5m, 1b).
function parseMoneyArg(args) {
  for (const a of args) {
    const s = String(a).toLowerCase().replace(/,/g, "").trim();
    const m = s.match(/^(\d*\.?\d+)\s*([kmb]?)$/);
    if (!m) continue;
    let v = parseFloat(m[1]);
    if (m[2] === "k") v *= 1e3; else if (m[2] === "m") v *= 1e6; else if (m[2] === "b") v *= 1e9;
    if (Number.isFinite(v) && v > 0) return Math.floor(v);
  }
  return NaN;
}

// Parse a plain integer (used for timeout minutes — NOT money suffixes).
function parseIntArg(args) {
  for (const a of args) { if (/^\d+$/.test(a)) return parseInt(a, 10); }
  return NaN;
}

function reasonFrom(args) {
  const words = args.filter((a) => !/^<@!?\d+>$/.test(a) && !/^\d+$/.test(a));
  return words.join(" ").trim();
}

async function fetchMember(message, userId) {
  if (!message.guild) return null;
  try { return await message.guild.members.fetch(userId); } catch (_) { return null; }
}

async function deleteIsland(message, ownerId) {
  const chId = economy.getIslandChannel(ownerId);
  economy.clearIslandChannel(ownerId);
  if (!chId || !message.guild) return false;
  let ch = message.guild.channels.cache.get(chId);
  if (!ch) ch = await message.guild.channels.fetch(chId).catch(() => null);
  if (ch) { await ch.delete("Private island wiped by admin").catch(() => {}); return true; }
  return false;
}

function helpText() {
  const p = PREFIX;
  return [
    "\uD83D\uDEE1\uFE0F **ADMIN \u2014 owner only** (hidden from " + p + "help)",
    "",
    "**Money**",
    "\u2022 `" + p + "admin give money @user <amount>` \u2014 add to their wallet",
    "\u2022 `" + p + "admin remove money @user <amount>` \u2014 take from their wallet",
    "\u2022 `" + p + "admin set money @user <amount>` \u2014 set their wallet exactly",
    "\u2022 `" + p + "admin info @user` \u2014 show their balances & assets",
    "",
    "**Wipes**",
    "\u2022 `" + p + "admin wipe businesses @user` \u2014 must rebuy",
    "\u2022 `" + p + "admin wipe factory @user` \u2014 must rebuy & re-upgrade",
    "\u2022 `" + p + "admin wipe cars @user`",
    "\u2022 `" + p + "admin wipe dogs @user` \u00b7 `" + p + "admin wipe cats @user` \u00b7 `" + p + "admin wipe pets @user`",
    "\u2022 `" + p + "admin wipe houses @user` \u2014 also deletes their private island channel",
    "\u2022 `" + p + "admin wipe all @user` \u2014 everything above at once",
    "",
    "**Moderation**",
    "\u2022 `" + p + "admin ban @user [reason]`",
    "\u2022 `" + p + "admin kick @user [reason]`",
    "\u2022 `" + p + "admin timeout @user <minutes> [reason]` \u00b7 `" + p + "admin untimeout @user`",
  ].join("\n");
}

async function doWipe(message, what, t) {
  switch (what) {
    case "business": case "businesses": {
      const n = economy.wipeBusinesses(t.id);
      return message.reply("\uD83E\uDDF9 wiped **" + n + "** business(es) from <@" + t.id + "> \u2014 they'll have to rebuy.");
    }
    case "factory": {
      const had = economy.wipeFactory(t.id);
      return message.reply(had ? "\uD83E\uDDF9 wiped <@" + t.id + ">'s factory \u2014 they must rebuy & re-upgrade." : "<@" + t.id + "> didn't own a factory.");
    }
    case "car": case "cars": {
      const n = economy.wipeCars(t.id);
      return message.reply("\uD83E\uDDF9 wiped **" + n + "** car(s) from <@" + t.id + ">.");
    }
    case "dog": case "dogs": {
      const n = pets.wipePets(t.id, "dog");
      return message.reply("\uD83E\uDDF9 wiped **" + n + "** dog(s) from <@" + t.id + ">.");
    }
    case "cat": case "cats": {
      const n = pets.wipePets(t.id, "cat");
      return message.reply("\uD83E\uDDF9 wiped **" + n + "** cat(s) from <@" + t.id + ">.");
    }
    case "pet": case "pets": {
      const n = pets.wipePets(t.id, "all");
      return message.reply("\uD83E\uDDF9 wiped **" + n + "** pet(s) from <@" + t.id + ">.");
    }
    case "house": case "houses": {
      const res = economy.wipeHouses(t.id);
      let extra = "";
      if (res.hadIsland) { const del = await deleteIsland(message, t.id); extra = del ? " Their private island channel was deleted." : " (island record cleared)."; }
      return message.reply("\uD83E\uDDF9 wiped **" + res.count + "** house(s) from <@" + t.id + ">." + extra);
    }
    case "all": {
      const b = economy.wipeBusinesses(t.id);
      economy.wipeFactory(t.id);
      const c = economy.wipeCars(t.id);
      const p = pets.wipePets(t.id, "all");
      const res = economy.wipeHouses(t.id);
      if (res.hadIsland) await deleteIsland(message, t.id);
      return message.reply("\uD83E\uDDF9 nuked <@" + t.id + ">: " + b + " businesses, factory, " + c + " cars, " + p + " pets, " + res.count + " houses" + (res.hadIsland ? " (+island)" : "") + " wiped.");
    }
    default:
      return message.reply("wipe what? `businesses` `factory` `cars` `dogs` `cats` `pets` `houses` `all`");
  }
}

async function handleAdmin(message, args) {
  // Hard gate: anyone who isn't the owner gets ZERO response — invisible.
  if (!isOwner(message.author.id)) return;

  const sub = (args[0] || "").toLowerCase();
  if (!sub || sub === "help") return message.reply(helpText());

  // money: give / add / remove / take / set
  if (sub === "give" || sub === "add" || sub === "remove" || sub === "take" || sub === "deduct" || sub === "set") {
    const t = firstMentionUser(message);
    if (!t) return message.reply("tag a user: `" + PREFIX + "admin " + sub + " money @user <amount>`");
    const amt = parseMoneyArg(args.slice(1));
    if (!Number.isFinite(amt) || amt <= 0) return message.reply("give a positive amount, e.g. `" + PREFIX + "admin " + sub + " money @user 50000`");
    if (sub === "set") {
      economy.setWallet(t.id, amt);
      return message.reply("\u2705 set <@" + t.id + ">'s wallet to " + money(amt) + ".");
    }
    if (sub === "give" || sub === "add") {
      const w = economy.addWallet(t.id, amt);
      return message.reply("\u2705 gave " + money(amt) + " to <@" + t.id + ">. wallet now " + money(w) + ".");
    }
    const w = economy.addWallet(t.id, -amt);
    return message.reply("\u2705 removed " + money(amt) + " from <@" + t.id + ">. wallet now " + money(w) + ".");
  }

  if (sub === "info" || sub === "check") {
    const t = firstMentionUser(message);
    if (!t) return message.reply("tag a user: `" + PREFIX + "admin info @user`");
    const nw = economy.netWorth(t.id);
    const u = economy.getUser(t.id);
    return message.reply([
      "\uD83D\uDCCA **<@" + t.id + ">**",
      "wallet " + money(nw.wallet) + " \u00b7 bank " + money(nw.bank),
      "net worth " + money(nw.total),
      "businesses " + (u.businesses ? u.businesses.length : 0) + " \u00b7 cars " + (u.cars ? u.cars.length : 0) + " \u00b7 houses " + (u.houses ? u.houses.length : 0) + " \u00b7 factory " + (u.factory ? "yes" : "no"),
    ].join("\n"));
  }

  if (sub === "wipe") {
    const t = firstMentionUser(message);
    if (!t) return message.reply("tag a user: `" + PREFIX + "admin wipe <thing> @user`");
    const what = (args[1] || "").toLowerCase();
    return doWipe(message, what, t);
  }

  // Moderation
  if (sub === "ban" || sub === "kick" || sub === "timeout" || sub === "mute" || sub === "untimeout" || sub === "unmute") {
    if (!message.guild) return message.reply("moderation only works in a server.");
    const t = firstMentionUser(message);
    if (!t) return message.reply("tag a user: `" + PREFIX + "admin " + sub + " @user`");
    if (t.id === message.author.id) return message.reply("you can't " + sub + " yourself.");
    const reason = reasonFrom(args.slice(1)) || ("Admin " + sub + " by owner");

    if (sub === "ban") {
      try { await message.guild.members.ban(t.id, { reason }); return message.reply("\uD83D\uDD28 banned <@" + t.id + ">."); }
      catch (e) { return message.reply("couldn't ban \u2014 check I have **Ban Members** and a higher role. (" + e.message + ")"); }
    }
    if (sub === "kick") {
      const m = await fetchMember(message, t.id);
      if (!m) return message.reply("they're not in the server.");
      try { await m.kick(reason); return message.reply("\uD83D\uDC62 kicked <@" + t.id + ">."); }
      catch (e) { return message.reply("couldn't kick \u2014 check I have **Kick Members** and a higher role. (" + e.message + ")"); }
    }
    if (sub === "untimeout" || sub === "unmute") {
      const m = await fetchMember(message, t.id);
      if (!m) return message.reply("they're not in the server.");
      try { await m.timeout(null, reason); return message.reply("\u2705 cleared timeout on <@" + t.id + ">."); }
      catch (e) { return message.reply("couldn't clear timeout \u2014 check **Moderate Members**. (" + e.message + ")"); }
    }
    // timeout / mute
    const mins = parseIntArg(args.slice(1));
    if (!Number.isFinite(mins) || mins <= 0) return message.reply("how many minutes? `" + PREFIX + "admin timeout @user 10`");
    const ms = Math.min(mins, 40320) * 60 * 1000; // Discord max 28 days
    const m = await fetchMember(message, t.id);
    if (!m) return message.reply("they're not in the server.");
    try { await m.timeout(ms, reason); return message.reply("\u23F2\uFE0F timed out <@" + t.id + "> for **" + mins + "** min."); }
    catch (e) { return message.reply("couldn't timeout \u2014 check I have **Moderate Members** and a higher role. (" + e.message + ")"); }
  }

  return message.reply("unknown admin command. `" + PREFIX + "admin help`");
}

module.exports = { handleAdmin, isOwner, OWNER_ID };
