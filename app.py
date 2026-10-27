import asyncio
import os
import logging
from aiohttp import web
import discord
from discord import app_commands

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("timi")

TOKEN = os.getenv("DISCORD_TOKEN")
PORT = int(os.getenv("PORT", "10000"))

intents = discord.Intents.default()
bot = discord.Client(intents=intents)
tree = app_commands.CommandTree(bot)


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
    embed.add_field(name="Status", value="Core connection and slash commands are active.", inline=False)
    await interaction.response.send_message(embed=embed)


@tree.command(name="help", description="Show the available Timi commands.")
async def help_command(interaction: discord.Interaction):
    embed = discord.Embed(
        title="Timi commands",
        description="Commands currently available:",
        color=discord.Color.from_rgb(90, 90, 95),
    )
    embed.add_field(name="/ping", value="Check whether Timi is responding.", inline=False)
    embed.add_field(name="/about", value="Learn about Timi.", inline=False)
    embed.add_field(name="/help", value="Show this command list.", inline=False)
    await interaction.response.send_message(embed=embed)


@bot.event
async def on_ready():
    log.info("Connected to Discord as %s (ID: %s)", bot.user, bot.user.id if bot.user else "unknown")


async def health(_request: web.Request) -> web.Response:
    user = str(bot.user) if bot.user else None
    return web.json_response({
        "service": "timi",
        "status": "ok" if bot.is_ready() else "starting",
        "discord_connected": bot.is_ready(),
        "bot_user": user,
    })


async def home(_request: web.Request) -> web.Response:
    return web.json_response({
        "name": "Timi",
        "message": "Timi's web endpoint is running.",
        "health": "/health",
    })


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


async def main():
    if not TOKEN:
        raise RuntimeError("DISCORD_TOKEN is missing. Add it as a secret environment variable in Render.")

    runner = await run_web_server()
    try:
        # Sync application commands once at startup. Global command propagation can take a little time.
        await bot.login(TOKEN)
        await tree.sync()
        await bot.connect(reconnect=True)
    finally:
        await bot.close()
        await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
