# Timi Bot

A JavaScript Discord bot with a moderation configuration panel.

## Requirements

- Node.js 20 or newer
- A Discord application and bot token
- The bot invited to your server with the `bot` and `applications.commands` scopes
- The **Message Content Intent** enabled under Developer Portal → Bot → Privileged Gateway Intents
- Bot permissions: View Channels, Read Message History, Manage Messages, Moderate Members; add Kick Members or Ban Members only if those sanctions are selected

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a local `.env` file based on `.env.example`.
3. Set `DISCORD_TOKEN`, `CLIENT_ID`, and `GUILD_ID` in `.env`.
4. Start Timi:

   ```bash
   npm start
   ```

Timi registers slash commands when it starts. When `GUILD_ID` is set, commands are registered to that test server for faster updates. If it is omitted, commands are registered globally, which can take longer to appear.

## Server setup

Run `/setup` with the Manage Server permission. Timi creates the `ticket` category if it does not exist, along with `#timi-logs` and `#timi-confirmations`. The log channel is saved as the server's moderation log destination. Timi needs Manage Channels permission. If either private channel name already exists, setup stops rather than changing existing channel permissions.

## Moderation panel

Run `/moderationconfig` in a server. You need the **Manage Server** permission.

The panel contains the controls shown in the reference:

- Module status: enable or disable the module
- Applied sanction: choose `timeout`, `kick`, `ban`, or `delete`; timeout duration is configurable in minutes
- Log Channel: select a text channel
- Action Duration: configure 1–60 seconds
- Max message count: configure 1–100 messages

Settings are saved per server in `data/moderation-settings.json` on the machine running Timi. The channel named `announcements` is selected as the initial log channel when it exists.

## Anti-spam enforcement

The moderation module checks rapid message bursts per channel and member, repeated or near-identical text, excessive mentions, and rapid link posting. Detection state is kept in bounded in-memory queues. Settings are cached in memory, so message processing does not synchronously read the JSON settings file for each message. When a trigger is detected, Timi attempts to delete recent spam messages and applies the configured timeout, kick, or ban when it has the required Discord permissions. If a sanction cannot be applied, it logs the failure to the console. Configure a log channel to receive moderation action reports.

Moderators with Manage Messages or Administrator are exempt. Timi itself is ignored, but other bot accounts are evaluated too. The detector is heuristic: test it in a private server first, because thresholds can produce false positives. Runtime detection history resets when Timi restarts; server settings remain stored in `data/moderation-settings.json` on the host.

## Security

- Never commit or share `.env`.
- Keep the real bot token private.
- If a token is exposed, reset it in the Discord Developer Portal.


## Runtime efficiency

- Moderation settings are loaded from disk once and written only when a setting changes.
- Message handling exits early for DMs, bots, moderators, and disabled moderation before normalizing content.
- Message/fingerprint/link queues are pruned from their heads and bounded to prevent unbounded per-user state.
- Anti-spam state is keyed by server, channel, and user so activity in separate channels does not count toward the same message burst.
- The private `#timi` channel is shared by bot approval requests and owner-facing moderation alerts.


## Ticket system

Run `/ticketpanel` with Manage Server permission to open the private ticket-panel configurator. Customize the public panel title, description, Open Ticket button label, the message shown inside each ticket, the Close Ticket button label, and the ticket category name. Select **Publish Panel** to post the configured panel in the current channel.

When a member opens a ticket, Timi creates a private text channel under the configured category. The channel name uses the `ticket-username` format (Discord channel names use hyphens rather than spaces). The ticket is visible to its owner and Timi; server managers can manage tickets. The Close Ticket button asks for confirmation in an ephemeral message. Confirming displays `Closing this ticket in 5 seconds…`, then deletes the ticket channel.

Timi needs Manage Channels permission to create and delete ticket channels. Ticket settings are stored per server in `data/ticket-settings.json` on the machine running Timi. Existing open tickets are identified by their channel topic to prevent a member opening duplicate tickets.


## Email verification website (Render frontend + Termux backend)

The verification website can be split across two hosts so the Discord bot and its active verification sessions stay in one process on your Android phone.

### Architecture

- **Render Static Site:** publishes the `public/` directory only. It serves the HTML, CSS, and browser JavaScript over HTTPS; it does not run the Discord bot.
- **Termux on Android:** runs `node index.js`, the Discord bot, active verification sessions, rate-limit state, and SMTP email delivery.
- **HTTPS tunnel:** exposes the local Termux HTTP server on port `3000) through a public HTTPS URL. A phone on a mobile carrier network generally cannot accept direct inbound connections, so use a tunnel.
- **Session continuity:** do not run a second bot copy on Render. Sessions are in memory and must be created and consumed by the same running Termux process.

### Configure Render Static Site

1. In Render, create a **Static Site** from `lstudiolab/Timi-Bot`, branch `main`.
2. Set the **Publish Directory** to `public`. No build command is needed.
3. After creation, copy its exact HTTPS origin, such as `https://your-timi-frontend.onrender.com`.
4. Edit `public/config.js` in GitHub and set `window.TIMI_API_BASE_URL` to the public HTTPS tunnel URL for the Termux server. Do not include a trailing slash. This file contains no secrets.
5. Set the Termux environment variables `BASE_URL` and `FRONTEND_ORIGIN` to that exact Render Static Site origin.

### Configure Termux backend

Set these values in the existing `.env` on the phone:

- `BASE_URL`: Render Static Site origin. Timi uses it to generate member-facing links such as `/verify?session=...`.
- `FRONTEND_ORIGIN`: same exact origin, with no path or trailing slash. The API uses this strict allowlist for CORS.
- `PORT=3000`
- `TRUST_PROXY=false` initially. Only enable it after confirming your chosen tunnel's forwarded-IP behavior; incorrect proxy trust can weaken rate limiting.
- SMTP settings: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `VERIFICATION_FROM`.
- `IP_HASH_SECRET`: a long random secret. Keep it stable between restarts.

Then pull the latest repository changes and install dependencies if needed:

```bash
git pull
npm install
npm start
```

Keep the bot running in Termux. Start the HTTPS tunnel in a second Termux session and forward its public URL to `http://127.0.0.1:3000`. Set the resulting public HTTPS URL in `public/config.js`, commit/push that change, and wait for Render to redeploy the static site.

### Verify the deployment

1. Open `https://YOUR-TERMUX-TUNNEL/health`. It should return JSON containing `"ok":true`.
2. Confirm the Render Static Site loads `/`, `/style.css`, `/app.js`, and `/config.js`.
3. In Discord, run `/verificationconfig` and configure the role/channel, then run `/verifypanel`.
4. Click **Verify**. The link must use the Render Static Site origin and contain a 64-character session token.
5. Submit an email address. The page should show a generic success message, and the one-time code should arrive by email. Then complete `/verifycode` in Discord.

### Security and operational limits

- The API accepts cross-origin requests only from the exact `FRONTEND_ORIGIN` configured on the Termux backend and supports CORS preflight for JSON requests.
- Email codes expire after 10 minutes, are stored as hashes, and are limited to five incorrect attempts. Verification sessions expire after 30 minutes and are stored in process memory.
- The network request limit is 20 requests in a rolling 24-hour period before a hashed network identifier is blocked for seven days. Raw IP addresses are not stored in the JSON file.
- A bot or backend restart invalidates active sessions and codes. Keep one bot process running.
- The tunnel URL must remain the same while the frontend is configured to use it. Temporary tunnel URLs change when restarted, requiring an update to `public/config.js`.
- Never put Discord tokens, SMTP passwords, or other secrets in the `public/` directory or commit them to GitHub.
