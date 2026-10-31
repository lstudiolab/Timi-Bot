import { Moderation } from "../../systems/moderation.js";
import { Protection } from "../../systems/protection.js";
import { Recovery } from "../../systems/recovery.js";

export function createModerationLibrary({client,store,logger,foundation}){
  const moderation=new Moderation(client,store,logger);
  const protection=new Protection(client,store,logger);
  const recovery=new Recovery(client,store,logger);
  return {
    async ready(guild){
      await protection.ready(guild);
      for(const channel of guild.channels.cache.values())recovery.snapshot(channel);
    },
    async handleInteraction(i){
      if(i.isChatInputCommand()&&i.commandName==="moderation-settings")return moderation.handle(i);
      const id=i.customId||"";
      if(id.startsWith("modpanel:"))return moderation.handle(i);
      if(id.startsWith("botguard:"))return foundation.handleInteraction(i);
    },
    async messageCreate(message){
      recovery.backupMessage(message);
      await moderation.onMessage(message);
    },
    async guildMemberAdd(member){await protection.memberJoin(member);},
    channelCreate(channel){recovery.snapshot(channel);},
    channelUpdate(oldChannel,channel){recovery.snapshot(channel);},
    async channelDelete(channel){await recovery.onChannelDelete(channel);}
  };
}
