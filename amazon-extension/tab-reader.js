// Opens an Amazon page in a background tab, lets Amazon's own scripts fill it in, and reads it through reader.js.
import { SignedOut } from './sync-core.js';

const MARK = '#mani-sync';
const LOAD_TIMEOUT_MS = 60000;

/** Returns open(url) → { read(), next(), goto(url), close() } for the given extension API (`browser`). */
export function tabOpener(ext) {
  return async function open(url) {
    let tabId = null;
    let waiter = null;
    const settleWaiter = (fn, value) => {
      if (!waiter) return;
      const w = waiter;
      waiter = null;
      clearTimeout(w.timer);
      w[fn](value);
    };
    const onMessage = (msg, sender) => {
      if (msg?.type === 'mani-ready' && sender.tab?.id === tabId) settleWaiter('resolve', msg);
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.url && /\/ap\/(signin|mfa|cvf)/.test(info.url)) {
        settleWaiter('reject', new SignedOut('Signed out of Amazon. Sign in at amazon.com in this browser and it will retry.'));
      }
    };
    const onRemoved = (id) => {
      if (id === tabId) settleWaiter('reject', new Error('The Amazon tab was closed before it finished.'));
    };
    ext.runtime.onMessage.addListener(onMessage);
    ext.tabs.onUpdated.addListener(onUpdated);
    ext.tabs.onRemoved.addListener(onRemoved);

    const ready = () =>
      new Promise((resolve, reject) => {
        waiter = { resolve, reject, timer: setTimeout(() => settleWaiter('reject', new Error('The Amazon page took too long to load.')), LOAD_TIMEOUT_MS) };
      });
    const close = async () => {
      ext.runtime.onMessage.removeListener(onMessage);
      ext.tabs.onUpdated.removeListener(onUpdated);
      ext.tabs.onRemoved.removeListener(onRemoved);
      const id = tabId;
      tabId = null;
      if (id !== null) await ext.tabs.remove(id).catch(() => {});
    };

    try {
      const loaded = ready();
      tabId = (await ext.tabs.create({ url: url + MARK, active: false })).id;
      await loaded;
    } catch (e) {
      await close();
      throw e;
    }
    return {
      read: () => ext.tabs.sendMessage(tabId, { cmd: 'read' }),
      next: () => ext.tabs.sendMessage(tabId, { cmd: 'next' }),
      async goto(next) {
        const loaded = ready();
        await ext.tabs.update(tabId, { url: next + MARK });
        await loaded;
      },
      close,
    };
  };
}
