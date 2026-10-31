import { PermissionFlagsBits, ButtonStyle } from "discord.js";
import { DAY, snowflakeTime, mentionRole, mentionChannel } from "../utils.js";
import { greyEmbed, button, row, respond, deny, requireOwner, isManager } from "../ui.js";

const P=PermissionFlagsBits;
export class Verification {
  constructor(client,store,logger){this.client=client;this.store=store;this.logger=logger;}
  async validateRole(guild,role,assignable){
    if(!role||role.id===guild.id||role.managed)return [false,"Choose a normal server role other than @everyone or an integration role."];
    if(!assignable)return [true];
    const me=await guild.members.fetchMe();
    if(!me.permissions.has(P.ManageRoles))return [false,"Timi needs Manage Roles permission."];
    if(role.position>=me.roles.highest.position)return [false,"Move Timi's highest role above the selected role."];
    return [true];
  }
  score(guild,user,member,s){
    const record=this.store.member(guild.id,user),now=Date.now();
    const age=Math.max(0,(now-snowflakeTime(user))/DAY),minimum=Number(s.min_age_days)||0,ageFailed=age<minimum;
    const factor=ageFailed?0:minimum===0||age/minimum>=4?1:age/minimum>=2?.95:age/minimum>=1.5?.9:age/minimum>=1.2?.8:.7;
    const p=s.points,agePoints=Math.round(p.age*factor);
    const historyPoints=Math.round(p.history-Math.min(Math.max(0,record.leaves-1)*p.history*.2+record.failed*p.history*.15,p.history));
    const attempts=record.attempts.filter(t=>now-t<=600000);attempts.push(now);record.attempts=attempts;
    const attemptFactor=attempts.length===1?1:attempts.length===2?.9:attempts.length===3?.8:attempts.length<=5?.7:.6;
    const attemptPoints=Math.round(p.attempts*attemptFactor);
    const behaviorFactor=record.suspicious===0?1:record.suspicious===1?.65:record.suspicious<=3?.3:0;
    const behaviorPoints=Math.round(p.behavior*behaviorFactor),avatarPoints=member.user.avatar?p.avatar:Math.round(p.avatar*.25);
    const checks=[
      {name:"Account age",points:agePoints,max:p.age,reason:ageFailed?`Account is ${age.toFixed(1)} days old; minimum is ${minimum} days.`:`Account age: ${age.toFixed(1)} days.`},
      {name:"Server history",points:historyPoints,max:p.history,reason:`${record.joins} joins, ${record.leaves} leaves, ${record.failed} previous failed checks.`},
      {name:"Verification attempts",points:attemptPoints,max:p.attempts,reason:`${attempts.length} attempt(s) in the last 10 minutes.`},
      {name:"Message behavior",points:behaviorPoints,max:p.behavior,reason:`${record.suspicious} suspicious event(s). ${record.last_reason}`},
      {name:"Avatar",points:avatarPoints,max:p.avatar,reason:member.user.avatar?"Custom avatar present.":"Default avatar; weak signal only."}
    ];
    this.store.save();return {score:agePoints+historyPoints+attemptPoints+behaviorPoints+avatarPoints,checks,ageFailed};
  }
  async log(guild,channelId,content){
    let ch=channelId?await guild.channels.fetch(channelId).catch(()=>null):null;
    if(!ch)ch=guild.channels.cache.find(c=>c.name==="timi"&&c.isTextBased());
    if(ch?.isTextBased())await ch.send({content,allowedMentions:{parse:[]}}).catch(()=>{});
  }
  settingsText(s){
    return `**Timi verification settings**\nVerified role: ${mentionRole(s.role_id)}\nRequired role: ${mentionRole(s.required_role_id)}\nMinimum account age: ${s.min_age_days} days\nReview channel: ${mentionChannel(s.review_channel_id)}\nThresholds: 80+ pass, 60–79 manual review, below 60 kick\nWeights: age 40, history 20, attempts 20, behavior 10, avatar 10`;
  }
  async command(i){
    if(!await requireOwner(i))return;
    const guild=i.guild,s=this.store.verify(guild.id);
    if(i.commandName==="verify-panel"){
      const existing=s.published_panels.find(p=>p.channel_id===i.channelId);
      const payload={embeds:[greyEmbed(s.panel_title,s.panel_description)],components:[row(button("verify:start","Verify",ButtonStyle.Primary))]};
      if(existing){
        const msg=await i.channel.messages.fetch(existing.message_id).catch(()=>null);
        if(msg)await msg.edit(payload);else{const sent=await i.channel.send(payload);existing.message_id=sent.id;}
      }else{const sent=await i.channel.send(payload);s.published_panels.push({channel_id:i.channelId,message_id:sent.id});}
      this.store.data.verification[guild.id]=s;this.store.save();
      return respond(i,existing?"Existing verification panel updated.":"Risk-based verification panel published.");
    }
    const role=i.options.getRole("role"),required=i.options.getRole("required-role");
    const clear=i.options.getBoolean("clear-required-role"),age=i.options.getInteger("min-age-days");
    const review=i.options.getChannel("review-channel"),title=i.options.getString("title"),description=i.options.getString("description");
    if(!role&&!required&&!clear&&age===null&&!review&&title===null&&description===null)return respond(i,this.settingsText(s));
    if(role){const [ok,msg]=await this.validateRole(guild,role,true);if(!ok)return deny(i,msg);s.role_id=role.id;}
    if(required){const [ok,msg]=await this.validateRole(guild,required,false);if(!ok)return deny(i,msg);s.required_role_id=required.id;}
    if(clear)s.required_role_id="";
    if(age!==null)s.min_age_days=Math.max(0,Math.min(3650,age));
    if(review)s.review_channel_id=review.id;
    if(title!==null)s.panel_title=title.trim()||"Verify your account";
    if(description!==null)s.panel_description=description.trim()||"Press Verify to have Timi assess your account and server history.";
    this.store.data.verification[guild.id]=s;this.store.save();
    for(const p of s.published_panels){
      const ch=await guild.channels.fetch(p.channel_id).catch(()=>null);
      const msg=await ch?.messages.fetch(p.message_id).catch(()=>null);
      await msg?.edit({embeds:[greyEmbed(s.panel_title,s.panel_description)],components:[row(button("verify:start","Verify",ButtonStyle.Primary))]}).catch(()=>{});
    }
    return respond(i,"Verification settings saved. Existing panels have been refreshed.");
  }
  async verify(i){
    const guild=i.guild,user=i.user,s=this.store.verify(guild.id),record=this.store.member(guild.id,user.id);
    if(record.last_verified>0)return deny(i,"You have already completed verification. Each member can verify only once in this server.");
    const member=await guild.members.fetch(user.id);
    if(s.role_id&&member.roles.cache.has(s.role_id))return deny(i,"You are already verified.");
    if(s.required_role_id&&!member.roles.cache.has(s.required_role_id))return deny(i,"You cannot start verification yet. You must first have the configured required role.");
    const {score,checks,ageFailed}=this.score(guild,user.id,member,s);
    const outcome=ageFailed?"review":score>=s.thresholds.pass?"pass":score>=s.thresholds.review?"review":"kick";
    const detail=checks.map(v=>`**${v.name}:** ${v.points}/${v.max} — ${v.reason}`).join("\n");
    if(outcome==="pass"){
      if(!s.role_id)return deny(i,`Your score is ${score}/100, but the server owner has not configured a verified role.`);
      await member.roles.add(s.role_id,"Timi verification passed");record.last_verified=Date.now();this.store.save();
      await respond(i,`**Verification passed — ${score}/100**\nYour verified role has been assigned.`);
      await this.log(guild,s.review_channel_id,`Verification passed for <@${user.id}> — **${score}/100**\n${detail}`);
    }else if(outcome==="review"){
      await respond(i,`**Manual review required — ${score}/100**\n${ageFailed?"Your account does not meet the server's minimum age requirement. ":""}A moderator must review your verification.`);
      await this.log(guild,s.review_channel_id,`**Verification requires manual review**\nMember: <@${user.id}>\nScore: **${score}/100**\n${detail}`);
    }else{
      await respond(i,`**Verification failed — ${score}/100**\nYour account did not meet the server's risk threshold.`);
      await member.kick("Timi verification failed").catch(error=>this.logger.warn("Verification kick failed:",error.message));
      record.failed++;this.store.save();
      await this.log(guild,s.review_channel_id,`**Verification failed; kick attempted**\nMember: <@${user.id}>\nScore: **${score}/100**\n${detail}`);
    }
  }
  async botDecision(i){
    const match=i.customId.match(/^botguard:(yes|no):(\d+):(\d+)$/);
    if(!match)return deny(i,"This bot approval control is invalid.");
    const [,decision,guildId,botId]=match,guild=await this.client.guilds.fetch(guildId);
    if(guild.ownerId!==i.user.id&&!isManager(i))return deny(i,"Only the server owner or a member with Manage Server can decide.");
    const key=guildId+":"+botId,pending=this.store.data.pending_bots[key];
    if(pending!==i.message.id)return deny(i,"This request is no longer pending.");
    if(decision==="no"){
      await guild.members.kick(botId,"Bot rejected by server owner");
      delete this.store.data.pending_bots[key];this.store.save();
      return respond(i,"Bot rejected and removed from the server.");
    }
    for(const channel of guild.channels.cache.values()){
      if(channel.permissionOverwrites.cache.has(botId)&&!["timi","timi-logs","timi-confirmations"].includes(channel.name))
        await channel.permissionOverwrites.delete(botId).catch(()=>{});
    }
    delete this.store.data.pending_bots[key];this.store.save();
    return respond(i,"Bot approved. Temporary restrictions were removed; private Timi channels remain inaccessible.");
  }
  async handle(i){
    if(i.isChatInputCommand()&&["verify-settings","verify-panel"].includes(i.commandName))return this.command(i);
    if(i.isButton()&&i.customId==="verify:start")return this.verify(i);
    if(i.isButton()&&i.customId.startsWith("botguard:"))return this.botDecision(i);
  }
}
