// One sync: reads Amazon with your normal Amazon sign-in and sends the results to Mani. Shared by the Chrome build
// (run from offscreen.js) and the Firefox build (run from background-firefox.js). Needs fetch and DOMParser.
import {
  isSignInPage,
  orderPageDiagnostics,
  pageDiagnostics,
  parseOrderDocument,
  parseOrderListDocument,
  parseOrderListTokens,
  parseTransactionTokens,
  tokensFromDocument,
} from './parse.js';

const AMAZON = 'https://www.amazon.com';
const TRANSACTIONS = AMAZON + '/cpe/yourpayments/transactions';
const MAX_ORDERS_PER_RUN = 40;
const PAUSE_MS = 1500; // between Amazon page loads, to stay gentle
// Stopping early at things Mani already has: always read at least MIN_PAGES, and only stop after this many pages in a
// row with nothing new.
const MIN_PAGES = 2;
const FAMILIAR_PAGES_TO_STOP = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SignedOut extends Error {}

async function amazonPage(url, init = {}) {
  const res = await fetch(url, { credentials: 'include', redirect: 'follow', ...init });
  if (!res.ok) throw new Error(`Amazon returned HTTP ${res.status} for ${new URL(url).pathname}`);
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (isSignInPage(res.url, doc)) throw new SignedOut('Signed out of Amazon. Sign in at amazon.com in Chrome and it will retry.');
  return { doc, html, url: res.url };
}

export async function mani(cfg, path, body) {
  const res = await fetch(cfg.maniUrl.replace(/\/+$/, '') + '/api/integrations/amazon' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Mani: ${json.error || 'HTTP ' + res.status}`);
  return json;
}

function orderUrl(id) {
  return id.startsWith('D01-')
    ? `${AMAZON}/gp/digital/your-account/order-summary.html?orderID=${encodeURIComponent(id)}`
    : `${AMAZON}/gp/your-account/order-details?orderID=${encodeURIComponent(id)}`;
}

/** Runs one sync. `progress(text)` is called as it goes; `openTab` (see tab-reader.js) lets it read pages in a real tab. Throws on failure (after telling Mani, unless Mani is the problem). */
export async function runSync(cfg, progress = async () => {}, openTab = null) {
  try {
    return await run(cfg, progress, openTab);
  } catch (e) {
    const error = e?.message || String(e);
    if (!/^Mani:/.test(error)) await mani(cfg, '/status', { error }).catch(() => {});
    throw e;
  }
}

const ordersUrl = (year, start) => `${AMAZON}/your-orders/orders?timeFilter=year-${year}&startIndex=${start}`;
const oldestOf = (rows, key) => rows.reduce((m, r) => (r[key] < m ? r[key] : m), '9999-12-31');

/** Reads charges and orders from real background tabs (pages as Amazon's scripts render them). */
async function readWithTabs(openTab, cutoff, progress, known) {
  let debug = null;

  // Charges: page through Your Payments with its own "Next page" button. Normally stop once we're back among charges
  // Mani already has; on a full scan, keep going to the look-back date.
  const charges = [];
  let complete = true; // did both lists get read all the way back to the look-back date?
  let tab = await openTab(TRANSACTIONS);
  try {
    let familiar = 0;
    for (let n = 1; n <= 15; n++) {
      const page = await tab.read();
      let found = parseTransactionTokens(page.tokens);
      if (!found.length) found = parseTransactionTokens(page.lines);
      for (const c of found) if (!charges.some((x) => x.orderId === c.orderId && x.date === c.date && x.amount === c.amount)) charges.push(c);
      await progress(`Read ${charges.length} Amazon charges (page ${n})…`);
      if (found.length && oldestOf(found, 'date') < cutoff) break;
      // A page with nothing new counts toward stopping; a page of only pending charges (none read) counts as neither.
      if (found.length) familiar = found.every((c) => known.charges.has(`${c.orderId}|${c.date}|${c.amount}`)) ? familiar + 1 : 0;
      if (!known.fullScan && n >= MIN_PAGES && familiar >= FAMILIAR_PAGES_TO_STOP) {
        complete = false;
        break;
      }
      if (!(await tab.next())) break;
    }
  } finally {
    await tab.close();
  }

  // Orders: ten per page, newest first.
  const listed = [];
  let pages = 0;
  const thisYear = new Date().getFullYear();
  tab = null;
  let familiar = 0;
  try {
    years: for (let year = thisYear; year >= Number(cutoff.slice(0, 4)); year--) {
      for (let start = 0; start < 300; start += 10) {
        await sleep(PAUSE_MS);
        if (tab) await tab.goto(ordersUrl(year, start));
        else tab = await openTab(ordersUrl(year, start));
        const page = await tab.read();
        let found = parseOrderListTokens(page.tokens);
        if (!found.length) found = parseOrderListTokens(page.lines);
        pages++;
        if (!found.length) {
          if (start === 0 && year === thisYear) {
            const interesting = page.lines.filter((l) => /order|total|placed|\$\d/i.test(l));
            complete = false; // an unreadable order list is not a finished scan
            debug = { where: 'orders-tab', lines: page.lines.length, interesting: interesting.slice(0, 40).map((l) => l.slice(0, 70)), first: page.lines.slice(0, 25).map((l) => l.slice(0, 70)) };
          }
          break;
        }
        listed.push(...found.filter((o) => o.orderDate >= cutoff && !listed.some((x) => x.orderId === o.orderId)));
        await progress(`Read ${charges.length} charges and ${listed.length} orders…`);
        if (found.some((o) => o.orderDate < cutoff)) break years;
        if (found.length < 10) break;
        // Stop early only after several pages in a row with nothing new: orders can show up late or out of order, so
        // one familiar page isn't proof that everything older is already known.
        familiar = found.every((o) => known.orders.has(o.orderId)) ? familiar + 1 : 0;
        if (!known.fullScan && pages >= MIN_PAGES && familiar >= FAMILIAR_PAGES_TO_STOP) {
          complete = false;
          break years;
        }
      }
    }
  } catch (e) {
    // Keep the charges already read; note why the order list stopped.
    if (e instanceof SignedOut) throw e;
    debug = { where: 'orders-tab', error: e?.message || String(e), pages, orders: listed.length };
    complete = false;
  } finally {
    if (tab) await tab.close();
  }
  return { charges: charges.filter((c) => c.date >= cutoff), listed, pages, debug, fullScan: known.fullScan && complete };
}

/** Reads what it can from the pages as downloaded (no scripts run): the newest charges, and orders if Amazon includes them. */
async function readByDownload(cutoff, progress) {
  const payments = await amazonPage(TRANSACTIONS);
  const paymentTokens = tokensFromDocument(payments.doc);
  const charges = parseTransactionTokens(paymentTokens).filter((c) => c.date >= cutoff);
  await progress(`Read ${charges.length} Amazon charges…`);
  let debug = null;
  if (!charges.length || charges.every((c) => !c.last4)) debug = { where: 'payments', ...pageDiagnostics(payments.doc, paymentTokens) };

  const listed = [];
  let pages = 0;
  const thisYear = new Date().getFullYear();
  for (let year = thisYear; year >= Number(cutoff.slice(0, 4)); year--) {
    for (let start = 0; start < 200; start += 10) {
      await sleep(PAUSE_MS);
      const { doc, html } = await amazonPage(ordersUrl(year, start));
      const tokens = tokensFromDocument(doc); // before parsing, which may strip scripts from the document
      const diagnostics = start === 0 && year === thisYear ? orderPageDiagnostics(doc, html, tokens) : null;
      const found = parseOrderListDocument(doc);
      pages++;
      if (!found.length) {
        if (diagnostics) debug = { where: 'orders', ...diagnostics };
        break;
      }
      listed.push(...found.filter((o) => o.orderDate >= cutoff));
      await progress(`Read ${charges.length} charges and ${listed.length} orders…`);
      if (found.length < 10 || found.some((o) => o.orderDate < cutoff)) break;
    }
  }
  return { charges, listed, pages, debug };
}

async function run(cfg, progress, openTab) {
  await mani(cfg, '/ping');
  const cutoff = new Date(Date.now() - cfg.days * 86400000).toISOString().slice(0, 10);

  // 1 + 2. Card charges (Your Payments) and orders with their totals (Your Orders). Amazon fills both pages in with
  // its own scripts, so where the browser lets us (openTab) they're read in a real background tab; otherwise, or if that
  // fails, from the page as downloaded — which only has the newest charges and no order list.
  let got = null;
  let debug = null;
  if (openTab) {
    try {
      const k = await mani(cfg, '/known').catch(() => ({}));
      const known = { orders: new Set(k.orders || []), charges: new Set(k.charges || []), fullScan: k.fullScan !== false };
      got = await readWithTabs(openTab, cutoff, progress, known);
    } catch (e) {
      if (e instanceof SignedOut) throw e;
      debug = { where: 'tab', error: e?.message || String(e) };
    }
  }
  if (!got) {
    const note = debug;
    got = await readByDownload(cutoff, progress);
    debug = note || got.debug;
  } else debug = got.debug;
  const { charges, listed, pages } = got;
  const first = await mani(cfg, '/import', { charges, orders: listed.map((o) => ({ ...o, items: [] })) });

  // 3. What was in each order Mani doesn't know yet.
  const orders = [];
  for (const id of (first.needOrders || []).slice(0, MAX_ORDERS_PER_RUN)) {
    await sleep(PAUSE_MS);
    await progress(`Reading order ${orders.length + 1} of ${Math.min(first.needOrders.length, MAX_ORDERS_PER_RUN)}…`);
    try {
      const { doc } = await amazonPage(orderUrl(id));
      orders.push({ orderId: id, ...parseOrderDocument(doc) });
    } catch (e) {
      if (e instanceof SignedOut) throw e;
      console.warn('Order', id, e);
    }
  }
  const second = orders.length ? await mani(cfg, '/import', { orders }) : { matched: 0 };
  await mani(cfg, '/status', { error: '', debug, fullScan: got.fullScan === true });
  return {
    charges: charges.length,
    listed: listed.length,
    pages,
    orders: orders.length,
    itemsFound: orders.reduce((s, o) => s + o.items.length, 0),
    matched: (first.matched || 0) + (second.matched || 0),
  };
}

