// Chrome: runs one sync in a hidden extension page (it can parse HTML and isn't stopped mid-way like the background
// worker), reporting progress and the result to background.js.
import { runSync } from './sync-core.js';

const progress = (text) => chrome.runtime.sendMessage({ type: 'progress', text }).catch(() => {});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'run') return;
  runSync(msg.cfg, progress)
    .then((result) => chrome.runtime.sendMessage({ type: 'done', result }))
    .catch((e) => chrome.runtime.sendMessage({ type: 'done', error: e?.message || String(e) }));
});

chrome.runtime.sendMessage({ type: 'offscreen-ready' }).catch(() => {});
