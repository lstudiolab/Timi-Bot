import { REST, Routes } from "discord.js";
import { loadConfig, createLogger } from "./config.js";
import { coreCommandData } from "./commands.js";
const config=loadConfig(),logger=createLogger(config.logLevel);
const rest=new REST({version:"10"}).setToken(config.token);
try{
  // Library commands are registered per guild at runtime. Keep only library
  // management commands global so they are available before installation.
  const route=Routes.applicationCommands(config.clientId);
  const commands=await rest.put(route,{body:coreCommandData});
  logger.info(`Registered ${commands.length} core slash commands.`);
}catch(error){logger.error("Core slash command registration failed:",error);process.exitCode=1;}
