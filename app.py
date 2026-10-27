import asyncio
import logging
import os
import random
from typing import Awaitable, Callable, TypeVar

import discord
from aiohttp import web
from discord import app_commands

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("timi")

TOKEN = os.getenv("DISCORD_TOKEN", "").strip()
PORT = int(os.getenv("PORT", "10000"))

intents = discord.Intents.default()
bot = discord.Client(intents=intents)
tree = app_commands.CommandTree(bot)

T = TypeVar("T")
_commands_synced = False


@tree.command(name="ping", description="Check whether Timi is responding.")
async def ping(interaction: discord.Interaction):
    await interaction.response.send_message("Pong. Timi is online.")


@tree.command(name="about", description="Learn what Timi is.")
async def about(interaction: discord.Interaction):
    embed = discord.Embed(
        title="Timi",
        description="A modular Discord bot. Moderation and server tools are being built in stages.",
        color=discord.Color.from_rgb(90, 90, 95),
    )
    embed.add_field(
        name="Status",
        value="Core connection and slash commands are active.",
        inline=False,
    )
    await interaction.response.send_message(embed=embed)


@tree.command(name="help", description="Show the available Timi commands.")
async def help_command(interaction: discord.Interaction):
    embed = discord.Embed(
        title="Timi commands",
        description="Commands currently available:",
        color=discord.Color.from_rgb(90, 90, 95),
    )
    embed.add_field(name="/ping", value="Check whether Timi is responding.", inline=False)
    embed.add_field(name="/about", value="Learn what Timi is.", inline=False)
    embed.add_field(name="/help", value="Show this command list.", inline=False)
    await interaction.response.send_message(embed=embed)


@bot.event
async def on_ready():
    global _commands_synced
    log.info(
        "Connected to Discord as %s (ID: %s)",
        bot.user,
        bot.user.id if bot.user else "unknown",
    )
    if not _commands_synced:
        try:
            synced = await with_rate_limit_backoff("slash-command sync", tree.sync)
            _commands_synced = True
            log.info("Successfully synced %d global slash commands.", len(synced))
        except Exception:
            log.exception("Slash-command synchronization failed.")
            # Keep the bot connected even if command registration fails.
            # A later reconnect can retry synchronization.


async def health(_request: web.Request) -> web.Response:
    # This endpoint reports process health to Render. Keep it HTTP 200 while the
    # process is alive so a Discord API rate limit doesn't cause health-check restarts.
    return web.json_response(
        {
            "service": "timi",
            "status": "ok",
            "discord_connected": bot.is_ready(),
            "bot_user": str(bot.user) if bot.user else None,
        }
    )


async def home(_request: web.Request) -> web.Response:
    return web.json_response(
        {
            "name": "Timi",
            "message": "Timi's web endpoint is running.",
            "health": "/health",
        }
    )


async def run_web_server() -> web.AppRunner:
    app = web.Application()
    app.router.add_get("/", home)
    app.router.add_get("/health", health)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, host="0.0.0.0", port=PORT)
    await site.start()
    log.info("HTTP server listening on port %s", PORT)
    return runner


async def with_rate_limit_backoff(
    label: str,
    operation: Callable[[], Awaitable[T]],
) -> T:
    """Honor Discord's Retry-After header and avoid rapid retries on HTTP 429."""
    backoff = 60.0
    while True:
        try:
            return await operation()
        except discord.HTTPException as error:
            if error.status != 429:
                raise

            response = getattr(error, "response", None)
            headers = getattr(response, "headers", {}) or {}
            retry_after = 0.0
            for header in ("Retry-After", "X-RateLimit-Reset-After"):
                try:
                    retry_after = max(retry_after, float(headers.get(header, 0)))
                except (TypeError, ValueError):
                    continue

            # Honor Discord's full delay; do not cap it and retry too early.
            wait_seconds = max(retry_after, backoff, 30.0) + random.uniform(1.0, 5.0)
            is_global = str(headers.get("X-RateLimit-Global", "")).lower() == "true"
            scope = "global" if is_global else "route or global"
            log.warning(
                "Discord HTTP 429 during %s (%s limit). Retry-After=%s; "
                "waiting %.1f seconds before retry. No token value is logged.",
                label,
                scope,
                headers.get("Retry-After", "not supplied"),
                wait_seconds,
            )
            await asyncio.sleep(wait_seconds)
            backoff = min(backoff * 2, 3600.0)


async def run_discord() -> None:
    # Use the documented Client lifecycle. If a transient API limit occurs during
    # login, retry login only after Discord's indicated wait instead of crashing.
    while True:
        try:
            await bot.start(TOKEN, reconnect=True)
            return
        except discord.HTTPException as error:
            if error.status != 429:
                raise
            await with_rate_limit_backoff("Discord login", lambda: _raise_same(error))
        except discord.LoginFailure:
            log.exception(
                "Discord rejected the bot token. Verify DISCORD_TOKEN in Render "
                "is the bot token from Discord Developer Portal; do not paste it into logs."
            )
            raise


async def _raise_same(error: Exception):
    raise error


async def main():
    if not TOKEN:
        raise RuntimeError(
            "DISCORD_TOKEN is missing or empty. Add it as a secret environment variable in Render."
        )

    runner = await run_web_server()
    try:
        await run_discord()
    finally:
        await bot.close()
        await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
