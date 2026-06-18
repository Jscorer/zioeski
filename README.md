# ZioEski Discord Bot

Only discord eco bot that is based and ziopilled

## 1. One-time setup on Discord

1. Go to <https://discord.com/developers/applications> → **New Application**.
2. Sidebar → **Bot** → **Reset Token** → copy it (shown once).
3. **On the same Bot page**, under *Privileged Gateway Intents*, turn ON:
   - ✅ **MESSAGE CONTENT INTENT** *(required — lets the bot read messages)*
4. Sidebar → **OAuth2 → URL Generator**:
   - Scopes: `bot`
   - Bot permissions: `View Channels`, `Send Messages`, `Read Message History`,
     `Add Reactions`, `Embed Links`
5. Open the generated URL and invite the bot to your server.

> If you got `Used disallowed intents` when starting the bot, it's step 3 —
> tick **Message Content Intent** and **Save Changes**.

---

## 2. Install

Requires **Node.js 18 or newer**. AI model is set to **qwen3:14b** — pull it
with `ollama pull qwen3:14b` (it's a larger "thinking" model; its `<think>`
reasoning is stripped automatically before messages are sent). Prefer something
lighter? Set `AI_MODEL` in `config.js` back to `llama3.2`.

```bash
npm install
```

## 3. Configure

**Recommended — .env file:**
```bash
cp .env.example .env      # then paste your bot token into it
npm run start:env
```

**Add** bot token in `config.js` 

You can also edit `config.js` to change:
- `ENABLED_CHANNEL_IDS` — channels the AI persona chats in (right-click channel → Copy Channel ID; enable Developer Mode first)
- `PERSONA` — the character the bot role-plays as if you wanna use the chatbot
- `AI_MODEL` — must match a model you've pulled in Ollama
- `COMMAND_PREFIX` / `CURRENCY_NAME` / `CURRENCY_EMOJI` — eco settings
(the config has a lot more than this, this is just the basics)

To change the **daily amount, rob chance, or rob cooldown**, edit the constants
at the top of `economy.js`:
```js
const DAILY_AMOUNT = 15000;
const ROB_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const ROB_SUCCESS_CHANCE = 0.5;         // 50%
```

## 4. Run Ollama

```bash
ollama pull llama3.2   # one-time
ollama serve           # leave running
```

## 5. Start

```bash
npm run start:env   # token from .env
# or
npm start           # token from config.js
```
