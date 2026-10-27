const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const path = require("path");
const { createClient } = require("redis");

loadLocalEnv();

const app = express();
const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL;
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const COOKIE_NAME = "session";

// Redis has no folders. This prefix is the isolated "folder" for this app.
// Every read and write stays under it, so a shared Render Key Value store
// used by another service is left untouched.
const KEY_NAMESPACE = normalizeNamespace(process.env.REDIS_KEY_PREFIX || "agent-incentive/");

const DAY_INDEX_KEY = key("day-index");
const AGENTS_KEY = key("agents");

app.set("trust proxy", 1);
app.use(express.json({ limit: "64kb" }));

let redisClient = null;
const loginAttempts = new Map();

function passwordMatches(input) {
  const given = crypto.createHash("sha256").update(String(input)).digest();
  const expected = crypto.createHash("sha256").update(AUTH_PASSWORD).digest();
  return crypto.timingSafeEqual(given, expected);
}

function signSession() {
  const body = Buffer.from(
    JSON.stringify({ exp: Date.now() + SESSION_MS })
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function readSession(req) {
  const raw = req.headers.cookie || "";
  const part = raw
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${COOKIE_NAME}=`));
  if (!part) return null;
  const token = decodeURIComponent(part.slice(COOKIE_NAME.length + 1));
  const dot = token.indexOf(".");
  if (dot === -1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!payload || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function setSessionCookie(res) {
  const secure = process.env.NODE_ENV === "production" || Boolean(process.env.RENDER);
  const parts = [
    `${COOKIE_NAME}=${signSession()}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${Math.floor(SESSION_MS / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === "production" || Boolean(process.env.RENDER);
  const parts = [`${COOKIE_NAME}=`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clientIp(req) {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function tooManyAttempts(ip) {
  const now = Date.now();
  const recent = (loginAttempts.get(ip) || []).filter((at) => now - at < 15 * 60 * 1000);
  loginAttempts.set(ip, recent);
  return recent.length >= 8;
}

function requireAuth(req, res, next) {
  if (!AUTH_PASSWORD || !SESSION_SECRET) {
    return res.status(503).json({ error: "Login is not configured on the server." });
  }
  if (!readSession(req)) {
    return res.status(401).json({ error: "Login required" });
  }
  next();
}

app.post("/api/login", (req, res) => {
  if (!AUTH_PASSWORD || !SESSION_SECRET) {
    return res.status(503).json({ error: "Login is not configured on the server." });
  }
  const ip = clientIp(req);
  if (tooManyAttempts(ip)) {
    return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
  }
  const password = req.body && req.body.password;
  if (typeof password !== "string" || !passwordMatches(password)) {
    const recent = loginAttempts.get(ip) || [];
    recent.push(Date.now());
    loginAttempts.set(ip, recent);
    return res.status(401).json({ error: "Wrong password" });
  }
  loginAttempts.delete(ip);
  setSessionCookie(res);
  res.json({ ok: true });
});

app.post("/api/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/session", (req, res) => {
  if (!readSession(req)) {
    return res.status(401).json({ ok: false });
  }
  res.json({ ok: true });
});

app.use((req, res, next) => {
  if (req.path === "/styles.css") return next();
  const signedIn = Boolean(SESSION_SECRET) && Boolean(readSession(req));
  if (req.path.startsWith("/api/")) return next();
  if (req.path === "/login.html") {
    if (signedIn) return res.redirect("/");
    return next();
  }
  if (!signedIn && (req.path === "/" || req.path === "/index.html" || req.path === "/script.js")) {
    if (req.path === "/script.js") return res.status(401).type("text/plain").send("Login required");
    return res.redirect("/login.html");
  }
  next();
});

function loadLocalEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const name = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[name] == null || process.env[name] === "") {
      process.env[name] = value;
    }
  }
}

function normalizeNamespace(prefix) {
  const cleaned = String(prefix).trim().replace(/^\/+/, "");
  if (!cleaned || cleaned.includes("..") || /[\s\r\n]/.test(cleaned)) {
    throw new Error("REDIS_KEY_PREFIX must be a simple path-like prefix such as agent-incentive/");
  }
  return cleaned.endsWith("/") ? cleaned : `${cleaned}/`;
}

function key(suffix) {
  if (typeof suffix !== "string" || !suffix || suffix.includes("..") || suffix.startsWith("/")) {
    throw new Error("Invalid Redis key suffix");
  }
  const full = `${KEY_NAMESPACE}${suffix}`;
  if (!full.startsWith(KEY_NAMESPACE)) {
    throw new Error("Refusing Redis key outside the agent-incentive namespace");
  }
  return full;
}

function dayKey(date) {
  return key(`days/${date}`);
}

function isValidDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date);
}

function finiteNonNegative(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n < 1e12 ? n : null;
}

function finiteRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 1e7) return null;
  return Math.round(n * 100) / 100;
}

function sanitizeAgentList(list) {
  if (!Array.isArray(list) || list.length > 50) return null;
  const clean = [];
  const seen = new Set();
  for (const agent of list) {
    if (!agent || typeof agent !== "object") return null;
    const name = String(agent.name || "").trim();
    if (!/^[A-Za-z][A-Za-z0-9 .'-]{0,39}$/.test(name)) return null;
    const keyName = name.toLowerCase();
    if (seen.has(keyName)) return null;
    seen.add(keyName);

    const hasRates = agent.cardPerMaan != null || agent.kouzaPerMaan != null;
    const hasFactors = agent.cardFactor != null || agent.kouzaFactor != null;
    if (hasRates && !hasFactors) {
      const cardPerMaan = finiteRate(agent.cardPerMaan);
      const kouzaPerMaan = finiteRate(agent.kouzaPerMaan);
      if (cardPerMaan == null || kouzaPerMaan == null) return null;
      clean.push({ name, cardPerMaan, kouzaPerMaan });
    } else if (hasFactors && !hasRates) {
      const cardFactor = finiteRate(agent.cardFactor);
      const kouzaFactor = finiteRate(agent.kouzaFactor);
      if (cardFactor == null || kouzaFactor == null) return null;
      clean.push({ name, cardFactor, kouzaFactor });
    } else {
      return null;
    }
  }
  return clean;
}

function sanitizeAgents(agents) {
  const clean = {};
  for (const [name, value] of Object.entries(agents)) {
    if (!/^[A-Za-z][A-Za-z0-9 .'-]{0,39}$/.test(name)) continue;
    if (!value || typeof value !== "object") continue;
    const cardMaan = finiteNonNegative(value.cardMaan);
    const kouzaMaan = finiteNonNegative(value.kouzaMaan);
    const totalInr = finiteNonNegative(value.totalInr);
    if (cardMaan == null || kouzaMaan == null || totalInr == null) continue;
    clean[name] = { cardMaan, kouzaMaan, totalInr };
  }
  return clean;
}

async function getRedis() {
  if (!REDIS_URL) return null;
  if (redisClient?.isOpen) return redisClient;

  if (redisClient) {
    try {
      await redisClient.disconnect();
    } catch {
      // The previous socket is already gone.
    }
    redisClient = null;
  }

  const client = createClient({
    url: REDIS_URL,
    socket: {
      reconnectStrategy: (retries) => Math.min(retries * 100, 3000),
    },
  });
  client.on("error", (err) => {
    console.error("Redis error:", err.message);
  });
  await client.connect();
  redisClient = client;
  return redisClient;
}

function redisNotConfigured(res) {
  return res.status(503).json({
    error: "Redis is not configured. Set REDIS_URL on the Render web service.",
  });
}

app.get("/api/health", requireAuth, async (_req, res) => {
  try {
    if (!REDIS_URL) {
      return res.json({
        ok: true,
        redis: false,
        namespace: KEY_NAMESPACE,
        message: "REDIS_URL not set",
      });
    }
    const redis = await getRedis();
    await redis.ping();
    res.json({ ok: true, redis: true, namespace: KEY_NAMESPACE });
  } catch (err) {
    res.status(503).json({
      ok: false,
      redis: false,
      namespace: KEY_NAMESPACE,
      error: err.message,
    });
  }
});

app.get("/api/agents", requireAuth, async (_req, res) => {
  try {
    const redis = await getRedis();
    if (!redis) return res.json({ agents: null, persisted: false });
    const raw = await redis.get(AGENTS_KEY);
    if (!raw) return res.json({ agents: null, persisted: true });
    const agents = sanitizeAgentList(JSON.parse(raw));
    if (!agents) return res.status(500).json({ error: "Saved agent list is invalid" });
    res.json({ agents, persisted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/agents", requireAuth, async (req, res) => {
  const agents = sanitizeAgentList(req.body && req.body.agents);
  if (!agents) {
    return res.status(400).json({ error: "Agent list is not valid" });
  }
  try {
    const redis = await getRedis();
    if (!redis) return redisNotConfigured(res);
    await redis.set(AGENTS_KEY, JSON.stringify(agents));
    res.json({ ok: true, agents });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/days", requireAuth, async (_req, res) => {
  try {
    const redis = await getRedis();
    if (!redis) return redisNotConfigured(res);
    const dates = await redis.sMembers(DAY_INDEX_KEY);
    dates.sort((a, b) => b.localeCompare(a));
    res.json({ dates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/days/:date", requireAuth, async (req, res) => {
  const { date } = req.params;
  if (!isValidDate(date)) {
    return res.status(400).json({ error: "Date must be YYYY-MM-DD" });
  }
  try {
    const redis = await getRedis();
    if (!redis) return redisNotConfigured(res);
    const raw = await redis.get(dayKey(date));
    if (!raw) {
      return res.status(404).json({ error: "No saved data for this date" });
    }
    res.json(JSON.parse(raw));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/days/:date", requireAuth, async (req, res) => {
  const { date } = req.params;
  if (!isValidDate(date)) {
    return res.status(400).json({ error: "Date must be YYYY-MM-DD" });
  }
  const body = req.body;
  if (!body || typeof body !== "object" || !body.agents || typeof body.agents !== "object" || Array.isArray(body.agents)) {
    return res.status(400).json({ error: "Body must include an agents object" });
  }

  const agents = sanitizeAgents(body.agents);
  if (Object.keys(agents).length === 0) {
    return res.status(400).json({ error: "No valid agent rows to save" });
  }

  const grandTotal = Object.values(agents).reduce((sum, row) => sum + row.totalInr, 0);
  const record = {
    date,
    savedAt: new Date().toISOString(),
    grandTotal,
    agents,
  };

  try {
    const redis = await getRedis();
    if (!redis) return redisNotConfigured(res);
    await redis.set(dayKey(date), JSON.stringify(record));
    await redis.sAdd(DAY_INDEX_KEY, date);
    res.json({ ok: true, record });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Agent Incentive app listening on port ${PORT}`);
  console.log(`Redis key namespace: ${KEY_NAMESPACE}`);
  if (!REDIS_URL) {
    console.warn("REDIS_URL is not set — save/load stays unavailable until it is configured.");
  }
  if (!AUTH_PASSWORD || !SESSION_SECRET) {
    console.warn("AUTH_PASSWORD or SESSION_SECRET is missing — login will stay closed.");
  }
});
