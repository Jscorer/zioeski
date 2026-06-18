// Command dispatcher: economy commands + routes game commands to ./games.
// Exposed as handleCommand(message) -> boolean (true if it was a command).

const { EmbedBuilder } = require("discord.js");
const economy = require("./economy");
const games = require("./games");
const crimes = require("./crimes");
const business = require("./business");
const factory = require("./factory");
const stocktrader = require("./stocktrader");
const racing = require("./racing");
const pets = require("./pets");
const island = require("./island");
const admin = require("./admin");
const h = require("./gamehelpers");
const config = require("./config");
const { log } = require("./logger");

const PREFIX = h.PREFIX;
const EMOJI = h.EMOJI;
const money = h.money;
const { parseAmount, firstMentionUser } = h;

// ── Economy commands ──────────────────────────────────────────
async function cmdBalance(message) {
  const target = firstMentionUser(message) || message.author;
  const u = economy.getUser(target.id);
  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(`${EMOJI} ${target.username}'s balance`)
    .addFields(
      { name: "Wallet", value: money(u.wallet), inline: true },
      { name: "Bank", value: money(u.bank), inline: true },
      { name: "Total", value: money(u.wallet + u.bank), inline: true }
    );
  await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
}

async function cmdDeposit(message, args) {
  const u = economy.getUser(message.author.id);
  if (u.wallet <= 0) return message.reply("your wallet is empty");
  const amt = parseAmount(args[0], u.wallet);
  if (!Number.isFinite(amt) || amt <= 0) return message.reply(`usage: \`${PREFIX}deposit <amount|all>\``);
  const res = economy.deposit(message.author.id, amt);
  if (!res.ok) return message.reply(res.reason);
  return message.reply(`deposited ${money(res.deposited)}. wallet: ${money(res.wallet)} | bank: ${money(res.bank)}`);
}

async function cmdWithdraw(message, args) {
  const u = economy.getUser(message.author.id);
  if (u.bank <= 0) return message.reply("your bank is empty");
  const amt = parseAmount(args[0], u.bank);
  if (!Number.isFinite(amt) || amt <= 0) return message.reply(`usage: \`${PREFIX}withdraw <amount|all>\``);
  const res = economy.withdraw(message.author.id, amt);
  if (!res.ok) return message.reply(res.reason);
  return message.reply(`withdrew ${money(res.withdrawn)}. wallet: ${money(res.wallet)} | bank: ${money(res.bank)}`);
}

async function cmdLoan(message, args) {
  const id = message.author.id;
  const sub = (args[0] || "").toLowerCase();

  if (sub === "pay" || sub === "repay") {
    const loan = economy.getLoan(id);
    if (!loan) return message.reply("you don't have a loan to pay off.");
    const raw = args[1];
    const amt = !raw || raw.toLowerCase() === "all" ? "all" : parseAmount(raw, loan.principal);
    const res = economy.payLoan(id, amt);
    if (!res.ok) {
      if (res.reason === "insufficient") return message.reply(`you only have ${money(res.have)} (wallet + bank) but owe ${money(res.owed)}.`);
      if (res.reason === "invalid") return message.reply(`usage: \`${PREFIX}loan pay <amount|all>\``);
      return message.reply("couldn't pay that.");
    }
    if (res.cleared) return message.reply(`\u2705 loan paid off! you paid ${money(res.paid)} and owe nothing now. wallet: ${money(res.wallet)}`);
    return message.reply(`\uD83D\uDCB8 paid ${money(res.paid)} toward your loan \u2014 still owe ${money(res.remaining)}.`);
  }

  if (sub === "take" || sub === "borrow" || sub === "get") {
    const cap = economy.loanCap(id);
    if (cap <= 0) return message.reply("you need a positive net worth before anyone will lend to you \u2014 go earn some money first.");
    const amt = parseAmount(args[1], cap);
    if (!Number.isFinite(amt) || amt <= 0) return message.reply(`usage: \`${PREFIX}loan take <amount>\` \u2014 you can borrow up to ${money(cap)} (2\u00d7 your net worth).`);
    const res = economy.takeLoan(id, amt);
    if (!res.ok) {
      if (res.reason === "active") return message.reply(`you already have a loan (${money(res.principal)} owed). pay it off first with \`${PREFIX}loan pay all\`.`);
      if (res.reason === "too_big") return message.reply(`\uD83D\uDED1 too much \u2014 the most you can borrow is ${money(res.cap)} (2\u00d7 your net worth).`);
      if (res.reason === "cooldown") return message.reply(`\u23F3 you recently took a loan \u2014 lenders need a breather. you can borrow again in ${economy.formatDuration(res.waitMs)} (12h cooldown between loans).`);
      if (res.reason === "no_networth") return message.reply("you need a positive net worth before anyone will lend to you.");
      return message.reply(`usage: \`${PREFIX}loan take <amount>\``);
    }
    return message.reply(
      `\uD83C\uDFE6 loan approved! borrowed ${money(res.amount)} \u2014 wallet now ${money(res.wallet)}.\n` +
        `\u26A0\uFE0F you'll be charged **5% interest every 5 minutes** (${money(Math.ceil(res.amount * economy.LOAN_INTEREST_RATE))} to start) out of your wallet/bank. pay it down with \`${PREFIX}loan pay <amount|all>\`.`
    );
  }

  // default: status
  const loan = economy.getLoan(id);
  const cap = economy.loanCap(id);
  if (!loan) {
    const cd = economy.loanCooldownLeft(id);
    if (cd > 0) return message.reply(`you have no active loan. a new loan is on cooldown \u2014 available in ${economy.formatDuration(cd)} (12h between loans). then you can borrow up to ${money(cap)} (2\u00d7 your net worth).`);
    return message.reply(`you have no active loan. you can borrow up to ${money(cap)} (2\u00d7 your net worth) with \`${PREFIX}loan take <amount>\`.`);
  }
  return message.reply(
    `\uD83C\uDFE6 **Your loan**\n` +
      `\u2022 owed: ${money(loan.principal)}\n` +
      `\u2022 interest: ${money(loan.interestPerPeriod)} (5%) every 5 min \u2014 next charge in ${economy.formatDuration(loan.nextInMs)}\n` +
      `\u2022 interest paid so far: ${money(loan.totalInterest)}\n` +
      `pay it down with \`${PREFIX}loan pay <amount|all>\`.`
  );
}

async function cmdDaily(message) {
  const res = economy.daily(message.author.id);
  if (!res.ok) return message.reply(`already claimed \u2014 come back in ${economy.formatDuration(res.remaining)}`);
  return message.reply(`\uD83C\uDF81 here's your daily ${money(res.amount)}. wallet now: ${money(res.wallet)}`);
}

async function cmdRob(message) {
  const target = firstMentionUser(message);
  if (!target) return message.reply(`who? \`${PREFIX}rob @user\``);
  if (target.bot) return message.reply("can't rob a bot");
  const res = economy.rob(message.author.id, target.id);
  if (!res.ok) {
    if (res.reason === "cooldown") return message.reply(`feds are still watching you. try again in ${economy.formatDuration(res.remaining)}`);
    return message.reply(res.reason);
  }
  if (res.success) {
    const slopPart = res.stolenSlop > 0 ? ` + ${money(res.stolenSlop)} \uD83E\uDD63 goyslop` : "";
    return message.reply(`\uD83D\uDD2B you robbed <@${target.id}> for ${money(res.stolen)}${slopPart}! they're cleaned out now`, { allowedMentions: { users: [] } });
  }
  const compPart = res.comp > 0 ? ` and had to pay them ${money(res.comp)} in compensation` : "";
  return message.reply(`\uD83D\uDE94 you got caught trying to rob <@${target.id}>${compPart} \u2014 better luck next time`, { allowedMentions: { users: [] } });
}

const WORK_JOBS = [
  "McDonald's", "Domino's", "Burger King", "KFC", "Subway", "Greggs",
  "Starbucks", "Costa", "an Amazon warehouse", "a gas station", "Tesco",
  "Walmart", "the chippy", "Nando's", "Five Guys", "Pizza Hut", "a car wash",
  "Deliveroo", "Uber Eats", "a call centre", "B&Q", "Wetherspoons",
];
const WORK_WIN = [
  "You make {money} working a shift at {job}",
  "You pulled a double at {job} and pocketed {money}",
  "{job} paid you {money} for the day",
  "You hustled at {job} and made {money}",
  "Tips were great at {job} \u2014 you earned {money}",
  "You covered someone's shift at {job} and banked {money}",
];
const WORK_FAIL = [
  "You tried working at {job} but got fired!",
  "You showed up late to {job} and got sent home with nothing",
  "You spilled an entire order at {job} \u2014 no pay today",
  "You overslept and missed your shift at {job}",
  "You got caught slacking at {job} and walked out empty-handed",
  "{job} said they'd call you back. they won't.",
];

function pickWork(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function cmdWork(message) {
  const res = economy.work(message.author.id);
  if (!res.ok) {
    if (res.reason === "cooldown")
      return message.reply(`\u23F3 you're knackered \u2014 you can work again in ${economy.formatDuration(res.remaining)}`);
    return message.reply("you can't work right now");
  }
  const job = pickWork(WORK_JOBS);
  if (res.success) {
    const line = pickWork(WORK_WIN).replace("{job}", job).replace("{money}", money(res.amount));
    return message.reply(`\uD83D\uDCBC ${line}. wallet: ${money(res.wallet)}`);
  }
  return message.reply(`\uD83D\uDE2C ${pickWork(WORK_FAIL).replace("{job}", job)}`);
}

async function cmdAway(message) {
  const res = economy.toggleAway(message.author.id);
  if (!res.ok) {
    if (res.reason === "cooldown") return message.reply(`\u23F3 you entered away mode too recently \u2014 try again in ${economy.formatDuration(res.remaining)} (leaving away has no cooldown)`);
    return message.reply("couldn't toggle away mode");
  }
  if (res.away) {
    return message.reply("\uD83D\uDE34 **away mode ON** \u2014 you can't be robbed, but your businesses stop earning, your factory pauses, and you can't gamble or sell stocks until you're back. send any message to come back instantly (no cooldown), or use `" + PREFIX + "away`");
  }
  return message.reply("\u2705 **away mode OFF** \u2014 welcome back. businesses + factory are running again");
}

async function cmdGive(message, args) {
  const target = firstMentionUser(message);
  if (!target) return message.reply(`usage: \`${PREFIX}give @user <amount>\``);
  if (target.id === message.author.id) return message.reply("can't give to yourself");
  if (target.bot) return message.reply("can't give to a bot");
  const amountArg = args.find((a) => !a.startsWith("<@"));
  const u = economy.getUser(message.author.id);
  const amt = parseAmount(amountArg, u.wallet);
  if (!Number.isFinite(amt) || amt <= 0) return message.reply(`usage: \`${PREFIX}give @user <amount>\``);
  const res = economy.transferWallet(message.author.id, target.id, amt);
  if (!res.ok) return message.reply("not enough in your wallet");
  return message.reply(`gave ${money(amt)} to <@${target.id}>`, { allowedMentions: { users: [] } });
}

async function cmdLeaderboard(message) {
  // Rank everyone by TOTAL net worth only (no per-asset breakdown). Pets, the
  // breeding station (pets inside + every goy-buck sunk into buying/upgrading
  // it) and the lab are all folded in via pets.summaryOf().netWorth.
  let rows = economy.leaderboard(50).map((row) => {
    const s = pets.summaryOf(row.id);
    return { id: row.id, total: row.total + s.netWorth };
  });
  rows.sort((a, b) => b.total - a.total);
  rows = rows.slice(0, 10);
  if (rows.length === 0) return message.reply("nobody's got any money yet");
  const lines = await Promise.all(
    rows.map(async (row, i) => {
      let name = `user ${row.id}`;
      try {
        const user = await message.client.users.fetch(row.id);
        name = user.username;
      } catch (_) {}
      const medal = ["\uD83E\uDD47", "\uD83E\uDD48", "\uD83E\uDD49"][i] || `**${i + 1}.**`;
      return `${medal} **${name}** \u2014 ${money(row.total)}`;
    })
  );
  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(`${EMOJI} Richest players \u2014 net worth`)
    .setDescription(lines.join("\n"))
    .setFooter({ text: "total net worth = cash + bank + businesses + factory + goyslop + stocks + houses + cars + pets + breeding station + lab" });
  await message.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function cmdHelp(message) {
  const lines = [
    `**Economy**`,
    `\`${PREFIX}balance [@user]\` \u2014 wallet + bank`,
    `\`${PREFIX}deposit <amount|all>\` \u2014 bank money (safe from robbers)`,
    `\`${PREFIX}withdraw <amount|all>\` \u2014 pull from bank`,
    `\`${PREFIX}daily\` \u2014 claim ${money(economy.DAILY_AMOUNT)} every 24h`,
    `\`${PREFIX}rob @user\` \u2014 50% chance to steal their whole wallet + goyslop, or pay them 25% of yours on fail (15m cd)`,
    `\`${PREFIX}work\` \u2014 70% chance to earn ${money(700)}-${money(2000)} at a random job (1m cd)`,
    `\`${PREFIX}away\` \u2014 toggle away: can't be robbed, income + factory pause, no gambling/stock-selling. auto-on after 12h idle, any message brings you back (5m cd to enter only)`,
    `\`${PREFIX}give @user <amount>\` \u2014 transfer money`,
    `\`${PREFIX}loan take <amount>\` \u2014 borrow up to **2\u00d7 your net worth** \u00b7 \`${PREFIX}loan pay <amount|all>\` \u00b7 \`${PREFIX}loan status\` (charged **5% interest every 5 min** \u00b7 **12h cooldown between loans**)`,
    `\`${PREFIX}leaderboard\` \u2014 richest players by net worth (cash + businesses + factory + goyslop + stocks + houses + cars)`,
    ``,
    `**Games** (amounts accept \`all\`, \`half\`, \`1k\`, \`2.5m\`)`,
    `\`${PREFIX}coinflip <amount>\` \u2014 50/50 vs house, 2x`,
    `\`${PREFIX}coinflip @user <amount>\` \u2014 challenge a player`,
    `\`${PREFIX}dice <amount> <high|low>\` \u2014 2x`,
    `\`${PREFIX}higherlower <amount>\` \u2014 chain for bigger multipliers`,
    `\`${PREFIX}crash <amount>\` \u2014 cash out before it busts`,
    `\`${PREFIX}blackjack <amount>\` \u2014 2.5x on a natural`,
    `\`${PREFIX}roulette <amount> <red|black|green|odd|even|0-36>\``,
    `\`${PREFIX}horserace <amount> <1-5>\``,
    `\`${PREFIX}slots <amount>\` \u2014 3-reel slots w/ wilds, scatters & free spins (~97% RTP)`,
    `\`${PREFIX}mines <amount> <1-19>\` \u2014 pick how many mines; more mines = bigger multiplier`,
    `\`${PREFIX}dragontower <amount> <easy|medium|hard|expert|master>\` \u2014 climb without hitting a dragon`,
    ``,
    `**Crime** (each has a 30s cooldown \u2014 fail too much and max heat locks you out of crimes til it cools)`,
    `\`${PREFIX}shoplift\` \u2014 60% chance, 200-500`,
    `\`${PREFIX}skim\` \u2014 50% chance, 500-2000`,
    `\`${PREFIX}sellfent\` \u2014 30% chance, 5000`,
    `\`${PREFIX}heat\` \u2014 check your police heat (max it out and crimes lock til it cools)`,
    ``,
    `**Businesses** (earn passive income into your wallet)`,
    `\`${PREFIX}business\` \u2014 list businesses + what you own`,
    `\`${PREFIX}business buy <name> [qty]\` \u2014 buy one or several at once (e.g. \`${PREFIX}business buy kiss the wall 5\`)`,
    `\`${PREFIX}business sell|give <name> [@user]\``,
    ``,
    `**Factory** (you can own ONE, upgrade to produce more goyslop)`,
    `\`${PREFIX}factory\` \u2014 view your factory + next upgrade`,
    `\`${PREFIX}factory buy\` \u2014 buy a factory (${money(economy.FACTORY_BASE_COST)}), makes ${economy.FACTORY_BASE_RATE} \uD83E\uDD63/sec`,
    `\`${PREFIX}factory upgrade\` \u2014 cost doubles each time, output x${economy.FACTORY_UPGRADE_MULT}`,
    `\`${PREFIX}goyslop\` \u2014 show your goyslop stockpile`,
    `\`${PREFIX}goyslop sell\` \u2014 sell all goyslop (${money(economy.GOYSLOP_PRICE)} each)`,
    ``,
    `**Stocks** (live market \u2014 prices move every 30s, some safe, some wild)`,
    `\`${PREFIX}stocks\` \u2014 live market board (price + \uD83D\uDCC8/\uD83D\uDCC9 movement)`,
    `\`${PREFIX}stocks buy <ticker> <shares|all>\` \u2014 buy shares`,
    `\`${PREFIX}stocks sell <ticker> <shares|all>\` \u2014 sell shares`,
    `\`${PREFIX}stocks portfolio\` \u2014 your holdings, gains/losses & total P/L`,
    `\`${PREFIX}stock <ticker>\` \u2014 one stock's price, hourly & daily average + change`,
    ``,
    `**Cars & Racing** (unbox cars, race AI or wager players)`,
    `\`${PREFIX}lootbox open <type> [n]\` \u2014 unbox cars: shitbox/beater/street/sports/super/hyper`,
    `\`${PREFIX}cars\` \u2014 garage \u00b7 \`${PREFIX}car select <#>\` racer \u00b7 \`${PREFIX}car <#>\` stats`,
    `\`${PREFIX}race <type>\` \u2014 race 10 AI bots, top 3 paid (60s cd)`,
    `\`${PREFIX}race wager @user <amount>\` \u2014 1v1 a player, same car type, winner takes all`,
    `\`${PREFIX}bookface\` \u2014 market \u00b7 \`${PREFIX}bookface sell <#> <price>\` \u00b7 \`${PREFIX}bookface buy <id>\``,
    `\`${PREFIX}sell <#>\` \u2014 sell one for full value \u2014 or mass-sell ${PREFIX}sell <rarity> / ${PREFIX}sell all (or \`${PREFIX}car sell <#>\`)`,
    `every race has a base 10% chance to destroy your car (high Reliability lowers it)`,
    ``,
    `**Houses** (status flex)`,
    `\`${PREFIX}house\` \u2014 list houses + what you own`,
    `\`${PREFIX}house buy|sell|give <name> [@user]\``,
    `\`${PREFIX}house buy island\` \u2014 a **Private Island** (${money(10000000)}, one only, can't sell) makes you a personal locked channel`,
    `\`${PREFIX}island\` \u2014 view it \u00b7 \`${PREFIX}island rename <name>\` \u00b7 \`${PREFIX}island perms give|remove @user\` to let people in`,
    ``,
    `**Pets \u2014 Dogs & Cats** (breed real breeds, race, fight, and run the Gene Lab) \u2014 full guide: \`${PREFIX}pethelp\``,
    `\`${PREFIX}pound <dog|cat>\` \u2014 adopt a random rescue \u00b7 \`${PREFIX}petstore\` refreshing shop`,
    `\`${PREFIX}pets\` \u2014 your pets \u00b7 \`${PREFIX}pet <#>\` info \u00b7 \`${PREFIX}pet select <#>\` racer/fighter`,
    `\`${PREFIX}petname <#> <name>\` rename \u00b7 \`${PREFIX}petimage <#> <url>\` \u00b7 \`${PREFIX}feed/walk <#>\` \u00b7 \`${PREFIX}care\` feed + walk ALL (neglect = they run off)`,
    `\`${PREFIX}breed <male#> <female#>\` \u2014 puppies/kittens (females breed in heats) \u00b7 \`${PREFIX}semen <male#>\` sell a sample`,
    `\`${PREFIX}seedshop\` + \`${PREFIX}breed <female#> seed\` no-male breeding \u00b7 \`${PREFIX}potion\` self-breed a purebred`,
    `\`${PREFIX}station\` \u2014 **Breeding Station**: auto-breed a male + females, litters auto-sell hourly \u00b7 \`${PREFIX}station buy\` (${money(1e12)}) \u00b7 see \`${PREFIX}pethelp\` for all station commands`,
    `\`${PREFIX}lab buy\` Gene Lab (${money(1e15)}) \u2192 \`${PREFIX}lab breed <dog#> <cat#>\` = a dog-cat worth **5\u2013500 quadrillion** (24h)`,
    `\`${PREFIX}petrace\` animated race \u00b7 \`${PREFIX}petshow\` dog/cat show \u00b7 \`${PREFIX}petattack @user\` rob with your pet (15m cd)`,
    `\`${PREFIX}petmarket\` buy/sell with players \u00b7 \`${PREFIX}petsell <#>|all\` cash out to the shelter`,
  ];
  // The full command list is far past Discord's 4096-char embed limit (which
  // made !help silently fail), so we send ONE message per category. The flat
  // `lines` array is split on blank lines; each block's first line is its bold
  // header, used as that message's embed title.
  const sections = [];
  let cur = null;
  for (const line of lines) {
    if (line === "") {
      if (cur) sections.push(cur);
      cur = null;
      continue;
    }
    if (!cur) cur = { header: line, body: [] };
    else cur.body.push(line);
  }
  if (cur) sections.push(cur);

  try {
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      const m = s.header.match(/\*\*(.+?)\*\*/);
      const title = `${EMOJI} ${m ? m[1] : "Commands"}`;
      // Anything on the header line after the bold name becomes a subtitle.
      const extra = s.header.replace(/\*\*.+?\*\*/, "").replace(/^[\s\u2014\-]+/, "").trim();
      const descLines = [];
      if (extra) descLines.push(`*${extra}*`);
      descLines.push(...s.body);
      const desc = (descLines.join("\n") || "\u200b").slice(0, 4000);
      const embed = new EmbedBuilder().setColor(0x2ecc71).setTitle(title).setDescription(desc);
      if (i === 0) {
        await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
      } else {
        await message.channel.send({ embeds: [embed] });
      }
    }
  } catch (err) {
    try {
      await message.reply("\u26A0\uFE0F couldn't send the help menu \u2014 try again in a moment.");
    } catch (_) {}
    if (typeof log === "function") log("cmdHelp failed:", err);
  }
}

// ── Dispatch table ───────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ELI_LINES = [
  "i need more estrogen",
  "where is my estrogen guys im running low fr fr",
  "somebody hook me up with that estrogen \uD83D\uDC89",
  "i put the T in estrogen HEHE",
];

// !eligrogan \u2014 silly bit: bot \"types\" then dribbles out a few messages
async function cmdEliGrogan(message) {
  for (const line of ELI_LINES) {
    try { await message.channel.sendTyping(); } catch (_) {}
    await sleep(1500);
    try {
      await message.channel.send(line);
    } catch (_) {
      await message.reply(line);
    }
  }
}

const HANDLERS = {
  help: cmdHelp,
  commands: cmdHelp,
  balance: cmdBalance,
  bal: cmdBalance,
  cash: cmdBalance,
  deposit: cmdDeposit,
  dep: cmdDeposit,
  withdraw: cmdWithdraw,
  wd: cmdWithdraw,
  daily: cmdDaily,
  loan: cmdLoan,
  loans: cmdLoan,
  borrow: cmdLoan,
  rob: cmdRob,
  work: cmdWork,
  away: cmdAway,
  afk: cmdAway,
  give: cmdGive,
  pay: cmdGive,
  leaderboard: cmdLeaderboard,
  lb: cmdLeaderboard,
  top: cmdLeaderboard,
  // games
  coinflip: games.coinflip,
  cf: games.coinflip,
  flip: games.coinflip,
  dice: games.dice,
  roll: games.dice,
  higherlower: games.higherLower,
  hl: games.higherLower,
  crash: games.crash,
  blackjack: games.blackjack,
  bj: games.blackjack,
  roulette: games.roulette,
  horserace: games.horseRace,
  hr: games.horseRace,
  horse: games.horseRace,
  slots: games.slots,
  slot: games.slots,
  spin: games.slots,
  mines: games.mines,
  mine: games.mines,
  dragontower: games.dragonTower,
  dragon: games.dragonTower,
  dt: games.dragonTower,
  // crime
  shoplift: crimes.shoplift,
  skim: crimes.skim,
  sellfent: crimes.sellfent,
  heat: crimes.cmdHeat,
  jail: crimes.cmdHeat,
  police: crimes.cmdHeat,
  // businesses + houses
  business: business.handleBusiness,
  biz: business.handleBusiness,
  businesses: business.handleBusiness,
  house: business.handleHouse,
  houses: business.handleHouse,
  // factory + goyslop
  factory: factory.handleFactory,
  fac: factory.handleFactory,
  goyslop: factory.handleGoyslop,
  slop: factory.handleGoyslop,
  // stocks
  stocks: stocktrader.handleStocks,
  stock: stocktrader.handleStocks,
  stonks: stocktrader.handleStocks,
  // cars / racing
  cars: racing.cmdCars,
  garage: racing.cmdCars,
  car: racing.cmdCar,
  lootbox: racing.cmdLootbox,
  lootboxes: racing.cmdLootbox,
  box: racing.cmdLootbox,
  bookface: racing.cmdBookface,
  bf: racing.cmdBookface,
  market: racing.cmdBookface,
  race: racing.cmdRace,
  racing: racing.cmdRace,
  sell: racing.cmdSell,
  sellcar: racing.cmdSell,

  eligrogan: cmdEliGrogan,
  eli: cmdEliGrogan,
  // pets: dogs, cats & the gene lab
  pets: pets.cmdPets,
  petlist: pets.cmdPets,
  pet: pets.cmdPet,
  petname: pets.cmdRename,
  petrename: pets.cmdRename,
  petimage: pets.cmdImage,
  petpic: pets.cmdImage,
  pound: pets.cmdPound,
  adopt: pets.cmdPound,
  petstore: pets.cmdPetStore,
  petshop: pets.cmdPetStore,
  breed: pets.cmdBreed,
  semen: pets.cmdSemen,
  seed: pets.cmdSemen,
  seedshop: pets.cmdSeedShop,
  seeds: pets.cmdSeedShop,
  potion: pets.cmdPotion,
  lab: pets.cmdLab,
  genelab: pets.cmdLab,
  petmarket: pets.cmdMarket,
  petsell: pets.cmdPetSell,
  station: pets.cmdStation,
  breedingstation: pets.cmdStation,
  bs: pets.cmdStation,
  petrace: pets.cmdPetRace,
  petshow: pets.cmdPetShow,
  petattack: pets.cmdAttack,
  sic: pets.cmdAttack,
  feed: pets.cmdFeed,
  walk: pets.cmdWalk,
  care: pets.cmdCareAll,
  careall: pets.cmdCareAll,
  petcare: pets.cmdCareAll,
  // hidden owner-only admin tools (see admin.js / !admin help) — NOT listed in !help
  admin: admin.handleAdmin,
  pethelp: pets.cmdPetHelp,
  // private island channels
  island: island.handleIsland,
  myisland: island.handleIsland,
};

async function handleCommand(message) {
  const content = (message.content || "").trim();
  if (!content.startsWith(PREFIX)) return false;

  const withoutPrefix = content.slice(PREFIX.length).trim();
  if (!withoutPrefix) return false;
  const parts = withoutPrefix.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  const handler = HANDLERS[cmd];
  if (!handler) return false;

  try {
    await handler(message, args);
  } catch (err) {
    log("error", `command ${cmd}: ${err.message}`);
    try {
      await message.reply("something broke running that command");
    } catch (_) {}
  }
  return true;
}

module.exports = { handleCommand };
