const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ChannelType,
} = require("discord.js");
const config = require("./config");
const { log } = require("./logger");
const { handleCommand } = require("./commands");
const economy = require("./economy");

// fetch is built into Node 18+. If you're on older Node, uncomment the next line
// and add node-fetch to your dependencies.
// const fetch = require("node-fetch");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages, // optional, lets it work in DMs too
  ],
  partials: [Partials.Channel], // needed for DM messages
});

// ── State ────────────────────────────────────────────────────
const contextMap = new Map();          // channelId -> [{ role, text }]
const pendingByUser = new Map();       // `${channelId}:${userId}` -> { messages, timer, channel, authorName, userId }
const channelIdleTimers = new Map();   // channelId -> NodeJS.Timeout
const lastChannelActivity = new Map(); // channelId -> { authorName, fromBot }
const channelSendLocks = new Map();    // channelId -> Promise chain (serialise replies per channel)

// ── Utils ────────────────────────────────────────────────────
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getContext(channelId) {
  if (!contextMap.has(channelId)) contextMap.set(channelId, []);
  return contextMap.get(channelId);
}

function pushContext(channelId, role, text) {
  const ctx = getContext(channelId);
  ctx.push({ role, text });
  while (ctx.length > config.CONTEXT_WINDOW) ctx.shift();
}

function channelLabel(channel) {
  if (!channel) return "unknown";
  if (channel.type === ChannelType.DM) return `DM:${channel.recipient?.username || channel.id}`;
  return `#${channel.name || channel.id}`;
}

// Run async work serially per channel so idle + batch flushes never overlap
function withChannelLock(channelId, fn) {
  const prev = channelSendLocks.get(channelId) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  channelSendLocks.set(
    channelId,
    next.catch(() => {})
  );
  return next;
}

// ── Prompts ──────────────────────────────────────────────────
function buildReplyPrompt(channelId, newMessage, authorName, isToxic) {
  const ctx = getContext(channelId);
  // Don't double-print the message we just pushed; show history up to (but not including) the trailing turn.
  const history = ctx
    .slice(0, -1)
    .map((m) => `${m.role}: ${m.text}`)
    .join("\n");

  const toxicLine = isToxic
    ? "\nThis time, be a little sarcastic, blunt, or subtly roast what they said. Still natural, not over the top."
    : "";

  return `${config.PERSONA}${toxicLine}

Recent conversation:
${history || "(no history yet)"}

${authorName} just sent the following (possibly split across multiple messages — treat as one thought):
${newMessage}

Reply as yourself (one short chat message, no names, no quotation marks):`;
}

function buildIdlePrompt(channelId, mode) {
  const ctx = getContext(channelId);
  const history = ctx.map((m) => `${m.role}: ${m.text}`).join("\n");

  const instruction =
    mode === "expand"
      ? "The chat has gone quiet for a few minutes since YOUR last message. Send a short, casual follow-up that naturally builds on what you just said — an extra thought, a question, or a small tangent. Do NOT repeat what you already said. Do NOT mention that nobody replied or that it's gone quiet."
      : "The chat has gone quiet for a few minutes. Break the silence with a short, casual message to spark conversation — share a random thought, ask the group something, or make a light observation. Do NOT reference the silence. Do NOT say things like 'where is everyone' or 'anyone there'.";

  return `${config.PERSONA}

Recent conversation:
${history || "(no history yet)"}

${instruction}

Your message (one short chat message, no names, no quotation marks):`;
}

// ── Ollama ───────────────────────────────────────────────────
async function callOllama(prompt) {
  const res = await fetch(`${config.OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.AI_MODEL,
      prompt,
      stream: false,
      options: {
        temperature: 0.9,
        num_predict: 120,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Ollama ${res.status}: ${err}`);
  }

  const data = await res.json();
  let text = data.response?.trim();
  if (!text) throw new Error("Empty response from Ollama");
  // "Thinking" models (e.g. qwen3) wrap their reasoning in <think>...</think>.
  // Strip it so only the actual chat message gets sent to Discord.
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<\/?think>/gi, "").trim();
  return text.replace(/^(you|me|reply|assistant)[:\s]+/i, "").trim();
}

async function safeOllama(prompt) {
  try {
    return await callOllama(prompt);
  } catch (err) {
    if (err.message.includes("ECONNREFUSED") || err.cause?.code === "ECONNREFUSED") {
      log("error", "Ollama is not running! Start it with: ollama serve");
    } else {
      log("error", `AI error: ${err.message}`);
    }
    return null;
  }
}

// ── Idle behaviour ───────────────────────────────────────────
function scheduleIdle(channel) {
  if (!config.IDLE_ENABLED) return;
  if (!channel || !channel.id) return;
  if (!config.ENABLED_CHANNEL_IDS.includes(channel.id)) return;

  const existing = channelIdleTimers.get(channel.id);
  if (existing) clearTimeout(existing);

  const delay = randomInt(config.IDLE_MIN_MS, config.IDLE_MAX_MS);
  const t = setTimeout(() => {
    onIdleFire(channel).catch((e) => log("error", `idle: ${e.message}`));
  }, delay);
  channelIdleTimers.set(channel.id, t);
  log("info", `[${channelLabel(channel)}] idle timer armed for ${(delay / 1000).toFixed(0)}s`);
}

async function onIdleFire(channel) {
  // Don't fire if a batch is queued or being processed for this channel
  for (const key of pendingByUser.keys()) {
    if (key.startsWith(`${channel.id}:`)) {
      log("info", `[${channelLabel(channel)}] idle skipped — batch pending`);
      scheduleIdle(channel);
      return;
    }
  }

  const last = lastChannelActivity.get(channel.id);
  const mode = last && last.fromBot ? "expand" : "new";
  log("wait", `[${channelLabel(channel)}] idle fired (mode=${mode})`);

  await withChannelLock(channel.id, async () => {
    try {
      await channel.sendTyping().catch(() => {});
      await sleep(randomInt(1500, 3500));
      const text = await safeOllama(buildIdlePrompt(channel.id, mode));
      if (!text) return;
      await channel.send(text);
      pushContext(channel.id, "me", text);
      lastChannelActivity.set(channel.id, { authorName: "me", fromBot: true });
      log("sent", `[${channelLabel(channel)}] idle msg: ${text}`);
    } catch (e) {
      log("error", `idle send: ${e.message}`);
    }
  });

  // Re-arm regardless — keeps the convo loop alive
  scheduleIdle(channel);
}

// ── Batch handling ───────────────────────────────────────────
function pendingKey(channelId, userId) {
  return `${channelId}:${userId}`;
}

function scheduleBatchFlush(key) {
  const entry = pendingByUser.get(key);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    flushBatch(key).catch((e) => log("error", `flush: ${e.message}`));
  }, config.BATCH_WAIT_MS);
}

async function flushBatch(key) {
  const entry = pendingByUser.get(key);
  if (!entry) return;
  // Remove from pending so brand-new messages start a fresh batch
  pendingByUser.delete(key);

  const { channel, authorName, messages } = entry;
  const combined = messages.map((m) => m.content).join("\n");

  log(
    "msg",
    `[${channelLabel(channel)}] flushing ${messages.length} msg(s) from ${authorName}: ${combined.replace(/\n/g, " | ")}`
  );
  pushContext(channel.id, authorName, combined);

  // Reply chance applies to the whole batch, not per message
  if (Math.random() > config.REPLY_CHANCE) {
    log("skip", `Skipped (chance) in ${channelLabel(channel)}`);
    return;
  }

  await withChannelLock(channel.id, async () => {
    const delay = randomInt(config.REPLY_DELAY_MIN_MS, config.REPLY_DELAY_MAX_MS);
    log("wait", `Waiting ${(delay / 1000).toFixed(1)}s before replying...`);
    await sleep(delay);

    await channel.sendTyping().catch(() => {});
    await sleep(randomInt(1000, 3000));

    const isToxic = Math.random() < config.TOXIC_CHANCE;
    const reply = await safeOllama(buildReplyPrompt(channel.id, combined, authorName, isToxic));
    if (!reply) return;

    try {
      await channel.send(reply);
      pushContext(channel.id, "me", reply);
      lastChannelActivity.set(channel.id, { authorName: "me", fromBot: true });
      log("sent", `Replied: ${reply}`);
    } catch (e) {
      log("error", `send failed: ${e.message}`);
    }
  });

  scheduleIdle(channel);
}

// ── Event handlers ───────────────────────────────────────────
client.on(Events.MessageCreate, async (message) => {
  try {
    // Track our own outgoing messages so the idle timer + last-speaker bookkeeping stay accurate
    if (message.author.id === client.user.id) {
      if (config.ENABLED_CHANNEL_IDS.includes(message.channel.id)) {
        lastChannelActivity.set(message.channel.id, { authorName: "me", fromBot: true });
        scheduleIdle(message.channel);
      }
      return;
    }

    if (config.IGNORE_BOTS && message.author.bot) return;

    // ── Activity / auto-away bookkeeping ────────────────────────
    // Any message anywhere in the server counts as activity: it resets the
    // 12h auto-away timer, and (unless this IS the away command) pulls the
    // user out of away mode instantly with no cooldown.
    const prefix = config.COMMAND_PREFIX || "!";
    const lc = (message.content || "").trim().toLowerCase();
    const isAwayCmd =
      lc === prefix + "away" || lc.startsWith(prefix + "away ") ||
      lc === prefix + "afk" || lc.startsWith(prefix + "afk ");
    try {
      if (isAwayCmd) {
        economy.markActive(message.author.id); // let !away itself decide the toggle
      } else if (economy.leaveAway(message.author.id)) {
        message.react("\uD83D\uDC4B").catch(() => {});
      }
    } catch (e) {
      log("error", `activity tracking: ${e.message}`);
    }

    // ── Channel policy ──────────────────────────────────────
    //  • The AI chatbot channel(s) in ENABLED_CHANNEL_IDS are STRICTLY for the
    //    AI persona — NO economy / gambling / crime / business commands run
    //    there (commands are blacklisted from the chatbot channel).
    //  • EVERY OTHER channel is for commands only — the AI never chats there.
    if (!config.ENABLED_CHANNEL_IDS.includes(message.channel.id)) {
      await handleCommand(message);
      return;
    }
    // From here on we're in an AI chatbot channel: persona only, no commands.
    if (!message.content || message.content.trim().length < config.MIN_MESSAGE_LENGTH) return;

    if (config.ONLY_WHEN_MENTIONED) {
      if (!message.mentions.users.has(client.user.id)) return;
    }

    const authorName = message.member?.displayName || message.author.username;

    // Always update activity + idle timer, even if this message ends up in a batch we skip
    lastChannelActivity.set(message.channel.id, { authorName, fromBot: false });
    scheduleIdle(message.channel);

    const key = pendingKey(message.channel.id, message.author.id);
    let entry = pendingByUser.get(key);
    if (!entry) {
      entry = {
        messages: [],
        timer: null,
        channel: message.channel,
        authorName,
        userId: message.author.id,
      };
      pendingByUser.set(key, entry);
    }
    entry.messages.push({ content: message.content });
    entry.authorName = authorName; // refresh in case nickname changed mid-batch

    log(
      "msg",
      `[${channelLabel(message.channel)}] ${authorName} (queued ${entry.messages.length}): ${message.content}`
    );
    scheduleBatchFlush(key);
  } catch (err) {
    log("error", `messageCreate error: ${err.message}`);
  }
});

client.once(Events.ClientReady, async (c) => {
  log("ready", `Bot online as ${c.user.tag}`);
  log("info", `Model: ${config.AI_MODEL} (via Ollama at ${config.OLLAMA_URL})`);
  log("info", `Watching ${config.ENABLED_CHANNEL_IDS.length} channel(s)`);
  log(
    "info",
    `Batch wait: ${config.BATCH_WAIT_MS}ms | Idle: ${
      config.IDLE_ENABLED ? `${config.IDLE_MIN_MS / 1000}-${config.IDLE_MAX_MS / 1000}s` : "off"
    }`
  );

  if (config.IDLE_ENABLED) {
    for (const id of config.ENABLED_CHANNEL_IDS) {
      try {
        const ch = await c.channels.fetch(id);
        if (ch) scheduleIdle(ch);
      } catch (e) {
        log("error", `couldn't fetch channel ${id}: ${e.message}`);
      }
    }
  }

  // ── Auto-away sweep ──────────────────────────────────
  // Anyone who hasn't sent a message for 12h is automatically put into away
  // mode. Idempotent: already-away players are skipped (no error, no re-toggle).
  economy.applyAutoAway(); // initialise activity timestamps on boot
  const AUTO_AWAY_CHECK_MS = 5 * 60 * 1000; // re-check every 5 minutes
  setInterval(() => {
    try {
      const newly = economy.applyAutoAway();
      if (newly.length) log("info", `auto-away: ${newly.length} player(s) set away after 12h idle`);
    } catch (e) {
      log("error", `auto-away sweep: ${e.message}`);
    }
  }, AUTO_AWAY_CHECK_MS);
});

client.on(Events.Error, (err) => log("error", `client error: ${err.message}`));
client.on(Events.Warn, (msg) => log("info", `warn: ${msg}`));

const token = process.env.DISCORD_TOKEN || config.DISCORD_TOKEN;
if (!token || token.includes("PUT_YOUR")) {
  log("error", "No bot token set. Put it in .env as DISCORD_TOKEN=... or in config.js");
  process.exit(1);
}

client.login(token).catch((err) => {
  log("error", `Login failed: ${err.message}`);
  process.exit(1);
});
