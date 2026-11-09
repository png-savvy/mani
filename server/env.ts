// Minimal .env loader (KEY=value lines). Imported first so settings exist before other modules read them.
import fs from 'node:fs';
import path from 'node:path';

const file = path.resolve(process.env.ENV_FILE || '.env');
if (fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
