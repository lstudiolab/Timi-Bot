# Timi Bot

A minimal JavaScript Discord bot scaffold. No bot features have been added yet.

## Requirements

- Node.js 20 or newer
- A Discord application and bot token

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a local `.env` file based on `.env.example`.
3. Put your bot token in `DISCORD_TOKEN`.
4. Start Timi:

   ```bash
   npm start
   ```

## Security

- Never commit or share `.env`.
- Keep the real bot token private.
- If a token is exposed, reset it in the Discord Developer Portal.

## Current status

Only the basic Discord client startup and login are implemented. Commands, moderation, logging, and other features have not been added.
