// Car racing system: garage, lootboxes, Bookface marketplace, AI races and
// 1v1 player wagers. Command handlers are wired up in commands.js.
//
// Balance notes (per owner spec):
//  - AI races have a 60s cooldown and pay only the player's own placement.
//  - Bots are competitive: up to 2 rivals scale near your car's Overall, the
//    rest lean uncommon, but bots are never Legendary/Mythical so top-tier
//    cars still usually win.
//  - Prizes were toned down from the original spec.
//  - Every car has a BASE 10% explode chance per race, reduced by Reliability
//    down to ~3% at 100 Reliability. Applies to AI races AND wagers.

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
} = require("discord.js");
const economy = require("./economy");
const cars = require("./cars");
const h = require("./gamehelpers");

const PREFIX = h.PREFIX;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TRACK = 22;
const CAR = "\uD83C\uDFCE";    // racing car (player)
const BOT_CAR = "\uD83D\uDE97"; // car (bot)
const FLAG = "\uD83C\uDFC1";
const BOOM = "\uD83D\uDCA5";
const TROPHY = "\uD83C\uDFC6";
const SKULL = "\uD83D\uDC80";

const BOT_NAMES = [
  "Chad", "Brad", "Kyle", "Dale", "Hank", "Moe", "Vito", "Rusty", "Turbo",
  "Gunther", "Sven", "Lars", "Dmitri", "Hans", "Klaus", "Bruno", "Rocco",
  "Axel", "Duke", "Boomer", "Reggie", "Sal",
];

// Base 10% explosion, reduced by reliability toward ~3% at 100.
function explodeChance(reliability) {
  const c = 0.1 - 0.07 * ((reliability || 0) / 100);
  return Math.max(0.03, Math.min(0.1, c));
}
function rollExplode(car) {
  return Math.random() < explodeChance(car.reliability);
}

function bar(v) {
  const seg = Math.max(0, Math.min(10, Math.round((v || 0) / 10)));
  return "\u2588".repeat(seg) + "\u2591".repeat(10 - seg);
}
function typeLabel(t) {
  return (cars.TYPES[t] && cars.TYPES[t].label) || t;
}
function rDot(car) {
  return cars.RARITY[car.rarity].emoji;
}
function rTag(car) {
  const r = cars.RARITY[car.rarity];
  return `${r.emoji} ${r.label}`;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function typeListLines() {
  return cars.TYPE_ORDER.map((t) => {
    const m = cars.TYPES[t];
    return `\`${t}\` \u2014 box ${h.money(m.lootbox)} \u00b7 prizes ${economy.fmt(m.prizes[0])}/${economy.fmt(m.prizes[1])}/${economy.fmt(m.prizes[2])}`;
  }).join("\n");
}

function carEmbed(car, title) {
  const r = cars.RARITY[car.rarity];
  return new EmbedBuilder()
    .setColor(r.color)
    .setTitle(title || `${CAR} ${car.name}`)
    .setDescription(`${rTag(car)} \u00b7 **${typeLabel(car.type)}**`)
    .addFields(
      { name: "Horsepower", value: `${bar(car.hp)} ${car.hp}` },
      { name: "Handling", value: `${bar(car.handling)} ${car.handling}` },
      { name: "Reliability", value: `${bar(car.reliability)} ${car.reliability}` },
      { name: "Overall", value: `**${car.overall}** / 100`, inline: true },
      { name: "Value", value: h.money(car.price), inline: true },
    );
}

// Resolve a 1-based garage index to an owned car.
function resolveOwned(userId, token) {
  const owned = economy.listCars(userId);
  if (!owned.length) return { error: `you don't own any cars yet. Open a lootbox: \`${PREFIX}lootbox open <type>\`` };
  const n = parseInt(token, 10);
  if (!Number.isInteger(n) || n < 1 || n > owned.length) {
    return { error: `pick a car number between 1 and ${owned.length} (see \`${PREFIX}cars\`)` };
  }
  return { owned: owned[n - 1], list: owned };
}

// ── !cars ──────────────────────────────────────────────
function cmdCars(message) {
  const owned = economy.listCars(message.author.id);
  if (!owned.length) {
    return message.reply(`${CAR} your garage is empty. Open a lootbox with \`${PREFIX}lootbox open <type>\`\n\n**Types**\n${typeListLines()}`);
  }
  const order = cars.TYPE_ORDER;
  const sorted = owned
    .map((o, idx) => ({ o, idx }))
    .sort((a, b) => order.indexOf(a.o.car.type) - order.indexOf(b.o.car.type) || b.o.car.overall - a.o.car.overall);
  const lines = sorted.map(({ o, idx }) => {
    const c = o.car;
    return `\`${String(idx + 1).padStart(2)}\` ${rDot(c)} **${c.name}** \u00b7 ${typeLabel(c.type)} \u00b7 OVR **${c.overall}**${o.selected ? " \u2705" : ""}`;
  });
  const embed = new EmbedBuilder()
    .setColor(0x2c2f33)
    .setTitle(`${CAR} ${message.author.username}'s Garage`)
    .setDescription(lines.slice(0, economy.MAX_CARS).join("\n") + (owned.length > economy.MAX_CARS ? `\n\n\u26A0\uFE0F showing ${economy.MAX_CARS}/${owned.length} \u2014 over the ${economy.MAX_CARS}-car cap, sell some with ${PREFIX}sell <#> or ${PREFIX}sell <rarity>` : ""))
    .setFooter({ text: `${owned.length}/${economy.MAX_CARS} cars \u00b7 ${PREFIX}car select <#> \u00b7 ${PREFIX}sell <#> \u00b7 ${PREFIX}sell <rarity>` });
  return message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
}

// ── !car [select <#> | <#>] ────────────────────────────
function cmdCar(message, args) {
  const sub = (args[0] || "").toLowerCase();
  if (sub === "select" || sub === "use" || sub === "equip") {
    const res = resolveOwned(message.author.id, args[1]);
    if (res.error) return message.reply(res.error);
    const sel = economy.selectCar(message.author.id, res.owned.iid);
    if (!sel.ok) return message.reply("couldn't select that car.");
    return message.reply({ content: `\u2705 selected **${sel.car.name}** (${typeLabel(sel.car.type)}, OVR ${sel.car.overall}) as your racer.`, allowedMentions: { repliedUser: false } });
  }
  if (sub === "sell") {
    return cmdSell(message, args.slice(1));
  }
  let target;
  if (args[0]) {
    const res = resolveOwned(message.author.id, args[0]);
    if (res.error) return message.reply(res.error);
    target = res.owned;
  } else {
    target = economy.getSelectedCar(message.author.id);
    if (!target) return message.reply(`you have no car selected. \`${PREFIX}car select <#>\` (see \`${PREFIX}cars\`)`);
  }
  return message.reply({ embeds: [carEmbed(target.car)], allowedMentions: { repliedUser: false } });
}

// ── !sell <#> / !car sell <#> — sell a car straight back for its full value ──
function cmdSell(message, args) {
  const id = message.author.id;
  const owned = economy.listCars(id);
  if (!owned.length) return message.reply(`you don't own any cars yet \u2014 open a lootbox with ${PREFIX}lootbox open <type>`);
  const token = (args[0] || "").toLowerCase();

  // Mass sell: !sell all  or  !sell <rarity>
  if (token === "all" || cars.RARITY[token]) {
    const match = token === "all" ? owned : owned.filter((o) => o.car.rarity === token);
    if (!match.length) return message.reply(`you don't own any ${cars.RARITY[token].label} cars.`);
    let total = 0, n = 0;
    for (const o of match) {
      if (economy.destroyCar(id, o.iid)) { total += o.car.price; n++; }
    }
    const wallet = economy.addWallet(id, total);
    const what = token === "all" ? "your entire garage" : `all ${cars.RARITY[token].emoji} ${cars.RARITY[token].label} cars`;
    return message.reply({ content: `\uD83D\uDCB8 sold ${what} \u2014 **${n}** car(s) for ${h.money(total)}. Wallet: ${h.money(wallet)}.`, allowedMentions: { repliedUser: false } });
  }

  // Single sell by garage number
  const res = resolveOwned(id, args[0]);
  if (res.error) return message.reply(res.error);
  const car = res.owned.car;
  const removed = economy.destroyCar(id, res.owned.iid);
  if (!removed) return message.reply("couldn't sell that car.");
  const wallet = economy.addWallet(id, car.price);
  return message.reply({ content: `\uD83D\uDCB8 sold **${car.name}** (${typeLabel(car.type)}, OVR ${car.overall}) for ${h.money(car.price)}. Wallet: ${h.money(wallet)}.`, allowedMentions: { repliedUser: false } });
}

// ── !lootbox [open <type> [count]] ─────────────────────
async function cmdLootbox(message, args) {
  const sub = (args[0] || "").toLowerCase();
  if (sub !== "open" && sub !== "buy") {
    const embed = new EmbedBuilder()
      .setColor(0xf1c40f)
      .setTitle(`${FLAG} Lootboxes`)
      .setDescription(
        `Open a box to unbox a random car of that tier.\n\n${typeListLines()}\n\n**Unbox odds:** ${cars.RARITY_ORDER.map((r) => `${cars.RARITY[r].emoji} ${cars.RARITY[r].unbox}%`).join(" \u00b7 ")}\n\nUsage: \`${PREFIX}lootbox open <type> [count]\` (up to 10)`,
      );
    return message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
  }
  const type = cars.normalizeType(args[1]);
  if (!type) return message.reply(`unknown type. Pick one of: ${cars.TYPE_ORDER.map((t) => "`" + t + "`").join(", ")}`);
  let count = parseInt(args[2], 10);
  if (!Number.isInteger(count) || count < 1) count = 1;
  count = Math.min(10, count);
  const id = message.author.id;
  if (!h.lock(id)) return message.reply("\u23F3 finish your current action first.");
  try {
    const res = economy.openLootbox(id, type, count);
    if (!res.ok) {
      if (res.reason === "full") return message.reply(`\uD83D\uDE97 your garage is full (${res.max}/${res.max}) \u2014 sell cars first: ${PREFIX}sell <#> or ${PREFIX}sell <rarity>.`);
      if (res.reason === "insufficient") return message.reply(`you need ${h.money(res.cost)} for ${count}x ${typeLabel(type)} lootbox \u2014 you have ${h.money(res.have)}.`);
      return message.reply("couldn't open that lootbox.");
    }
    count = res.results.length;
    const waitMsg = await message.reply(`${FLAG} opening **${count}x ${typeLabel(type)}** lootbox...`);
    await sleep(900);
    const lines = res.results
      .map((x) => `${rDot(x.car)} **${x.car.name}** \u00b7 ${cars.RARITY[x.car.rarity].label} \u00b7 OVR **${x.car.overall}** \u00b7 ${h.money(x.car.price)}`)
      .join("\n");
    const best = res.results.reduce((a, b) => (cars.RARITY_ORDER.indexOf(b.car.rarity) > cars.RARITY_ORDER.indexOf(a.car.rarity) ? b : a));
    const embed = new EmbedBuilder()
      .setColor(cars.RARITY[best.car.rarity].color)
      .setTitle(`${FLAG} ${typeLabel(type)} Lootbox \u00d7${count}`)
      .setDescription(lines)
      .setFooter({ text: `-${economy.fmt(res.cost)} \u00b7 ${PREFIX}cars to view your garage` });
    await waitMsg.edit({ content: "", embeds: [embed] });
  } finally {
    h.unlock(id);
  }
}

// ── !bookface [browse | sell <#> <price> | buy <id> | unlist <id> | mine] ──
async function cmdBookface(message, args) {
  const sub = (args[0] || "browse").toLowerCase();
  const id = message.author.id;

  if (sub === "sell" || sub === "list") {
    const res = resolveOwned(id, args[1]);
    if (res.error) return message.reply(res.error);
    const price = h.parseAmount(args[2], res.owned.car.price);
    if (!Number.isFinite(price) || price <= 0) return message.reply(`give a real price, e.g. \`${PREFIX}bookface sell ${args[1]} 5m\``);
    const r = economy.listCarForSale(id, res.owned.iid, price);
    if (!r.ok) {
      if (r.reason === "too_high") return message.reply("that price is too high.");
      if (r.reason === "not_owned") return message.reply("you don't own that car.");
      return message.reply("couldn't list that car.");
    }
    return message.reply({ content: `\uD83D\uDCC4 listed **${r.car.name}** on Bookface for ${h.money(r.price)} \u2014 listing \`${r.listingId}\`. Others buy it with \`${PREFIX}bookface buy ${r.listingId}\`.`, allowedMentions: { repliedUser: false } });
  }

  if (sub === "buy") {
    const listingId = (args[1] || "").toUpperCase();
    const r = economy.buyListing(id, listingId);
    if (!r.ok) {
      if (r.reason === "not_found") return message.reply("that listing doesn't exist (it may have sold).");
      if (r.reason === "own") return message.reply(`that's your own listing. Cancel it with \`${PREFIX}bookface unlist ${listingId}\`.`);
      if (r.reason === "insufficient") return message.reply(`you need ${h.money(r.price)} but only have ${h.money(r.have)}.`);
      return message.reply("couldn't buy that listing.");
    }
    return message.reply({ content: `\u2705 bought **${r.car.name}** (${typeLabel(r.car.type)}, OVR ${r.car.overall}) for ${h.money(r.price)}. It's in your garage \u2014 \`${PREFIX}car select\` to race it.`, allowedMentions: { repliedUser: false } });
  }

  if (sub === "unlist" || sub === "cancel") {
    const listingId = (args[1] || "").toUpperCase();
    const r = economy.unlistCar(id, listingId);
    if (!r.ok) {
      if (r.reason === "not_yours") return message.reply("that's not your listing.");
      return message.reply("that listing doesn't exist.");
    }
    return message.reply({ content: `\u21A9\uFE0F unlisted **${r.car.name}** \u2014 back in your garage.`, allowedMentions: { repliedUser: false } });
  }

  if (sub === "mine") {
    const mine = economy.getUserListings(id);
    if (!mine.length) return message.reply("you have no active Bookface listings.");
    const lines = mine.map((l) => `\`${l.id}\` ${rDot(l.car)} **${l.car.name}** \u00b7 ${typeLabel(l.car.type)} \u00b7 OVR ${l.car.overall} \u2014 ${h.money(l.price)}`).join("\n");
    return message.reply({ embeds: [new EmbedBuilder().setColor(0x3498db).setTitle("\uD83D\uDCC4 Your Bookface listings").setDescription(lines)], allowedMentions: { repliedUser: false } });
  }

  // browse
  const listings = economy.getListings();
  if (!listings.length) return message.reply(`\uD83D\uDCC4 Bookface is empty. List a car with \`${PREFIX}bookface sell <#> <price>\`.`);
  const lines = listings.slice(0, 25).map((l) => `\`${l.id}\` ${rDot(l.car)} **${l.car.name}** \u00b7 ${typeLabel(l.car.type)} \u00b7 OVR ${l.car.overall} \u2014 ${h.money(l.price)}`).join("\n");
  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle("\uD83D\uDCC4 Bookface Marketplace")
    .setDescription(lines)
    .setFooter({ text: `${listings.length} listing(s) \u00b7 ${PREFIX}bookface buy <id> \u00b7 ${PREFIX}bookface sell <#> <price>` });
  return message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
}

// Build 10 AI opponents. Up to 2 are competitive rivals (rare, scaled near the
// player's Overall); the rest lean uncommon. Never legendary/mythical.
function buildBots(typeKey, playerOverall) {
  const rares = cars.listTypeRarity(typeKey, "rare");
  const unc = cars.listTypeRarity(typeKey, "uncommon");
  const com = cars.listTypeRarity(typeKey, "common");
  const bots = [];
  const numGood = 1 + Math.floor(Math.random() * 2);
  for (let i = 0; i < numGood && rares.length; i++) {
    let cand = rares.filter((c) => c.overall <= playerOverall + 4);
    if (!cand.length) cand = rares;
    bots.push(pickRandom(cand));
  }
  while (bots.length < 10) {
    const useUnc = Math.random() < 0.6 && unc.length;
    const arr = useUnc ? unc : (com.length ? com : (unc.length ? unc : rares));
    if (!arr || !arr.length) break;
    bots.push(pickRandom(arr));
  }
  return bots;
}

// ── AI race ────────────────────────────────────────────
async function runAiRace(message, typeKey, sel) {
  const player = { name: "You", car: sel.car, isPlayer: true, pos: 0 };
  const botCars = buildBots(typeKey, sel.car.overall);
  const names = shuffle(BOT_NAMES.slice());
  const bots = botCars.map((c, i) => ({ name: names[i % names.length], car: c, isPlayer: false, pos: 0 }));
  const racers = [player].concat(bots);
  racers.forEach((r) => { r.score = r.car.overall + (Math.random() * 2 - 1) * 3; });

  const playerExploded = rollExplode(sel.car);

  const scores = racers.map((r) => r.score);
  const minS = Math.min.apply(null, scores), maxS = Math.max.apply(null, scores);
  const speed = (r) => 0.9 + ((r.score - minS) / ((maxS - minS) || 1)) * 1.7;

  const render = () => {
    const lanes = racers.map((r) => {
      const done = Math.min(TRACK, Math.floor(r.pos));
      const lane = "\u2014".repeat(Math.max(0, TRACK - done)) + (r.isPlayer ? CAR : BOT_CAR);
      const who = r.isPlayer ? `**You** \u00b7 ${r.car.name}` : `${r.name} \u00b7 ${r.car.name}`;
      return `${lane}${FLAG} ${who}`;
    });
    return `${FLAG} **${typeLabel(typeKey)} Race** \u2014 your **${sel.car.name}** (OVR ${sel.car.overall})\n\n${lanes.join("\n")}`;
  };

  const msg = await message.reply(render());
  let frame = 0, finished = false;
  while (!finished && frame < 12) {
    await sleep(1100);
    racers.forEach((r) => { r.pos += speed(r) * (0.7 + Math.random() * 0.6); });
    frame++;
    if (racers.some((r) => r.pos >= TRACK)) finished = true;
    await msg.edit(render()).catch(() => {});
  }

  if (playerExploded) player.pos = -1; // DNF, drops out of the standings
  const standings = racers.slice().sort((a, b) => (b.pos - a.pos) || (b.score - a.score));
  const playerRank = standings.findIndex((r) => r.isPlayer) + 1;
  const meta = cars.TYPES[typeKey];

  const medals = ["\uD83E\uDD47", "\uD83E\uDD48", "\uD83E\uDD49"];
  const resultLines = standings.slice(0, 5).map((r, i) => {
    const tag = medals[i] || `\`#${i + 1}\``;
    return `${tag} ${r.isPlayer ? "**You**" : r.name} \u00b7 ${r.car.name} (OVR ${r.car.overall})`;
  });

  let color, footer;
  if (playerExploded) {
    economy.destroyCar(message.author.id, sel.iid);
    color = 0xe74c3c;
    footer = `${BOOM} your ${sel.car.name} blew up mid-race and is GONE \u2014 no payout.`;
  } else if (playerRank <= 3) {
    const prize = meta.prizes[playerRank - 1];
    economy.addWallet(message.author.id, prize);
    color = 0x2ecc71;
    footer = `${TROPHY} you placed #${playerRank} \u2014 +${economy.fmt(prize)} ${h.CUR}`;
  } else {
    color = 0x95a5a6;
    footer = `you placed #${playerRank}. No podium, no payout \u2014 better luck next time.`;
  }

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${FLAG} ${typeLabel(typeKey)} Race \u2014 Results`)
    .setDescription(resultLines.join("\n"))
    .setFooter({ text: footer });
  await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
}

// ── 1v1 wager race ─────────────────────────────────────
async function runWager(message, args) {
  const challenger = message.author;
  const target = h.firstMentionUser(message);
  if (!target) return message.reply(`mention who you want to race: \`${PREFIX}race wager @user <amount>\``);
  if (target.id === challenger.id) return message.reply("you can't wager against yourself.");
  if (target.bot) return message.reply("you can't wager against a bot.");

  const cSel = economy.getSelectedCar(challenger.id);
  if (!cSel) return message.reply(`you have no car selected. \`${PREFIX}car select <#>\` first.`);
  const tSel = economy.getSelectedCar(target.id);
  if (!tSel) return message.reply(`**${target.username}** has no car selected, so they can't race.`);
  if (cSel.car.type !== tSel.car.type) return message.reply(`both racers must use the **same car type**. Yours: ${typeLabel(cSel.car.type)}, theirs: ${typeLabel(tSel.car.type)}.`);

  const amtArg = args.slice(1).find((a) => !a.startsWith("<@") && a.toLowerCase() !== "wager");
  const cUser = economy.getUser(challenger.id);
  const amount = h.parseAmount(amtArg, cUser.wallet);
  if (!Number.isFinite(amount) || amount <= 0) return message.reply(`give a real wager amount, e.g. \`${PREFIX}race wager @user 10000000\` (or \`all\`).`);
  if (amount > cUser.wallet) return message.reply(`you only have ${h.money(cUser.wallet)}.`);
  const tUser = economy.getUser(target.id);
  if (tUser.wallet < amount) return message.reply(`**${target.username}** only has ${h.money(tUser.wallet)} \u2014 they can't match ${h.money(amount)}.`);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("race_accept").setLabel("Accept").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("race_deny").setLabel("Deny").setStyle(ButtonStyle.Danger),
  );
  const promptEmbed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(`${FLAG} Race Wager Challenge`)
    .setDescription(`<@${challenger.id}> challenges <@${target.id}> to a **${typeLabel(cSel.car.type)}** race for ${h.money(amount)}!\n\n**${challenger.username}:** ${cSel.car.name} (OVR ${cSel.car.overall})\n**${target.username}:** ${tSel.car.name} (OVR ${tSel.car.overall})\n\n<@${target.id}>, accept within 60s.`);
  const prompt = await message.reply({ content: `<@${target.id}>`, embeds: [promptEmbed], components: [row] });

  let collected;
  try {
    collected = await prompt.awaitMessageComponent({
      componentType: ComponentType.Button,
      time: 60000,
      filter: (i) => i.user.id === target.id && (i.customId === "race_accept" || i.customId === "race_deny"),
    });
  } catch (e) {
    await prompt.edit({ content: "\u231B challenge expired \u2014 no response.", embeds: [], components: [] }).catch(() => {});
    return;
  }
  if (collected.customId === "race_deny") {
    await collected.update({ content: `\u274C <@${target.id}> declined the race.`, embeds: [], components: [] }).catch(() => {});
    return;
  }
  await collected.update({ content: `${FLAG} challenge accepted! starting race...`, embeds: [], components: [] }).catch(() => {});

  if (!h.lock(challenger.id)) { await message.channel.send("you're busy with another action."); return; }
  if (!h.lock(target.id)) { h.unlock(challenger.id); await message.channel.send(`**${target.username}** is busy with another action.`); return; }
  try {
    const c2 = economy.getSelectedCar(challenger.id);
    const t2 = economy.getSelectedCar(target.id);
    if (!c2 || !t2) { await message.channel.send("a racer no longer has a car selected \u2014 race cancelled."); return; }
    if (c2.car.type !== t2.car.type) { await message.channel.send("car types no longer match \u2014 race cancelled."); return; }
    const cu = economy.getUser(challenger.id), tu = economy.getUser(target.id);
    if (cu.wallet < amount || tu.wallet < amount) { await message.channel.send("a racer can no longer cover the wager \u2014 race cancelled."); return; }
    economy.addWallet(challenger.id, -amount);
    economy.addWallet(target.id, -amount);
    await runWagerRace(message, { challenger, target, cSel: c2, tSel: t2, amount });
  } finally {
    h.unlock(challenger.id);
    h.unlock(target.id);
  }
}

async function runWagerRace(message, ctx) {
  const { challenger, target, cSel, tSel, amount } = ctx;
  const A = { id: challenger.id, name: challenger.username, car: cSel.car, iid: cSel.iid, pos: 0 };
  const B = { id: target.id, name: target.username, car: tSel.car, iid: tSel.iid, pos: 0 };
  const aExpl = rollExplode(A.car);
  const bExpl = rollExplode(B.car);
  A.score = A.car.overall + (Math.random() * 2 - 1) * 3;
  B.score = B.car.overall + (Math.random() * 2 - 1) * 3;
  const minS = Math.min(A.score, B.score), maxS = Math.max(A.score, B.score);
  const speed = (r) => 1.0 + ((r.score - minS) / ((maxS - minS) || 1)) * 1.6;

  const render = () => {
    const lane = (r) => {
      const done = Math.min(TRACK, Math.floor(r.pos));
      return `${"\u2014".repeat(Math.max(0, TRACK - done))}${CAR}${FLAG} **${r.name}** \u00b7 ${r.car.name}`;
    };
    return `${FLAG} **Wager Race** \u2014 ${typeLabel(A.car.type)} \u00b7 pot ${h.money(amount * 2)}\n\n${lane(A)}\n${lane(B)}`;
  };

  const msg = await message.channel.send(render());
  let frame = 0, finished = false;
  while (!finished && frame < 12) {
    await sleep(1100);
    A.pos += speed(A) * (0.7 + Math.random() * 0.6);
    B.pos += speed(B) * (0.7 + Math.random() * 0.6);
    frame++;
    if (A.pos >= TRACK || B.pos >= TRACK) finished = true;
    await msg.edit(render()).catch(() => {});
  }

  let winner = null, draw = false;
  const destroyed = [];
  if (aExpl && bExpl) { draw = true; destroyed.push(A, B); }
  else if (aExpl) { winner = B; destroyed.push(A); }
  else if (bExpl) { winner = A; destroyed.push(B); }
  else {
    const diff = Math.abs(A.car.overall - B.car.overall);
    if (diff <= 5) winner = Math.random() < 0.5 ? A : B;
    else winner = A.car.overall > B.car.overall ? A : B;
  }
  for (const d of destroyed) economy.destroyCar(d.id, d.iid);

  let color, title, desc;
  if (draw) {
    economy.addWallet(A.id, amount);
    economy.addWallet(B.id, amount);
    color = 0xe74c3c;
    title = `${BOOM} Double KO!`;
    desc = `Both cars exploded! The ${h.money(amount)} stake is refunded to each racer.\n${BOOM} **${A.car.name}** and **${B.car.name}** are GONE.`;
  } else {
    const loser = winner === A ? B : A;
    economy.addWallet(winner.id, amount * 2);
    color = 0x2ecc71;
    title = `${TROPHY} ${winner.name} wins!`;
    const boom = destroyed.length ? `\n${BOOM} **${loser.car.name}** exploded and is GONE.` : "";
    desc = `<@${winner.id}> takes the pot of **${h.money(amount * 2)}**!\n\n${TROPHY} ${winner.name} \u2014 ${winner.car.name} (OVR ${winner.car.overall})\n${SKULL} ${loser.name} \u2014 ${loser.car.name} (OVR ${loser.car.overall})${boom}`;
  }
  await message.channel.send({ embeds: [new EmbedBuilder().setColor(color).setTitle(title).setDescription(desc)] });
}

// ── !race [<type> | wager @user <amount>] ──────────────
async function cmdRace(message, args) {
  const sub = (args[0] || "").toLowerCase();
  if (!args.length) {
    const sel = economy.getSelectedCar(message.author.id);
    const selLine = sel
      ? `Your racer: ${rDot(sel.car)} **${sel.car.name}** (${typeLabel(sel.car.type)}, OVR ${sel.car.overall})`
      : `You have no car selected. \`${PREFIX}car select <#>\``;
    const embed = new EmbedBuilder()
      .setColor(0xe67e22)
      .setTitle(`${FLAG} Racing`)
      .setDescription(`${selLine}\n\n**Race the AI:** \`${PREFIX}race <type>\` \u2014 vs 10 bots, top 3 paid, 60s cooldown\n**Wager a player:** \`${PREFIX}race wager @user <amount>\` \u2014 same car type, winner takes all\n\n${typeListLines()}\n\n${BOOM} every car has a base **10%** explode chance per race \u2014 high **Reliability** cuts that to as low as ~3%.`);
    return message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
  }
  if (sub === "wager" || sub === "challenge" || sub === "vs" || sub === "1v1") {
    return runWager(message, args);
  }
  const typeKey = cars.normalizeType(args.join(" "));
  if (!typeKey) return message.reply(`unknown race type. Pick one of: ${cars.TYPE_ORDER.map((t) => "`" + t + "`").join(", ")}, or \`${PREFIX}race wager @user <amount>\`.`);

  const id = message.author.id;
  const cd = economy.raceCooldownRemaining(id);
  if (cd > 0) return message.reply(`\u23F3 slow down! wait **${economy.formatDuration(cd)}** before your next race.`);
  const sel = economy.getSelectedCar(id);
  if (!sel) return message.reply(`you have no car selected. Open a lootbox then \`${PREFIX}car select <#>\`.`);
  if (sel.car.type !== typeKey) return message.reply(`your selected car **${sel.car.name}** is a ${typeLabel(sel.car.type)} \u2014 it can't enter ${typeLabel(typeKey)} races. Select a matching car with \`${PREFIX}car select <#>\`.`);
  if (!h.lock(id)) return message.reply("\u23F3 finish your current action first.");
  economy.markRace(id);
  try {
    await runAiRace(message, typeKey, sel);
  } catch (e) {
    console.error("[race]", e);
    await message.channel.send("something went wrong during the race.").catch(() => {});
  } finally {
    h.unlock(id);
  }
}

module.exports = {
  cmdCars,
  cmdCar,
  cmdSell,
  cmdLootbox,
  cmdBookface,
  cmdRace,
};
