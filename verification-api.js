const http = require("node:http");
const crypto = require("node:crypto");
const nodemailer = require("nodemailer");

const sessions = new Map();
const jobs = new Map();
const emailCooldowns = new Map();
const CODE_TTL = 10 * 60 * 1000;
const SESSION_TTL = 30 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_BODY = 8192;

function send(res, status, body, headers = {}) {
  const raw = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(raw), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  res.end(raw);
}
function authorized(req) {
  const expected = process.env.BOT_API_SECRET || "";
  const supplied = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected), b = Buffer.from(supplied);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function originHeaders(req) {
  const origin = req.headers.origin;
  const allowed = (process.env.FRONTEND_ORIGIN || "").replace(/\/$/, "");
  const headers = { "Vary": "Origin", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Accept", "Access-Control-Max-Age": "600" };
  if (origin && allowed && origin === allowed) headers["Access-Control-Allow-Origin"] = allowed;
  return headers;
}
async function body(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) throw Object.assign(new Error("Request too large."), { status: 413 });
  }
  try { return JSON.parse(raw || "{}"); } catch { throw Object.assign(new Error("Invalid JSON body."), { status: 400 }); }
}
function validToken(token) { return typeof token === "string" && /^[a-f0-9]{64}$/i.test(token); }
function sessionFor(token) {
  const s = sessions.get(token);
  if (!validToken(token) || !s || s.expiresAt < Date.now() || s.used) return null;
  return s;
}
function mailer() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, VERIFICATION_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !VERIFICATION_FROM) throw new Error("Email delivery is not configured.");
  return nodemailer.createTransport({ host: SMTP_HOST, port: Number(SMTP_PORT || 587), secure: Number(SMTP_PORT) === 465, auth: { user: SMTP_USER, pass: SMTP_PASS } });
}
function htmlError(message) {
  const safe = String(message).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  return "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Timi verification</title><body style=\"font:16px -apple-system,BlinkMacSystemFont,sans-serif;background:#f5f5f7;color:#1d1d1f;padding:32px\"><main style=\"max-width:480px;margin:12vh auto;background:white;padding:28px;border-radius:24px\"><h1>Verification link unavailable</h1><p>" + safe + "</p><p>Return to Discord and press Verify to create a new link.</p></main></body></html>";
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const cors = originHeaders(req);
  try {
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, service: "timi-verification-api" });
    if (url.pathname.startsWith("/internal/")) {
      if (!authorized(req)) return send(res, 401, { ok: false, message: "Unauthorized." });
      if (req.method === "POST" && url.pathname === "/internal/sessions") {
        const p = await body(req);
        if (!/^\d{15,22}$/.test(p.userId || "") || !/^\d{15,22}$/.test(p.guildId || "")) return send(res, 400, { ok: false, message: "Invalid Discord identifiers." });
        const token = crypto.randomBytes(32).toString("hex");
        sessions.set(token, { userId: p.userId, guildId: p.guildId, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL, attempts: 0, used: false, status: "awaiting_email" });
        const base = (process.env.BASE_URL || "").replace(/\/$/, "");
        if (!/^https:\/\//i.test(base)) return send(res, 503, { ok: false, message: "BASE_URL must be the public HTTPS website URL." });
        return send(res, 201, { ok: true, url: base + "/?session=" + token });
      }
      if (req.method === "GET" && url.pathname === "/internal/jobs") {
        const pending = [...jobs.values()].filter(j => j.status === "pending").slice(0, 20);
        for (const j of pending) j.status = "processing";
        return send(res, 200, { ok: true, jobs: pending.map(j => ({ id: j.id, userId: j.userId, guildId: j.guildId })) });
      }
      const match = url.pathname.match(/^\/internal\/jobs\/([a-f0-9]{64})\/result$/);
      if (req.method === "POST" && match) {
        const job = jobs.get(match[1]);
        if (!job || !["processing", "pending"].includes(job.status)) return send(res, 404, { ok: false, message: "Job not found or already completed." });
        const p = await body(req);
        job.status = p.ok ? "completed" : "failed";
        job.result = { ok: Boolean(p.ok), message: String(p.message || (p.ok ? "Verification complete." : "Role assignment failed.")).slice(0, 500), roleName: p.roleName || "" };
        job.finishedAt = Date.now();
        const s = sessions.get(job.token);
        if (s) { s.status = job.status; s.result = job.result; s.used = true; }
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { ok: false, message: "Not found." });
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/verify")) {
      const token = url.searchParams.get("session") || "";
      if (!sessionFor(token)) { res.writeHead(400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); return res.end(htmlError("This verification link is invalid, expired, or already used.")); }
      res.writeHead(302, { Location: (process.env.FRONTEND_ORIGIN || "") + "/?session=" + encodeURIComponent(token), "Cache-Control": "no-store" }); return res.end();
    }
    if (url.pathname === "/api/status" && req.method === "GET") {
      const token = url.searchParams.get("session") || "";
      const s = sessions.get(token);
      if (!validToken(token) || !s || s.expiresAt < Date.now()) return send(res, 400, { ok: false, message: "Verification session expired. Return to Discord and start again." }, cors);
      return send(res, 200, { ok: true, status: s.status || "awaiting_email", result: s.result || null }, cors);
    }
    const apiRoutes = ["/api/request-code", "/api/verify-code"];
    if (apiRoutes.includes(url.pathname) && req.method === "OPTIONS") {
      const origin = req.headers.origin, allowed = (process.env.FRONTEND_ORIGIN || "").replace(/\/$/, "");
      if (!origin || origin !== allowed) return send(res, 403, { ok: false, message: "Origin not allowed." });
      res.writeHead(204, cors); return res.end();
    }
    if (apiRoutes.includes(url.pathname) && req.method === "POST") {
      const origin = req.headers.origin, allowed = (process.env.FRONTEND_ORIGIN || "").replace(/\/$/, "");
      if (origin && origin !== allowed) return send(res, 403, { ok: false, message: "This website is not allowed to use the verification API." }, cors);
      const p = await body(req), token = p.session || "", s = sessionFor(token);
      if (!s) return send(res, 400, { ok: false, message: "This verification link is invalid, expired, or already used. Return to Discord and press Verify again." }, cors);
      if (url.pathname === "/api/request-code") {
        const email = typeof p.email === "string" ? p.email.trim().toLowerCase() : "";
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return send(res, 400, { ok: false, message: "Enter a valid email address." }, cors);
        if (emailCooldowns.has(email) && Date.now() - emailCooldowns.get(email) < 60000) return send(res, 429, { ok: false, message: "Wait 60 seconds before requesting another code for this email." }, cors);
        const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
        s.email = email; s.codeHash = crypto.createHash("sha256").update(token + ":" + code).digest("hex"); s.codeExpiresAt = Date.now() + CODE_TTL; s.attempts = 0;
        emailCooldowns.set(email, Date.now());
        try {
          await mailer().sendMail({ from: process.env.VERIFICATION_FROM, to: email, subject: "Your Timi verification code", text: "Your Timi verification code is " + code + ". It expires in 10 minutes. If you did not request this, ignore this email.", html: "<div style=\"font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#1d1d1f\"><h2>Timi verification</h2><p>Your one-time code is:</p><p style=\"font-size:32px;letter-spacing:8px;font-weight:700\">" + code + "</p><p>This code expires in 10 minutes. If you did not request it, ignore this message.</p></div>" });
        } catch (e) { emailCooldowns.delete(email); console.error("Email send failed:", e.message); return send(res, 503, { ok: false, message: "Email could not be sent. Check the server's email configuration." }, cors); }
        return send(res, 200, { ok: true, message: "Check your inbox for the six-digit code. It expires in 10 minutes." }, cors);
      }
      const code = typeof p.code === "string" ? p.code.trim() : "";
      if (!s.email || !s.codeHash) return send(res, 400, { ok: false, message: "Request a verification code first." }, cors);
      if (Date.now() > s.codeExpiresAt) return send(res, 400, { ok: false, message: "That code expired. Request a new one." }, cors);
      s.attempts++;
      if (s.attempts > MAX_ATTEMPTS) { s.used = true; return send(res, 429, { ok: false, message: "Too many incorrect attempts. Return to Discord and start again." }, cors); }
      const hash = crypto.createHash("sha256").update(token + ":" + code).digest("hex");
      if (!/^\d{6}$/.test(code) || hash !== s.codeHash) return send(res, 400, { ok: false, message: "That code is incorrect. Check your email and try again." }, cors);
      s.codeHash = null; s.status = "processing";
      const id = crypto.randomBytes(32).toString("hex");
      jobs.set(id, { id, token, userId: s.userId, guildId: s.guildId, status: "pending", createdAt: Date.now() });
      s.jobId = id;
      return send(res, 200, { ok: true, status: "processing", message: "Email confirmed. Timi is assigning your Discord role." }, cors);
    }
    return send(res, 404, { ok: false, message: "Not found." }, cors);
  } catch (e) {
    console.error("Verification API request failed:", e.message);
    return send(res, e.status || 500, { ok: false, message: e.status ? e.message : "Internal server error." }, originHeaders(req));
  }
});
setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions) if (s.expiresAt < now) sessions.delete(token);
  for (const [id, j] of jobs) if (now - j.createdAt > 60 * 60 * 1000) jobs.delete(id);
  for (const [email, t] of emailCooldowns) if (now - t > 5 * 60 * 1000) emailCooldowns.delete(email);
}, 60000).unref();
const port = Number(process.env.PORT || 3000);
server.listen(port, "0.0.0.0", () => console.log("Timi verification API listening on port " + port));
