# Timi

Timi is a Discord bot written in C++20 using [D++ (DPP)](https://github.com/brainboxdotcc/DPP).

## Current starter features

- Connects to Discord using the `DISCORD_TOKEN` environment variable.
- Registers a global `/ping` slash command.
- Replies to `/ping` with a basic health response.
- Uses CMake and Docker for repeatable builds.
- Includes a Render Blueprint for a persistent background worker in Singapore.

## Run locally

Requirements: CMake 3.20+, a C++20 compiler, Git, and the development libraries required by DPP.

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
DISCORD_TOKEN="your-bot-token" ./build/timi
```

Never commit your Discord token. Set it as an environment variable or a secret in your hosting provider.

## Deploy on Render

1. Open the Render Blueprint page: https://dashboard.render.com/blueprints
2. Create a Blueprint instance from this repository.
3. Set `DISCORD_TOKEN` when prompted. Keep it secret.
4. Review the service plan and any charges before applying.
5. Apply the Blueprint and check the worker logs.

The Blueprint uses a paid `starter` worker plan because a gateway-connected Discord bot must stay running. Review current Render pricing before deployment.

## Invite permissions

Create an application in the Discord Developer Portal, add a bot, and enable the `bot` and `applications.commands` OAuth2 scopes when generating an invite. The starter only needs permission to use application commands and send interaction responses.

## Roadmap

- Per-server configuration storage
- Welcome channel and customizable greeting messages
- Embed builder and component buttons
- Ticket system
- Moderation and role utilities
- Persistent database support
