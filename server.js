const express = require("express");
const fs = require("fs");
const path = require("path");
const { createClient } = require("redis");

loadLocalEnv();

const app = express();
const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL;

// Redis has no folders. This prefix is the isolated "folder" for this app.
// Every read and write stays under it, so a shared Render Key Value store
// used by another service is left untouched.
const KEY_NAMESPACE = normalizeNamespace(process.env.REDIS_KEY_PREFIX || "agent-incentive/");

const DAY_INDEX_KEY = key("day-index");

app.use(express.json({ limit: "64kb" }));

let redisClient = null;

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

app.get("/api/health", async (_req, res) => {
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

app.get("/api/days", async (_req, res) => {
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

app.get("/api/days/:date", async (req, res) => {
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

app.put("/api/days/:date", async (req, res) => {
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
});
