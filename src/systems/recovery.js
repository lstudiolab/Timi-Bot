import { AuditLogEvent, ChannelType, PermissionFlagsBits } from "discord.js";
import { nowMs, snowflakeTime, DAY } from "../utils.js";

const WEEK=7*DAY,MAX_MESSAGES=25000;
export class Recovery {
  constructor(client,store,logger){this.client=client;this.store=store;this.logger=logger;this.deletions=new Map();}
  snapshot(channel) {
    if(!channel.guild||!channel.id)return;
    const permissions=channel.permissionOverwrites?.cache?.map(o=>({
      id:o.id,type:o.type,allow:o.allow.bitfield.toString(),deny:o.deny.bitfield.toString()
    }))||[];
    this.store.data.channels[channel.guild.id+":"+channel.id]={
      id:channel.id,name:channel.name,type:channel.type,topic:channel.topic??null,
      parent_id:channel.parentId??null,position:channel.position??0,nsfw:channel.nsfw??false,
      rate_limit_per_user:channel.rateLimitPerUser??0,bitrate:channel.bitrate??null,
      user_limit:channel.userLimit??null,permission_overwrites:permissions
    };
    this.store.queueSave();
  }
  backupMessage(message) {
    if(!message.guild||message.author.bot||(!message.content&&message.attachments.size===0))return;
    const guild=message.guild.id;
    const list=this.store.data.messages[guild]||[];this.store.data.messages[guild]=list;
    list.push({
      id:message.id,channel_id:message.channelId,author_id:message.author.id,author_tag:message.author.tag,
      content:(message.content||"").slice(0,4000),timestamp_ms:message.createdTimestamp,
      attachments:[...message.attachments.values()].slice(0,10).map(a=>({name:a.name,url:a.url,content_type:a.contentType,size:a.size}))
    });
    const cutoff=nowMs()-WEEK;
    this.store.data.messages[guild]=list.filter(m=>(m.timestamp_ms||0)>=cutoff).slice(-MAX_MESSAGES);
    this.store.queueSave();
  }
  async findLogChannel(guild) {
    return guild.channels.cache.find(c=>c.type===ChannelType.GuildText&&c.name==="timi")||null;
  }
  async onChannelDelete(channel) {
    if(!channel.guild)return;
    const guild=channel.guild,id=channel.id;
    await new Promise(resolve=>setTimeout(resolve,1200));
    const audit=await guild.fetchAuditLogs({type:AuditLogEvent.ChannelDelete,limit:8}).catch(()=>null);
    const entry=audit?.entries.find(e=>e.target?.id===id);
    const actor=entry?.executor;
    if(!actor||actor.id===guild.ownerId||actor.id===this.client.user.id||actor.bot)return;
    const key=guild.id+":"+actor.id,now=Date.now();
    const entries=(this.deletions.get(key)||[]).filter(item=>now-item.at<=60000);
    entries.push({at:now,id});
    this.deletions.set(key,entries);
    const log=await this.findLogChannel(guild);
    if(log)await log.send({content:`Security alert: a moderator or member deleted #${channel.name||"unknown"} (${id}). ${entries.length} channel deletion(s) in 60 seconds.`});
    if(entries.length<3)return;

    let restored=0;
    for(const item of entries) {
      const snapshot=this.store.data.channels[guild.id+":"+item.id];
      if(!snapshot) {
        if(log)await log.send({content:`Recovery incomplete: no saved channel configuration exists for deleted channel ID ${item.id}.`});
        continue;
      }
      const overwrites=(snapshot.permission_overwrites||[]).map(o=>({
        id:o.id,allow:BigInt(o.allow||"0"),deny:BigInt(o.deny||"0"),type:o.type
      }));
      const options={
        name:snapshot.name,type:snapshot.type,topic:snapshot.topic??undefined,
        parent:snapshot.parent_id??undefined,position:snapshot.position,
        nsfw:snapshot.nsfw,rateLimitPerUser:snapshot.rate_limit_per_user,
        permissionOverwrites:overwrites,reason:"Timi anti-nuke channel recovery"
      };
      if(snapshot.type===ChannelType.GuildVoice){options.bitrate=snapshot.bitrate;options.userLimit=snapshot.user_limit;}
      try {
        const created=await guild.channels.create(options);restored++;
        const archive=(this.store.data.messages[guild.id]||[])
          .filter(m=>m.channel_id===item.id&&m.timestamp_ms>=nowMs()-WEEK)
          .sort((a,b)=>a.timestamp_ms-b.timestamp_ms);
        for(const message of archive) {
          const attachments=(message.attachments||[]).map(f=>`${f.name||"attachment"}: ${f.url||""}`).join(" | ");
          const text=`[Recovered archive • original message ${message.id} • <t:${Math.floor(message.timestamp_ms/1000)}:F>]\nAuthor ID: ${message.author_id}\n${message.content||"(no text content)"}${attachments?"\nAttachments: "+attachments:""}`;
          await created.send({content:text.slice(0,1900),allowedMentions:{parse:[]} }).catch(()=>{});
        }
        snapshot.deletedAt=nowMs();this.store.queueSave();
      } catch(error) { this.logger.error("Could not restore deleted channel",item.id,error); }
    }

    const actorMember=await guild.members.fetch(actor.id).catch(()=>null);
    const botMember=await guild.members.fetchMe();
    if(!actorMember||actorMember.user.bot){this.deletions.delete(key);return;}
    const botTop=botMember.roles.highest.position,actorTop=actorMember.roles.highest.position;
    const canModerate=botMember.permissions.has(P.ModerateMembers)||botMember.permissions.has(P.Administrator);
    const canManage=botMember.permissions.has(P.ManageRoles)||botMember.permissions.has(P.Administrator);
    if(!canModerate||!canManage||actorTop>=botTop) {
      if(log)await log.send({content:`Critical anti-nuke alert: channel recovery recreated ${restored} of ${entries.length} deleted channel(s), but Timi could not quarantine <@${actor.id}>. Permissions or role hierarchy are insufficient. Manually review the audit log.`});
      this.deletions.delete(key);return;
    }
    let timeoutOk=true;
    try { await actorMember.timeout(60*60*1000,"Timi anti-nuke: deleted multiple channels within 60 seconds"); }
    catch { timeoutOk=false; }
    let removed=0;
    for(const role of actorMember.roles.cache.values()) {
      if(role.id===guild.id||role.managed||role.position>=botTop)continue;
      if(await actorMember.roles.remove(role).then(()=>true).catch(()=>false))removed++;
    }
    if(log)await log.send({content:`Anti-nuke recovery finished: recreated ${restored} of ${entries.length} deleted channel(s). <@${actor.id}> ${timeoutOk?"timed out for 60 minutes":"could not be timed out"}; removed ${removed} manageable role(s). Reposted archives are copies with new message IDs; attachment source links may expire.`});
    this.deletions.delete(key);
  }
}
