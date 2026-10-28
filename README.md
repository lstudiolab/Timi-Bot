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


## Email verification website

Timi now includes a small HTTPS-hosted verification site and Discord verification flow in the same repository.

### Configure hosting and email

- Deploy this repository as a Render **Web Service**, not a worker, so it can receive web requests. The bot and website run in the same Node process.
- Add the environment variables from `.env.example` to Render. Set `BASE_URL` to the public HTTPS URL assigned to this service.
- Configure SMTP credentials for a real email provider. `VERIFICATION_FROM` must be an address authorized by that provider. Do not commit secrets.
- Use a persistent disk mounted at the repository's `data` directory if you need the JSON settings and seven-day IP blocks to survive service restarts. A database is preferable for multiple instances; this implementation is intended for one running instance.
- The website starts when a verification command is first used. `GET /health` is available for a service health check.

### Discord setup

1. Start Timi after setting the environment variables.
2. As the server owner, run `/verificationconfig role:@Verified channel:#verification`. You can also customize the panel title and description. Timi needs **Manage Roles**, and its highest role must be above the role it grants.
3. Run `/verifypanel` in the channel where the public panel should appear.
4. Members click **Verify**, open the private website link, and request a code by email.
5. In the configured verification channel, members run `/verifycode`, click **Enter verification code**, and submit the six-digit code in Discord.
6. Timi checks the code, expiration, single-use state and attempt limit, grants the configured role, and offers a private **Claim username** button. The member must type the generated username exactly in the modal.

### Abuse controls

- Email codes expire after 10 minutes and are stored as hashes rather than plaintext.
- A code can be accepted once. Verification sessions expire after 30 minutes; five incorrect attempts are allowed before the session is invalidated.
- A hashed network identifier is used for request-rate tracking. At 20 requests in a rolling 24-hour period, that network hash is blocked for seven days. The raw IP is not written to the JSON store.
- A ten-slot heuristic organizer (nine signals plus an aggregate-risk slot) flags unusual request volume, repeated email requests, failed codes, missing browser identification, rapid requests, session reuse, and network changes. Alerts are sent to the private `#timi` channel when available. Signals are heuristic and can produce false positives.
- Do not expose the service directly without HTTPS. Set `TRUST_PROXY=true` only when the app is behind a trusted reverse proxy such as Render's; otherwise leave it false. The app uses the first `X-Forwarded-For` address only when this flag is explicitly enabled.

### Important deployment note

This first implementation keeps active verification sessions in process memory. Restarting or redeploying the service invalidates in-progress verification links and codes, while saved guild settings and IP blocks are in `data/verification.json`. Use a persistent disk and a single instance for this version.
