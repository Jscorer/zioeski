// All gambling games. Each export is an async function (message, args).
// Bets are deducted up front; payouts are added back on win.

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} = require("discord.js");

const economy = require("./economy");
const h = require("./gamehelpers");
const { log } = require("./logger");
const slotsGame = require("./slots");
const minesGame = require("./mines");
const dtGame = require("./dragontower");

const { money, validateBet, firstMentionUser, lock, unlock } = h;
const PREFIX = h.PREFIX;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ══ COINFLIP (solo vs house, or PvP with accept) ════════════════════
async function coinflip(message, args) {
  const opponent = firstMentionUser(message);
  const cleanArgs = args.filter((a) => !a.startsWith("<@"));
  const amountArg = cleanArgs[0];

  if (opponent) return coinflipPvp(message, opponent, amountArg);

  const v = validateBet(message.author.id, amountArg);
  if (!v.ok) return message.reply(v.error);
  if (!lock(message.author.id)) return message.reply("finish your current game first");
  try {
    economy.addWallet(message.author.id, -v.amount);
    const win = Math.random() < 0.5;
    if (win) economy.addWallet(message.author.id, v.amount * 2);
    const u = economy.getUser(message.author.id);
    return message.reply(
      `\uD83E\uDE99 **${win ? "heads" : "tails"}** \u2014 you ${win ? `won ${money(v.amount)}` : `lost ${money(v.amount)}`}. wallet: ${money(u.wallet)}`
    );
  } finally {
    unlock(message.author.id);
  }
}

async function coinflipPvp(message, opponent, amountArg) {
  const challenger = message.author;
  if (opponent.id === challenger.id) return message.reply("can't flip against yourself");
  if (opponent.bot) return message.reply("can't challenge a bot");

  const cv = validateBet(challenger.id, amountArg);
  if (!cv.ok) return message.reply(cv.error);
  const ou = economy.getUser(opponent.id);
  if (ou.away) return message.reply(`<@${opponent.id}> is away and can't gamble right now`);
  if (ou.wallet < cv.amount) return message.reply(`<@${opponent.id}> doesn't have ${money(cv.amount)} to match`);

  if (!lock(challenger.id)) return message.reply("finish your current game first");

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("cf-accept").setLabel("Accept").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("cf-decline").setLabel("Decline").setStyle(ButtonStyle.Danger)
  );

  let challengeMsg;
  try {
    challengeMsg = await message.channel.send({
      content: `<@${opponent.id}>, **${challenger.username}** challenges you to a coinflip for ${money(cv.amount)}. accept?`,
      components: [row],
      allowedMentions: { users: [opponent.id] },
    });

    const interaction = await challengeMsg.awaitMessageComponent({
      filter: (i) => i.user.id === opponent.id,
      time: 60_000,
      componentType: ComponentType.Button,
    });

    if (interaction.customId === "cf-decline") {
      await interaction.update({ content: `\u274C <@${opponent.id}> declined the coinflip.`, components: [] });
      return;
    }

    // Re-check funds at accept time (balances may have changed)
    const c2 = economy.getUser(challenger.id);
    const o2 = economy.getUser(opponent.id);
    if (c2.away || o2.away) {
      await interaction.update({ content: "one of you went away \u2014 coinflip cancelled.", components: [] });
      return;
    }
    if (c2.wallet < cv.amount || o2.wallet < cv.amount) {
      await interaction.update({ content: "one of you no longer has the funds. cancelled.", components: [] });
      return;
    }

    economy.addWallet(challenger.id, -cv.amount);
    economy.addWallet(opponent.id, -cv.amount);
    const challengerWins = Math.random() < 0.5;
    const winner = challengerWins ? challenger : opponent;
    economy.addWallet(winner.id, cv.amount * 2);

    await interaction.update({
      content:
        `\uD83E\uDE99 coin landed **${challengerWins ? "heads" : "tails"}** \u2014 **${winner.username}** wins ${money(cv.amount * 2)}!\n` +
        `(${challenger.username} vs ${opponent.username}, ${money(cv.amount)} each)`,
      components: [],
    });
  } catch (e) {
    if (challengeMsg) await challengeMsg.edit({ content: "\u23F1\uFE0F coinflip challenge timed out.", components: [] }).catch(() => {});
  } finally {
    unlock(challenger.id);
  }
}

// ══ DICE (high 4-6 / low 1-3, 2x) ════════════════════════════════
async function dice(message, args) {
  const amountArg = args[0];
  const pick = (args[1] || "").toLowerCase();
  if (!["high", "low", "h", "l"].includes(pick)) {
    return message.reply(`usage: \`${PREFIX}dice <amount> <high|low>\` (high = 4-6, low = 1-3)`);
  }
  const v = validateBet(message.author.id, amountArg);
  if (!v.ok) return message.reply(v.error);
  if (!lock(message.author.id)) return message.reply("finish your current game first");
  try {
    economy.addWallet(message.author.id, -v.amount);
    const roll = 1 + Math.floor(Math.random() * 6);
    const wantHigh = pick.startsWith("h");
    const won = wantHigh ? roll >= 4 : roll <= 3;
    if (won) economy.addWallet(message.author.id, v.amount * 2);
    const u = economy.getUser(message.author.id);
    return message.reply(
      `\uD83C\uDFB2 rolled a **${roll}** \u2014 you picked **${wantHigh ? "high" : "low"}** \u2014 ${won ? `won ${money(v.amount)}` : `lost ${money(v.amount)}`}. wallet: ${money(u.wallet)}`
    );
  } finally {
    unlock(message.author.id);
  }
}

// ══ HIGHER OR LOWER (chain multiplier, buttons) ═════════════════════
async function higherLower(message, args) {
  const v = validateBet(message.author.id, args[0]);
  if (!v.ok) return message.reply(v.error);
  if (!lock(message.author.id)) return message.reply("finish your current game first");

  economy.addWallet(message.author.id, -v.amount);
  let current = h.drawCard();
  let multiplier = 1.0;
  let streak = 0;

  const row = () =>
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("hl-higher").setLabel("\u2B06\uFE0F Higher").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("hl-lower").setLabel("\u2B07\uFE0F Lower").setStyle(ButtonStyle.Primary),
      // Cash out only unlocks once you've made at least one correct guess (round 2+).
      new ButtonBuilder().setCustomId("hl-cashout").setLabel("\uD83D\uDCB0 Cash out").setStyle(ButtonStyle.Secondary).setDisabled(streak < 1)
    );

  const render = (status) => {
    const payout = Math.floor(v.amount * multiplier);
    return (
      `**Higher or Lower** \u2014 bet ${money(v.amount)}\n` +
      `Current card: ${h.cardStr(current)}  (A=1 \u2192 K=13, ties pay)\n` +
      `Streak **${streak}** \u2014 multiplier **${multiplier.toFixed(2)}x** (cash out = ${money(payout)})\n` +
      (status ? `\n${status}` : "will the next card be higher or lower?")
    );
  };

  const reply = await message.reply({ content: render(), components: [row()] });
  try {
    while (true) {
      let i;
      try {
        i = await reply.awaitMessageComponent({
          filter: (x) => x.user.id === message.author.id,
          time: 30_000,
          componentType: ComponentType.Button,
        });
      } catch {
        await reply.edit({ content: render("\u23F1\uFE0F timed out \u2014 you lost your bet."), components: [] });
        break;
      }

      if (i.customId === "hl-cashout") {
        if (streak < 1) {
          // Safety net in case the disabled button is somehow pressed.
          await i.reply({ content: "\u26D4 you can't cash out on the first card \u2014 make at least one correct guess first (cash out unlocks on round 2).", ephemeral: true });
          continue;
        }
        const payout = Math.floor(v.amount * multiplier);
        economy.addWallet(message.author.id, payout);
        const u = economy.getUser(message.author.id);
        await i.update({
          content: `\uD83D\uDCB0 cashed out at **${multiplier.toFixed(2)}x** for ${money(payout)} (profit ${money(payout - v.amount)}). wallet: ${money(u.wallet)}`,
          components: [],
        });
        break;
      }

      const guessHigher = i.customId === "hl-higher";
      const next = h.drawCard();
      const cmp = h.hlValue(next) - h.hlValue(current);
      const correct = cmp === 0 ? true : guessHigher ? cmp > 0 : cmp < 0;

      if (!correct) {
        const u = economy.getUser(message.author.id);
        await i.update({
          content: `\u274C next was ${h.cardStr(next)}. you lost ${money(v.amount)}. wallet: ${money(u.wallet)}`,
          components: [],
        });
        break;
      }

      streak++;
      multiplier = Math.max(multiplier + 0.5, multiplier * 1.7);
      current = next;
      await i.update({ content: render(`\u2705 correct! the card was ${h.cardStr(next)}.`), components: [row()] });
    }
  } finally {
    unlock(message.author.id);
  }
}

// ══ CRASH (rising multiplier, cash out before it busts) ═════════════════
function genCrashPoint() {
  if (Math.random() < 0.03) return 1.0; // 3% instant bust
  const r = Math.random();
  return Math.min(100, Math.max(1.01, 0.99 / (1 - r)));
}

async function crash(message, args) {
  const v = validateBet(message.author.id, args[0]);
  if (!v.ok) return message.reply(v.error);
  if (!lock(message.author.id)) return message.reply("finish your current game first");

  economy.addWallet(message.author.id, -v.amount);
  const crashPoint = genCrashPoint();
  let multiplier = 1.0;
  let cashedOut = false;
  let cashoutMult = 0;

  const row = (disabled) =>
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("crash-cashout")
        .setLabel("\uD83D\uDCB0 Cash out")
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled)
    );

  const reply = await message.reply({
    content: `\uD83D\uDE80 **Crash** \u2014 bet ${money(v.amount)}\nmultiplier: **1.00x**`,
    components: [row(false)],
  });

  const collector = reply.createMessageComponentCollector({
    filter: (i) => i.user.id === message.author.id && i.customId === "crash-cashout",
    componentType: ComponentType.Button,
    time: 60_000,
  });

  collector.on("collect", async (i) => {
    if (cashedOut) return i.deferUpdate().catch(() => {});
    cashedOut = true;
    cashoutMult = multiplier;
    const payout = Math.floor(v.amount * cashoutMult);
    economy.addWallet(message.author.id, payout);
    const u = economy.getUser(message.author.id);
    await i.update({
      content: `\uD83D\uDCB0 cashed out at **${cashoutMult.toFixed(2)}x** \u2014 won ${money(payout)} (profit ${money(payout - v.amount)}). wallet: ${money(u.wallet)}`,
      components: [row(true)],
    });
    collector.stop("cashed");
  });

  try {
    // Rising loop
    while (!cashedOut && multiplier < crashPoint) {
      await sleep(900);
      if (cashedOut) break;
      multiplier = Math.min(crashPoint, +(multiplier * 1.18 + 0.05).toFixed(2));
      if (multiplier >= crashPoint) break;
      await reply.edit({
        content: `\uD83D\uDE80 **Crash** \u2014 bet ${money(v.amount)}\nmultiplier: **${multiplier.toFixed(2)}x**`,
        components: [row(false)],
      }).catch(() => {});
    }

    if (!cashedOut) {
      collector.stop("crashed");
      const u = economy.getUser(message.author.id);
      await reply.edit({
        content: `\uD83D\uDCA5 **CRASHED at ${crashPoint.toFixed(2)}x** \u2014 you lost ${money(v.amount)}. wallet: ${money(u.wallet)}`,
        components: [row(true)],
      }).catch(() => {});
    }
  } finally {
    unlock(message.author.id);
  }
}

// ══ BLACKJACK (vs dealer, Hit/Stand/Double/Split, 2.5x natural) ══════
async function blackjack(message, args) {
  const uid = message.author.id;
  const v = validateBet(uid, args[0]);
  if (!v.ok) return message.reply(v.error);
  if (!lock(uid)) return message.reply("finish your current game first");

  economy.addWallet(uid, -v.amount);
  const dealer = [h.drawCard(), h.drawCard()];
  // Each hand tracks its own cards + bet so split/double settle independently.
  const hands = [{ cards: [h.drawCard(), h.drawCard()], bet: v.amount, done: false, doubled: false }];
  let active = 0;
  let didSplit = false;

  const wallet = () => economy.getUser(uid).wallet;
  const canDouble = (hd) => hd.cards.length === 2 && wallet() >= hd.bet;
  const canSplit = (hd) =>
    !didSplit && hd.cards.length === 2 &&
    h.bjValue(hd.cards[0]) === h.bjValue(hd.cards[1]) && wallet() >= hd.bet;

  const handsBlock = (reveal) => {
    const dealerLine = reveal
      ? `Dealer: ${h.handStr(dealer)}  = **${h.handTotal(dealer)}**`
      : `Dealer shows: ${h.cardStr(dealer[0])} \`??\``;
    const lines = hands.map((hd, idx) => {
      const arrow = hands.length > 1 && idx === active && !reveal ? "\u25B6 " : (hands.length > 1 ? "\u2003" : "");
      const tag = hands.length > 1 ? `Hand ${idx + 1}${hd.doubled ? " (2x)" : ""}: ` : "Your hand: ";
      const betTag = hands.length > 1 || hd.doubled ? `  \u00b7 bet ${money(hd.bet)}` : "";
      return `${arrow}${tag}${h.handStr(hd.cards)}  = **${h.handTotal(hd.cards)}**${betTag}`;
    });
    return `**Blackjack** \u2014 bet ${money(v.amount)}\n${dealerLine}\n${lines.join("\n")}`;
  };

  // Natural blackjack (only possible on the original two-card hand)
  if (h.handTotal(hands[0].cards) === 21) {
    const payout = Math.floor(v.amount * 2.5);
    economy.addWallet(uid, payout);
    const u = economy.getUser(uid);
    unlock(uid);
    return message.reply(
      `**Blackjack!** ${h.handStr(hands[0].cards)} = 21 \uD83C\uDFB0\nnatural \u2014 paid 2.5x = ${money(payout)}. wallet: ${money(u.wallet)}`
    );
  }

  const row = () => {
    const hd = hands[active];
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("bj-hit").setLabel("Hit").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("bj-stand").setLabel("Stand").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("bj-double").setLabel("Double").setStyle(ButtonStyle.Success).setDisabled(!canDouble(hd)),
      new ButtonBuilder().setCustomId("bj-split").setLabel("Split").setStyle(ButtonStyle.Danger).setDisabled(!canSplit(hd))
    );
  };

  const view = () => {
    const hd = hands[active];
    const opts = ["Hit", "Stand"];
    if (canDouble(hd)) opts.push("Double");
    if (canSplit(hd)) opts.push("Split");
    return handsBlock(false) +
      (hands.length > 1 ? `\n\nplaying **Hand ${active + 1}**` : "") +
      `\n${opts.join(" / ")}?`;
  };

  const settleAll = async (target, isInteraction) => {
    while (h.handTotal(dealer) < 17) dealer.push(h.drawCard());
    const dt = h.handTotal(dealer);
    let totalReturn = 0;
    let totalStaked = 0;
    const results = hands.map((hd, idx) => {
      totalStaked += hd.bet;
      const pt = h.handTotal(hd.cards);
      let outcome, ret;
      if (pt > 21) { outcome = "bust \u274C"; ret = 0; }
      else if (dt > 21) { outcome = "dealer bust \u2014 win \u2705"; ret = hd.bet * 2; }
      else if (pt > dt) { outcome = "win \u2705"; ret = hd.bet * 2; }
      else if (pt < dt) { outcome = "lose \u274C"; ret = 0; }
      else { outcome = "push \u2796"; ret = hd.bet; }
      totalReturn += ret;
      const label = hands.length > 1 ? `Hand ${idx + 1}` : "Result";
      return `${label}: ${pt} vs ${dt} \u2014 ${outcome}`;
    });
    if (totalReturn > 0) economy.addWallet(uid, totalReturn);
    const u = economy.getUser(uid);
    const net = totalReturn - totalStaked;
    const content =
      handsBlock(true) + "\n\n" + results.join("\n") +
      `\n\nnet ${net >= 0 ? "+" : "\u2212"}${money(Math.abs(net))}. wallet: ${money(u.wallet)}`;
    if (isInteraction) await target.update({ content, components: [] });
    else await target.edit({ content, components: [] });
  };

  // Advance to the next unfinished hand, or settle if all are done.
  const advance = async (i) => {
    while (active < hands.length && hands[active].done) active++;
    if (active >= hands.length) { await settleAll(i, true); return true; }
    await i.update({ content: view(), components: [row()] });
    return false;
  };

  const reply = await message.reply({ content: view(), components: [row()] });
  try {
    while (true) {
      let i;
      try {
        i = await reply.awaitMessageComponent({
          filter: (x) => x.user.id === uid,
          time: 60_000,
          componentType: ComponentType.Button,
        });
      } catch {
        await settleAll(reply, false);
        break;
      }
      const hd = hands[active];
      if (i.customId === "bj-hit") {
        hd.cards.push(h.drawCard());
        if (h.handTotal(hd.cards) >= 21) {
          hd.done = true;
          if (await advance(i)) break;
        } else {
          await i.update({ content: view(), components: [row()] });
        }
      } else if (i.customId === "bj-stand") {
        hd.done = true;
        if (await advance(i)) break;
      } else if (i.customId === "bj-double") {
        if (!canDouble(hd)) { await i.reply({ content: "\u26D4 can't double this hand right now.", ephemeral: true }); continue; }
        economy.addWallet(uid, -hd.bet);
        hd.bet *= 2;
        hd.doubled = true;
        hd.cards.push(h.drawCard());
        hd.done = true;
        if (await advance(i)) break;
      } else if (i.customId === "bj-split") {
        if (!canSplit(hd)) { await i.reply({ content: "\u26D4 can't split this hand right now.", ephemeral: true }); continue; }
        economy.addWallet(uid, -hd.bet);
        didSplit = true;
        const moved = hd.cards.pop();
        hd.cards.push(h.drawCard());
        hands.splice(active + 1, 0, { cards: [moved, h.drawCard()], bet: hd.bet, done: false, doubled: false });
        await i.update({ content: view(), components: [row()] });
      }
    }
  } finally {
    unlock(uid);
  }
}

// ══ ROULETTE (single 0-36 wheel) ═════════════════════════════════
const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
async function roulette(message, args) {
  const amountArg = args[0];
  const betRaw = (args[1] || "").toLowerCase();
  if (!betRaw) {
    return message.reply(`usage: \`${PREFIX}roulette <amount> <red|black|green|odd|even|0-36>\``);
  }
  const v = validateBet(message.author.id, amountArg);
  if (!v.ok) return message.reply(v.error);

  // Determine bet type + payout multiplier
  let betType = null;
  let numberPick = null;
  let multiplier = 0;
  if (["red", "black"].includes(betRaw)) {
    betType = betRaw;
    multiplier = 2;
  } else if (betRaw === "green") {
    betType = "green";
    multiplier = 36;
  } else if (["odd", "even"].includes(betRaw)) {
    betType = betRaw;
    multiplier = 2;
  } else if (/^\d{1,2}$/.test(betRaw) && +betRaw >= 0 && +betRaw <= 36) {
    betType = "number";
    numberPick = +betRaw;
    multiplier = 36;
  } else {
    return message.reply(`unknown bet. use red, black, green, odd, even, or a number 0-36`);
  }

  if (!lock(message.author.id)) return message.reply("finish your current game first");
  try {
    economy.addWallet(message.author.id, -v.amount);
    const result = Math.floor(Math.random() * 37); // 0-36
    const colour = result === 0 ? "green" : RED_NUMBERS.has(result) ? "red" : "black";

    let won = false;
    if (betType === "red" || betType === "black") won = colour === betType;
    else if (betType === "green") won = result === 0;
    else if (betType === "odd") won = result !== 0 && result % 2 === 1;
    else if (betType === "even") won = result !== 0 && result % 2 === 0;
    else if (betType === "number") won = result === numberPick;

    if (won) economy.addWallet(message.author.id, v.amount * multiplier);
    const u = economy.getUser(message.author.id);
    const emoji = colour === "red" ? "\uD83D\uDD34" : colour === "black" ? "\u26AB" : "\uD83D\uDFE2";
    return message.reply(
      `\uD83C\uDFB0 ball landed on ${emoji} **${result} ${colour}**\n` +
        `${won ? `you won ${money(v.amount * multiplier)} (${multiplier}x)` : `you lost ${money(v.amount)}`}. wallet: ${money(u.wallet)}`
    );
  } finally {
    unlock(message.author.id);
  }
}

// ══ HORSE RACE (pick 1-5, odds-based multipliers, animated) ═════════════
const HORSES = [
  { name: "Hasidic Horse", emoji: "\uD83C\uDFC7", mult: 2 },
  { name: "Netanyahu", emoji: "\uD83C\uDFC7", mult: 2 },
  { name: "Grogan", emoji: "\uD83C\uDFC7", mult: 3 },
  { name: "Horny Horse", emoji: "\uD83C\uDFC7", mult: 5 },
  { name: "Goy Horse", emoji: "\uD83C\uDFC7", mult: 6 },
];
const TRACK = 20;

async function horseRace(message, args) {
  const amountArg = args[0];
  const pickRaw = args[1];
  const pick = parseInt(pickRaw, 10);
  if (!(pick >= 1 && pick <= HORSES.length)) {
    const list = HORSES.map((hh, i) => `**${i + 1}** ${hh.name} (${hh.mult}x)`).join(", ");
    return message.reply(`usage: \`${PREFIX}horserace <amount> <1-${HORSES.length}>\`\nhorses: ${list}`);
  }
  const v = validateBet(message.author.id, amountArg);
  if (!v.ok) return message.reply(v.error);
  if (!lock(message.author.id)) return message.reply("finish your current game first");

  try {
    economy.addWallet(message.author.id, -v.amount);
    const pos = HORSES.map(() => 0);

    const render = () =>
      `\uD83C\uDFC1 **Horse Race** \u2014 you backed **#${pick} ${HORSES[pick - 1].name}** for ${money(v.amount)}\n\n` +
      HORSES.map((hh, i) => {
        const done = Math.min(TRACK, pos[i]);
        const lane = "\u2014".repeat(Math.max(0, TRACK - done)) + hh.emoji;
        return `\`${i + 1}\` |${lane}\`\uD83C\uDFC1\`  ${hh.name}`;
      }).join("\n");

    const reply = await message.reply(render());

    let winner = -1;
    while (winner === -1) {
      await sleep(1100);
      for (let i = 0; i < HORSES.length; i++) pos[i] += 1 + Math.floor(Math.random() * 4);
      let best = -1;
      let leaders = [];
      for (let i = 0; i < HORSES.length; i++) {
        if (pos[i] >= TRACK) {
          if (pos[i] > best) {
            best = pos[i];
            leaders = [i];
          } else if (pos[i] === best) leaders.push(i);
        }
      }
      await reply.edit(render()).catch(() => {});
      if (leaders.length) winner = leaders[Math.floor(Math.random() * leaders.length)];
    }

    const won = winner === pick - 1;
    if (won) economy.addWallet(message.author.id, v.amount * HORSES[winner].mult);
    const u = economy.getUser(message.author.id);
    await reply.edit(
      render() +
        `\n\n\uD83C\uDFC6 **#${winner + 1} ${HORSES[winner].name}** wins!\n` +
        `${won ? `you won ${money(v.amount * HORSES[winner].mult)} (${HORSES[winner].mult}x)` : `you lost ${money(v.amount)}`}. wallet: ${money(u.wallet)}`
    ).catch(() => {});
  } finally {
    unlock(message.author.id);
  }
}

// ══ SLOTS (3-reel, wilds + scatters + free spins, ~97% RTP) ══════════
async function slots(message, args) {
  const v = validateBet(message.author.id, args[0]);
  if (!v.ok) return message.reply(v.error);
  if (!lock(message.author.id)) return message.reply("finish your current game first");
  try {
    economy.addWallet(message.author.id, -v.amount);
    const result = slotsGame.play();
    const e = slotsGame.EMOJI;
    const line = (g) => `[ ${g.map((k) => e[k]).join("  \u2502  ")} ]`;

    // little spin animation
    const reply = await message.reply(
      `\uD83C\uDFB0 **SLOTS** \u2014 bet ${money(v.amount)}\n\n${line(slotsGame.spinGrid())}\n\nspinning\u2026`
    );
    await sleep(650);
    await reply
      .edit(`\uD83C\uDFB0 **SLOTS** \u2014 bet ${money(v.amount)}\n\n${line(slotsGame.spinGrid())}\n\nspinning\u2026`)
      .catch(() => {});
    await sleep(650);

    const payout = Math.floor(v.amount * result.totalMult);
    if (payout > 0) economy.addWallet(message.author.id, payout);
    const u = economy.getUser(message.author.id);

    let body = `\uD83C\uDFB0 **SLOTS** \u2014 bet ${money(v.amount)}\n\n${line(result.grid)}\n`;
    if (result.base.label) body += `\n${result.base.label}`;
    if (result.freeRounds.length) {
      const freeWinMult = result.freeRounds.reduce((a, fr) => a + fr.mult, 0);
      const hits = result.freeRounds.filter((fr) => fr.mult > 0).length;
      body +=
        `\n\uD83C\uDD93 **${result.freeSpinsAwarded} FREE SPINS!** \u2014 ${hits} hit ` +
        `(+${money(Math.floor(v.amount * freeWinMult))}, 2x bonus)`;
    }
    body += "\n\n";
    if (payout > 0) {
      body += `\u2705 **${result.totalMult.toFixed(2)}x** \u2014 won ${money(payout)} (profit ${money(payout - v.amount)}). wallet: ${money(u.wallet)}`;
    } else {
      body += `\u274C no win \u2014 lost ${money(v.amount)}. wallet: ${money(u.wallet)}`;
    }
    await reply.edit(body).catch(() => {});
  } finally {
    unlock(message.author.id);
  }
}

// ══ MINES (pick your mine count — more mines = bigger multiplier) ══════
async function mines(message, args) {
  const amountArg = args[0];
  let mineCount = parseInt(args[1], 10);
  if (!Number.isInteger(mineCount)) mineCount = 3;
  if (mineCount < 1 || mineCount > minesGame.TILES - 1) {
    return message.reply(
      `pick between 1 and ${minesGame.TILES - 1} mines. e.g. \`${PREFIX}mines 500 3\` (more mines = higher multiplier)`
    );
  }
  const v = validateBet(message.author.id, amountArg);
  if (!v.ok) return message.reply(v.error);
  if (!lock(message.author.id)) return message.reply("finish your current game first");

  economy.addWallet(message.author.id, -v.amount);
  const board = minesGame.makeBoard(mineCount);
  const revealed = new Set();
  let ended = false;

  const curMult = () => minesGame.multiplier(mineCount, revealed.size);

  const rows = () => {
    const out = [];
    for (let r = 0; r < 4; r++) {
      const row = new ActionRowBuilder();
      for (let c = 0; c < 5; c++) {
        const idx = r * 5 + c;
        const b = new ButtonBuilder().setCustomId(`m${idx}`);
        if (revealed.has(idx)) {
          b.setStyle(ButtonStyle.Success).setEmoji("\uD83D\uDC8E").setDisabled(true);
        } else if (ended) {
          if (board.has(idx)) b.setStyle(ButtonStyle.Danger).setEmoji("\uD83D\uDCA3").setDisabled(true);
          else b.setStyle(ButtonStyle.Secondary).setEmoji("\u2B1C").setDisabled(true);
        } else {
          b.setStyle(ButtonStyle.Secondary).setEmoji("\u2753").setDisabled(false);
        }
        row.addComponents(b);
      }
      out.push(row);
    }
    out.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("cashout")
          .setStyle(ButtonStyle.Primary)
          .setLabel(`\uD83D\uDCB0 Cash Out (${curMult().toFixed(2)}x)`)
          .setDisabled(ended || revealed.size === 0)
      )
    );
    return out;
  };

  const header = (status) =>
    `\uD83D\uDCA3 **Mines** \u2014 bet ${money(v.amount)} \u2022 **${mineCount}** mines\n` +
    `revealed **${revealed.size}** \u2022 multiplier **${curMult().toFixed(2)}x** \u2022 cash out = ${money(Math.floor(v.amount * curMult()))}\n` +
    (status || "pick a tile \u2014 avoid the mines");

  const reply = await message.reply({ content: header(), components: rows() });
  const collector = reply.createMessageComponentCollector({
    filter: (i) => i.user.id === message.author.id,
    componentType: ComponentType.Button,
    time: 120_000,
  });

  const finish = async (interaction, status, payout) => {
    ended = true;
    if (payout > 0) economy.addWallet(message.author.id, payout);
    const u = economy.getUser(message.author.id);
    const tail = payout > 0 ? `won ${money(payout)} (profit ${money(payout - v.amount)}).` : `lost ${money(v.amount)}.`;
    await interaction.update({ content: header(`${status}\n${tail} wallet: ${money(u.wallet)}`), components: rows() }).catch(() => {});
    collector.stop("done");
  };

  collector.on("collect", async (i) => {
    if (ended) return i.deferUpdate().catch(() => {});
    if (i.customId === "cashout") {
      if (revealed.size === 0) return i.deferUpdate().catch(() => {});
      return finish(i, "\uD83D\uDCB0 cashed out!", Math.floor(v.amount * curMult()));
    }
    const idx = parseInt(i.customId.slice(1), 10);
    if (revealed.has(idx)) return i.deferUpdate().catch(() => {});
    if (board.has(idx)) return finish(i, "\uD83D\uDCA5 BOOM \u2014 you hit a mine!", 0);
    revealed.add(idx);
    if (revealed.size >= minesGame.maxSafe(mineCount)) {
      return finish(i, "\uD83C\uDFC6 cleared the whole board!", Math.floor(v.amount * curMult()));
    }
    await i.update({ content: header("nice \u2014 keep going or cash out"), components: rows() }).catch(() => {});
  });

  collector.on("end", async () => {
    unlock(message.author.id);
    if (ended) return;
    ended = true;
    const payout = revealed.size > 0 ? Math.floor(v.amount * curMult()) : 0;
    if (payout > 0) economy.addWallet(message.author.id, payout);
    const u = economy.getUser(message.author.id);
    const tail = payout > 0 ? `auto cashed out ${money(payout)}` : `lost ${money(v.amount)}`;
    await reply.edit({ content: header(`\u23F1\uFE0F timed out \u2014 ${tail}. wallet: ${money(u.wallet)}`), components: rows() }).catch(() => {});
  });
}

// ══ DRAGON TOWER (climb the tower, pick difficulty) ════════════════
async function dragonTower(message, args) {
  const amountArg = args[0];
  const diff = dtGame.resolveDifficulty(args[1]);
  if (!diff) {
    const list = Object.values(dtGame.DIFFICULTY)
      .map((d) => `${d.label.toLowerCase()} (${d.tiles - d.safe}\uD83D\uDC09/${d.tiles})`)
      .join(", ");
    return message.reply(`usage: \`${PREFIX}dragontower <amount> <difficulty>\`\ndifficulties: ${list}`);
  }
  const v = validateBet(message.author.id, amountArg);
  if (!v.ok) return message.reply(v.error);
  if (!lock(message.author.id)) return message.reply("finish your current game first");

  economy.addWallet(message.author.id, -v.amount);
  const tower = dtGame.makeTower(diff);
  const ROWS = dtGame.ROWS;
  const path = [];
  let level = 0;
  let ended = false;
  let deathRow = -1;
  let deathCol = -1;

  const view = (status) => {
    const lines = [
      `\uD83D\uDC09 **Dragon Tower** \u2014 ${diff.label} \u2022 bet ${money(v.amount)}`,
      `level **${level}/${ROWS}** \u2022 multiplier **${dtGame.multiplier(diff, level).toFixed(2)}x** \u2022 cash out = ${money(Math.floor(v.amount * dtGame.multiplier(diff, level)))}`,
      "",
    ];
    for (let r = ROWS - 1; r >= 0; r--) {
      const cells = [];
      for (let c = 0; c < diff.tiles; c++) {
        if (r < level) {
          cells.push(c === path[r] ? "\uD83E\uDD5A" : "\u2B1B");
        } else if (ended) {
          if (r === deathRow && c === deathCol) cells.push("\uD83D\uDC09");
          else cells.push(tower[r].has(c) ? "\uD83E\uDD5A" : "\uD83D\uDC09");
        } else if (r === level) {
          cells.push("\u2B50");
        } else {
          cells.push("\u2B1C");
        }
      }
      const marker = !ended && r === level ? "\u25B6\uFE0F" : r < level ? "\u2705" : r === deathRow ? "\uD83D\uDCA5" : "\u3000";
      lines.push(`${marker} ${cells.join(" ")}`);
    }
    if (status) {
      lines.push("");
      lines.push(status);
    }
    return lines.join("\n");
  };

  const buttons = () => {
    const rowT = new ActionRowBuilder();
    for (let c = 0; c < diff.tiles; c++) {
      rowT.addComponents(
        new ButtonBuilder().setCustomId(`dt-t${c}`).setStyle(ButtonStyle.Secondary).setLabel(`${c + 1}`).setDisabled(ended)
      );
    }
    const rowC = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("dt-cashout")
        .setStyle(ButtonStyle.Success)
        .setLabel(`\uD83D\uDCB0 Cash Out (${dtGame.multiplier(diff, level).toFixed(2)}x)`)
        .setDisabled(ended || level === 0)
    );
    return [rowT, rowC];
  };

  const reply = await message.reply({ content: view("pick a tile to climb \uD83E\uDD5A = egg, \uD83D\uDC09 = dragon"), components: buttons() });
  try {
    while (true) {
      let i;
      try {
        i = await reply.awaitMessageComponent({
          filter: (x) => x.user.id === message.author.id,
          time: 45_000,
          componentType: ComponentType.Button,
        });
      } catch {
        ended = true;
        const payout = level > 0 ? Math.floor(v.amount * dtGame.multiplier(diff, level)) : 0;
        if (payout > 0) economy.addWallet(message.author.id, payout);
        const u = economy.getUser(message.author.id);
        const tail = payout > 0 ? `auto cashed out ${money(payout)}` : `lost ${money(v.amount)}`;
        await reply.edit({ content: view(`\u23F1\uFE0F timed out \u2014 ${tail}. wallet: ${money(u.wallet)}`), components: buttons() }).catch(() => {});
        break;
      }

      if (i.customId === "dt-cashout") {
        ended = true;
        const payout = Math.floor(v.amount * dtGame.multiplier(diff, level));
        economy.addWallet(message.author.id, payout);
        const u = economy.getUser(message.author.id);
        await i.update({ content: view(`\uD83D\uDCB0 cashed out at **${dtGame.multiplier(diff, level).toFixed(2)}x** \u2014 won ${money(payout)} (profit ${money(payout - v.amount)}). wallet: ${money(u.wallet)}`), components: buttons() }).catch(() => {});
        break;
      }

      const c = parseInt(i.customId.slice(4), 10); // "dt-t<c>"
      if (tower[level].has(c)) {
        path[level] = c;
        level++;
        if (level >= ROWS) {
          ended = true;
          const payout = Math.floor(v.amount * dtGame.multiplier(diff, ROWS));
          economy.addWallet(message.author.id, payout);
          const u = economy.getUser(message.author.id);
          await i.update({ content: view(`\uD83D\uDC51 **YOU REACHED THE TOP!** \u2014 won ${money(payout)} (profit ${money(payout - v.amount)}). wallet: ${money(u.wallet)}`), components: buttons() }).catch(() => {});
          break;
        }
        await i.update({ content: view("\uD83E\uDD5A egg! climb again or cash out"), components: buttons() }).catch(() => {});
      } else {
        ended = true;
        deathRow = level;
        deathCol = c;
        const u = economy.getUser(message.author.id);
        await i.update({ content: view(`\uD83D\uDC09 a dragon got you on level ${level + 1}! lost ${money(v.amount)}. wallet: ${money(u.wallet)}`), components: buttons() }).catch(() => {});
        break;
      }
    }
  } finally {
    unlock(message.author.id);
  }
}

module.exports = {
  coinflip,
  dice,
  higherLower,
  crash,
  blackjack,
  roulette,
  horseRace,
  slots,
  mines,
  dragonTower,
};
