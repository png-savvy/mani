// Sandbox-only helpers for testing Plaid without real banks.
//   npm run plaid:sandbox -- list
//   npm run plaid:sandbox -- reset-login <connectionId>   (bank "needs you to log in again" -> test Fix connection)
//   npm run plaid:sandbox -- refresh <connectionId>       (new transactions for user_transactions_dynamic)
import '../env.ts';
import { db } from '../db.ts';
import { decrypt } from '../security.ts';
import { plaidConfig } from '../banks.ts';

const [cmd, arg] = process.argv.slice(2);
const cfg = plaidConfig();

if (cfg.env !== 'sandbox') {
  console.error('Refusing to run: PLAID_ENV is not "sandbox".');
  process.exit(1);
}

async function post(path: string, body: Record<string, unknown>) {
  const res = await fetch(cfg.baseUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: cfg.clientId, secret: cfg.secret, ...body }),
  });
  const json = (await res.json()) as any;
  if (!res.ok) throw new Error(`${json.error_code}: ${json.error_message}`);
  return json;
}

function accessToken(id: string | undefined): string {
  const row = db.prepare(`SELECT secret_enc FROM connections WHERE id = ? AND provider = 'plaid'`).get(Number(id)) as { secret_enc: string } | undefined;
  if (!row) throw new Error(`No Plaid connection with id ${id}. Run "list" to see ids.`);
  return decrypt(row.secret_enc);
}

try {
  if (cmd === 'list') {
    console.table(db.prepare(`SELECT id, institution, status, error, last_sync_at FROM connections WHERE provider = 'plaid'`).all());
  } else if (cmd === 'reset-login') {
    await post('/sandbox/item/reset_login', { access_token: accessToken(arg) });
    console.log('Done. Press Sync now in Settings: the connection should turn red with a "Fix connection" button.');
  } else if (cmd === 'refresh') {
    await post('/transactions/refresh', { access_token: accessToken(arg) });
    console.log('Refresh requested. Wait ~30 seconds, then press Import in the account.');
  } else {
    console.log('Usage: npm run plaid:sandbox -- list | reset-login <connectionId> | refresh <connectionId>');
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
