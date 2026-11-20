// Firefox's promise-returning extension API is `browser`; Chrome's `chrome` returns promises too (Manifest V3).
const ext = globalThis.browser ?? chrome;
const $ = (id) => document.getElementById(id);

const FIELDS = ['url', 'token', 'days'];

/** Fills the boxes once when opened: with anything typed but not yet saved (the popup closes when you click away), else the saved settings. */
async function fill() {
  const { maniUrl = '', token = '', days = 60, draft } = await ext.storage.local.get(['maniUrl', 'token', 'days', 'draft']);
  const saved = { url: maniUrl, token, days };
  for (const f of FIELDS) $(f).value = draft?.[f] ?? saved[f];
}

// Remember every keystroke, so switching windows to copy the token loses nothing.
for (const f of FIELDS) {
  $(f).addEventListener('input', () => {
    ext.storage.local.set({ draft: Object.fromEntries(FIELDS.map((k) => [k, $(k).value])) });
  });
}

async function render() {
  const { status = {} } = await ext.storage.local.get('status');
  const when = status.finishedAt ? `\n${new Date(status.finishedAt).toLocaleString()}` : '';
  $('status').textContent = (status.message || 'Not run yet.') + (status.state === 'running' ? '' : when);
  $('status').className = status.state === 'error' ? 'error' : '';
}

$('save').onclick = async () => {
  let url = $('url').value.trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\//.test(url)) url = 'https://' + url;
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    $('status').textContent = 'That Mani address does not look right.';
    return;
  }
  const days = Math.min(365, Math.max(7, Number($('days').value) || 60));
  // Both start right away, inside the click: browsers only show a permission prompt in direct response to a click, and
  // Firefox closes this popup when the prompt opens (the save is already on its way by then).
  const saved = ext.storage.local.set({ maniUrl: url, token: $('token').value.trim(), days }).then(() => ext.storage.local.remove('draft'));
  // Already-allowed addresses (localhost, *.ts.net) resolve at once without a prompt.
  const granted = await ext.permissions.request({ origins: [origin + '/*'] }).catch(() => false);
  await saved;
  if (!granted) {
    $('status').textContent = 'Permission to reach your Mani address was not given.';
    return;
  }
  $('status').textContent = 'Saved. Syncing…';
  ext.runtime.sendMessage({ type: 'sync-now' });
};

$('sync').onclick = () => ext.runtime.sendMessage({ type: 'sync-now' });

$('tab').onclick = (e) => {
  e.preventDefault();
  ext.tabs.create({ url: ext.runtime.getURL('popup.html?tab=1') });
  window.close();
};
if (new URLSearchParams(location.search).has('tab')) {
  document.body.classList.add('in-tab');
  $('tab-hint').hidden = true;
}

ext.storage.onChanged.addListener((changes) => {
  if (changes.status) render();
});
fill();
render();
