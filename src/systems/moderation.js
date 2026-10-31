import { PermissionFlagsBits, ButtonStyle, TextInputStyle, ChannelType, ChannelSelectMenuBuilder } from "discord.js";
import { normalizeMessage, jaccard, mentionChannel } from "../utils.js";
import { button,row,textInput,modal,respond,deny,requireManager } from "../ui.js";

const P=PermissionFlagsBits;
export class Moderation {
  constructor(client,store,logger){this.client=client;this.store=store;this.logger=logger;this.spam=new Map();this.warningRetention=30*86400000;this.processingJobs=new Set();this.jobTimer=null;}
  async resumeJobs(guild){
    const jobs=this.store.data.moderation_jobs[guild.id]||[];
    for(const job of jobs)if(job.status!=="completed"&&job.status!=="cancelled")await this.processJob(guild,job);
    this.scheduleJobs(guild);
  }
  scheduleJobs(guild,delay=30000){
    if(this.jobTimer)clearTimeout(this.jobTimer);
    this.jobTimer=setTimeout(()=>this.resumeJobs(guild).catch(error=>this.logger.error("Moderation job recovery failed:",error)),delay);
    this.jobTimer.unref?.();
  }
  async processJob(guild,job){
    if(this.processingJobs.has(job.id)||job.status==="completed"||job.status==="cancelled")return;
    this.processingJobs.add(job.id);
    try{
      job.status="processing";job.updated_at=Date.now();this.store.save();
      if(!job.steps.deleted){
        const channel=await guild.channels.fetch(job.channel_id).catch(()=>null);
        if(channel?.isTextBased()){
          const ids=(job.message_ids||[]).filter(Boolean);
          if(ids.length>1)await channel.bulkDelete(ids,true).catch(async()=>{for(const id of ids){const message=await channel.messages.fetch(id).catch(()=>null);if(message)await message.delete().catch(()=>{});}});
          else if(ids[0]){const message=await channel.messages.fetch(ids[0]).catch(()=>null);if(message)await message.delete().catch(()=>{});}
        }
        job.steps.deleted=true;job.updated_at=Date.now();this.store.save();
      }
      if(!job.steps.sanction){
        const member=await guild.members.fetch(job.user_id).catch(()=>null);
        if(member){
          if(job.action==="timeout")await member.timeout(job.timeout_minutes*60000,job.reason);
          else if(job.action==="kick")await member.kick(job.reason);
          else if(job.action==="ban")await guild.members.ban(job.user_id,{deleteMessageSeconds:Math.min(60,job.action_duration_seconds),reason:job.reason});
        }
        job.steps.sanction=true;job.updated_at=Date.now();this.store.save();
      }
      if(!job.steps.logged){
        await this.log(guild,`Anti-spam action: ${job.action_result}. Automatic warning #${job.warning_id} issued to <@${job.user_id}>. Channel: <#${job.channel_id}>. Reason: ${job.reason}.`);
        job.steps.logged=true;job.updated_at=Date.now();this.store.save();
      }
      job.status="completed";job.completed_at=Date.now();job.updated_at=Date.now();
      const jobs=this.store.data.moderation_jobs[guild.id]||[];
      const completed=jobs.filter(v=>v.status==="completed").sort((a,b)=>(b.completed_at||0)-(a.completed_at||0));
      const keep=new Set(completed.slice(0,200).map(v=>v.id));
      this.store.data.moderation_jobs[guild.id]=jobs.filter(v=>v.status!=="completed"||keep.has(v.id));
      this.store.save();
    }catch(error){
      job.status="pending";job.attempts=(job.attempts||0)+1;job.last_error=String(error?.message||error).slice(0,500);job.updated_at=Date.now();
      this.store.save();this.logger.error(`Moderation job ${job.id} failed; it will be retried:`,error);
      this.scheduleJobs(guild,Math.min(300000,10000*2**Math.min(job.attempts,5)));
    }finally{this.processingJobs.delete(job.id);}
  }
  async enqueueJob(guild,job){
    this.store.data.moderation_jobs[guild.id]||=[];
    this.store.data.moderation_jobs[guild.id].push(job);this.store.save();
    await this.processJob(guild,job);
  }
  text(x){return ["**Timi Moderation Settings**","",`**Module:** ${x.enabled?"Active":"Inactive"}`,`**Sanction:** ${x.sanction}`,
    `**Timeout duration:** ${x.timeout_minutes} minute(s)`,`**Log channel:** ${mentionChannel(x.log_channel_id)}`,
    `**Action duration:** ${x.action_duration_seconds} second(s)`,`**Maximum messages:** ${x.max_message_count}`,
    `**Block Discord invites:** ${x.block_invites}`,`**Block mass mentions:** ${x.block_mass_mentions}`,
    `**Block excessive caps:** ${x.block_excessive_caps}`].join("\n");}
  rows(x){return [
    row(button(x.enabled?"modpanel:disable":"modpanel:enable",x.enabled?"Disable":"Enable",x.enabled?ButtonStyle.Danger:ButtonStyle.Success),
      button("modpanel:sanction","Edit sanction"),button("modpanel:log","Set log channel")),
    row(button("modpanel:duration","Action duration"),button("modpanel:max-count","Max messages")),
    row(button("modpanel:invites","Toggle invites"),button("modpanel:mentions","Toggle mentions"),button("modpanel:caps","Toggle caps"))
  ];}
  async refresh(guild,x){
    if(!x.panel_channel_id||!x.panel_message_id)return;
    try{const c=await guild.channels.fetch(x.panel_channel_id),m=await c.messages.fetch(x.panel_message_id);await m.edit({content:this.text(x),components:this.rows(x)});}
    catch(e){this.logger.warn("Could not update moderation panel:",e.message);}
  }
  async command(i){
    if(i.commandName!=="moderation-settings")return;
    if(!await requireManager(i))return;
    const x=this.store.mods(i.guildId);
    if(x.panel_channel_id&&x.panel_message_id){
      try{const c=await i.guild.channels.fetch(x.panel_channel_id),m=await c.messages.fetch(x.panel_message_id);
        await m.edit({content:this.text(x),components:this.rows(x)});return respond(i,"The existing moderation settings panel was updated.");}
      catch{x.panel_channel_id="";x.panel_message_id="";}
    }
    const sent=await i.channel.send({content:this.text(x),components:this.rows(x),allowedMentions:{parse:[]}});
    x.panel_channel_id=i.channelId;x.panel_message_id=sent.id;this.store.save();
    return respond(i,"A persistent moderation settings panel was created in this channel.");
  }
  async component(i){
    if(!await requireManager(i))return;
    const id=i.customId,x=this.store.mods(i.guildId);
    if(id==="modpanel:sanction")return i.showModal(modal("modpanel:sanction-modal","Edit applied sanction",[
      textInput("sanction","Sanction: timeout, kick, ban, delete",x.sanction,TextInputStyle.Short,true,12),
      textInput("timeout-minutes","Timeout duration in minutes",String(x.timeout_minutes),TextInputStyle.Short,true,5)]));
    if(id==="modpanel:duration"||id==="modpanel:max-count"){
      const duration=id==="modpanel:duration";
      return i.showModal(modal(duration?"modpanel:duration-modal":"modpanel:max-count-modal",duration?"Edit action duration":"Edit max message count",[
        textInput("value",duration?"Action duration in seconds":"Maximum message count",String(duration?x.action_duration_seconds:x.max_message_count),TextInputStyle.Short,true,3)]));
    }
    if(id==="modpanel:log"){
      const select=new ChannelSelectMenuBuilder().setCustomId("modpanel:log-select").setPlaceholder("Select a log channel")
        .setChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1);
      return respond(i,"Select the channel where moderation logs should be sent.",[row(select)]);
    }
    if(id==="modpanel:enable"||id==="modpanel:disable")x.enabled=id==="modpanel:enable";
    else if(id==="modpanel:log-select")x.log_channel_id=i.channels.first()?.id||"";
    else if(id==="modpanel:invites")x.block_invites=!x.block_invites;
    else if(id==="modpanel:mentions")x.block_mass_mentions=!x.block_mass_mentions;
    else if(id==="modpanel:caps")x.block_excessive_caps=!x.block_excessive_caps;
    else return deny(i,"This moderation control is no longer available.");
    this.store.data.moderation[i.guildId]=x;this.store.save();await this.refresh(i.guild,x);
    return respond(i,this.text(x),this.rows(x));
  }
  async modalSubmit(i){
    if(!await requireManager(i))return;
    const x=this.store.mods(i.guildId),f=Object.fromEntries(i.fields.fields.map(v=>[v.customId,v.value.trim()]));
    if(i.customId==="modpanel:sanction-modal"){
      const action=f.sanction.toLowerCase(),minutes=Number(f["timeout-minutes"]);
      if(!["timeout","kick","ban","delete"].includes(action))return deny(i,"Use timeout, kick, ban, or delete.");
      if(!Number.isInteger(minutes)||minutes<1||minutes>40320)return deny(i,"Timeout must be 1–40320 minutes.");
      x.sanction=action;x.timeout_minutes=minutes;
    }else{
      const n=Number(f.value);
      if(i.customId==="modpanel:duration-modal"){if(!Number.isInteger(n)||n<1||n>60)return deny(i,"Action duration must be 1–60 seconds.");x.action_duration_seconds=n;}
      else if(i.customId==="modpanel:max-count-modal"){if(!Number.isInteger(n)||n<1||n>100)return deny(i,"Maximum message count must be 1–100.");x.max_message_count=n;}
      else return deny(i,"This moderation form is no longer available.");
    }
    this.store.data.moderation[i.guildId]=x;this.store.save();await this.refresh(i.guild,x);
    return respond(i,this.text(x),this.rows(x));
  }
  async log(guild,content){
    const x=this.store.mods(guild.id);
    let channel=x.log_channel_id?await guild.channels.fetch(x.log_channel_id).catch(()=>null):null;
    if(!channel)channel=guild.channels.cache.find(c=>c.name==="timi"&&c.type===ChannelType.GuildText);
    if(channel?.isTextBased())await channel.send({content,allowedMentions:{parse:[]}}).catch(()=>{});
  }
  async warn(guild,user,reason){
    const now=Date.now(),cases=this.store.data.moderation_cases[guild]||[];
    const kept=cases.filter(v=>v.type!=="warning"||now-(v.created_at||now)<=this.warningRetention);
    const id=kept.reduce((max,v)=>Math.max(max,Number(v.id)||0),0)+1;
    kept.push({id,type:"warning",user_id:user,moderator_id:"timi",reason,created_at:now,automatic:true});
    this.store.data.moderation_cases[guild]=kept;this.store.save();return id;
  }
  async onMessage(message){
    if(!message.guild||message.author.bot)return;
    const guild=message.guild;
    const member=message.member||await guild.members.fetch(message.author.id).catch(()=>null);
    if(!member)return;
    if(message.author.id===guild.ownerId||member.permissions.has(P.Administrator)||member.permissions.has(P.ManageMessages))return;
    const x=this.store.mods(guild.id);if(!x.enabled)return;
    const content=message.content||"",lower=content.toLowerCase();
    for(const word of this.store.data.automod_words[guild.id]||[]){
      if(word&&lower.includes(word.toLowerCase())){
        const reason="blocked word or phrase: "+word;await message.delete().catch(()=>{});
        const record=this.store.member(guild.id,message.author.id);record.suspicious++;record.last_suspicious=Date.now();record.last_reason=reason;
        const warning=await this.warn(guild.id,message.author.id,reason);
        await this.log(guild,`AutoMod removed a message from <@${message.author.id}> in <#${message.channelId}>. Automatic warning #${warning}. Reason: ${reason}.`);
        return;
      }
    }
    const key=`${guild.id}:${message.channelId}:${message.author.id}`,now=Date.now();
    const recent=(this.spam.get(key)||[]).filter(v=>now-v.at<=20000);
    const normalized=normalizeMessage(content),links=(content.match(/https?:\/\/\S+/g)||[]).length;
    const letters=content.match(/[a-z]/gi)||[],caps=letters.length>=12&&letters.filter(c=>c===c.toUpperCase()).length/letters.length>=.75;
    const mentionCount=message.mentions.users.size+message.mentions.roles.size;
    recent.push({id:message.id,at:now,content:normalized,links});while(recent.length>100)recent.shift();this.spam.set(key,recent);
    const window=recent.filter(v=>now-v.at<=8000),repeated=window.some(v=>v.id!==message.id&&normalized.length>=4&&jaccard(normalized,v.content)>=.88);
    const invite=/discord\.gg\/|discord(?:app)?\.com\/invite\//i.test(content);
    const linkCount=window.reduce((n,v)=>n+v.links,0);
    let reason;
    if(window.length>=Math.max(2,x.max_message_count))reason="message burst";
    else if(repeated)reason="repeated or near-identical message";
    else if(x.block_mass_mentions&&(message.mentions.everyone||mentionCount>=5))reason="mass mention or mention spam";
    else if(x.block_invites&&invite)reason="unapproved Discord invite link";
    else if(x.block_excessive_caps&&caps)reason="excessive capital letters";
    else if(links>=4||linkCount>=5)reason="link spam";
    if(!reason)return;
    this.spam.delete(key);
    const record=this.store.member(guild.id,message.author.id);record.suspicious++;record.last_suspicious=Date.now();record.last_reason=reason;
    const warning=await this.warn(guild.id,message.author.id,reason);
    let actionResult="messages deleted";
    if(x.sanction==="timeout")actionResult=`timed out for ${x.timeout_minutes} minute(s)`;
    else if(x.sanction==="kick")actionResult="kicked";
    else if(x.sanction==="ban")actionResult="banned";
    const job={id:`automod:${guild.id}:${message.id}`,type:"automod-sanction",status:"pending",
      guild_id:guild.id,user_id:message.author.id,channel_id:message.channelId,message_ids:window.map(v=>v.id),
      reason,warning_id:warning,action:x.sanction,action_result:actionResult,timeout_minutes:x.timeout_minutes,
      action_duration_seconds:x.action_duration_seconds,steps:{deleted:false,sanction:false,logged:false},
      attempts:0,created_at:Date.now(),updated_at:Date.now()};
    await this.enqueueJob(guild,job);
  }
  async onMessageDelete(message){
    if(message.partial)message=await message.fetch().catch(()=>null);
    if(!message?.guild||message.author?.bot)return;
    await this.log(message.guild,`Message deleted in <#${message.channelId}> by <@!${message.author.id}>. Content: ${(message.content||"(no text content)").slice(0,1200)}`);
  }
  async onMessageUpdate(oldMessage,newMessage){
    if(newMessage.partial)newMessage=await newMessage.fetch().catch(()=>null);
    if(!newMessage?.guild||newMessage.author?.bot)return;
    const before=oldMessage.content||"",after=newMessage.content||"";
    if(before===after)return;
    await this.log(newMessage.guild,`Message edited in <#${newMessage.channelId}> by <@!${newMessage.author.id}>. Before: ${before.slice(0,600)||"(empty)"} | After: ${after.slice(0,600)||"(empty)"}`);
  }
  async onMemberUpdate(oldMember,newMember){
    const before=new Set(oldMember.roles.cache.keys()),after=new Set(newMember.roles.cache.keys());
    const added=[...after].filter(id=>!before.has(id)).map(id=>`<@&${id}>`);
    const removed=[...before].filter(id=>!after.has(id)).map(id=>`<@&${id}>`);
    const changes=[];
    if(oldMember.nickname!==newMember.nickname)changes.push(`Nickname: ${oldMember.nickname||"none"} → ${newMember.nickname||"none"}`);
    if(added.length)changes.push("Roles added: "+added.join(", "));
    if(removed.length)changes.push("Roles removed: "+removed.join(", "));
    if(changes.length)await this.log(newMember.guild,`Member update for <@!${newMember.id}>: ${changes.join("; ")}`);
  }
  async onBan(guild,user,removed=false){
    await this.log(guild,`Member ${removed?"unbanned":"banned"}: <@!${user.id}> (${user.tag||user.id}).`);
  }
  async wordCommand(i){
    if(!await requireManager(i))return;
    const action=i.options.getSubcommand(),phrase=i.options.getString("phrase")?.trim();
    const words=this.store.data.automod_words[i.guildId]||[];
    if(action==="list")return respond(i,words.length?"**Blocked words and phrases**\n"+words.map((word,index)=>`${index+1}. ${word}`).join("\n"):"No blocked words or phrases are configured.");
    if(!phrase)return deny(i,"Enter a non-empty word or phrase.");
    const index=words.findIndex(word=>word.toLowerCase()===phrase.toLowerCase());
    if(action==="add"){
      if(index!==-1)return deny(i,"That word or phrase is already blocked.");
      if(words.length>=100)return deny(i,"The blocked phrase list is full (100 entries).");
      words.push(phrase);this.store.data.automod_words[i.guildId]=words;this.store.save();
      return respond(i,`Added **${phrase}** to the blocked phrase list.`);
    }
    if(action==="remove"){
      if(index===-1)return deny(i,"That word or phrase is not in the blocked list.");
      words.splice(index,1);this.store.data.automod_words[i.guildId]=words;this.store.save();
      return respond(i,`Removed **${phrase}** from the blocked phrase list.`);
    }
  }
  async handle(i){
    if(i.isChatInputCommand()&&i.commandName==="moderation-settings")return this.command(i);
    if(i.isChatInputCommand()&&i.commandName==="automod-word")return this.wordCommand(i);
    if(i.isButton()&&i.customId.startsWith("modpanel:"))return this.component(i);
    if(i.isChannelSelectMenu()&&i.customId==="modpanel:log-select")return this.component(i);
    if(i.isModalSubmit()&&i.customId.startsWith("modpanel:"))return this.modalSubmit(i);
  }
}
