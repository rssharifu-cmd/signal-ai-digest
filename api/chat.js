/**
 * Vercel Node.js Serverless — POST /api/chat
 * GET /api/chat — quick health JSON
 *
 * Modified to support Gemini automatically as the primary intelligence model.
 */

const { formatMemoryForPrompt, buildDigestPrompt } = require("./memory");
const { GoogleGenAI } = require("@google/genai");

const GROK_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";
const GROK_TIMEOUT_MS = 45000;

// Initialize Gemini if key exists
let aiClient = null;
if (process.env.GEMINI_API_KEY) {
  try {
    aiClient = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        }
      }
    });
  } catch (err) {
    console.error("Failed to initialize GoogleGenAI client:", err);
  }
}

const ONBOARDING_SYSTEM = `ROLE:
This AI is the onboarding intelligence for Sharflow.
Its only job is to understand who the user is through natural conversation — so Sharflow can deliver personalized intelligence later.

CONVERSATION STYLE:
- No intro, no welcome, no setup mentions. Do NOT introduce yourself or mention building a profile.
- There is no opening message. The first message must simply be: "What do you do?" and absolutely nothing else.
- DO NOT COMMENT ON OR VALIDATE THE USER'S ANSWERS. Remove all commentary on user answers (do NOT say things like "that's interesting", "abacus is an ancient tool", "that sounds exciting", "great!", "awesome!", "cool!", "I understand", "I see", or validate of any kind).
- Just ask the next question. Nothing else before it. No filler, no appreciation, no conversational buffers.
- One question at a time. Always.
- Sound like a sharp, direct, and elite strategist, not an appreciative or talkative chatbot.
- Never use bullet points during conversation.
- Never ask about problems or challenges.

CONVERSATION FLOW:
First message: "What do you do?"
Then based on their answer, go narrower:
- What sector or specific area within that profession?
Then based on that:
- What does their actual day-to-day work look like?
Then:
- How do they currently stay informed? (books, podcasts, YouTube, newsletters, Twitter, communities)
Then:
- What kind of content do they find actually useful vs what feels like noise to them?
Then one final question to fill any remaining gap.

ADAPTIVE RULES (apply based on what they say):
- Founder → ask company stage and market
- Investor → ask investment thesis and focus areas
- Tech person → ask what they build and who they build for
- Finance person → ask what markets or instruments they focus on
- Creative → ask what projects they are currently working on
- Student → ask what they are preparing for or study toward
- Policy/Government → ask what area and at what scale
- Unclear profession → ask what a typical Tuesday looks like for them

GOAL — by end of conversation AI must understand:
1. Their industry, sector, and exact role
2. How specialized vs broad their work is
3. Where they get information and how they learn
4. What content depth they prefer (quick signals vs deep analysis)
5. What they consider noise — what they want filtered out
6. What is happening in their world right now
7. What they are trying to build or achieve

WRAPPING UP:
After 4-6 user messages, when enough is known, say exactly:
"Got everything I need. Let me put together your profile."
Do not output the profile yet. Just say that line.

NEVER:
- Ask two things at once
- Repeat anything already answered
- Give advice or suggestions
- Say "as someone in your field..."
- Mention being an AI or building a profile
- Ask generic goal questions without context`;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function grokFetch(apiKey, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GROK_TIMEOUT_MS);
  try {
    return await fetch(GROK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function parseBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  const raw = typeof req.body === "string" ? req.body : "";
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function handler(req, res) {
  cors(res);

  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      route: "/api/chat",
      runtime: "nodejs",
    });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = parseBody(req);
    const apiGrokKey = (process.env.GROK_API_KEY || "").trim();

    const action = body.action || "chat";

    // ── CHAT ─────────────────────────────────────────────────────────────────
    if (action === "chat") {
      const messages = body.messages;
      if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: "messages array required" });
      }

      // Profile form data passed from frontend
      const profileForm = body.profileForm || {};
      const profileContext = Object.keys(profileForm).length
        ? `\n\nPROFILE FORM ALREADY SUBMITTED:\n${Object.entries(profileForm)
            .map(([k, v]) => `- ${k}: ${v}`)
            .filter(([, v]) => v)
            .join("\n")}`
        : "";

      let system = ONBOARDING_SYSTEM + profileContext;
      let conv = messages;

      if (messages[0]?.role === "assistant") {
        system +=
          "\n\nYou already opened the chat with this message (stay consistent):\n---\n" +
          messages[0].content +
          "\n---";
        conv = messages.slice(1);
      }
      if (conv.length === 0) return res.status(400).json({ error: "No user messages yet" });

      const userTurns = messages.filter((m) => m.role === "user").length;

      // After 4+ turns, hint AI to wrap up if it hasn't
      if (userTurns >= 4) {
        system +=
          "\n\nYou have collected enough information. In your next reply (if not already done), warmly tell the user you have everything needed and are ready to generate their profile summary. Keep it to 1–2 sentences.";
      }

      let content = "";

      if (!apiGrokKey) {
        return res.status(400).json({ error: "GROK_API_KEY not configured" });
      }
      const grokRes = await grokFetch(apiGrokKey, {
        model: "llama-3.3-70b-versatile",
        max_tokens: 600,
        messages: [{ role: "system", content: system }, ...conv],
      });
      if (!grokRes.ok) {
        const err = await grokRes.json().catch(() => ({}));
        return res.status(grokRes.status).json({ error: err.error?.message || "Groq API error" });
      }
      const data = await grokRes.json();
      content = data.choices?.[0]?.message?.content ?? "";

      // Detect if AI is signalling wrap-up
      const wrapKeywords = ["ready to draft", "ready to generate", "have everything", "build your profile", "draft your profile"];
      const readyForSummary = userTurns >= 3 && wrapKeywords.some(k => content.toLowerCase().includes(k));

      return res.status(200).json({
        content,
        userTurns,
        readyForSummary,
      });
    }

    // ── SUMMARY ──────────────────────────────────────────────────────────────
    if (action === "summary") {
      const messages = body.messages;
      if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: "messages required for summary" });
      }

      const profileForm = body.profileForm || {};
      const profileFormText = Object.keys(profileForm).length
        ? `PROFILE FORM:\n${Object.entries(profileForm)
            .map(([k, v]) => `- ${k}: ${v}`)
            .filter(([, v]) => v)
            .join("\n")}\n\n`
        : "";

      const transcript = messages
        .map((m) => `${m.role === "user" ? "User" : "Signal"}: ${m.content}`)
        .join("\n\n");

      const adj =
        typeof body.adjustment === "string" && body.adjustment.trim()
          ? `\n\nThe user requests this revision: ${body.adjustment.trim()}`
          : "";

      const userPrompt = `${profileFormText}FOLLOW-UP CHAT:\n${transcript}${adj}\n\n---
Write a highly personalized, sharp profile summary of this user based on the chat transcript.
Output EXACTLY 4 lines (maximum 6 lines total, no more), with absolutely NO introduction, NO conversational filler sentences, and NO concluding phrases.

You MUST use EXACTLY this format:
Who they are: [A tight, non-generic description of professional focus/interests]
Topics to cover: [Primary specialized topics and domains to monitor for signals]
What to avoid: [Specific noises, low-value themes, or generic advice to filter out]
Preferred content style: [Tone, size, or specificity preference, e.g. 'Actionable, analytical, highly technical bullet points']`;

      let content = "";

      if (aiClient) {
        const response = await aiClient.models.generateContent({
          model: "gemini-3.5-flash",
          contents: userPrompt,
          config: {
            systemInstruction: "You write tight, accurate user profiles for a personalized digest product. Use only facts from the form and chat. Be specific, not generic.",
            temperature: 0.3,
          }
        });
        content = response.text || "";
      } else {
        if (!apiGrokKey) {
          return res.status(400).json({
            error: "Missing API key. Provide GEMINI_API_KEY or GROK_API_KEY.",
          });
        }
        const grokRes = await grokFetch(apiGrokKey, {
          model: MODEL,
          max_tokens: 1000,
          messages: [
            {
              role: "system",
              content:
                "You write tight, accurate user profiles for a personalized digest product. Use only facts from the form and chat. Be specific, not generic.",
            },
            { role: "user", content: userPrompt },
          ],
        });

        if (!grokRes.ok) {
          const err = await grokRes.json().catch(() => ({}));
          return res.status(grokRes.status).json({ error: err.error?.message || "Groq API error" });
        }

        const data = await grokRes.json();
        content = data.choices?.[0]?.message?.content ?? "";
      }

      return res.status(200).json({ content });
    }

    // ── DIGEST ───────────────────────────────────────────────────────────────
    if (action === "digest") {
      const profile = body.profile || {};
      const memory = body.memory || null;
      const narrative =
        profile.narrative ||
        profile.summary ||
        [
          profile.profession && `Role: ${profile.profession}`,
          profile.goals && `Goals: ${profile.goals}`,
          profile.topics && `Topics: ${profile.topics}`,
          profile.avoid && `Avoid: ${profile.avoid}`,
          profile.language && `Language: ${profile.language}`,
          profile.country && `Country: ${profile.country}`,
          profile.newsScope && `News scope: ${profile.newsScope}`,
          profile.digestLength && `Digest length: ${profile.digestLength}`,
        ]
          .filter(Boolean)
          .join("\n");

      if (!narrative && !memory) {
        return res.status(400).json({ error: "profile or memory required" });
      }

      const today = new Date().toLocaleDateString("en-US", {
        weekday: "long", month: "long", day: "numeric", year: "numeric",
      });

      const newsContext =
        typeof body.newsContext === "string" && body.newsContext.trim()
          ? body.newsContext.trim()
          : "";

      const memoryText = formatMemoryForPrompt(memory);
      const tone = profile.tone ? `Preferred tone: ${profile.tone}` : "";
      const prompt = buildDigestPrompt({
        memoryText: [memoryText, tone].filter(Boolean).join("\n"),
        profileText: narrative,
        newsContext,
        plan: body.plan,
        today,
      });

      let content = "";

      if (aiClient) {
        const response = await aiClient.models.generateContent({
          model: "gemini-3.5-flash",
          contents: prompt,
          config: {
            systemInstruction: "You are Signal — a personal intelligence system. You filter global noise into insights for one specific person. You never hallucinate. You explain WHY each item matters to them. You give actionable implications, not summaries.",
            temperature: 0.3,
          }
        });
        content = response.text || "";
      } else {
        if (!apiGrokKey) {
          return res.status(400).json({
            error: "Missing API key. Provide GEMINI_API_KEY or GROK_API_KEY.",
          });
        }
        const isPro = body.plan === "pro";
        const grokRes = await grokFetch(apiGrokKey, {
          model: MODEL,
          max_tokens: isPro ? 1800 : 1400,
          temperature: 0.3,
          messages: [
            {
              role: "system",
              content:
                "You are Signal — a personal intelligence system. You filter global noise into insights for one specific person. You never hallucinate. You explain WHY each item matters to them. You give actionable implications, not summaries.",
            },
            { role: "user", content: prompt },
          ],
        });

        if (!grokRes.ok) {
          const err = await grokRes.json().catch(() => ({}));
          return res.status(grokRes.status).json({ error: err.error?.message || "Groq API error" });
        }

        const data = await grokRes.json();
        content = data.choices?.[0]?.message?.content ?? "";
      }

      return res.status(200).json({ content });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    const msg =
      err?.name === "AbortError" ? "Request timed out — try again." : err.message || "Server error";
    return res.status(err?.name === "AbortError" ? 504 : 500).json({ error: msg });
  }
}

module.exports = handler;
