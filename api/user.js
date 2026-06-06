/**
 * Vercel Node.js Serverless — /api/user
 *
 * All routes require Authorization: Bearer <token>
 *
 * POST { profile, plan, lockedUntil } — save profile + memory
 * POST { action: "feedback", topic, sentiment, storyTitle } — update memory
 *
 * GET — returns authenticated user + profile + memory
 */

const jwt = require("jsonwebtoken");
const { getDb } = require("./db");
const {
  buildMemoryFromOnboarding,
  applyFeedback,
  applyClick,
  ensureMemory,
} = require("./memory");

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function parseBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  const raw = typeof req.body === "string" ? req.body : "";
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

function extractEmail(req) {
  const secret = (process.env.JWT_SECRET || "").trim();
  if (!secret) return null;
  const header = req.headers?.authorization || "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  try {
    const decoded = jwt.verify(token, secret);
    return decoded.email || null;
  } catch {
    return null;
  }
}

function safeUser(user) {
  const { passwordHash, ...rest } = user;
  return rest;
}

async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const email = extractEmail(req);
  if (!email) {
    return res.status(401).json({ error: "Unauthorized. Please log in." });
  }

  try {
    const db = await getDb();
    const users = db.collection("users");

    if (req.method === "GET") {
      const user = await users.findOne({ email });
      if (!user) return res.status(404).json({ error: "User not found" });
      return res.status(200).json({ ok: true, user: safeUser(user) });
    }

    if (req.method === "POST") {
      const body = parseBody(req);
      const now = new Date();
      const action = (body.action || "save").trim();

      const user = await users.findOne({ email });

      // ── FEEDBACK — update memory from dashboard 👍/👎 ─────────────────────
      if (action === "feedback") {
        if (!user) return res.status(404).json({ error: "User not found" });

        const sentiment = (body.sentiment || "").trim();
        if (!["like", "dislike"].includes(sentiment)) {
          return res.status(400).json({ error: "sentiment must be 'like' or 'dislike'" });
        }

        const currentMemory = ensureMemory(user, user.profile);
        const updatedMemory = applyFeedback(currentMemory, {
          topic: body.topic,
          sentiment,
          storyTitle: body.storyTitle,
        });

        await users.updateOne(
          { email },
          { $set: { memory: updatedMemory, updatedAt: now } }
        );

        return res.status(200).json({ ok: true, memory: updatedMemory });
      }

      // ── CLICK / ENGAGEMENT — update memory from click activity ─────────────────────
      if (action === "click") {
        if (!user) return res.status(404).json({ error: "User not found" });

        const currentMemory = ensureMemory(user, user.profile);
        const updatedMemory = applyClick(currentMemory, {
          topic: body.topic,
          storyTitle: body.storyTitle,
          url: body.url,
        });

        await users.updateOne(
          { email },
          { $set: { memory: updatedMemory, updatedAt: now } }
        );

        return res.status(200).json({ ok: true, memory: updatedMemory });
      }

      // ── SAVE profile + memory ─────────────────────────────────────────────
      const update = { $set: { updatedAt: now } };

      if (body.name) update.$set.name = body.name;
      if (body.plan) update.$set.plan = body.plan;

      if (body.profile) {
        const profile = {
          summary: body.profile.summary || "",
          profession: body.profile.profession || "",
          goals: body.profile.goals || "",
          topics: body.profile.topics || "",
          avoid: body.profile.avoid || "",
          customSources: body.profile.customSources || "",
          language: body.profile.language || "English",
          country: body.profile.country || "",
          newsScope: body.profile.newsScope || "Mixed",
          digestLength: body.profile.digestLength || "Standard",
          tone: body.profile.tone || "",
          digestTime: body.profile.digestTime || "08:00",
          timezone: body.profile.timezone || "UTC",
          lockedUntil: body.lockedUntil ? new Date(body.lockedUntil) : null,
          savedAt: now,
        };
        update.$set.profile = profile;

        const memory = buildMemoryFromOnboarding({
          profession: profile.profession,
          goals: profile.goals,
          topics: profile.topics,
          avoid: profile.avoid,
          customSources: profile.customSources,
          summary: profile.summary,
          language: profile.language,
          country: profile.country,
          newsScope: profile.newsScope,
          digestLength: profile.digestLength,
        });
        update.$set.memory = memory;
      }

      if (user) {
        await users.updateOne({ email }, update);
      } else {
        return res.status(404).json({ error: "User not found. Complete signup first." });
      }

      return res.status(200).json({ ok: true, email });
    }

    return res.status(405).json({ error: "Method not allowed" });

  } catch (err) {
    console.error("user route error:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}

module.exports = handler;
