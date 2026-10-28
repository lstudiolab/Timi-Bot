# Timi Bot

A JavaScript Discord bot with a moderation configuration panel.

## Requirements

- Node.js 20 or newer
- A Discord application and bot token
- The bot invited to your server with the `bot` and `applications.commands` scopes

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

## Moderation panel

Run `/moderation-panel` in a server. You need the **Manage Server** permission.

The panel contains the controls shown in the reference:

- Module status: enable or disable the module
- Applied sanction: choose `timeout`, `kick`, `ban`, or `delete`; timeout duration is configurable in minutes
- Log Channel: select a text channel
- Action Duration: configure 1–60 seconds
- Max message count: configure 1–100 messages

Settings are saved per server in `data/moderation-settings.json` on the machine running Timi. The channel named `announcements` is selected as the initial log channel when it exists.

**Scope:** this commit implements the configuration panel and persistent settings only. It does not yet enforce a spam-detection or moderation system, or send moderation log events.

## Security

- Never commit or share `.env`.
- Keep the real bot token private.
- If a token is exposed, reset it in the Discord Developer Portal.
