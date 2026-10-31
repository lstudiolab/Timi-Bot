import {
  ButtonStyle, RoleSelectMenuBuilder, StringSelectMenuBuilder,
  ChannelType, TextInputStyle
} from "discord.js";
import { requireOwner, respond, deny, modal, textInput, row, button, greyEmbed } from "../ui.js";
import { isSnowflake, renderTemplate } from "../utils.js";

export class RolePicker {
  constructor(client,store,logger,verification){this.client=client;this.store=store;this.logger=logger;this.verification=verification;}
  async command(i){
    if(!await requireOwner(i))return;
    return respond(i,"**Role picker setup**\n\nCreate a self-service role menu. Configure its appearance, choose the allowed roles, then publish. Text supports {user}, {username}, {user_tag}, {user_id}, {server}, {server_id}, {member_count}, {channel}, {channel_name}, {owner}, {owner_id}, {bot}, {bot_name}, {date}, {time}, and {timestamp}.",
      [row(button("rolepicker:start","Configure role picker",ButtonStyle.Primary))]);
  }
  async button(i){
    if(i.customId.startsWith("rolepicker:footer-link:")){
      const id=i.customId.slice("rolepicker:footer-link:".length),menu=this.store.data.role_picker_menus[id];
      if(!menu||menu.guild_id!==i.guildId||!menu.footer_channel_id)return deny(i,"This link is no longer available.");
      return respond(i,"Open the channel: https://discord.com/channels/"+menu.guild_id+"/"+menu.footer_channel_id);
    }
    if(i.customId==="rolepicker:start"){
      if(!await requireOwner(i))return;
      return i.showModal(modal("rolepicker:details","Role picker settings",[
        textInput("rp-title","Menu title","Choose your roles",TextInputStyle.Short,true,100),
        textInput("rp-description","Description","Select the roles you want.",TextInputStyle.Paragraph,true,500),
        textInput("rp-placeholder","Dropdown placeholder","Select roles...",TextInputStyle.Short,true,150),
        textInput("rp-footer","Optional bottom button text","",TextInputStyle.Short,false,80),
        textInput("rp-footer-channel","Optional bottom button channel ID","",TextInputStyle.Short,false,22)
      ]));
    }
    if(i.customId.startsWith("rolepicker:publish:")){
      if(!await requireOwner(i))return;
      const id=i.customId.slice("rolepicker:publish:".length),draft=this.store.data.role_picker_drafts[id];
      if(!draft||draft.guild_id!==i.guildId||!draft.roles?.length)return deny(i,"Choose at least one role before publishing.");
      const roles=[];
      for(const roleId of draft.roles){
        const role=await i.guild.roles.fetch(roleId).catch(()=>null);
        if(!role)return deny(i,"One of the selected roles no longer exists. Reopen setup and select roles again.");
        const [ok,message]=await this.verification.validateRole(i.guild,role,true);
        if(!ok)return deny(i,message);
        roles.push({id:role.id,name:role.name});
      }
      const menuId=Date.now()+"-"+i.id;
      const menu={id:menuId,guild_id:i.guildId,channel_id:draft.channel_id,title:draft.title,description:draft.description,
        placeholder:draft.placeholder,footer_text:draft.footer_text,footer_channel_id:draft.footer_channel_id,roles,selections:{}};
      const channel=await i.guild.channels.fetch(menu.channel_id),sent=await channel.send(this.publicPayload(menu,{guild:i.guild,user:i.user,member:i.member,channel,client:this.client}));
      menu.message_id=sent.id;this.store.data.role_picker_menus[menuId]=menu;
      delete this.store.data.role_picker_drafts[id];this.store.save();
      return respond(i,`Role picker menu published in <#${channel.id}>. You can create another menu with /setup-role-picker.`);
    }
  }
  publicPayload(menu,context={}){
    const select=new StringSelectMenuBuilder().setCustomId("rolepicker:menu:"+menu.id)
      .setPlaceholder(renderTemplate(menu.placeholder||"Choose roles",context).slice(0,150)).setMinValues(0)
      .setMaxValues(Math.max(1,Math.min(25,menu.roles.length)))
      .addOptions(menu.roles.map(role=>({label:role.name.slice(0,100),value:role.id})));
    const components=[row(select)];
    if(menu.footer_text&&menu.footer_channel_id){
      components.push(row(button("rolepicker:footer-link:"+menu.id,renderTemplate(menu.footer_text,context).slice(0,80))));
    }
    return {embeds:[greyEmbed(renderTemplate(menu.title,context),renderTemplate(menu.description,context))],components,allowedMentions:{parse:[]}};
  }
  async modalSubmit(i){
    if(i.customId!=="rolepicker:details")return;
    if(!await requireOwner(i))return;
    const f=Object.fromEntries(i.fields.fields.map(v=>[v.customId,v.value.trim()]));
    if(!f["rp-title"]||!f["rp-description"]||!f["rp-placeholder"])return deny(i,"Menu title, description, and placeholder are required.");
    if(f["rp-footer-channel"]&&!isSnowflake(f["rp-footer-channel"]))return deny(i,"The bottom button channel must be a valid channel ID.");
    if(f["rp-footer-channel"]){
      const channel=await i.guild.channels.fetch(f["rp-footer-channel"]).catch(()=>null);
      if(!channel||channel.type!==ChannelType.GuildText)return deny(i,"The bottom button channel must be a text channel in this server.");
    }
    const id=i.guildId+":"+i.id;
    const draft={guild_id:i.guildId,channel_id:i.channelId,title:f["rp-title"],description:f["rp-description"],
      placeholder:f["rp-placeholder"],footer_text:f["rp-footer"],footer_channel_id:f["rp-footer-channel"],roles:[]};
    this.store.data.role_picker_drafts[id]=draft;this.store.save();
    const count=i.guild.roles.cache.filter(role=>role.id!==i.guildId&&!role.managed).size;
    const menu=new RoleSelectMenuBuilder().setCustomId("rolepicker:setup-roles:"+id)
      .setPlaceholder("Choose the roles members can pick").setMinValues(1).setMaxValues(25);
    return respond(i,`**${draft.title}**\n${draft.description}\n\nChoose which roles members can select. ${count} assignable roles were found. Select up to 25.`,[row(menu)]);
  }
  async setupRoles(i){
    if(!await requireOwner(i))return;
    const id=i.customId.slice("rolepicker:setup-roles:".length),draft=this.store.data.role_picker_drafts[id];
    if(!draft||draft.guild_id!==i.guildId)return deny(i,"This setup has expired. Run /setup-role-picker again.");
    draft.roles=[...i.values];this.store.save();
    return respond(i,`**${draft.title}**\n${draft.description}\n\n**Roles included:** ${draft.roles.length}\n\nChange the selection or publish this menu.`,
      [row(button("rolepicker:publish:"+id,"Publish role menu",ButtonStyle.Primary))]);
  }
  async menu(i){
    const id=i.customId.slice("rolepicker:menu:".length),menu=this.store.data.role_picker_menus[id];
    if(!menu||menu.guild_id!==i.guildId)return deny(i,"This role picker is no longer available.");
    const selected=new Set(i.values),previous=new Set(menu.selections[i.user.id]||[]);
    const add=[...selected].filter(role=>!previous.has(role)),remove=[...previous].filter(role=>!selected.has(role));
    try{
      if(add.length)await i.member.roles.add(add,"Timi self-service role picker");
      if(remove.length)await i.member.roles.remove(remove,"Timi self-service role picker");
    }catch(error){
      this.logger.warn("Role picker role update failed:",error.message);
      return deny(i,"Timi could not update your roles. Check Manage Roles and role hierarchy.");
    }
    menu.selections[i.user.id]=[...selected];this.store.save();
    return respond(i,selected.size?"Your role selections have been updated.":"Your role selections have been cleared.");
  }
  async handle(i){
    if(i.isChatInputCommand()&&i.commandName==="setup-role-picker")return this.command(i);
    if(i.isButton()&&i.customId.startsWith("rolepicker:"))return this.button(i);
    if(i.isModalSubmit()&&i.customId==="rolepicker:details")return this.modalSubmit(i);
    if(i.isRoleSelectMenu()&&i.customId.startsWith("rolepicker:setup-roles:"))return this.setupRoles(i);
    if(i.isStringSelectMenu()&&i.customId.startsWith("rolepicker:menu:"))return this.menu(i);
  }
}
