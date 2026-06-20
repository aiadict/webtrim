# WebTrim — Hide Elements & Clean Web Pages

> Chrome Extension | Manifest V3 | Plain HTML/CSS/JS | No backend | No account

## Tagline

**Hide AI Overviews, sponsored content, and any annoying element on any website — forever. One click. Stored locally.**

---

## What it does

WebTrim lets any user permanently hide parts of websites they never want to see again. Click any element to hide it on that site forever. Add text rules to auto-hide anything containing words like "Sponsored", "AI Overview", or "Recommended for you". Rules apply instantly on every future visit with zero performance cost.

---

## The Opportunity

**Entry point — AI Overview hiders:** Google AI Overviews (launched 2024) have generated massive user frustration. Millions search "how to remove AI overview from Google." This is the viral hook that drives initial installs and press coverage.

**Retention — hide anything:** The element blocker engine underneath handles any site, any element. Users stay because they accumulate rules across dozens of sites over time.

**Market gap:**
- uBlock Origin can do element hiding but requires CSS selectors — technical users only
- CustomBlocker (the closest match) has 1k users, 4.2★, effectively dead
- No clean dominant player with 100k+ users and 4.5★+ exists
- This is a broad consumer pain with no consumer-grade solution

---

## Target Audience

| Segment | Pain | Entry keyword |
|---|---|---|
| General web users | Google AI Overviews cluttering search results | "hide ai overview chrome" |
| News readers | Comment sections, related articles, cookie banners | "hide elements website chrome" |
| LinkedIn users | Promoted posts, "People Also Viewed", suggestions | "clean linkedin feed" |
| Power users / devs | Rule-based element hiding across any site | "block elements by text chrome" |

---

## Positioning

Do NOT position as "element blocker" — too technical, too broad.

Lead with: **"Clean up Google Search. Hide AI Overviews and clutter."**

Then expand: **"Works on any website. Hide anything. Permanently."**

---

## Core Features

### MVP (Phase 1)
- **Click-to-hide picker:** activate from popup → click any element on the page → it disappears, rule saved for this domain
- **Text rules:** hide any element whose visible text contains a string (e.g. "AI Overview", "Sponsored", "Promoted")
- **Per-site rule list:** popup shows all rules for current domain with toggle and delete
- **Pause mode:** temporarily reveal all hidden elements (useful for checking what's hidden)
- **Instant application:** content script applies rules at `document_start` — no flash of hidden content

### Phase 2
- **MutationObserver:** catches dynamically injected elements (infinite scroll, SPAs, React/Next.js apps)
- **CSS selector input:** power user mode for precise targeting
- **Preset rule packs:** "Google Clean" (AI Overviews + sponsored), "LinkedIn Clean" (promoted jobs + ads)
- **Import / export rules:** JSON file

### Phase 3 — Monetization
- **Free tier:** up to 10 rules total
- **Pro ($9 one-time or $3/month):** unlimited rules, preset packs, RegExp matching, rule groups, import/export
- Payment via ExtensionPay or LemonSqueezy (no backend required)

---

## Technical Architecture

```
webtrim/
├── manifest.json              # MV3, host_permissions: <all_urls>
├── content/
│   └── content.js             # Applies rules at document_start, MutationObserver, picker mode
├── background/
│   └── background.js          # Message routing, storage helpers
├── popup/
│   ├── popup.html
│   ├── popup.js               # Rule list UI, picker toggle, pause toggle
│   └── popup.css
└── icons/
```

**Key technical decisions:**
- `chrome.storage.local` for all rules — no server, no account, GDPR-safe by default
- `document_start` injection — rules applied before DOM renders, zero content flash
- `MutationObserver` in content script — handles dynamically loaded elements
- Picker mode injects a highlight overlay via scripting API, no persistent DOM pollution
- Selector generation: walk up DOM tree to build a stable, reasonably specific CSS selector

**Main technical challenge:** Generating stable CSS selectors for dynamic pages (SPAs that re-render on navigation). Use a combination of `id`, `data-*` attributes, and structural path as fallback.

---

## Monetization Model

| Tier | Price | Features |
|---|---|---|
| Free | $0 | Up to 10 rules across all sites |
| Pro | $9 one-time | Unlimited rules, preset packs, RegExp, import/export |

Revenue estimate: [ESTIMATE] $80–$300 per 1,000 DAU/month at 2–4% paid conversion.

---

## Launch Strategy

1. **CWS listing keywords:** "hide AI overview", "hide elements on website", "clean google search", "block page elements", "remove sponsored content chrome"
2. **Reddit launch:** post in r/chrome_extensions, r/mildlyinfuriating (AI Overview frustration threads), r/productivity
3. **Hook:** "I built a Chrome extension to remove Google AI Overviews — also works on any other element on any site"
4. **Press angle:** anti-AI-clutter narrative, privacy-first (local-only, no data sent)

---

## Build Estimate

- Phase 1 MVP: 10–14 days solo
- Phase 2 Polish: 5–7 days
- Phase 3 Monetization: 2–3 days

Total to paid launch: ~3 weeks
