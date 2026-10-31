import { PermissionFlagsBits, TextInputStyle, ButtonStyle, EmbedBuilder } from "discord.js";
import { greyEmbed,button,row,textInput,modal,respond,deny,requireManager } from "../ui.js";
import { renderTemplate } from "../utils.js";

export class Embeds {
  constructor(client,store,logger){this.client=client;this.store=store;this.logger=logger;}
  payload(x,context={}){
    const e=new EmbedBuilder().setColor(0x808080);
    if(x.title)e.setTitle(renderTemplate(x.title,context));if(x.description)e.setDescription(renderTemplate(x.description,context));if(x.url)e.setURL(renderTemplate(x.url,context));
    if(x.author)e.setAuthor({name:renderTemplate(x.author,context)});if(x.footer)e.setFooter({text:renderTemplate(x.footer,context)});
    if(x.thumbnail)e.setThumbnail(x.thumbnail);if(x.image)e.setImage(x.image);
    if(x.fields?.length)e.addFields(x.fields.map(f=>({name:renderTemplate(f.name,context),value:renderTemplate(f.value,context),inline:!!f.inline})));
    return e;
  }
  editorPreview(x){
    const preview=new EmbedBuilder().setColor(0x808080)
      .setTitle(x.title||"Untitled embed")
      .setDescription(x.description||"Your embed description will appear here.");
    const avatar=this.client.user?.displayAvatarURL({extension:"png",size:256});
    if(avatar)preview.setThumbnail(avatar);
    if(x.author)preview.setAuthor({name:x.author});
    if(x.footer)preview.setFooter({text:x.footer});
    if(x.fields?.length)preview.addFields(x.fields.slice(0,25).map(f=>({name:f.name,value:f.value,inline:!!f.inline})));
    return preview;
  }
  text(x){
    return `**Embed editor: ${x.name}**\n\nTitle: ${x.title||"—"}\nDescription: ${x.description||"—"}\nColor: #808080\nAuthor: ${x.author||"—"}\nFooter: ${x.footer||"—"}\nFields: ${x.fields.length}\n${x.fields.map((f,i)=>`${i+1}. ${f.name}${f.inline?" (inline)":""}`).join("\n")||"No fields"}\nThumbnail: ${x.thumbnail?"Set":"—"}\nImage: ${x.image?"Set":"—"}\nURL: ${x.url||"—"}\n\nPlaceholders: {user}, {username}, {user_tag}, {user_id}, {server}, {server_id}, {member_count}, {channel}, {channel_name}, {owner}, {owner_id}, {bot}, {bot_name}, {date}, {time}, {timestamp}.\nChanges save automatically and update every placed message.`;
  }
  components(x){
    return [
      row(button("embed:content:"+x.name,"Title & description",ButtonStyle.Primary),button("embed:style:"+x.name,"Appearance")),
      row(button("embed:media:"+x.name,"Images & link"),button("embed:add-field:"+x.name,"Add field"),button("embed:remove-field:"+x.name,"Remove field",ButtonStyle.Danger))
    ];
  }
  async refresh(x){
    for(const p of x.placements||[]){
      try{
        const channel=await this.client.channels.fetch(p.channel_id),message=await channel.messages.fetch(p.message_id);
        const user=await this.client.users.fetch(x.creator_id).catch(()=>null);
        await message.edit({embeds:[this.payload(x,{guild:channel.guild,user,channel,client:this.client})],allowedMentions:{parse:[]}});
      }catch(error){this.logger.warn("Could not refresh saved embed:",error.message);}
    }
  }
  async command(i){
    if(!await requireManager(i))return;
    if(i.commandName==="create-embed")return i.showModal(modal("embed:create","Create an embed",[
      textInput("name","Embed name (no spaces)","",TextInputStyle.Short,true,24),
      textInput("title","Embed title","",TextInputStyle.Short,true,256),
      textInput("description","Embed description","",TextInputStyle.Paragraph,true,4000)
    ]));
    const name=i.options.getString("name").toLowerCase(),x=this.store.embed(i.guildId,name);
    if(!x)return deny(i,"No saved embed with that name. Use /create-embed first.");
    if(i.commandName==="edit-embed")return respond(i,this.text(x),this.components(x),[this.editorPreview(x)]);
    if(i.commandName==="place-embed"){
      const sent=await i.channel.send({embeds:[this.payload(x,{guild:i.guild,user:i.user,member:i.member,channel:i.channel,client:this.client})],allowedMentions:{parse:[]}});
      x.placements.push({channel_id:i.channelId,message_id:sent.id});this.store.saveEmbed(x);
      return respond(i,"Embed placed in this channel.");
    }
  }
  async button(i){
    if(!await requireManager(i))return;
    const [,action,name]=i.customId.split(":"),x=this.store.embed(i.guildId,name);
    if(!x)return deny(i,"This saved embed no longer exists.");
    const forms={
      content:["Edit embed content",[textInput("title","Title",x.title,TextInputStyle.Short,true,256),textInput("description","Description",x.description,TextInputStyle.Paragraph,true,4000)]],
      style:["Edit embed appearance",[textInput("author","Author",x.author,TextInputStyle.Short,false,256),textInput("footer","Footer",x.footer,TextInputStyle.Short,false,2048)]],
      media:["Edit embed images and link",[textInput("thumbnail","Thumbnail image URL",x.thumbnail,TextInputStyle.Short,false,500),textInput("image","Main image URL",x.image,TextInputStyle.Short,false,500),textInput("url","Title URL",x.url,TextInputStyle.Short,false,500)]],
      "add-field":["Add embed field",[textInput("field-name","Field name","",TextInputStyle.Short,true,256),textInput("field-value","Field value","",TextInputStyle.Paragraph,true,1024),textInput("inline","Inline? type true or false","false",TextInputStyle.Short,false,5)]],
      "remove-field":["Remove embed field",[textInput("field-index","Field number to remove (1-based)","",TextInputStyle.Short,true,2)]]
    };
    const form=forms[action];if(!form)return deny(i,"This embed control is no longer available.");
    return i.showModal(modal(i.customId,form[0],form[1]));
  }
  async modalSubmit(i){
    if(!await requireManager(i))return;
    const fields=Object.fromEntries(i.fields.fields.map(v=>[v.customId,v.value.trim()]));
    if(i.customId==="embed:create"){
      const name=fields.name.toLowerCase();
      if(!/^[\w-]+$/.test(name)||!fields.title||!fields.description)return deny(i,"Use a simple name (letters, numbers, - or _) and provide a title and description.");
      if(this.store.embed(i.guildId,name))return deny(i,"An embed with that name already exists. Use /edit-embed.");
      const x={guild_id:i.guildId,name,creator_id:i.user.id,title:fields.title,description:fields.description,color:0x808080,
        author:"",footer:"",thumbnail:"",image:"",url:"",fields:[],placements:[]};
      this.store.saveEmbed(x);return respond(i,this.text(x),this.components(x),[this.editorPreview(x)]);
    }
    const [,action,name]=i.customId.split(":"),x=this.store.embed(i.guildId,name);
    if(!x)return deny(i,"This saved embed no longer exists.");
    if(action==="content")Object.assign(x,{title:fields.title,description:fields.description});
    else if(action==="style")Object.assign(x,{author:fields.author,footer:fields.footer});
    else if(action==="media"){
      for(const url of [fields.thumbnail,fields.image,fields.url])if(url&&!/^https:\/\//i.test(url))return deny(i,"Image and title links must use HTTPS URLs.");
      Object.assign(x,{thumbnail:fields.thumbnail,image:fields.image,url:fields.url});
    }else if(action==="add-field"){
      if(x.fields.length>=25)return deny(i,"Discord embeds support up to 25 fields.");
      if(!fields["field-name"]||!fields["field-value"])return deny(i,"Field name and value are required.");
      x.fields.push({name:fields["field-name"],value:fields["field-value"],inline:["true","yes"].includes(fields.inline.toLowerCase())});
    }else if(action==="remove-field"){
      const index=Number(fields["field-index"])-1;
      if(!Number.isInteger(index)||index<0||index>=x.fields.length)return deny(i,"Enter a valid field number.");
      x.fields.splice(index,1);
    }else return deny(i,"This embed form is no longer available.");
    this.store.saveEmbed(x);await this.refresh(x);
    return respond(i,this.text(x),this.components(x),[this.editorPreview(x)]);
  }
  async handle(i){
    if(i.isChatInputCommand()&&["create-embed","edit-embed","place-embed"].includes(i.commandName))return this.command(i);
    if(i.isButton()&&i.customId.startsWith("embed:"))return this.button(i);
    if(i.isModalSubmit()&&i.customId.startsWith("embed:"))return this.modalSubmit(i);
  }
}
