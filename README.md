# Timi Bot

Timi is a Discord bot written in Rust. Verification is performed entirely inside Discord; there is no email verification website or external verification flow.

## Requirements

- Rust stable toolchain
- A Discord application and bot token
- Invite scopes: `bot` and `applications.commands`
- Enable **Server Members Intent** and **Message Content Intent** in Developer Portal → Bot → Privileged Gateway Intents
- Grant the bot the permissions required by the enabled systems: View Channels, Send Messages, Read Message History, Embed Links, Manage Channels, Manage Messages, Manage Roles, Moderate Members, View Audit Log, Kick Members and Ban Members

## Install on Termux

```sh
pkg update && pkg upgrade -y
pkg install rust git clang make pkg-config openssl -y

git clone https://github.com/lstudiolab/Timi-Bot.git
cd Timi-Bot
cp .env.example .env
nano .env

cargo build --release
./target/release/timi-bot
```

The release binary is compiled for the Android device architecture. Keep Termux active while Timi runs. A persistent shell session such as `tmux` can keep the process attached to a session.

## Configuration

Set these values in `.env`:

- `DISCORD_TOKEN`: the bot token
- `CLIENT_ID`: the Discord application ID
- `GUILD_ID`: optional development server ID; leave empty to register commands globally
- `DATA_DIR`: optional data directory; defaults to `data`
- `RUST_LOG`: optional logging filter; defaults to `info`

Never commit `.env` or share your bot token. Keep the `data/` directory backed up; it contains server configuration and recovery records.

## Commands

- `/ticket-setup` creates the ticket category and private support/log channels, then provides the ticket setup wizard.
- `/ticket-panel` publishes the configured public ticket panel.
- `/ticket-settings` opens the ticket configurator. Changes update the existing panel rather than requiring a duplicate panel message.
- `/moderation-settings` opens the moderation settings panel.
- `/verify-settings` displays or changes verification settings. Only the server owner can use it.
- `/verify-panel` publishes the verification panel. Only the server owner can use it.

Ticket configuration covers the panel title and description, open and close button labels, ticket welcome message, category name, support role, transcript channel and panel destination. A member can have one open ticket at a time, with a short creation cooldown. Closing requires confirmation and either ticket ownership or Manage Server permission. The transcript copies up to 1,000 recent messages, including attachment references, before the ticket channel is deleted.

## Protection systems

**Moderation** detects message bursts, duplicate or near-duplicate messages, Discord invite links, mass mentions, excessive capital letters and rapid link posting. Members with Manage Messages or Administrator are exempt. Configurable sanctions are timeout, kick, ban or delete-only. Invite, mention and caps filters can be toggled independently.

**Risk-based verification** uses these maximum score weights: account age 40, server history 20, verification attempts 20, recorded suspicious behavior 10 and avatar 10. Scores of 80–100 pass, 60–79 require manual review and below 60 trigger a kick. An account younger than the configured minimum is always routed to manual review and is never kicked solely because of age. A default avatar is only a weak signal. The owner can configure a verified role, a prerequisite role, a minimum account age and a review channel.

**Bot protection** temporarily restricts newly joined bots and sends approval or rejection controls to the private owner channel. New-account alerts and join-burst notifications are also sent there.

**Anti-nuke and recovery** monitor channel deletion bursts, snapshot channel settings, archive human-authored text messages for seven days and attempt to recreate deleted channels after a confirmed burst. Up to 25,000 recent messages per server are retained. Restored messages are archival copies with new message IDs. Attachment URLs are referenced rather than re-uploaded and may expire; embeds and pre-deployment history cannot be recreated.

## Data and recovery

Timi stores runtime settings and recovery records under `DATA_DIR` (default: `data`). Back up this directory before replacing the installation or moving to another device. Keep backups private because they may contain server configuration and archived message content.

## Platform limits

Discord does not expose IP addresses, device or browser fingerprints, VPN/proxy status or reliable cross-account identity to bots. Timi does not claim to inspect these signals.

Test ticket permissions and moderation thresholds in a private server before production use. Role hierarchy and bot permissions determine whether role assignment, timeout, kick, ban or quarantine actions can succeed.
