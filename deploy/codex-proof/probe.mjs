#!/usr/bin/env node
// Sandbox probe (KBC-027 AC-1, ADR 0020): stands in for the Codex binary in the `codex`
// container, started by the real runner exactly like a Codex turn (same user, folder,
// environment, mounts). It looks everywhere it can for the canaries the proof planted on the
// host (state, Claude login, deploy .env, secrets key) and prints what it found as one line.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// This run's canary comes as the turn's input (random per run), so source files that only
// mention the word cannot match; nothing else reaches the probe but stdin.
let MARK = '';
for await (const chunk of process.stdin) MARK += chunk;
MARK = MARK.trim();
if (MARK.length < 24) {
  process.stdout.write(
    `${JSON.stringify({ type: 'kbchat.probe', error: 'no canary' })}\n`,
  );
  process.exit(2);
}
const SKIP = new Set(['/proc', '/sys', '/dev']);
const MAX_BYTES = 2 * 1024 * 1024;
const SERVER_VARIABLES = [
  'KB_CHAT_SECRETS_KEY',
  'SMTP_PASSWORD',
  'SMTP_USER',
  'RESEND_API_KEY',
  'GOOGLE_CLIENT_ID',
  'KB_CHAT_OWNER_EMAIL',
  'KB_CHAT_STATE_DIR',
  'CLAUDE_CONFIG_DIR',
];

const files = [];
const unreadable = [];
function walk(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    unreadable.push(dir);
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    if (SKIP.has(path)) continue;
    let info;
    try {
      info = statSync(path);
    } catch {
      continue;
    }
    if (info.isDirectory()) walk(path);
    else if (info.isFile() && info.size <= MAX_BYTES) {
      try {
        if (readFileSync(path, 'latin1').includes(MARK)) files.push(path);
      } catch {
        // Unreadable: that is the point.
      }
    }
  }
}
walk('/');

const processes = [];
for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
  try {
    if (readFileSync(`/proc/${pid}/environ`, 'latin1').includes(MARK))
      processes.push(pid);
  } catch {
    // Another user's process: not readable.
  }
}

// The image creates these folders empty for the API; a mount would fill them.
const hasContent = (path) => {
  try {
    return statSync(path).isDirectory() ? readdirSync(path).length > 0 : true;
  } catch {
    return false;
  }
};
const explicit = [
  '/data/state',
  '/home/app/.claude',
  '/srv/kb-chat',
  '/app/.env',
  '/vault',
].filter(hasContent);

process.stdout.write(
  `${JSON.stringify({
    type: 'kbchat.probe',
    uid: process.getuid?.(),
    canaryFiles: files,
    canaryProcesses: processes,
    canaryEnv: Object.entries(process.env)
      .filter(([, value]) => String(value).includes(MARK))
      .map(([name]) => name),
    serverVariables: SERVER_VARIABLES.filter((name) => name in process.env),
    serverPathsVisible: explicit,
    envNames: Object.keys(process.env).sort(),
  })}\n`,
);
