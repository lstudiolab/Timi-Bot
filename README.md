# Timi Bot

Timi is a Discord bot built with **Node.js 24+** and **discord.js 14**. It provides configurable ticket panels, private support tickets and staff threads, transcripts, moderation controls, risk-based verification, self-service role pickers, reusable embeds, bot-join approval, and best-effort channel/message recovery.

## Requirements

- Node.js 24.17.0 or newer
- npm
- A Discord application and bot token
- OAuth2 scopes: `bot` and `applications.commands`
- Enable **Server Members Intent** and **Message Content Intent** in the Discord Developer Portal.

Grant only the permissions needed for the features you enable. Timi uses View Channels, Send Messages, Read Message History, Embed Links, Attach Files, Manage Channels, Manage Messages, Manage Threads, Create Private Threads, Send Messages in Threads, Manage Roles, Moderate Members, View Audit Log, Kick Members, and Ban Members.

## Termux installation

Install Node.js LTS and Git:

```sh
pkg update
pkg install -y nodejs-lts git
```

Check that Node.js is version 24 or newer:

```sh
node --version
npm --version
```

Update the existing Timi repository and run the JavaScript setup:

```sh
cd ~/Timi-Bot
git pull origin main
node scripts/termux-setup.js
```

The setup script installs npm dependencies and runs the tests. It creates `.env` from `.env.example` only when `.env` does not already exist. Existing credentials and the `data/` directory are preserved.

## Configuration

Edit `.env` from the repository root:

```env
DISCORD_TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_application_id
GUILD_ID=
DATA_DIR=data
LOG_LEVEL=info
```

- `DISCORD_TOKEN`: Bot token from Developer Portal → Bot.
- `CLIENT_ID`: Application ID from Developer Portal → General Information.
- `GUILD_ID`: Optional development server ID. Leave blank for global slash-command registration.
- `DATA_DIR`: Persistent JSON data directory. Defaults to `data`.
- `LOG_LEVEL`: `debug`, `info`, `warn`, or `error`.

Never commit `.env` or share your bot token. If the token was exposed, reset it in the Developer Portal.

## Start Timi

```sh
cd ~/Timi-Bot
npm start
```

Timi registers its slash commands when it connects. To register them separately:

```sh
npm run deploy
```

For a persistent Termux session:

```sh
pkg install tmux
tmux new -s timi
cd ~/Timi-Bot
npm start
```

Detach with `Ctrl+B`, then `D`. Reopen with `tmux attach -t timi`. Android may still stop background processes; keep Termux exempt from battery optimization.

## Built-in libraries

Timi is one integrated bot. Its three first-party libraries are included in the same codebase; they are not external plugins or third-party modules. Each server independently chooses which libraries to activate.

- **Moderation** — moderation actions and cases, auto moderation, server protection, anti-raid and bot approval, activity archiving, and moderation logs.
- **Support** — ticket setup, configurable panels, private tickets, staff threads, transcripts, permissions, and ticket logs.
- **Foundation** — server utilities, message/embed builder, welcome and goodbye messages, role picker, and member verification.

Only the server owner can install a library. Use `/library-list` to inspect the libraries and `/install-library` with the optional `libraryname` field to activate one. A library is inactive until installed. Its data is kept when it is not installed.

## Commands

- Core: `/library-list`, `/install-library`.
- Moderation: `/moderation-settings`.
- Support: `/ticket-setup`, `/ticket-panel`, `/ticket-settings`.
- Foundation: `/ping`, `/server-info`, `/user-info`, `/avatar`, `/welcome-settings`, `/verify-settings`, `/verify-panel`, `/setup-role-picker`, `/create-embed`, `/edit-embed`, `/place-embed`.

## Data and recovery

The primary store is `data/timi.json`; `data/timi.json.bak` is the previous known-good copy. Timi migrates compatible legacy ticket, moderation, verification, and recovery JSON files when their corresponding records are missing. Invalid primary data is preserved and recovered from the backup when possible; Timi refuses to silently reset corrupted data.

Channel snapshots and up to 25,000 human-authored messages per server are retained for seven days. Recovery is best-effort: recreated messages have new IDs, attachment URLs may expire, and deleted content that was never archived cannot be reconstructed.

## Development and tests

```sh
npm run check
npm test
```

The GitHub Actions workflow performs JavaScript syntax checks and runs the Node.js test suite on pushes and pull requests to `main`.
