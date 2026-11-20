// Runs inside Amazon's Your Orders and Your Payments pages — but only in the background tab the extension itself opens
// (marked with #mani-sync). Your own Amazon tabs are left completely alone.
// Amazon fills these pages in with its own scripts after they load, so they're read here, as you would see them.
(() => {
  if (!location.hash.includes('mani-sync')) return;
  const ext = globalThis.browser ?? chrome;
  const ORDER_ID = /\b[A-Z0-9]{3}-\d{7}-\d{7}\b/;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pageText = () => (document.body ? document.body.innerText : '');

  /** Waits until order numbers have appeared and the page has stopped changing. */
  async function settle(maxMs) {
    const start = Date.now();
    let last = -1;
    let stable = 0;
    while (Date.now() - start < maxMs) {
      await sleep(700);
      const t = pageText();
      const loaded = ORDER_ID.test(t) || /\b0 orders\b|no orders|no transactions/i.test(t);
      if (loaded && t.length === last) {
        if (++stable >= 2) return true;
      } else stable = 0;
      last = t.length;
    }
    return false;
  }

  /** Visible text pieces in reading order (same as tokensFromDocument in parse.js). */
  function tokens() {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const parent = n.parentElement;
      if (parent && /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName)) continue;
      if (parent && parent.closest('[hidden], [aria-hidden="true"]')) continue;
      const t = n.nodeValue.replace(/\s+/g, ' ').trim();
      if (t) out.push(t);
    }
    return out;
  }

  function findNext() {
    const named = document.querySelector('input[name*="NextPage"]');
    if (named && !named.disabled && !named.closest('.a-button-disabled')) return named;
    for (const el of document.querySelectorAll('.a-button-text, button, a, span')) {
      if (el.children.length || !/^next page$/i.test((el.textContent || '').trim())) continue;
      const button = el.closest('.a-button');
      if (button?.classList.contains('a-button-disabled') || el.closest('.a-disabled')) continue;
      return button?.querySelector('input, button') || el;
    }
    return null;
  }

  ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.cmd === 'read') {
      const lines = pageText().split(/\n+/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
      sendResponse({ tokens: tokens().slice(0, 8000), lines: lines.slice(0, 4000), url: location.href });
      return;
    }
    if (msg?.cmd === 'next') {
      (async () => {
        const button = findNext();
        if (!button) return sendResponse(false);
        const before = pageText();
        button.click();
        const start = Date.now();
        while (Date.now() - start < 15000) {
          await sleep(500);
          if (pageText() !== before) {
            await settle(8000);
            return sendResponse(true);
          }
        }
        sendResponse(false);
      })();
      return true; // answer comes later
    }
  });

  settle(25000).then((ok) => ext.runtime.sendMessage({ type: 'mani-ready', ok }));
})();
