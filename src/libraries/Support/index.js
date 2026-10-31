import { Tickets } from "../../systems/tickets.js";
export function createSupportLibrary({client,store,logger}){
  const tickets=new Tickets(client,store,logger);
  return {async handleInteraction(i){
    if(i.isChatInputCommand()&&i.commandName.startsWith("ticket-"))return tickets.handle(i);
    if((i.customId||"").startsWith("ticket:"))return tickets.handle(i);
  }};
}
