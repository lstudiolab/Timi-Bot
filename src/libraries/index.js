import { createModerationLibrary } from "./Moderation/index.js";
import { createSupportLibrary } from "./Support/index.js";
import { createFoundationLibrary } from "./Foundation/index.js";

export const LIBRARIES = Object.freeze({
  Moderation: Object.freeze({
    name:"Moderation",
    description:"Moderation, server protection, automatic moderation, server activity and moderation logs.",
    systems:["Moderation controls","Warnings and cases","Auto moderation","Anti-raid and bot protection","Server activity archive","Audit and moderation logs"],
    create:createModerationLibrary
  }),
  Support: Object.freeze({
    name:"Support",
    description:"A complete configurable ticket and support system.",
    systems:["Ticket setup","Custom ticket panels","Private support tickets","Staff threads","Transcripts","Ticket permissions and logs"],
    create:createSupportLibrary
  }),
  Foundation: Object.freeze({
    name:"Foundation",
    description:"General server tools and member experience systems.",
    systems:["Server utilities","Message and embed builder","Welcome and goodbye","Role management and role picker","Member verification"],
    create:createFoundationLibrary
  })
});
export function normalizeLibraryName(value){
  const key=String(value||"").trim().toLowerCase().replace(/[\s_-]/g,"");
  return Object.keys(LIBRARIES).find(name=>name.toLowerCase()===key)||null;
}
