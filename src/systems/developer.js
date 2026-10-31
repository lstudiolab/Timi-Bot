import {
  ActionRowBuilder, AttachmentBuilder, StringSelectMenuBuilder, TextInputStyle
} from "discord.js";
import { autoFixTbScript, buildTbScriptModal, compileTbScript, renderTbScript } from "../tbscript.js";
import { getStorageReport, canStoreGuildState, formatBytes, hasPro, proRequiredMessage } from "../subscriptions.js";
import { textInput, modal, respond, deny, requireOwner } from "../ui.js";

const STARTER = [
  "{",
  '   {title:"Welcome"}',
  '   {description:"Hello, {user}!"}',
  '   {color:"#808080"}',
  "}"
].join("\n");

const KIT = {
  embed: '{\n   {title:"Welcome"}\n   {description:"Hello, {user}!"}\n   {footer:"Welcome to {server}"}\n   {color:"#808080"}\n}',
  button: '{\n   {title:"Choose an action"}\n   {addbutton:true:"Get role":"":false}\n   {onclick(button):giverole:"Member"}\n}',
  modal: '{\n   {title:"Contact us"}\n   {modal:"Contact form"\n      {input:"Subject":"What is this about?"}\n      {input:"Details":"Describe your request":true}\n   }\n}',
  visibility: '{\n   {description:"Only the person running this script can see this response."}\n   {ephemeral:true}\n}',
  image: '{\n   {title:"Image preview"}\n   {imagelink:"https://example.com/image.png"}\n}'
};

const TEMPLATES = {
  ...KIT,
  welcome: "{\n   {title:\"Welcome\"}\n   {description:\"Welcome {user} to {server}. You are member #{member_count}.\"}\n   {color:\"#808080\"}\n}",
  ticket: "{\n   {title:\"Support\"}\n   {description:\"Need help? Open a ticket and our team will assist you.\"}\n   {color:\"#808080\"}\n   {addbutton:true:\"Open ticket\":\"\":false}\n}",
  verification: "{\n   {title:\"Verification\"}\n   {description:\"Complete verification to access {server}.\"}\n   {color:\"#808080\"}\n   {addbutton:true:\"Verify\":\"\":false}\n}"
};
const DOCUMENTATION = {
  syntax: 'TbScript keeps your exact block structure. A source file begins with an outer { block. Each instruction is another {keyword:argument} block inside it. Nested instructions stay inside their parent block. Arguments use : separators. Text values use double quotes. Statements do not use semicolons.',
  keywords: 'title:text, description:text, footer:text, author:text, imagelink:https-url, thumbnail:https-url, url:https-url, content:text, color:#RRGGBB, ephemeral:true|false, field:name:value:inline, addbutton:enabled:title:emoji:disabled, modal:title with nested input blocks, input:label:placeholder:paragraph.',
  actions: 'The supported button action is {onclick(button):giverole:"Role name"}. It attaches to the most recently declared enabled addbutton. Timi verifies that the role exists, is not managed or @everyone, and is below Timi highest role before assigning it.',
  placeholders: 'Placeholders inside quoted text are interpolated: {user}, {username}, {user_tag}, {user_id}, {server}, {server_id}, {member_count}, {channel}, {channel_name}, {owner}, {owner_id}, {bot}, {bot_name}, {date}, {time}, and {timestamp}.',
  safety: 'TbScript is a restricted Discord component language. It does not execute JavaScript, shell commands, arbitrary network requests, or dynamically evaluated code. Only explicitly supported actions run. The current automatic repair adds missing closing braces only; it does not rewrite logic.'
};
function slugify(value) {
  return String(value || "").toLowerCase().trim().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
}
function quote(value) {
  return '"' + String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n") + '"';
}
function panelSource(title, description) {
  return "{\n   {title:" + quote(title) + "}\n   {description:" + quote(description) + "}\n   {color:\"#808080\"}\n}";
}
function errorsText(errors) {
  return errors.slice(0, 8).map(error => typeof error === "string"
    ? "• " + error
    : "• Line " + error.line + ", column " + error.column + ": " + error.message).join("\n");
}
function storageError(report) {
  return "This change would exceed your Timi storage allocation (" + formatBytes(report.bytes) + " / "
    + formatBytes(report.limit) + "). Remove unused saved content or upgrade to Timi Pro.";
}
function panelTarget(target) {
  return ["ticket-panel","verification-panel","moderation-panel","role-picker-panel"].includes(target);
}
function insertKitBlock(source, snippet) {
  const base=String(source||"").trim();
  const addition=String(snippet||"").trim();
  if(!base.startsWith("{")||!base.endsWith("}")||!addition.startsWith("{")||!addition.endsWith("}")) {
    throw new Error("A component can only be assembled into a complete TbScript block.");
  }
  const inner=addition.slice(1,-1).trim();
  return base.slice(0,-1).trimEnd()+"\n   "+inner.replace(/\n/g,"\n   ")+"\n}";
}
function stopRuntime(store,guildId,slug) {
  const active=store.data.developer_active[guildId]?.[slug];
  if(active) active.status="stopped";
  const project=store.data.developer_projects[guildId]?.[slug];
  if(project){project.status="saved";project.active=false;}
}

export class Developer {
  constructor(context) {
    this.client = context.client;
    this.store = context.store;
    this.logger = context.logger;
    this.context = context;
  }

  async allowed(i) {
    if (!hasPro(this.store, i.guildId)) {
      await deny(i, proRequiredMessage("the Developer library"));
      return false;
    }
    return requireOwner(i);
  }

  projects(guildId) {
    this.store.data.developer_projects[guildId] ||= {};
    return this.store.data.developer_projects[guildId];
  }

  project(guildId, name) {
    return this.projects(guildId)[slugify(name)] || null;
  }

  async command(i) {
    if (!await this.allowed(i)) return;
    const name = i.commandName;

    if (name === "code") {
      const slug = slugify(i.options.getString("name"));
      if (!/^[a-z0-9][a-z0-9_-]{0,23}$/.test(slug)) return deny(i, "Project names can contain letters, numbers, underscores, and hyphens (up to 24 characters).");
      if (this.project(i.guildId, slug)) return deny(i, "That project already exists. Use /code-edit.");
      const attachment=i.options.getAttachment("file");
      if(attachment)return this.createProjectFromAttachment(i,slug,attachment);
      return i.showModal(modal("developer:editor:new:" + slug, "Create TbScript project", [
        textInput("source", "TbScript source", STARTER, TextInputStyle.Paragraph, true, 4000)
      ]));
    }
    if(name==="code-template")return this.createTemplate(i,i.options.getString("name"),i.options.getString("template"));
    if(name==="code-docs")return this.docs(i,i.options.getString("topic")||"syntax");
    if(name==="code-validate")return this.validate(i,i.options.getString("name"));

    if (name === "code-edit") {
      const target = i.options.getString("target");
      const attachment=i.options.getAttachment("file");
      if(attachment)return this.replaceTargetFromAttachment(i,target,attachment);
      if (target === "project") {
        const slug = slugify(i.options.getString("name"));
        const project = this.project(i.guildId, slug);
        if (!project) return deny(i, "That project does not exist. Use /code-list or /code.");
        if(Buffer.byteLength(project.source,"utf8")>3900)return deny(i,"This source is too large for a Discord editor modal. Use /code-export, edit the .tdl file, then run /code-edit with target:Project, name, and the edited file attached.");
        return i.showModal(modal("developer:editor:project:" + slug, "Edit " + project.name, [
          textInput("source", "TbScript source", project.source, TextInputStyle.Paragraph, true, 4000)
        ]));
      }
      if (panelTarget(target)) {
        const current = this.store.data.panel_scripts[i.guildId]?.[target];
        if(current&&Buffer.byteLength(current,"utf8")>3900)return deny(i,"This source is too large for a Discord editor modal. Edit a .tdl file and attach it to /code-edit with the same target.");
        const settings = target === "ticket-panel" ? this.store.ticket(i.guildId)
          : target === "verification-panel" ? this.store.verify(i.guildId) : null;
        const fallback=panelSource(settings?.panel_title||target.replace("-panel",""),settings?.panel_description||"Customize this Timi panel with TbScript.");
        return i.showModal(modal("developer:editor:panel:" + target, "Edit " + target.replace("-panel", " panel") + " code", [
          textInput("source", "TbScript source", current || fallback, TextInputStyle.Paragraph, true, 4000)
        ]));
      }
      return deny(i, "Choose project, ticket-panel, or verification-panel.");
    }

    if (name === "code-list") {
      const entries = Object.entries(this.projects(i.guildId));
      const storage = getStorageReport(this.store, i.guildId);
      const body = entries.length
        ? entries.slice(0, 20).map(([slug, p]) => "**" + p.name + "** (" + slug + ") · v" + p.version + " · " + (p.status || "saved")).join("\n")
        : "No projects saved yet. Use /code to create one.";
      return respond(i, "**Developer projects**\n" + body + "\n\nStorage: " + formatBytes(storage.bytes) + " / " + formatBytes(storage.limit));
    }
    if (name === "code-run") return this.run(i, i.options.getString("name"));
    if (name === "code-stop") return this.stop(i, i.options.getString("name"));
    if (name === "code-delete") return this.remove(i, i.options.getString("name"));
    if (name === "code-export") return this.export(i, i.options.getString("name"));
    if (name === "code-import") return this.import(i, i.options.getAttachment("file"), i.options.getBoolean("replace") === true);
    if (name === "code-history") return this.history(i, i.options.getString("name"));
    if (name === "code-undo") return this.undo(i, i.options.getString("name"));
    if (name === "code-redo") return this.redo(i, i.options.getString("name"));
    if (name === "code-kit") return this.kit(i);
    if (name === "timi-customize") return this.customize(i);
  }

  async createProjectFromAttachment(i,slug,attachment){
    if(!attachment.name.toLowerCase().endsWith(".tdl"))return deny(i,"Attach a TbScript file with the .tdl extension.");
    if(attachment.size>64*1024)return deny(i,"TbScript imports are limited to 64 KB.");
    const response=await fetch(attachment.url);
    if(!response.ok)return deny(i,"Timi could not download that attachment.");
    const original=await response.text();
    if(Buffer.byteLength(original,"utf8")>64*1024)return deny(i,"TbScript imports are limited to 64 KB.");
    const source=autoFixTbScript(original),compiled=compileTbScript(source);
    if(!compiled.ok)return deny(i,"The file contains invalid TbScript:\n"+errorsText(compiled.errors));
    return this.createProjectFromSource(i,slug,source,"attached .tdl file");
  }

  async createProjectFromSource(i,slug,source,origin="template"){
    if(this.project(i.guildId,slug))return deny(i,"That project already exists.");
    const project={id:slug,name:slug,source,version:1,status:"saved",active:false,created_at:Date.now(),updated_at:Date.now(),last_run:null};
    const projects={...this.projects(i.guildId),[slug]:project};
    const report=canStoreGuildState(this.store,i.guildId,{developer_projects:{...(this.store.data.developer_projects||{}),[i.guildId]:projects}});
    if(!report.ok)return deny(i,storageError(report));
    this.store.data.developer_projects[i.guildId]=projects;
    this.store.save();
    return respond(i,"Created **"+slug+"** from a "+origin+". It is saved but not running. Use /code-run to test it.");
  }

  async createTemplate(i,rawName,templateName){
    const slug=slugify(rawName),source=TEMPLATES[templateName];
    if(!/^[a-z0-9][a-z0-9_-]{0,23}$/.test(slug))return deny(i,"Project names can contain letters, numbers, underscores, and hyphens (up to 24 characters).");
    if(!source)return deny(i,"Unknown TbScript template.");
    const compiled=compileTbScript(source);
    if(!compiled.ok)return deny(i,"The built-in template failed validation: "+errorsText(compiled.errors));
    return this.createProjectFromSource(i,slug,source,"the "+templateName+" template");
  }

  async docs(i,topic){
    const selected=DOCUMENTATION[topic]||DOCUMENTATION.syntax;
    const title=topic.charAt(0).toUpperCase()+topic.slice(1);
    return respond(i,"**TbScript documentation — "+title+"**\n"+selected+"\n\nUse /code-kit to assemble components into a project, /code-template to start from a template, and /code-validate to inspect a saved project's syntax.");
  }

  async validate(i,rawName){
    const slug=slugify(rawName),project=this.project(i.guildId,slug);
    if(!project)return deny(i,"That project does not exist.");
    const compiled=compileTbScript(project.source);
    if(!compiled.ok)return deny(i,"TbScript validation failed:\n"+errorsText(compiled.errors));
    return respond(i,"TbScript is valid. "+compiled.instructions.length+" instruction block(s) were transpiled. Project remains saved and was not run.");
  }

  async editorSubmit(i) {
    if (!await this.allowed(i)) return;
    const parts = i.customId.split(":");
    const mode = parts[2];
    const target = parts.slice(3).join(":");
    const original = i.fields.getTextInputValue("source");
    const source = autoFixTbScript(original);
    const compiled = compileTbScript(source);
    if (!compiled.ok) return deny(i, "TbScript could not be saved:\n" + errorsText(compiled.errors));
    const autoFixNote = source !== original ? " Missing closing braces were added automatically." : "";

    if (mode === "panel") {
      if (!panelTarget(target)) return deny(i, "Unsupported panel target.");
      const scripts = { ...(this.store.data.panel_scripts[i.guildId] || {}), [target]: source };
      const report = canStoreGuildState(this.store, i.guildId, {
        panel_scripts: { ...(this.store.data.panel_scripts || {}), [i.guildId]: scripts }
      });
      if (!report.ok) return deny(i, storageError(report));
      this.store.data.panel_scripts[i.guildId] = scripts;
      this.store.save();
      await this.refreshPanel(i.guild, target);
      return respond(i, "TbScript saved and existing " + target.replace("-", " ") + " panels refreshed." + autoFixNote + " Use /code-edit to change it again.");
    }

    const slug = target;
    if (!/^[a-z0-9][a-z0-9_-]{0,23}$/.test(slug)) return deny(i, "Invalid project name.");
    const projects = { ...this.projects(i.guildId) };
    const old = projects[slug];
    if (mode === "new" && old) return deny(i, "That project already exists.");
    if (mode !== "new" && !old) return deny(i, "That project no longer exists.");

    const history = { ...(this.store.data.developer_history[i.guildId] || {}) };
    const versions = [...(history[slug] || [])];
    if (old) {
      versions.push({ version: old.version, source: old.source, saved_at: old.updated_at || Date.now() });
      history[slug] = versions.slice(-10);
    }
    projects[slug] = {
      id: old?.id || slug, name: old?.name || slug, source,
      version: (old?.version || 0) + 1, status: "saved", active: false,
      created_at: old?.created_at || Date.now(), updated_at: Date.now(), last_run: old?.last_run || null
    };
    const report = canStoreGuildState(this.store, i.guildId, {
      developer_projects: { ...(this.store.data.developer_projects || {}), [i.guildId]: projects },
      developer_history: { ...(this.store.data.developer_history || {}), [i.guildId]: history }
    });
    if (!report.ok) return deny(i, storageError(report));
    this.store.data.developer_projects[i.guildId] = projects;
    this.store.data.developer_history[i.guildId] = history;
    this.store.data.developer_redo[i.guildId] ||= {};
    delete this.store.data.developer_redo[i.guildId][slug];
    stopRuntime(this.store,i.guildId,slug);
    this.store.save();
    return respond(i, (mode === "new" ? "Project created." : "Project saved.") + autoFixNote + " It is saved but not running. Use /code-run to test it.");
  }

  async replaceTargetFromAttachment(i,target,attachment){
    if(!attachment.name.toLowerCase().endsWith(".tdl"))return deny(i,"Attach a TbScript file with the .tdl extension.");
    if(attachment.size>64*1024)return deny(i,"TbScript imports are limited to 64 KB.");
    const response=await fetch(attachment.url);
    if(!response.ok)return deny(i,"Timi could not download that attachment.");
    const original=await response.text();
    if(Buffer.byteLength(original,"utf8")>64*1024)return deny(i,"TbScript imports are limited to 64 KB.");
    const source=autoFixTbScript(original),compiled=compileTbScript(source);
    if(!compiled.ok)return deny(i,"The file contains invalid TbScript:\n"+errorsText(compiled.errors));
    if(panelTarget(target)){
      const scripts={...(this.store.data.panel_scripts[i.guildId]||{}),[target]:source};
      const report=canStoreGuildState(this.store,i.guildId,{panel_scripts:{...(this.store.data.panel_scripts||{}),[i.guildId]:scripts}});
      if(!report.ok)return deny(i,storageError(report));
      this.store.data.panel_scripts[i.guildId]=scripts;
      this.store.save();
      await this.refreshPanel(i.guild,target);
      return respond(i,"Updated the "+target.replace("-"," ")+" from the attached .tdl file. "+(source!==original?"Missing closing braces were added.":""));
    }
    if(target!=="project")return deny(i,"Choose project, ticket-panel, or verification-panel.");
    const slug=slugify(i.options.getString("name")),project=this.project(i.guildId,slug);
    if(!project)return deny(i,"That project does not exist.");
    return this.replaceProjectSource(i,slug,source,project);
  }

  async replaceProjectSource(i,slug,source,project){
    const projects={...this.projects(i.guildId)};
    const history={...(this.store.data.developer_history[i.guildId]||{})};
    history[slug]=[...(history[slug]||[]),{version:project.version,source:project.source,saved_at:project.updated_at||Date.now()}].slice(-10);
    const next={...project,source,version:project.version+1,status:"saved",active:false,updated_at:Date.now()};
    const redo={...(this.store.data.developer_redo[i.guildId]||{}),[slug]:[]};
    const report=canStoreGuildState(this.store,i.guildId,{
      developer_projects:{...(this.store.data.developer_projects||{}),[i.guildId]:{...projects,[slug]:next}},
      developer_history:{...(this.store.data.developer_history||{}),[i.guildId]:history},
      developer_redo:{...(this.store.data.developer_redo||{}),[i.guildId]:redo}
    });
    if(!report.ok)return deny(i,storageError(report));
    this.store.data.developer_projects[i.guildId]={...projects,[slug]:next};
    this.store.data.developer_history[i.guildId]=history;
    this.store.data.developer_redo[i.guildId]=redo;
    stopRuntime(this.store,i.guildId,slug);
    this.store.save();
    return respond(i,"Updated **"+project.name+"** from the attached .tdl file. It is saved but not running.");
  }

  async refreshPanel(guild, target) {
    try {
      if (target === "ticket-panel") await this.context.libraries?.Support?.refreshPanels?.(guild);
      if (target === "verification-panel") await this.context.libraries?.Foundation?.refreshVerification?.(guild);
      if (target === "moderation-panel") await this.context.libraries?.Moderation?.refreshPanel?.(guild);
      if (target === "role-picker-panel") await this.context.libraries?.Foundation?.refreshRolePickers?.(guild);
    } catch (error) {
      this.logger.warn("TbScript panel refresh failed:", error.message);
    }
  }

  async run(i, rawName) {
    const slug = slugify(rawName);
    const project = this.project(i.guildId, slug);
    if (!project) return deny(i, "That project does not exist.");
    const compiled = compileTbScript(project.source);
    if (!compiled.ok) return deny(i, "This saved project has errors:\n" + errorsText(compiled.errors));
    const rendered = renderTbScript(compiled, { scope: "p-" + slug, context: { guild: i.guild, user: i.user, member: i.member, channel: i.channel, client: this.client } });
    let message;
    if (rendered.ephemeral) {
      message = await i.editReply({
        content: rendered.content || (rendered.embeds.length ? null : "TbScript test output"),
        embeds: rendered.embeds, components: rendered.components, allowedMentions: { parse: [] }
      });
    } else {
      message = await i.channel.send({
        content: rendered.content, embeds: rendered.embeds, components: rendered.components, allowedMentions: { parse: [] }
      });
      await respond(i, "Project " + project.name + " is running in this channel. Use /code-stop to disable its controls.");
    }
    this.store.data.developer_active[i.guildId] ||= {};
    this.store.data.developer_active[i.guildId][slug] = {
      status: "running", channel_id: i.channelId, message_id: message.id,
      ephemeral: rendered.ephemeral, started_at: Date.now()
    };
    project.status = "running";
    project.active = true;
    project.last_run = Date.now();
    this.store.save();
  }

  async stop(i, rawName) {
    const slug = slugify(rawName);
    const active = this.store.data.developer_active[i.guildId]?.[slug];
    if (!active || active.status !== "running") return deny(i, "That project is not currently running.");
    active.status = "stopped";
    const project = this.project(i.guildId, slug);
    if (project) { project.status = "saved"; project.active = false; }
    if (!active.ephemeral) {
      const channel = await i.guild.channels.fetch(active.channel_id).catch(() => null);
      const message = await channel?.messages.fetch(active.message_id).catch(() => null);
      await message?.edit({ components: [] }).catch(() => {});
    }
    this.store.save();
    return respond(i, "Project stopped. Its controls are now inactive.");
  }

  async remove(i, rawName) {
    const slug = slugify(rawName);
    const projects = { ...this.projects(i.guildId) };
    if (!projects[slug]) return deny(i, "That project does not exist.");
    delete projects[slug];
    const history = { ...(this.store.data.developer_history[i.guildId] || {}) };
    delete history[slug];
    const redo={...(this.store.data.developer_redo[i.guildId]||{})};delete redo[slug];
    this.store.data.developer_projects[i.guildId] = projects;
    this.store.data.developer_history[i.guildId] = history;
    this.store.data.developer_redo[i.guildId] = redo;
    if (this.store.data.developer_active[i.guildId]) delete this.store.data.developer_active[i.guildId][slug];
    this.store.save();
    return respond(i, "Project and its saved version history were deleted.");
  }

  async export(i, rawName) {
    const slug = slugify(rawName);
    const project = this.project(i.guildId, slug);
    if (!project) return deny(i, "That project does not exist.");
    const file = new AttachmentBuilder(Buffer.from(project.source, "utf8"), { name: slug + ".tdl" });
    return i.editReply({ content: "Exported " + project.name + " as a TbScript file.", files: [file], allowedMentions: { parse: [] } });
  }

  async import(i, attachment, replaceExisting = false) {
    if (!attachment) return deny(i, "Attach a .tdl file to import.");
    if (!attachment.name.toLowerCase().endsWith(".tdl")) return deny(i, "Only .tdl TbScript files can be imported.");
    if (attachment.size > 64 * 1024) return deny(i, "TbScript imports are limited to 64 KB.");
    const response = await fetch(attachment.url);
    if (!response.ok) return deny(i, "Timi could not download that attachment.");
    const source = await response.text();
    if (Buffer.byteLength(source, "utf8") > 64 * 1024) return deny(i, "TbScript imports are limited to 64 KB.");
    const fixed = autoFixTbScript(source);
    const compiled = compileTbScript(fixed);
    if (!compiled.ok) return deny(i, "Import failed:\n" + errorsText(compiled.errors));
    const slug = slugify(attachment.name.replace(/\.tdl$/i, "")) || "imported-project";
    const existing=this.project(i.guildId,slug);
    if(existing&&!replaceExisting)return deny(i,"A project named "+slug+" already exists. Set replace:true to update it and preserve version history.");
    if(existing)return this.replaceProjectSource(i,slug,fixed,existing);
    const projects = { ...this.projects(i.guildId), [slug]: {
      id: slug, name: slug, source: fixed, version: 1, status: "saved", active: false,
      created_at: Date.now(), updated_at: Date.now(), last_run: null
    } };
    const report = canStoreGuildState(this.store, i.guildId, {
      developer_projects: { ...(this.store.data.developer_projects || {}), [i.guildId]: projects }
    });
    if (!report.ok) return deny(i, storageError(report));
    this.store.data.developer_projects[i.guildId] = projects;
    this.store.save();
    return respond(i, "Imported " + slug + ". It is saved but not running.");
  }

  async history(i, rawName) {
    const slug = slugify(rawName);
    const project=this.project(i.guildId,slug);
    if(!project)return deny(i,"That project does not exist.");
    const entries=this.store.data.developer_history[i.guildId]?.[slug]||[];
    const lines=["**Current version "+project.version+"** · "+new Date(project.updated_at).toISOString(),
      ...entries.slice(-10).reverse().map(entry=>"Version "+entry.version+" · "+new Date(entry.saved_at).toISOString())];
    return respond(i,"**Version history: "+slug+"**\n"+lines.join("\n"));
  }

  async undo(i,rawName){
    const slug=slugify(rawName),project=this.project(i.guildId,slug);
    if(!project)return deny(i,"That project does not exist.");
    const history={...(this.store.data.developer_history[i.guildId]||{})};
    const entries=[...(history[slug]||[])];
    if(!entries.length)return deny(i,"There is no saved change to undo.");
    const previous=entries.pop();
    const redo={...(this.store.data.developer_redo[i.guildId]||{})};
    const redoEntries=[...(redo[slug]||[]),{version:project.version,source:project.source,saved_at:Date.now()}].slice(-10);
    const next={...project,source:previous.source,version:project.version+1,status:"saved",active:false,updated_at:Date.now()};
    const report=canStoreGuildState(this.store,i.guildId,{
      developer_projects:{...(this.store.data.developer_projects||{}),[i.guildId]:{...this.projects(i.guildId),[slug]:next}},
      developer_history:{...(this.store.data.developer_history||{}),[i.guildId]:{...history,[slug]:entries}},
      developer_redo:{...(this.store.data.developer_redo||{}),[i.guildId]:{...redo,[slug]:redoEntries}}
    });
    if(!report.ok)return deny(i,storageError(report));
    history[slug]=entries;redo[slug]=redoEntries;
    this.store.data.developer_history[i.guildId]=history;
    this.store.data.developer_redo[i.guildId]=redo;
    this.projects(i.guildId)[slug]=next;stopRuntime(this.store,i.guildId,slug);
    this.store.save();
    return respond(i,"Undid the last saved change. Project is saved and not running.");
  }

  async redo(i,rawName){
    const slug=slugify(rawName),project=this.project(i.guildId,slug);
    if(!project)return deny(i,"That project does not exist.");
    const redo={...(this.store.data.developer_redo[i.guildId]||{})};
    const entries=[...(redo[slug]||[])];
    if(!entries.length)return deny(i,"There is no undone change to redo.");
    const nextVersion=entries.pop();
    const history={...(this.store.data.developer_history[i.guildId]||{})};
    const previous=[...(history[slug]||[]),{version:project.version,source:project.source,saved_at:Date.now()}].slice(-10);
    const next={...project,source:nextVersion.source,version:project.version+1,status:"saved",active:false,updated_at:Date.now()};
    const report=canStoreGuildState(this.store,i.guildId,{
      developer_projects:{...(this.store.data.developer_projects||{}),[i.guildId]:{...this.projects(i.guildId),[slug]:next}},
      developer_history:{...(this.store.data.developer_history||{}),[i.guildId]:{...history,[slug]:previous}},
      developer_redo:{...(this.store.data.developer_redo||{}),[i.guildId]:{...redo,[slug]:entries}}
    });
    if(!report.ok)return deny(i,storageError(report));
    history[slug]=previous;redo[slug]=entries;
    this.store.data.developer_history[i.guildId]=history;
    this.store.data.developer_redo[i.guildId]=redo;
    this.projects(i.guildId)[slug]=next;stopRuntime(this.store,i.guildId,slug);
    this.store.save();
    return respond(i,"Redid the saved change. Project is saved and not running.");
  }

  async kit(i) {
    const menu = new StringSelectMenuBuilder().setCustomId("developer:kit")
      .setPlaceholder("Choose a component to assemble").setMinValues(1).setMaxValues(1)
      .addOptions(
        { label: "Embed", value: "embed", description: "Title, description, footer, author and color" },
        { label: "Button and role action", value: "button", description: "Add a button and assign a role" },
        { label: "Modal", value: "modal", description: "Build an input form using nested blocks" },
        { label: "Private response", value: "visibility", description: "Make output visible only to the runner" },
        { label: "Image", value: "image", description: "Add an image to an embed" }
      );
    return respond(i, "**TbScript component kit**\nChoose a component, then choose the project where it should be assembled. The generated code stays editable.", [new ActionRowBuilder().addComponents(menu)]);
  }

  async assembleKit(i,key,slug){
    if(!await this.allowed(i))return;
    const snippet=KIT[key];
    const project=this.project(i.guildId,slug);
    if(!snippet||!project)return deny(i,"The selected component or project is no longer available.");
    const source=insertKitBlock(project.source,snippet);
    const compiled=compileTbScript(source);
    if(!compiled.ok)return deny(i,"This component cannot be assembled into the current file:\n"+errorsText(compiled.errors));
    const projects={...this.projects(i.guildId)};
    const history={...(this.store.data.developer_history[i.guildId]||{})};
    const entries=[...(history[slug]||[]),{version:project.version,source:project.source,saved_at:Date.now()}].slice(-10);
    const next={...project,source,version:project.version+1,status:"saved",active:false,updated_at:Date.now()};
    const redo={...(this.store.data.developer_redo[i.guildId]||{}),[slug]:[]};
    const report=canStoreGuildState(this.store,i.guildId,{
      developer_projects:{...(this.store.data.developer_projects||{}),[i.guildId]:{...projects,[slug]:next}},
      developer_history:{...(this.store.data.developer_history||{}),[i.guildId]:{...history,[slug]:entries}},
      developer_redo:{...(this.store.data.developer_redo||{}),[i.guildId]:redo}
    });
    if(!report.ok)return deny(i,storageError(report));
    this.store.data.developer_projects[i.guildId]={...projects,[slug]:next};
    this.store.data.developer_history[i.guildId]={...history,[slug]:entries};
    this.store.data.developer_redo[i.guildId]=redo;
    stopRuntime(this.store,i.guildId,slug);
    this.store.save();
    return respond(i,"The "+key+" component was assembled into **"+project.name+"**. Version "+next.version+" is saved but not running.");
  }

  async customize(i) {
    const current = this.store.data.customizations[i.guildId] || {
      color: "#808080", author: "", footer: "", image: "", button_style: "secondary"
    };
    return i.showModal(modal("developer:customize", "Timi appearance", [
      textInput("color", "Embed color (#RRGGBB)", current.color, TextInputStyle.Short, true, 7),
      textInput("author", "Default embed author", current.author, TextInputStyle.Short, false, 256),
      textInput("footer", "Default embed footer", current.footer, TextInputStyle.Short, false, 2048),
      textInput("image", "Default panel image URL", current.image, TextInputStyle.Short, false, 500),
      textInput("button-style", "Button style: secondary, primary, success, danger", current.button_style, TextInputStyle.Short, true, 9)
    ]));
  }

  async customizeSubmit(i) {
    if (!await this.allowed(i)) return;
    const values = Object.fromEntries(i.fields.fields.map(field => [field.customId, field.value.trim()]));
    if (!/^#[0-9a-f]{6}$/i.test(values.color)) return deny(i, "Use a six-digit hex color such as #808080.");
    if (values.image && !/^https:\/\//i.test(values.image)) return deny(i, "The panel image URL must use HTTPS.");
    values["button-style"] = values["button-style"].toLowerCase();
    if (!["secondary", "primary", "success", "danger"].includes(values["button-style"])) return deny(i, "Choose secondary, primary, success, or danger.");
    const theme = {
      color: values.color.toUpperCase(), author: values.author, footer: values.footer,
      image: values.image, button_style: values["button-style"]
    };
    const customizations = { ...(this.store.data.customizations || {}), [i.guildId]: theme };
    const report = canStoreGuildState(this.store, i.guildId, { customizations });
    if (!report.ok) return deny(i, storageError(report));
    this.store.data.customizations = customizations;
    this.store.save();
    await this.refreshPanel(i.guild, "ticket-panel");
    await this.refreshPanel(i.guild, "verification-panel");
    return respond(i, "Appearance settings saved. Existing ticket and verification panels were refreshed.");
  }

  async handleScriptButton(i) {
    const match = i.customId.match(/^tbs:(ticket|verification|moderation|role-picker|p-[a-z0-9_-]{1,24}):(\d+)$/i);
    if (!match) return deny(i, "This TbScript control is invalid.");
    const scope = match[1], index = Number(match[2]);
    let source = "";
    if (scope.startsWith("p-")) {
      const slug = scope.slice(2);
      const active = this.store.data.developer_active[i.guildId]?.[slug];
      const project = this.project(i.guildId, slug);
      if (!hasPro(this.store, i.guildId) || !project || active?.status !== "running" || active.message_id !== i.message.id) return deny(i, "This project control is no longer active.");
      source = project.source;
    } else {
      if (!hasPro(this.store, i.guildId) || !(this.store.data.installed_libraries[i.guildId] || []).includes("Developer")) return deny(i, "The Developer library is not active.");
      const panels = scope === "ticket" ? this.store.ticket(i.guildId).published_panels
        : scope === "verification" ? this.store.verify(i.guildId).published_panels
        : scope === "moderation" ? [{message_id:this.store.mods(i.guildId).panel_message_id}]
        : Object.values(this.store.data.role_picker_menus||{}).filter(menu=>menu.guild_id===i.guildId);
      if (!panels.some(panel => panel.message_id === i.message.id)) return deny(i, "This panel control is no longer active.");
      source = this.store.data.panel_scripts[i.guildId]?.[scope + "-panel"] || "";
    }
    const compiled = compileTbScript(source);
    if (!compiled.ok) return deny(i, "This saved TbScript is no longer valid.");
    const action = compiled.output.buttons[index]?.action;
    if (!action) return deny(i, "No action is configured for this button.");
    const role = i.guild.roles.cache.find(candidate => candidate.id === action.role || candidate.name.toLowerCase() === action.role.toLowerCase());
    if (!role || role.id === i.guild.id || role.managed) return deny(i, "The configured role no longer exists or cannot be assigned.");
    const member = await i.guild.members.fetch(i.user.id);
    if (member.roles.cache.has(role.id)) return deny(i, "You already have that role.");
    const bot = await i.guild.members.fetchMe();
    if (!bot.permissions.has("ManageRoles") || role.position >= bot.roles.highest.position) return deny(i, "Timi cannot assign that role. Check Manage Roles and role hierarchy.");
    await member.roles.add(role, "TbScript button action");
    return respond(i, "Role " + role.name + " assigned.");
  }

  async modalButton(i) {
    const scope = i.customId.slice(4);
    let source = "";
    if (scope.startsWith("p-")) {
      const slug = scope.slice(2);
      const project = this.project(i.guildId, slug);
      const active = this.store.data.developer_active[i.guildId]?.[slug];
      if (!project || active?.status !== "running" || active.message_id !== i.message.id) return deny(i, "This project form is no longer active.");
      source = project.source;
    } else {
      const target = ["ticket","verification","moderation","role-picker"].includes(scope) ? scope + "-panel" : "";
      if (!target || !(this.store.data.installed_libraries[i.guildId] || []).includes("Developer")) return deny(i, "This panel form is no longer active.");
      const panels = scope === "ticket" ? this.store.ticket(i.guildId).published_panels
        : scope === "verification" ? this.store.verify(i.guildId).published_panels
        : scope === "moderation" ? [{message_id:this.store.mods(i.guildId).panel_message_id}]
        : Object.values(this.store.data.role_picker_menus||{}).filter(menu=>menu.guild_id===i.guildId);
      if (!panels.some(panel => panel.message_id === i.message.id)) return deny(i, "This panel form is no longer active.");
      source = this.store.data.panel_scripts[i.guildId]?.[target] || "";
    }
    const compiled = compileTbScript(source);
    if (!compiled.ok || !compiled.output.modal) return deny(i, "This TbScript form is invalid.");
    return i.showModal(buildTbScriptModal(compiled, "tbm-submit:" + scope));
  }

  async handleInteraction(i) {
    if (i.isChatInputCommand()) return this.command(i);
    if (i.isButton() && i.customId.startsWith("tbs:")) return this.handleScriptButton(i);
    if (i.isButton() && i.customId.startsWith("tbm:")) return this.modalButton(i);
    if (i.isModalSubmit() && i.customId.startsWith("tbm-submit:")) {
      const values = i.fields.fields.map((field, index) => "• Input " + (index + 1) + ": " + (field.value || "—"));
      return respond(i, "Form submitted.\n" + values.join("\n"));
    }
    if (i.isModalSubmit() && i.customId.startsWith("developer:editor:")) return this.editorSubmit(i);
    if (i.isModalSubmit() && i.customId === "developer:customize") return this.customizeSubmit(i);
    if (i.isStringSelectMenu() && i.customId === "developer:kit") {
      const key=i.values[0];
      const projects=Object.entries(this.projects(i.guildId));
      if(!KIT[key])return deny(i,"Unknown component.");
      if(!projects.length){
        const fence=String.fromCharCode(96).repeat(3);
        return respond(i,"Create a project with /code first. Component source:\n"+fence+"text\n"+KIT[key]+"\n"+fence);
      }
      const menu=new StringSelectMenuBuilder().setCustomId("developer:kit-project:"+key)
        .setPlaceholder("Choose a project").setMinValues(1).setMaxValues(1)
        .addOptions(projects.slice(0,25).map(([slug,p])=>({label:p.name.slice(0,100),value:slug,description:"Version "+p.version+" · "+(p.status||"saved")})));
      return respond(i,"Select the project that should receive this component.",[new ActionRowBuilder().addComponents(menu)]);
    }
    if(i.isStringSelectMenu()&&i.customId.startsWith("developer:kit-project:")){
      const key=i.customId.slice("developer:kit-project:".length);
      return this.assembleKit(i,key,i.values[0]);
    }
  }

  async onInstall(guild) {
    for(const target of ["ticket-panel","verification-panel","moderation-panel","role-picker-panel"]) {
      await this.refreshPanel(guild,target);
    }
  }

  async onUninstall(guild) {
    for(const target of ["ticket-panel","verification-panel","moderation-panel","role-picker-panel"]) {
      await this.refreshPanel(guild,target);
    }
  }
}

export function createDeveloperLibrary(context) {
  const developer = new Developer(context);
  return {
    async handleInteraction(i) { return developer.handleInteraction(i); },
    async onInstall(guild) { return developer.onInstall(guild); },
    async onUninstall(guild) { return developer.onUninstall(guild); }
  };
}
