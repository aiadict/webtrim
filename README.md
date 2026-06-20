# WebTrim — Hide Elements & Clean Web Pages

> Chrome Extension | Manifest V3 | Plain HTML/CSS/JS | No backend | No account

**Hide AI Overviews, sponsored content, and any annoying element on any website — forever. One click. Stored locally.**

---

## What it does

WebTrim lets you permanently hide parts of websites you never want to see again. Click any element to hide it on that site forever. Add text rules to auto-hide anything containing words like "Sponsored", "AI Overview", or "Recommended for you". Rules apply instantly on every future visit with zero performance cost.

Everything is stored locally on your device — no account, no backend, no data sent anywhere.

---

## Features

- **Click-to-hide picker:** activate from popup → click any element on the page → it disappears, rule saved for that domain
- **Text rules:** hide any element whose visible text contains a string (e.g. "AI Overview", "Sponsored", "Promoted")
- **Per-site rule list:** popup shows all rules for the current domain with toggle and delete
- **Pause mode:** temporarily reveal all hidden elements to check what's been hidden
- **Dynamic pages:** MutationObserver catches elements injected by infinite scroll, SPAs, and React/Next.js apps
- **Quick-add chips:** domain-aware suggestions (e.g. "AI Overview" on Google, "Promoted" on LinkedIn)
- **CSP-safe hiding:** uses `chrome.scripting.insertCSS` to hide elements even on strict CSP sites (GitHub, Stripe, etc.)
- **Instant application:** rules applied at `document_start` — no flash of content before hiding

---

## Install

Load unpacked from Chrome at `chrome://extensions` with Developer Mode enabled, or install from the Chrome Web Store *(coming soon)*.

---

## Technical Architecture

```
webtrim/
├── manifest.json              # MV3, host_permissions: <all_urls>
├── content/
│   └── content.js             # Applies rules at document_start, MutationObserver, picker mode
├── background/
│   └── background.js          # Message routing, storage helpers, CSS injection
├── popup/
│   ├── popup.html
│   ├── popup.js               # Rule list UI, picker toggle, pause toggle
│   └── popup.css
└── icons/
```

**Key decisions:**
- `chrome.storage.local` — no server, no account, GDPR-safe by default
- `document_start` injection — rules applied before DOM renders, zero content flash
- Per-domain write queue in background worker — prevents lost-update race conditions on rapid adds
- Selector generation walks up the DOM tree using `id`, `data-*` attributes, and structural path as fallback
- Dual CSS path (DOM `<style>` + scripting API) ensures hiding works on CSP-restricted sites
