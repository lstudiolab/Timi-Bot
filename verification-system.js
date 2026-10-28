const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const nodemailer = require("nodemailer");
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits } = require("discord.js");

const DATA_DIR = path.join(__dirname, "data");
const STORE_PATH = path.join(DATA_DIR, "verification.json");
const DEFAULTS = { roleId: "", channelId: "", panelTitle: "Verify your account", panelDescription: "Verify your email address to receive access to this server.", publishedPanels: [] };
const CODE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CODES_PER_IP_DAY = 20;
const MAX_CODE_ATTEMPTS = 5;
const sessions = new Map();
const emailSendCooldowns = new Map();
let storeCache;
let server;
let transporter;

function readStore() {
  if (storeCache) return storeCache;
  try { storeCache = fs.existsSync(STORE_PATH) ? JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) : { guilds: {}, ipActivity: {} }; }
  catch (error) { console.error("Verification store read failed:", error.message); storeCache = { guilds: {}, ipActivity: {} }; }
  if (!storeCache || typeof storeCache !== "object") storeCache = {};
  storeCache.guilds ||= {};
  storeCache.ipActivity ||= {};
  return storeCache;
}
function writeStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STORE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(readStore(), null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STORE_PATH);
}
function getSettings(guildId) { return { ...DEFAULTS, ...(readStore().guilds[guildId] || {}) }; }
function saveSettings(guildId, settings) { const store = readStore(); store.guilds[guildId] = { ...getSettings(guildId), ...settings }; writeStore(); }
function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString("hex"); }
function hashCode(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function hashIp(ip) {
  const secret = process.env.IP_HASH_SECRET || process.env.DISCORD_TOKEN;
  if (!secret) throw new Error("Set IP_HASH_SECRET to enable privacy-preserving abuse tracking.");
  return crypto.createHmac("sha256", secret).update(String(ip || "unknown")).digest("hex");
}
function clientIp(req) {
  if (process.env.TRUST_PROXY === "true") {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.length < 1024) {
      const chain = forwarded.split(",").map(value => value.trim()).filter(Boolean);
      const candidate = chain.at(-1);
      if (candidate && candidate.length <= 64 && /^[0-9a-fA-F:.]+$/.test(candidate)) return candidate;
    }
  }
  return req.socket.remoteAddress || "unknown";
}
function json(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(data), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extraHeaders });
  res.end(data);
}
function allowedFrontendOrigin() { return (process.env.FRONTEND_ORIGIN || "").trim().replace(/\/$/, ""); }
function apiHeaders(req) {
  const origin = req.headers.origin;
  const allowed = allowedFrontendOrigin();
  const headers = { "Vary": "Origin", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Accept", "Access-Control-Max-Age": "600" };
  if (origin && allowed && origin === allowed) headers["Access-Control-Allow-Origin"] = allowed;
  return headers;
}
function apiJson(req, res, status, body) { return json(res, status, body, apiHeaders(req)); }
function pageError(res, status, message) {
  const safe = String(message).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
  res.end("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Timi verification</title><body style=\"font:16px -apple-system,BlinkMacSystemFont,sans-serif;background:#f5f5f7;color:#1d1d1f;padding:32px\"><main style=\"max-width:480px;margin:12vh auto;background:white;padding:28px;border-radius:24px\"><h1>Verification link unavailable</h1><p>" + safe + "</p><p>Return to Discord and press Verify to create a new link.</p></main></body></html>");
}
function getMailer() {
  if (transporter) return transporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !process.env.VERIFICATION_FROM) throw new Error("Email delivery is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and VERIFICATION_FROM.");
  transporter = nodemailer.createTransport({ host: SMTP_HOST, port: Number(SMTP_PORT || 587), secure: Number(SMTP_PORT) === 465, auth: { user: SMTP_USER, pass: SMTP_PASS } });
  return transporter;
}
function assessIp(ip) {
  const store = readStore(), now = Date.now(), ipHash = hashIp(ip);
  const record = store.ipActivity[ipHash] || { events: [], blockedUntil: 0 };
  record.events = record.events.filter(t => now - t < DAY_MS);
  if (record.blockedUntil > now) return { blocked: true, ipHash, count: record.events.length };
  record.events.push(now);
  if (record.events.length >= MAX_CODES_PER_IP_DAY) record.blockedUntil = now + 7 * DAY_MS;
  store.ipActivity[ipHash] = record; writeStore();
  return { blocked: record.blockedUntil > now, ipHash, count: record.events.length };
}
async function sendSecurityAlert(client, guildId, message) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;
  const channel = guild.channels.cache.find(c => c.name === "timi" && c.isTextBased() && c.isSendable());
  if (channel) await channel.send({ content: message.slice(0, 1900), allowedMentions: { parse: [] } }).catch(() => {});
}
function makeSessionUrl(token) {
  const base = (process.env.BASE_URL || "").replace(/\/$/, "");
  if (!/^https:\/\//i.test(base)) throw new Error("Set BASE_URL to the public HTTPS URL of the verification website.");
  return base + "/?session=" + encodeURIComponent(token);
}
function parseBody(req, raw) {
  if ((req.headers["content-type"] || "").includes("application/json")) {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}
async function grantVerificationRole(client, session) {
  const guild = await client.guilds.fetch(session.guildId).catch(() => null);
  if (!guild) return { ok: false, status: 404, message: "The Discord server could not be found. Return to Discord and start verification again." };
  const settings = getSettings(session.guildId);
  if (!settings.roleId) return { ok: false, status: 409, message: "Email verified, but the server owner has not configured a verification role yet." };
  const role = await guild.roles.fetch(settings.roleId).catch(() => null);
  const member = await guild.members.fetch(session.userId).catch(() => null);
  if (!role || !member) return { ok: false, status: 404, message: "Your Discord membership or the configured role could not be found. Make sure you have not left the server." };
  const botMember = guild.members.me || await guild.members.fetch(client.user.id).catch(() => null);
  if (!botMember || !botMember.permissions.has(PermissionFlagsBits.ManageRoles) || !role.editable) return { ok: false, status: 403, message: "Timi cannot assign this role. The server owner must grant Manage Roles and move Timi's highest role above the verification role." };
  try { if (!member.roles.cache.has(role.id)) await member.roles.add(role, "Timi website email verification completed"); }
  catch (error) { console.error("Could not grant verification role:", error.message); return { ok: false, status: 502, message: "Your email was verified, but Discord rejected the role assignment. Contact a server manager." }; }
  return { ok: true, roleName: role.name };
}
function startWebServer(client) {
  if (server) return;
  const port = Number(process.env.PORT || 3000);
  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, service: "timi-verification" });
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/verify")) {
        const token = url.searchParams.get("session") || "";
        if (!/^[a-f0-9]{64}$/i.test(token)) return pageError(res, 400, "This verification link is missing or invalid.");
        const session = sessions.get(token);
        if (!session || session.expiresAt < Date.now() || session.used) return pageError(res, 400, "This verification link expired or was already used.");
        const frontend = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https:; base-uri 'none'; frame-ancestors 'none'" });
        return res.end(frontend);
      }
      if (req.method === "GET" && ["/style.css", "/app.js", "/config.js"].includes(url.pathname)) {
        const asset = fs.readFileSync(path.join(__dirname, "public", url.pathname.slice(1)));
        const type = url.pathname.endsWith(".css") ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8";
        res.writeHead(200, { "Content-Type": type, "Content-Length": asset.length, "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" });
        return res.end(asset);
      }
      const apiRoutes = ["/api/request-code", "/api/verify-code"];
      if (apiRoutes.includes(url.pathname) && req.method === "OPTIONS") {
        const origin = req.headers.origin, allowed = allowedFrontendOrigin();
        if (!origin || !allowed || origin !== allowed) return json(res, 403, { ok: false, message: "Origin not allowed" });
        res.writeHead(204, apiHeaders(req)); return res.end();
      }
      if (apiRoutes.includes(url.pathname) && req.method === "POST") {
        const origin = req.headers.origin, allowed = allowedFrontendOrigin();
        if (origin && (!allowed || origin !== allowed)) return apiJson(req, res, 403, { ok: false, message: "This website is not allowed to use the verification API." });
        let raw = "";
        for await (const chunk of req) { raw += chunk; if (raw.length > 8192) return apiJson(req, res, 413, { ok: false, message: "Request too large." }); }
        const payload = parseBody(req, raw);
        if (!payload || typeof payload !== "object") return apiJson(req, res, 400, { ok: false, message: "Invalid request body." });
        const token = typeof payload.session === "string" ? payload.session : "";
        const session = sessions.get(token);
        if (!/^[a-f0-9]{64}$/i.test(token) || !session || session.expiresAt < Date.now() || session.used) return apiJson(req, res, 400, { ok: false, message: "This verification link is invalid, expired, or already used. Return to Discord and press Verify again." });
        if (url.pathname === "/api/request-code") {
          const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return apiJson(req, res, 400, { ok: false, message: "Enter a valid email address." });
          let assessment;
          try { assessment = assessIp(clientIp(req)); } catch (error) { console.error("IP abuse tracking is not configured:", error.message); return apiJson(req, res, 503, { ok: false, message: "Verification is temporarily unavailable. Contact the server owner." }); }
          if (assessment.blocked) {
            await sendSecurityAlert(client, session.guildId, "Verification security: network hash " + assessment.ipHash.slice(0, 12) + " blocked for 7 days after " + assessment.count + " requests in 24 hours.");
            return apiJson(req, res, 429, { ok: false, message: "Too many verification requests from this network. Try again later." });
          }
          if (emailSendCooldowns.has(email) && Date.now() - emailSendCooldowns.get(email) < 60000) return apiJson(req, res, 429, { ok: false, message: "Wait 60 seconds before requesting another code for this email." });
          const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
          session.email = email; session.codeHash = hashCode(token + ":" + code); session.codeExpiresAt = Date.now() + CODE_TTL_MS; session.attempts = 0; session.ipHash = assessment.ipHash;
          emailSendCooldowns.set(email, Date.now());
          try {
            await getMailer().sendMail({
              from: process.env.VERIFICATION_FROM, to: email, subject: "Your Timi verification code",
              text: "Your Timi verification code is " + code + ". It expires in 10 minutes. If you did not request this, ignore this email.",
              html: "<div style=\"font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#1d1d1f\"><h2>Timi verification</h2><p>Your one-time code is:</p><p style=\"font-size:32px;letter-spacing:8px;font-weight:700\">" + code + "</p><p>This code expires in 10 minutes. If you did not request it, ignore this message.</p></div>"
            });
          } catch (error) {
            console.error("Verification email delivery failed:", error.message); emailSendCooldowns.delete(email);
            return apiJson(req, res, 503, { ok: false, message: "Email could not be sent. Try again later or contact the server owner." });
          }
          return apiJson(req, res, 200, { ok: true, message: "Check your inbox for the six-digit code. It expires in 10 minutes." });
        }
        const code = typeof payload.code === "string" ? payload.code.trim() : "";
        if (!session.email || !session.codeHash) return apiJson(req, res, 400, { ok: false, message: "Request a verification code first." });
        if (Date.now() > session.codeExpiresAt) return apiJson(req, res, 400, { ok: false, message: "That code expired. Request a new one." });
        session.attempts = (session.attempts || 0) + 1;
        if (session.attempts > MAX_CODE_ATTEMPTS) { session.used = true; return apiJson(req, res, 429, { ok: false, message: "Too many incorrect attempts. Return to Discord and start again." }); }
        if (!/^\d{6}$/.test(code) || hashCode(token + ":" + code) !== session.codeHash) {
          if (session.attempts >= 3) await sendSecurityAlert(client, session.guildId, "Verification alert: <@" + session.userId + "> has " + session.attempts + " failed website code attempts.");
          return apiJson(req, res, 400, { ok: false, message: "That code is incorrect. Check your email and try again." });
        }
        const result = await grantVerificationRole(client, session);
        if (!result.ok) return apiJson(req, res, result.status, result);
        session.codeHash = null; session.used = true; session.verifiedAt = Date.now();
        await sendSecurityAlert(client, session.guildId, "Verification completed: <@" + session.userId + "> verified their email and was granted the configured role.");
        return apiJson(req, res, 200, { ok: true, message: "Email verified. The Discord role \"" + result.roleName + "\" has been assigned to your account. You can return to Discord." });
      }
      return json(res, 404, { ok: false, message: "Not found" });
    } catch (error) {
      console.error("Verification web request failed:", error.message);
      if (!res.headersSent) json(res, 500, { ok: false, message: "Internal server error" }); else res.end();
    }
  });
  server.listen(port, "0.0.0.0", () => console.log("Timi verification website listening on port " + port));
}
function buildPanel(settings) {
  const embed = new EmbedBuilder().setColor(0x808080).setTitle(settings.panelTitle).setDescription(settings.panelDescription);
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("verify:start").setLabel("Verify").setStyle(ButtonStyle.Primary));
  return { embeds: [embed], components: [row] };
}
async function handleInteraction(interaction) {
  if (!interaction.customId?.startsWith("verify:")) return false;
  if (!interaction.inGuild()) { await interaction.reply({ content: "Verification can only be used in a server.", ephemeral: true }); return true; }
  if (interaction.customId !== "verify:start") {
    await interaction.reply({ content: "Complete email verification on the private Timi website link. The configured Discord role will be assigned automatically after the code is accepted.", ephemeral: true });
    return true;
  }
  const token = randomToken();
  const session = { userId: interaction.user.id, guildId: interaction.guildId, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS, attempts: 0, used: false };
  sessions.set(token, session);
  let link;
  try { link = makeSessionUrl(token); }
  catch (error) { sessions.delete(token); console.error("Could not create verification URL:", error.message); await interaction.reply({ content: "The verification website is not configured yet. Please contact the server owner.", ephemeral: true }); return true; }
  await interaction.reply({ content: "Open your private verification link: " + link + "\n\nEnter your email and the six-digit code on the website. Timi will assign your configured role automatically when verification succeeds. This private link expires in 30 minutes.", ephemeral: true });
  return true;
}
function startSessionCleanup() {
  setInterval(() => {
    const now = Date.now();
    for (const [token, session] of sessions) if (session.expiresAt < now) sessions.delete(token);
    for (const [email, timestamp] of emailSendCooldowns) if (now - timestamp > 5 * 60000) emailSendCooldowns.delete(email);
  }, 60000).unref();
}
startSessionCleanup();
module.exports = { startWebServer, handleInteraction, buildPanel, getSettings, saveSettings, makeSessionUrl };
