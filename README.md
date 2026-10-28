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

Run `/setup` with the Manage Server permission. Timi creates `#timi-logs` and `#timi-confirmations`, both private to the server owner, the user who ran `/setup`, and Timi. The log channel is saved as the server's moderation log destination. Timi needs Manage Channels permission. If either channel name already exists, setup stops rather than changing existing channel permissions.

## Moderation panel

Run `/moderation-panel` in a server. You need the **Manage Server** permission.

The panel contains the controls shown in the reference:

- Module status: enable or disable the module
- Applied sanction: choose `timeout`, `kick`, `ban`, or `delete`; timeout duration is configurable in minutes
- Log Channel: select a text channel
- Action Duration: configure 1–60 seconds
- Max message count: configure 1–100 messages

Settings are saved per server in `data/moderation-settings.json` on the machine running Timi. The channel named `announcements` is selected as the initial log channel when it exists.

## Anti-spam enforcement

The moderation module now checks rapid message bursts, repeated or near-identical text, excessive mentions, and rapid link posting. Detection state is tracked per server and member in memory. When a trigger is detected, Timi attempts to delete recent spam messages and applies the configured timeout, kick, or ban when it has the required Discord permissions. If a sanction cannot be applied, it logs the failure to the console. Configure a log channel to receive moderation action reports.

Moderators with Manage Messages or Administrator are exempt. Timi itself is ignored, but other bot accounts are evaluated too. The detector is heuristic: test it in a private server first, because thresholds can produce false positives. Runtime detection history resets when Timi restarts; server settings remain stored in `data/moderation-settings.json` on the host.

## Security

- Never commit or share `.env`.
- Keep the real bot token private.
- If a token is exposed, reset it in the Discord Developer Portal.
