/**
 * Vercel Node.js Serverless — GET /api/cron-research
 *
 * Runs at 12:30 PM UTC (30 min before digest send).
 * Deep research pipeline: fetches all sources for every user,
 * saves lean cache to MongoDB "research_cache" collection.
 * TTL index auto-deletes records after 24 hours.
 */

const { getDb } = require("./db");

const TAVILY_URL  = "https://api.tavily.com/search";
const YOUTUBE_URL = "https://www.googleapis.com/youtube/v3/search";
const TIMEOUT_MS  = 25000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), ms)),
  ]);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── DEEP RESEARCH FOR ONE USER ────────────────────────────────────────────────
async function researchForUser(user, lastDigest) {
  const profile    = user.profile || {};
  const topics     = profile.topics     || "technology, AI";
  const profession = profile.profession || "";
  const avoid      = profile.avoid      || "";

  const tavilyKey  = (process.env.TAVILY_API_KEY  || "").trim();
  const youtubeKey = (process.env.YOUTUBE_API_KEY || "").trim();

  // Smart time window: from last digest sentAt, fallback 48h
  let startTime;
  if (lastDigest && lastDigest.sentAt) {
    startTime = new Date(lastDigest.sentAt);
  } else {
    startTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
  }
  const publishedAfterStr = startTime.toISOString();

  // Extract already-sent URLs
  const sentUrls = new Set();
  if (lastDigest && lastDigest.content) {
    const urlRegex = /https?:\/\/[^\s>")\*,;]+/g;
    let m;
    while ((m = urlRegex.exec(lastDigest.content)) !== null) {
      sentUrls.add(m[0].trim().replace(/[\.,\);]+$/, "").toLowerCase());
    }
  }

  // ── TAVILY (deep search) ──────────────────────────────────────────────────
  async function tavily() {
    if (!tavilyKey) return [];
    // Run 2 queries: topics + profession for richer coverage
    const queries = [
      `Latest news: ${topics}`,
      profession ? `${profession} trends opportunities ${new Date().getFullYear()}` : null,
    ].filter(Boolean);

    const results = [];
    for (const q of queries) {
      try {
        const res = await withTimeout(fetch(TAVILY_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: tavilyKey,
            query: q,
            search_depth: "advanced",
            include_answer: false,
            include_raw_content: false,
            max_results: 8,
            exclude_domains: avoid ? avoid.split(",").map(s => s.trim()).filter(Boolean) : [],
            publishedAfter: publishedAfterStr,
          }),
        }), TIMEOUT_MS);
        if (!res.ok) continue;
        const data = await res.json();
        (data.results || []).forEach(r => {
          results.push({
            source: "tavily",
            title: (r.title || "").slice(0, 120),
            url: r.url || "",
            snippet: (r.content || r.snippet || "").slice(0, 200),
          });
        });
        await sleep(300); // avoid rate limit between queries
      } catch (err) {
        console.log(`[RESEARCH] Tavily query failed: ${err.message}`);
      }
    }
    return results;
  }

  // ── REDDIT ────────────────────────────────────────────────────────────────
  async function reddit() {
    const subredditMap = {
      "money": "Entrepreneur", "online": "Entrepreneur", "youtube": "NewTubers",
      "ai": "artificial", "ml": "MachineLearning", "startup": "startups",
      "finance": "finance", "tech": "technology", "crypto": "CryptoCurrency",
      "marketing": "marketing", "business": "business", "ecommerce": "ecommerce",
    };
    const topicsLower = topics.toLowerCase();
    let subreddit = "Entrepreneur";
    for (const [key, sub] of Object.entries(subredditMap)) {
      if (topicsLower.includes(key)) { subreddit = sub; break; }
    }

    // Check multiple subreddits for richer signal
    const subreddits = [subreddit, "technology"].filter((v, i, a) => a.indexOf(v) === i);
    const results = [];

    for (const sub of subreddits) {
      try {
        const res = await withTimeout(
          fetch(`https://www.reddit.com/r/${sub}/hot.json?limit=15`, {
            headers: { "User-Agent": "Signal-Research/1.0" },
          }), TIMEOUT_MS
        );
        if (!res.ok) continue;
        const data = await res.json();
        (data?.data?.children || [])
          .filter(p => !p.data?.stickied && !p.data?.over_18)
          .slice(0, 6)
          .forEach(p => {
            results.push({
              source: "reddit",
              title: (p.data?.title || "").slice(0, 120),
              url: `https://reddit.com${p.data?.permalink || ""}`,
              snippet: `${p.data?.ups || 0} upvotes · r/${p.data?.subreddit}`,
            });
          });
      } catch (err) {
        console.log(`[RESEARCH] Reddit r/${sub} failed: ${err.message}`);
      }
    }
    return results;
  }

  // ── RSS ───────────────────────────────────────────────────────────────────
  async function rss() {
    const topicsLower = topics.toLowerCase();
    const feedMap = [
      { keys: ["money", "online", "business", "entrepreneur"], url: "https://feeds.feedburner.com/entrepreneur/latest" },
      { keys: ["youtube", "creator", "content"], url: "https://techcrunch.com/feed/" },
      { keys: ["ai", "ml", "machine learning"], url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
      { keys: ["startup"], url: "https://techcrunch.com/category/startups/feed/" },
      { keys: ["finance", "market", "economy"], url: "https://feeds.bbci.co.uk/news/business/rss.xml" },
      { keys: ["crypto"], url: "https://cointelegraph.com/rss" },
      { keys: ["marketing"], url: "https://feeds.feedburner.com/marketingland" },
      { keys: ["tech", "engineering", "software"], url: "https://feeds.feedburner.com/TechCrunch" },
    ];

    let feedUrl = "https://techcrunch.com/feed/";
    for (const { keys, url } of feedMap) {
      if (keys.some(k => topicsLower.includes(k))) { feedUrl = url; break; }
    }

    try {
      const res = await withTimeout(
        fetch(feedUrl, { headers: { "User-Agent": "Signal-Research/1.0" } }), TIMEOUT_MS
      );
      if (!res.ok) return [];
      const xml  = await res.text();
      const items = [];
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;
      while ((match = itemRegex.exec(xml)) !== null && items.length < 10) {
        const block = match[1];
        const title = (/<title><!\[CDATA\[(.*?)\]\]><\/title>/.exec(block) || /<title>(.*?)<\/title>/.exec(block) || [])[1] || "";
        const link  = (/<link>(.*?)<\/link>/.exec(block) || [])[1] || "";
        const desc  = (/<description><!\[CDATA\[(.*?)\]\]><\/description>/.exec(block) || /<description>(.*?)<\/description>/.exec(block) || [])[1] || "";
        if (title && link) {
          items.push({
            source: "rss",
            title: title.replace(/&amp;/g, "&").trim().slice(0, 120),
            url: link.trim(),
            snippet: desc.replace(/<[^>]+>/g, "").slice(0, 200).trim(),
          });
        }
      }
      return items;
    } catch (err) {
      console.log(`[RESEARCH] RSS failed: ${err.message}`);
      return [];
    }
  }

  // ── YOUTUBE ───────────────────────────────────────────────────────────────
  async function youtube() {
    if (!youtubeKey) return [];
    const primaryTopic = topics.split(",")[0].trim();
    const query = `${primaryTopic} ${profession ? profession.split(" ")[0] : ""} ${new Date().getFullYear()}`.trim();
    try {
      const params = new URLSearchParams({
        part: "snippet", q: query, type: "video",
        order: "relevance", maxResults: "8",
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
          title: (item.snippet.title || "").slice(0, 120),
          url: `https://youtube.com/watch?v=${item.id.videoId}`,
          snippet: `${item.snippet.channelTitle} · ${(item.snippet.description || "").slice(0, 150)}`,
        }));
    } catch (err) {
      console.log(`[RESEARCH] YouTube failed: ${err.message}`);
      return [];
    }
  }

  // ── GOOGLE TRENDS ─────────────────────────────────────────────────────────
  async function googleTrends() {
    try {
      const res = await withTimeout(
        fetch("https://trends.google.com/trends/api/dailytrends?hl=en-US&tz=-300&geo=US&ns=15", {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        }), TIMEOUT_MS
      );
      if (!res.ok) return [];
      const text = await res.text();
      const json = JSON.parse(text.slice(5));
      const trends = json?.default?.trendingSearchesDays?.[0]?.trendingSearches || [];
      const topicKeywordsLower = topics.toLowerCase().split(/[\s,]+/).filter(k => k.length > 2);
      const results = [];

      for (const trend of trends.slice(0, 25)) {
        const title = trend.title?.query || "";
        const titleLower = title.toLowerCase();
        const firstArticle = (trend.articles || [])[0];
        const isRelevant = topicKeywordsLower.some(kw => titleLower.includes(kw)) ||
          (firstArticle && topicKeywordsLower.some(kw =>
            (firstArticle.title || "").toLowerCase().includes(kw)
          ));
        if (isRelevant && firstArticle) {
          results.push({
            source: "google_trends",
            title: `Trending: ${title} — ${(firstArticle.title || "").slice(0, 80)}`,
            url: firstArticle.url || `https://trends.google.com/trends/explore?q=${encodeURIComponent(title)}&geo=US`,
            snippet: `Trending in US with ${trend.formattedTraffic || "high"} searches. ${(firstArticle.snippet || "").slice(0, 150)}`,
          });
        }
      }
      return results;
    } catch (err) {
      console.log(`[RESEARCH] Google Trends failed: ${err.message}`);
      return [];
    }
  }

  // ── COMBINE + RANK ────────────────────────────────────────────────────────
  const [tavilyResults, rssItems, redditPosts, youtubeVideos, trendingTopics] = await Promise.all([
    tavily(), rss(), reddit(), youtube(), googleTrends(),
  ]);

  let pool = [
    ...(tavilyResults  || []),
    ...(rssItems       || []),
    ...(redditPosts    || []),
    ...(youtubeVideos  || []),
    ...(trendingTopics || []),
  ];

  // Filter duplicates from last digest
  pool = pool.filter(art => {
    if (!art.url) return true;
    const urlLower = art.url.trim().toLowerCase();
    for (const sentUrl of sentUrls) {
      if (urlLower.includes(sentUrl) || sentUrl.includes(urlLower)) return false;
    }
    return true;
  });

  // Rank by relevance
  const topicKeywords = topics.toLowerCase().split(/[\s,]+/).map(k => k.trim()).filter(k => k.length > 2);
  const profKeywords  = profession.toLowerCase().split(/[\s,]+/).map(k => k.trim()).filter(k => k.length > 2);

  const ranked = pool.map(art => {
    let score = 0;
    const tl = (art.title   || "").toLowerCase();
    const sl = (art.snippet || "").toLowerCase();
    topicKeywords.forEach(kw => { if (tl.includes(kw)) score += 15; if (sl.includes(kw)) score += 5; });
    profKeywords.forEach(kw  => { if (tl.includes(kw)) score += 10; if (sl.includes(kw)) score += 3; });
    if (art.source === "google_trends") score += 4;
    if (art.source === "tavily")        score += 3;
    if (art.source === "youtube")       score += 2;
    if (art.source === "reddit")        score += 1;
    return { ...art, score };
  });

  ranked.sort((a, b) => b.score - a.score);

  // Return top 10 (digest will pick best 5-6)
  return ranked.slice(0, 10).map(a => ({
    source:  a.source,
    title:   a.title,
    url:     a.url,
    snippet: a.snippet,
    score:   a.score,
  }));
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
  const results = { researched: 0, skipped: 0, failed: 0 };

  try {
    const db    = await getDb();
    const users = await db.collection("users").find({
      email:   { $exists: true, $ne: "" },
      profile: { $exists: true, $ne: null },
    }).toArray();

    console.log(`[RESEARCH] Starting deep research for ${users.length} users`);

    // Ensure TTL index exists — auto-deletes after 24h
    try {
      await db.collection("research_cache").createIndex(
        { expiresAt: 1 },
        { expireAfterSeconds: 0, background: true }
      );
    } catch (_) {}

    for (const user of users) {
      try {
        if (!user.email || !user.profile?.summary) {
          results.skipped++;
          continue;
        }

        // Get last digest for time window + dedup
        const lastDigest = await db.collection("digests").findOne(
          { email: user.email, locked: { $ne: true } },
          { sort: { sentAt: -1 } }
        );

        const articles = await researchForUser(user, lastDigest);
        console.log(`[RESEARCH] ${user.email} — found ${articles.length} relevant articles`);

        // Save lean cache — upsert so re-runs don't duplicate
        const today = new Date().toISOString().split("T")[0];
        await db.collection("research_cache").updateOne(
          { email: user.email, date: today },
          {
            $set: {
              email:     user.email,
              userId:    user._id,
              date:      today,
              articles,
              cachedAt:  new Date(),
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            }
          },
          { upsert: true }
        );

        results.researched++;
        await sleep(500);

      } catch (err) {
        console.error(`[RESEARCH] Failed for ${user.email}: ${err.message}`);
        results.failed++;
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[RESEARCH] Done in ${duration}s`, results);
    return res.status(200).json({ ok: true, duration: `${duration}s`, ...results });

  } catch (err) {
    console.error("[RESEARCH] Fatal:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = handler;
