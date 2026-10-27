# Timi

Timi is a Discord bot written in C++20 using [D++ (DPP)](https://github.com/brainboxdotcc/DPP).

## Current commands

- `/ping` — checks that Timi is responding.
- `/about` — describes the bot and planned systems.
- `/help` — lists available commands.

## Repository layout

- `src/main.cpp` — bot startup and slash-command handlers.
- `CMakeLists.txt` — C++20 build and DPP dependency.
- `Dockerfile` — multi-stage container build.
- `render.yaml` — Render Blueprint for a persistent worker.
- `.github/workflows/build.yml` — Linux build check on pushes and pull requests.
- `.env.example` — placeholder showing the required environment variable.

## Run locally

Requirements: CMake 3.20+, a C++20 compiler, Git, and the development libraries required by DPP.

1. Copy `.env.example` to `.env` and replace the placeholder with your Discord bot token.
2. Export the variable in your terminal (do not commit the real token).
3. Build and run:

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
export DISCORD_TOKEN="your-bot-token"
./build/timi
```

Never paste your real Discord token into source code, GitHub, screenshots, or public chat. If a token has been exposed, reset it in the Discord Developer Portal.

## Discord application setup

1. Open the [Discord Developer Portal](https://discord.com/developers/applications).
2. Create an application named **Timi**, then open its **Bot** page and create the bot user.
3. Copy the bot token and store it as the `DISCORD_TOKEN` secret in your host. Do not share it in chat.
4. Under **OAuth2 → URL Generator**, select `bot` and `applications.commands`.
5. For the current starter commands, grant only the permissions needed to view channels and use application commands / send interaction responses. Avoid granting Administrator unless a feature specifically requires it.
6. Open the generated invite URL and add Timi to your test server.

The current code uses default intents and does not yet require the privileged Message Content or Server Members intents.

## Deploy on Render

The repository includes a Blueprint at [render.yaml](./render.yaml). Open the [Render Blueprint dashboard](https://dashboard.render.com/blueprints), connect this repository, review the worker plan and any charges, set `DISCORD_TOKEN` as a secret environment variable, and apply it.

A Discord gateway bot needs a continuously running process. Use a **Background Worker**, not a scheduled Cron Job. The Blueprint currently specifies the paid `starter` worker plan; review the current price in Render before creating it. The connected Render integration available to this project cannot create a background worker directly, so the Blueprint must be applied in the dashboard.

## Roadmap

- Per-server configuration and persistent storage
- Welcome and leave messages
- Embed builder and interactive buttons
- Ticket panels, ticket channels, and transcripts
- Moderation and role utilities
- Permission checks, audit logging, and safer configuration flows

Features are added in stages; the roadmap items are not implemented yet.
