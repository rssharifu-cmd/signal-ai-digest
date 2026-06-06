/**
 * Vercel Node.js Serverless — /api/auth
 *
 * POST { action: "signup", email, password, name }
 *   → hash password → save user → return JWT
 *
 * POST { action: "login", email, password }
 *   → verify password → return JWT
 *
 * GET (Authorization: Bearer <token>)
 *   → verify JWT → return user
 *
 * Required env vars:
 *   MONGODB_URI   — MongoDB Atlas connection string
 *   JWT_SECRET    — any long random string (e.g. openssl rand -hex 32)
 */

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { getDb } = require("./db");

const SALT_ROUNDS = 10;
const JWT_EXPIRES = "7d";

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

function signToken(payload, secret) {
  return jwt.sign(payload, secret, { expiresIn: JWT_EXPIRES });
}

function verifyToken(token, secret) {
  return jwt.verify(token, secret);
}

function extractToken(req) {
  const header = req.headers?.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  return null;
}

// Strip sensitive fields before returning user to client
function safeUser(user) {
  const { passwordHash, ...rest } = user;
  return rest;
}

async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const jwtSecret = (process.env.JWT_SECRET || "").trim();
  if (!jwtSecret) {
    return res.status(500).json({ error: "JWT_SECRET env var not set. Add it in Vercel project settings." });
  }

  // ── GET /api/auth — verify token + return current user ───────────────────
  if (req.method === "GET") {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: "No token provided" });

    try {
      const decoded = verifyToken(token, jwtSecret);
      const db = await getDb();
      const user = await db.collection("users").findOne({ email: decoded.email });
      if (!user) return res.status(404).json({ error: "User not found" });
      return res.status(200).json({ ok: true, user: safeUser(user) });
    } catch (err) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = parseBody(req);
    const action = (body.action || "").trim();
    const email = (body.email || "").trim().toLowerCase();
    const password = (body.password || "").trim();

    if (!email) return res.status(400).json({ error: "email is required" });
    if (!password) return res.status(400).json({ error: "password is required" });
    if (password.length < 6) return res.status(400).json({ error: "password must be at least 6 characters" });

    const db = await getDb();
    const users = db.collection("users");

    // ── SIGNUP ──────────────────────────────────────────────────────────────
    if (action === "signup") {
      const name = (body.name || "").trim();

      // Check if email already exists
      const existing = await users.findOne({ email });
      if (existing) {
        return res.status(409).json({ error: "An account with this email already exists" });
      }

      const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
      const now = new Date();

      const newUser = {
        email,
        name,
        passwordHash,
        plan: "starter",
        active: false,        // activated after Stripe payment (Week 4)
        profile: null,
        createdAt: now,
        updatedAt: now,
      };

      await users.insertOne(newUser);

      const token = signToken({ email, name }, jwtSecret);

      return res.status(201).json({
        ok: true,
        token,
        user: safeUser(newUser),
      });
    }

    // ── LOGIN ────────────────────────────────────────────────────────────────
    if (action === "login") {
      const user = await users.findOne({ email });

      if (!user) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      // Users created before auth (no passwordHash) — prompt reset
      if (!user.passwordHash) {
        return res.status(401).json({
          error: "No password set for this account. Please sign up again.",
        });
      }

      const match = await bcrypt.compare(password, user.passwordHash);
      if (!match) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      // Update last login
      await users.updateOne({ email }, { $set: { lastLoginAt: new Date() } });

      const token = signToken({ email, name: user.name }, jwtSecret);

      return res.status(200).json({
        ok: true,
        token,
        user: safeUser(user),
      });
    }

    return res.status(400).json({ error: "Unknown action. Use 'signup' or 'login'." });

  } catch (err) {
    console.error("auth route error:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}

module.exports = handler;
