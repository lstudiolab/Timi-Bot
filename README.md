# Timi Bot

Timi is a Discord bot implemented in Lua. It connects directly to Discord Gateway and REST API v10 using the Luvit runtime. Slash commands, buttons, select menus, and modals are handled by Timi's Lua interaction layer.

## Features

- Configurable ticket setup, panels, private ticket channels, private staff threads, priority selection, close confirmation, and transcripts (up to 1,000 recent messages).
- Moderation controls for message bursts, repeated messages, invite links, mass mentions, excessive caps, and rapid link posting. Sanctions can be timeout, kick, ban, or delete-only.
- Risk-based account verification with configurable verified/prerequisite roles, minimum account age, review channel, scoring, manual review, and owner-only controls.
- Temporary restrictions and owner approval/rejection when another bot joins a server.
- New-account alerts and join-burst notifications.
- Anti-nuke recovery using channel snapshots and a seven-day archive of up to 25,000 recent human-authored messages per server.
- Persistent self-service role-picker menus.
- Reusable embeds with edit-in-place updates for every message where an embed was placed.

## Requirements

- Luvi runtime (LuaJIT-based)
- Lit package manager
- A Discord application and bot token
- OAuth scopes: `bot` and `applications.commands`
- Enable Server Members Intent and Message Content Intent in the Discord Developer Portal.
- Give Timi only the permissions required for enabled features: View Channels, Send Messages, Read Message History, Embed Links, Manage Channels, Manage Messages, Manage Roles, Moderate Members, View Audit Log, Kick Members, and Ban Members.

## Install dependencies

Install Luvi and Lit for your platform. The project manifest pins the complete Luvit runtime and matching module loader. From the repository directory, install the project dependencies:

```sh
lit install
```

The package manifest installs Luvit 2.18.1 as a complete, version-matched runtime, plus HTTP and WebSocket modules.

## Termux setup (Android)

Install Git, clone Timi, and run the setup script:

```sh
pkg update
pkg install -y git
git clone https://github.com/lstudiolab/Timi-Bot.git
cd Timi-Bot
bash scripts/termux-setup.sh
```

The setup script installs `luvi` and `lit`, installs the pinned Luvit runtime and application dependencies together, and checks every Lua source file. Do not launch this project with the separately packaged system `luvit` command; use the project runtime through `luvi .`. It creates `.env` from `.env.example` only when `.env` does not already exist.

Your existing `.env` is preserved. Start Timi from the repository root with:

```sh
luvi .
```

To keep Timi running in a Termux session after closing the terminal view, use `tmux`:

```sh
pkg install tmux
tmux new -s timi
cd ~/Timi-Bot
luvi .
```

Detach with `Ctrl+B`, then `D`; return with `tmux attach -t timi`. Termux must remain installed and Android must not kill its background process.

Termux is an Android environment. It does not run natively on iOS.

## Configuration

The `.env` file is read at startup. Set `DISCORD_TOKEN` and `CLIENT_ID`. `GUILD_ID` is optional and makes slash command registration apply to one development server; leave it blank for global registration. `DATA_DIR` defaults to `data`.

Never commit `.env` or share your bot token. The `data/` directory contains server configuration, verification records, moderation cases, recovery snapshots, and message archives. Back it up before replacing an installation.

## Run

```sh
luvi .
```

Keep Termux active while Timi runs. A persistent `tmux` session can keep the process attached.

## Commands

- `/ticket-setup` creates the ticket category and private support/log channels, then opens the ticket setup wizard.
- `/ticket-panel` publishes the configured ticket panel or updates its existing message.
- `/ticket-settings` opens the ticket configurator.
- `/moderation-settings` creates or updates the moderation settings panel.
- `/verify-settings` displays or changes verification settings. Only the server owner can use it.
- `/verify-panel` publishes or updates the risk-based verification panel. Only the server owner can use it.
- `/setup-role-picker` creates another self-service role picker menu. Only the server owner can use it.
- `/create-embed`, `/edit-embed`, and `/place-embed` create, edit, and publish reusable embeds.

## Interaction behavior

Timi acknowledges non-modal interactions immediately and displays a common `Working…` state before the final response. Modal-opening actions respond with the modal directly because Discord requires a modal to be the initial interaction response. Initial callbacks are single-shot and are never retried. Runtime failures are logged; the global error handler does not replace an interaction with a generated generic error message.

## Data and recovery

The live store is `data/timi.json`, with `data/timi.json.bak` as the last-known-good copy. If the main file is invalid, Timi attempts to recover from the backup and preserves the invalid file rather than silently resetting it. On startup, old `ticket-settings.json`, `moderation-settings.json`, `verification.json`, and `recovery-backup.json` files are imported when corresponding records are missing. Keep old files until the new installation has been checked and backed up.

Channel and message recovery are best-effort Discord API operations. Restored messages are archival copies with new message IDs. Attachment URLs are references and may expire. Deleted message embeds and history from before Timi began archiving cannot be recreated. Discord does not expose member IP addresses, device fingerprints, browser fingerprints, or reliable cross-account identity to bots.

## Testing

GitHub Actions checks Lua syntax and runs the pure Lua unit tests on every push and pull request to `main`.
