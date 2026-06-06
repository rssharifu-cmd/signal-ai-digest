/* Signal — client application */

const STORAGE = {
  lock: "signal_lock_until",
  profile: "signal_profile",
  msgs: "signal_messages",
  email: "signal_email",
  profileForm: "signal_profile_form",
  plan: "signal_plan",
  token: "signal_jwt_token",
  lastDigest: "signal_last_digest",
  lastDigestDate: "signal_last_digest_date",
  emailDigest: "signal_email_digest_on",
};

const LEGACY_LOCK = "digest_locked";
const LEGACY_ANSWERS = "digest_answers";

let profileFormData = {};
let onboardStep = 1;
const ONBOARD_STEPS = 5;
let lockCountdownTimer = null;
let userMemory = null;

// ── Utils ───────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function formatBotHtml(t) {
  return escapeHtml(t).replace(/\n/g, "<br/>");
}

function toast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 4200);
}

function getSavedForm() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE.profileForm) || "{}");
  } catch {
    return {};
  }
}

function authHeaders() {
  const token = localStorage.getItem(STORAGE.token) || "";
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function applyUserToLocalState(user) {
  if (!user) return;
  if (user.name) {
    const form = getSavedForm();
    form.name = user.name;
    localStorage.setItem(STORAGE.profileForm, JSON.stringify(form));
  }
  if (user.plan) localStorage.setItem(STORAGE.plan, user.plan);
  if (user.profile?.summary) localStorage.setItem(STORAGE.profile, user.profile.summary);
  if (user.profile?.lockedUntil) {
    localStorage.setItem(STORAGE.lock, user.profile.lockedUntil);
  }
  if (user.profile) {
    const existing = getSavedForm();
    localStorage.setItem(
      STORAGE.profileForm,
      JSON.stringify({
        name: user.name || existing.name || "",
        profession: user.profile.profession || existing.profession || "",
        goals: user.profile.goals || existing.goals || "",
        topics: user.profile.topics || existing.topics || "",
        avoid: user.profile.avoid || existing.avoid || "",
        customSources: user.profile.customSources || existing.customSources || "",
        language: user.profile.language || existing.language || "English",
        country: user.profile.country || existing.country || "United States",
        newsScope: user.profile.newsScope || existing.newsScope || "Mixed",
        digestLength: user.profile.digestLength || existing.digestLength || "Standard",
        digestTime: user.profile.digestTime || existing.digestTime || "08:00",
        timezone: user.profile.timezone || existing.timezone || "UTC",
      })
    );
  }
  if (user.memory) userMemory = user.memory;
}

function routeAfterAuth(user) {
  const prof = user?.profile?.summary || localStorage.getItem(STORAGE.profile);
  if (prof) {
    const lockRaw = user?.profile?.lockedUntil || localStorage.getItem(STORAGE.lock);
    const lockDate = lockRaw ? new Date(lockRaw) : new Date(0);
    showDashboard(lockDate, prof);
    return true;
  }
  showOnboarding();
  return false;
}

async function hydrateSession() {
  const token = localStorage.getItem(STORAGE.token);
  if (!token) return false;

  try {
    const res = await fetch("/api/auth", { headers: authHeaders() });
    if (!res.ok) {
      localStorage.removeItem(STORAGE.token);
      return false;
    }
    const data = await res.json();
    applyUserToLocalState(data.user);
    return routeAfterAuth(data.user);
  } catch {
    return false;
  }
}

// ── Auth ────────────────────────────────────────────────────────────────────
function openAuthModal(tab = "signup") {
  switchAuthTab(tab);
  document.getElementById("auth-modal").classList.add("open");
}

function closeAuthModal() {
  document.getElementById("auth-modal").classList.remove("open");
}

function switchAuthTab(tab) {
  document.getElementById("auth-signup-form").classList.toggle("hidden", tab !== "signup");
  document.getElementById("auth-login-form").classList.toggle("hidden", tab !== "login");
  document.getElementById("tab-signup").classList.toggle("active", tab === "signup");
  document.getElementById("tab-login").classList.toggle("active", tab === "login");
}

async function handleSignup() {
  const name = document.getElementById("auth-name").value.trim();
  const email = document.getElementById("auth-email").value.trim();
  const pass = document.getElementById("auth-pass").value.trim();
  if (!name || !email || !pass) {
    toast("Please fill in all fields.");
    return;
  }
  if (pass.length < 6) {
    toast("Password must be at least 6 characters.");
    return;
  }

  const btn = document.querySelector("#auth-signup-form .btn-primary");
  btn.disabled = true;
  btn.textContent = "Creating account…";

  try {
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "signup", email, password: pass, name }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast(data.error || "Signup failed");
      return;
    }
    localStorage.setItem(STORAGE.token, data.token);
    localStorage.setItem(STORAGE.email, email);
    document.getElementById("pf-name").value = name;
    closeAuthModal();
    showOnboarding();
  } catch {
    toast("Network error — try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Create Account →";
  }
}

async function handleLogin() {
  const email = document.getElementById("login-email").value.trim();
  const pass = document.getElementById("login-pass").value.trim();
  if (!email || !pass) {
    toast("Please enter email and password.");
    return;
  }

  const btn = document.querySelector("#auth-login-form .btn-primary");
  btn.disabled = true;
  btn.textContent = "Signing in…";

  try {
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "login", email, password: pass }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast(data.error || "Login failed");
      return;
    }

    localStorage.setItem(STORAGE.token, data.token);
    localStorage.setItem(STORAGE.email, email);
    applyUserToLocalState(data.user);

    closeAuthModal();
    routeAfterAuth(data.user);
  } catch {
    toast("Network error — try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign In →";
  }
}

// ── Onboarding wizard ───────────────────────────────────────────────────────
function showOnboarding() {
  document.getElementById("landing-view").classList.add("hidden");
  document.getElementById("app-shell").style.display = "flex";
  document.getElementById("phase-label").textContent = "Setup";
  document.getElementById("onboarding-view").classList.remove("hidden");
  document.getElementById("dashboard-view").classList.add("hidden");

  const form = getSavedForm();
  if (form.name) document.getElementById("pf-name").value = form.name;
  if (form.customTopics) document.getElementById("pf-custom-topics").value = form.customTopics;
  if (form.customSources) document.getElementById("pf-sources").value = form.customSources;
  if (form.language) document.getElementById("pf-language").value = form.language;
  if (form.country) document.getElementById("pf-country").value = form.country;

  restoreChipGroup("role", form.profession, "pf-role-other");
  restoreChipGroup("goal", form.goals, "pf-goal-other");
  restoreChipGroup("scope", form.newsScope || "Mixed");
  restoreChipGroup("length", form.digestLength || "Standard");

  if (form.topics) {
    const selected = form.topics.split(",").map((t) => t.trim().toLowerCase());
    document.querySelectorAll("#topic-chips .option-chip").forEach((chip) => {
      chip.classList.toggle("selected", selected.includes(chip.textContent.trim().toLowerCase()));
    });
  }
  if (form.avoid) {
    const avoidList = form.avoid.split(",").map((t) => t.trim().toLowerCase());
    document.querySelectorAll("#avoid-chips .option-chip").forEach((chip) => {
      chip.classList.toggle("selected", avoidList.includes(chip.textContent.trim().toLowerCase()));
    });
    const chipTexts = Array.from(document.querySelectorAll("#avoid-chips .option-chip.selected")).map((c) =>
      c.textContent.trim().toLowerCase()
    );
    const customAvoid = form.avoid
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t && !chipTexts.includes(t.toLowerCase()))
      .join(", ");
    if (customAvoid) document.getElementById("pf-avoid-custom").value = customAvoid;
  }

  onboardStep = 1;
  updateOnboardUI();
}

function restoreChipGroup(group, value, otherInputId) {
  if (!value) return;
  const chips = document.querySelectorAll(`[data-group="${group}"]`);
  let matched = false;
  chips.forEach((chip) => {
    const isMatch = chip.textContent.trim() === value;
    chip.classList.toggle("selected", isMatch);
    if (isMatch) matched = true;
  });
  if (!matched && otherInputId) {
    const otherChip = document.querySelector(`[data-group="${group}"][data-other]`);
    if (otherChip) {
      otherChip.classList.add("selected");
      const input = document.getElementById(otherInputId);
      if (input) {
        input.classList.remove("hidden");
        input.value = value;
      }
    }
  }
}

function updateOnboardUI() {
  document.querySelectorAll(".onboard-step").forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.step) === onboardStep);
  });

  const pct = (onboardStep / ONBOARD_STEPS) * 100;
  const fill = document.getElementById("progress-fill");
  const label = document.getElementById("progress-label");
  if (fill) fill.style.width = `${pct}%`;
  if (label) label.textContent = `Step ${onboardStep} of ${ONBOARD_STEPS}`;

  document.getElementById("onboard-back").classList.toggle("hidden", onboardStep === 1);
  const nextBtn = document.getElementById("onboard-next");
  nextBtn.textContent = onboardStep === ONBOARD_STEPS ? "Confirm & open dashboard" : "Continue";
  nextBtn.disabled = false;
}

function onboardBack() {
  if (onboardStep > 1) {
    onboardStep--;
    updateOnboardUI();
  }
}

function selectSingleChip(el) {
  const group = el.dataset.group;
  document.querySelectorAll(`[data-group="${group}"]`).forEach((c) => c.classList.remove("selected"));
  el.classList.add("selected");

  const otherKey = el.dataset.other;
  if (otherKey) {
    const input = document.getElementById(`pf-${otherKey}-other`);
    if (input) {
      input.classList.remove("hidden");
      input.focus();
    }
  } else {
    const input = document.getElementById(`pf-${group}-other`);
    if (input) {
      input.classList.add("hidden");
      input.value = "";
    }
  }
}

function getSingleChipValue(group, otherInputId) {
  const selected = document.querySelector(`[data-group="${group}"].selected`);
  if (!selected) return "";
  if (selected.dataset.other) {
    return document.getElementById(otherInputId)?.value.trim() || "";
  }
  return selected.textContent.trim();
}

function toggleChip(el) {
  el.classList.toggle("selected");
}

function getSelectedChips(selector) {
  return Array.from(document.querySelectorAll(`${selector}.selected`)).map((el) =>
    el.textContent.trim()
  );
}

function collectAvoidTopics() {
  const chips = getSelectedChips("#avoid-chips .option-chip");
  const custom = document.getElementById("pf-avoid-custom")?.value.trim() || "";
  const extra = custom ? custom.split(",").map((t) => t.trim()).filter(Boolean) : [];
  return [...chips, ...extra].filter(Boolean).join(", ");
}

function digestLengthToTone(length) {
  if (length === "Quick") return "concise";
  if (length === "Deep") return "detailed";
  return "";
}

function buildProfileSummaryText(form) {
  return [
    `Role: ${form.profession || "—"}`,
    `Goal: ${form.goals || "—"}`,
    `Topics: ${form.topics || "—"}`,
    `Language: ${form.language || "English"}`,
    `Country: ${form.country || "—"}`,
    `News scope: ${form.newsScope || "Mixed"}`,
    `Digest length: ${form.digestLength || "Standard"}`,
    form.avoid ? `Avoid: ${form.avoid}` : null,
    form.customSources ? `Favorite sources: ${form.customSources}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function onboardNext() {
  if (onboardStep === 1) {
    const role = getSingleChipValue("role", "pf-role-other");
    const goal = getSingleChipValue("goal", "pf-goal-other");
    if (!role) { toast("Select your role."); return; }
    if (!goal) { toast("Select your primary goal."); return; }
    profileFormData.profession = role;
    profileFormData.goals = goal;
    profileFormData.name = document.getElementById("pf-name").value.trim() || undefined;
  } else if (onboardStep === 2) {
    const selected = getSelectedChips("#topic-chips .option-chip");
    const custom = document.getElementById("pf-custom-topics").value.trim();
    const allTopics = [...selected, ...(custom ? custom.split(",").map((t) => t.trim()) : [])].filter(Boolean);
    if (!allTopics.length) { toast("Pick at least one topic."); return; }
    profileFormData.topics = allTopics.join(", ");
    profileFormData.customTopics = custom || undefined;
  } else if (onboardStep === 3) {
    profileFormData.language = document.getElementById("pf-language").value;
    profileFormData.country = document.getElementById("pf-country").value;
    profileFormData.newsScope = getSingleChipValue("scope") || "Mixed";
    profileFormData.digestLength = getSingleChipValue("length") || "Standard";
    profileFormData.digestTime = "08:00";
    profileFormData.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } else if (onboardStep === 4) {
    profileFormData.avoid = collectAvoidTopics() || undefined;
    profileFormData.customSources = document.getElementById("pf-sources").value.trim() || undefined;
    profileFormData.tone = digestLengthToTone(profileFormData.digestLength);
    renderOnboardReview();
  } else if (onboardStep === 5) {
    confirmProfile();
    return;
  }

  onboardStep++;
  updateOnboardUI();
  if (onboardStep === 5) renderOnboardReview();
}

function renderOnboardReview() {
  const el = document.getElementById("onboard-review");
  const rows = [
    ["Role", profileFormData.profession],
    ["Goal", profileFormData.goals],
    ["Topics", profileFormData.topics],
    ["Language", profileFormData.language],
    ["Country", profileFormData.country],
    ["News scope", profileFormData.newsScope],
    ["Digest length", profileFormData.digestLength],
    ["Avoid", profileFormData.avoid || "Nothing specified"],
    ["Sources", profileFormData.customSources || "Default curated feeds"],
  ];
  el.innerHTML = rows
    .map(
      ([k, v]) =>
        `<div class="profile-row"><span class="label">${escapeHtml(k)}</span><span>${escapeHtml(v || "—")}</span></div>`
    )
    .join("");
}

async function confirmProfile() {
  const btn = document.getElementById("onboard-next");
  btn.disabled = true;
  btn.textContent = "Setting up…";

  Object.keys(profileFormData).forEach((k) => {
    if (profileFormData[k] == null || profileFormData[k] === "") delete profileFormData[k];
  });
  localStorage.setItem(STORAGE.profileForm, JSON.stringify(profileFormData));

  const profileText = buildProfileSummaryText(profileFormData);
  const lockUntil = new Date();
  lockUntil.setDate(lockUntil.getDate() + 7);
  const savedEmail = localStorage.getItem(STORAGE.email) || "";

  localStorage.setItem(STORAGE.lock, lockUntil.toISOString());
  localStorage.setItem(STORAGE.profile, profileText);

  if (savedEmail) {
    const token = localStorage.getItem(STORAGE.token) || "";
    try {
      const saveRes = await fetch("/api/user", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: profileFormData.name || "",
          plan: localStorage.getItem(STORAGE.plan) || "starter",
          lockedUntil: lockUntil.toISOString(),
          profile: {
            summary: profileText,
            profession: profileFormData.profession || "",
            goals: profileFormData.goals || "",
            topics: profileFormData.topics || "",
            avoid: profileFormData.avoid || "",
            customSources: profileFormData.customSources || "",
            language: profileFormData.language || "English",
            country: profileFormData.country || "",
            newsScope: profileFormData.newsScope || "Mixed",
            digestLength: profileFormData.digestLength || "Standard",
            tone: profileFormData.tone || "",
            digestTime: profileFormData.digestTime || "08:00",
            timezone: profileFormData.timezone || "UTC",
          },
        }),
      });
      if (saveRes.ok) {
        const userRes = await fetch("/api/user", { headers: authHeaders() });
        if (userRes.ok) {
          const userData = await userRes.json();
          if (userData.user?.memory) userMemory = userData.user.memory;
        }
      }
      fetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "welcome",
          email: savedEmail,
          name: profileFormData.name || "",
          profileSummary: profileText,
          unlockDate: lockUntil.toLocaleDateString(undefined,
            { month: "long", day: "numeric", year: "numeric" }),
        }),
      }).catch(() => {});
    } catch (err) {
      console.warn("Profile save:", err.message);
    }
  }

  showDashboard(lockUntil, profileText);
  generateDashboardDigest(true);
}

async function apiChat(body) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(raw.slice(0, 180) || "Invalid JSON");
  }
  if (!res.ok) throw new Error(data.error || res.statusText || "Request failed");
  if (["chat", "summary", "digest"].includes(body.action)) {
    if (typeof data.content !== "string" || !data.content.trim()) {
      throw new Error(data.error || "Empty reply from AI.");
    }
  }
  return data;
}

async function apiNews(form) {
  const res = await fetch("/api/news", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topics: form.topics || "technology, AI",
      profession: form.profession || "",
      avoid: form.avoid || "",
    }),
  });
  const raw = await res.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(raw.slice(0, 180) || "Invalid JSON");
  }
  if (!res.ok) throw new Error(data.error || "News fetch failed");
  return data;
}

function buildNewsContext(news) {
  if (!news?.ok) return "";
  const t = news.text || {};
  return [
    "ARTICLES:",
    t.articles || "None",
    "",
    "REDDIT:",
    t.reddit || "None",
    "",
    "VIDEO:",
    t.video || "None",
  ].join("\n");
}

async function fetchPersonalizedDigest({ showToastOnFetch = false } = {}) {
  const profileText = localStorage.getItem(STORAGE.profile) || "";
  const form = getSavedForm();
  const plan = localStorage.getItem(STORAGE.plan) || "starter";

  let newsContext = "";
  let sourceNote = "";

  try {
    if (showToastOnFetch) toast("Fetching live sources for your topics…");
    const news = await apiNews(form);
    newsContext = buildNewsContext(news);
    const c = news.counts || {};
    sourceNote = `${c.total || 0} items · Tavily ${c.tavily || 0} · RSS ${c.rss || 0} · Reddit ${c.reddit || 0}${c.video ? " · Video" : ""}`;
    if (showToastOnFetch) toast("Personalizing your digest…");
  } catch (e) {
    console.warn("News fetch:", e.message);
    sourceNote = "Profile-only (news API unavailable)";
  }

  const data = await apiChat({
    action: "digest",
    profile: {
      narrative: profileText,
      profession: form.profession,
      goals: form.goals,
      topics: form.topics,
      avoid: form.avoid,
      tone: form.tone,
      language: form.language,
      country: form.country,
      newsScope: form.newsScope,
      digestLength: form.digestLength,
    },
    memory: userMemory,
    plan,
    newsContext,
  });

  const today = new Date().toISOString().split("T")[0];
  localStorage.setItem(STORAGE.lastDigest, data.content);
  localStorage.setItem(STORAGE.lastDigestDate, today);

  return { content: data.content, sourceNote };
}

// ── Dashboard ───────────────────────────────────────────────────────────────
function showDashboard(lockDate, profileText, email) {
  document.getElementById("landing-view").classList.add("hidden");
  document.getElementById("app-shell").style.display = "flex";
  document.getElementById("onboarding-view").classList.add("hidden");
  document.getElementById("dashboard-view").classList.remove("hidden");
  document.getElementById("phase-label").textContent = "Dashboard";

  const hr = new Date().getHours();
  const greet = hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";
  const form = getSavedForm();
  const name = form.name ? `, ${form.name.split(" ")[0]}` : "";
  document.getElementById("dash-greeting").textContent = greet + name;

  document.getElementById("dp-profession").textContent = form.profession || "—";
  document.getElementById("dp-goal").textContent = form.goals || "—";
  document.getElementById("dp-scope").textContent = form.newsScope || "Mixed";
  document.getElementById("dp-avoid").textContent = form.avoid || "—";
  document.getElementById("dp-length").textContent = form.digestLength || "Standard";
  document.getElementById("dp-region").textContent =
    [form.language, form.country].filter(Boolean).join(" · ") || "—";
  document.getElementById("dp-sources").textContent = form.customSources || "Default curated feeds";

  const tagsEl = document.getElementById("dp-tags");
  tagsEl.innerHTML = "";
  (form.topics || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 8)
    .forEach((t) => {
      const tag = document.createElement("span");
      tag.className = "profile-tag";
      tag.textContent = t;
      tagsEl.appendChild(tag);
    });

  syncProfilePanels();
  startLockCountdown(lockDate);
  renderCachedDigest();
  if (profileText) localStorage.setItem(STORAGE.profile, profileText);
}

function syncProfilePanels() {
  const form = getSavedForm();
  const pairs = [
    ["dp-profession", "dp-profession-2", form.profession],
    ["dp-goal", "dp-goal-2", form.goals],
    ["dp-scope", "dp-scope-2", form.newsScope],
    ["dp-length", "dp-length-2", form.digestLength],
    ["dp-avoid", "dp-avoid-2", form.avoid],
  ];
  pairs.forEach(([, to, val]) => {
    const el = document.getElementById(to);
    if (el) el.textContent = val || "—";
  });
  const langEl = document.getElementById("dp-language");
  const countryEl = document.getElementById("dp-country");
  if (langEl) langEl.textContent = form.language || "—";
  if (countryEl) countryEl.textContent = form.country || "—";
  const tags = document.getElementById("dp-tags");
  const tags2 = document.getElementById("dp-tags-2");
  if (tags && tags2) tags2.innerHTML = tags.innerHTML;
}

function syncDigestPanels() {
  const out = document.getElementById("digest-output");
  const full = document.getElementById("digest-output-full");
  const note = document.getElementById("digest-source-note");
  const noteFull = document.getElementById("digest-source-note-full");
  if (full && out) {
    full.className = out.className;
    full.innerHTML = out.innerHTML;
    wireDigestFeedback(full);
  }
  if (noteFull && note) noteFull.textContent = note.textContent;
}

function startLockCountdown(lockDate) {
  if (lockCountdownTimer) clearInterval(lockCountdownTimer);
  const el = document.getElementById("lock-countdown");
  const pill = el?.closest(".meta-pill");

  function tick() {
    const diff = lockDate - new Date();
    if (diff <= 0) {
      el.textContent = "Unlocked — you can refine your profile";
      if (pill) {
        pill.classList.remove("amber");
        pill.classList.add("green");
      }
      clearInterval(lockCountdownTimer);
      return;
    }
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    el.textContent = d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
  }
  tick();
  lockCountdownTimer = setInterval(tick, 60000);
}

function extractStoryTopic(title) {
  const cleaned = (title || "").replace(/^[①②③④⑤]\s*/, "").trim();
  const words = cleaned.split(/\s+/).slice(0, 4).join(" ");
  return words || cleaned;
}

function renderDigestHtml(content) {
  if (!content) return "";

  const lines = content.split("\n");
  let html = "";
  let storyBuf = [];
  let storyTitle = "";
  let inStories = false;
  let storyIndex = 0;

  function flushStory() {
    if (!storyTitle && !storyBuf.length) return;
    const topic = extractStoryTopic(storyTitle);
    const body = storyBuf.map((l) => formatBotHtml(l)).join("<br/>");
    const sid = `story-${storyIndex++}`;
    const safeTopic = escapeHtml(topic);
    const safeTitle = escapeHtml(storyTitle);
    html += `<div class="digest-story" data-topic="${safeTopic}">
      <div class="digest-story-title">${formatBotHtml(storyTitle)}</div>
      <div class="digest-story-body">${body}</div>
      <div class="digest-feedback">
        <span>Relevant?</span>
        <button type="button" class="fb-btn" data-topic="${safeTopic}" data-title="${safeTitle}" data-sentiment="like">👍 More like this</button>
        <button type="button" class="fb-btn" data-topic="${safeTopic}" data-title="${safeTitle}" data-sentiment="dislike">👎 Less like this</button>
      </div>
    </div>`;
    storyBuf = [];
    storyTitle = "";
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^🔥|^💡|^📺|^━/.test(trimmed) || trimmed === "") {
      if (/^①|^②|^③|^④|^⑤/.test(storyTitle)) flushStory();
      if (trimmed) html += `<div style="margin:12px 0 8px;font-weight:700;">${formatBotHtml(trimmed)}</div>`;
      inStories = trimmed.startsWith("🔥");
      continue;
    }
    if (/^①|^②|^③|^④|^⑤/.test(trimmed)) {
      flushStory();
      storyTitle = trimmed;
      inStories = true;
      continue;
    }
    if (inStories && storyTitle) {
      storyBuf.push(line);
      continue;
    }
    html += `<div>${formatBotHtml(line)}</div>`;
  }
  flushStory();
  return html || formatBotHtml(content);
}

function wireDigestFeedback(container) {
  if (!container) return;
  container.querySelectorAll(".fb-btn").forEach((btn) => {
    btn.onclick = () =>
      submitFeedback(btn.dataset.topic, btn.dataset.sentiment, btn.dataset.title, btn);
  });
}

function setDigestContent(el, content) {
  if (!el) return;
  el.innerHTML = renderDigestHtml(content);
  wireDigestFeedback(el);
}

async function submitFeedback(topic, sentiment, storyTitle, btn) {
  const row = btn?.closest(".digest-feedback");
  if (row) {
    row.querySelectorAll(".fb-btn").forEach((b) => b.classList.remove("liked", "disliked"));
    btn.classList.add(sentiment === "like" ? "liked" : "disliked");
  }

  try {
    const res = await fetch("/api/user", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ action: "feedback", topic, sentiment, storyTitle }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Feedback failed");
    if (data.memory) userMemory = data.memory;
    toast(sentiment === "like" ? "Got it — we'll show more like this" : "Noted — we'll show less of this");
  } catch (e) {
    toast(e.message || "Could not save feedback");
  }
}

function renderCachedDigest() {
  const el = document.getElementById("digest-output");
  const note = document.getElementById("digest-source-note");
  const content = localStorage.getItem(STORAGE.lastDigest);
  const date = localStorage.getItem(STORAGE.lastDigestDate);

  if (content && date === new Date().toISOString().split("T")[0]) {
    el.className = "digest-content";
    setDigestContent(el, content);
    note.textContent = `Last generated today`;
  } else if (content) {
    el.className = "digest-content";
    setDigestContent(el, content);
    note.textContent = `Cached from ${date} — tap Generate for today's edition`;
  } else {
    el.className = "digest-content empty";
    el.textContent = "No digest yet. Hit Generate to pull live stories matched to your profile.";
    note.textContent = "";
  }
  syncDigestPanels();
}

async function generateDashboardDigest(auto = false) {
  const el = document.getElementById("digest-output");
  const note = document.getElementById("digest-source-note");
  const btn = document.getElementById("btn-generate-digest");

  el.className = "digest-status";
  el.innerHTML = `<div class="spinner"></div><span>Fetching sources and writing your digest…</span>`;
  if (btn) btn.disabled = true;

  try {
    const { content, sourceNote } = await fetchPersonalizedDigest({ showToastOnFetch: !auto });
    el.className = "digest-content";
    setDigestContent(el, content);
    note.textContent = sourceNote;
    window._lastDigestContent = content;
    syncDigestPanels();
    if (!auto) toast("Digest ready — personalized from live sources");
  } catch (e) {
    el.className = "digest-content empty";
    el.textContent = e.message || "Could not generate digest.";
    note.textContent = "";
    syncDigestPanels();
    toast(e.message || "Digest failed");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function sendDigestEmail() {
  const savedEmail = localStorage.getItem(STORAGE.email) || "";
  const form = getSavedForm();
  const content = window._lastDigestContent || localStorage.getItem(STORAGE.lastDigest) || "";
  if (!savedEmail || !content) {
    toast("Sign in with email and generate a digest first.");
    return;
  }
  toast("Sending to " + savedEmail + "…");
  try {
    const res = await fetch("/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "digest",
        email: savedEmail,
        name: form.name || "",
        digestContent: content,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Send failed");
    toast("Digest emailed to " + savedEmail);
  } catch (e) {
    toast("Email failed: " + e.message);
  }
}

function dashNav(panel) {
  document.querySelectorAll(".dash-nav-item").forEach((b) => {
    b.classList.toggle("active", b.dataset.panel === panel);
  });
  document.querySelectorAll(".dash-panel").forEach((p) => {
    p.classList.toggle("hidden", p.id !== `panel-${panel}`);
  });
  if (panel === "settings") {
    loadSettingsIntoDashboard();
  }
}

// ── Reset & init ──────────────────────────────────────────────────────────────
function tryMigrateLegacy() {
  const locked = localStorage.getItem(LEGACY_LOCK);
  const saved = localStorage.getItem(LEGACY_ANSWERS);
  if (!locked || !saved) return false;
  const until = new Date(locked);
  if (until <= new Date()) return false;
  let answers;
  try {
    answers = JSON.parse(saved);
  } catch {
    return false;
  }
  const narrative = ["Profession", "Goal", "Challenge", "Sources", "YouTube", "Delivery", "Email"]
    .map((k) => {
      const v = answers[k.toLowerCase()];
      return v ? `${k}: ${v}` : null;
    })
    .filter(Boolean)
    .join("\n");
  localStorage.setItem(STORAGE.profile, narrative || "Legacy profile");
  localStorage.setItem(STORAGE.lock, locked);
  return true;
}

function resetAll() {
  if (lockCountdownTimer) clearInterval(lockCountdownTimer);
  Object.values(STORAGE).forEach((k) => localStorage.removeItem(k));
  [LEGACY_LOCK, LEGACY_ANSWERS].forEach((k) => localStorage.removeItem(k));
  profileFormData = {};
  userMemory = null;
  document.getElementById("landing-view").classList.remove("hidden");
  document.getElementById("app-shell").style.display = "none";
  toast("Signed out locally — refresh to start over");
}

window.onload = async () => {
  if (tryMigrateLegacy()) {
    showDashboard(new Date(localStorage.getItem(STORAGE.lock)), localStorage.getItem(STORAGE.profile));
    return;
  }

  const hydrated = await hydrateSession();
  if (hydrated) return;

  const prof = localStorage.getItem(STORAGE.profile);
  if (prof) {
    const lock = localStorage.getItem(STORAGE.lock);
    showDashboard(lock ? new Date(lock) : new Date(0), prof);
    return;
  }

  const savedForm = localStorage.getItem(STORAGE.profileForm);
  if (savedForm) {
    try {
      profileFormData = JSON.parse(savedForm);
    } catch {
      profileFormData = {};
    }
  }
};

function loadSettingsIntoDashboard() {
  const form = getSavedForm();
  
  const elTime = document.getElementById("settings-digest-time");
  const elTz = document.getElementById("settings-timezone");
  const elLang = document.getElementById("settings-language");
  const elCountry = document.getElementById("settings-country");
  const elScope = document.getElementById("settings-news-scope");
  const elLength = document.getElementById("settings-digest-length");
  const elAvoid = document.getElementById("settings-avoid");

  if (elTime) elTime.value = form.digestTime || "08:00";
  if (elTz) elTz.value = form.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  if (elLang) elLang.value = form.language || "English";
  if (elCountry) elCountry.value = form.country || "United States";
  if (elScope) elScope.value = form.newsScope || "Mixed";
  if (elLength) elLength.value = form.digestLength || "Standard";
  if (elAvoid) elAvoid.value = form.avoid || "";
}

async function saveDashboardSettings() {
  const digestTime = document.getElementById("settings-digest-time").value;
  const timezone = document.getElementById("settings-timezone").value;
  const language = document.getElementById("settings-language").value;
  const country = document.getElementById("settings-country").value;
  const newsScope = document.getElementById("settings-news-scope").value;
  const digestLength = document.getElementById("settings-digest-length").value;
  const avoid = document.getElementById("settings-avoid").value;

  const form = getSavedForm();
  form.digestTime = digestTime;
  form.timezone = timezone;
  form.language = language;
  form.country = country;
  form.newsScope = newsScope;
  form.digestLength = digestLength;
  form.avoid = avoid;
  form.tone = digestLengthToTone(digestLength);

  localStorage.setItem(STORAGE.profileForm, JSON.stringify(form));

  const summaryText = buildProfileSummaryText(form);
  localStorage.setItem(STORAGE.profile, summaryText);

  // Sync displayed profile panel labels immediately
  syncProfilePanels();

  const token = localStorage.getItem(STORAGE.token) || "";
  const btn = document.getElementById("btn-save-settings");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Saving…";
  }

  try {
    const res = await fetch("/api/user", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({
        profile: {
          summary: summaryText,
          profession: form.profession || "",
          goals: form.goals || "",
          topics: form.topics || "",
          avoid: form.avoid || "",
          customSources: form.customSources || "",
          language: form.language || "English",
          country: form.country || "",
          newsScope: form.newsScope || "Mixed",
          digestLength: form.digestLength || "Standard",
          tone: form.tone || "",
          digestTime: form.digestTime || "08:00",
          timezone: form.timezone || "UTC",
        }
      })
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || "Failed to save settings to database");
    }

    toast("Settings saved to profile ✓");

    // Re-render dashboard overview and fields with the lock dates
    const savedLock = localStorage.getItem(STORAGE.lock);
    const lockDate = savedLock ? new Date(savedLock) : new Date(0);
    showDashboard(lockDate, summaryText);

  } catch (err) {
    toast("Error: " + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Save Changes";
    }
  }
}

// Expose for inline handlers
window.openAuthModal = openAuthModal;
window.closeAuthModal = closeAuthModal;
window.switchAuthTab = switchAuthTab;
window.handleSignup = handleSignup;
window.handleLogin = handleLogin;
window.toggleChip = toggleChip;
window.selectSingleChip = selectSingleChip;
window.onboardBack = onboardBack;
window.onboardNext = onboardNext;
window.generateDashboardDigest = generateDashboardDigest;
window.sendDigestEmail = sendDigestEmail;
window.dashNav = dashNav;
window.resetAll = resetAll;
window.submitFeedback = submitFeedback;
window.loadSettingsIntoDashboard = loadSettingsIntoDashboard;
window.saveDashboardSettings = saveDashboardSettings;
window.submitFeedback = submitFeedback;
