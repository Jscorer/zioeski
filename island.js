// Private Island channels. Buying the Private Island house (via !house) gives
// each player ONE private, locked text channel under a fixed category. Only the
// owner (and server admins) can see/type by default; the owner can rename it
// and grant/revoke access to other people with !island.

const { ChannelType, PermissionFlagsBits } = require("discord.js");
const economy = require("./economy");
const h = require("./gamehelpers");

const PREFIX = h.PREFIX;
const money = h.money;

// Category the private-island channels are created under.
const ISLAND_CATEGORY_ID = "1515605167330951229";

// Discord channel names: lowercase, no spaces, limited charset, <=100 chars.
function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function defaultIslandName(member, user) {
  const base = slugify((member && member.displayName) || (user && user.username) || "player") || "player";
  return `${base}-private-island`;
}

// Build the permission overwrites that lock the channel to just the owner.
// @everyone is denied view; the owner can view/send/read history; the bot keeps
// management rights. Server admins bypass overwrites automatically.
function lockedOverwrites(guild, ownerId) {
  const botId = guild.client.user.id;
  return [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: ownerId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
    {
      id: botId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
      ],
    },
  ];
}

// Create the owner's private island channel. Returns { ok, channel } or
// { ok:false, reason }. Stores the channel id on the user so !island can find it.
async function createIslandChannel(guild, ownerId, member, user) {
  if (!guild) return { ok: false, reason: "no_guild" };
  try {
    const channel = await guild.channels.create({
      name: defaultIslandName(member, user),
      type: ChannelType.GuildText,
      parent: ISLAND_CATEGORY_ID,
      topic: `\uD83C\uDFDD\uFE0F Private island of <@${ownerId}> \u2014 locked. Owner: ${PREFIX}island perms give @user`,
      permissionOverwrites: lockedOverwrites(guild, ownerId),
      reason: `Private island purchased by ${user ? user.username : ownerId}`,
    });
    economy.setIslandChannel(ownerId, channel.id);
    return { ok: true, channel };
  } catch (err) {
    return { ok: false, reason: "error", error: err };
  }
}

// Fetch the owner's existing island channel (or null). Cleans up a stale id if
// the channel was deleted.
async function fetchIslandChannel(guild, ownerId) {
  const id = economy.getIslandChannel(ownerId);
  if (!id || !guild) return null;
  try {
    const ch = guild.channels.cache.get(id) || (await guild.channels.fetch(id));
    return ch || null;
  } catch {
    economy.clearIslandChannel(ownerId);
    return null;
  }
}

// Ensure the owner has a channel; (re)create it if missing. Used after buying
// and as a self-heal when running !island.
async function ensureIslandChannel(message) {
  const ownerId = message.author.id;
  const existing = await fetchIslandChannel(message.guild, ownerId);
  if (existing) return { ok: true, channel: existing, created: false };
  const member = message.member || (message.guild ? await message.guild.members.fetch(ownerId).catch(() => null) : null);
  const res = await createIslandChannel(message.guild, ownerId, member, message.author);
  if (!res.ok) return res;
  return { ok: true, channel: res.channel, created: true };
}

async function handleIsland(message, args) {
  if (!message.guild) return message.reply("\uD83C\uDFDD\uFE0F islands only work inside the server, not in DMs.");
  const ownerId = message.author.id;
  if (!economy.ownsHouse(ownerId, "island")) {
    return message.reply(`\uD83C\uDFDD\uFE0F you don't own a **Private Island**. Buy one with \`${PREFIX}house buy island\` (${money(10000000)}).`);
  }

  const sub = (args[0] || "").toLowerCase();

  // No subcommand → show (and self-heal) the island.
  if (!sub || sub === "info" || sub === "show") {
    const res = await ensureIslandChannel(message);
    if (!res.ok) {
      if (res.reason === "no_guild") return message.reply("run this in the server.");
      return message.reply("\u26A0\uFE0F I couldn't access your island channel \u2014 make sure I have **Manage Channels** permission and that the category still exists.");
    }
    const note = res.created ? " (rebuilt it for you)" : "";
    return message.reply(
      `\uD83C\uDFDD\uFE0F your private island is <#${res.channel.id}>${note}.\n` +
        `\u2022 \`${PREFIX}island rename <new name>\`\n` +
        `\u2022 \`${PREFIX}island perms give @user\` \u2014 let someone in\n` +
        `\u2022 \`${PREFIX}island perms remove @user\` \u2014 kick them out\n` +
        `it's locked to you (and admins) by default.`,
      { allowedMentions: { repliedUser: false } }
    );
  }

  if (sub === "rename") {
    const newNameRaw = args.slice(1).join(" ").trim();
    if (!newNameRaw) return message.reply(`usage: \`${PREFIX}island rename <new name>\``);
    const slug = slugify(newNameRaw);
    if (!slug) return message.reply("that name has no usable characters \u2014 try letters/numbers.");
    const res = await ensureIslandChannel(message);
    if (!res.ok) return message.reply("\u26A0\uFE0F couldn't access your island channel (do I have **Manage Channels**?).");
    try {
      await res.channel.setName(slug, `Island renamed by ${message.author.username}`);
      return message.reply(`\uD83C\uDFDD\uFE0F renamed your island to <#${res.channel.id}>.`, { allowedMentions: { repliedUser: false } });
    } catch (err) {
      return message.reply("\u26A0\uFE0F couldn't rename it \u2014 Discord limits renames to twice per 10 min. Try again shortly.");
    }
  }

  if (sub === "perms" || sub === "perm") {
    const action = (args[1] || "").toLowerCase();
    const target = h.firstMentionUser(message);
    if (action !== "give" && action !== "remove" && action !== "add" && action !== "kick") {
      return message.reply(`usage: \`${PREFIX}island perms give @user\` or \`${PREFIX}island perms remove @user\``);
    }
    if (!target) return message.reply(`mention who: \`${PREFIX}island perms ${action} @user\``);
    const res = await ensureIslandChannel(message);
    if (!res.ok) return message.reply("\u26A0\uFE0F couldn't access your island channel (do I have **Manage Channels**?).");
    const giving = action === "give" || action === "add";
    try {
      if (giving) {
        await res.channel.permissionOverwrites.edit(target.id, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
        });
        return message.reply(`\uD83C\uDFDD\uFE0F gave <@${target.id}> access to your island.`, { allowedMentions: { users: [] } });
      } else {
        if (target.id === ownerId) return message.reply("you can't remove yourself from your own island.");
        await res.channel.permissionOverwrites.delete(target.id, `Island access removed by ${message.author.username}`);
        return message.reply(`\uD83C\uDFDD\uFE0F removed <@${target.id}> from your island.`, { allowedMentions: { users: [] } });
      }
    } catch (err) {
      return message.reply("\u26A0\uFE0F couldn't update permissions (do I have **Manage Channels**?).");
    }
  }

  return message.reply(`usage: \`${PREFIX}island\` \u00b7 \`${PREFIX}island rename <name>\` \u00b7 \`${PREFIX}island perms give|remove @user\``);
}

module.exports = {
  handleIsland,
  createIslandChannel,
  ensureIslandChannel,
  fetchIslandChannel,
  ISLAND_CATEGORY_ID,
  slugify,
};
