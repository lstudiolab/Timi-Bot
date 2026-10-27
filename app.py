import asyncio, logging, os, random, time
from collections import defaultdict, deque
from datetime import timedelta
import discord
from aiohttp import web
from discord import app_commands

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("timi")
TOKEN = os.getenv("DISCORD_TOKEN", "").strip()
PORT = int(os.getenv("PORT", "10000"))
intents = discord.Intents.default()
intents.members = True
intents.message_content = True
bot = discord.Client(intents=intents)
tree = app_commands.CommandTree(bot)
settings = {}
private_channels = {}
sent_messages = defaultdict(lambda: defaultdict(lambda: defaultdict(deque)))
mention_windows = defaultdict(lambda: defaultdict(deque))
join_events = defaultdict(deque)
raid_locks = set()
synced = False

def conf(gid):
    return settings.setdefault(gid, {"enabled": True, "timeout": 10, "action_duration": 10, "threshold": 20, "log_channel": None})

async def private_channel(guild):
    # Reuse the channel after restarts/reconnects instead of creating duplicates.
    cached_id = private_channels.get(guild.id)
    ch = guild.get_channel(cached_id) if cached_id else None
    if ch:
        return ch
    ch = discord.utils.get(guild.text_channels, name="timi")
    if ch and ch.topic == "Private Timi moderation and security console":
        private_channels[guild.id] = ch.id
        return ch
    owner = guild.owner
    if owner is None:
        try:
            owner = await bot.fetch_user(guild.owner_id)
        except discord.HTTPException:
            log.exception("Unable to fetch guild owner; cannot create private Timi channel")
            return None
    overwrites = {guild.default_role: discord.PermissionOverwrite(view_channel=False)}
    if guild.me:
        overwrites[guild.me] = discord.PermissionOverwrite(view_channel=True, send_messages=True, read_message_history=True, manage_messages=True)
    overwrites[owner] = discord.PermissionOverwrite(view_channel=True, send_messages=True, read_message_history=True)
    try:
        ch = await guild.create_text_channel("timi", overwrites=overwrites, topic="Private Timi moderation and security console")
        private_channels[guild.id] = ch.id
        return ch
    except discord.HTTPException:
        log.exception("Unable to create private Timi channel in guild %s", guild.id)
        return None

async def report(guild, embed, view=None):
    ch = guild.get_channel(conf(guild.id).get("log_channel")) or await private_channel(guild)
    if ch:
        try: await ch.send(embed=embed, view=view)
        except discord.HTTPException: log.exception("Unable to send moderation report")

def config_embed(gid):
    c = conf(gid); g = bot.get_guild(gid)
    ch = g.get_channel(c["log_channel"]) if g and c["log_channel"] else None
    e = discord.Embed(title="Timi Moderation", color=discord.Color.from_rgb(90,90,96))
    e.description = "Moderation is **" + ("enabled" if c["enabled"] else "disabled") + "**."
    e.add_field(name="Timeout duration", value=f"{c['timeout']} minutes")
    e.add_field(name="Action duration", value=f"{c['action_duration']} minutes")
    e.add_field(name="Spam threshold", value=f"{c['threshold']} messages/minute/channel")
    e.add_field(name="Log channel", value=ch.mention if ch else "Private #timi (default)", inline=False)
    return e

class SettingsModal(discord.ui.Modal, title="Edit moderation settings"):
    timeout = discord.ui.TextInput(label="Timeout duration (minutes)", default="10", max_length=5)
    action_duration = discord.ui.TextInput(label="Action duration (minutes)", default="10", max_length=5)
    threshold = discord.ui.TextInput(label="Max messages per minute", default="20", max_length=3)
    def __init__(self, gid):
        super().__init__(); self.gid = gid; c=conf(gid)
        self.timeout.default=str(c["timeout"]); self.action_duration.default=str(c["action_duration"]); self.threshold.default=str(c["threshold"])
    async def on_submit(self, interaction):
        try:
            a,b,d=int(self.timeout.value),int(self.action_duration.value),int(self.threshold.value)
            if not (1<=a<=40320 and 1<=b<=40320 and 5<=d<=100): raise ValueError
        except ValueError:
            return await interaction.response.send_message("Enter whole numbers: durations 1–40320 minutes; threshold 5–100.", ephemeral=True)
        conf(self.gid).update(timeout=a, action_duration=b, threshold=d)
        await interaction.response.send_message("Settings saved for this running instance.", ephemeral=True)

class LogChannelSelect(discord.ui.ChannelSelect):
    def __init__(self,gid): super().__init__(channel_types=[discord.ChannelType.text],placeholder="Choose log channel"); self.gid=gid
    async def callback(self,interaction):
        conf(self.gid)["log_channel"]=self.values[0].id
        await interaction.response.send_message("Log channel set to "+self.values[0].mention,ephemeral=True)

class ConfigView(discord.ui.View):
    def __init__(self,gid):
        super().__init__(timeout=300); self.gid=gid; self.add_item(LogChannelSelect(gid))
    @discord.ui.button(label="Disable moderation",style=discord.ButtonStyle.danger,row=1)
    async def toggle(self,interaction,button):
        c=conf(self.gid); c["enabled"]=not c["enabled"]
        button.label="Disable moderation" if c["enabled"] else "Enable moderation"
        button.style=discord.ButtonStyle.danger if c["enabled"] else discord.ButtonStyle.success
        await interaction.response.edit_message(embed=config_embed(self.gid),view=self)
    @discord.ui.button(label="Edit settings",style=discord.ButtonStyle.secondary,row=1)
    async def edit(self,interaction,button): await interaction.response.send_modal(SettingsModal(self.gid))

@tree.command(name="moderationconfig",description="Configure Timi moderation and security.")
@app_commands.checks.has_permissions(manage_guild=True)
async def moderationconfig(interaction):
    if not interaction.guild: return await interaction.response.send_message("Use this in a server.",ephemeral=True)
    await interaction.response.send_message(embed=config_embed(interaction.guild.id),view=ConfigView(interaction.guild.id),ephemeral=True)

@tree.command(name="ping",description="Check whether Timi is responding.")
async def ping(interaction): await interaction.response.send_message("Pong. Timi is online.")

@tree.command(name="about",description="Learn what Timi is.")
async def about(interaction): await interaction.response.send_message(embed=discord.Embed(title="Timi",description="Discord moderation and security bot.",color=discord.Color.dark_grey()))

@tree.command(name="help",description="Show Timi commands.")
async def help_cmd(interaction): await interaction.response.send_message("Commands: /ping, /about, /help, /moderationconfig")

class DecisionView(discord.ui.View):
    def __init__(self,uid): super().__init__(timeout=86400); self.uid=uid
    async def act(self,i,action):
        if not i.guild or i.user.id!=i.guild.owner_id: return await i.response.send_message("Only the server owner can decide.",ephemeral=True)
        m=i.guild.get_member(self.uid)
        if not m: return await i.response.edit_message(content="Member is no longer in the server.",embed=None,view=None)
        try:
            if action=="allow": await m.timeout(None,reason="Allowed by owner after Timi review")
            elif action=="kick": await m.kick(reason="Timi moderation confirmed by owner")
            else: await m.ban(reason="Timi moderation confirmed by owner",delete_message_seconds=0)
            for item in self.children: item.disabled=True
            await i.response.edit_message(content=f"Owner decision applied: {action} for {m}.",view=self)
        except discord.HTTPException: await i.response.send_message("Action failed; check Timi permissions.",ephemeral=True)
    @discord.ui.button(label="Allow",style=discord.ButtonStyle.success)
    async def allow(self,i,b): await self.act(i,"allow")
    @discord.ui.button(label="Kick",style=discord.ButtonStyle.secondary)
    async def kick(self,i,b): await self.act(i,"kick")
    @discord.ui.button(label="Ban",style=discord.ButtonStyle.danger)
    async def ban(self,i,b): await self.act(i,"ban")

class BotApproval(discord.ui.View):
    def __init__(self,mid): super().__init__(timeout=600); self.mid=mid
    async def decide(self,i,yes):
        if not i.guild or i.user.id!=i.guild.owner_id: return await i.response.send_message("Only the server owner can decide.",ephemeral=True)
        m=i.guild.get_member(self.mid)
        if not m: return await i.response.edit_message(content="Bot no longer in server.",embed=None,view=None)
        if not yes:
            await m.kick(reason="Owner rejected bot in Timi approval")
            return await i.response.edit_message(content="Bot rejected and removed.",embed=None,view=None)
        # A bot cannot grant arbitrary server-level permissions to another bot.
        for ch in i.guild.channels:
            if ch.id==private_channels.get(i.guild.id): continue
            try: await ch.set_permissions(m,view_channel=True,read_message_history=True,send_messages=isinstance(ch,discord.TextChannel),reason="Owner approved bot access")
            except discord.HTTPException: pass
        await i.response.edit_message(content="Bot approved. Timi granted channel access where possible; server-level permissions must be configured separately.",embed=None,view=None)
    @discord.ui.button(label="Yes",style=discord.ButtonStyle.success)
    async def yes(self,i,b): await self.decide(i,True)
    @discord.ui.button(label="No",style=discord.ButtonStyle.danger)
    async def no(self,i,b): await self.decide(i,False)

@bot.event
async def on_ready():
    global synced
    log.info("Connected to Discord as %s (ID %s)",bot.user,bot.user.id if bot.user else "?")
    for g in bot.guilds: await private_channel(g)
    if not synced:
        try: await tree.sync(); synced=True; log.info("Slash commands synced")
        except Exception: log.exception("Slash command sync failed")

@bot.event
async def on_guild_join(guild): await private_channel(guild)

@bot.event
async def on_member_join(member):
    g=member.guild
    # Eight joins in ten seconds: raise Discord's verification level for one minute.
    # This is a verification barrier, not a complete server-wide lock.
    now = time.monotonic()
    jq = join_events[g.id]
    jq.append(now)
    while jq and now - jq[0] > 10:
        jq.popleft()
    if len(jq) >= 8 and g.id not in raid_locks:
        raid_locks.add(g.id)
        async def temporary_raid_barrier():
            old_level = g.verification_level
            try:
                await g.edit(verification_level=discord.VerificationLevel.high, reason="Timi detected 8 joins within 10 seconds")
                await report(g, discord.Embed(title="Join raid detected", description="At least 8 members joined within 10 seconds. Verification was raised for 1 minute.", color=discord.Color.red()))
                await asyncio.sleep(60)
                await g.edit(verification_level=old_level, reason="Timi join-raid barrier expired")
            except discord.HTTPException:
                log.exception("Could not apply join-raid verification barrier")
            finally:
                raid_locks.discard(g.id)
                jq.clear()
        asyncio.create_task(temporary_raid_barrier())
    if member.bot:
        ch=await private_channel(g)
        if ch:
            e=discord.Embed(title="Bot join approval",description=f"Do you agree on giving this bot permission to serve this server?\n\nBot: {member.mention}",color=discord.Color.orange())
            await ch.send(embed=e,view=BotApproval(member.id))
        return
    if not conf(g.id)["enabled"]: return
    if (discord.utils.utcnow()-member.created_at)<timedelta(days=7):
        try: await member.timeout(timedelta(minutes=conf(g.id)["timeout"]),reason="Account younger than 7 days; owner review required")
        except discord.HTTPException: pass
        await report(g,discord.Embed(title="New account age gate",description=f"{member.mention} is under 7 days old and was timed out pending owner review.",color=discord.Color.orange()),DecisionView(member.id))

@bot.event
async def on_message(m):
    if not m.guild: return
    c=conf(m.guild.id)
    if m.webhook_id and m.mention_everyone:
        try: await m.delete()
        except discord.HTTPException: pass
        await report(m.guild,discord.Embed(title="Webhook mass mention blocked",description=f"Deleted a webhook message attempting to ping everyone in {m.channel.mention}.",color=discord.Color.red()))
        return
    if m.author.bot or not c["enabled"]: return
    now=time.monotonic()
    # Bound the tracking map: discard expired/empty user queues and stale channels.
    guild_queues = sent_messages[m.guild.id]
    for channel_id in list(guild_queues):
        users = guild_queues[channel_id]
        for user_id in list(users):
            queue = users[user_id]
            while queue and now - queue[0][0] > 60:
                queue.popleft()
            if not queue:
                users.pop(user_id, None)
        if not users:
            guild_queues.pop(channel_id, None)
    q=sent_messages[m.guild.id][m.channel.id][m.author.id]
    q.append((now,m.id))
    while q and now-q[0][0]>60: q.popleft()
    if len(q)>=c["threshold"]:
        member=m.author if isinstance(m.author,discord.Member) else m.guild.get_member(m.author.id)
        if member:
            try: await member.timeout(timedelta(minutes=c["timeout"]),reason="Timi detected channel spam")
            except discord.HTTPException: log.exception("Spam timeout failed")
        ids=[x[1] for x in q]
        try:
            for start in range(0,len(ids),100):
                batch=[discord.Object(id=x) for x in ids[start:start+100]]
                if batch: await m.channel.delete_messages(batch)
        except discord.HTTPException: pass
        e=discord.Embed(title="Spam detected",description=f"User: {m.author.mention}\nChannel: {m.channel.mention}\nMessages: {len(ids)}\nAction: timeout for {c['timeout']} minutes.\nReason: exceeded configured messages per minute.",color=discord.Color.red(),timestamp=discord.utils.utcnow())
        await report(m.guild,e,DecisionView(m.author.id)); q.clear(); return
    # Five mention-containing messages in three seconds: timeout is supported; selective per-target revocation is not.
    if m.mentions:
        guild_mentions = mention_windows[m.guild.id]
        for user_id in list(guild_mentions):
            while guild_mentions[user_id] and now - guild_mentions[user_id][0] > 3:
                guild_mentions[user_id].popleft()
            if not guild_mentions[user_id]:
                guild_mentions.pop(user_id, None)
        mq=guild_mentions[m.author.id]; mq.append(now)
        while mq and now-mq[0]>3: mq.popleft()
        if len(mq)>=5 and isinstance(m.author,discord.Member):
            try:
                await m.author.timeout(timedelta(minutes=c["timeout"]),reason="Timi detected rapid mention spam")
                await m.delete()
                await report(m.guild,discord.Embed(title="Mention spam",description=f"{m.author.mention} sent 5 mention-containing messages in under 3 seconds and was timed out for {c['timeout']} minutes. Discord does not support revoking mentions of only one target.",color=discord.Color.red()))
            except discord.HTTPException: log.exception("Mention spam handling failed")
            mq.clear()
    text=m.content
    if len(text)>=300 and sum(ch.isupper() for ch in text)>len(text)*.25 and sum(not ch.isalnum() and not ch.isspace() for ch in text)>len(text)*.18:
        await report(m.guild,discord.Embed(title="Potential manipulation attempt",description=f"Flagged a long unusual message from {m.author.mention} in {m.channel.mention}. This is a heuristic, not proof of intent.",color=discord.Color.orange()))

@bot.event
async def on_member_update(before,after):
    if before.nick==after.nick and before.name==after.name: return
    name=(after.name+" "+(after.nick or "")).casefold()
    if any(word in name for word in ("nigger","nigga")):
        await report(after.guild,discord.Embed(title="Potentially inappropriate name",description=f"{after.mention} matched the configured name filter. Owner review required.",color=discord.Color.orange()),DecisionView(after.id))

@bot.event
async def on_guild_channel_delete(channel):
    g=channel.guild
    if not conf(g.id)["enabled"]: return
    try:
        async for entry in g.audit_logs(limit=5,action=discord.AuditLogAction.channel_delete):
            if entry.target and entry.target.id==channel.id:
                if entry.user and entry.user.id==g.owner_id: return
                recreated=None
                if isinstance(channel,discord.TextChannel):
                    recreated=await g.create_text_channel(channel.name,category=channel.category,topic=channel.topic,nsfw=channel.nsfw,reason="Timi restored deleted channel")
                elif isinstance(channel,discord.VoiceChannel):
                    recreated=await g.create_voice_channel(channel.name,category=channel.category,bitrate=channel.bitrate,user_limit=channel.user_limit,reason="Timi restored deleted channel")
                desc=f"{entry.user.mention if entry.user else 'Unknown actor'} deleted #{channel.name}. "
                desc+=f"Recreated as {recreated.mention}. Discord cannot restore deleted message history." if recreated else "Channel type could not be recreated."
                await report(g,discord.Embed(title="Channel deletion protection",description=desc,color=discord.Color.red()))
                return
    except discord.HTTPException: log.exception("Channel deletion protection failed")

async def health(_): return web.json_response({"service":"timi","status":"ok","discord_connected":bot.is_ready(),"bot_user":str(bot.user) if bot.user else None})
async def home(_): return web.json_response({"name":"Timi","message":"Timi endpoint running","health":"/health"})
async def web_server():
    app=web.Application(); app.router.add_get("/",home); app.router.add_get("/health",health)
    runner=web.AppRunner(app); await runner.setup(); await web.TCPSite(runner,"0.0.0.0",PORT).start()
    log.info("HTTP server listening on port %s",PORT); return runner

def retry_delay(e):
    headers = getattr(getattr(e, "response", None), "headers", {}) or {}
    try:
        wait = float(headers.get("Retry-After", 0))
    except (TypeError, ValueError):
        wait = 0
    # Respect Discord's Retry-After; add only a small jitter to avoid synchronized retries.
    return max(wait, 60) + random.uniform(1, 5)

async def run_bot():
    # Let discord.py manage gateway reconnects. Login-level HTTP 429 is different:
    # repeated login attempts can extend Discord's global rate limit, so wait once
    # for the server-specified Retry-After and make one controlled retry at a time.
    while not bot.is_closed():
        try:
            await bot.start(TOKEN, reconnect=True)
            return
        except discord.HTTPException as e:
            if e.status != 429:
                raise
            delay = retry_delay(e)
            log.warning("Discord login is rate-limited; sleeping %.1f seconds before a single retry.", delay)
            await asyncio.sleep(delay)
        except (discord.LoginFailure, discord.PrivilegedIntentsRequired):
            log.exception("Discord rejected the token or required intents; stopping instead of retrying forever.")
            raise

async def main():
    if not TOKEN: raise RuntimeError("DISCORD_TOKEN is missing; set it in Render environment variables.")
    runner=await web_server()
    try: await run_bot()
    finally: await bot.close(); await runner.cleanup()

if __name__=="__main__": asyncio.run(main())
