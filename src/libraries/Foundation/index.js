import { Verification } from "../../systems/verification.js";
import { RolePicker } from "../../systems/role-picker.js";
import { Embeds } from "../../systems/embeds.js";
import { Foundation } from "../../systems/foundation.js";
export function createFoundationLibrary({client,store,logger}){
  const verification=new Verification(client,store,logger);
  const rolePicker=new RolePicker(client,store,logger,verification);
  const embeds=new Embeds(client,store,logger);
  const utilities=new Foundation(client,store,logger);
  return {async handleInteraction(i){
    if(i.isChatInputCommand()){
      if(["verify-settings","verify-panel"].includes(i.commandName))return verification.handle(i);
      if(i.commandName==="setup-role-picker")return rolePicker.handle(i);
      if(["ping","server-info","user-info","avatar","welcome-settings"].includes(i.commandName))return utilities.command(i);
      if(["create-embed","edit-embed","place-embed"].includes(i.commandName))return embeds.handle(i);
    }
    const id=i.customId||"";
    if(id.startsWith("verify:")||id.startsWith("botguard:"))return verification.handle(i);
    if(id.startsWith("rolepicker:"))return rolePicker.handle(i);
    if(id.startsWith("embed:"))return embeds.handle(i);
    },
    async guildMemberAdd(member){await utilities.memberAdd(member);},
    async guildMemberRemove(member){await utilities.memberRemove(member);}
  };
}
