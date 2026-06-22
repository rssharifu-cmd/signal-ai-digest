/**
 * Vercel Node.js Serverless — GET /api/cron
 *
 * Triggered daily at 8:00 AM UTC by Vercel Cron.
 * Orchestrates the full digest pipeline for every active user:
 *
 *   MongoDB → get all users
 *   For each user:
 *     → /api/news  — fetch Tavily + RSS + Reddit + YouTube
 *     → Groq       — summarize + personalize into digest
 *     → /api/send  — send beautiful HTML email
 *     → MongoDB    — save digest record
 *
 * Required env vars:
 *   MONGODB_URI, GROK_API_KEY, RESEND_API_KEY,
 *   FROM_EMAIL, TAVILY_API_KEY, YOUTUBE_API_KEY
 *
 * Security: CRON_SECRET header must match env var
 * (Vercel sets Authorization: Bearer <CRON_SECRET> automatically)
 */

const { getDb } = require("./db");
const { formatMemoryForPrompt, buildDigestPrompt, ensureMemory } = require("./memory");

const GROK_URL      = "https://api.groq.com/openai/v1/chat/completions";
const RESEND_URL    = "https://api.resend.com/emails";
const TAVILY_URL    = "https://api.tavily.com/search";
const YOUTUBE_URL   = "https://www.googleapis.com/youtube/v3/search";
const MODEL         = "llama-3.3-70b-versatile";
const TIMEOUT_MS    = 30000;

// ── HELPERS ───────────────────────────────────────────────────────────────────
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), ms)),
  ]);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── FETCH NEWS (inline — avoids internal HTTP call) ───────────────────────────
async function fetchNews(topics, profession, avoid) {
  const tavilyKey  = (process.env.TAVILY_API_KEY  || "").trim();
  const youtubeKey = (process.env.YOUTUBE_API_KEY || "").trim();

  // --- Tavily ---
  async function tavily() {
    if (!tavilyKey) return [];
    try {
      const res = await withTimeout(fetch(TAVILY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: tavilyKey,
          query: `Latest news: ${topics || "technology AI business"}`,
          search_depth: "advanced",
          include_answer: false,
          include_raw_content: false,
          max_results: 6,
          exclude_domains: avoid
            ? avoid.split(",").map(s => s.trim()).filter(Boolean)
            : [],
        }),
      }), TIMEOUT_MS);
      if (!res.ok) {
        console.log(`[${new Date().toISOString()}] [CRON] Tavily bad response: fallback to RSS + Reddit`);
        return [];
      }
      const data = await res.json();
      return (data.results || []).map(r => ({
        source: "tavily",
        title: r.title || "",
        url: r.url || "",
        snippet: (r.content || r.snippet || "").slice(0, 400),
      }));
    } catch (err) {
      console.log(`[${new Date().toISOString()}] [CRON] Tavily failed/timeout: fallback to RSS + Reddit. Error:`, err.message);
      return [];
    }
  }

  // --- Reddit ---
  async function reddit() {
    const subredditMap = {
      "ai": "artificial", "ml": "MachineLearning", "startup": "startups",
      "finance": "finance", "tech": "technology", "politics": "worldnews",
      "crypto": "CryptoCurrency", "marketing": "marketing", "design": "design",
      "climate": "climate", "engineering": "programming",
    };
    const topicsLower = (topics || "").toLowerCase();
    let subreddit = "technology";
    for (const [key, sub] of Object.entries(subredditMap)) {
      if (topicsLower.includes(key)) { subreddit = sub; break; }
    }
    try {
      const res = await withTimeout(
        fetch(`https://www.reddit.com/r/${subreddit}/hot.json?limit=6`, {
          headers: { "User-Agent": "Signal-NewsDigest/1.0" },
        }), TIMEOUT_MS
      );
      if (!res.ok) return [];
      const data = await res.json();
      return (data?.data?.children || [])
        .filter(p => !p.data?.stickied && !p.data?.over_18)
        .slice(0, 3)
        .map(p => ({
          source: "reddit",
          title: p.data?.title || "",
          url: `https://reddit.com${p.data?.permalink || ""}`,
          snippet: `${p.data?.ups || 0} upvotes · r/${p.data?.subreddit}`,
        }));
    } catch (err) {
      console.log(`[${new Date().toISOString()}] [CRON] Reddit failed:`, err.message);
      return [];
    }
  }

  // --- RSS (matches dashboard pipeline) ---
  async function rss() {
    const topicsLower = (topics || "").toLowerCase();
    const feedMap = [
      { keys: ["ai", "ml", "machine learning"], url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
      { keys: ["startup"], url: "https://techcrunch.com/category/startups/feed/" },
      { keys: ["finance", "market", "economy"], url: "https://feeds.bbci.co.uk/news/business/rss.xml" },
      { keys: ["tech", "engineering", "software"], url: "https://feeds.feedburner.com/TechCrunch" },
      { keys: ["politics", "world", "geopolitics"], url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
    ];
    let feedUrl = "https://feeds.bbci.co.uk/news/rss.xml";
    for (const { keys, url } of feedMap) {
      if (keys.some((k) => topicsLower.includes(k))) { feedUrl = url; break; }
    }
    try {
      const res = await withTimeout(
        fetch(feedUrl, { headers: { "User-Agent": "Signal-NewsDigest/1.0" } }),
        TIMEOUT_MS
      );
      if (!res.ok) return [];
      const xml = await res.text();
      const items = [];
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;
      while ((match = itemRegex.exec(xml)) !== null && items.length < 4) {
        const block = match[1];
        const title = (/<title><!\[CDATA\[(.*?)\]\]><\/title>/.exec(block) || /<title>(.*?)<\/title>/.exec(block) || [])[1] || "";
        const link = (/<link>(.*?)<\/link>/.exec(block) || [])[1] || "";
        const desc = (/<description><!\[CDATA\[(.*?)\]\]><\/description>/.exec(block) || /<description>(.*?)<\/description>/.exec(block) || [])[1] || "";
        if (title && link) {
          items.push({
            source: "rss",
            title: title.replace(/&amp;/g, "&").trim(),
            url: link.trim(),
            snippet: desc.replace(/<[^>]+>/g, "").slice(0, 300).trim(),
          });
        }
      }
      return items;
    } catch (err) {
      console.log(`[${new Date().toISOString()}] [CRON] RSS failed:`, err.message);
      return [];
    }
  }

  // --- YouTube ---
  async function youtube() {
    if (!youtubeKey) return null;
    const primaryTopic = (topics || "technology").split(",")[0].trim();
    const query = `${primaryTopic} ${profession ? profession.split(" ")[0] : ""} 2025`.trim();
    try {
      const params = new URLSearchParams({
        part: "snippet", q: query, type: "video",
        order: "relevance", maxResults: "3",
        videoDuration: "medium", relevanceLanguage: "en",
        publishedAfter: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        key: youtubeKey,
      });
      const res = await withTimeout(fetch(`${YOUTUBE_URL}?${params}`), TIMEOUT_MS);
      if (!res.ok) return null;
      const data = await res.json();
      const item = (data.items || []).find(i => i.snippet?.title?.length > 10);
      if (!item) return null;
      return {
        title: item.snippet.title,
        channel: item.snippet.channelTitle,
        url: `https://youtube.com/watch?v=${item.id.videoId}`,
      };
    } catch (err) {
      console.log(`[${new Date().toISOString()}] [CRON] YouTube failed:`, err.message);
      return null;
    }
  }

  const [tavilyArticles, rssItems, redditPosts, video] = await Promise.all([
    tavily(), rss(), reddit(), youtube(),
  ]);

  return {
    articles: [...tavilyArticles, ...rssItems].slice(0, 8),
    reddit: redditPosts,
    video,
  };
}

// ── PERSONALIZED DIGEST GENERATION (Gemini with Groq Fallback) ────────────────
async function generateDigest(user, news) {
  const apiGrokKey = (process.env.GROK_API_KEY || "").trim();
  const apiGeminiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!apiGrokKey && !apiGeminiKey) {
    throw new Error("Neither GEMINI_API_KEY nor GROK_API_KEY is configured.");
  }

  const profile = user.profile || {};
  const memory = ensureMemory(user, profile);
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });

  const articleText = news.articles.length
    ? news.articles.map((a, i) =>
        `[${i + 1}] ${a.title}\nSource: ${a.source} | ${a.url}\n${a.snippet}`
      ).join("\n\n")
    : "No articles available.";

  const redditText = news.reddit.length
    ? news.reddit.map((r) => `[R] ${r.title}\n${r.snippet}\n${r.url}`).join("\n\n")
    : "";

  const videoText = news.video
    ? `VIDEO: "${news.video.title}" by ${news.video.channel}\n${news.video.url}`
    : "";

  const newsContext = [
    "ARTICLES:",
    articleText,
    redditText && "\nREDDIT:\n" + redditText,
    videoText && "\n" + videoText,
  ].filter(Boolean).join("\n");

  const memoryText = formatMemoryForPrompt(memory);
  const profileText = [
    user.name && `Name: ${user.name}`,
    profile.profession && `Role: ${profile.profession}`,
    profile.goals && `Goals: ${profile.goals}`,
    profile.topics && `Topics: ${profile.topics}`,
    profile.avoid && `Avoid: ${profile.avoid}`,
    profile.summary && `Summary: ${profile.summary.slice(0, 400)}`,
    profile.tone && `Tone: ${profile.tone}`,
  ].filter(Boolean).join("\n");

  const prompt = `Generate a personalized intelligence brief for ONE specific user. Today is ${today}.

USER IS:
${memoryText || profileText}

${newsContext}

OUTPUT FORMAT (follow exactly, preserving character dividers and icons):

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
YOUR SIGNAL · ${today}

🔥 TOP STORIES

① [Story headline or synthesized high-conviction trend]
[Synthesized Intelligence Paragraph: Strictly 2 sentences maximum. Sentence 1 must state what happened, sharp and specific. Sentence 2 must state what changes next, who benefits, or what opportunity exists. Absolutely do not use labels like "WHAT:", "WHY YOU:", "ACTION:", "WHY IT MATTERS:", or "IMPLICATION:". Do not use generic filler or clinical phrases like "As a professional in...", "Consider exploring...", "Monitor the situation...", "may have implications", "could impact", "important to understand", "significant development", "it is critical to". Write like an elite strategic advisor.]
→ [source URL]

② [Next Story headline]
[Synthesized Intelligence Paragraph: Exactly 2 sentences maximum. Sentence 1: what happened. Sentence 2: what changes next/opportunity. No labels or procedural tags.]
→ [source URL]

③ [Story headline — only if strongly relevant]
[Synthesized Intelligence Paragraph: Exactly 2 sentences maximum. Sentence 1: what happened. Sentence 2: what changes next/opportunity. No labels or procedural tags.]
→ [source URL]
${user.plan === "pro" ? `
📺 VIDEO WORTH YOUR TIME
[Synthesized relevance & target takeaway — exactly 2 sentences, no headers or labels.]
→ [URL]
` : ""}
💡 ONE THING TO DO TODAY
[Actionable intelligence — what move should the user execute today based on these signals? Not generic advice.]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STRICT WRITING DIRECTIVES:
- NO LABELS: Never write "WHAT:", "WHY YOU:", "ACTION:", "WHY IT MATTERS:", or "IMPLICATION:". Deliver pure synthesized intelligence.
- NO CLINICAL AI HYPNOTICS: Never use phrases like "may have implications", "could impact", "important to understand", "as a professional in...", "Consider exploring...", "Monitor the situation...", "significant development", "it is critical to".
- EACH STORY MUST BE MAXIMUM 2 SENTENCES: Sentence 1 must state what happened (sharp and specific). Sentence 2 must state what changes next, who benefits, or what opportunity exists.
- INSIGHT FIRST: Do not write "AI is transforming industries." Instead write: "Small agencies are starting to substitute whole creative departments with local open-source pipelines."
- BE PRECISE AND DIRECT: Provide concrete figures, realistic scenarios, or sharp opportunism. Sound like a smart, elite colleague. Connect dots between stories where possible.`;

  // Use Gemini if available
  if (apiGeminiKey) {
    const { GoogleGenAI } = require("@google/genai");
    const ai = new GoogleGenAI({
      apiKey: apiGeminiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        }
      }
    });

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        systemInstruction: "You are Signal — a personal intelligence system. Filter noise into insights for one person. Never hallucinate. Explain WHY. Give actionable implications.",
        temperature: 0.3,
      }
    });
    return response.text || "";
  } else {
    // Fallback to Groq
    const res = await withTimeout(
      fetch(GROK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiGrokKey}`,
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1400,
          messages: [
            { role: "system", content: "You are Signal — a personal intelligence system. Filter noise into insights for one person. Never hallucinate. Explain WHY. Give actionable implications." },
            { role: "user", content: prompt },
          ],
        }),
      }),
      TIMEOUT_MS
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || "Groq API error");
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  }
}

// ── SEND EMAIL ─────────────────────────────────────────────────────────────────
async function sendDigestEmail(user, digestContent) {
  const apiKey    = (process.env.RESEND_API_KEY || "").trim();
  const fromEmail = (process.env.FROM_EMAIL || "Signal <onboarding@resend.dev>").trim();
  if (!apiKey) throw new Error("RESEND_API_KEY not set");

  let firstName = (user.name || "").split(" ")[0] || "there";
  if (firstName.toLowerCase() === "sh" || firstName.toLowerCase() === "sh.") {
    firstName = "there";
  }
  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
  });

  // Convert plain text digest to HTML
  const bodyHtml = digestContent
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/━+/g, '<hr style="border:none;border-top:1px solid #E8E6E0;margin:18px 0;"/>')
    .replace(/^(🔥|💡|📊|📺|💬)[^\n]+$/gm, m =>
      `<p style="font-size:12px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#16A34A;margin:20px 0 8px;">${m}</p>`)
    .replace(/^(①|②|③|④|⑤)/gm, m =>
      `<span style="color:#1B4FD8;font-weight:700;">${m}</span>`)
    .replace(/^→ .+$/gm, m =>
      `<span style="font-size:12px;color:#1B4FD8;">${m}</span>`)
    .replace(/^• .+$/gm, m =>
      `<div style="display:flex;gap:8px;margin-bottom:6px;"><span style="color:#16A34A;">•</span><span>${m.slice(2)}</span></div>`)
    .replace(/\n/g, "<br/>");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Your digest — ${date}</title>
</head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#1A1A18;">
<div style="padding:24px 16px;">
  <div style="max-width:580px;margin:0 auto;background:#fff;border:1px solid #E8E6E0;border-radius:12px;overflow:hidden;">
    <div style="background:#1A1A18;padding:18px 28px;display:flex;justify-content:space-between;align-items:center;">
      <div style="font-size:18px;font-weight:700;color:#fff;letter-spacing:-0.02em;">Signal.</div>
      <div style="font-size:12px;color:rgba(255,255,255,0.5);">${date}</div>
    </div>
    <div style="padding:28px 32px;font-size:14px;line-height:1.8;color:#1A1A18;">
      <div style="font-size:18px;font-weight:700;margin-bottom:18px;">Good morning, ${firstName}.</div>
      ${bodyHtml}
    </div>
    <div style="padding:18px 28px;text-align:center;font-size:12px;color:#9E9E96;border-top:1px solid #E8E6E0;">
      <p>You're receiving this because you subscribed to Sharflow. To unsubscribe visit sharflow.com/unsubscribe</p>
      <p style="margin-top:6px;"><a href="https://sharflow.com/unsubscribe" style="color:#9E9E96;text-decoration:none;">Unsubscribe</a> · <a href="#" style="color:#9E9E96;text-decoration:none;">Update preferences</a></p>
    </div>
  </div>
</div>
</body>
</html>`;

  const res = await withTimeout(
    fetch(RESEND_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [user.email],
        subject: `Your digest — ${date}`,
        html,
        headers: {
          "List-Unsubscribe": "<https://sharflow.com/unsubscribe>"
        }
      }),
    }),
    TIMEOUT_MS
  );

  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || "Resend error");
  return data.id;
}

// ── SAVE DIGEST TO MONGODB ─────────────────────────────────────────────────────
async function saveDigest(db, userId, email, content, localDateStr) {
  try {
    await db.collection("digests").insertOne({
      userId,
      email,
      content,
      sentAt: new Date(),
      date: localDateStr || new Date().toISOString().split("T")[0],
    });
  } catch (e) {
    console.warn("Digest save failed:", e.message);
  }
}

// ── RECORD DELIVERY ATTEMPT LOG ──────────────────────────────────────────────────
async function logDelivery(db, user, status, error = null, userLocalDateStr = "", userTimeStr = "") {
  try {
    await db.collection("delivery_logs").insertOne({
      userId: user._id,
      email: user.email,
      status, // 'success', 'failed', 'skipped'
      error,
      attemptedAt: new Date(),
      userLocalTime: userTimeStr,
      userLocalDate: userLocalDateStr,
      timezone: user.profile?.timezone || "UTC",
      digestTime: user.profile?.digestTime || "08:00"
    });
  } catch (e) {
    console.warn("Delivery log insert failed:", e.message);
  }
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
async function handler(req, res) {
  // Vercel cron sends Authorization: Bearer <CRON_SECRET>
  const cronSecret = (process.env.CRON_SECRET || "").trim();
  if (cronSecret) {
    const authHeader = req.headers?.authorization || "";
    if (authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startTime = Date.now();
  const results = { sent: 0, failed: 0, skipped: 0, errors: [] };
  const now = new Date();

  try {
    const db    = await getDb();
    const users = await db.collection("users").find({
      email:   { $exists: true, $ne: "" },
      profile: { $exists: true, $ne: null },
    }).toArray();

    console.log(`[CRON] Starting hourly timezone matching run for ${users.length} registered users`);

    for (const user of users) {
      let userTimeStr = "";
      let userLocalDateStr = "";
      let userHour = 8;
      let userTz = user.profile?.timezone || "UTC";

      try {
        if (!user.email || !user.profile?.summary) {
          console.log(`[${new Date().toISOString()}] [CRON] Skipping user ${user.email || "unknown"} — email or starting profile summary is missing.`);
          results.skipped++;
          continue;
        }

        const profile = user.profile;
        const digestTimePreference = profile.digestTime || "08:00"; 

        try {
          userTimeStr = now.toLocaleTimeString("en-US", {
            timeZone: userTz,
            hour12: false,
            hour: "2-digit",
            minute: "2-digit",
          });
          userLocalDateStr = now.toLocaleDateString("en-US", {
            timeZone: userTz,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          });
          const localHourStr = now.toLocaleTimeString("en-US", {
            timeZone: userTz,
            hour12: false,
            hour: "2-digit",
          });
          userHour = parseInt(localHourStr, 10);
        } catch (tzErr) {
          console.warn(`[${new Date().toISOString()}] Invalid timezone [${userTz}] for user ${user.email}, falling back to UTC`, tzErr.message);
          userTz = "UTC";
          userTimeStr = now.toLocaleTimeString("en-US", {
            timeZone: "UTC",
            hour12: false,
            hour: "2-digit",
            minute: "2-digit",
          });
          userLocalDateStr = now.toLocaleDateString("en-US", {
            timeZone: "UTC",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          });
          userHour = now.getUTCHours();
        }

        const targetHour = parseInt(digestTimePreference.split(":")[0], 10);

        // 1. Check if the current user-local hour is the targeted delivery hour
        if (userHour !== targetHour) {
          console.log(`[${new Date().toISOString()}] [CRON] Skipping ${user.email} — current local hour ${userHour} does not match target hour ${targetHour}.`);
          results.skipped++;
          continue;
        }

        // 2. Prevent duplicate sends within the same user-local day
        if (user.lastDigestSentDate === userLocalDateStr) {
          console.log(`[${new Date().toISOString()}] [CRON] Skipping ${user.email} — already received their digest for ${userLocalDateStr} today.`);
          results.skipped++;
          continue;
        }

        // 3. Double check the digests collection to ensure no race conditions
        const existingDigest = await db.collection("digests").findOne({
          email: user.email,
          date: userLocalDateStr
        });
        if (existingDigest) {
          console.log(`[${new Date().toISOString()}] [CRON] Skipping ${user.email} — duplicate check matched in db digests collection for ${userLocalDateStr}.`);
          await db.collection("users").updateOne(
            { _id: user._id },
            { $set: { lastDigestSentDate: userLocalDateStr } }
          );
          results.skipped++;
          continue;
        }

        // 4. Matches scheduled parameters - proceed with fetch and dispatch
        const topics  = profile.topics     || "technology, AI";
        const prof    = profile.profession || "";
        const avoid   = profile.avoid      || "";

        // Fetch news matching preferences
        const news = await fetchNews(topics, prof, avoid);
        console.log(`[${new Date().toISOString()}] [CRON] ${user.email} — fetched ${news.articles.length} news articles`);

        // Generate personalized digest via AI
        const digestContent = await generateDigest(user, news);
        if (!digestContent) { 
          console.log(`[${new Date().toISOString()}] [CRON] Skipping ${user.email} — generated digest content is empty.`);
          results.skipped++; 
          await logDelivery(db, user, "skipped", "Empty digest content generated", userLocalDateStr, userTimeStr);
          continue; 
        }

        // Send beautiful HTML email via Resend
        const emailId = await sendDigestEmail(user, digestContent);
        console.log(`[${new Date().toISOString()}] [CRON] ${user.email} — email sent successfully: ${emailId}`);

        // Save complete historical record inside the digests collection
        await saveDigest(db, user._id, user.email, digestContent, userLocalDateStr);

        // Stamp send state directly to the user record
        await db.collection("users").updateOne(
          { _id: user._id },
          { $set: { lastDigestSentDate: userLocalDateStr, lastDigestSentAt: new Date() } }
        );

        // Log successful delivery attempt
        await logDelivery(db, user, "success", null, userLocalDateStr, userTimeStr);

        results.sent++;

        // Rate limit padding between active dispatches
        await sleep(500);

      } catch (userErr) {
        console.error(`[${new Date().toISOString()}] [CRON] Failed for ${user.email}:`, userErr.message);
        results.failed++;
        results.errors.push({ email: user.email, error: userErr.message });
        try {
          await logDelivery(db, user, "failed", userErr.message, userLocalDateStr, userTimeStr);
        } catch (logErr) {
          console.error(`[${new Date().toISOString()}] Status log write failed for ${user.email}:`, logErr.message);
        }
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[CRON] Done in ${duration}s —`, results);

    return res.status(200).json({
      ok: true,
      duration: `${duration}s`,
      users: users.length,
      ...results,
    });

  } catch (err) {
    console.error("[CRON] Fatal error:", err.message);
    return res.status(500).json({ error: err.message || "Cron failed" });
  }
}

module.exports = handler;
