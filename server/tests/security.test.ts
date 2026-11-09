import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated database for this test run.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mani-sec-'));
process.env.DATA_DIR = dir;

const { loginThrottleMs, recordLoginFailure, clearLoginFailures, verifyPassword, hashPassword } = await import('../security.ts');

test('password hashing round-trips and rejects wrong passwords', () => {
  const stored = hashPassword('correct horse');
  assert.equal(verifyPassword('correct horse', stored), true);
  assert.equal(verifyPassword('wrong', stored), false);
});

test('global login throttle ramps with failures and ignores the apparent IP', () => {
  assert.equal(loginThrottleMs(), 0, 'no delay before any failures');

  // The first few failures stay instant (normal mistypes).
  for (let i = 0; i < 5; i++) recordLoginFailure('1.1.1.1');
  assert.equal(loginThrottleMs(), 0, 'first 5 failures are free');

  // Rotating the IP (as an X-Forwarded-For spoof would) must NOT reset the global counter.
  for (let i = 0; i < 10; i++) recordLoginFailure(`10.0.0.${i}`);
  const delay = loginThrottleMs();
  assert.ok(delay > 0, 'sustained guessing is throttled regardless of IP');

  // More failures => more delay, up to the ceiling.
  for (let i = 0; i < 50; i++) recordLoginFailure(`10.1.0.${i}`);
  assert.ok(loginThrottleMs() >= delay, 'delay grows with more failures');
  assert.ok(loginThrottleMs() <= 5000, 'delay is capped so a real login never stalls for long');
});

test('clearing one IP does not wipe the global attack record', () => {
  clearLoginFailures('1.1.1.1');
  assert.ok(loginThrottleMs() > 0, 'a successful login from one IP leaves the global window intact');
});
