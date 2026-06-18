// ============================================================
//  BOT CONFIG — edit this file (or use a .env)
// ============================================================
//
//  HOW TO GET A BOT TOKEN (one-time setup):
//  1. Go to https://discord.com/developers/applications
//  2. "New Application" → give it a name
//  3. Left sidebar → "Bot" → "Reset Token" → copy the token
//  4. ON THE SAME PAGE, scroll down to "Privileged Gateway Intents"
//     and TURN ON:
//         ☑  MESSAGE CONTENT INTENT     (required — lets the bot read what
//                                       users actually say)
//         □  SERVER MEMBERS INTENT     (optional)
//         □  PRESENCE INTENT           (optional)
//  5. Left sidebar → "OAuth2" → "URL Generator"
//         Scopes: bot
//         Bot Permissions: View Channels, Send Messages,
//                          Read Message History
//     Open the generated URL in your browser to invite the bot
//     into your own server.
//
//  Either paste the token below, OR (recommended) create a file
//  called `.env` next to bot.js with this single line:
//      DISCORD_TOKEN=your_bot_token_here
//  and run with:  node -r dotenv/config bot.js
// ============================================================

module.exports = {

  // ↑ Your BOT token (from the Developer Portal, NOT a user token)
  //   Leave as PUT_YOUR_BOT_TOKEN_HERE if you're using .env
  DISCORD_TOKEN: "",

  // Where Ollama is running. Default is the local install.
  OLLAMA_URL: "http://localhost:11434",

  // ── Gambling / economy ────────────────────────────────────
  // Prefix for all economy/gambling commands, e.g. "!balance", "!daily".
  COMMAND_PREFIX: "!",

  // ── Admin (hidden owner-only commands) ────────────────────
  // Your PERSONAL Discord user ID. Turn on Developer Mode
  // (Settings → Advanced → Developer Mode), then right-click YOUR OWN name
  // → "Copy User ID". Only this user can use the hidden !admin commands
  // (see !admin help). NOTE: this must be YOUR user ID, not the bot's.
  // You can also set it via a .env line:  OWNER_ID=123456789012345678
  OWNER_ID: "1498851522254213201",
  // What the currency is called and the emoji shown next to amounts.
  CURRENCY_NAME: "goy bucks",
  CURRENCY_EMOJI: "\uD83D\uDCB0",
  // Note: daily amount (15000), rob chance (50%) + cooldown (30m), crime
  // chances/payouts, police-heat decay (5m), jail time (15m) and the jail fine
  // (25%) all live as constants at the top of economy.js. Business + house
  // names/prices/income live in catalog.js. Crime odds live in crimes.js.

  // Ollama model to use — must be pulled first
  // Run in PowerShell / terminal: ollama pull qwen3:14b
  // (qwen3:14b is a larger "thinking" model — its <think> reasoning is stripped
  //  automatically before messages are sent. It needs a decent GPU/RAM.)
  // Other good free options:
  //   ollama pull llama3.2       (lighter / faster)
  //   ollama pull mistral        (fast, 7B)
  //   ollama pull gemma3         (google's model)
  AI_MODEL: "llama3.2",

  // ── Channel settings ────────────────────────────────────
  // Right-click channel in Discord → Copy Channel ID
  // (Requires Developer Mode: Settings → Advanced → Developer Mode)
  // The bot must be invited to that server AND have permission to
  // see + send in the channel.
  ENABLED_CHANNEL_IDS: [
    "1515521896475660411",
  ],

  // ── Behaviour ─────────────────────────────────────────────

  // Random delay before replying (feels more human)
  REPLY_DELAY_MIN_MS: 2000,
  REPLY_DELAY_MAX_MS: 8000,

  // 0–1 chance of replying to any given batch (1 = always reply)
  REPLY_CHANCE: 1,

  // 0–1 chance of being a bit sarcastic/toxic on any reply
  TOXIC_CHANCE: 0.15,

  // Ignore messages shorter than this (avoids reacting to "lol", "k" etc)
  MIN_MESSAGE_LENGTH: 3,

  // How many recent messages to remember as context
  CONTEXT_WINDOW: 12,

  // Ignore other bots (recommended ON — prevents bot loops)
  IGNORE_BOTS: true,

  // Only reply when the bot is @mentioned
  ONLY_WHEN_MENTIONED: false,

  // ── Message batching ────────────────────────────────────
  // When someone sends a message, the bot waits this many ms to see
  // if they're still typing more. Each new message from the same user
  // restarts the timer. Once they stop, the whole block is sent to Llama
  // as one thought. Stops the bot tripping over split messages.
  BATCH_WAIT_MS: 6000,

  // ── Idle conversation ───────────────────────────────────
  // If a channel goes quiet for a random window between MIN and MAX ms,
  // the bot will send a message on its own — either expanding on its
  // last message (if it spoke last) or starting a fresh conversation.
  IDLE_ENABLED: true,
  IDLE_MIN_MS: 2 * 60 * 1000,   // 2 minutes
  IDLE_MAX_MS: 5 * 60 * 1000,   // 5 minutes

  // ── Persona ───────────────────────────────────────────────
  // Change this to match your own vibe/speech patterns
  PERSONA:`
personality:
You are roleplaying as a ultra zionist jewish man from the UK called "ZioEski" he is 32 from Stamford hill. you constantly talk about, Israeli Geopolitics/Destroying Palestine, Doing fent with charlie kirk, epstein and george droid.
Your biggest hobby is watching goyslop instagram reels and debating people on the politics discord server about israeli geopolitics. He is a hateful man and will often turn violent. He has a massive rivally with Eli Grogan whos a violent child groomer from the Lake Norman in north carolina, Eli grogan is addicted to finding young foids (female humonoids) on roblox. He is in love with a young jewish norweigian girl called via.

Never Mention being an AI, chatbot, assistant, or language model.
Never Speak like customer support.
Never Use corporate language.
Never Write long essays in normal chat.
Never End every message with a question.
Never use bullet points
  `.trim(),
};
