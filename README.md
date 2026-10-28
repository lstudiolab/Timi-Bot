# Timi Bot

Timi is a configurable Discord bot with tickets, moderation, security monitoring, recovery backups, welcome messages, leveling, economy, and utility commands. Server configuration is stored separately per guild.

## Requirements

- Node.js 20 or newer.
- A Discord application and bot token.
- The bot invited with `bot` and `applications.commands` scopes.
- Enable **Server Members Intent** and **Message Content Intent** in Discord Developer Portal → Bot → Privileged Gateway Intents.
- Grant only the permissions needed by enabled features. Typical features use View Channels, Send Messages, Read Message History, Manage Channels, Manage Messages, Moderate Members, and optionally Kick Members / Ban Members.
- If recovery uses SQLite, the runtime must support the native `better-sqlite3` dependency and a writable persistent `data/` directory.

## Setup

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env`.
3. Set `DISCORD_TOKEN`, `CLIENT_ID`, and optionally `GUILD_ID`.
4. Run `npm start`.

Timi registers slash commands at startup. If `GUILD_ID` is set, they are registered to that server for testing; otherwise they are registered globally.

Run `/setup` with Manage Server permission to create Timi's private support/log channels and the default ticket category. Setup avoids silently changing permissions on existing channels with reserved names.

## Ticket system

- `/ticketpanel` opens the private ticket builder used to configure and publish the first public panel.
- `/panelconfig` opens the private editor for changing an existing public panel. These commands share saved per-server settings; configuration controls remain private.
- Edit the panel title, description, six-digit hexadecimal accent color, open-ticket button label, the opening message inside a ticket, close button label, and category name.
- Select up to ten support roles. These roles and server managers are granted visibility to private tickets.
- Select a text channel for transcripts. Closing a ticket sends a text transcript (messages, author names, timestamps, and attachment URLs) before deletion. The transcript feature is limited to the most recent 5,000 messages that Discord will return.
- Adjust the close delay from zero to 60 seconds.
- Publishing creates the public ticket panel. Later saved settings refresh tracked published panels.
- Members can open one ticket at a time, subject to a short per-user cooldown. Ticket channel names use the `ticket-username` format.

The bot needs Manage Channels to create and delete tickets. Transcript delivery requires View Channel, Read Message History, Send Messages, and Attach Files in the destination channel.

## Moderation

- `/moderationconfig` configures anti-spam module status, the sanction, timeout duration, the log channel, the action/detection window, message-count threshold, mention/link limits, duplicate window, and similarity threshold.
- `/moderationexempt` adds, removes, or clears role/channel exemptions from anti-spam checks.
- Available anti-spam sanctions: timeout, kick, ban, or delete messages only.
- Moderation actions are logged to the selected log channel when configured.
- `/warn` records a member warning, `/warnings` views recent warning history, and `/clearwarnings` clears a member's warnings.
- `/userinfo`, `/serverinfo`, and `/ping` provide utility information.

Anti-spam detection is heuristic, so test thresholds in a private server before relying on automatic sanctions. Moderators with Manage Messages or Administrator are exempt. Use the narrowest permissions necessary.

## Security controls

- `/securityconfig` adjusts new-account alert age, optional new-account timeouts, join-burst thresholds/windows, anti-nuke enablement, deletion thresholds/windows, and timeout duration.
- New-account timeouts are **disabled by default**. New accounts can still generate alerts for review.
- Join-burst monitoring alerts on unusually fast joins; it does not automatically punish joiners.
- Repeated channel deletion can trigger recovery of saved channel settings/messages and a timeout if Timi has sufficient permissions. Timi does not automatically strip all roles.
- Bot approval requests store pending state and snapshot existing explicit channel overwrites so the bot can restore prior permissions when the decision is made. Test this flow in a disposable server before trusting it on sensitive servers.

Security automations use Discord audit logs and permission hierarchy. They cannot override the server owner, Administrator permission, or members above Timi's role.

Use `/configreset` to reset one feature section to default settings. Ticket public panels are refreshed; leveling XP and economy balances are preserved. Warning records are not cleared by configuration resets.\n\n## Welcome messages

Use `/welcomeconfig` to enable or disable welcome messages, select the destination channel, and customize the message. Supported placeholders are `{user}`, `{username}`, `{server}`, and `{memberCount}`. Welcome messages are disabled until configured.

## Leveling

- `/levelconfig` sets whether leveling is enabled, XP per eligible message, cooldown, and the level-up channel.
- `/rank` displays a member's level and XP.
- `/leaderboard` displays the ten highest XP totals.

Leveling is disabled by default. The progression uses `level = floor(sqrt(XP / 100))`. Eligible messages award XP only after anti-spam checks.

## Economy

- `/economyconfig` adjusts whether the economy is enabled, daily and work reward ranges, and cooldowns.
- `/balance` checks balances; `/daily` claims the daily reward; `/work` earns a work reward; `/pay` transfers coins to another member.

Economy data is stored per server. Transfers validate the amount, block self-payments and bots, require the recipient to belong to the server, and reject insufficient balances.

## Recovery backups

Recovery data uses SQLite with gzip-compressed records. It retains a rolling seven-day archive within per-server storage/message caps and migrates the previous JSON backup when possible. Channel restoration is best-effort: Discord permissions, channel types, missing parent categories, thread history, attachment availability, and API limits can prevent exact recovery.

**Storage warning:** SQLite is not a substitute for durable storage. A host with an ephemeral filesystem can lose the database on redeploy or restart. Use persistent storage and periodically back up the database. Confirm native `better-sqlite3` compatibility for the actual hosting environment.

## Data and secrets

- Local runtime data goes in `data/`, which is ignored by Git.
- Never commit or share `.env`; reset a token immediately if it is exposed.
- JSON settings persist across restarts only if the host preserves the `data/` directory.
- Source-level checks and automated syntax validation do not replace live Discord integration testing. Validate permissions and configuration flows in a test server before production use.
