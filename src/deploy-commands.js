import { REST, Routes } from "discord.js";
import { loadConfig, createLogger } from "./config.js";
import { commandData } from "./commands.js";
const config=loadConfig(),logger=createLogger(config.logLevel);
const rest=new REST({version:"10"}).setToken(config.token);
const route=config.guildId?Routes.applicationGuildCommands(config.clientId,config.guildId):Routes.applicationCommands(config.clientId);
try{
  const commands=await rest.put(route,{body:commandData});
  logger.info(`Registered ${commands.length} slash commands.`);
}catch(error){logger.error("Slash command registration failed:",error);process.exitCode=1;}
