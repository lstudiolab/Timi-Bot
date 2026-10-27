# Timi Bot

Timi is a Python Discord bot built with `discord.py` and an HTTP health endpoint for Render.

## Current behavior

- Creates or reuses a private `#timi` channel when the bot is in a server.
- Provides moderation event handlers for spam, rapid mentions, webhook mass mentions, new-account age checks, suspicious long messages, name filtering, channel deletion recovery, and join-raid detection.
- Requests owner review for certain moderation events using buttons in the private channel.
- Runs a `/health` endpoint for Render health checks.

**Slash commands are currently disabled while the bot's command system is being redesigned.** Do not expect `/ping`, `/about`, `/help`, or `/moderationconfig` to be registered.

## Requirements

- Python 3.10+
- A Discord application and bot user
- A Discord bot token stored as the `DISCORD_TOKEN` environment variable
- The Server Members and Message Content privileged intents enabled in the Discord Developer Portal for the relevant features

## Run locally

Install dependencies:

```sh
python -m pip install -r requirements.txt
```

Set the token as an environment variable; never commit it to GitHub or paste it into chat.

macOS/Linux:

```sh
export DISCORD_TOKEN="your-bot-token"
python app.py
```

Windows PowerShell:

```powershell
$env:DISCORD_TOKEN="your-bot-token"
python app.py
```

## Deploy on Render

The `render.yaml` Blueprint defines a free Python Web Service in Singapore.

- Build command: `pip install -r requirements.txt`
- Start command: `python app.py`
- Health check path: `/health`
- Required environment variable: `DISCORD_TOKEN` (secret)

The HTTP health endpoint and Discord Gateway client run in one process. Render's free Web Service may spin down after inactivity, so it is not a reliable always-on host for a Discord Gateway bot. Do not use external pings to bypass the free-instance sleep policy.

## Important limitations

- Per-server settings and tracking data are currently held in memory and reset when the process restarts.
- Channel deletion recovery can recreate a channel, but Discord does not restore deleted message history or every original permission override.
- Join-raid handling raises the server verification level temporarily; it is not a complete server-wide lock.
- Discord does not support revoking one member's ability to mention only one specific target; Timi uses timeout-based handling for rapid mention spam.
- Login HTTP 429 responses are logged with available rate-limit headers and response details. Timi deliberately does not automatically retry a rate-limited initial login; investigate the response before restarting the service.
- Moderation actions depend on the bot's role hierarchy, permissions, enabled privileged intents, and Discord API availability.
