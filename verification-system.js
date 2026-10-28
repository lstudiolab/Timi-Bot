const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const nodemailer = require("nodemailer");
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder,
  PermissionFlagsBits, SlashCommandBuilder, TextInputBuilder, TextInputStyle
} = require("discord.js");

const DATA_DIR = path.join(__dirname, "data");
const STORE_PATH = path.join(DATA_DIR, "verification.json");
const DEFAULTS = { roleId: "", channelId: "", panelTitle: "Verify your account", panelDescription: "Verify your email address to receive access to this server.", publishedPanels: [] };
const CODE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 60 * 1000;
const IP_BLOCK_MS = 7 * 24 * 60 * 60 * 1000;
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
  try {
    storeCache = fs.existsSync(STORE_PATH) ? JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) : { guilds: {}, ipActivity: {}, alerts: [] };
  } catch (error) {
    console.error("Verification store read failed:", error.message);
    storeCache = { guilds: {}, ipActivity: {}, alerts: [] };
  }
  if (!storeCache || typeof storeCache !== "object") storeCache = {};
  storeCache.guilds ||= {};
  storeCache.ipActivity ||= {};
  storeCache.alerts ||= [];
  return storeCache;
}
function writeStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STORE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(readStore(), null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STORE_PATH);
}
function getSettings(guildId) { return { ...DEFAULTS, ...(readStore().guilds[guildId] || {}) }; }
function saveSettings(guildId, settings) {
  const store = readStore();
  store.guilds[guildId] = { ...getSettings(guildId), ...settings };
  writeStore();
}
function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString("hex"); }
function hashCode(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function hashIp(ip) {
  const secret = process.env.IP_HASH_SECRET || process.env.DISCORD_TOKEN;
  if (!secret) throw new Error("Set IP_HASH_SECRET to enable privacy-preserving abuse tracking.");
  return crypto.createHmac("sha256", secret).update(String(ip || "unknown")).digest("hex");
}
function clientIp(req) {
  // Only enable this behind a trusted reverse proxy that appends the actual client
  // address to X-Forwarded-For. Never trust the leftmost value: clients can often
  // supply that value themselves and rotate it to evade per-IP rate limits.
  if (process.env.TRUST_PROXY === "true") {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.length < 1024) {
      const chain = forwarded.split(",").map(value => value.trim()).filter(Boolean);
      const candidate = chain.at(-1);
      if (candidate && candidate.length <= 64 && /^[0-9a-fA-F:.]+$/.test(candidate)) {
        return candidate;
      }
    }
  }
  return req.socket.remoteAddress || "unknown";
}
function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(data), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(data);
}
function html(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
  res.end(body);
}
function page(session, message = "") {
  const safeSession = String(session || "").replace(/[^a-f0-9]/g, "").slice(0, 64);
  const safeMessage = String(message).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Timi Verification</title><style>
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f5f7;color:#1d1d1f;font:16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:22px}.card{width:min(100%,420px);padding:32px;border:1px solid #dedee3;border-radius:28px;background:#fff;box-shadow:0 18px 60px #0000000a}h1{font-size:26px;letter-spacing:-.7px;margin:0 0 10px}p{line-height:1.5;color:#666;margin:0 0 22px}.mark{width:42px;height:42px;border-radius:14px;background:#1d1d1f;color:white;display:grid;place-items:center;font-weight:700;margin-bottom:22px}label{display:block;font-size:13px;font-weight:600;margin:14px 0 7px}input{width:100%;padding:14px;border:1px solid #d2d2d7;border-radius:12px;font:inherit;outline-offset:2px}button{width:100%;margin-top:18px;border:0;border-radius:13px;padding:14px;background:#1d1d1f;color:white;font:inherit;font-weight:600;cursor:pointer}small{display:block;color:#777;line-height:1.5;margin-top:18px}.notice{padding:12px;border-radius:12px;background:#f2f2f7;margin-bottom:16px;font-size:14px}
  </style><main class="card"><div class="mark">T</div><h1>Verify your email</h1><p>Enter your email address. Timi will send a one-time code that you must enter back in Discord.</p>${safeMessage ? `<div class="notice">${safeMessage}</div>` : ""}<form method="post" action="/api/request-code"><input type="hidden" name="session" value="${safeSession}"><label for="email">Email address</label><input id="email" name="email" type="email" maxlength="254" autocomplete="email" required placeholder="you@example.com"><button type="submit">Send verification code</button></form><small>The code expires in 10 minutes. Never share it with anyone. This page is only for Timi server verification.</small></main></html>`;
}
function makeUsername() {
  const adjectives = ["Quiet", "Silver", "Mellow", "Swift", "Clever", "Cloud", "Bright", "Velvet", "Pixel", "Nova"];
  const nouns = ["Otter", "Comet", "Maple", "Panda", "Robin", "Pebble", "Orbit", "Mochi", "Clover", "Sparrow"];
  return adjectives[crypto.randomInt(adjectives.length)] + nouns[crypto.randomInt(nouns.length)] + crypto.randomInt(1000, 10000);
}
function getMailer() {
  if (transporter) return transporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !process.env.VERIFICATION_FROM) throw new Error("Email delivery is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and VERIFICATION_FROM.");
  transporter = nodemailer.createTransport({ host: SMTP_HOST, port: Number(SMTP_PORT || 587), secure: Number(SMTP_PORT) === 465, auth: { user: SMTP_USER, pass: SMTP_PASS } });
  return transporter;
}
function organizerSignals({ ipCount, email, session, ua, now }) {
  const signals = [];
  if (ipCount >= 10) signals.push({ key: "high-ip-volume", weight: 3, detail: "High verification request volume from one network" });
  else if (ipCount >= 5) signals.push({ key: "medium-ip-volume", weight: 2, detail: "Repeated verification requests from one network" });
  if (emailSendCooldowns.has(email) && now - emailSendCooldowns.get(email) < 60_000) signals.push({ key: "email-retry", weight: 1, detail: "Repeated requests for the same email" });
  if (session.attempts >= 3) signals.push({ key: "failed-code-attempts", weight: 3, detail: "Multiple failed code attempts" });
  if (!ua || ua.length < 8) signals.push({ key: "missing-user-agent", weight: 1, detail: "Missing or unusual browser identification" });
  if (session.createdAt && now - session.createdAt < 1500) signals.push({ key: "rapid-flow", weight: 1, detail: "Verification flow started unusually quickly" });
  if (session.lastCodeSentAt && now - session.lastCodeSentAt < 30_000) signals.push({ key: "rapid-resend", weight: 2, detail: "Verification code resent unusually quickly" });
  if (session.used) signals.push({ key: "session-reuse", weight: 4, detail: "Attempt to reuse a completed verification session" });
  if (session.email && session.email !== email) signals.push({ key: "email-change", weight: 2, detail: "Email changed within the same session" });
  if (session.ipHash && session.ipHash !== hashIp(ip)) signals.push({ key: "network-change", weight: 2, detail: "Network changed during verification" });
  // Ten slots total: the 3x3 grid above plus one final aggregate risk slot.
  const score = signals.reduce((sum, signal) => sum + signal.weight, 0);
  signals.push({ key: "aggregate-risk", weight: score >= 6 ? 3 : score >= 3 ? 2 : score > 0 ? 1 : 0, detail: `Aggregate risk score: ${score}` });
  return { score, signals: signals.slice(0, 10) };
}
async function sendSecurityAlert(client, guildId, message) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;
  const channel = guild.channels.cache.find(c => c.name === "timi" && c.isTextBased() && c.isSendable());
  if (!channel) return;
  await channel.send({ content: message.slice(0, 1900), allowedMentions: { parse: [] } }).catch(() => {});
}
function assessIp(ip, session, email, userAgent) {
  const store = readStore();
  const now = Date.now();
  const ipHash = hashIp(ip);
  const record = store.ipActivity[ipHash] || { events: [], blockedUntil: 0 };
  record.events = record.events.filter(t => now - t < DAY_MS);
  if (record.blockedUntil > now) return { blocked: true, record, ipHash, count: record.events.length };
  record.events.push(now);
  if (record.events.length >= MAX_CODES_PER_IP_DAY) record.blockedUntil = now + IP_BLOCK_MS;
  store.ipActivity[ipHash] = record;
  writeStore();
  const risk = organizerSignals({ ipCount: record.events.length, email, session, ua: userAgent, now });
  return { blocked: record.blockedUntil > now, record, ipHash, count: record.events.length, risk };
}
function startWebServer(client) {
  if (server) return;
  const port = Number(process.env.PORT || 3000);
  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, service: "timi-verification" });
      if (req.method === "GET" && url.pathname === "/style.css") {
        const asset = fs.readFileSync(path.join(__dirname, "public", "style.css"));
        res.writeHead(200, { "Content-Type": "text/css; charset=utf-8", "Content-Length": asset.length, "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" });
        return res.end(asset);
      }
      if (req.method === "GET" && url.pathname === "/app.js") {
        const asset = fs.readFileSync(path.join(__dirname, "public", "app.js"));
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Content-Length": asset.length, "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" });
        return res.end(asset);
      }
      if (req.method === "GET" && url.pathname === "/verify") {
        const token = url.searchParams.get("session") || "";
        const session = sessions.get(token);
        if (!session || session.expiresAt < Date.now() || session.used) return html(res, 400, page("", "This verification link expired. Click Verify in Discord to create a new one."));
        const frontend = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
        return html(res, 200, frontend);
      }
      if (req.method === "POST" && url.pathname === "/api/request-code") {
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 8192) { res.writeHead(413); return res.end(); }
        }
        const params = new URLSearchParams(raw);
        const token = params.get("session") || "";
        const email = (params.get("email") || "").trim().toLowerCase();
        const session = sessions.get(token);
        if (!session || session.expiresAt < Date.now() || session.used) return html(res, 400, page("", "This verification link is invalid or expired. Return to Discord and click Verify again."));
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return html(res, 400, page(token, "Enter a valid email address."));
        const ip = clientIp(req);
        const assessment = assessIp(ip, session, email, req.headers["user-agent"] || "");
        if (assessment.blocked) {
          await sendSecurityAlert(client, session.guildId, `Verification security: network hash ${assessment.ipHash.slice(0, 12)} blocked for 7 days after ${assessment.count} requests in 24 hours.`);
          return html(res, 429, page(token, "Too many verification attempts from this network. Access is temporarily blocked for 7 days."));
        }
        if (assessment.risk.score >= 3) {
          await sendSecurityAlert(client, session.guildId, `Verification anomaly: score ${assessment.risk.score}; signals: ${assessment.risk.signals.map(s => s.key).join(", ")}. Session user: <@${session.userId}>. System action: flagged for review; no role was granted.`);
        }
        if (emailSendCooldowns.has(email) && Date.now() - emailSendCooldowns.get(email) < 60_000) {
          return html(res, 429, page(token, "Wait 60 seconds before requesting another code for this email."));
        }
        const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
        session.email = email;
        session.codeHash = hashCode(token + ":" + code);
        session.codeExpiresAt = Date.now() + CODE_TTL_MS;
        session.attempts = 0;
        session.ipHash = assessment.ipHash;
        session.lastCodeSentAt = Date.now();
        session.username ||= makeUsername();
        emailSendCooldowns.set(email, Date.now());
        try {
          await getMailer().sendMail({
            from: process.env.VERIFICATION_FROM,
            to: email,
            subject: "Your Timi verification code",
            text: `Your Timi verification code is ${code}. It expires in 10 minutes. If you did not request this, ignore this email.`,
            html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px"><h2>Timi verification</h2><p>Your one-time code is:</p><p style="font-size:32px;letter-spacing:8px;font-weight:700">${code}</p><p>This code expires in 10 minutes. If you did not request it, ignore this message.</p></div>`
          });
        } catch (error) {
          console.error("Verification email delivery failed:", error.message);
          return html(res, 503, page(token, "Email could not be sent. Try again later or contact the server owner."));
        }
        return html(res, 200, `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Code sent</title><body style="font:16px -apple-system,sans-serif;background:#f5f5f7;display:grid;place-items:center;min-height:100vh;padding:20px"><main style="background:white;border:1px solid #ddd;border-radius:24px;padding:30px;max-width:420px"><h1>Check your email</h1><p>A one-time code has been sent if the address can receive mail.</p><p>Return to Discord and run <b>/verifycode</b>, then enter the code in the modal. The code expires in 10 minutes.</p></main></body>`);
      }
      html(res, 404, "<!doctype html><title>Not found</title><h1>Not found</h1>");
    } catch (error) {
      console.error("Verification web request failed:", error.message);
      if (!res.headersSent) json(res, 500, { error: "Internal server error" });
      else res.end();
    }
  });
  server.listen(port, "0.0.0.0", () => console.log(`Timi verification website listening on port ${port}`));
}
function buildPanel(settings) {
  const embed = new EmbedBuilder().setColor(0x808080).setTitle(settings.panelTitle).setDescription(settings.panelDescription);
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("verify:start").setLabel("Verify").setStyle(ButtonStyle.Primary));
  return { embeds: [embed], components: [row] };
}
function makeCodeModal() {
  return new ModalBuilder().setCustomId("verify:code-submit").setTitle("Enter verification code").addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("code").setLabel("6-digit email code").setStyle(TextInputStyle.Short).setMinLength(6).setMaxLength(6).setRequired(true).setPlaceholder("000000"))
  );
}
function makeUsernameModal(username) {
  return new ModalBuilder().setCustomId("verify:username-submit").setTitle("Claim your Timi username").addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("username").setLabel("Type your generated username").setStyle(TextInputStyle.Short).setMinLength(3).setMaxLength(32).setRequired(true).setValue(username))
  );
}
function makeSessionUrl(token) {
  const base = (process.env.BASE_URL || "").replace(/\/$/, "");
  if (!/^https:\/\//i.test(base)) throw new Error("Set BASE_URL to the public HTTPS URL of the verification website.");
  return `${base}/verify?session=${token}`;
}
async function handleInteraction(interaction, client) {
  if (!interaction.customId?.startsWith("verify:")) return false;
  if (!interaction.inGuild()) {
    await interaction.reply({ content: "Verification can only be used in a server.", ephemeral: true });
    return true;
  }
  const settings = getSettings(interaction.guildId);
  if (interaction.customId === "verify:start") {
    const token = randomToken();
    sessions.set(token, { userId: interaction.user.id, guildId: interaction.guildId, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS, attempts: 0, used: false });
    let link;
    try {
      link = makeSessionUrl(token);
    } catch (error) {
      sessions.delete(token);
      console.error("Could not create verification URL:", error.message);
      await interaction.reply({
        content: "The verification website is not configured yet. Please contact the server owner.",
        ephemeral: true
      });
      return true;
    }
    await interaction.reply({
      content: `Open this secure verification link: ${link}\n\nEnter your email on the website. After the code is sent, return to Discord and use /verifycode. This link expires in 30 minutes and is private to your verification session.`,
      ephemeral: true
    });
    return true;
  }
  if (interaction.customId === "verify:code-open") {
    const session = [...sessions.values()].find(item => item.userId === interaction.user.id && item.guildId === interaction.guildId && item.email && !item.used && item.expiresAt > Date.now());
    if (!session) {
      await interaction.reply({ content: "Start with the Verify button and request a code from the website first.", ephemeral: true });
      return true;
    }
    await interaction.showModal(makeCodeModal());
    return true;
  }
  if (interaction.customId === "verify:code-submit" && interaction.isModalSubmit()) {
    const entry = [...sessions.entries()].find(([, item]) => item.userId === interaction.user.id && item.guildId === interaction.guildId && item.email && !item.used && item.expiresAt > Date.now() && item.codeHash);
    if (!entry) {
      await interaction.reply({ content: "No active code was found. Restart verification from the panel.", ephemeral: true });
      return true;
    }
    const [token, session] = entry;
    if (Date.now() > session.codeExpiresAt) {
      await interaction.reply({ content: "That code expired. Restart verification and request a new one.", ephemeral: true });
      return true;
    }
    const code = interaction.fields.getTextInputValue("code").trim();
    session.attempts = (session.attempts || 0) + 1;
    if (session.attempts > MAX_CODE_ATTEMPTS) {
      session.used = true;
      await interaction.reply({ content: "Too many incorrect attempts. Restart verification later.", ephemeral: true });
      return true;
    }
    if (!/^\d{6}$/.test(code) || hashCode(token + ":" + code) !== session.codeHash) {
      if (session.attempts >= 3) await sendSecurityAlert(client, session.guildId, `Verification anomaly: <@${session.userId}> has ${session.attempts} failed code attempts. Flagged for owner review.`);
      await interaction.reply({ content: "That code is incorrect. Check the email and try again.", ephemeral: true });
      return true;
    }
    session.codeHash = null;
    session.used = true;
    session.verifiedAt = Date.now();
    session.username ||= makeUsername();
    const guild = interaction.guild;
    if (!settings.roleId) {
      await interaction.reply({ content: "Email verified, but no verification role is configured. Ask the server owner to run /verificationconfig.", ephemeral: true });
      return true;
    }
    const role = await guild.roles.fetch(settings.roleId).catch(() => null);
    const member = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (!role || !member) {
      await interaction.reply({ content: "Email verified, but the configured role or member could not be found. Contact a server manager.", ephemeral: true });
      return true;
    }
    if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles) || !role.editable) {
      await interaction.reply({ content: "Email verified, but Timi cannot assign the configured role. Move Timi's role above the verification role and grant Manage Roles.", ephemeral: true });
      return true;
    }
    try {
      await member.roles.add(role, "Timi email verification completed");
    } catch (error) {
      console.error("Could not grant verification role:", error.message);
      await interaction.reply({ content: "Email verified, but Discord rejected the role assignment. Check Timi's permissions and role hierarchy.", ephemeral: true });
      return true;
    }
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("verify:username-open").setLabel("Claim username").setStyle(ButtonStyle.Primary));
    await interaction.reply({ content: `Email verified and <@&${role.id}> granted. Your generated username is **${session.username}**. Use the button below to claim it.`, components: [row], ephemeral: true });
    return true;
  }
  if (interaction.customId === "verify:username-open") {
    const session = [...sessions.values()].find(item => item.userId === interaction.user.id && item.guildId === interaction.guildId && item.verifiedAt && !item.usernameClaimed);
    if (!session) {
      await interaction.reply({ content: "No unclaimed username was found for this account.", ephemeral: true });
      return true;
    }
    await interaction.showModal(makeUsernameModal(session.username));
    return true;
  }
  if (interaction.customId === "verify:username-submit" && interaction.isModalSubmit()) {
    const session = [...sessions.values()].find(item => item.userId === interaction.user.id && item.guildId === interaction.guildId && item.verifiedAt && !item.usernameClaimed);
    if (!session) {
      await interaction.reply({ content: "This username claim has expired or was already used.", ephemeral: true });
      return true;
    }
    const submitted = interaction.fields.getTextInputValue("username").trim();
    if (submitted !== session.username) {
      await interaction.reply({ content: "That does not match your generated username. Use the exact username shown in your verification message.", ephemeral: true });
      return true;
    }
    const store = readStore();
    const claims = store.guilds[interaction.guildId]?.claimedUsernames || {};
    const normalized = submitted.toLowerCase();
    if (claims[normalized] && claims[normalized] !== interaction.user.id) {
      await interaction.reply({ content: "That username is already claimed. Contact a server manager.", ephemeral: true });
      return true;
    }
    claims[normalized] = interaction.user.id;
    store.guilds[interaction.guildId] = { ...getSettings(interaction.guildId), claimedUsernames: claims };
    writeStore();
    session.usernameClaimed = true;
    session.claimedAt = Date.now();
    await interaction.reply({ content: `Username **${submitted}** successfully claimed.`, ephemeral: true });
    return true;
  }
  return false;
}
function startSessionCleanup() {
  setInterval(() => {
    const now = Date.now();
    for (const [token, session] of sessions) if (session.expiresAt < now) sessions.delete(token);
    for (const [email, timestamp] of emailSendCooldowns) if (now - timestamp > 5 * 60_000) emailSendCooldowns.delete(email);
  }, 60_000).unref();
}
startSessionCleanup();

module.exports = {
  startWebServer,
  handleInteraction,
  buildPanel,
  getSettings,
  saveSettings,
  makeSessionUrl
};
