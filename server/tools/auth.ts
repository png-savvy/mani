// Lockout recovery, run on the computer that hosts the app (stop the app first or restart it after):
//   npm run auth -- disable-2fa      turn off two-step login
//   npm run auth -- reset-password   choose a new password (typed privately, not saved in shell history)
// Both sign out every device.
import '../env.ts';
import readline from 'node:readline';
import { db } from '../db.ts';
import { setPassword } from '../security.ts';
import { disableTwoFactor } from '../totp.ts';

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    let prompted = false;
    out._writeToOutput = (s: string) => {
      if (!prompted) {
        out.output.write(s);
        prompted = true;
      } else if (s.includes('\n')) out.output.write('\n');
    };
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

const cmd = process.argv[2];
if (cmd === 'disable-2fa') {
  disableTwoFactor();
  db.prepare(`DELETE FROM sessions`).run();
  console.log('Two-step login is off and all devices were signed out. Log in with just your password, then set it up again in Settings.');
} else if (cmd === 'reset-password') {
  const pw = await askHidden('New password (8+ characters): ');
  const again = await askHidden('Type it again: ');
  if (pw.length < 8) {
    console.error('Too short — use at least 8 characters.');
    process.exit(1);
  }
  if (pw !== again) {
    console.error("Passwords didn't match. Nothing changed.");
    process.exit(1);
  }
  setPassword(pw);
  db.prepare(`DELETE FROM sessions`).run();
  console.log('Password changed and all devices signed out.');
} else {
  console.log('Usage: npm run auth -- disable-2fa | reset-password');
}
