// WebTrim content script — document_start

(function () {
  'use strict';

  // Normalize domain — strip leading www. so rules saved on www.google.com
  // also apply when the user lands on google.com and vice versa.
  function normalizeDomain(hostname) {
    return hostname.replace(/^www\./, '');
  }

  const domain = normalizeDomain(location.hostname);
  // Namespace storage key to avoid collisions with other extensions.
  const storageKey = 'webtrim::' + domain;

  let rules = [];
  let pickerActive = false;
  let pickerHiddenCount = 0;
  let pauseMode = false;
  let highlightEl = null;
  // Save the element's existing outline before overwriting it.
  let _savedOutline = '';
  let _savedOutlineOffset = '';
  // Page-level picker banner element reference.
  let bannerEl = null;

  // --- CSS-based hiding ---
  // A <style> element avoids inline-style DOM mutations that would re-trigger
  // the MutationObserver and create feedback loops.
  // Appended to <html> immediately because <head> may not exist yet at document_start.
  const styleEl = document.createElement('style');
  styleEl.id = 'webtrim-styles';
  (document.head || document.documentElement).appendChild(styleEl);

  // Shared CSS for pause overlay — used by both setPause and rebuildCSS so they stay in sync.
  const PAUSE_OVERLAY_CSS = `
    [data-webtrim-hidden], .webtrim-paused {
      outline: 2px dashed rgba(231,76,60,0.55) !important;
      outline-offset: -2px !important;
      background-color: rgba(231,76,60,0.07) !important;
    }`;

  function rebuildCSS() {
    let css;
    if (pauseMode) {
      css = PAUSE_OVERLAY_CSS;
    } else {
      const lines = ['[data-webtrim-hidden] { display: none !important; }'];
      for (const rule of rules) {
        if (rule.disabled || rule.type !== 'selector') continue;
        // Invalid selectors are silently dropped by the CSS engine — no try/catch needed.
        lines.push(`${rule.value} { display: none !important; }`);
      }
      css = lines.join('\n');
    }
    // Primary path: DOM style element (instant, works on most pages).
    styleEl.textContent = css;
    // Parallel path: scripting API injection bypasses pages with strict CSP
    // (GitHub, Stripe, banking sites) that block content-script-inserted <style> elements.
    chrome.runtime.sendMessage({ action: 'updateCSS', css }).catch(() => {});
  }

  // --- Text rule matching ---

  function applyTextRules() {
    if (!document.body) return;
    for (const rule of rules) {
      if (rule.disabled || rule.type !== 'text') continue;
      hideByText(rule.value);
    }
  }

  function hideByText(text) {
    const lower = text.toLowerCase();
    // Exclude text nodes inside <script>, <style>, <noscript>, <template>
    // so matching a string that appears in inline JS never hides a script tag.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const tag = node.parentElement?.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      if (!node.textContent.toLowerCase().includes(lower)) continue;
      const target = findMeaningfulParent(node.parentElement);
      if (target && !target.hasAttribute('data-webtrim-hidden')) {
        target.setAttribute('data-webtrim-hidden', '');
      }
    }
  }

  // Walk up to find the real ad container, then collapse single-child wrappers above it.
  // Phase 1: skip single-child blocks (label wrappers) until we find a block with > 1 child.
  // Phase 2: keep walking up through single-child ancestors (the gray slot reservations)
  //          so they collapse too, stopping before a block that has other content as siblings.
  function findMeaningfulParent(el) {
    const blockTags = new Set(['DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'LI', 'TR', 'HEADER', 'FOOTER', 'NAV', 'MAIN']);
    const safe = new Set([document.body, document.documentElement]);
    let node = el;
    let depth = 0;
    let firstBlock = null;

    while (node && !safe.has(node) && depth < 15) {
      if (blockTags.has(node.tagName)) {
        if (!firstBlock) firstBlock = node;
        if (node.children.length > 1) {
          // Found the real container — bubble up through single-child slot wrappers (max 6).
          let result = node;
          let parent = node.parentElement;
          let up = 0;
          while (parent && !safe.has(parent) && blockTags.has(parent.tagName) && parent.children.length === 1 && up < 6) {
            result = parent;
            parent = parent.parentElement;
            up++;
          }
          return result;
        }
      }
      node = node.parentElement;
      depth++;
    }
    return firstBlock || ((el && !safe.has(el)) ? el : null);
  }

  // Full rebuild: remove all text-rule attributes then reapply everything.
  // Required after any rule change so deleted/disabled rules stop hiding elements.
  // Selector rules need no DOM cleanup — the CSS stylesheet handles them directly.
  function fullApply() {
    document.querySelectorAll('[data-webtrim-hidden]').forEach(el => {
      el.removeAttribute('data-webtrim-hidden');
    });
    rebuildCSS();
    applyTextRules();
    // Re-sync pause overlay classes if paused — rules may have changed (added/deleted/toggled).
    if (pauseMode) {
      removePauseOverlay();
      applyPauseOverlay();
    }
  }

  // --- MutationObserver for dynamic pages / SPAs ---

  // Use requestIdleCallback so text-rule scanning doesn't interrupt active rendering.
  // Genuine fallback to setTimeout for environments where rIC is unavailable.
  const _rIC = window.requestIdleCallback
    ? (cb) => window.requestIdleCallback(cb, { timeout: 1000 })
    : (cb) => window.setTimeout(cb, 0);
  const _cIC = window.cancelIdleCallback
    ? (id) => window.cancelIdleCallback(id)
    : (id) => window.clearTimeout(id);

  let textRuleTimer = null;
  function scheduleTextRules() {
    if (textRuleTimer !== null) _cIC(textRuleTimer);
    textRuleTimer = _rIC(() => {
      textRuleTimer = null;
      applyTextRules();
    });
  }

  const observer = new MutationObserver((mutations) => {
    // Exclude mutations caused by our own styleEl changes.
    // Setting styleEl.textContent creates a childList mutation that would
    // otherwise cause an infinite observer → rebuild → observer loop.
    const hasNewNodes = mutations.some(m => {
      if (!m.addedNodes.length) return false;
      if (m.target === styleEl || styleEl.contains(m.target)) return false;
      if (bannerEl && (m.target === bannerEl || bannerEl.contains(m.target))) return false;
      if (bannerEl && [...m.addedNodes].includes(bannerEl)) return false;
      return true;
    });
    if (!hasNewNodes) return;
    // Selector rules are covered by CSS automatically; only text rules need a re-scan.
    scheduleTextRules();
  });

  function startObserver() {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  // --- Picker banner ---
  // Injected into the page when picker mode is active so the user knows what to do.
  // pointer-events: none lets clicks pass through to the element underneath.

  function showPickerBanner() {
    if (bannerEl) return;
    bannerEl = document.createElement('div');
    bannerEl.id = 'webtrim-banner';
    bannerEl.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'right:0',
      'z-index:2147483647',
      'background:#e74c3c',
      'color:#fff',
      'padding:9px 16px',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'font-size:13px',
      'font-weight:500',
      'letter-spacing:0.01em',
      'box-shadow:0 2px 10px rgba(0,0,0,0.25)',
      'pointer-events:none',
      'user-select:none',
      'display:flex',
      'align-items:center',
    ].join(';');

    const msgEl = document.createElement('span');
    msgEl.id = 'webtrim-banner-msg';
    msgEl.style.cssText = 'flex:1;text-align:center';
    msgEl.textContent = '';

    const doneBtn = document.createElement('button');
    doneBtn.id = 'webtrim-done-btn';
    doneBtn.textContent = 'Done';
    doneBtn.style.cssText = [
      'pointer-events:auto',
      'background:rgba(255,255,255,0.25)',
      'border:1px solid rgba(255,255,255,0.55)',
      'color:#fff',
      'font-size:12px',
      'font-weight:700',
      'padding:3px 12px',
      'border-radius:4px',
      'cursor:pointer',
      'font-family:inherit',
      'flex-shrink:0',
    ].join(';');
    doneBtn.addEventListener('click', () => { if (pickerActive) deactivatePicker(); });

    // Left spacer keeps message visually centered
    const spacer = document.createElement('span');
    spacer.style.cssText = 'flex:0 0 52px';

    bannerEl.appendChild(spacer);
    bannerEl.appendChild(msgEl);
    bannerEl.appendChild(doneBtn);
    document.documentElement.appendChild(bannerEl);
    updatePickerBanner();
  }

  function updatePickerBanner() {
    const msgEl = document.getElementById('webtrim-banner-msg');
    if (!msgEl) return;
    msgEl.textContent = pickerHiddenCount === 0
      ? '✂ WebTrim — click anything on this page to hide it · Esc to cancel'
      : `✂ WebTrim — ${pickerHiddenCount} hidden · click more or press Esc / Done to finish`;
  }

  function showBannerError() {
    const msgEl = document.getElementById('webtrim-banner-msg');
    if (!msgEl) return;
    msgEl.textContent = 'Could not save — try again';
    // Restore to the live count message, not a stale snapshot.
    setTimeout(updatePickerBanner, 2500);
  }

  function hidePickerBanner() {
    if (bannerEl) {
      bannerEl.remove();
      bannerEl = null;
    }
  }

  // --- Element picker ---

  // Improved selector generation.
  // Priority: id → stable data-* attributes → tag+filtered-classes → nth-of-type.
  // Filters out generated class names (hashes, styled-components) that break
  // across deployments on React/Next.js/Vue apps.
  function buildSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);

    const stableAttrs = ['data-testid', 'data-qa', 'data-cy', 'data-id'];

    // Check the element itself for stable attributes first
    for (const attr of stableAttrs) {
      const val = el.getAttribute(attr);
      if (val) return `[${attr}=${JSON.stringify(val)}]`;
    }

    const parts = [];
    let node = el;

    while (node && node !== document.body) {
      if (node.id) {
        parts.unshift('#' + CSS.escape(node.id));
        break;
      }

      const tag = node.tagName.toLowerCase();

      // Stable data attribute on this ancestor → anchor here and stop walking
      let anchored = false;
      for (const attr of stableAttrs) {
        const val = node.getAttribute(attr);
        if (val) {
          parts.unshift(`${tag}[${attr}=${JSON.stringify(val)}]`);
          anchored = true;
          break;
        }
      }
      if (anchored) break;

      // Filter generated class names: hex hashes, styled-components, CSS Modules (_hash)
      const classes = [...node.classList]
        .filter(c =>
          !c.startsWith('webtrim') &&
          !/^[a-f0-9]{5,}$/i.test(c) &&
          !/^sc-[a-zA-Z]/.test(c) &&
          !/^_[a-zA-Z0-9]{4,}$/.test(c)
        )
        .slice(0, 2)
        .map(c => '.' + CSS.escape(c))
        .join('');

      if (classes) {
        parts.unshift(tag + classes);
      } else {
        // No usable classes — use nth-of-type for structural specificity
        const siblings = node.parentElement
          ? [...node.parentElement.children].filter(c => c.tagName === node.tagName)
          : [];
        // indexOf returns -1 for detached nodes; clamp to 0 so nth+1 ≥ 1.
        const nth = Math.max(siblings.indexOf(node), 0);
        parts.unshift(`${tag}:nth-of-type(${nth + 1})`);
      }

      node = node.parentElement;
    }

    return parts.join(' > ');
  }

  // Extract a human-readable label from the clicked element.
  // Stored alongside the CSS selector so the popup can show meaningful text
  // instead of raw selectors like "div.UDZeY > div.RNNXgb".
  function extractLabel(el) {
    const text = el.innerText?.trim().replace(/\s+/g, ' ');
    if (text) return text.slice(0, 60);
    const attr = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt');
    if (attr) return attr.slice(0, 60);
    return el.tagName.toLowerCase();
  }

  function onPickerMouseOver(e) {
    if (bannerEl?.contains(e.target)) return;
    e.stopPropagation();
    if (highlightEl) {
      highlightEl.style.outline = _savedOutline;
      highlightEl.style.outlineOffset = _savedOutlineOffset;
    }
    highlightEl = e.target;
    _savedOutline = highlightEl.style.outline;
    _savedOutlineOffset = highlightEl.style.outlineOffset;
    highlightEl.style.outline = '2px solid #e74c3c';
    highlightEl.style.outlineOffset = '-2px';
  }

  function onPickerClick(e) {
    // Guard against picking body, html, our style element, or the picker
    // banner itself. Clicking body produces an empty selector that breaks the stylesheet.
    if (
      e.target === document.body ||
      e.target === document.documentElement ||
      e.target === styleEl ||
      e.target === bannerEl ||
      bannerEl?.contains(e.target)
    ) return;

    e.preventDefault();
    e.stopPropagation();

    const selector = buildSelector(e.target);
    if (!selector) { showBannerError(); return; }

    const label = extractLabel(e.target);
    const clicked = e.target;

    // Do NOT hide optimistically — wait for storage confirmation so a failed
    // write never leaves a ghost element hidden with no corresponding rule.
    chrome.runtime.sendMessage(
      { action: 'addRule', domain, rule: { type: 'selector', value: selector, label } },
      (res) => {
        if (chrome.runtime.lastError || !res?.ok) {
          showBannerError();
          return;
        }
        // Only hide and count on a confirmed, non-duplicate save.
        if (!res.duplicate) {
          clicked.setAttribute('data-webtrim-hidden', '');
          pickerHiddenCount++;
          updatePickerBanner();
        }
      }
    );
  }

  function onPickerKeyDown(e) {
    if (e.key === 'Escape') deactivatePicker();
  }

  function onPickerScroll() {
    if (!highlightEl) return;
    highlightEl.style.outline = _savedOutline;
    highlightEl.style.outlineOffset = _savedOutlineOffset;
    highlightEl = null;
    _savedOutline = '';
    _savedOutlineOffset = '';
  }

  function activatePicker() {
    pickerActive = true;
    pickerHiddenCount = 0;
    document.addEventListener('mouseover', onPickerMouseOver, true);
    document.addEventListener('click', onPickerClick, true);
    document.addEventListener('keydown', onPickerKeyDown, true);
    window.addEventListener('scroll', onPickerScroll, true);
    // Target <html> not <body> — page styles can override cursor on <body>.
    document.documentElement.style.cursor = 'crosshair';
    showPickerBanner();
  }

  function deactivatePicker() {
    pickerActive = false;
    document.removeEventListener('mouseover', onPickerMouseOver, true);
    document.removeEventListener('click', onPickerClick, true);
    document.removeEventListener('keydown', onPickerKeyDown, true);
    window.removeEventListener('scroll', onPickerScroll, true);
    document.documentElement.style.cursor = '';
    if (highlightEl) {
      highlightEl.style.outline = _savedOutline;
      highlightEl.style.outlineOffset = _savedOutlineOffset;
      highlightEl = null;
      _savedOutline = '';
      _savedOutlineOffset = '';
    }
    hidePickerBanner();
  }

  // --- Pause overlay ---
  // When paused, instead of simply showing everything, mark formerly-hidden
  // elements with a red dashed outline so the user can see exactly what
  // the extension is controlling. Selector-rule elements need an explicit
  // class because they have no data attribute (CSS handles them purely).

  function applyPauseOverlay() {
    for (const rule of rules) {
      if (rule.disabled || rule.type !== 'selector') continue;
      try {
        document.querySelectorAll(rule.value).forEach(el => el.classList.add('webtrim-paused'));
      } catch (_) {}
    }
  }

  function removePauseOverlay() {
    document.querySelectorAll('.webtrim-paused').forEach(el => el.classList.remove('webtrim-paused'));
  }

  // --- Message handler ---

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.action) {
      case 'activatePicker':
        activatePicker();
        sendResponse({ ok: true });
        break;
      case 'deactivatePicker':
        if (pickerActive) deactivatePicker();
        sendResponse({ ok: true });
        break;
      case 'setPause':
        if (pauseMode === msg.value) { sendResponse({ ok: true }); break; }
        pauseMode = msg.value;
        if (pauseMode) {
          styleEl.textContent = PAUSE_OVERLAY_CSS;
          applyTextRules();
          applyPauseOverlay();
        } else {
          removePauseOverlay();
          fullApply();
        }
        sendResponse({ ok: true });
        break;
      case 'rulesUpdated':
        rules = msg.rules || [];
        fullApply();
        sendResponse({ ok: true });
        break;
      case 'getState':
        sendResponse({ pickerActive, pauseMode });
        return true;
      case 'getHiddenCount': {
        // Use a Set so elements matched by both a text rule and a selector rule
        // are counted only once.
        const hidden = new Set(document.querySelectorAll('[data-webtrim-hidden]'));
        for (const rule of rules) {
          if (rule.disabled || rule.type !== 'selector') continue;
          try { document.querySelectorAll(rule.value).forEach(el => hidden.add(el)); } catch (_) {}
        }
        sendResponse({ count: hidden.size });
        return true;
      }
    }
  });

  // --- Init ---

  // Check chrome.runtime.lastError to avoid silent failures.
  // Handle schema versioning — assign UUIDs to rules that predate fix #2.
  chrome.storage.local.get([storageKey], (result) => {
    if (chrome.runtime.lastError) return;
    const stored = result[storageKey] || {};
    rules = (stored.rules || []).map(r => ({ id: r.id || crypto.randomUUID(), ...r }));
    rebuildCSS();   // Inject selector CSS rules immediately — no body needed
    if (document.body) {
      applyTextRules();
    } else {
      document.addEventListener('DOMContentLoaded', applyTextRules);
    }
    startObserver(); // Start after initial apply so first scan doesn't re-trigger itself.
  });

})();
