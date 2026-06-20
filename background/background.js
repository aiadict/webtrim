// WebTrim background service worker

function storageKey(domain) {
  return 'webtrim::' + domain;
}

function normalizeData(raw) {
  return {
    version: 1,
    rules: (raw.rules || [])
      .map(r => ({
        id: r.id || crypto.randomUUID(),
        type: r.type,
        value: r.value,
        label: r.label || r.value,
        disabled: r.disabled || false,
      }))
      // Drop corrupted rules (missing/wrong type, missing/empty value)
      // so they never reach the content script and cause hidden elements or CSS errors.
      .filter(r =>
        (r.type === 'selector' || r.type === 'text') &&
        typeof r.value === 'string' &&
        r.value.trim() !== ''
      ),
  };
}

// Per-domain write queue serialises all storage mutations so rapid
// multi-pick clicks never produce a lost-update (two reads before either write lands).
const queues = {};
function enqueue(domain, task) {
  if (!queues[domain]) queues[domain] = Promise.resolve();
  queues[domain] = queues[domain].then(task, () => {});
}

// CSS injection via the scripting API bypasses the page's Content Security Policy.
// Pages like GitHub, Stripe, and banking sites block <style> elements injected by
// content scripts, but chrome.scripting.insertCSS is a privileged extension operation
// that is exempt from CSP. We track the last injected CSS per tab so we can remove
// it before replacing it (the API requires the exact string to remove).
const injectedCSS = {};
async function reinjectCSS(tabId, css) {
  const prev = injectedCSS[tabId];
  if (prev) {
    try { await chrome.scripting.removeCSS({ target: { tabId }, css: prev }); } catch (_) {}
  }
  if (css) {
    try { await chrome.scripting.insertCSS({ target: { tabId }, css }); } catch (_) {}
    injectedCSS[tabId] = css;
  } else {
    delete injectedCSS[tabId];
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const { action } = msg;
  const key = storageKey(msg.domain);
  const targetTabId = sender.tab?.id ?? msg.tabId;

  if (action === 'updateCSS') {
    const tabId = sender.tab?.id;
    if (tabId) reinjectCSS(tabId, msg.css).catch(() => {});
    sendResponse({ ok: true });
    return;
  }

  if (action === 'addRule') {
    // Validate incoming rule before touching storage.
    if (
      !msg.rule?.value?.trim() ||
      !['selector', 'text'].includes(msg.rule?.type)
    ) {
      sendResponse({ ok: false });
      return;
    }

    enqueue(msg.domain, () => new Promise(resolve => {
      chrome.storage.local.get([key], (result) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false });
          resolve();
          return;
        }
        const data = normalizeData(result[key] || {});

        const isDuplicate = data.rules.some(
          r => r.type === msg.rule.type && r.value === msg.rule.value
        );
        if (!isDuplicate) {
          data.rules.push({
            id: crypto.randomUUID(),
            type: msg.rule.type,
            value: msg.rule.value,
            label: msg.rule.label || msg.rule.value,
            disabled: false,
          });
        }

        chrome.storage.local.set({ [key]: data }, () => {
          if (chrome.runtime.lastError) { sendResponse({ ok: false }); resolve(); return; }
          if (targetTabId) {
            chrome.tabs.sendMessage(targetTabId, { action: 'rulesUpdated', rules: data.rules }).catch(() => {});
          }
          // Signal duplicate so the popup can show "Already added" instead
          // of "✓ Saved permanently" — same data, different user feedback.
          sendResponse({ ok: true, duplicate: isDuplicate, rules: data.rules });
          resolve();
        });
      });
    }));
    return true;
  }

  if (action === 'getRules') {
    // Route through enqueue so a getRules that arrives while addRule writes
    // are in-flight waits for them to complete before reading — prevents stale list.
    enqueue(msg.domain, () => new Promise(resolve => {
      chrome.storage.local.get([key], (result) => {
        if (chrome.runtime.lastError) { sendResponse({ rules: [] }); resolve(); return; }
        const data = normalizeData(result[key] || {});

        const needsMigration = (result[key]?.rules || []).some(r => !r.id);
        if (needsMigration) {
          chrome.storage.local.set({ [key]: data });
        }

        sendResponse({ rules: data.rules });
        resolve();
      });
    }));
    return true;
  }

  if (action === 'deleteRule') {
    const { ruleId } = msg;
    enqueue(msg.domain, () => new Promise(resolve => {
      chrome.storage.local.get([key], (result) => {
        if (chrome.runtime.lastError) { sendResponse({ ok: false }); resolve(); return; }
        const data = normalizeData(result[key] || {});
        data.rules = data.rules.filter(r => r.id !== ruleId);
        chrome.storage.local.set({ [key]: data }, () => {
          if (chrome.runtime.lastError) { sendResponse({ ok: false }); resolve(); return; }
          if (targetTabId) {
            chrome.tabs.sendMessage(targetTabId, { action: 'rulesUpdated', rules: data.rules }).catch(() => {});
          }
          sendResponse({ ok: true, rules: data.rules });
          resolve();
        });
      });
    }));
    return true;
  }

  if (action === 'toggleRule') {
    const { ruleId } = msg;
    enqueue(msg.domain, () => new Promise(resolve => {
      chrome.storage.local.get([key], (result) => {
        if (chrome.runtime.lastError) { sendResponse({ ok: false }); resolve(); return; }
        const data = normalizeData(result[key] || {});
        const rule = data.rules.find(r => r.id === ruleId);
        if (rule) rule.disabled = !rule.disabled;
        chrome.storage.local.set({ [key]: data }, () => {
          if (chrome.runtime.lastError) { sendResponse({ ok: false }); resolve(); return; }
          if (targetTabId) {
            chrome.tabs.sendMessage(targetTabId, { action: 'rulesUpdated', rules: data.rules }).catch(() => {});
          }
          sendResponse({ ok: true, rules: data.rules });
          resolve();
        });
      });
    }));
    return true;
  }
});
