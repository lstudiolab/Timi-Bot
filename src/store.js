import fs from "node:fs";
import path from "node:path";
import { fillDefaults } from "./utils.js";

const defaults=()=>({
  tickets:{},moderation:{},verification:{},members:{},channels:{},messages:{},
  role_picker_menus:{},role_picker_drafts:{},embeds:{},moderation_cases:{},automod_words:{},pending_bots:{}
});
function readJson(file){
  try{if(!fs.existsSync(file))return null;const value=JSON.parse(fs.readFileSync(file,"utf8"));
    return value&&typeof value==="object"&&!Array.isArray(value)?value:null;}catch{return null;}
}
function renameFields(value,mapping){
  if(!value||typeof value!=="object")return false;
  let changed=false;
  for(const [oldKey,newKey] of Object.entries(mapping)){
    if(value[newKey]===undefined&&value[oldKey]!==undefined){value[newKey]=value[oldKey];changed=true;}
    if(oldKey!==newKey&&value[oldKey]!==undefined){delete value[oldKey];changed=true;}
  }
  return changed;
}
function normalizePanels(value){
  let changed=renameFields(value,{publishedPanels:"published_panels"});
  for(const panel of value.published_panels||[])if(renameFields(panel,{channelId:"channel_id",messageId:"message_id"}))changed=true;
  return changed;
}
function normalizeData(data){
  let changed=false;
  for(const value of Object.values(data.tickets||{})){
    if(renameFields(value,{panelTitle:"panel_title",panelDescription:"panel_description",openButtonLabel:"open_label",
      ticketMessage:"ticket_message",closeButtonLabel:"close_label",categoryName:"category_name",supportRoleId:"support_role_id",
      transcriptChannelId:"transcript_channel_id",panelChannelId:"panel_channel_id"}))changed=true;
    if(normalizePanels(value))changed=true;
  }
  for(const value of Object.values(data.moderation||{})){
    if(renameFields(value,{timeoutMinutes:"timeout_minutes",logChannelId:"log_channel_id",actionDurationSeconds:"action_duration_seconds",
      maxMessageCount:"max_message_count",blockInvites:"block_invites",blockMassMentions:"block_mass_mentions",
      blockExcessiveCaps:"block_excessive_caps",panelChannelId:"panel_channel_id",panelMessageId:"panel_message_id"}))changed=true;
  }
  for(const value of Object.values(data.verification||{})){
    if(renameFields(value,{roleId:"role_id",requiredRoleId:"required_role_id",reviewChannelId:"review_channel_id",
      minAccountAgeDays:"min_age_days",panelTitle:"panel_title",panelDescription:"panel_description",pointMax:"points"}))changed=true;
    if(normalizePanels(value))changed=true;
  }
  for(const value of Object.values(data.members||{})){
    if(renameFields(value,{verificationAttempts:"attempts",failedChecks:"failed",suspiciousMessages:"suspicious",
      lastJoinAt:"last_join",lastVerifiedAt:"last_verified",lastSuspiciousAt:"last_suspicious",
      lastSuspiciousReason:"last_reason"}))changed=true;
  }
  for(const value of Object.values(data.embeds||{})){
    if(renameFields(value,{guildId:"guild_id",creatorId:"creator_id"}))changed=true;
    for(const p of value.placements||[])if(renameFields(p,{channelId:"channel_id",messageId:"message_id"}))changed=true;
  }
  return changed;
}
function migrateLegacy(data,dir){
  let changed=false;
  for(const [file,key] of [["ticket-settings.json","tickets"],["moderation-settings.json","moderation"]]){
    const old=readJson(path.join(dir,file));if(!old)continue;
    for(const [guild,value] of Object.entries(old))if(data[key][guild]===undefined){data[key][guild]=value;changed=true;}
  }
  const verification=readJson(path.join(dir,"verification.json"));
  if(verification){
    for(const [guild,value] of Object.entries(verification.guilds||{}))if(!data.verification[guild]){data.verification[guild]=value;changed=true;}
    for(const [key,value] of Object.entries(verification.members||{}))if(!data.members[key]){data.members[key]=value;changed=true;}
  }
  const recovery=readJson(path.join(dir,"recovery-backup.json"));
  if(recovery?.guilds)for(const [guild,value] of Object.entries(recovery.guilds)){
    for(const [channel,snapshot] of Object.entries(value.channels||{})){
      const key=guild+":"+channel;if(!data.channels[key]){data.channels[key]=snapshot;changed=true;}
    }
    for(const message of value.messages||[]){
      const item={id:String(message.id||""),channel_id:String(message.channelId||message.channel_id||""),
        author_id:String(message.authorId||message.author_id||""),content:message.content||"",
        timestamp_ms:Number(message.createdAt||message.timestamp_ms)||0,attachments:message.attachments||[]};
      data.messages[guild]||=[];
      if(!data.messages[guild].some(old=>old.id===item.id)){data.messages[guild].push(item);changed=true;}
    }
  }
  return changed;
}

export class Store{
  constructor(dataDir,logger){
    this.dataDir=dataDir;this.file=path.join(dataDir,"timi.json");this.backup=path.join(dataDir,"timi.json.bak");
    this.logger=logger;this.data=defaults();
    const hasMain=fs.existsSync(this.file),hasBackup=fs.existsSync(this.backup);
    if(hasMain){
      const primary=readJson(this.file);
      if(primary)this.data=fillDefaults(primary,defaults());
      else if(hasBackup){
        const recovered=readJson(this.backup);
        if(!recovered)throw new Error("Both data/timi.json and its backup are invalid; refusing to reset bot data.");
        const corrupt=this.file+".corrupt-"+Date.now();fs.renameSync(this.file,corrupt);
        this.data=fillDefaults(recovered,defaults());this.logger.warn("Recovered bot data from backup; preserved invalid file at",corrupt);
      }else throw new Error("data/timi.json is invalid and no backup exists; refusing to reset bot data.");
    }else if(hasBackup){
      const recovered=readJson(this.backup);if(!recovered)throw new Error("data/timi.json is missing and backup is invalid.");
      this.data=fillDefaults(recovered,defaults());
    }
    let changed=migrateLegacy(this.data,dataDir);
    if(normalizeData(this.data))changed=true;
    if(changed){this.save();this.logger.info("Imported or normalized legacy Timi settings and recovery data.");}
  }
  save(){
    const temp=this.file+".tmp";
    if(fs.existsSync(this.file)&&readJson(this.file))fs.copyFileSync(this.file,this.backup);
    fs.writeFileSync(temp,JSON.stringify(this.data,null,2),{mode:0o600});
    fs.renameSync(temp,this.file);
  }
  queueSave(){
    if(this.pendingSave)return;
    this.pendingSave=setTimeout(()=>{this.pendingSave=null;try{this.save();}catch(error){this.logger.error("Deferred data save failed:",error);}},750);
    this.pendingSave.unref?.();
  }
  ticket(guild){
    this.data.tickets[guild]||={};
    return fillDefaults(this.data.tickets[guild],{
      panel_title:"Support Tickets",panel_description:"Need help? Open a ticket and our team will assist you.",
      open_label:"Open Ticket",ticket_message:"Please describe what you need help with. A member of the support team will be with you shortly.",
      close_label:"Close Ticket",category_name:"ticket",support_role_id:"",transcript_channel_id:"",panel_channel_id:"",published_panels:[]
    });
  }
  mods(guild){
    this.data.moderation[guild]||={};
    return fillDefaults(this.data.moderation[guild],{enabled:true,sanction:"timeout",timeout_minutes:10,log_channel_id:"",
      action_duration_seconds:3,max_message_count:3,block_invites:true,block_mass_mentions:true,block_excessive_caps:true,
      panel_channel_id:"",panel_message_id:""});
  }
  verify(guild){
    this.data.verification[guild]||={};
    const value=fillDefaults(this.data.verification[guild],{
      role_id:"",required_role_id:"",review_channel_id:"",min_age_days:7,panel_title:"Verify your account",
      panel_description:"Press Verify to have Timi assess your account and server history.",published_panels:[],
      points:{age:40,history:20,attempts:20,behavior:10,avatar:10},thresholds:{pass:80,review:60}
    });
    value.points=fillDefaults(value.points||{},{age:40,history:20,attempts:20,behavior:10,avatar:10});
    value.thresholds=fillDefaults(value.thresholds||{},{pass:80,review:60});return value;
  }
  member(guild,user){
    const key=guild+":"+user;this.data.members[key]||={};
    return fillDefaults(this.data.members[key],{joins:0,leaves:0,attempts:[],failed:0,suspicious:0,last_join:0,
      last_verified:0,last_suspicious:0,last_reason:""});
  }
  embed(guild,name){
    const value=this.data.embeds[guild+":"+name];if(!value)return null;
    return fillDefaults(value,{guild_id:guild,name,creator_id:"",title:"",description:"",color:8421504,author:"",
      footer:"",thumbnail:"",image:"",url:"",fields:[],placements:[]});
  }
  saveEmbed(value){this.data.embeds[value.guild_id+":"+value.name]=value;this.save();}
}
