/**
 * Vercel Node.js Serverless — POST /api/send
 *
 * Actions:
 *   welcome  — sends a welcome / profile-confirmed email
 *   digest   — sends the daily digest email
 *
 * Required env vars (set in Vercel project settings):
 *   RESEND_API_KEY   — from resend.com dashboard
 *   FROM_EMAIL       — e.g. "Signal <digest@yourdomain.com>"
 *                      must be a verified domain in Resend
 */

const RESEND_URL = "https://api.resend.com/emails";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function parseBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  const raw = typeof req.body === "string" ? req.body : "";
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

// ── EMAIL TEMPLATES ───────────────────────────────────────────────────────────

function welcomeHtml({ name, profileSummary, unlockDate, email }) {
  const firstName = name ? name.split(" ")[0] : "there";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Welcome to Signal</title>
<style>
  body { margin:0; padding:0; background:#FAFAF8; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color:#1A1A18; -webkit-font-smoothing:antialiased; }
  .wrap { max-width:580px; margin:0 auto; background:#fff; border:1px solid #E8E6E0; border-radius:12px; overflow:hidden; }
  .header { background:#1B4FD8; padding:28px 32px; }
  .header-logo { font-size:22px; font-weight:700; color:#fff; letter-spacing:-0.02em; }
  .header-logo span { opacity:0.6; }
  .body { padding:32px; }
  .greeting { font-size:24px; font-weight:700; margin-bottom:8px; letter-spacing:-0.02em; }
  .sub { font-size:15px; color:#6B6B64; line-height:1.65; margin-bottom:24px; }
  .profile-box { background:#F4F3EF; border:1px solid #E8E6E0; border-radius:10px; padding:20px 22px; margin-bottom:24px; }
  .profile-box-label { font-size:11px; font-weight:700; letter-spacing:0.1em; text-transform:uppercase; color:#9E9E96; margin-bottom:12px; }
  .profile-box p { font-size:13px; color:#1A1A18; line-height:1.75; white-space:pre-wrap; margin:0; }
  .divider { border:none; border-top:1px solid #E8E6E0; margin:24px 0; }
  .lock-note { font-size:13px; color:#6B6B64; line-height:1.6; margin-bottom:24px; }
  .lock-note strong { color:#1A1A18; }
  .cta { display:block; width:100%; text-align:center; padding:14px; background:#1B4FD8; color:#fff; font-size:15px; font-weight:700; text-decoration:none; border-radius:8px; box-sizing:border-box; }
  .footer { padding:20px 32px; text-align:center; font-size:12px; color:#9E9E96; border-top:1px solid #E8E6E0; }
  .footer a { color:#9E9E96; text-decoration:none; }
</style>
</head>
<body>
<div style="padding:24px 16px;">
  <div class="wrap">
    <div class="header">
      <div class="header-logo">Signal<span>.</span></div>
    </div>
    <div class="body">
      <div class="greeting">Welcome, ${firstName}!</div>
      <p class="sub">Your profile is confirmed and locked. Your first digest lands in your inbox tomorrow morning.</p>

      <div class="profile-box">
        <div class="profile-box-label">Your profile summary</div>
        <p>${profileSummary ? profileSummary.replace(/</g, "&lt;").replace(/>/g, "&gt;") : "Profile saved successfully."}</p>
      </div>

      <hr class="divider"/>

      <p class="lock-note">
        Your profile is locked until <strong>${unlockDate}</strong> so Signal can tune your digest over the first week.
        After that you can update it anytime from your dashboard.
      </p>

      <a class="cta" href="https://signal.app">Open your dashboard →</a>
    </div>
    <div class="footer">
      <p>You're receiving this because you signed up at signal.app with ${email}</p>
      <p style="margin-top:6px;"><a href="#">Unsubscribe</a> · <a href="#">Privacy</a></p>
    </div>
  </div>
</div>
</body>
</html>`;
}

function digestHtml({ name, digestContent, date }) {
  const firstName = name ? name.split(" ")[0] : "there";
  // Convert plain-text digest (with ━, bullets, etc.) to readable HTML
  const bodyHtml = digestContent
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/━+/g, '<hr style="border:none;border-top:1px solid #E8E6E0;margin:18px 0;"/>')
    .replace(/^(🔥|💡|📊|📺|🛠️)[^\n]+$/gm, m => `<p style="font-size:12px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#16A34A;margin:20px 0 8px;">${m}</p>`)
    .replace(/^(①|②|③|④|⑤)/gm, m => `<span style="color:#1B4FD8;font-weight:700;">${m}</span>`)
    .replace(/^→ .+$/gm, m => `<span style="font-size:12px;color:#1B4FD8;">${m}</span>`)
    .replace(/\n/g, "<br/>");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Your Signal digest — ${date}</title>
<style>
  body { margin:0; padding:0; background:#FAFAF8; font-family:'Helvetica Neue',Helvetica,Arial,sans-serif; color:#1A1A18; -webkit-font-smoothing:antialiased; }
  .wrap { max-width:580px; margin:0 auto; background:#fff; border:1px solid #E8E6E0; border-radius:12px; overflow:hidden; }
  .header { background:#1A1A18; padding:18px 28px; display:flex; justify-content:space-between; align-items:center; }
  .header-logo { font-size:18px; font-weight:700; color:#fff; letter-spacing:-0.02em; }
  .header-date { font-size:12px; color:rgba(255,255,255,0.5); }
  .body { padding:28px 32px; font-size:14px; line-height:1.8; color:#1A1A18; }
  .greeting { font-size:18px; font-weight:700; margin-bottom:18px; }
  hr { border:none; border-top:1px solid #E8E6E0; margin:18px 0; }
  .footer { padding:18px 28px; text-align:center; font-size:12px; color:#9E9E96; border-top:1px solid #E8E6E0; }
  .footer a { color:#9E9E96; text-decoration:none; }
</style>
</head>
<body>
<div style="padding:24px 16px;">
  <div class="wrap">
    <div class="header">
      <div class="header-logo">Signal.</div>
      <div class="header-date">${date}</div>
    </div>
    <div class="body">
      <div class="greeting">Good morning, ${firstName}.</div>
      ${bodyHtml}
    </div>
    <div class="footer">
      <p><a href="#">Unsubscribe</a> · <a href="#">Update preferences</a> · <a href="#">Privacy</a></p>
    </div>
  </div>
</div>
</body>
</html>`;
}

// ── HANDLER ───────────────────────────────────────────────────────────────────

async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    return res.status(200).json({ ok: true, route: "/api/send", runtime: "nodejs" });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = (process.env.RESEND_API_KEY || "").trim();
  const fromEmail = (process.env.FROM_EMAIL || "Signal <onboarding@resend.dev>").trim();

  if (!apiKey) {
    return res.status(400).json({ error: "Missing RESEND_API_KEY env var. Add it in Vercel project settings." });
  }

  try {
    const body = parseBody(req);
    const action = body.action || "welcome";
    const toEmail = (body.email || "").trim();

    if (!toEmail) return res.status(400).json({ error: "email is required" });

    let subject, html;

    // ── WELCOME ──────────────────────────────────────────────────────────────
    if (action === "welcome") {
      const name = body.name || "";
      const profileSummary = body.profileSummary || "";
      const unlockDate = body.unlockDate || "";

      subject = `Welcome to Signal${name ? `, ${name.split(" ")[0]}` : ""} — your digest starts tomorrow`;
      html = welcomeHtml({ name, profileSummary, unlockDate, email: toEmail });

    // ── DIGEST ───────────────────────────────────────────────────────────────
    } else if (action === "digest") {
      const name = body.name || "";
      const digestContent = body.digestContent || "";
      const date = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

      if (!digestContent) return res.status(400).json({ error: "digestContent is required" });

      subject = `Your Signal digest — ${date}`;
      html = digestHtml({ name, digestContent, date });

    } else {
      return res.status(400).json({ error: "Unknown action. Use 'welcome' or 'digest'." });
    }

    // Send via Resend
    const sendRes = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        subject,
        html,
      }),
    });

    const data = await sendRes.json();

    if (!sendRes.ok) {
      return res.status(sendRes.status).json({ error: data?.message || data?.name || "Resend API error", details: data });
    }

    return res.status(200).json({ ok: true, id: data.id, action });

  } catch (err) {
    return res.status(500).json({ error: err.message || "Server error" });
  }
}

module.exports = handler;
