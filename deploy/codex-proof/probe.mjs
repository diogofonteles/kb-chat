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
// "leave-a-stray": this turn leaves a detached process behind, which the runner must reap
// before the next turn (ADR 0020); every probe reports the strays it can see.
const leaveStray = MARK.includes('\nleave-a-stray');
MARK = MARK.split('\n')[0];
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

// The image creates these folders empty for the API; a mount would fill them, and a folder
// that exists but cannot be read (the API's 0700 state) is a mount just the same.
const hasContent = (path) => {
  let info;
  try {
    info = statSync(path);
  } catch {
    return false;
  }
  if (!info.isDirectory()) return true;
  try {
    return readdirSync(path).length > 0;
  } catch {
    return true;
  }
};

// Only these mounts may exist in the container (the probe's own file in the proof only).
const ALLOWED_MOUNTS = [
  /^\/$/,
  /^\/codex-home$/,
  /^\/tmp$/,
  /^\/(proc|sys|dev)(\/|$)/,
  /^\/etc\/(hosts|hostname|resolv\.conf)$/,
  /^\/probe\/probe\.mjs$/,
];
const mounts = readFileSync('/proc/self/mountinfo', 'utf8')
  .trim()
  .split('\n')
  .map((line) => line.split(' '))
  .map((fields) => ({ point: fields[4], options: fields[5] }));
const extraMounts = mounts
  .map((mount) => mount.point)
  .filter((point) => !ALLOWED_MOUNTS.some((allowed) => allowed.test(point)));
const rootReadOnly = mounts.some(
  (mount) => mount.point === '/' && mount.options.split(',').includes('ro'),
);

// No capability left, and no way to gain one.
const status = readFileSync('/proc/self/status', 'utf8');
const field = (name) =>
  new RegExp(`^${name}:\\s*(\\S+)`, 'm').exec(status)?.[1];
const noCapabilities =
  /^0+$/.test(field('CapEff') ?? '') && /^0+$/.test(field('CapPrm') ?? '');
const noNewPrivileges = field('NoNewPrivs') === '1';

// The cloud's metadata service hands out the VM's credentials: it must not answer here.
const metadataReachable = await fetch('http://169.254.169.254/', {
  signal: AbortSignal.timeout(3000),
}).then(
  () => true,
  () => false,
);
const explicit = [
  '/data/state',
  '/home/app/.claude',
  '/srv/kb-chat',
  '/app/.env',
  '/vault',
].filter(hasContent);

const strays = readdirSync('/proc')
  .filter((name) => /^\d+$/.test(name))
  .filter((pid) => {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'latin1').includes(
        'kbchat-stray',
      );
    } catch {
      return false;
    }
  });
if (leaveStray) {
  const { spawn } = await import('node:child_process');
  // The stray starts a child of its own: the runner must reap the whole family.
  const family = `require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'kbchat-stray-child'], { stdio: 'ignore' }); setInterval(() => {}, 1000);`;
  spawn(process.execPath, ['-e', family, 'kbchat-stray'], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}
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
    extraMounts,
    rootReadOnly,
    noCapabilities,
    noNewPrivileges,
    metadataReachable,
    strays,
    envNames: Object.keys(process.env).sort(),
  })}\n`,
);
