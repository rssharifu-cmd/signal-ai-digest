/**
 * Vercel Node.js Serverless — GET /api/cron
 *
 * Triggered daily at 1:00 PM UTC by Vercel Cron.
 * Orchestrates the full digest pipeline for every active user.
 *
 * Required env vars:
 *   MONGODB_URI, GROK_API_KEY, RESEND_API_KEY,
 *   FROM_EMAIL, TAVILY_API_KEY, YOUTUBE_API_KEY
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

function getUTCHourForLocalTime(digestTime, timezone) {
  let [localHourStr] = (digestTime || "08:00").split(":");
  let targetHour = parseInt(localHourStr, 10);
  if (isNaN(targetHour)) targetHour = 8;

  const now = new Date();
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || "UTC",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    });
    const formatterUTC = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    });

    const parts = formatter.formatToParts(now);
    const utcParts = formatterUTC.formatToParts(now);
    const getVal = (pList, type) => parseInt(pList.find(p => p.type === type).value, 10);

    const localDate = Date.UTC(
      getVal(parts, "year"), getVal(parts, "month") - 1, getVal(parts, "day"),
      getVal(parts, "hour"), getVal(parts, "minute"), getVal(parts, "second")
    );
    const utcDate = Date.UTC(
      getVal(utcParts, "year"), getVal(utcParts, "month") - 1, getVal(utcParts, "day"),
      getVal(utcParts, "hour"), getVal(utcParts, "minute"), getVal(utcParts, "second")
    );

    const diffMs = localDate - utcDate;
    const diffHours = Math.round(diffMs / (1000 * 60 * 60));
    return (targetHour - diffHours + 24) % 24;
  } catch (err) {
    console.error("Error converting local time to UTC hour: ", err.message);
    return targetHour;
  }
}

// ── FETCH NEWS ────────────────────────────────────────────────────────────────
async function fetchNews(topics, profession, avoid, lastDigest = null) {
  const tavilyKey  = (process.env.TAVILY_API_KEY  || "").trim();
  const youtubeKey = (process.env.YOUTUBE_API_KEY || "").trim();

  // Smarter time window: use last digest sentAt, fallback 48h
  let startTimeWindow;
  if (lastDigest && lastDigest.sentAt) {
    startTimeWindow = new Date(lastDigest.sentAt);
  } else {
    startTimeWindow = new Date(Date.now() - 48 * 60 * 60 * 1000);
  }
  const publishedAfterStr = startTimeWindow.toISOString();

  // Extract already-sent URLs from last digest content
  const sentUrls = new Set();
  if (lastDigest && lastDigest.content) {
    const urlRegex = /https?:\/\/[^\s>")\*,;]+/g;
    let m;
    while ((m = urlRegex.exec(lastDigest.content)) !== null) {
      sentUrls.add(m[0].trim().replace(/[\.,\);]+$/, "").toLowerCase());
    }
  }

  // --- Tavily ---
  async function tavily() {
    const queryStr = `Latest news: ${topics || "technology AI business"}`;
    if (!tavilyKey) return [];
    try {
      const res = await withTimeout(fetch(TAVILY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: tavilyKey,
          query: queryStr,
          search_depth: "advanced",
          include_answer: false,
          include_raw_content: false,
          max_results: 10,
          exclude_domains: avoid ? avoid.split(",").map(s => s.trim()).filter(Boolean) : [],
          publishedAfter: publishedAfterStr,
        }),
      }), TIMEOUT_MS);
      if (!res.ok) { console.log(`[CRON] Tavily bad response: ${res.status}`); return []; }
      const data = await res.json();
      console.log(`[CRON] Tavily returned ${data.results?.length || 0} results`);
      return (data.results || []).map(r => ({
        source: "tavily",
        title: r.title || "",
        url: r.url || "",
        snippet: (r.content || r.snippet || "").slice(0, 400),
      }));
    } catch (err) {
      console.log(`[CRON] Tavily failed:`, err.message);
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
        fetch(`https://www.reddit.com/r/${subreddit}/hot.json?limit=10`, {
          headers: { "User-Agent": "Signal-NewsDigest/1.0" },
        }), TIMEOUT_MS
      );
      if (!res.ok) return [];
      const data = await res.json();
      return (data?.data?.children || [])
        .filter(p => !p.data?.stickied && !p.data?.over_18)
        .slice(0, 5)
        .map(p => ({
          source: "reddit",
          title: p.data?.title || "",
          url: `https://reddit.com${p.data?.permalink || ""}`,
          snippet: `${p.data?.ups || 0} upvotes · r/${p.data?.subreddit} · ${p.data?.selftext || ""}`,
        }));
    } catch (err) {
      console.log(`[CRON] Reddit failed:`, err.message);
      return [];
    }
  }

  // --- RSS ---
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
        fetch(feedUrl, { headers: { "User-Agent": "Signal-NewsDigest/1.0" } }), TIMEOUT_MS
      );
      if (!res.ok) return [];
      const xml = await res.text();
      const items = [];
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;
      while ((match = itemRegex.exec(xml)) !== null && items.length < 8) {
        const block = match[1];
        const title = (/<title><!\[CDATA\[(.*?)\]\]><\/title>/.exec(block) || /<title>(.*?)<\/title>/.exec(block) || [])[1] || "";
        const link  = (/<link>(.*?)<\/link>/.exec(block) || [])[1] || "";
        const desc  = (/<description><!\[CDATA\[(.*?)\]\]><\/description>/.exec(block) || /<description>(.*?)<\/description>/.exec(block) || [])[1] || "";
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
      console.log(`[CRON] RSS failed:`, err.message);
      return [];
    }
  }

  // --- YouTube ---
  async function youtube() {
    if (!youtubeKey) return [];
    const primaryTopic = (topics || "technology").split(",")[0].trim();
    const query = `${primaryTopic} ${profession ? profession.split(" ")[0] : ""} 2025`.trim();
    try {
      const params = new URLSearchParams({
        part: "snippet", q: query, type: "video",
        order: "relevance", maxResults: "5",
        videoDuration: "medium", relevanceLanguage: "en",
        publishedAfter: publishedAfterStr,
        key: youtubeKey,
      });
      const res = await withTimeout(fetch(`${YOUTUBE_URL}?${params}`), TIMEOUT_MS);
      if (!res.ok) return [];
      const data = await res.json();
      return (data.items || [])
        .filter(i => i.snippet?.title?.length > 10)
        .map(item => ({
          source: "youtube",
          title: item.snippet.title,
          url: `https://youtube.com/watch?v=${item.id.videoId}`,
          snippet: `Video on YouTube: ${item.snippet.channelTitle} · ${item.snippet.description || ""}`,
        }));
    } catch (err) {
      console.log(`[CRON] YouTube failed:`, err.message);
      return [];
    }
  }

  const [tavilyArticles, rssItems, redditPosts, youtubeVideos] = await Promise.all([
    tavily(), rss(), reddit(), youtube(),
  ]);

  // Combine into one pool
  let candidatePool = [
    ...(tavilyArticles || []),
    ...(rssItems || []),
    ...(redditPosts || []),
    ...(youtubeVideos || []),
  ];

  console.log(`[CRON] Candidate pool before dedup: ${candidatePool.length}`);

  // Filter out already-sent URLs
  candidatePool = candidatePool.filter(art => {
    if (!art.url) return true;
    const urlLower = art.url.trim().toLowerCase();
    for (const sentUrl of sentUrls) {
      if (urlLower.includes(sentUrl) || sentUrl.includes(urlLower)) {
        console.log(`[CRON] Filtered duplicate: ${art.url}`);
        return false;
      }
    }
    return true;
  });

  console.log(`[CRON] Candidate pool after dedup: ${candidatePool.length}`);

  // Rank by relevance to topics and profession
  const topicKeywords = (topics || "").toLowerCase().split(/[\s,]+/).map(k => k.trim()).filter(k => k.length > 2);
  const profKeywords  = (profession || "").toLowerCase().split(/[\s,]+/).map(k => k.trim()).filter(k => k.length > 2);

  const rankedCandidates = candidatePool.map(art => {
    let score = 0;
    const titleLower   = (art.title || "").toLowerCase();
    const snippetLower = (art.snippet || "").toLowerCase();
    topicKeywords.forEach(kw => {
      if (titleLower.includes(kw))   score += 15;
      if (snippetLower.includes(kw)) score += 5;
    });
    profKeywords.forEach(kw => {
      if (titleLower.includes(kw))   score += 10;
      if (snippetLower.includes(kw)) score += 3;
    });
    if (art.source === "tavily")  score += 2;
    if (art.source === "youtube") score += 1;
    return { ...art, score };
  });

  rankedCandidates.sort((a, b) => b.score - a.score);
  const finalArticles = rankedCandidates.slice(0, 6);

  console.log(`[CRON] Top articles selected:`, finalArticles.map(a => `[${a.score}|${a.source}] ${a.title}`));

  return { articles: finalArticles, reddit: [], video: null };
}

// ── DIGEST GENERATION ─────────────────────────────────────────────────────────
async function generateDigest(user, news) {
  const apiGrokKey   = (process.env.GROK_API_KEY   || "").trim();
  const apiGeminiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!apiGrokKey && !apiGeminiKey) throw new Error("Neither GEMINI_API_KEY nor GROK_API_KEY is configured.");

  const profile = user.profile || {};
  const memory  = ensureMemory(user, profile);
  const today   = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });

  const articleText = news.articles.length
    ? news.articles.map((a, i) =>
        `[${i + 1}] ${a.title}\nSource: ${a.source} | ${a.url}\n${a.snippet}`
      ).join("\n\n")
    : "No articles available.";

  const newsContext = ["ARTICLES:", articleText].join("\n");

  const memoryText  = formatMemoryForPrompt(memory);
  const profileText = [
    user.name       && `Name: ${user.name}`,
    profile.profession && `Role: ${profile.profession}`,
    profile.goals   && `Goals: ${profile.goals}`,
    profile.topics  && `Topics: ${profile.topics}`,
    profile.avoid   && `Avoid: ${profile.avoid}`,
    profile.summary && `Summary: ${profile.summary.slice(0, 400)}`,
    profile.tone    && `Tone: ${profile.tone}`,
  ].filter(Boolean).join("\n");

  // FIX: system instruction enforces 2-sentence rule hard
  const systemInstruction = `You are Signal — a ruthlessly precise personal intelligence system.

MANDATORY RULES — violating any of these is a critical failure:
1. EXACTLY 2 sentences per story. Not 1. Not 3. Count them. Stop at 2.
2. Sentence 1: what happened — sharp, specific, no fluff.
3. Sentence 2: what changes next, who wins, or what opportunity opens.
4. NEVER use: "WHAT:", "WHY YOU:", "ACTION:", "WHY IT MATTERS:", "IMPLICATION:"
5. NEVER use: "may have implications", "could impact", "important to understand", "as a professional in", "consider exploring", "monitor the situation", "significant development", "it is critical to"
6. 📊 THIS WEEK = pure trend observations only. No advice. No actions. No recommendations.
7. Never personalize with "as a YouTuber" or "as a [profession]" — just deliver the insight.
8. Write like a sharp analyst, not a corporate AI.`;

  const prompt = `Generate a personalized intelligence brief for this user. Today is ${today}.

USER PROFILE:
${memoryText || profileText}

${newsContext}

OUTPUT FORMAT — follow exactly:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
YOUR SIGNAL · ${today}

🔥 TOP STORIES

① [Headline or synthesized trend title]
[EXACTLY 2 sentences. S1: what happened. S2: what changes next or who benefits.]
→ [URL]

② [Headline]
[EXACTLY 2 sentences. S1: what happened. S2: what changes next or who benefits.]
→ [URL]

③ [Headline]
[EXACTLY 2 sentences. S1: what happened. S2: what changes next or who benefits.]
→ [URL]

④ [Headline]
[EXACTLY 2 sentences. S1: what happened. S2: what changes next or who benefits.]
→ [URL]

⑤ [Headline]
[EXACTLY 2 sentences. S1: what happened. S2: what changes next or who benefits.]
→ [URL]

📊 THIS WEEK
• [Sharp trend observation. 1-2 sentences. No advice. No actions.]
• [Sharp trend observation. 1-2 sentences. No advice. No actions.]
• [Sharp trend observation. 1-2 sentences. No advice. No actions.]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━

REMINDERS:
- Each story body = EXACTLY 2 sentences, no more, no less.
- No labels. No generic filler. No advice in THIS WEEK.
- Write like an elite analyst who respects the reader's time.`;

  // Use Gemini if available — FIX: pass systemInstruction correctly
  if (apiGeminiKey) {
    const { GoogleGenAI } = require("@google/genai");
    const ai = new GoogleGenAI({ apiKey: apiGeminiKey });

    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        systemInstruction: systemInstruction,
        temperature: 0.25,
      },
    });
    return response.text || "";

  } else {
    // Fallback: Groq
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
            { role: "system", content: systemInstruction },
            { role: "user",   content: prompt },
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

  // FIX: use real first name from profile, fallback to "there"
  const profile = user.profile || {};
  let firstName = profile.firstName || profile.name || (user.name || "").split(" ")[0] || "there";
  if (!firstName || firstName.length < 2 || firstName.toLowerCase() === "undefined") {
    firstName = "there";
  }

  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
  });

  // Convert plain text digest to HTML
  const bodyHtml = digestContent
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/━+/g, '<hr style="border:none;border-top:1px solid #E8E6E0;margin:18px 0;"/>')
    .replace(/^(🔥|📊|📺|💬)[^\n]+$/gm, m =>
      `<p style="font-size:12px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#16A34A;margin:20px 0 8px;">${m}</p>`)
    .replace(/^(①|②|③|④|⑤|⑥)/gm, m =>
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
      <p>You're receiving this because you subscribed to Sharflow.</p>
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
        subject: `Your Signal — ${date}`,
        html,
        headers: { "List-Unsubscribe": "<https://sharflow.com/unsubscribe>" },
      }),
    }),
    TIMEOUT_MS
  );

  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || "Resend error");
  return data.id;
}

// ── SAVE DIGEST ───────────────────────────────────────────────────────────────
async function saveDigest(db, userId, email, content, localDateStr) {
  try {
    await db.collection("digests").insertOne({
      userId, email, content,
      sentAt: new Date(),
      date: localDateStr || new Date().toISOString().split("T")[0],
    });
  } catch (e) {
    console.warn("Digest save failed:", e.message);
  }
}

// ── LOG DELIVERY ──────────────────────────────────────────────────────────────
async function logDelivery(db, user, status, error = null, userLocalDateStr = "", userTimeStr = "") {
  try {
    await db.collection("delivery_logs").insertOne({
      userId: user._id,
      email: user.email,
      status,
      error,
      attemptedAt: new Date(),
      userLocalTime: userTimeStr,
      userLocalDate: userLocalDateStr,
      timezone: user.profile?.timezone || "UTC",
      digestTime: user.profile?.digestTime || "08:00",
    });
  } catch (e) {
    console.warn("Delivery log insert failed:", e.message);
  }
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
async function handler(req, res) {
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
  const results   = { sent: 0, failed: 0, skipped: 0, errors: [] };
  const now       = new Date();

  try {
    const db    = await getDb();
    const users = await db.collection("users").find({
      email:   { $exists: true, $ne: "" },
      profile: { $exists: true, $ne: null },
    }).toArray();

    console.log(`[CRON] Starting run for ${users.length} users`);

    for (const user of users) {
      let userTimeStr = "";
      let userLocalDateStr = "";
      let userHour = 8;
      let userTz   = user.profile?.timezone || "UTC";

      try {
        if (!user.email || !user.profile?.summary) {
          console.log(`[CRON] Skipping ${user.email || "unknown"} — missing email or profile summary`);
          results.skipped++;
          continue;
        }

        const profile              = user.profile;
        const digestTimePreference = profile.digestTime || "08:00";

        try {
          userTimeStr = now.toLocaleTimeString("en-US", {
            timeZone: userTz, hour12: false, hour: "2-digit", minute: "2-digit",
          });
          userLocalDateStr = now.toLocaleDateString("en-US", {
            timeZone: userTz, year: "numeric", month: "2-digit", day: "2-digit",
          });
          const localHourStr = now.toLocaleTimeString("en-US", {
            timeZone: userTz, hour12: false, hour: "2-digit",
          });
          userHour = parseInt(localHourStr, 10);
        } catch (tzErr) {
          console.warn(`Invalid timezone [${userTz}] for ${user.email}, falling back to UTC`);
          userTz           = "UTC";
          userTimeStr      = now.toLocaleTimeString("en-US", { timeZone: "UTC", hour12: false, hour: "2-digit", minute: "2-digit" });
          userLocalDateStr = now.toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
          userHour         = now.getUTCHours();
        }

        // Check UTC hour match
        const targetUTCHour  = getUTCHourForLocalTime(digestTimePreference, userTz);
        const currentUTCHour = now.getUTCHours();
        if (currentUTCHour !== targetUTCHour) {
          console.log(`[CRON] Skipping ${user.email} — UTC hour ${currentUTCHour} ≠ target ${targetUTCHour}`);
          results.skipped++;
          continue;
        }

        // FIX: Atomic duplicate prevention — upsert with $setOnInsert only
        // If a digest record already exists for this user+date, skip.
        // We insert a "lock" record first before sending to prevent race conditions.
        const lockResult = await db.collection("digests").updateOne(
          { email: user.email, date: userLocalDateStr },
          { $setOnInsert: { email: user.email, date: userLocalDateStr, locked: true, lockedAt: new Date() } },
          { upsert: true }
        );

        // If upsertedCount is 0, record already existed — skip
        if (lockResult.upsertedCount === 0) {
          console.log(`[CRON] Skipping ${user.email} — digest lock already exists for ${userLocalDateStr}`);
          await db.collection("users").updateOne(
            { _id: user._id },
            { $set: { lastDigestSentDate: userLocalDateStr } }
          );
          results.skipped++;
          continue;
        }

        console.log(`[CRON] Lock acquired for ${user.email} on ${userLocalDateStr} — proceeding`);

        // Fetch last sent digest for dedup + time window
        const lastDigest = await db.collection("digests").findOne(
          { email: user.email, locked: { $ne: true } },
          { sort: { sentAt: -1 } }
        );

        const topics = profile.topics     || "technology, AI";
        const prof   = profile.profession || "";
        const avoid  = profile.avoid      || "";

        const news = await fetchNews(topics, prof, avoid, lastDigest);
        console.log(`[CRON] ${user.email} — fetched ${news.articles.length} articles`);

        const digestContent = await generateDigest(user, news);
        if (!digestContent) {
          console.log(`[CRON] ${user.email} — empty digest, skipping`);
          // Remove the lock so it can retry
          await db.collection("digests").deleteOne({ email: user.email, date: userLocalDateStr, locked: true });
          results.skipped++;
          await logDelivery(db, user, "skipped", "Empty digest content", userLocalDateStr, userTimeStr);
          continue;
        }

        const emailId = await sendDigestEmail(user, digestContent);
        console.log(`[CRON] ${user.email} — sent: ${emailId}`);

        // Update the lock record with full content
        await db.collection("digests").updateOne(
          { email: user.email, date: userLocalDateStr },
          { $set: { userId: user._id, content: digestContent, sentAt: new Date(), locked: false } }
        );

        await db.collection("users").updateOne(
          { _id: user._id },
          { $set: { lastDigestSentDate: userLocalDateStr, lastDigestSentAt: new Date() } }
        );

        await logDelivery(db, user, "success", null, userLocalDateStr, userTimeStr);
        results.sent++;
        await sleep(500);

      } catch (userErr) {
        console.error(`[CRON] Failed for ${user.email}:`, userErr.message);
        // Remove lock on failure so it can retry
        try {
          await db.collection("digests").deleteOne({ email: user.email, date: userLocalDateStr, locked: true });
        } catch (_) {}
        results.failed++;
        results.errors.push({ email: user.email, error: userErr.message });
        try {
          await logDelivery(db, user, "failed", userErr.message, userLocalDateStr, userTimeStr);
        } catch (logErr) {
          console.error(`Status log write failed for ${user.email}:`, logErr.message);
        }
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[CRON] Done in ${duration}s —`, results);

    return res.status(200).json({
      ok: true, duration: `${duration}s`, users: users.length, ...results,
    });

  } catch (err) {
    console.error("[CRON] Fatal error:", err.message);
    return res.status(500).json({ error: err.message || "Cron failed" });
  }
}

module.exports = handler;
