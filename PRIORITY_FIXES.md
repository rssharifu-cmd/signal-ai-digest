# Priority Fixes & Implementation Roadmap: Signal

This roadmap classifies issues identified during the Signal platform audit and charts a multi-phase implementation plan.

---

## 1. Issue Risk Classifications

### 🔴 CRITICAL RISK
1.  **Simulated Timezones & Unsaved Settings (Database Desync)**:
    *   *Issue*: `/api/user.js` discards `body.settings`, meaning user timezone preferences and notification toggles are permanently lost during synchronization.
    *   *Impact*: Inability to schedule or deliver digests at appropriate local hours.
2.  **Serverless Sequential Loop Timeout Exception ($O(N)$ Delivery)**:
    *   *Issue*: `/api/cron.js` loops synchronously and sequentially through all users. The total execution time scale rises linearly.
    *   *Impact*: Total crash and abort of the global delivery pipeline once the user base exceeds ~12 active users due to Vercel/Cloud Run execution limits.

### 🟡 HIGH RISK
3.  **Hardcoded English News Search & Generic Sources**:
    *   *Issue*: Dynamic queries for non-English speakers use English criteria. RSS directories are hardcoded to major UK/US channels (BBC & TechCrunch), ignoring specified niches and favorite sources.
    *   *Impact*: Degraded regional personalization for international subscribers.
4.  **Enforced Strict Profile Locking**:
    *   *Issue*: The 7-day rigid user profile edit lock cannot be altered, preventing users from immediate corrections or visual tuning.
    *   *Impact*: Increased early churn and frustration.

### 🔵 MEDIUM RISK
5.  **Manual Pull Cost & Abuse Surface**:
    *   *Issue*: The direct "Generate" trigger is costly and can be run continuously by a single user, generating rapid, expensive LLM charges.
    *   *Impact*: Uncapped external API expenses.
6.  **Mock Payments & Free Tiers**:
    *   *Issue*: Pricing and payment processes are mock indicators, preventing monetization.
    *   *Impact*: Zero revenue generation.

### 🟢 LOW RISK
7.  **Short Memory Retention Cycles**:
    *   *Issue*: Evaluated user feedback factors are purged after 7 days, destroying early pattern profiles.
    *   *Impact*: Declining digest relevance over time.

---

## 2. Phased Implementation Plan

### Phase 1: Must Fix Before Launch (Production Readiness)
*   [ ] **Correct Schema Synchronization in `/api/user.js`**:
    *   Update user save endpoint to parse and persist the `settings` object block (specifically `timezone`, `digestTime`, `digestFrequency`, `notifications`, `learningEnabled`, and `analyticsEnabled`) directly to the MongoDB user record.
*   [ ] **Implement Local Hour Timezone Scheduling in `/api/cron.js`**:
    *   Revise the cron SQL/DB query to fetch only users whose local time matches their target `digestTime` (e.g. 08:00 AM) based on their configured `timezone`.
    *   *Example formulation*: Check if `new Date().toLocaleTimeString("en-US", { timeZone: user.settings.timezone })` matches the target window. This enables correct time-shifted delivery.
*   [ ] **Decouple Sequential Bottlenecks**:
    *   Transition sequential loops to concurrent execution (`Promise.all` batches of 5-10 concurrent users) or configure task scheduling triggers to process users individually of the main cron process.

### Phase 2: Strong Personalization & Localization
*   [ ] **Localize Headline Feeds & Searches**:
    *   Configure Tavily and YouTube parameters dynamically using preferred user `language` and regional codes (e.g. setting query language codes, searching native region RSS, and custom regional terms).
*   [ ] **Incorporate Specified Sources**:
    *   Integrate a dynamic RSS extractor that uses the custom favorite sources written by the user, scraping those specific sources if provided.
*   [ ] **Permit Profile Unlock Bypass**:
    *   Replace the rigid 7-day lockdown cycle with an "Edit Profile Anyway" option on the UX dashboard to make customization feel smooth and supportive.

### Phase 3: Growth and Retention Improvements
*   [ ] **Stripe Checkout Integration**:
    *   Include genuine payment processing and token validation checks on the back-end to support the paid Pro tier.
*   [ ] **Dashboard Pull Caching**:
    *   Prevent manual pulls more than once per 12 hours or save generated briefs inside the `digests` collection to avoid double-charging for identical days.
*   [ ] **Upgrade Memory Retentions**:
    *   Revise memory threshold algorithms to separate short-term clicks (7-day decay) from permanent profile interests (explicitly declared topics), ensuring Signal retains a stable memory base.
