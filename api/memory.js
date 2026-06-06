/**
 * Lightweight per-user memory for Signal personalization.
 * No conversation history — only structured signals.
 */

const CLICK_RETENTION_DAYS = 7;
const DEFAULT_INTEREST_SCORE = 70;

function parseTopics(topicsStr) {
  return (topicsStr || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function parseSources(sourcesStr) {
  return (sourcesStr || "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseDisliked(avoidStr) {
  return (avoidStr || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Build initial memory from onboarding profile data. */
function buildMemoryFromOnboarding({
  profession, goals, topics, avoid, customSources, summary,
  language, country, newsScope, digestLength,
}) {
  const interests = {};
  for (const topic of parseTopics(topics)) {
    interests[topic] = DEFAULT_INTEREST_SCORE;
  }

  return {
    role: (profession || "").trim(),
    goals: (goals || "").trim(),
    interests,
    dislikedTopics: parseDisliked(avoid),
    favoriteSources: parseSources(customSources),
    clickedTopics: [],
    profileSummary: (summary || "").trim(),
    language: (language || "English").trim(),
    country: (country || "").trim(),
    newsScope: (newsScope || "Mixed").trim(),
    digestLength: (digestLength || "Standard").trim(),
    updatedAt: new Date(),
  };
}

function pruneClickedTopics(clickedTopics) {
  const cutoff = Date.now() - CLICK_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return (clickedTopics || []).filter((c) => {
    const at = c.at instanceof Date ? c.at.getTime() : new Date(c.at).getTime();
    return at >= cutoff;
  });
}

/** Extract useful, non-stopword keyword concepts for semantic profiling. */
function extractKeywords(text) {
  if (!text) return [];
  const cleaned = text
    .replace(/^[①②③④⑤]\s*/, "")
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"']/g, " ")
    .toLowerCase();
  
  const stopwords = new Set([
     "about", "above", "after", "again", "against", "all", "am", "an", "and", "any", "are", "as", "at",
     "be", "because", "been", "before", "being", "below", "between", "both", "but", "by", "can", "could",
     "did", "do", "does", "doing", "down", "during", "each", "few", "for", "from",
     "further", "had", "has", "have", "having", "he", "her", "here", "hers", "herself", "him", "himself",
     "his", "how", "i", "if", "in", "into", "is", "it", "its", "itself", "me", "more", "most", "my",
     "myself", "no", "nor", "not", "of", "off", "on", "once", "only", "or", "other", "our", "ours",
     "ourselves", "out", "over", "own", "same", "she", "should", "so", "some", "such", "than", "that",
     "the", "their", "theirs", "them", "themselves", "then", "there", "these", "they", "this", "those",
     "through", "to", "too", "under", "until", "up", "very", "was", "we", "were", "what", "when", "where",
     "which", "while", "who", "whom", "why", "with", "would", "you", "your", "yours", "yourself", "yourselves",
     "what's", "you'll", "you'd", "we'll", "it's"
  ]);

  return cleaned
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !stopwords.has(w));
}

/** Apply 👍/👎 feedback — adjusts interest scores and disliked list, with long-term semantic keyword updates. */
function applyFeedback(memory, { topic, sentiment, storyTitle }) {
  const m = { ...memory };
  m.interests = { ...(m.interests || {}) };
  m.dislikedTopics = [...(m.dislikedTopics || [])];
  m.clickedTopics = pruneClickedTopics(m.clickedTopics || []);

  const key = (topic || storyTitle || "").trim();
  if (!key) return m;

  const now = new Date();
  m.clickedTopics.push({ topic: key, at: now });

  const keywords = extractKeywords(key);

  if (sentiment === "like") {
    const prev = m.interests[key] ?? DEFAULT_INTEREST_SCORE;
    m.interests[key] = Math.min(100, prev + 15);
    
    // Boost keyword concepts in long-term profile
    for (const kw of keywords) {
      const pKw = m.interests[kw] ?? DEFAULT_INTEREST_SCORE;
      m.interests[kw] = Math.min(100, pKw + 8);
    }

    m.dislikedTopics = m.dislikedTopics.filter(
      (d) => d.toLowerCase() !== key.toLowerCase() && !keywords.includes(d.toLowerCase())
    );
  } else if (sentiment === "dislike") {
    const prev = m.interests[key] ?? DEFAULT_INTEREST_SCORE;
    m.interests[key] = Math.max(0, prev - 25);

    // Down-rank keyword concepts in long-term profile
    for (const kw of keywords) {
      const pKw = m.interests[kw] ?? DEFAULT_INTEREST_SCORE;
      m.interests[kw] = Math.max(0, pKw - 12);
    }

    if (!m.dislikedTopics.some((d) => d.toLowerCase() === key.toLowerCase())) {
      m.dislikedTopics.push(key);
    }
  }

  m.clickedTopics = pruneClickedTopics(m.clickedTopics);
  m.updatedAt = now;
  return m;
}

/** Apply opened article / clicked link event - records click in recent engagements and reinforces long-term profile interest. */
function applyClick(memory, { topic, storyTitle, url }) {
  const m = { ...memory };
  m.interests = { ...(m.interests || {}) };
  m.clickedTopics = pruneClickedTopics(m.clickedTopics || []);

  const key = (topic || storyTitle || "").trim();
  if (!key) return m;

  const now = new Date();
  // Record short-term engagement activity (declaws after 7 days)
  m.clickedTopics.push({ topic: key, url, at: now });

  // Reinforce permanent interest score
  const prev = m.interests[key] ?? DEFAULT_INTEREST_SCORE;
  m.interests[key] = Math.min(100, prev + 5);

  // Reinforce semantic keywords in long-term memory for broader interest learning
  const keywords = extractKeywords(key);
  for (const kw of keywords) {
    const pKw = m.interests[kw] ?? DEFAULT_INTEREST_SCORE;
    m.interests[kw] = Math.min(100, pKw + 3);
  }

  m.clickedTopics = pruneClickedTopics(m.clickedTopics);
  m.updatedAt = now;
  return m;
}

/** Format memory block for AI digest prompts. */
function formatMemoryForPrompt(memory) {
  if (!memory) return "";

  const lines = [];
  if (memory.role) lines.push(`Role: ${memory.role}`);
  if (memory.goals) lines.push(`Goals: ${memory.goals}`);
  if (memory.profileSummary) {
    lines.push(`Profile summary: ${memory.profileSummary.slice(0, 600)}`);
  }

  const interests = memory.interests || {};
  const ranked = Object.entries(interests)
    .sort((a, b) => b[1] - a[1])
    .map(([t, s]) => `${t} (${s}/100)`);
  if (ranked.length) lines.push(`Interest scores: ${ranked.join(", ")}`);

  if (memory.dislikedTopics?.length) {
    lines.push(`Disliked / deprioritize: ${memory.dislikedTopics.join(", ")}`);
  }
  if (memory.favoriteSources?.length) {
    lines.push(`Favorite sources: ${memory.favoriteSources.join(", ")}`);
  }
  if (memory.language) lines.push(`Language: ${memory.language}`);
  if (memory.country) lines.push(`Country: ${memory.country}`);
  if (memory.newsScope) lines.push(`News scope: ${memory.newsScope}`);
  if (memory.digestLength) lines.push(`Digest length: ${memory.digestLength}`);

  const recent = pruneClickedTopics(memory.clickedTopics || [])
    .slice(-8)
    .map((c) => c.topic);
  if (recent.length) lines.push(`Recently engaged topics (7d): ${recent.join(", ")}`);

  return lines.length ? lines.join("\n") : "";
}

function ensureMemory(user, profilePayload) {
  if (user.memory?.role || user.memory?.interests) {
    const m = { ...user.memory };
    m.clickedTopics = pruneClickedTopics(m.clickedTopics || []);
    return m;
  }
  return buildMemoryFromOnboarding({
    profession: profilePayload?.profession || user.profile?.profession,
    goals: profilePayload?.goals || user.profile?.goals,
    topics: profilePayload?.topics || user.profile?.topics,
    avoid: profilePayload?.avoid || user.profile?.avoid,
    customSources: profilePayload?.customSources || user.profile?.customSources,
    summary: profilePayload?.summary || user.profile?.summary,
  });
}

/** Shared digest prompt — dashboard + cron use identical intelligence rules. */
function buildDigestPrompt({ memoryText, profileText, newsContext, plan, today }) {
  const isPro = plan === "pro";

  const newsRules = newsContext
    ? `LIVE NEWS (mandatory — every item must cite a source below):
- Use exact URLs provided. Never invent headlines or outlets.
- Skip weakly related items. Prefer 2–3 sharp insights over padding.
- Deprioritize topics in the disliked list.

${newsContext}`
    : `No live news feed supplied. Use only the user profile. Prefix title with "[Preview — connect Tavily API for live news]". Do not invent events or URLs.`;

  return `Generate a personalized intelligence brief for ONE specific user. Today is ${today}.

USER MEMORY (personalization signals — use heavily):
${memoryText || profileText}

${newsRules}

OUTPUT FORMAT (follow exactly):

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
YOUR SIGNAL · ${today}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔥 TOP STORIES

① [Story headline from source]
WHAT: [One clear sentence — the fact, no fluff]
WHY YOU: [One sentence — why this matters for THIS user's role and goals]
ACTION: [One concrete implication or move they could make]
→ [source URL]

② [Story headline]
WHAT: [fact]
WHY YOU: [personal relevance]
ACTION: [implication]
→ [source URL]

③ [Story headline — only if strongly relevant]
WHAT: [fact]
WHY YOU: [personal relevance]
ACTION: [implication]
→ [source URL]
${isPro ? `
📺 VIDEO WORTH YOUR TIME
"[Title]" · [Channel]
WHY YOU: [1 sentence tied to goals]
ACTION: [What to take from it]
→ [URL]
` : ""}
💡 ONE THING TO DO TODAY
[Single specific action aligned with their goals — not generic advice]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STRICT RULES:
- No generic AI hype, market summaries, or filler phrases.
- No repeated sentence structures across items.
- Every story MUST have WHAT / WHY YOU / ACTION lines.
- Write like a sharp analyst briefing one person, not a newsletter.`;
}

module.exports = {
  buildMemoryFromOnboarding,
  applyFeedback,
  applyClick,
  formatMemoryForPrompt,
  ensureMemory,
  pruneClickedTopics,
  buildDigestPrompt,
};
