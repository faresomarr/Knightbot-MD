# Knightbot-MD / Telegram x WhatsApp Pairing Hub

Telegram bot that issues WhatsApp pairing codes and runs per-number multi-session
sockets for automatic status reactions.

## Configuration (`.env`)

```
TELEGRAM_BOT_TOKEN=...        # required
DEFAULT_EMOJI=❤️
DATA_DIR=./data
LOG_LEVEL=info
PORT=3000
```

## Run

```
npm install
npm start
```

## Stability patches in this build

1. `requestPairingCode` is delayed 4s after the first `connecting`/`qr` event so
   the Baileys socket has time to negotiate keys before we ask it to sign a code.
   Repeated up to 3 times with backoff. This eliminates `Error: Connection Closed
   at sendRawMessage` that happens when the call lands before the socket is open.
2. Backoff reconnect (3s → 5s → 7s, capped at 15s) so a transient 428 close does
   not mount a reconnect storm and immediately wipe the runtime.
3. The runtime map survives a reconnect (only deleted on a real `loggedOut` or
   a clean logout) so we never re-issue a pairing code for a session that is
   already linked.
4. Explicit socket options (`connectTimeoutMs`, `keepAliveIntervalMs`,
   `retryRequestDelayMs`, `maxMsgRetryCount`) so Render's NAT'd WebSockets stay
   warm.
5. Browsers tag is now `Browsers.macOS('Desktop')` — the previous value combined
   `APP_NAME` with characters that some Render nodes mis-route.

## Commands

Telegram:
- `/link 9677xxxxxxx`
- `/sessions`
- `/emoji 9677xxxxxxx ❤️`
- `/toggle 9677xxxxxxx on|off`
- `/logout 9677xxxxxxx`

WhatsApp (from inside any linked account):
- `.pair 9677xxxxxxx`
- `.emoji ❤️`
- `.status on|off`
- `.me`
- `.logout`
