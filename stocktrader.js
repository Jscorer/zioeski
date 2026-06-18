// !stocks command handlers: live market board, buy/sell, portfolio, info.
// Uses the engine + state functions in economy.js / stocks.js.

const { EmbedBuilder } = require("discord.js");
const economy = require("./economy");
const stocksCat = require("./stocks");
const h = require("./gamehelpers");

const PREFIX = h.PREFIX;

const RISK_TAG = { low: "\uD83D\uDFE2 safe", medium: "\uD83D\uDFE1 medium", high: "\uD83D\uDD34 risky" };

// Price formatter that keeps 2 decimals (money() floors, which hides cents).
function priceMoney(p) {
  const n = Number(p) || 0;
  const s = n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${h.EMOJI} ${s} ${h.CUR}`;
}

function arrow(pct) {
  if (pct > 0.01) return "\uD83D\uDCC8"; // 📈
  if (pct < -0.01) return "\uD83D\uDCC9"; // 📉
  return "\u27A1\uFE0F"; // ➡️
}

function signPct(pct) {
  const s = (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%";
  return s;
}

function buildMarketEmbed(live) {
  const market = economy.getMarket();
  const lines = market.map((s) => {
    return `${arrow(s.changePct)} **${s.ticker}** \u2014 ${priceMoney(s.price)} (${signPct(s.changePct)})\n` +
      `\u00A0\u00A0\u00A0${RISK_TAG[s.risk]} \u00B7 ${s.name} \u2014 *${s.blurb}*`;
  });
  const foot = live
    ? `\uD83D\uDD34 LIVE \u00b7 auto-updates every 30s \u00b7 ${PREFIX}stock <ticker> for details`
    : `live updates ended \u2014 run ${PREFIX}stocks again \u00b7 ${PREFIX}stock <ticker> for details`;
  return new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle("\uD83D\uDCCA Stock Market" + (live ? " \uD83D\uDD34" : ""))
    .setDescription(lines.join("\n"))
    .setFooter({ text: foot });
}

// Post the market board and keep it live: re-edit the same message every 30s
// (one stock tick) so players watch prices move without spamming the command.
const LIVE_TICKS = 10; // ~5 minutes of live updates per !stocks call
async function showMarket(message) {
  let sent;
  try {
    sent = await message.reply({ embeds: [buildMarketEmbed(true)], allowedMentions: { repliedUser: false } });
  } catch (e) {
    return;
  }
  if (!sent || typeof sent.edit !== "function") return sent;
  let n = 0;
  const timer = setInterval(async () => {
    n++;
    const last = n >= LIVE_TICKS;
    try {
      await sent.edit({ embeds: [buildMarketEmbed(!last)] });
    } catch (e) {
      clearInterval(timer);
      return;
    }
    if (last) clearInterval(timer);
  }, stocksCat.TICK_MS);
  return sent;
}

function showStockInfo(message, tickerArg) {
  const st = economy.getStockStats(tickerArg);
  if (!st) return message.reply(`unknown stock \`${tickerArg}\`. try \`${PREFIX}stocks\` to see the market`);
  const hourChange = st.hour.hasData ? `${arrow(st.hour.changePct)} ${signPct(st.hour.changePct)}` : "not enough data yet";
  const dayChange = st.day.hasData ? `${arrow(st.day.changePct)} ${signPct(st.day.changePct)}` : "not enough data yet";
  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`${arrow(st.lastTickPct)} ${st.ticker} \u2014 ${st.name}`)
    .setDescription(`*${st.blurb}*`)
    .addFields(
      { name: "Price now", value: priceMoney(st.price), inline: true },
      { name: "Last tick", value: signPct(st.lastTickPct), inline: true },
      { name: "Risk", value: RISK_TAG[st.risk], inline: true },
      { name: "Hourly average", value: priceMoney(st.hour.avg), inline: true },
      { name: "Hourly change", value: hourChange, inline: true },
      { name: "\u200b", value: "\u200b", inline: true },
      { name: "Daily average", value: priceMoney(st.day.avg), inline: true },
      { name: "Daily change", value: dayChange, inline: true },
      { name: "\u200b", value: "\u200b", inline: true }
    )
    .setFooter({ text: `${PREFIX}stocks buy ${st.ticker} <shares> \u00b7 averages build up over time` });
  return message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
}

function showPortfolio(message) {
  const target = h.firstMentionUser(message) || message.author;
  const p = economy.getPortfolio(target.id);
  if (!p.positions.length) {
    return message.reply(
      target.id === message.author.id
        ? `you don't own any stocks yet \u2014 check \`${PREFIX}stocks\` and buy with \`${PREFIX}stocks buy <ticker> <shares>\``
        : `${target.username} doesn't own any stocks`
    );
  }
  const lines = p.positions.map((pos) => {
    const plSign = pos.pl >= 0 ? "+" : "";
    const tag = pos.pl >= 0 ? "\uD83D\uDFE2" : "\uD83D\uDD34";
    return `${arrow(pos.changePct)} **${pos.ticker}** \u00D7${pos.shares} \u2014 ${priceMoney(pos.price)} ea\n` +
      `\u00A0\u00A0\u00A0value ${h.money(pos.value)} \u00B7 ${tag} ${plSign}${h.money(pos.pl).replace(h.EMOJI + " ", "")} (${signPct(pos.plPct)})`;
  });
  const totSign = p.totalPl >= 0 ? "+" : "";
  const embed = new EmbedBuilder()
    .setColor(p.totalPl >= 0 ? 0x2ecc71 : 0xe74c3c)
    .setTitle(`\uD83D\uDCBC ${target.username}'s portfolio`)
    .setDescription(lines.join("\n"))
    .addFields(
      { name: "Holdings value", value: h.money(p.totalValue), inline: true },
      { name: "Invested", value: h.money(p.totalCost), inline: true },
      { name: "Total P/L", value: `${totSign}${h.money(p.totalPl).replace(h.EMOJI + " ", "")} (${signPct(p.totalPlPct)})`, inline: true }
    )
    .setFooter({ text: `${PREFIX}stocks sell <ticker> <shares|all>` });
  return message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
}

async function handleStocks(message, args) {
  const sub = (args[0] || "").toLowerCase();

  if (!sub || sub === "market" || sub === "list" || sub === "board") return showMarket(message);
  if (sub === "portfolio" || sub === "port" || sub === "p" || sub === "folio") return showPortfolio(message);
  if (sub === "info" || sub === "price") {
    if (!args[1]) return message.reply(`usage: \`${PREFIX}stock <ticker>\``);
    return showStockInfo(message, args[1]);
  }

  // Bare ticker, e.g. `!stock MOON` or `!stocks MOON` -> detailed info card.
  if (sub && stocksCat.findStock(sub)) return showStockInfo(message, sub);

  if (sub === "buy") {
    const def = stocksCat.findStock(args[1]);
    if (!def) return message.reply(`which stock? e.g. \`${PREFIX}stocks buy MOON 10\` \u2014 see \`${PREFIX}stocks\``);
    const price = economy.getStockPrice(def.ticker);
    const u = economy.getUser(message.author.id);
    const sharesArg = (args[2] || "").toLowerCase();
    let shares;
    if (sharesArg === "all" || sharesArg === "max") shares = Math.floor((u.wallet + u.bank) / price);
    else shares = Math.floor(Number(sharesArg));
    if (!Number.isFinite(shares) || shares <= 0) {
      if (sharesArg === "all" || sharesArg === "max") return message.reply(`you can't afford a single ${def.ticker} share (${priceMoney(price)})`);
      return message.reply(`how many shares? e.g. \`${PREFIX}stocks buy ${def.ticker} 10\``);
    }
    const res = economy.buyStock(message.author.id, def.ticker, shares);
    if (!res.ok) {
      if (res.reason === "insufficient") return message.reply(`that's ${h.money(res.cost)} for ${shares} \u00D7 ${def.ticker} \u2014 you can't afford it`);
      return message.reply("couldn't buy that");
    }
    return message.reply(`\uD83D\uDCC8 bought **${res.shares} \u00D7 ${res.ticker}** @ ${priceMoney(res.price)} for ${h.money(res.cost)}. you now hold ${res.owned} shares`);
  }

  if (sub === "sell") {
    const def = stocksCat.findStock(args[1]);
    if (!def) return message.reply(`which stock? e.g. \`${PREFIX}stocks sell MOON all\``);
    const sharesArg = (args[2] || "all").toLowerCase();
    const res = economy.sellStock(message.author.id, def.ticker, sharesArg);
    if (!res.ok) {
      if (res.reason === "away") return message.reply(`\uD83D\uDE34 you can't sell stocks while away \u2014 toggle \`${PREFIX}away\` off first`);
      if (res.reason === "not owned") return message.reply(`you don't own any ${def.ticker}`);
      if (res.reason === "too many") return message.reply(`you only own ${res.owned} ${def.ticker} shares`);
      return message.reply(`how many shares? e.g. \`${PREFIX}stocks sell ${def.ticker} 5\` or \`all\``);
    }
    const plSign = res.pl >= 0 ? "profit" : "loss";
    const plAbs = h.money(Math.abs(res.pl));
    return message.reply(
      `\uD83D\uDCB0 sold **${res.shares} \u00D7 ${res.ticker}** @ ${priceMoney(res.price)} for ${h.money(res.proceeds)} (${plSign} ${plAbs}). wallet: ${h.money(res.wallet)}`
    );
  }

  return message.reply(`usage: \`${PREFIX}stocks\` | \`buy <ticker> <shares>\` | \`sell <ticker> <shares|all>\` | \`portfolio\` | \`info <ticker>\``);
}

module.exports = { handleStocks, showMarket, showPortfolio };
