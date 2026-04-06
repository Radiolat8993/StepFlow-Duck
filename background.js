// background.js — Service Worker: orchestration, state, tab management, message routing

importScripts('data/names.js');

const LOG_PREFIX = '[MultiPage:bg]';

// ============================================================
// State Management (chrome.storage.session)
// ============================================================

const DEFAULT_STATE = {
  currentStep: 0,
  stepStatuses: {
    1: 'pending', 2: 'pending', 3: 'pending', 4: 'pending', 5: 'pending',
    6: 'pending', 7: 'pending', 8: 'pending', 9: 'pending',
  },
  oauthUrl: null,
  email: null,
  password: null,
  accounts: [], // { email, password, createdAt }
  lastEmailTimestamp: null,
  localhostUrl: null,
  flowStartTime: null,
  incognitoWindowId: null,
  tabRegistry: {},
  logs: [],
  vpsUrl: '',
  mailProvider: '163', // 'qq' or '163'
};

async function getState() {
  const state = await chrome.storage.session.get(null);
  return { ...DEFAULT_STATE, ...state };
}

async function setState(updates) {
  console.log(LOG_PREFIX, 'storage.set:', JSON.stringify(updates).slice(0, 200));
  await chrome.storage.session.set(updates);
}

async function resetState() {
  console.log(LOG_PREFIX, 'Resetting all state');
  // Close incognito window if still open
  await closeIncognitoWindow();
  // Preserve settings and persistent data across resets
  const prev = await chrome.storage.session.get(['seenCodes', 'tabRegistry', 'vpsUrl', 'mailProvider']);
  await chrome.storage.session.clear();
  await chrome.storage.session.set({
    ...DEFAULT_STATE,
    seenCodes: prev.seenCodes || [],
    accounts: [], // accounts now live in chrome.storage.local
    tabRegistry: prev.tabRegistry || {},
    vpsUrl: prev.vpsUrl || '',
    mailProvider: prev.mailProvider || '163',
  });
}

// ============================================================
// Persistent Accounts (chrome.storage.local)
// ============================================================

async function getAccounts() {
  const data = await chrome.storage.local.get('accounts');
  return data.accounts || [];
}

async function saveAccount(account) {
  const accounts = await getAccounts();
  accounts.push(account);
  await chrome.storage.local.set({ accounts });
  // Broadcast to side panel
  chrome.runtime.sendMessage({
    type: 'ACCOUNT_ADDED',
    payload: account,
  }).catch(() => {});
  return accounts;
}

async function deleteAccount(index) {
  const accounts = await getAccounts();
  if (index >= 0 && index < accounts.length) {
    accounts.splice(index, 1);
    await chrome.storage.local.set({ accounts });
  }
  return accounts;
}

async function clearAccounts() {
  await chrome.storage.local.set({ accounts: [] });
}

/**
 * Generate a random password: 14 chars, mix of uppercase, lowercase, digits, symbols.
 */
function generatePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%&*?';
  const all = upper + lower + digits + symbols;

  // Ensure at least one of each type
  let pw = '';
  pw += upper[Math.floor(Math.random() * upper.length)];
  pw += lower[Math.floor(Math.random() * lower.length)];
  pw += digits[Math.floor(Math.random() * digits.length)];
  pw += symbols[Math.floor(Math.random() * symbols.length)];

  // Fill remaining 10 chars
  for (let i = 0; i < 10; i++) {
    pw += all[Math.floor(Math.random() * all.length)];
  }

  // Shuffle
  return pw.split('').sort(() => Math.random() - 0.5).join('');
}

// ============================================================
// Tab Registry
// ============================================================

async function getTabRegistry() {
  const state = await getState();
  return state.tabRegistry || {};
}

async function registerTab(source, tabId) {
  const registry = await getTabRegistry();
  registry[source] = { tabId, ready: true };
  await setState({ tabRegistry: registry });
  console.log(LOG_PREFIX, `Tab registered: ${source} -> ${tabId}`);
}

async function isTabAlive(source) {
  const registry = await getTabRegistry();
  const entry = registry[source];
  if (!entry) return false;
  try {
    await chrome.tabs.get(entry.tabId);
    return true;
  } catch {
    // Tab no longer exists — clean up registry
    registry[source] = null;
    await setState({ tabRegistry: registry });
    return false;
  }
}

async function getTabId(source) {
  const registry = await getTabRegistry();
  return registry[source]?.tabId || null;
}

/**
 * Activate a tab AND focus its parent window to the foreground.
 */
async function focusTab(tabId) {
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (tab.windowId) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
}

// ============================================================
// Command Queue (for content scripts not yet ready)
// ============================================================

const pendingCommands = new Map(); // source -> { message, resolve, reject, timer }

function queueCommand(source, message, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(source);
      const err = `Content script on ${source} did not respond in ${timeout / 1000}s. Try refreshing the tab and retry.`;
      console.error(LOG_PREFIX, err);
      reject(new Error(err));
    }, timeout);
    pendingCommands.set(source, { message, resolve, reject, timer });
    console.log(LOG_PREFIX, `Command queued for ${source} (waiting for ready)`);
  });
}

function flushCommand(source, tabId) {
  const pending = pendingCommands.get(source);
  if (pending) {
    clearTimeout(pending.timer);
    pendingCommands.delete(source);
    chrome.tabs.sendMessage(tabId, pending.message).then(pending.resolve).catch(pending.reject);
    console.log(LOG_PREFIX, `Flushed queued command to ${source} (tab ${tabId})`);
  }
}

// ============================================================
// Wait for content script READY signal (used after page navigation)
// ============================================================

const readyWaiters = new Map(); // source -> { resolve, timer }

function waitForContentScriptReady(source, timeoutMs = 20000) {
  // If already ready, resolve immediately
  return new Promise(async (resolve, reject) => {
    const registry = await getTabRegistry();
    if (registry[source]?.ready) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      readyWaiters.delete(source);
      reject(new Error(`Content script on ${source} did not become ready within ${timeoutMs / 1000}s`));
    }, timeoutMs);

    readyWaiters.set(source, {
      resolve: () => { clearTimeout(timer); readyWaiters.delete(source); resolve(); },
    });
  });
}

function notifyContentScriptReady(source) {
  const waiter = readyWaiters.get(source);
  if (waiter) waiter.resolve();
}

// ============================================================
// Reuse or create tab
// ============================================================

async function reuseOrCreateTab(source, url, options = {}) {
  const alive = await isTabAlive(source);
  if (alive) {
    const tabId = await getTabId(source);

    // Mark as not ready BEFORE navigating — so READY signal from new page is captured correctly
    const registry = await getTabRegistry();
    if (registry[source]) registry[source].ready = false;
    await setState({ tabRegistry: registry });

    // Navigate existing tab to new URL
    await chrome.tabs.update(tabId, { url, active: true });
    console.log(LOG_PREFIX, `Reused tab ${source} (${tabId}), navigated to ${url.slice(0, 60)}`);

    // Wait for page load complete (with 30s timeout)
    await new Promise((resolve) => {
      const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
      const listener = (tid, info) => {
        if (tid === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });

    // If dynamic injection needed (VPS panel), re-inject after navigation
    if (options.inject) {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: options.inject,
      });
    }

    // Wait a bit for content script to inject and send READY
    await new Promise(r => setTimeout(r, 500));

    return tabId;
  }

  // Create new tab
  const tab = await chrome.tabs.create({ url, active: true });
  console.log(LOG_PREFIX, `Created new tab ${source} (${tab.id})`);

  // If dynamic injection needed (VPS panel), inject scripts after load
  if (options.inject) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: options.inject,
    });
  }

  return tab.id;
}

// ============================================================
// Incognito Window Management
// ============================================================

async function createIncognitoTab(source, url) {
  // Check if extension is allowed in incognito mode
  const allowed = await chrome.extension.isAllowedIncognitoAccess();
  if (!allowed) {
    throw new Error('Extension not allowed in incognito mode. Please enable it in chrome://extensions → Details → "Allow in Incognito".');
  }

  // Close existing incognito window if any
  await closeIncognitoWindow();

  // Create new incognito window
  const win = await chrome.windows.create({ url, incognito: true });
  const tab = win.tabs[0];

  await setState({ incognitoWindowId: win.id });

  // Register the tab under the given source
  const registry = await getTabRegistry();
  registry[source] = { tabId: tab.id, ready: false };
  await setState({ tabRegistry: registry });

  console.log(LOG_PREFIX, `Created incognito window ${win.id}, tab ${source} (${tab.id})`);

  // Wait for page load
  await new Promise((resolve) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
    const listener = (tabId, info) => {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });

  await new Promise(r => setTimeout(r, 500));
  return tab.id;
}

async function closeIncognitoWindow() {
  const state = await getState();
  if (state.incognitoWindowId) {
    try {
      await chrome.windows.remove(state.incognitoWindowId);
      console.log(LOG_PREFIX, `Closed incognito window ${state.incognitoWindowId}`);
    } catch {
      // Window already closed — ignore
    }
    await setState({ incognitoWindowId: null });
  }
}

/**
 * Close all tabs in the tab registry (except mail tabs which preserve login session).
 * @param {Object} options
 * @param {boolean} options.keepMail - If true, keep mail tabs open (default false)
 */
async function closeAllRegisteredTabs(options = {}) {
  const { keepMail = false } = options;
  const registry = await getTabRegistry();
  for (const [source, entry] of Object.entries(registry)) {
    if (!entry || !entry.tabId) continue;
    if (keepMail && (source === 'mail-163' || source === 'qq-mail')) continue;
    try {
      await chrome.tabs.remove(entry.tabId);
      console.log(LOG_PREFIX, `Closed tab: ${source} (${entry.tabId})`);
    } catch {
      // Tab already closed
    }
  }
  // Clear registry (keep mail entries if requested)
  if (keepMail) {
    const mailSources = ['mail-163', 'qq-mail'];
    const newRegistry = {};
    for (const src of mailSources) {
      if (registry[src]) newRegistry[src] = registry[src];
    }
    await setState({ tabRegistry: newRegistry });
  } else {
    await setState({ tabRegistry: {} });
  }
}

/**
 * Activate a tab and bring its window to the foreground.
 */
async function focusTab(tabId) {
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (tab.windowId) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
}

// ============================================================
// Send command to content script (with readiness check)
// ============================================================

async function sendToContentScript(source, message) {
  const registry = await getTabRegistry();
  const entry = registry[source];

  if (!entry || !entry.ready) {
    console.log(LOG_PREFIX, `${source} not ready, queuing command`);
    return queueCommand(source, message);
  }

  // Verify tab is still alive
  const alive = await isTabAlive(source);
  if (!alive) {
    // Tab was closed — queue the command, it will be sent when tab is reopened
    console.log(LOG_PREFIX, `${source} tab was closed, queuing command`);
    return queueCommand(source, message);
  }

  console.log(LOG_PREFIX, `Sending to ${source} (tab ${entry.tabId}):`, message.type);
  return chrome.tabs.sendMessage(entry.tabId, message);
}

// ============================================================
// Logging
// ============================================================

async function addLog(message, level = 'info') {
  const state = await getState();
  const logs = state.logs || [];
  const entry = { message, level, timestamp: Date.now() };
  logs.push(entry);
  // Keep last 500 logs
  if (logs.length > 500) logs.splice(0, logs.length - 500);
  await setState({ logs });
  // Broadcast to side panel
  chrome.runtime.sendMessage({ type: 'LOG_ENTRY', payload: entry }).catch(() => {});
}

// ============================================================
// Step Status Management
// ============================================================

async function setStepStatus(step, status) {
  const state = await getState();
  const statuses = { ...state.stepStatuses };
  statuses[step] = status;
  await setState({ stepStatuses: statuses, currentStep: step });
  // Broadcast to side panel
  chrome.runtime.sendMessage({
    type: 'STEP_STATUS_CHANGED',
    payload: { step, status },
  }).catch(() => {});
}

// ============================================================
// Message Handler (central router)
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log(LOG_PREFIX, `Received: ${message.type} from ${message.source || 'sidepanel'}`, message);

  handleMessage(message, sender).then(response => {
    sendResponse(response);
  }).catch(err => {
    console.error(LOG_PREFIX, 'Handler error:', err);
    sendResponse({ error: err.message });
  });

  return true; // async response
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'CONTENT_SCRIPT_READY': {
      const tabId = sender.tab?.id;
      if (tabId && message.source) {
        await registerTab(message.source, tabId);
        flushCommand(message.source, tabId);
        notifyContentScriptReady(message.source);
        await addLog(`Content script ready: ${message.source} (tab ${tabId})`);
      }
      return { ok: true };
    }

    case 'LOG': {
      const { message: msg, level } = message.payload;
      await addLog(`[${message.source}] ${msg}`, level);
      return { ok: true };
    }

    case 'STEP_COMPLETE': {
      await setStepStatus(message.step, 'completed');
      await addLog(`Step ${message.step} completed`, 'ok');
      await handleStepData(message.step, message.payload);
      notifyStepComplete(message.step, message.payload);
      return { ok: true };
    }

    case 'STEP_ERROR': {
      await setStepStatus(message.step, 'failed');
      await addLog(`Step ${message.step} failed: ${message.error}`, 'error');
      notifyStepError(message.step, message.error);
      return { ok: true };
    }

    case 'GET_STATE': {
      return await getState();
    }

    case 'RESET': {
      await resetState();
      await addLog('Flow reset', 'info');
      return { ok: true };
    }

    case 'EXECUTE_STEP': {
      const step = message.payload.step;
      // Save email if provided (from side panel step 3)
      if (message.payload.email) {
        await setState({ email: message.payload.email });
      }
      await executeStep(step);
      return { ok: true };
    }

    case 'AUTO_RUN': {
      const totalRuns = message.payload?.totalRuns || 1;
      autoRunLoop(totalRuns);  // fire-and-forget
      return { ok: true };
    }

    case 'RESUME_AUTO_RUN': {
      if (message.payload.email) {
        await setState({ email: message.payload.email });
      }
      resumeAutoRun();  // fire-and-forget
      return { ok: true };
    }

    case 'SAVE_SETTING': {
      const updates = {};
      if (message.payload.vpsUrl !== undefined) updates.vpsUrl = message.payload.vpsUrl;
      if (message.payload.mailProvider !== undefined) updates.mailProvider = message.payload.mailProvider;
      await setState(updates);
      return { ok: true };
    }

    // Side panel data updates
    case 'SAVE_EMAIL': {
      await setState({ email: message.payload.email });
      return { ok: true };
    }

    case 'GET_ACCOUNTS': {
      return { accounts: await getAccounts() };
    }

    case 'DELETE_ACCOUNT': {
      const accounts = await deleteAccount(message.payload.index);
      return { ok: true, accounts };
    }

    case 'CLEAR_ACCOUNTS': {
      await clearAccounts();
      return { ok: true };
    }

    case 'AUTO_RUN_ACTION': {
      handleFailureAction(message.payload.action);
      return { ok: true };
    }

    default:
      console.warn(LOG_PREFIX, `Unknown message type: ${message.type}`);
      return { error: `Unknown message type: ${message.type}` };
  }
}

// ============================================================
// Step Data Handlers
// ============================================================

async function handleStepData(step, payload) {
  switch (step) {
    case 1:
      if (payload.oauthUrl) {
        await setState({ oauthUrl: payload.oauthUrl });
        // Broadcast OAuth URL to side panel
        chrome.runtime.sendMessage({
          type: 'DATA_UPDATED',
          payload: { oauthUrl: payload.oauthUrl },
        }).catch(() => {});
      }
      break;
    case 3:
      if (payload.email) await setState({ email: payload.email });
      break;
    case 4:
      if (payload.emailTimestamp) await setState({ lastEmailTimestamp: payload.emailTimestamp });
      break;
    case 8:
      if (payload.localhostUrl) {
        await setState({ localhostUrl: payload.localhostUrl });
        chrome.runtime.sendMessage({
          type: 'DATA_UPDATED',
          payload: { localhostUrl: payload.localhostUrl },
        }).catch(() => {});
      }
      break;
  }
}

// ============================================================
// Step Completion Waiting
// ============================================================

// Map of step -> { resolve, reject } for waiting on step completion
const stepWaiters = new Map();

function waitForStepComplete(step, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stepWaiters.delete(step);
      reject(new Error(`Step ${step} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    stepWaiters.set(step, {
      resolve: (data) => { clearTimeout(timer); stepWaiters.delete(step); resolve(data); },
      reject: (err) => { clearTimeout(timer); stepWaiters.delete(step); reject(err); },
    });
  });
}

function notifyStepComplete(step, payload) {
  const waiter = stepWaiters.get(step);
  if (waiter) waiter.resolve(payload);
}

function notifyStepError(step, error) {
  const waiter = stepWaiters.get(step);
  if (waiter) waiter.reject(new Error(error));
}

// ============================================================
// Step Execution
// ============================================================

async function executeStep(step) {
  console.log(LOG_PREFIX, `Executing step ${step}`);
  await setStepStatus(step, 'running');
  await addLog(`Step ${step} started`);

  const state = await getState();

  // Set flow start time on first step
  if (step === 1 && !state.flowStartTime) {
    await setState({ flowStartTime: Date.now() });
  }

  try {
    switch (step) {
      case 1: await executeStep1(state); break;
      case 2: await executeStep2(state); break;
      case 3: await executeStep3(state); break;
      case 4: await executeStep4(state); break;
      case 5: await executeStep5(state); break;
      case 6: await executeStep6(state); break;
      case 7: await executeStep7(state); break;
      case 8: await executeStep8(state); break;
      case 9: await executeStep9(state); break;
      default:
        throw new Error(`Unknown step: ${step}`);
    }
  } catch (err) {
    await setStepStatus(step, 'failed');
    await addLog(`Step ${step} failed: ${err.message}`, 'error');
  }
}

/**
 * Execute a step and wait for it to complete before returning.
 * @param {number} step
 * @param {number} delayAfter - ms to wait after completion (for page transitions)
 */
async function executeStepAndWait(step, delayAfter = 2000) {
  const promise = waitForStepComplete(step, 120000);
  await executeStep(step);
  await promise;
  // Extra delay for page transitions / DOM updates
  if (delayAfter > 0) {
    await new Promise(r => setTimeout(r, delayAfter));
  }
}

// ============================================================
// Auto Run Flow
// ============================================================

let autoRunActive = false;
let autoRunCurrentRun = 0;
let autoRunTotalRuns = 1;

// Outer loop: runs the full flow N times
async function autoRunLoop(totalRuns) {
  if (autoRunActive) {
    await addLog('Auto run already in progress', 'warn');
    return;
  }

  autoRunActive = true;
  autoRunTotalRuns = totalRuns;
  await setState({ autoRunning: true });

  for (let run = 1; run <= totalRuns; run++) {
    autoRunCurrentRun = run;

    // Close all tabs from previous run (keep mail tab to preserve login session)
    await closeAllRegisteredTabs({ keepMail: true });

    // Reset everything at the start of each run (keep VPS/mail settings)
    const prevState = await getState();
    const keepSettings = {
      vpsUrl: prevState.vpsUrl,
      mailProvider: prevState.mailProvider,
      autoRunning: true,
    };
    await resetState();
    await setState(keepSettings);
    // Tell side panel to reset all UI
    chrome.runtime.sendMessage({ type: 'AUTO_RUN_RESET' }).catch(() => {});
    await new Promise(r => setTimeout(r, 500));

    await addLog(`=== Auto Run ${run}/${totalRuns} — Phase 1: Get OAuth link & open signup ===`, 'info');
    const status = (phase) => ({ type: 'AUTO_RUN_STATUS', payload: { phase, currentRun: run, totalRuns } });

    chrome.runtime.sendMessage(status('running')).catch(() => {});

    const steps = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    let stopped = false;

    for (const step of steps) {
      if (step === 3) {
        await addLog(`=== Run ${run}/${totalRuns} — Phase 2: Register, verify, login, complete ===`, 'info');
        chrome.runtime.sendMessage(status('running')).catch(() => {});
      }

      let stepDone = false;
      while (!stepDone) {
        try {
          await executeStepAndWait(step, 2500);
          stepDone = true;
        } catch (err) {
          await addLog(`Run ${run}/${totalRuns} Step ${step} failed: ${err.message}`, 'error');

          // Pause and wait for user action (5 min timeout -> auto stop)
          const action = await waitForFailureAction(step, err.message);

          if (action === 'retry') {
            await addLog(`Step ${step}: User chose to retry`, 'info');
            chrome.runtime.sendMessage(status('running')).catch(() => {});
            // loop continues, retry the step
          } else if (action === 'skip') {
            await addLog(`Step ${step}: User chose to skip`, 'warn');
            await setStepStatus(step, 'completed');
            chrome.runtime.sendMessage(status('running')).catch(() => {});
            stepDone = true;
          } else {
            // 'stop' or timeout
            await addLog(`Auto run stopped by user (or timeout)`, 'warn');
            chrome.runtime.sendMessage(status('stopped')).catch(() => {});
            stopped = true;
            stepDone = true;
          }
        }
      }

      if (stopped) break;
    }

    if (stopped) break;
    await addLog(`=== Run ${run}/${totalRuns} COMPLETE! ===`, 'ok');
  }

  const completedRuns = autoRunCurrentRun;
  if (completedRuns >= autoRunTotalRuns) {
    await addLog(`=== All ${autoRunTotalRuns} runs completed successfully ===`, 'ok');
  } else {
    await addLog(`=== Stopped after ${completedRuns}/${autoRunTotalRuns} runs ===`, 'warn');
  }
  chrome.runtime.sendMessage({ type: 'AUTO_RUN_STATUS', payload: { phase: 'complete', currentRun: completedRuns, totalRuns: autoRunTotalRuns } }).catch(() => {});
  autoRunActive = false;
  await setState({ autoRunning: false });
}

// Promise-based pause/resume mechanism
let resumeResolver = null;

function waitForResume() {
  return new Promise((resolve) => {
    resumeResolver = resolve;
  });
}

async function resumeAutoRun() {
  const state = await getState();
  if (!state.email) {
    await addLog('Cannot resume: no email address. Paste email in Side Panel first.', 'error');
    return;
  }
  if (resumeResolver) {
    resumeResolver();
    resumeResolver = null;
  }
}

// Promise-based failure intervention mechanism
let failureActionResolver = null;

function waitForFailureAction(step, errorMsg, timeoutMs = 300000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      failureActionResolver = null;
      resolve('stop');
    }, timeoutMs);

    failureActionResolver = (action) => {
      clearTimeout(timer);
      failureActionResolver = null;
      resolve(action);
    };

    // Notify side panel to show intervention UI
    chrome.runtime.sendMessage({
      type: 'AUTO_RUN_PAUSED',
      payload: { step, error: errorMsg, timeoutMs },
    }).catch(() => {});
  });
}

function handleFailureAction(action) {
  if (failureActionResolver) {
    failureActionResolver(action);
  }
}

// ============================================================
// Step 1: Get OAuth Link (via vps-panel.js)
// ============================================================

async function executeStep1(state) {
  if (!state.vpsUrl) {
    throw new Error('No VPS URL configured. Enter VPS address in Side Panel first.');
  }
  await addLog(`Step 1: Opening VPS panel...`);
  await reuseOrCreateTab('vps-panel', state.vpsUrl, { inject: ['content/utils.js', 'content/vps-panel.js'] });

  await sendToContentScript('vps-panel', {
    type: 'EXECUTE_STEP',
    step: 1,
    source: 'background',
    payload: {},
  });
}

// ============================================================
// Step 2: Open Signup Page (Background opens tab, signup-page.js clicks Register)
// ============================================================

async function executeStep2(state) {
  if (!state.oauthUrl) {
    throw new Error('No OAuth URL. Complete step 1 first.');
  }
  await addLog(`Step 2: Opening auth URL...`);
  await reuseOrCreateTab('signup-page', state.oauthUrl);

  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 2,
    source: 'background',
    payload: {},
  });
}

// ============================================================
// Duck Email Auto-Generation
// ============================================================

async function generateDuckEmailAddress() {
  const DDG_URL = 'https://duckduckgo.com/email/settings/autofill';

  await addLog('Step 3: Opening DuckDuckGo Email Protection page...');
  await reuseOrCreateTab('duck-email', DDG_URL);

  // Wait for content script to be ready (critical for 2nd+ run after tab was closed)
  await addLog('Step 3: Waiting for DDG page to load...');
  await waitForContentScriptReady('duck-email', 20000);

  // Send generate command and wait for response
  const result = await sendToContentScript('duck-email', {
    type: 'GENERATE_DUCK_EMAIL',
    source: 'background',
    payload: {},
  });

  if (result && result.error) {
    throw new Error(result.error);
  }

  if (!result || !result.email) {
    throw new Error('No email returned from DDG page');
  }

  // Close DDG tab — no longer needed after getting the address
  const duckTabId = await getTabId('duck-email');
  if (duckTabId) {
    try {
      await chrome.tabs.remove(duckTabId);
      const registry = await getTabRegistry();
      registry['duck-email'] = null;
      await setState({ tabRegistry: registry });
      await addLog('Step 3: Closed DDG settings tab');
    } catch (_) { /* tab may already be closed */ }
  }

  return result.email;
}

// ============================================================
// Step 3: Fill Email & Password (via signup-page.js)
// ============================================================

async function executeStep3(state) {
  // Phase 1: Auto-generate duck email
  let email = state.email; // may already be set if user pasted manually

  if (!email) {
    try {
      email = await generateDuckEmailAddress();
      await setState({ email });
      // Update side panel email field
      chrome.runtime.sendMessage({
        type: 'DATA_UPDATED',
        payload: { email },
      }).catch(() => {});
      await addLog(`Step 3: Auto-generated duck email: ${email}`, 'ok');
    } catch (err) {
      await addLog(`Step 3: Duck email auto-generation failed: ${err.message}. Falling back to manual mode.`, 'warn');
      // Notify side panel to show pause bar
      chrome.runtime.sendMessage({
        type: 'AUTO_RUN_STATUS',
        payload: { phase: 'waiting_email', fallback: true },
      }).catch(() => {});
      // Wait for manual email input
      await waitForResume();
      const refreshedState = await getState();
      email = refreshedState.email;
      if (!email) {
        throw new Error('No email address. Paste email in Side Panel first.');
      }
    }
  }

  // Phase 2: Fill signup form
  const password = generatePassword();
  await setState({ password });

  await saveAccount({ email, password, createdAt: new Date().toISOString() });

  await addLog(`Step 3: Filling email ${email}, password generated (${password.length} chars)`);
  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 3,
    source: 'background',
    payload: { email, password },
  });
}

// ============================================================
// Step 4: Get Signup Verification Code (qq-mail.js polls, then fills in signup-page.js)
// ============================================================

function getMailConfig(state) {
  const provider = state.mailProvider || 'qq';
  if (provider === '163') {
    return { source: 'mail-163', url: 'https://mail.163.com/js6/main.jsp?df=mail163_letter#module=mbox.ListModule%7C%7B%22fid%22%3A1%2C%22order%22%3A%22date%22%2C%22desc%22%3Atrue%7D', label: '163 Mail' };
  }
  return { source: 'qq-mail', url: 'https://wx.mail.qq.com/', label: 'QQ Mail' };
}

async function executeStep4(state) {
  const mail = getMailConfig(state);
  await addLog(`Step 4: Opening ${mail.label}...`);

  // For mail tabs, only create if not alive — don't navigate (preserves login session)
  const alive = await isTabAlive(mail.source);
  if (alive) {
    const tabId = await getTabId(mail.source);
    await focusTab(tabId);
  } else {
    await reuseOrCreateTab(mail.source, mail.url);
  }

  const result = await sendToContentScript(mail.source, {
    type: 'POLL_EMAIL',
    step: 4,
    source: 'background',
    payload: {
      filterAfterTimestamp: state.flowStartTime || 0,
      senderFilters: ['openai', 'noreply', 'verify', 'auth'],
      subjectFilters: ['verify', 'verification', 'code', '验证', 'confirm'],
      maxAttempts: 20,
      intervalMs: 3000,
    },
  });

  if (result && result.error) {
    throw new Error(result.error);
  }

  if (result && result.code) {
    await setState({ lastEmailTimestamp: result.emailTimestamp });
    await addLog(`Step 4: Got verification code: ${result.code}`);

    // Switch to signup tab and fill code
    const signupTabId = await getTabId('signup-page');
    if (signupTabId) {
      await focusTab(signupTabId);
      await sendToContentScript('signup-page', {
        type: 'FILL_CODE',
        step: 4,
        source: 'background',
        payload: { code: result.code },
      });
    } else {
      throw new Error('Signup page tab was closed. Cannot fill verification code.');
    }
  }
}

// ============================================================
// Step 5: Fill Name & Birthday (via signup-page.js)
// ============================================================

async function executeStep5(state) {
  const { firstName, lastName } = generateRandomName();
  const { year, month, day } = generateRandomBirthday();

  await addLog(`Step 5: Generated name: ${firstName} ${lastName}, Birthday: ${year}-${month}-${day}`);

  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 5,
    source: 'background',
    payload: { firstName, lastName, year, month, day },
  });
}

// ============================================================
// Step 6: Login ChatGPT (Background opens tab, chatgpt.js handles login)
// ============================================================

async function executeStep6(state) {
  if (!state.oauthUrl) {
    throw new Error('No OAuth URL. Complete step 1 first.');
  }
  if (!state.email) {
    throw new Error('No email. Complete step 3 first.');
  }

  await addLog(`Step 6: Opening OAuth URL in incognito window for login...`);
  // Close old signup-page tab (registration is done) and open incognito for login
  const oldSignupTabId = await getTabId('signup-page');
  if (oldSignupTabId) {
    try { await chrome.tabs.remove(oldSignupTabId); } catch {}
  }
  await createIncognitoTab('signup-page', state.oauthUrl);

  // Phase 1: fill email and submit
  // After email submit, the page may do a full navigation to a password page,
  // which kills the content script before sendResponse fires. Use a timeout race.
  try {
    await Promise.race([
      sendToContentScript('signup-page', {
        type: 'EXECUTE_STEP',
        step: 6,
        source: 'background',
        payload: { email: state.email, password: state.password },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('phase1_timeout')), 30000)),
    ]);
  } catch {
    // Content script died during page navigation — expected for two-page login flow
    await addLog('Step 6: Page navigated after email submit, waiting for password page...');
  }

  // Check if step 6 was already completed (email + password on same page)
  const stepState = await getState();
  if (stepState.stepStatuses?.[6] === 'completed') {
    return; // All done in one page
  }

  // Phase 2: password page — wait for new content script to be ready, then fill password
  await addLog('Step 6: Waiting for password page to load...');
  // Wait for the new content script on the password page to send READY
  await waitForContentScriptReady('signup-page', 20000);

  // Send password fill command. After the content script fills the password and
  // clicks submit, the page navigates to the OTP page — which kills the content
  // script before sendResponse can fire. Use a timeout race so we don't hang.
  // The actual completion signal is reportComplete(6) from the content script,
  // which fires BEFORE the submit click.
  try {
    await Promise.race([
      sendToContentScript('signup-page', {
        type: 'EXECUTE_STEP',
        step: 6,
        source: 'background',
        payload: { email: state.email, password: state.password, phase: 'password' },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('phase2_timeout')), 30000)),
    ]);
  } catch {
    // Expected: content script dies after password submit (page navigates to OTP).
    // reportComplete(6) was already sent before the submit click, so step 6 is done.
    const st = await getState();
    if (st.stepStatuses?.[6] === 'completed') {
      await addLog('Step 6: Password submitted, page navigated to verification code page.');
    } else {
      throw new Error('Step 6 password phase failed: no completion signal received.');
    }
  }
}

// ============================================================
// Step 7: Get Login Verification Code (qq-mail.js polls, then fills in chatgpt.js)
// ============================================================

async function executeStep7(state) {
  const mail = getMailConfig(state);
  await addLog(`Step 7: Opening ${mail.label}...`);

  const alive = await isTabAlive(mail.source);
  if (alive) {
    const tabId = await getTabId(mail.source);
    await focusTab(tabId);
  } else {
    await reuseOrCreateTab(mail.source, mail.url);
  }

  const result = await sendToContentScript(mail.source, {
    type: 'POLL_EMAIL',
    step: 7,
    source: 'background',
    payload: {
      filterAfterTimestamp: state.lastEmailTimestamp || state.flowStartTime || 0,
      senderFilters: ['openai', 'noreply', 'verify', 'auth', 'chatgpt'],
      subjectFilters: ['verify', 'verification', 'code', '验证', 'confirm', 'login'],
      maxAttempts: 20,
      intervalMs: 3000,
    },
  });

  if (result && result.error) {
    throw new Error(result.error);
  }

  if (result && result.code) {
    await addLog(`Step 7: Got login verification code: ${result.code}`);

    // Switch to signup/auth tab in incognito and bring it to front
    const signupTabId = await getTabId('signup-page');
    if (signupTabId) {
      await focusTab(signupTabId);
      await sendToContentScript('signup-page', {
        type: 'FILL_CODE',
        step: 7,
        source: 'background',
        payload: { code: result.code },
      });
    } else {
      throw new Error('Auth page tab was closed. Cannot fill verification code.');
    }
  }
}

// ============================================================
// Step 8: Complete OAuth (webNavigation listener + chatgpt.js navigates)
// ============================================================

let webNavListener = null;
const MAX_PHONE_PAGE_RETRIES = 3;

async function executeStep8(state) {
  if (!state.oauthUrl) {
    throw new Error('No OAuth URL. Complete step 1 first.');
  }

  await addLog('Step 8: Setting up localhost redirect listener...');

  // Register webNavigation listener (scoped to this step)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (webNavListener) {
        chrome.webNavigation.onBeforeNavigate.removeListener(webNavListener);
        webNavListener = null;
      }
      setStepStatus(8, 'failed');
      addLog('Step 8: Localhost redirect not captured after 120s. Check if OAuth authorization completed.', 'error');
      reject(new Error('Localhost redirect not captured after 120s. Check if OAuth authorization completed.'));
    }, 120000);

    webNavListener = (details) => {
      if (details.url.startsWith('http://localhost')) {
        console.log(LOG_PREFIX, `Captured localhost redirect: ${details.url}`);
        chrome.webNavigation.onBeforeNavigate.removeListener(webNavListener);
        webNavListener = null;
        clearTimeout(timeout);

        setState({ localhostUrl: details.url }).then(async () => {
          addLog(`Step 8: Captured localhost URL: ${details.url}`, 'ok');

          // Close incognito window — login flow is done
          await closeIncognitoWindow();
          addLog('Step 8: Incognito window closed.');

          // Bring VPS panel to front so user can see step 9
          const vpsTabId = await getTabId('vps-panel');
          if (vpsTabId && await isTabAlive('vps-panel')) {
            await focusTab(vpsTabId);
          }

          setStepStatus(8, 'completed');
          notifyStepComplete(8, { localhostUrl: details.url });
          chrome.runtime.sendMessage({
            type: 'DATA_UPDATED',
            payload: { localhostUrl: details.url },
          }).catch(() => {});
          resolve();
        });
      }
    };

    chrome.webNavigation.onBeforeNavigate.addListener(webNavListener);

    // Try clicking "继续", with retry loop for phone page detection
    (async () => {
      try {
        for (let attempt = 1; attempt <= MAX_PHONE_PAGE_RETRIES; attempt++) {
          try {
            const signupTabId = await getTabId('signup-page');
            if (signupTabId) {
              await focusTab(signupTabId);
              await addLog('Step 8: Switching to auth page, clicking "继续" to complete OAuth...');
            } else {
              await createIncognitoTab('signup-page', state.oauthUrl);
              await addLog('Step 8: Auth tab reopened in incognito...');
            }

            const step8Result = await sendToContentScript('signup-page', {
              type: 'EXECUTE_STEP',
              step: 8,
              source: 'background',
              payload: {},
            });
            // sendToContentScript returns { error: ... } instead of throwing
            if (step8Result && step8Result.error) {
              throw new Error(step8Result.error);
            }
            // If no error, step 8 content script succeeded (redirect will be captured by listener)
            return;
          } catch (err) {
            const isRetryable = err.message === 'PHONE_PAGE_DETECTED' || err.message === 'ERROR_PAGE_DETECTED';
            if (isRetryable && attempt < MAX_PHONE_PAGE_RETRIES) {
              const reason = err.message === 'PHONE_PAGE_DETECTED' ? 'Phone page' : 'Error page (invalid_state)';
              await addLog(`Step 8: ${reason} detected (attempt ${attempt}/${MAX_PHONE_PAGE_RETRIES}). Re-opening OAuth to retry login...`, 'warn');
              await new Promise(r => setTimeout(r, 2000));

              // Re-open OAuth URL in incognito to start a fresh login session
              await createIncognitoTab('signup-page', state.oauthUrl);
              await new Promise(r => setTimeout(r, 2000));

              // Re-do login (step 6) — handle two-page flow
              await addLog('Step 8: Re-logging in (step 6)...');
              try {
                await Promise.race([
                  sendToContentScript('signup-page', {
                    type: 'EXECUTE_STEP',
                    step: 6,
                    source: 'background',
                    payload: { email: state.email, password: state.password },
                  }),
                  new Promise((_, reject) => setTimeout(() => reject(new Error('phase1_timeout')), 30000)),
                ]);
              } catch {
                // Content script died during page navigation — expected
              }
              await new Promise(r => setTimeout(r, 3000));

              // Check if page navigated to a separate password page
              const retryStepState = await getState();
              if (retryStepState.stepStatuses?.[6] !== 'completed') {
                await addLog('Step 8: Waiting for password page after retry login...');
                await waitForContentScriptReady('signup-page', 20000);
                try {
                  await Promise.race([
                    sendToContentScript('signup-page', {
                      type: 'EXECUTE_STEP',
                      step: 6,
                      source: 'background',
                      payload: { email: state.email, password: state.password, phase: 'password' },
                    }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('phase2_timeout')), 30000)),
                  ]);
                } catch {
                  // Expected: page navigates after password submit
                }
                await new Promise(r => setTimeout(r, 3000));
              }

              // Re-do verification code if needed (step 7)
              await addLog('Step 8: Re-fetching login verification code (step 7)...');
              const mail = getMailConfig(state);
              const alive = await isTabAlive(mail.source);
              if (alive) {
                const mailTabId = await getTabId(mail.source);
                await focusTab(mailTabId);
              } else {
                await reuseOrCreateTab(mail.source, mail.url);
              }

              const result = await sendToContentScript(mail.source, {
                type: 'POLL_EMAIL',
                step: 7,
                source: 'background',
                payload: {
                  filterAfterTimestamp: state.lastEmailTimestamp || state.flowStartTime || 0,
                  senderFilters: ['openai', 'noreply', 'verify', 'auth', 'chatgpt'],
                  subjectFilters: ['verify', 'verification', 'code', '验证', 'confirm', 'login'],
                  maxAttempts: 10,
                  intervalMs: 3000,
                  allowSeenAfter: 5, // retry scenario: use seen code after 5 attempts
                },
              });

              if (result && result.code) {
                await addLog(`Step 8: Got retry verification code: ${result.code}`);
                const retryTabId = await getTabId('signup-page');
                if (retryTabId) {
                  await focusTab(retryTabId);
                  await sendToContentScript('signup-page', {
                    type: 'FILL_CODE',
                    step: 7,
                    source: 'background',
                    payload: { code: result.code },
                  });
                }
                await new Promise(r => setTimeout(r, 3000));
              }

              // Now retry step 8 (loop continues)
              await addLog(`Step 8: Retry attempt ${attempt + 1}...`);
              await new Promise(r => setTimeout(r, 2000));
            } else {
              throw err;
            }
          }
        }
      } catch (err) {
        clearTimeout(timeout);
        if (webNavListener) {
          chrome.webNavigation.onBeforeNavigate.removeListener(webNavListener);
          webNavListener = null;
        }
        reject(err);
      }
    })();
  });
}

// ============================================================
// Step 9: VPS Verify (via vps-panel.js)
// ============================================================

async function executeStep9(state) {
  if (!state.localhostUrl) {
    throw new Error('No localhost URL. Complete step 8 first.');
  }
  if (!state.vpsUrl) {
    throw new Error('VPS URL not set. Please enter VPS URL in the side panel.');
  }

  await addLog('Step 9: Opening VPS panel...');

  let tabId = await getTabId('vps-panel');
  const alive = tabId && await isTabAlive('vps-panel');

  if (!alive) {
    // Create new tab
    const tab = await chrome.tabs.create({ url: state.vpsUrl, active: true });
    tabId = tab.id;
    await new Promise(resolve => {
      const listener = (tid, info) => {
        if (tid === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  } else {
    await focusTab(tabId);
  }

  // Inject scripts directly and wait for them to be ready
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/utils.js', 'content/vps-panel.js'],
  });
  await new Promise(r => setTimeout(r, 1000));

  // Send command directly — bypass queue/ready mechanism
  await addLog(`Step 9: Filling callback URL...`);
  await chrome.tabs.sendMessage(tabId, {
    type: 'EXECUTE_STEP',
    step: 9,
    source: 'background',
    payload: { localhostUrl: state.localhostUrl },
  });

}

// ============================================================
// Open Side Panel on extension icon click
// ============================================================

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
