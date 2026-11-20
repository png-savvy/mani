// Firefox: the background page can read HTML itself (no offscreen page needed) and stays loaded, so it runs syncs directly.
import { runSync } from './sync-core.js';
import { tabOpener } from './tab-reader.js';
// Firefox's promise-returning extension API is `browser`; Chrome's `chrome` returns promises too (Manifest V3).
const ext = globalThis.browser ?? chrome;

const EVERY_MINUTES = 180;
let running = null;

async function config() {
  const { maniUrl = '', token = '', days = 60 } = await ext.storage.local.get(['maniUrl', 'token', 'days']);
  return { maniUrl, token, days: Number(days) || 60 };
}

async function setStatus(patch) {
  const { status = {} } = await ext.storage.local.get('status');
  await ext.storage.local.set({ status: { ...status, ...patch } });
}

function sync() {
  if (running) return running;
  running = (async () => {
    const cfg = await config();
    if (!cfg.maniUrl || !cfg.token) {
      await setStatus({ state: 'setup', message: 'Open this extension and enter your Mani address and token.' });
      return;
    }
    await setStatus({ state: 'running', message: 'Starting…', startedAt: new Date().toISOString() });
    try {
      const r = await runSync(cfg, (text) => setStatus({ state: 'running', message: text }), tabOpener(ext));
      await setStatus({
        state: 'ok',
        message: `Found ${r.charges} recent charges and ${r.listed} orders; read ${r.orders} new orders (${r.itemsFound} items); matched ${r.matched} to bank transactions.`,
        finishedAt: new Date().toISOString(),
      });
    } catch (e) {
      await setStatus({ state: 'error', message: e?.message || String(e), finishedAt: new Date().toISOString() });
    }
  })().finally(() => {
    running = null;
  });
  return running;
}

ext.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'sync-now') sync();
});
ext.alarms.onAlarm.addListener((a) => {
  if (a.name === 'sync') sync();
});
ext.alarms.create('sync', { delayInMinutes: 1, periodInMinutes: EVERY_MINUTES });
