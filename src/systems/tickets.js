import {
  ChannelType, PermissionFlagsBits, ButtonStyle, TextInputStyle,
  StringSelectMenuBuilder, EmbedBuilder
} from "discord.js";
import { cleanChannelName, chunkText, renderTemplate } from "../utils.js";
import { GREY, greyEmbed, button, row, textInput, modal, respond, deny, requireManager } from "../ui.js";

const P = PermissionFlagsBits;
export class Tickets {
  constructor(client, store, logger) { this.client=client; this.store=store; this.logger=logger; this.cooldowns=new Map(); this.closing=new Set(); }
  text(x) {
    return ["**Ticket Panel Configuration**","",`**Panel title:** ${x.panel_title}`,`**Panel description:** ${x.panel_description}`,
      `**Open button:** ${x.open_label}`,`**Ticket message:** ${x.ticket_message}`,`**Close button:** ${x.close_label}`,
      `**Category:** ${x.category_name}`,`**Support role:** ${x.support_role_id ? "<@&"+x.support_role_id+">" : "Not configured"}`,
      `**Transcript channel:** ${x.transcript_channel_id ? "<#"+x.transcript_channel_id+">" : "Not configured"}`,
      `**Panel channel:** ${x.panel_channel_id ? "<#"+x.panel_channel_id+">" : "Current channel"}`,
      "","Placeholders: {user}, {username}, {user_tag}, {user_id}, {server}, {server_id}, {member_count}, {channel}, {channel_name}, {owner}, {owner_id}, {bot}, {bot_name}, {date}, {time}, {timestamp}.","Edit a setting, then publish. This configuration response stays in place."].join("\n");
  }
  settingsRows() { return [
    row(button("ticket:edit-panel","Edit panel"),button("ticket:edit-ticket","Edit ticket message"),button("ticket:edit-category","Edit category")),
    row(button("ticket:edit-access","Edit support and transcript"),button("ticket:publish","Publish panel",ButtonStyle.Success))
  ]; }
  payload(x,context={}) { return {embeds:[greyEmbed(renderTemplate(x.panel_title,context),renderTemplate(x.panel_description,context))],components:[row(button("ticket:open",renderTemplate(x.open_label,context),ButtonStyle.Primary))],allowedMentions:{parse:[]}}; }
  async command(i) {
    if (!await requireManager(i)) return;
    const guild=i.guild, name=i.commandName;
    if (name==="ticket-setup") {
      const category=guild.channels.cache.find(c=>c.type===ChannelType.GuildCategory&&c.name.toLowerCase()==="ticket")
        || await guild.channels.create({name:"ticket",type:ChannelType.GuildCategory});
      for (const n of ["timi-logs","timi-confirmations"]) {
        if (guild.channels.cache.some(c=>c.type===ChannelType.GuildText&&c.name===n))
          return deny(i,`A channel named #${n} already exists. Rename or remove it, then retry. Existing permissions were not changed.`);
      }
      const bot=await guild.members.fetchMe();
      const permissionOverwrites=[
        {id:guild.id,deny:[P.ViewChannel]},
        {id:guild.ownerId,allow:[P.ViewChannel,P.SendMessages,P.ReadMessageHistory]},
        {id:i.user.id,allow:[P.ViewChannel,P.SendMessages,P.ReadMessageHistory]},
        {id:bot.id,allow:[P.ViewChannel,P.SendMessages,P.ReadMessageHistory,P.EmbedLinks,P.AttachFiles,P.ManageMessages]}
      ];
      const logs=await guild.channels.create({name:"timi-logs",type:ChannelType.GuildText,topic:"Private moderation logs for Timi.",permissionOverwrites});
      const confirm=await guild.channels.create({name:"timi-confirmations",type:ChannelType.GuildText,topic:"Private setup confirmations for Timi.",permissionOverwrites});
      this.store.mods(guild.id).log_channel_id=logs.id; this.store.save();
      await confirm.send({content:`Timi setup completed by <@${i.user.id}>. Private log channel: <#${logs.id}>.`,allowedMentions:{users:[i.user.id]}});
      return respond(i,`Setup complete. Created <#${logs.id}>, <#${confirm.id}>, and the ticket category. Configure your ticket system next.`,[row(button("ticket:wizard-start","Configure ticket system",ButtonStyle.Primary))]);
    }
    const settings=this.store.ticket(guild.id);
    if (name==="ticket-settings") return respond(i,this.text(settings),this.settingsRows());
    const dest=await this.publish(guild,i.channel,settings);
    return respond(i,`Ticket panel published or updated in <#${dest.id}>.`);
  }
  async publish(guild,current,settings) {
    // Older or manually edited data files may not contain a valid panel list.
    if(!Array.isArray(settings.published_panels)) settings.published_panels=[];
    let dest=null;
    const configuredId=String(settings.panel_channel_id||"").trim();

    if(configuredId){
      // Prefer the guild cache; only make an API request when the channel is not cached.
      if(/^\d{15,22}$/.test(configuredId)){
        dest=guild.channels.cache.get(configuredId)||null;
        if(!dest){
          try {
            dest=await guild.channels.fetch(configuredId);
          } catch(error) {
            // Discord 10003 means the saved channel was deleted or no longer exists.
            // Other fetch failures also fall back safely, but are logged distinctly.
            if(error?.code===10003||error?.status===404){
              this.logger.warn(`Saved ticket panel channel ${configuredId} no longer exists in guild ${guild.id}; using the command channel.`);
            } else {
              this.logger.warn(`Could not fetch saved ticket panel channel ${configuredId} in guild ${guild.id}; using the command channel:`,error.message);
            }
            dest=null;
          }
        }
      }

      if(!dest||!dest.isTextBased()||typeof dest.send!=="function"||dest.guildId!==guild.id){
        settings.panel_channel_id=null;
        settings.published_panels=settings.published_panels.filter(p=>p?.channel_id!==configuredId);
        this.store.data.tickets[guild.id]=settings;
        this.store.save();
        this.logger.warn(`Cleared invalid saved ticket panel destination ${configuredId} for guild ${guild.id}.`);
        dest=null;
      }
    }

    dest=dest||current;
    if(!dest?.isTextBased()||typeof dest.send!=="function"||dest.guildId!==guild.id){
      throw new Error("Run the ticket panel command in a server text channel, or configure a valid panel destination.");
    }

    const existing=settings.published_panels.find(p=>p?.channel_id===dest.id);
    if(existing){
      const oldMessage=await dest.messages.fetch(existing.message_id).catch(error=>{
        this.logger.warn(`Saved ticket panel message ${existing.message_id} is unavailable in channel ${dest.id}; a replacement will be posted:`,error.message);
        return null;
      });
      if(oldMessage){
        await oldMessage.edit(this.payload(settings,{guild,channel:dest,client:this.client}));
      }else{
        const sent=await dest.send(this.payload(settings,{guild,channel:dest,client:this.client}));
        settings.published_panels=settings.published_panels.filter(p=>p?.channel_id!==dest.id);
        settings.published_panels.push({channel_id:dest.id,message_id:sent.id});
      }
    }else{
      const sent=await dest.send(this.payload(settings,{guild,channel:dest,client:this.client}));
      settings.published_panels.push({channel_id:dest.id,message_id:sent.id});
    }

    settings.panel_channel_id=dest.id;
    this.store.data.tickets[guild.id]=settings;
    this.store.save();
    return dest;
  }
  async refresh(settings) {
    for (const p of settings.published_panels||[]) {
      try { const c=await this.client.channels.fetch(p.channel_id); const m=await c.messages.fetch(p.message_id); await m.edit(this.payload(settings,{guild:c.guild,channel:c,client:this.client})); }
      catch(e) { this.logger.warn("Could not refresh ticket panel:",e.message); }
    }
  }
  async open(i) {
    const guild=i.guild,key=guild.id+":"+i.user.id,now=Date.now();
    if (now-(this.cooldowns.get(key)||0)<10000) return deny(i,"Please wait a few seconds before opening another ticket.");
    this.cooldowns.set(key,now);
    const x=this.store.ticket(guild.id);
    const already=guild.channels.cache.find(c=>c.type===ChannelType.GuildText&&c.topic===`timi-ticket-owner:${i.user.id}`);
    if (already) return deny(i,`You already have an open ticket: <#${already.id}>.`);
    let category=guild.channels.cache.find(c=>c.type===ChannelType.GuildCategory&&c.name.toLowerCase()===x.category_name.toLowerCase());
    if (!category) category=await guild.channels.create({name:x.category_name,type:ChannelType.GuildCategory});
    let support=null;
    if (x.support_role_id) {
      support=await guild.roles.fetch(x.support_role_id).catch(()=>null);
      if (!support||support.managed) return deny(i,"The configured support role no longer exists or is managed. Update /ticket-settings first.");
    }
    const bot=await guild.members.fetchMe();
    const permissionOverwrites=[
      {id:guild.id,deny:[P.ViewChannel]},
      {id:i.user.id,allow:[P.ViewChannel,P.SendMessages,P.ReadMessageHistory,P.AttachFiles,P.EmbedLinks]},
      {id:bot.id,allow:[P.ViewChannel,P.SendMessages,P.ReadMessageHistory,P.AttachFiles,P.EmbedLinks,P.ManageChannels,P.ManageMessages,P.ManageThreads,P.CreatePrivateThreads,P.SendMessagesInThreads]}
    ];
    if(support) permissionOverwrites.push({id:support.id,allow:[P.ViewChannel,P.SendMessages,P.ReadMessageHistory,P.AttachFiles,P.EmbedLinks,P.SendMessagesInThreads]});
    const ch=await guild.channels.create({name:"ticket-"+cleanChannelName(i.user.username).slice(0,90),type:ChannelType.GuildText,parent:category.id,
      topic:`timi-ticket-owner:${i.user.id}`,permissionOverwrites});
    try {
      const templateContext={guild,user:i.user,member:i.member,channel:ch,client:this.client};
      const emb=greyEmbed(renderTemplate(x.panel_title,templateContext),renderTemplate(x.ticket_message,templateContext)).addFields({name:"Priority",value:"Normal",inline:true});
      await ch.send({content:renderTemplate("{user}",templateContext),embeds:[emb],components:[row(button("ticket:close",renderTemplate(x.close_label,templateContext),ButtonStyle.Danger),button("ticket:priority","Set priority",ButtonStyle.Primary))],allowedMentions:{users:[i.user.id]}});
    } catch(e) { await ch.delete().catch(()=>{}); throw e; }
    let note="";
    try {
      const thread=await ch.threads.create({name:"staff-"+cleanChannelName(i.user.username),type:ChannelType.PrivateThread,autoArchiveDuration:1440,invitable:false});
      await thread.send(`Private staff discussion for <#${ch.id}>. The ticket owner cannot see this thread.`);
      if(support) {
        let after;
        while(true) {
          const members=await guild.members.list({limit:1000,...(after?{after}:{})});
          if(!members.size)break;
          for(const member of members.values()) {
            if(member.roles.cache.has(support.id)&&!member.user.bot) {
              await thread.members.add(member.id).catch(error=>this.logger.warn("Could not add support member to ticket thread:",member.id,error.message));
            }
          }
          after=members.last()?.id;
          if(members.size<1000||!after)break;
        }
      }
      note=` A private staff thread was created: <#${thread.id}>.`;
    } catch(e) { note=" The ticket is open, but Timi could not create its private staff thread. Check thread permissions."; this.logger.warn("Ticket staff thread failed:",e.message); }
    await this.log(guild,`Ticket opened. Member: <@${i.user.id}>. Channel: <#${ch.id}>.`);
    return respond(i,`Your ticket is ready: <#${ch.id}>`);
  }
  async log(guild,content) {
    const x=this.store.mods(guild.id);
    const id=x.log_channel_id||guild.channels.cache.find(c=>c.name==="timi"&&c.type===ChannelType.GuildText)?.id;
    const channel=id?await guild.channels.fetch(id).catch(()=>null):null;
    if(channel?.isTextBased()) await channel.send({content,allowedMentions:{parse:[]}}).catch(e=>this.logger.warn("Ticket log failed:",e.message));
  }
  async transcript(guild,channel) {
    const x=this.store.ticket(guild.id); if(!x.transcript_channel_id) return;
    const target=await guild.channels.fetch(x.transcript_channel_id).catch(()=>null); if(!target?.isTextBased()) return;
    const all=[]; let before;
    while(all.length<1000) {
      const limit=Math.min(100,1000-all.length), batch=await channel.messages.fetch({limit,...(before?{before}:{})});
      if(!batch.size) break;
      all.push(...batch.values()); before=batch.last().id; if(batch.size<limit) break;
    }
    all.sort((a,b)=>a.createdTimestamp-b.createdTimestamp);
    let text=`Transcript for ticket #${channel.name}\n`;
    for(const m of all) {
      const files=[...m.attachments.values()].map(a=>`${a.name||"attachment"}: ${a.url}`);
      text+=`[${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${m.content||"(no text content)"}${files.length?"\nAttachments: "+files.join(" | "):""}\n`;
    }
    if(all.length>=1000) text+="\nTranscript limited to the latest 1,000 messages.";
    for(const part of chunkText(text)) await target.send({content:part,allowedMentions:{parse:[]}});
  }
  async showModal(i,action) {
    const x=this.store.ticket(i.guildId);
    const forms={
      panel:["Customize Ticket Panel",[textInput("title","Panel title",x.panel_title),textInput("description","Panel description",x.panel_description,TextInputStyle.Paragraph,true,1000),textInput("open-label","Open button label",x.open_label,TextInputStyle.Short,true,80)]],
      ticket:["Customize Ticket Message",[textInput("message","Message inside each ticket",x.ticket_message,TextInputStyle.Paragraph,true,1000),textInput("close-label","Close button label",x.close_label,TextInputStyle.Short,true,80)]],
      category:["Customize Ticket Category",[textInput("category","Category name",x.category_name,TextInputStyle.Short,true,100)]],
      access:["Support and Transcript",[textInput("support-role","Support role ID",x.support_role_id,TextInputStyle.Short,false,22),textInput("transcript","Transcript channel ID",x.transcript_channel_id,TextInputStyle.Short,false,22),textInput("panel-channel","Panel channel ID",x.panel_channel_id,TextInputStyle.Short,false,22)]]
    };
    const [title,inputs]=forms[action]; return i.showModal(modal("ticket:settings:"+action,title,inputs));
  }
  async handleButton(i) {
    const id=i.customId,g=i.guild;
    if(id==="ticket:open") return this.open(i);
    if(id==="ticket:wizard-start") {
      if(!await requireManager(i)) return;
      return i.showModal(modal("ticket:wizard:stage1","Ticket system setup",[
        textInput("ticket-name","Ticket panel name","Support Tickets"),textInput("support-role","Support role ID","",TextInputStyle.Short,false,22),
        textInput("description","Panel description","Need help? Open a ticket.",TextInputStyle.Paragraph,true,1000),
        textInput("button-label","Open button label","Open Ticket",TextInputStyle.Short,true,80),textInput("category","Ticket category name","ticket")
      ]));
    }
    if(id==="ticket:wizard-continue") {
      if(!await requireManager(i)) return;
      const x=this.store.ticket(g.id);
      return i.showModal(modal("ticket:wizard:stage2","Ticket destinations",[
        textInput("ticket-message","Message inside each ticket",x.ticket_message,TextInputStyle.Paragraph,true,1000),
        textInput("transcript-channel","Transcript channel ID",x.transcript_channel_id,TextInputStyle.Short,false,22),
        textInput("panel-channel","Panel channel ID",x.panel_channel_id,TextInputStyle.Short,false,22)
      ]));
    }
    if(id.startsWith("ticket:edit-")) {
      if(!await requireManager(i)) return;
      return this.showModal(i,id.slice(12));
    }
    if(id==="ticket:publish") {
      if(!await requireManager(i)) return;
      const dest=await this.publish(g,i.channel,this.store.ticket(g.id));
      return respond(i,`Ticket panel published or updated in <#${dest.id}>.`);
    }
    if(["ticket:close","ticket:confirm-close","ticket:cancel-close"].includes(id)) {
      const ch=i.channel,owner=ch.topic?.match(/^timi-ticket-owner:(\d+)$/)?.[1];
      if(!owner) return deny(i,"This is not a Timi ticket channel.");
      if(i.user.id!==owner&&!i.memberPermissions?.has(P.ManageGuild)) return deny(i,"Only the ticket owner or a server manager can close this ticket.");
      if(id==="ticket:close") return respond(i,"Are you sure you want to close this ticket?",[row(button("ticket:confirm-close","Yes, close it",ButtonStyle.Danger),button("ticket:cancel-close","Cancel"))]);
      if(id==="ticket:cancel-close") return respond(i,"Ticket closure cancelled.");
      const key=g.id+":"+ch.id; if(this.closing.has(key)) return deny(i,"This ticket is already closing.");
      this.closing.add(key);
      try {
        await i.update({
          content:"Closing this ticket in 5 seconds…",
          components:[row(button("ticket:confirm-close","Closing this ticket in 5 seconds…",ButtonStyle.Danger).setDisabled(true))],
          allowedMentions:{parse:[]}
        });
        await new Promise(resolve=>setTimeout(resolve,5000));
        try { await this.transcript(g,ch); } catch(e) { this.logger.warn("Ticket transcript failed:",e.message); }
        await this.log(g,`Ticket closed. Channel: <#${ch.id}>. Closed by <@${i.user.id}>.`);
        await ch.delete("Ticket closed");
      } catch(e) {
        this.logger.error("Ticket close failed:",e);
        if(i.deferred||i.replied) {
          await i.editReply({content:"Timi could not close this ticket. Check the bot's channel permissions and try again.",components:[],allowedMentions:{parse:[]}}).catch(()=>{});
        } else {
          await deny(i,"Timi could not close this ticket. Check the bot's channel permissions and try again.").catch(()=>{});
        }
      } finally { this.closing.delete(key); }
      return;
    }
    if(id==="ticket:priority") {
      const x=this.store.ticket(g.id),staff=x.support_role_id&&i.member.roles.cache.has(x.support_role_id);
      if(!staff&&!i.memberPermissions?.has(P.ManageGuild)) return deny(i,"Only support staff can change ticket priority.");
      const menu=new StringSelectMenuBuilder().setCustomId("ticket:priority-select:"+i.message.id).setPlaceholder("Select priority").setMinValues(1).setMaxValues(1)
        .addOptions({label:"Low",value:"low",emoji:"🟢"},{label:"Normal",value:"normal",emoji:"🟡",default:true},{label:"High",value:"high",emoji:"🟠"},{label:"Urgent",value:"urgent",emoji:"🔴"});
      return respond(i,"Choose the priority for this ticket.",[row(menu)]);
    }
  }
  async handleSelect(i) {
    if(!i.customId.startsWith("ticket:priority-select:")) return;
    const x=this.store.ticket(i.guildId),staff=x.support_role_id&&i.member.roles.cache.has(x.support_role_id);
    if(!staff&&!i.memberPermissions?.has(P.ManageGuild)) return deny(i,"Only support staff can change ticket priority.");
    const values={low:["Low","🟢"],normal:["Normal","🟡"],high:["High","🟠"],urgent:["Urgent","🔴"]};
    const chosen=values[i.values[0]]; if(!chosen) return deny(i,"Choose a valid priority.");
    await i.channel.setName((chosen[1]+"-"+i.channel.name.replace(/^(🟢|🟡|🟠|🔴)-/,"")).slice(0,100));
    const msg=await i.channel.messages.fetch(i.customId.slice("ticket:priority-select:".length)).catch(()=>null);
    if(msg?.embeds[0]) {
      const fields=msg.embeds[0].fields.filter(f=>f.name!=="Priority"); fields.push({name:"Priority",value:chosen[0],inline:true});
      await msg.edit({embeds:[EmbedBuilder.from(msg.embeds[0]).setColor(GREY).setFields(fields)]});
    }
    return respond(i,`Ticket priority changed to **${chosen[0]}**.`);
  }
  async handleModal(i) {
    if(!await requireManager(i)) return;
    const x=this.store.ticket(i.guildId),f=Object.fromEntries(i.fields.fields.map(v=>[v.customId,v.value.trim()]));
    if(i.customId==="ticket:wizard:stage1") {
      Object.assign(x,{panel_title:f["ticket-name"],support_role_id:f["support-role"],panel_description:f.description,open_label:f["button-label"],category_name:f.category});
      if(!x.panel_title||!x.panel_description||!x.open_label||!x.category_name||(x.support_role_id&&!/^\d{15,22}$/.test(x.support_role_id))) return deny(i,"Complete all required fields and enter a valid support role ID.");
      this.store.data.tickets[i.guildId]=x; this.store.save();
      return respond(i,"First part saved. Continue with transcript and panel destinations.",[row(button("ticket:wizard-continue","Continue setup",ButtonStyle.Primary))]);
    }
    if(i.customId==="ticket:wizard:stage2") Object.assign(x,{ticket_message:f["ticket-message"],transcript_channel_id:f["transcript-channel"],panel_channel_id:f["panel-channel"]});
    else {
      const action=i.customId.split(":")[2];
      if(action==="panel") Object.assign(x,{panel_title:f.title,panel_description:f.description,open_label:f["open-label"]});
      else if(action==="ticket") Object.assign(x,{ticket_message:f.message,close_label:f["close-label"]});
      else if(action==="category") x.category_name=f.category;
      else if(action==="access") Object.assign(x,{support_role_id:f["support-role"],transcript_channel_id:f.transcript,panel_channel_id:f["panel-channel"]});
      else return deny(i,"This ticket form is no longer available.");
    }
    for(const value of [x.support_role_id,x.transcript_channel_id,x.panel_channel_id]) if(value&&!/^\d{15,22}$/.test(value)) return deny(i,"Role and channel IDs must be valid Discord IDs.");
    if(!x.panel_title||!x.panel_description||!x.open_label||!x.ticket_message||!x.close_label||!x.category_name) return deny(i,"Ticket settings must contain text.");
    this.store.data.tickets[i.guildId]=x; this.store.save(); await this.refresh(x);
    return respond(i,this.text(x),this.settingsRows());
  }
  async handle(i) {
    if(i.isChatInputCommand()) return this.command(i);
    if(i.isButton()) return this.handleButton(i);
    if(i.isStringSelectMenu()&&i.customId.startsWith("ticket:")) return this.handleSelect(i);
    if(i.isModalSubmit()&&i.customId.startsWith("ticket:")) return this.handleModal(i);
  }
}
