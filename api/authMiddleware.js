const jwt = require("jsonwebtoken");

function cors(req, res) {
  const origin = req.headers?.origin || "";
  const allowedOrigins = [
    "http://localhost:3000",
    "http://localhost:5000",
    "http://localhost:5173",
    "http://127.0.0.1:5500",
    "http://127.0.0.1:3000",
    "https://sharflow.com",
    "https://www.sharflow.com"
  ];
  
  // Allow localhost, vercel.app preview deployments, and main domains
  if (allowedOrigins.includes(origin) || origin.endsWith(".vercel.app") || !origin) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "https://sharflow.com");
  }
  
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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

module.exports = { cors, extractEmail };
