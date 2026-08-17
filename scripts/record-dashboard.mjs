#!/usr/bin/env node
/**
 * Record the dashboard as it reacts to real traffic.
 *
 *   node scripts/record-dashboard.mjs
 *
 * Headless Chrome screenshots the real page rather than capturing the screen:
 * nothing but the dashboard is ever photographed, it needs no recording
 * permission, and frames land straight on disk for ffmpeg.
 *
 * Chrome does not reliably exit after `--screenshot`, so rather than guessing a
 * sleep we wait for the PNG to appear and stop growing, then kill it. Each frame
 * takes about as long as the page needs and no longer.
 */

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = process.env.DEMO_PORT ?? '8790';
const BASE = `http://127.0.0.1:${PORT}`;
const FRAMES = process.env.FRAMES_DIR ?? '/tmp/fwdash';
const [W, H] = [1280, 860];

if (!existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}

rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

let shotIndex = 0;
const profiles = [];
process.on('exit', () => {
  for (const p of profiles) {
    try { rmSync(p, { recursive: true, force: true }); } catch { /* leave it to the OS */ }
  }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => `f${String(n).padStart(4, '0')}.png`;

async function shot() {
  const out = join(FRAMES, pad(shotIndex));
  // A fresh profile per shot: a reused one can still be locked by the previous
  // Chrome, which then exits without writing anything.
  const profile = mkdtempSync(join(tmpdir(), 'fwchrome-'));

  const child = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-sandbox',
    '--no-first-run', '--no-default-browser-check',
    '--virtual-time-budget=2500',
    `--user-data-dir=${profile}`,
    `--window-size=${W},${H}`,
    `--screenshot=${out}`,
    `${BASE}/?nolive=1&t=${shotIndex}`,
  ], { stdio: 'ignore' });

  // Wait for the file to appear and settle, rather than for Chrome to exit.
  let stable = 0;
  let lastSize = -1;
  for (let i = 0; i < 200; i++) {
    await sleep(100);
    if (existsSync(out)) {
      const size = statSync(out).size;
      if (size > 0 && size === lastSize) stable += 1;
      else stable = 0;
      lastSize = size;
      if (stable >= 3) break;
    }
  }

  child.kill('SIGKILL');
  // Chrome keeps flushing profile files for a moment after SIGKILL, so removing
  // the directory here races it. The frame is already on disk; cleanup is
  // best-effort and happens again at exit.
  profiles.push(profile);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch { /* retried on exit */ }

  if (!existsSync(out)) throw new Error(`frame ${shotIndex} was never written`);
  process.stdout.write(`\r  frame ${shotIndex} (${Math.round(lastSize / 1024)}KB)   `);
  shotIndex += 1;
}

/** Repeat the previous frame, so a state stays on screen long enough to read. */
function hold(n = 6) {
  const src = join(FRAMES, pad(shotIndex - 1));
  for (let i = 0; i < n; i++) {
    copyFileSync(src, join(FRAMES, pad(shotIndex)));
    shotIndex += 1;
  }
}

async function ask(model, content, maxTokens = 25) {
  try {
    await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0, messages: [{ role: 'user', content }], max_tokens: maxTokens }),
    });
  } catch { /* the dashboard showing the failure is also a valid frame */ }
}

console.log(`recording dashboard → ${FRAMES}`);

// 1. resting state
await shot(); hold(8);

// 2. traffic arrives: the log fills, quota bars move, usage totals climb
for (const q of ['what is a rate limit', 'name a colour', 'what is 2+2']) {
  await ask('fast', q);
  await shot();
}
hold(5);

// 3. aliases land on different models
for (const m of ['cheap', 'code', 'reason']) {
  await ask(m, 'reply with one word: ok', 10);
  await shot();
}
hold(6);

// 4. the same question again — a cache hit, costing nothing
await ask('fast', 'what is 2+2');
await shot(); hold(10);

// 5. an unknown model, then a server-side session
await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'gpt-5-turbo-ultra', messages: [{ role: 'user', content: 'hi' }] }),
}).catch(() => {});
await shot(); hold(6);

await ask('fast', 'My name is Ada.');
await ask('fast', 'What is my name?');
await shot(); hold(12);

console.log(`\n  ${shotIndex} frames`);
