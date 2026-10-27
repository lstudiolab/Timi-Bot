# Timi

Timi is a Discord bot using Python and discord.py. The repository is configured for a Render **Web Service** with an HTTP health endpoint.

## Current commands

- `/ping` — checks whether Timi is responding.
- `/about` — describes Timi.
- `/help` — lists the current commands.

The moderation, ticket, and other server systems are not implemented yet.

## Run locally

Requires Python 3.10 or newer.

1. Install dependencies:

   ```sh
   python -m pip install -r requirements.txt
   ```

2. Set `DISCORD_TOKEN` in your environment. Never commit the real token.

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

## Discord application setup

1. Open the [Discord Developer Portal](https://discord.com/developers/applications).
2. Create or select the Timi application and create its bot user.
3. Copy the token and add it in Render as the secret environment variable `DISCORD_TOKEN`. Do not share it in chat or commit it to GitHub.
4. Under OAuth2 URL Generator, select `bot` and `applications.commands`.
5. Invite Timi to your test server. Grant only the permissions required by features actually enabled.

## Deploy on Render

The `render.yaml` Blueprint describes a free Python Web Service in Singapore. Connect this repository in Render and apply the Blueprint, or create a Web Service from this repository using:

- Runtime: Python
- Build command: `pip install -r requirements.txt`
- Start command: `python app.py`
- Health check path: `/health`
- Environment variable: `DISCORD_TOKEN` (secret)

The HTTP endpoint and Discord Gateway client run in the same Python process. **Important:** Render's free Web Service can spin down after inactivity, so this does not guarantee that Gateway-based bot features work continuously 24/7. Do not use external pings to bypass Render's free-instance sleep policy. A paid Background Worker is the better fit for an always-on Gateway bot.

## Roadmap

- Moderation configuration and logs
- Spam detection and raid response
- Bot join approval
- Mention, webhook, account-age, and naming protection
- Ticket system, embeds, buttons, and per-server settings
