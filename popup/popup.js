'use strict';

let currentDomain = '';
let currentTabId = null;
let rules = [];
let pickerActive = false;
let pauseActive = false;
let contentScriptAvailable = true;

// Pending deletion state for the undo window.
let pendingDelete = null;

const $ = id => document.getElementById(id);

function normalizeDomain(hostname) {
  return hostname.replace(/^www\./, '');
}

// Domain-aware quick-add chips.
const DOMAIN_SUGGESTIONS = {
  'google.com':    ['AI Overview', 'Sponsored', 'People also ask', 'More results'],
  'linkedin.com':  ['Promoted', 'Suggested', 'People also viewed'],
  'youtube.com':   ['Sponsored', 'Promoted video'],
  'reddit.com':    ['Promoted', 'Sponsored'],
  'x.com':         ['Promoted', 'Suggested'],
  'twitter.com':   ['Promoted', 'Suggested'],
  'facebook.com':  ['Sponsored', 'Suggested for you'],
  'instagram.com': ['Sponsored', 'Suggested for you'],
};
const DEFAULT_SUGGESTIONS = ['Sponsored', 'Advertisement', 'Promoted'];

function getSuggestions() {
  return DOMAIN_SUGGESTIONS[currentDomain] || DEFAULT_SUGGESTIONS;
}

// --- Init ---

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return;

  try {
    currentDomain = normalizeDomain(new URL(tab.url).hostname);
    currentTabId = tab.id;
  } catch (_) {
    return;
  }

  $('domain').textContent = currentDomain;

  await loadRules();
  await syncContentScriptState();

  if (!contentScriptAvailable) {
    showUnavailableState();
  }

  renderRules();
  renderSuggestions();
  bindEvents();

  // Load hidden element count asynchronously — doesn't block UI.
  loadHiddenCount();
}

// --- Storage ---

async function loadRules() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'getRules', domain: currentDomain }, res => {
      if (chrome.runtime.lastError) { resolve(); return; }
      rules = res?.rules || [];
      resolve();
    });
  });
}

async function syncContentScriptState() {
  if (!currentTabId) return;
  try {
    const state = await chrome.tabs.sendMessage(currentTabId, { action: 'getState' });
    if (state?.pickerActive) {
      pickerActive = true;
      setPickerButtonState(true);
      startPickerSync();
    }
    if (state?.pauseMode) {
      pauseActive = true;
      setPauseButtonState(true);
    }
  } catch (_) {
    contentScriptAvailable = false;
  }
}

// Poll the content script every 500 ms while the popup shows the picker as active.
// Needed because the picker can be dismissed via the in-page banner Done/Esc while
// the popup is open — the popup has no push channel to receive that event.
let pickerSyncTimer = null;
function startPickerSync() {
  if (pickerSyncTimer) return;
  pickerSyncTimer = setInterval(async () => {
    if (!currentTabId) { stopPickerSync(); return; }
    try {
      const state = await chrome.tabs.sendMessage(currentTabId, { action: 'getState' });
      if (!state?.pickerActive) {
        pickerActive = false;
        setPickerButtonState(false);
        stopPickerSync();
      }
    } catch (_) { stopPickerSync(); }
  }, 500);
}
function stopPickerSync() {
  clearInterval(pickerSyncTimer);
  pickerSyncTimer = null;
}

// Query the content script for the number of elements
// currently hidden on the page. Shown alongside the rule count in the header.
async function loadHiddenCount() {
  if (!currentTabId || !contentScriptAvailable) return;
  try {
    const res = await chrome.tabs.sendMessage(currentTabId, { action: 'getHiddenCount' });
    const count = res?.count ?? 0;
    const el = $('hidden-count');
    if (count > 0) {
      el.textContent = `${count} hidden`;
      el.style.display = '';
    } else {
      el.style.display = 'none';
    }
  } catch (_) {}
}

function showUnavailableState() {
  $('btn-pick').disabled = true;
  $('btn-pause').disabled = true;
  // Text rules don't require an active content script — they apply on next page load.
  // Only the picker and pause controls need to be disabled.

  const notice = document.createElement('div');
  notice.className = 'unavailable-notice';
  notice.textContent = 'Element picking unavailable on this page. Text rules still work.';
  $('btn-pick').closest('.actions').insertAdjacentElement('afterend', notice);
}

// --- Render ---

function renderRules() {
  const list = $('rules-list');
  const countEl = $('rules-count');
  const pauseBtn = $('btn-pause');

  // Count badge only visible when rules exist
  countEl.style.display = rules.length > 0 ? '' : 'none';
  if (rules.length > 0) countEl.textContent = rules.length;

  // "Show Hidden" button only makes sense when there is something to reveal
  pauseBtn.style.display = rules.length > 0 ? '' : 'none';

  if (rules.length === 0) {
    // Two-card instructional empty state
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-card">
          <div class="empty-card-icon">🖱</div>
          <div class="empty-card-body">
            <div class="empty-card-title">Click to hide</div>
            <div class="empty-card-desc">Use "Pick an element to hide" above, then click any part of this page.</div>
          </div>
        </div>
        <div class="empty-card">
          <div class="empty-card-icon">abc</div>
          <div class="empty-card-body">
            <div class="empty-card-title">Hide by text</div>
            <div class="empty-card-desc">Type a word below — every element containing it disappears, on every visit.</div>
          </div>
        </div>
      </div>`;
    return;
  }

  // Display human label instead of raw CSS selector.
  //   rule.label = element text captured at pick time (or the text string for text rules)
  //   rule.value = raw CSS selector — shown in tooltip for power users
  // CSS toggle switch instead of ●/○ buttons.
  list.innerHTML = rules.map(rule => {
    const displayLabel = escapeHtml(rule.label || rule.value);
    const selectorTip  = rule.type === 'selector' ? escapeHtml(rule.value) : '';
    const isOn = !rule.disabled;
    return `
      <div class="rule-item ${rule.disabled ? 'disabled' : ''}" data-ruleid="${rule.id}">
        <span class="rule-type ${rule.type}" title="${selectorTip}">${rule.type === 'selector' ? 'click' : 'text'}</span>
        <span class="rule-value" title="${displayLabel}">${displayLabel}</span>
        <label class="rule-toggle" title="${isOn ? 'Disable rule' : 'Enable rule'}">
          <input type="checkbox" data-ruleid="${rule.id}" ${isOn ? 'checked' : ''}>
          <span class="toggle-track"></span>
        </label>
        <button class="rule-delete" data-ruleid="${rule.id}" title="Delete rule">✕</button>
      </div>`;
  }).join('');

  list.querySelectorAll('.rule-toggle input').forEach(cb => {
    cb.addEventListener('change', () => toggleRule(cb.dataset.ruleid));
  });
  list.querySelectorAll('.rule-delete').forEach(btn => {
    btn.addEventListener('click', () => deleteRule(btn.dataset.ruleid));
  });
}

// Render domain-aware chips, hiding already-added ones.
function renderSuggestions() {
  const container = $('suggestions');
  const added = new Set(
    rules.filter(r => r.type === 'text').map(r => r.value.toLowerCase())
  );
  const available = getSuggestions().filter(s => !added.has(s.toLowerCase()));

  if (available.length === 0) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML =
    '<span class="suggestions-label">Quick add</span>' +
    available.map(s => `<button class="chip" data-text="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('');

  container.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', async () => {
      await addTextRule(chip.dataset.text);
    });
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// --- Rule actions ---

// Returns true on success (including duplicates), false on storage error.
async function addTextRule(text) {
  const value = text.trim();
  if (!value) return true;
  return new Promise(resolve => {
    chrome.runtime.sendMessage(
      { action: 'addRule', domain: currentDomain, rule: { type: 'text', value }, tabId: currentTabId },
      res => {
        if (chrome.runtime.lastError || !res?.ok) {
          showErrorToast();
          resolve(false);
          return;
        }
        rules = res?.rules || rules;
        renderRules();
        renderSuggestions();
        loadHiddenCount();
        // Show "Already added" instead of "✓ Saved" for duplicates.
        showSaveToast(res.duplicate ? 'Already added' : '✓ Saved permanently');
        resolve(true);
      }
    );
  });
}

// Undo-able delete.
// The rule is visually faded immediately, but the actual storage delete is
// deferred by 5 seconds. Clicking Undo within that window cancels it.
async function deleteRule(ruleId) {
  // Commit any in-progress pending delete before starting a new one
  if (pendingDelete) {
    await commitPendingDelete();
  }

  const ruleToDelete = rules.find(r => r.id === ruleId);
  if (!ruleToDelete) return;

  // Fade the row so user sees immediate visual feedback
  const item = document.querySelector(`.rule-item[data-ruleid="${CSS.escape(ruleId)}"]`);
  if (item) item.classList.add('deleting');

  pendingDelete = {
    ruleId,
    ruleData: { ...ruleToDelete },
    timer: setTimeout(commitPendingDelete, 5000),
  };

  showUndoToast();
}

async function commitPendingDelete() {
  if (!pendingDelete) return;
  const { ruleId, timer } = pendingDelete;
  clearTimeout(timer);
  pendingDelete = null;
  hideUndoToast();

  return new Promise(resolve => {
    chrome.runtime.sendMessage(
      { action: 'deleteRule', domain: currentDomain, ruleId, tabId: currentTabId },
      res => {
        if (chrome.runtime.lastError || !res?.ok) {
          // Delete failed — restore the faded row and show error.
          showErrorToast();
          renderRules();
          resolve();
          return;
        }
        rules = res?.rules || rules;
        renderRules();
        renderSuggestions();
        loadHiddenCount();
        resolve();
      }
    );
  });
}

function undoDelete() {
  if (!pendingDelete) return;
  clearTimeout(pendingDelete.timer);
  pendingDelete = null;
  hideUndoToast();
  // Restore the visual state of the faded row
  document.querySelectorAll('.rule-item.deleting').forEach(el => el.classList.remove('deleting'));
}

function showUndoToast() {
  $('undo-toast').classList.add('visible');
}

function hideUndoToast() {
  $('undo-toast').classList.remove('visible');
}

async function toggleRule(ruleId) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(
      { action: 'toggleRule', domain: currentDomain, ruleId, tabId: currentTabId },
      res => {
        if (chrome.runtime.lastError || !res?.ok) {
          // Toggle failed — re-render from in-memory rules to reset the switch.
          showErrorToast();
          renderRules();
          resolve();
          return;
        }
        rules = res?.rules || rules;
        renderRules();
        loadHiddenCount();
        resolve();
      }
    );
  });
}

// Brief green toast after a rule is saved permanently.
let saveToastTimer = null;
function showSaveToast(message = '✓ Saved permanently') {
  const toast = $('save-toast');
  toast.querySelector('span').textContent = message;
  toast.classList.add('visible');
  clearTimeout(saveToastTimer);
  saveToastTimer = setTimeout(() => toast.classList.remove('visible'), 2000);
}

// Brief red toast when storage write fails (e.g. quota exceeded).
let errorToastTimer = null;
function showErrorToast() {
  const toast = $('error-toast');
  toast.classList.add('visible');
  clearTimeout(errorToastTimer);
  errorToastTimer = setTimeout(() => toast.classList.remove('visible'), 3000);
}

// --- Picker ---

function setPickerButtonState(active) {
  const btn   = $('btn-pick');
  const main  = $('pick-label');
  const sub   = $('pick-sub');
  if (active) {
    btn.classList.add('active');
    main.textContent = 'Picking…';
    sub.textContent  = 'Click anything · Esc to cancel';
  } else {
    btn.classList.remove('active');
    main.textContent = 'Pick an element to hide';
    sub.textContent  = 'then click it on the page';
  }
}

// Plain-language pause button labels
function setPauseButtonState(active) {
  const btn = $('btn-pause');
  btn.textContent = active ? 'Hide Again' : 'Show Hidden';
  btn.classList.toggle('active', active);
}

async function togglePicker() {
  if (pickerActive) {
    pickerActive = false;
    setPickerButtonState(false);
    stopPickerSync();
    if (currentTabId) {
      chrome.tabs.sendMessage(currentTabId, { action: 'deactivatePicker' }).catch(() => {});
    }
    return;
  }

  if (!currentTabId) return;
  try {
    // Await response to confirm content script received it.
    // Rejects on restricted pages (chrome:// , PDF, etc.).
    await chrome.tabs.sendMessage(currentTabId, { action: 'activatePicker' });
    pickerActive = true;
    window.close();
  } catch (_) {
    // Already guarded by showUnavailableState() for the known restricted-page case
  }
}

function togglePause() {
  pauseActive = !pauseActive;
  setPauseButtonState(pauseActive);
  if (currentTabId) {
    chrome.tabs.sendMessage(currentTabId, { action: 'setPause', value: pauseActive }).catch(() => {});
  }
}

// --- Events ---

function bindEvents() {
  $('btn-pick').addEventListener('click', togglePicker);
  $('btn-pause').addEventListener('click', togglePause);
  // Wire the Undo button
  $('undo-btn').addEventListener('click', undoDelete);

  const textInput = $('text-input');
  $('btn-add-text').addEventListener('click', async () => {
    const val = textInput.value;
    textInput.value = '';
    // Restore typed text if save fails so the user doesn't lose their input.
    const ok = await addTextRule(val);
    if (!ok) textInput.value = val;
  });
  textInput.addEventListener('keydown', async e => {
    if (e.key === 'Enter') {
      const val = textInput.value;
      textInput.value = '';
      const ok = await addTextRule(val);
      if (!ok) textInput.value = val;
    }
  });
}

document.addEventListener('DOMContentLoaded', init);

// When the popup closes while an undo window is open, commit the delete immediately.
// commitPendingDelete() is async and its continuation is killed by page teardown, so
// fire-and-forget directly: the message is dispatched before the page dies and the
// background service worker completes the storage write independently.
window.addEventListener('pagehide', () => {
  if (!pendingDelete) return;
  const { ruleId, timer } = pendingDelete;
  clearTimeout(timer);
  pendingDelete = null;
  chrome.runtime.sendMessage({ action: 'deleteRule', domain: currentDomain, ruleId, tabId: currentTabId });
});
