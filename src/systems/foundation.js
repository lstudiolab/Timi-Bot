import { ChannelType, EmbedBuilder } from "discord.js";
import { respond, deny, requireManager } from "../ui.js";

export class Foundation {
  constructor(client,store,logger){this.client=client;this.store=store;this.logger=logger;}
  settings(guildId){
    this.store.data.welcome[guildId] ||= {welcome_channel_id:"",welcome_message:"Welcome {user} to {server}! You are member #{member_count}.",goodbye_channel_id:"",goodbye_message:"{username} has left {server}."};
    return this.store.data.welcome[guildId];
  }
  async command(i){
    if(i.commandName==="ping")return respond(i,`Pong. Gateway latency: ${this.client.ws.ping} ms.`);
    if(i.commandName==="server-info"){
      const g=i.guild;
      const embed=new EmbedBuilder().setColor(0x808080).setTitle(g.name).setThumbnail(g.iconURL({size:256}))
        .addFields({name:"Owner",value:`<@!${g.ownerId}>`.replace("$",""),inline:true},
          {name:"Members",value:String(g.memberCount),inline:true},{name:"Channels",value:String(g.channels.cache.size),inline:true},
          {name:"Created",value:`<t:${Math.floor(g.createdTimestamp/1000)}:F>`});
      return respond(i,null,[],[embed]);
    }
    if(i.commandName==="user-info"){
      const user=i.options.getUser("user")||i.user,member=await i.guild.members.fetch(user.id).catch(()=>null);
      const embed=new EmbedBuilder().setColor(0x808080).setTitle(user.tag).setThumbnail(user.displayAvatarURL({size:256}))
        .addFields({name:"User ID",value:user.id},{name:"Account created",value:`<t:${Math.floor(user.createdTimestamp/1000)}:F>`},
          {name:"Joined server",value:member?`<t:${Math.floor(member.joinedTimestamp/1000)}:F>`:"Not a server member"});
      return respond(i,null,[],[embed]);
    }
    if(i.commandName==="avatar"){
      const user=i.options.getUser("user")||i.user;
      const embed=new EmbedBuilder().setColor(0x808080).setTitle(`${user.username}'s avatar`).setImage(user.displayAvatarURL({size:1024}));
      return respond(i,null,[],[embed]);
    }
    if(i.commandName==="welcome-settings"){
      if(!await requireManager(i))return;
      const s=this.settings(i.guildId);
      const welcomeChannel=i.options.getChannel("welcome-channel"),goodbyeChannel=i.options.getChannel("goodbye-channel");
      const welcomeMessage=i.options.getString("welcome-message"),goodbyeMessage=i.options.getString("goodbye-message");
      if(welcomeChannel)s.welcome_channel_id=welcomeChannel.id;
      if(goodbyeChannel)s.goodbye_channel_id=goodbyeChannel.id;
      if(welcomeMessage!==null)s.welcome_message=welcomeMessage;
      if(goodbyeMessage!==null)s.goodbye_message=goodbyeMessage;
      this.store.save();
      return respond(i,`**Welcome and goodbye settings saved.**\nWelcome channel: ${s.welcome_channel_id?`<#${s.welcome_channel_id}>`:"Disabled"}\nGoodbye channel: ${s.goodbye_channel_id?`<#${s.goodbye_channel_id}>`:"Disabled"}\n\nAvailable placeholders: `{user}`, `{username}`, `{server}`, `{member_count}`.`);
    }
  }
  render(template,member){
    return String(template||"").replaceAll("{user}",`<@${member.id}>`)
      .replaceAll("{username}",member.user.username).replaceAll("{server}",member.guild.name)
      .replaceAll("{member_count}",String(member.guild.memberCount));
  }
  async memberAdd(member){
    const s=this.settings(member.guild.id);if(!s.welcome_channel_id)return;
    const channel=await member.guild.channels.fetch(s.welcome_channel_id).catch(()=>null);
    if(channel?.type===ChannelType.GuildText)await channel.send({content:this.render(s.welcome_message,member),allowedMentions:{users:[member.id]}});
  }
  async memberRemove(member){
    const s=this.settings(member.guild.id);if(!s.goodbye_channel_id)return;
    const channel=await member.guild.channels.fetch(s.goodbye_channel_id).catch(()=>null);
    if(channel?.type===ChannelType.GuildText)await channel.send({content:this.render(s.goodbye_message,member),allowedMentions:{parse:[]}});
  }
}
