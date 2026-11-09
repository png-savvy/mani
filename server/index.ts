import './env.ts';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api } from './api.ts';
import { csrfGuard } from './security.ts';
import { startScheduler } from './scheduler.ts';
import { DB_PATH } from './db.ts';
import { plaidConfig } from './banks.ts';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

// When running behind a reverse proxy (Caddy, Nginx, Cloudflare Tunnel, Tailscale Serve), trust it for HTTPS detection.
const trust = process.env.TRUST_PROXY ?? 'loopback';
app.set('trust proxy', /^\d+$/.test(trust) ? Number(trust) : trust === 'true' ? true : trust);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' https://cdn.plaid.com",
      "frame-src https://cdn.plaid.com https://*.plaid.com",
      "connect-src 'self' https://*.plaid.com",
      "img-src 'self' data: https://*.plaid.com",
      "style-src 'self' 'unsafe-inline'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  next();
});

app.use('/api', express.json({ limit: '15mb' }), csrfGuard, api);

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(here, '../dist/client');
if (fs.existsSync(clientDir)) {
  app.use(
    express.static(clientDir, {
      index: false,
      // Built JS/CSS have content hashes in their names, so they can be cached forever; anything else
      // (logo, icons, manifest) must be re-checked so updates show up right away.
      setHeaders: (res, filePath) => {
        res.setHeader('Cache-Control', /[\\/]assets[\\/]/.test(filePath) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    }),
  );
  app.get('*', (req, res) => res.sendFile(path.join(clientDir, 'index.html')));
} else {
  app.get('/', (req, res) =>
    res.type('text').send('Client not built. Run "npm run build" (production) or "npm run dev" and open http://localhost:5173'),
  );
}

startScheduler();

app.listen(PORT, HOST, () => {
  const plaid = plaidConfig();
  console.log(`Mani budget server listening on http://${HOST}:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
  console.log(`Plaid: ${plaid.configured ? `configured (${plaid.env})` : 'not configured'} · SimpleFIN: available`);
});
