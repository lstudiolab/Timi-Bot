import { Client, Events, GatewayIntentBits, Partials, REST, Routes } from "discord.js";
import { loadConfig, createLogger } from "./config.js";
import { commandsForLibraries } from "./commands.js";
import { Store } from "./store.js";
import { LibraryManager } from "./module-manager.js";
import { LIBRARIES } from "./libraries/index.js";
import { startWorking, respond } from "./ui.js";
const config=loadConfig(),logger=createLogger(config.logLevel),store=new Store(config.dataDir,logger);
const client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMembers,GatewayIntentBits.GuildModeration,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent],partials:[Partials.Channel,Partials.Message,Partials.GuildMember]});
const manager=new LibraryManager(store,logger),context={client,store,logger};
const foundation=LIBRARIES.Foundation.create(context);context.foundation=foundation;
const libraries=Object.fromEntries(Object.entries(LIBRARIES).map(([name,definition])=>[name,definition.create(context)]));
const rest=new REST({version:"10"}).setToken(config.token);
async function syncGlobalCommands(){
 const registered=await rest.put(Routes.applicationCommands(config.clientId),{body:[]});
 logger.info(`Removed ${registered.length} legacy global library commands.`);
}
async function syncGuildCommands(guildId){
 const installed=store.data.installed_libraries[guildId]||[];
 const body=commandsForLibraries(installed);
 const route=Routes.applicationGuildCommands(config.clientId,guildId);
 const registered=await rest.put(route,{body});
 logger.info(`Synced ${registered.length} slash commands for guild ${guildId}.`);
 return registered;
}
function commandLibrary(n){if(n.startsWith("ticket-"))return "Support";if(["moderation-settings","automod-word"].includes(n))return "Moderation";if(["verify-settings","verify-panel","setup-role-picker","create-embed","edit-embed","place-embed","ping","server-info","user-info","avatar","welcome-settings"].includes(n))return "Foundation";return null;}
function componentLibrary(id){if(id.startsWith("ticket:"))return "Support";if(id.startsWith("modpanel:")||id.startsWith("botguard:"))return "Moderation";if(id.startsWith("verify:")||id.startsWith("rolepicker:")||id.startsWith("embed:"))return "Foundation";return null;}
function opensModal(i){if(i.isChatInputCommand())return i.commandName==="create-embed";if(!i.isButton())return false;const id=i.customId;return id==="rolepicker:start"||id==="ticket:wizard-start"||id==="ticket:wizard-continue"||id.startsWith("ticket:edit-")||id==="modpanel:sanction"||id==="modpanel:duration"||id==="modpanel:max-count"||id.startsWith("embed:");}
async function coreCommand(i){
 if(i.commandName==="library-list"){
  const lines=manager.list().map(l=>`**${l.name}** — ${manager.installed(i.guildId,l.name)?"Installed":"Available"}\n${l.description}\nSystems: ${l.systems.join(", ")}`);
  return respond(i,"**Timi Library**\n\n"+lines.join("\n\n")+"\n\nUse /install-library and enter a libraryname.");
 }
 if(i.commandName==="uninstall-library"){
  if(i.guild.ownerId!==i.user.id)return respond(i,"Only the server owner can uninstall Timi libraries.");
  const result=manager.uninstall(i.guildId,i.options.getString("libraryname"));
  if(!result.ok)return respond(i,result.error);
  await syncGuildCommands(i.guildId);
  return respond(i,`**${result.library.name}** is now disabled in this server. Its slash commands have been removed; saved configuration and records are preserved.`);
 }
 if(i.commandName==="install-library"){
  if(i.guild.ownerId!==i.user.id)return respond(i,"Only the server owner can install Timi libraries.");
  const name=i.options.getString("libraryname");
  if(!name)return respond(i,"Enter a library name in libraryname. Available: Moderation, Support, Foundation. Use /library-list for details.");
  const result=manager.install(i.guildId,name);if(!result.ok)return respond(i,result.error);
  if(libraries[result.library.name].ready)await libraries[result.library.name].ready(i.guild);
  return respond(i,`**${result.library.name}** is installed and active in this server.\n${result.library.description}`);
 }
}
async function handleInteraction(i){
 if(i.isRepliable()&&!opensModal(i))await startWorking(i);
 if(i.isChatInputCommand()){
  if(["install-library","uninstall-library","library-list"].includes(i.commandName))return coreCommand(i);
  const required=commandLibrary(i.commandName);if(!required)return;
  if(!manager.installed(i.guildId,required))return respond(i,`The **${required}** library is not installed in this server. Ask the owner to use /install-library.`);
  return libraries[required].handleInteraction(i);
 }
 const required=componentLibrary(i.customId||"");if(!required)return;
 if(!manager.installed(i.guildId,required))return respond(i,`The **${required}** library is not installed. This control is inactive.`);
 return libraries[required].handleInteraction(i);
}
client.once(Events.ClientReady,async ready=>{
 logger.info(`Logged in as ${ready.user.tag}`);
 try{await rest.put(Routes.applicationCommands(config.clientId),{body:commandsForLibraries([])});logger.info("Registered core global slash commands.");}catch(error){logger.error("Global command sync failed:",error);}
 for(const guild of ready.guilds.cache.values()){
  try{await syncGuildCommands(guild.id);}catch(error){logger.error(`Command sync failed for guild ${guild.id}:`,error);}
  for(const [name,library] of Object.entries(libraries))if(manager.installed(guild.id,name)&&library.ready)await library.ready(guild);
 }
});
client.on(Events.InteractionCreate,async i=>{try{await handleInteraction(i);}catch(error){logger.error(`Interaction ${i.id} failed:`,error);if(!i.isRepliable())return;const p={content:"Timi could not complete that action. Check bot permissions and try again.",components:[],allowedMentions:{parse:[]}};if(i.deferred||i.replied)await i.editReply(p).catch(()=>{});else await i.reply({...p,ephemeral:true}).catch(()=>{});}});
client.on(Events.MessageCreate,m=>{if(manager.installed(m.guildId,"Moderation"))libraries.Moderation.messageCreate(m).catch(e=>logger.error("Moderation message processing failed:",e));});
client.on(Events.MessageDelete,m=>{if(m.guild&&manager.installed(m.guild.id,"Moderation"))libraries.Moderation.messageDelete(m).catch(e=>logger.error("Message delete log failed:",e));});
client.on(Events.MessageUpdate,(oldMessage,newMessage)=>{if(newMessage.guild&&manager.installed(newMessage.guild.id,"Moderation"))libraries.Moderation.messageUpdate(oldMessage,newMessage).catch(e=>logger.error("Message edit log failed:",e));});
client.on(Events.GuildMemberUpdate,(oldMember,newMember)=>{if(manager.installed(newMember.guild.id,"Moderation"))libraries.Moderation.memberUpdate(oldMember,newMember).catch(e=>logger.error("Member update log failed:",e));});
client.on(Events.GuildBanAdd,ban=>{if(manager.installed(ban.guild.id,"Moderation"))libraries.Moderation.ban(ban.guild,ban.user).catch(e=>logger.error("Ban log failed:",e));});
client.on(Events.GuildBanRemove,ban=>{if(manager.installed(ban.guild.id,"Moderation"))libraries.Moderation.ban(ban.guild,ban.user,true).catch(e=>logger.error("Unban log failed:",e));});
client.on(Events.GuildMemberAdd,m=>{
 if(manager.installed(m.guild.id,"Moderation"))libraries.Moderation.guildMemberAdd(m).catch(e=>logger.error("Member join processing failed:",e));
 if(manager.installed(m.guild.id,"Foundation")){
  if(!manager.installed(m.guild.id,"Moderation")){const r=store.member(m.guild.id,m.id);r.joins++;r.last_join=Date.now();store.save();}
  libraries.Foundation.guildMemberAdd(m).catch(e=>logger.error("Welcome message failed:",e));
 }
});
client.on(Events.GuildMemberRemove,m=>{
 if(manager.installed(m.guild.id,"Foundation")){const r=store.member(m.guild.id,m.id);r.leaves++;store.save();libraries.Foundation.guildMemberRemove(m).catch(e=>logger.error("Goodbye message failed:",e));}
});
client.on(Events.ChannelCreate,c=>{if(c.guild&&manager.installed(c.guild.id,"Moderation"))libraries.Moderation.channelCreate(c);});
client.on(Events.ChannelUpdate,(o,c)=>{if(c.guild&&manager.installed(c.guild.id,"Moderation"))libraries.Moderation.channelUpdate(o,c);});
client.on(Events.ChannelDelete,c=>{if(c.guild&&manager.installed(c.guild.id,"Moderation"))libraries.Moderation.channelDelete(c).catch(e=>logger.error("Recovery failed:",e));});
client.on(Events.Error,e=>logger.error("Discord client error:",e));process.on("unhandledRejection",e=>logger.error("Unhandled rejection:",e));
function shutdown(signal){logger.info(`Received ${signal}; shutting down Timi.`);try{store.save();}catch(e){logger.error("Final save failed:",e);}client.destroy();process.exit(0);}
process.once("SIGINT",()=>shutdown("SIGINT"));process.once("SIGTERM",()=>shutdown("SIGTERM"));
try{await client.login(config.token);}catch(e){logger.error("Timi could not log in. Check DISCORD_TOKEN and application settings:",e);process.exitCode=1;}
