// Schedules syncs and keeps the status the popup shows. The actual work happens in offscreen.js.

const EVERY_MINUTES = 180;

async function config() {
  const { maniUrl = '', token = '', days = 60 } = await chrome.storage.local.get(['maniUrl', 'token', 'days']);
  return { maniUrl, token, days: Number(days) || 60 };
}

async function setStatus(patch) {
  const { status = {} } = await chrome.storage.local.get('status');
  await chrome.storage.local.set({ status: { ...status, ...patch } });
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  const ready = new Promise((resolve) => {
    const on = (msg) => {
      if (msg?.type === 'offscreen-ready') {
        chrome.runtime.onMessage.removeListener(on);
        resolve();
      }
    };
    chrome.runtime.onMessage.addListener(on);
  });
  await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['DOM_PARSER'], justification: 'Read Amazon order pages' });
  await Promise.race([ready, new Promise((r) => setTimeout(r, 3000))]);
}

// A run lives in the offscreen page; while that page exists, a sync is in progress. Its result arrives as a 'done'
// message, handled below even if Chrome restarted this background worker in the meantime.
export async function sync() {
  if (await chrome.offscreen.hasDocument()) {
    // A run that has been going for over 15 minutes is stuck; clear it and start again.
    const { status = {} } = await chrome.storage.local.get('status');
    if (status.startedAt && Date.now() - Date.parse(status.startedAt) < 15 * 60000) return;
    await chrome.offscreen.closeDocument().catch(() => {});
  }
  const cfg = await config();
  if (!cfg.maniUrl || !cfg.token) {
    await setStatus({ state: 'setup', message: 'Open this extension and enter your Mani address and token.' });
    return;
  }
  await setStatus({ state: 'running', message: 'Starting…', startedAt: new Date().toISOString() });
  await ensureOffscreen();
  chrome.runtime.sendMessage({ type: 'run', cfg }).catch(() => {});
}

async function finished(msg) {
  if (msg.error) await setStatus({ state: 'error', message: msg.error, finishedAt: new Date().toISOString() });
  else {
    const r = msg.result;
    await setStatus({
      state: 'ok',
      message: `Found ${r.charges} recent charges and ${r.listed} orders; read ${r.orders} new orders (${r.itemsFound} items); matched ${r.matched} to bank transactions.`,
      finishedAt: new Date().toISOString(),
    });
  }
  await chrome.offscreen.closeDocument().catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'progress') setStatus({ state: 'running', message: msg.text });
  if (msg?.type === 'done') finished(msg);
  if (msg?.type === 'sync-now') {
    sync();
    reply({ ok: true });
  }
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'sync') sync();
});

function schedule() {
  chrome.alarms.create('sync', { delayInMinutes: 1, periodInMinutes: EVERY_MINUTES });
}
chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);
