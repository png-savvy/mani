// Reading Amazon's pages. Amazon changes its page markup often, so this reads the *visible text* in page order instead of
// relying on CSS class names: a date heading, then for each charge the card, the amount and "Order #…".
// The pure functions here (everything but tokensFromDocument) are also used by Mani's tests.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DATE = /^(?:[A-Za-z]+,\s+)?([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/;
const DATE_ANYWHERE = /\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s+(\d{4})\b/;
const AMOUNT = /^([-+−])?\s*\$\s?([\d,]+\.\d{2})$/;
const ORDER_ID = /\b([A-Z0-9]{3}-\d{7}-\d{7})\b/;
const LAST4 = /(?:\*{2,}|•{2,}|ending in|x{2,})\s*(\d{4})\b/i;

export function parseDate(text) {
  const m = DATE.exec(text.trim()) || DATE_ANYWHERE.exec(text);
  if (!m) return null;
  const mon = MONTHS.indexOf(m[1].toLowerCase());
  if (mon < 0) return null;
  return `${m[3]}-${String(mon + 1).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}

/** Visible text pieces of a page, in reading order. */
export function tokensFromDocument(doc) {
  const out = [];
  const walker = doc.createTreeWalker(doc.body || doc.documentElement, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement;
    if (parent && /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName)) continue;
    if (parent && parent.closest('[hidden], [aria-hidden="true"]')) continue;
    const t = n.nodeValue.replace(/\s+/g, ' ').trim();
    if (t) out.push(t);
  }
  return out;
}

/**
 * Charges from the "Your Payments → Transactions" page. Each row reads, in order:
 *   Nov 13, 2026 · Amazon.com · Prime Visa •••• 1234 · Order #114-1000001-1000001 · -$21.98 · [Pending]
 * Rows marked Pending haven't been charged yet (they come back as completed charges later) and are skipped.
 * Returns [{ orderId, date, amount (cents, negative = charge, positive = refund), last4 }].
 */
export function parseTransactionTokens(tokens) {
  // Each date starts a new row.
  const rows = [];
  let row = null;
  for (const t of tokens) {
    const d = DATE.test(t) ? parseDate(t) : null;
    if (d) {
      row = { date: d, tokens: [] };
      rows.push(row);
    } else if (row) row.tokens.push(t);
  }
  const charges = [];
  for (const r of rows) {
    const text = r.tokens.join(' ');
    if (r.tokens.some((t) => /^(pending|in progress|processing)$/i.test(t))) continue;
    const ids = r.tokens.map((t) => ORDER_ID.exec(t)?.[1]).filter(Boolean);
    const amounts = r.tokens.map((t) => AMOUNT.exec(t)).filter(Boolean);
    // One order and one amount per row; anything else isn't a row we understand (left out rather than guessed).
    if (ids.length !== 1 || amounts.length !== 1) continue;
    const [, sign, value] = amounts[0];
    const cents = Math.round(Number(value.replace(/,/g, '')) * 100);
    const refund = sign === '+' || (!sign && /refund/i.test(text));
    charges.push({ orderId: ids[0].toUpperCase(), date: r.date, amount: refund ? cents : -cents, last4: LAST4.exec(text)?.[1] ?? null });
  }
  // The same charge can be printed twice (e.g. a summary and a detail); keep one.
  const seen = new Set();
  return charges.filter((c) => {
    const k = `${c.orderId}|${c.date}|${c.amount}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Orders from the "Your Orders" list: [{ orderId, orderDate, total (cents) }]. Each order card reads
 *   Order placed · November 3, 2026 · Total · $24.89 · Ship to … · Order # 112-…
 */
export function parseOrderListTokens(tokens) {
  const orders = [];
  let cur = null;
  let want = null; // the label we just passed: 'date' or 'total'
  const flush = () => {
    if (cur?.orderId && cur.orderDate && !orders.some((o) => o.orderId === cur.orderId)) orders.push(cur);
  };
  for (const t of tokens) {
    if (/^order placed\b/i.test(t)) {
      flush();
      cur = { orderId: null, orderDate: parseDate(t.replace(/^order placed\s*/i, '')), total: null };
      want = cur.orderDate ? null : 'date';
      continue;
    }
    if (!cur) continue;
    if (/^(order )?total\b/i.test(t)) {
      const inline = /\$\s?([\d,]+\.\d{2})/.exec(t);
      if (inline) cur.total = Math.round(Number(inline[1].replace(/,/g, '')) * 100);
      else want = 'total';
      continue;
    }
    if (want === 'date' && parseDate(t)) {
      cur.orderDate = parseDate(t);
      want = null;
      continue;
    }
    if (want === 'total') {
      const m = AMOUNT.exec(t);
      if (m) {
        cur.total = Math.round(Number(m[2].replace(/,/g, '')) * 100);
        want = null;
        continue;
      }
    }
    const id = ORDER_ID.exec(t);
    if (id && !cur.orderId) cur.orderId = id[1].toUpperCase();
  }
  flush();
  return orders;
}

/** One order's id, date and total out of a run of plain text (an order card, or the text after "Order placed"). */
function parseOrderText(text) {
  const id = ORDER_ID.exec(text);
  const orderDate = parseDate(text);
  if (!id || !orderDate) return null;
  const total = /total[^$\d]{0,40}\$\s?([\d,]+\.\d{2})/i.exec(text);
  return { orderId: id[1].toUpperCase(), orderDate, total: total ? Math.round(Number(total[1].replace(/,/g, '')) * 100) : null };
}

/**
 * Orders from a "Your Orders" page, trying three ways of reading it (Amazon's markup varies):
 * the visible text in order, then each order card's text, then the whole page's text split at "Order placed".
 */
export function parseOrderListDocument(doc) {
  const fromTokens = parseOrderListTokens(tokensFromDocument(doc));
  if (fromTokens.length) return fromTokens;

  const orders = [];
  const add = (o) => {
    if (o && !orders.some((x) => x.orderId === o.orderId)) orders.push(o);
  };
  const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ');
  for (const sel of ['.order-card', '.js-order-card', '[class*="order-card"]', '.order']) {
    for (const card of doc.querySelectorAll(sel)) add(parseOrderText(textOf(card)));
    if (orders.length) return orders;
  }
  for (const el of doc.querySelectorAll('script, style, noscript, template')) el.remove();
  const chunks = textOf(doc.body || doc.documentElement).split(/order placed/i).slice(1);
  for (const chunk of chunks) add(parseOrderText(chunk.slice(0, 1500)));
  return orders;
}

/** What a "Your Orders" page actually contains, for when none of the readers above find an order in it. */
export function orderPageDiagnostics(doc, html, tokens) {
  const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').slice(0, n);
  const ids = html.match(/\b\d{3}-\d{7}-\d{7}\b/g) || [];
  const at = ids.length ? html.indexOf(ids[0]) : -1;
  const placed = tokens.findIndex((t) => /order placed/i.test(t));
  const count = (sel) => doc.querySelectorAll(sel).length;
  return {
    title: clip(doc.title, 80),
    htmlLength: html.length,
    idsInHtml: ids.length,
    idsInText: tokens.filter((t) => ORDER_ID.test(t)).length,
    // The page source just around the first order number: shows how Amazon marks an order up.
    htmlAroundFirstId: at >= 0 ? clip(html.slice(Math.max(0, at - 700), at + 150), 900) : null,
    textAfterOrderPlaced: placed >= 0 ? tokens.slice(placed, placed + 16).map((t) => clip(t, 50)) : null,
    orderWords: tokens.filter((t) => /order|total|placed/i.test(t)).slice(0, 25).map((t) => clip(t, 50)),
    counts: { orderCard: count('.order-card'), jsOrderCard: count('.js-order-card'), anyOrderClass: count('[class*="order"]'), ariaHidden: count('[aria-hidden="true"]'), scripts: count('script') },
  };
}

const NOT_ITEM = /^(buy it again|view your item|view item|write a product review|track package|return or replace items?|return items?|share gift receipt|leave seller feedback|get product support|ask product question|problem with order|archive order|view order details|invoice|see all|details)$/i;

/** Item names from an order-details page: the text of links to product pages. */
export function parseOrderDocument(doc) {
  const items = [];
  for (const a of doc.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    if (!/\/(dp|gp\/product)\/[A-Z0-9]{10}/i.test(href)) continue;
    const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length < 4 || NOT_ITEM.test(text) || /^\$/.test(text)) continue;
    if (!items.includes(text)) items.push(text);
  }
  return { items, orderDate: parseOrderDate(tokensFromDocument(doc)) };
}

export function parseOrderDate(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    if (/(ordered on|order placed|order date)/i.test(tokens[i])) {
      const d = parseDate(tokens[i]) || (tokens[i + 1] ? parseDate(tokens[i + 1]) : null);
      if (d) return d;
    }
  }
  return null;
}

/**
 * A description of the page's layout (forms, buttons, the text around one charge), sent to your own Mani when reading
 * stops early, so the reader can be adjusted to Amazon's current pages.
 */
export function pageDiagnostics(doc, tokens) {
  const clip = (v, n = 90) => String(v ?? '').slice(0, n);
  const forms = [...doc.querySelectorAll('form')].slice(0, 12).map((f) => ({
    action: clip(f.getAttribute('action')),
    method: clip(f.getAttribute('method'), 10),
    inputs: [...f.querySelectorAll('input[name]')].slice(0, 15).map((i) => `${clip(i.getAttribute('type'), 10)}:${clip(i.getAttribute('name'), 70)}`),
  }));
  const buttons = [...doc.querySelectorAll('input[type="submit"], button, .a-button-text, a')]
    .map((b) => clip(b.getAttribute('name') || (b.textContent || '').trim(), 70))
    .filter((t) => /next|page|more|older|previous|›|»/i.test(t))
    .slice(0, 20);
  const i = tokens.findIndex((t) => ORDER_ID.test(t));
  return {
    forms,
    buttons,
    sample: i >= 0 ? tokens.slice(Math.max(0, i - 6), i + 3).map((t) => clip(t, 60)) : tokens.slice(0, 30).map((t) => clip(t, 60)),
  };
}

export function isSignInPage(url, doc) {
  return /\/ap\/(signin|mfa|cvf)/.test(url) || !!doc.querySelector('form[name="signIn"], #ap_email, #ap_password');
}
