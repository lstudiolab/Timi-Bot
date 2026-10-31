import { Client, Events, GatewayIntentBits, Partials, REST, Routes } from "discord.js";
import { loadConfig, createLogger } from "./config.js";
import { commandData } from "./commands.js";
import { Store } from "./store.js";
import { Tickets } from "./systems/tickets.js";
import { Moderation } from "./systems/moderation.js";
import { Verification } from "./systems/verification.js";
import { RolePicker } from "./systems/role-picker.js";
import { Embeds } from "./systems/embeds.js";
import { Protection } from "./systems/protection.js";
import { Recovery } from "./systems/recovery.js";

const config=loadConfig();
const logger=createLogger(config.logLevel);
const store=new Store(config.dataDir,logger);
const client=new Client({
  intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMembers,GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent],
  partials:[Partials.Channel,Partials.Message,Partials.GuildMember]
});
const tickets=new Tickets(client,store,logger);
const moderation=new Moderation(client,store,logger);
const verification=new Verification(client,store,logger);
const rolePicker=new RolePicker(client,store,logger,verification);
const embeds=new Embeds(client,store,logger);
const protection=new Protection(client,store,logger);
const recovery=new Recovery(client,store,logger);

async function registerCommands(){
  const rest=new REST({version:"10"}).setToken(config.token);
  const route=config.guildId?Routes.applicationGuildCommands(config.clientId,config.guildId):Routes.applicationCommands(config.clientId);
  const registered=await rest.put(route,{body:commandData});
  logger.info(`Registered ${registered.length} slash commands ${config.guildId?"in guild "+config.guildId:"globally"}.`);
}

client.once(Events.ClientReady,async ready=>{
  logger.info(`Logged in as ${ready.user.tag}`);
  try{await registerCommands();}catch(error){logger.error("Slash command registration failed:",error);}
  for(const guild of ready.guilds.cache.values()){
    await protection.ready(guild);
    for(const channel of guild.channels.cache.values())recovery.snapshot(channel);
  }
});

async function handleInteraction(interaction){
  if(interaction.isChatInputCommand()){
    if(interaction.commandName.startsWith("ticket-"))return tickets.handle(interaction);
    if(interaction.commandName==="moderation-settings")return moderation.handle(interaction);
    if(["verify-settings","verify-panel"].includes(interaction.commandName))return verification.handle(interaction);
    if(interaction.commandName==="setup-role-picker")return rolePicker.handle(interaction);
    if(["create-embed","edit-embed","place-embed"].includes(interaction.commandName))return embeds.handle(interaction);
    return;
  }
  const id=interaction.customId||"";
  if(id.startsWith("ticket:"))return tickets.handle(interaction);
  if(id.startsWith("modpanel:"))return moderation.handle(interaction);
  if(id.startsWith("verify:")||id.startsWith("botguard:"))return verification.handle(interaction);
  if(id.startsWith("rolepicker:"))return rolePicker.handle(interaction);
  if(id.startsWith("embed:"))return embeds.handle(interaction);
}

client.on(Events.InteractionCreate,async interaction=>{
  try{await handleInteraction(interaction);}
  catch(error){
    logger.error(`Interaction ${interaction.id} failed:`,error);
    if(!interaction.isRepliable())return;
    const payload={content:"Timi could not complete that action. Check the bot permissions and try again.",components:[],allowedMentions:{parse:[]}};
    if(interaction.deferred||interaction.replied)await interaction.editReply(payload).catch(()=>{});
    else await interaction.reply({...payload,ephemeral:true}).catch(()=>{});
  }
});

client.on(Events.MessageCreate,message=>{
  try{recovery.backupMessage(message);}catch(error){logger.error("Message archive failed:",error);}
  moderation.onMessage(message).catch(error=>logger.error("Message moderation failed:",error));
});
client.on(Events.GuildMemberAdd,member=>protection.memberJoin(member).catch(error=>logger.error("Member join protection failed:",error)));
client.on(Events.GuildMemberRemove,member=>{
  const record=store.member(member.guild.id,member.id);record.leaves=(record.leaves||0)+1;store.save();
});
client.on(Events.ChannelCreate,channel=>recovery.snapshot(channel));
client.on(Events.ChannelUpdate,(_old,channel)=>recovery.snapshot(channel));
client.on(Events.ChannelDelete,channel=>recovery.onChannelDelete(channel).catch(error=>logger.error("Channel recovery failed:",error)));
client.on(Events.Error,error=>logger.error("Discord client error:",error));
process.on("unhandledRejection",error=>logger.error("Unhandled promise rejection:",error));
function shutdown(signal){
  logger.info(`Received ${signal}; shutting down Timi.`);
  try{store.save();}catch(error){logger.error("Final data save failed:",error);}
  client.destroy();
  process.exit(0);
}
process.once("SIGINT",()=>shutdown("SIGINT"));
process.once("SIGTERM",()=>shutdown("SIGTERM"));

try{await client.login(config.token);}
catch(error){
  logger.error("Timi could not log in. Check DISCORD_TOKEN and the bot application settings:",error);
  process.exitCode=1;
}
