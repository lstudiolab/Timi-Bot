import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle
} from "discord.js";
import { renderTemplate } from "./utils.js";
import { hasPro } from "./subscriptions.js";

const MAX_SOURCE_LENGTH = 64 * 1024;
const KEYWORDS = new Set([
  "title", "description", "footer", "author", "imagelink", "thumbnail",
  "url", "content", "color", "ephemeral", "addbutton", "onclick(button)",
  "field", "modal", "input"
]);

class TbScriptSyntaxError extends Error {
  constructor(message, line, column) {
    super(message);
    this.name = "TbScriptSyntaxError";
    this.line = line;
    this.column = column;
  }
}

class Parser {
  constructor(source) {
    this.source = String(source ?? "");
    this.index = 0;
    this.line = 1;
    this.column = 1;
    this.maxDepth = 32;
  }

  peek() { return this.source[this.index] ?? ""; }

  advance() {
    const char = this.source[this.index++] ?? "";
    if (char === "\n") { this.line++; this.column = 1; }
    else this.column++;
    return char;
  }

  skipSpace() {
    while (/\s/.test(this.peek()) && this.peek()) this.advance();
  }

  fail(message) {
    throw new TbScriptSyntaxError(message, this.line, this.column);
  }

  readQuoted() {
    const startLine = this.line;
    const startColumn = this.column;
    this.advance();
    let value = "";
    while (this.peek()) {
      const char = this.advance();
      if (char === '"') return { type: "string", value };
      if (char === "\\") {
        const escaped = this.advance();
        const escapes = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };
        value += Object.prototype.hasOwnProperty.call(escapes, escaped) ? escapes[escaped] : escaped;
      } else value += char;
    }
    throw new TbScriptSyntaxError("Unclosed quoted text.", startLine, startColumn);
  }

  readAtom() {
    const line = this.line;
    const column = this.column;
    let value = "";
    while (this.peek() && !/[\s:{}]/.test(this.peek())) value += this.advance();
    if (!value) this.fail("Expected a keyword or value.");
    if (value.includes(";")) throw new TbScriptSyntaxError("TbScript does not use semicolons.", line, column);
    return { type: "atom", value };
  }

  readValue() {
    this.skipSpace();
    if (this.peek() === '"') return this.readQuoted();
    const token = this.readAtom();
    const raw = token.value;
    if (raw === "true") return { type: "boolean", value: true };
    if (raw === "false") return { type: "boolean", value: false };
    if (/^-?\d+(?:\.\d+)?$/.test(raw)) return { type: "number", value: Number(raw) };
    return { type: "atom", value: raw };
  }

  parseStatement(opened = false, depth = 1) {
    if(depth>this.maxDepth)this.fail("TbScript nesting is limited to 32 levels.");
    if (!opened) {
      if (this.peek() !== "{") this.fail("Expected an opening { for an instruction block.");
      this.advance();
    }
    this.skipSpace();
    const nameToken = this.readAtom();
    const node = { name: nameToken.value.toLowerCase(), args: [], children: [], line: this.line, column: this.column };
    while (true) {
      this.skipSpace();
      if (this.peek() === ":") {
        this.advance();
        node.args.push(this.readValue());
        continue;
      }
      if (this.peek() === "{") {
        node.children.push(this.parseStatement(false,depth+1));
        continue;
      }
      if (this.peek() === "}") {
        this.advance();
        return node;
      }
      this.fail("Expected :, a nested { block, or } after " + node.name + ".");
    }
  }

  parse() {
    if (this.source.length > MAX_SOURCE_LENGTH) {
      this.fail("TbScript source exceeds the 64 KB safety limit.");
    }
    this.skipSpace();
    if (this.peek() !== "{") this.fail("A TbScript file must begin with {.");
    this.advance();
    this.skipSpace();
    const root = { name: "$root", args: [], children: [], line: 1, column: 1 };
    if (this.peek() === "}") {
      this.advance();
    } else if (this.peek() === "{") {
      while (true) {
        this.skipSpace();
        if (this.peek() === "}") { this.advance(); break; }
        if (this.peek() !== "{") this.fail("The outer code block can contain only nested instruction blocks.");
        root.children.push(this.parseStatement(false));
      }
    } else {
      root.children.push(this.parseStatement(true));
    }
    this.skipSpace();
    if (this.peek()) this.fail("Unexpected content after the outer code block.");
    return root;
  }
}

function valueOf(token) { return token?.value; }
function expectCount(node, min, max, errors) {
  if (node.args.length < min || node.args.length > max) {
    errors.push(node.name + " expects " + (min === max ? min : min + "–" + max) + " argument(s).");
    return false;
  }
  return true;
}
function expectString(token) {
  return Boolean(token && (token.type === "string" || token.type === "atom"));
}
function expectBoolean(token) { return token?.type === "boolean"; }

function flattenRoot(node, output = []) {
  for (const child of node.children || []) {
    output.push(child);
    if (child.name !== "modal") flattenRoot(child, output);
  }
  return output;
}

export function parseTbScript(source) {
  try {
    return { ok: true, ast: new Parser(source).parse(), errors: [] };
  } catch (error) {
    return {
      ok: false,
      ast: null,
      errors: [{
        message: error.message,
        line: Number(error.line) || 1,
        column: Number(error.column) || 1
      }]
    };
  }
}

export function compileTbScript(source) {
  const parsed = parseTbScript(source);
  if (!parsed.ok) return { ok: false, errors: parsed.errors, ast: null, instructions: [] };

  const errors = [];
  const instructions = [];
  const result = {
    title: "",
    description: "",
    footer: "",
    author: "",
    image: "",
    thumbnail: "",
    url: "",
    content: "",
    color: 0x808080,
    ephemeral: false,
    fields: [],
    buttons: [],
    modal: null,
    instructions
  };

  for (const node of parsed.ast.children) {
    const name = node.name;
    if (!KEYWORDS.has(name)) {
      errors.push("Unknown TbScript keyword: " + name + " (line " + node.line + ").");
      continue;
    }
    const args = node.args.map(valueOf);
    const instruction = { block: name, line: node.line, arguments: args, children: node.children.length };
    instructions.push(instruction);

    if (["title", "description", "footer", "author", "imagelink", "thumbnail", "url", "content"].includes(name)) {
      if (!expectCount(node, 1, 1, errors)) continue;
      if (!expectString(node.args[0])) { errors.push(name + " requires a text value."); continue; }
      const key = name === "imagelink" ? "image" : name;
      if (["imagelink", "thumbnail", "url"].includes(name)) {
        let valid = false;
        try { valid = new URL(String(args[0])).protocol === "https:"; } catch {}
        if (!valid) { errors.push(name + " requires a valid HTTPS URL."); continue; }
      }
      result[key] = args[0];
      if (node.children.length) errors.push(name + " does not accept nested blocks.");
      continue;
    }

    if (name === "color") {
      if (!expectCount(node, 1, 1, errors)) continue;
      const raw = String(args[0] ?? "");
      const match = raw.match(/^#?([0-9a-f]{6})$/i);
      if (!match) { errors.push("color expects a six-digit hexadecimal value such as \"#808080\"."); continue; }
      result.color = Number.parseInt(match[1], 16);
      if (node.children.length) errors.push("color does not accept nested blocks.");
      continue;
    }

    if (name === "ephemeral") {
      if (!expectCount(node, 1, 1, errors)) continue;
      if (!expectBoolean(node.args[0])) { errors.push("ephemeral expects true or false."); continue; }
      result.ephemeral = args[0];
      if (node.children.length) errors.push("ephemeral does not accept nested blocks.");
      continue;
    }

    if (name === "field") {
      if (!expectCount(node, 2, 3, errors)) continue;
      if (!expectString(node.args[0]) || !expectString(node.args[1])) {
        errors.push("field expects a quoted name and value.");
        continue;
      }
      if (node.args[2] && !expectBoolean(node.args[2])) {
        errors.push("field's third argument must be true or false.");
        continue;
      }
      if (result.fields.length >= 25) { errors.push("An embed can contain no more than 25 fields."); continue; }
      result.fields.push({ name: String(args[0]).slice(0, 256), value: String(args[1]).slice(0, 1024), inline: args[2] === true });
      if (node.children.length) errors.push("field does not accept nested blocks.");
      continue;
    }

    if (name === "addbutton") {
      if (!expectCount(node, 4, 4, errors)) continue;
      if (!expectBoolean(node.args[0]) || !expectString(node.args[1]) || !expectString(node.args[2]) || !expectBoolean(node.args[3])) {
        errors.push("addbutton syntax is {addbutton:true:\"Label\":\"\":false}; its arguments are enabled, title, emoji, disabled.");
        continue;
      }
      if(args[0]&&!String(args[1]).trim()){errors.push("An enabled addbutton needs a non-empty title.");continue;}
      if (args[0] && result.buttons.length >= 25) { errors.push("A message can contain no more than 25 script buttons."); continue; }
      if (args[0]) result.buttons.push({
        label: String(args[1]).slice(0, 80),
        emoji: String(args[2] || ""),
        disabled: args[3],
        action: null
      });
      continue;
    }

    if (name === "onclick(button)") {
      if (!expectCount(node, 2, 2, errors)) continue;
      const button = result.buttons[result.buttons.length - 1];
      if (!button) { errors.push("onclick(button) must follow an enabled addbutton block."); continue; }
      if (String(args[0]).toLowerCase() !== "giverole" || !expectString(node.args[1])) {
        errors.push("The supported onclick action is {onclick(button):giverole:\"Role name\"}.");
        continue;
      }
      button.action = { type: "giverole", role: String(args[1]) };
      if (node.children.length) errors.push("onclick(button) does not accept nested blocks.");
      continue;
    }

    if (name === "modal") {
      if (!expectCount(node, 1, 1, errors)) continue;
      if (!expectString(node.args[0])) { errors.push("modal expects a quoted title."); continue; }
      if (result.modal) { errors.push("Only one modal can be attached to a TbScript message."); continue; }
      const inputs = [];
      for (const child of node.children) {
        if (child.name !== "input" || child.children.length || child.args.length < 2 || child.args.length > 3
          || !expectString(child.args[0]) || !expectString(child.args[1])
          || (child.args[2] && !expectBoolean(child.args[2]))) {
          errors.push("Inside modal, use {input:\"Label\":\"Placeholder\":true} (true selects a paragraph input).");
          continue;
        }
        inputs.push({ label: String(valueOf(child.args[0])).slice(0, 45), placeholder: String(valueOf(child.args[1])).slice(0, 100), paragraph: valueOf(child.args[2]) === true });
      }
      if (!inputs.length) errors.push("modal needs at least one nested input block.");
      if (inputs.length > 5) errors.push("Discord modals support up to five inputs.");
      result.modal = { title: String(args[0]).slice(0, 45), inputs: inputs.slice(0, 5) };
      continue;
    }

    if (name === "input") errors.push("input is only valid inside a modal block.");
  }

  if(result.modal&&result.buttons.length>=25)errors.push("A modal button must fit within Discord's five component rows; use at most 24 other buttons.");
  const hasPresentation=Boolean(result.title||result.description||result.footer||result.author||result.image||result.thumbnail||result.url||result.content||result.fields.length||result.buttons.length||result.modal);
  if(!hasPresentation)errors.push("A TbScript file needs at least one visible instruction.");
  if (errors.length) return { ok: false, errors, ast: parsed.ast, instructions };
  return { ok: true, errors: [], ast: parsed.ast, instructions, output: result };
}

export function autoFixTbScript(source) {
  const normalized = String(source ?? "").replace(/\r\n?/g, "\n").trim();
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const char of normalized) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}") depth--;
  }
  if (depth > 0 && !quoted) return normalized + "\n" + "}".repeat(depth);
  return normalized;
}

export function renderTbScript(compiled, options = {}) {
  if (!compiled?.ok) throw new Error("Cannot render invalid TbScript.");
  const data = compiled.output;
  const context = options.context || {};
  const render = value => renderTemplate(value, context);
  const embeds = [];
  const hasEmbed = data.title || data.description || data.footer || data.author || data.image
    || data.thumbnail || data.url || data.fields.length;
  if (hasEmbed) {
    const embed = new EmbedBuilder().setColor(data.color);
    if (data.title) embed.setTitle(render(data.title).slice(0, 256));
    if (data.description) embed.setDescription(render(data.description).slice(0, 4096));
    if (data.footer) embed.setFooter({ text: render(data.footer).slice(0, 2048) });
    if (data.author) embed.setAuthor({ name: render(data.author).slice(0, 256) });
    if (data.image) embed.setImage(render(data.image));
    if (data.thumbnail) embed.setThumbnail(render(data.thumbnail));
    if (data.url) embed.setURL(render(data.url));
    if (data.fields.length) embed.addFields(data.fields.map(field=>({
      name:render(field.name).slice(0,256),value:render(field.value).slice(0,1024),inline:field.inline
    })));
    embeds.push(embed);
  }

  const scope = String(options.scope || "preview").replace(/[^a-z0-9_-]/gi, "").slice(0, 32) || "preview";
  const components = [];
  const buttons = data.buttons.map((item, index) => {
    const customId = "tbs:" + scope + ":" + index;
    const builder = new ButtonBuilder().setCustomId(customId).setLabel(render(item.label).slice(0,80)).setStyle(ButtonStyle.Secondary).setDisabled(item.disabled);
    if (item.emoji) {
      try { builder.setEmoji(item.emoji); } catch { throw new Error("Invalid emoji on script button " + (index + 1) + "."); }
    }
    return { builder, action: item.action };
  });
  if (data.modal) {
    buttons.push({
      builder: new ButtonBuilder().setCustomId("tbm:" + scope).setLabel("Open form").setStyle(ButtonStyle.Secondary),
      action: null
    });
  }
  for (let index = 0; index < buttons.length; index += 5) {
    components.push(new ActionRowBuilder().addComponents(buttons.slice(index, index + 5).map(item => item.builder)));
  }
  return {
    content: data.content ? render(data.content).slice(0,2000) : undefined,
    embeds,
    components,
    ephemeral: data.ephemeral,
    buttons: buttons.map(item => item.action),
    modal: data.modal
  };
}

export function buildTbScriptModal(compiled, customId) {
  if (!compiled?.ok || !compiled.output.modal) throw new Error("This TbScript has no modal.");
  const definition = compiled.output.modal;
  const modal = new ModalBuilder().setCustomId(customId).setTitle(definition.title);
  for (let index = 0; index < definition.inputs.length; index++) {
    const input = definition.inputs[index];
    const builder = new TextInputBuilder()
      .setCustomId("field-" + index)
      .setLabel(input.label)
      .setPlaceholder(input.placeholder)
      .setRequired(false)
      .setMaxLength(1000)
      .setStyle(input.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short);
    modal.addComponents(new ActionRowBuilder().addComponents(builder));
  }
  return modal;
}

export function applyPanelTbScript(store, guildId, target, basePayload, context = {}) {
  if (!hasPro(store,guildId) || !(store.data.installed_libraries[guildId] || []).includes("Developer")) return basePayload;
  const scriptKey = ["ticket","verification","moderation","role-picker"].includes(target) ? target + "-panel" : target;
  const source = store.data.panel_scripts?.[guildId]?.[scriptKey];
  if (!source) return basePayload;
  const compiled = compileTbScript(source);
  if (!compiled.ok) return basePayload;
  const rendered = renderTbScript(compiled, { scope: target, context });
  const baseComponents = basePayload.components || [];
  return {
    ...basePayload,
    content: rendered.content || basePayload.content,
    embeds: rendered.embeds.length ? rendered.embeds : basePayload.embeds,
    components: [...baseComponents, ...rendered.components].slice(0, 5)
  };
}
