// A run's private temp root, for the runs that do not come through tools/heavy.sh (a single
// spec by hand, an editor). Call it in a test config, before anything is spawned: TMPDIR then
// reaches the workers, the servers and the browsers, and the root goes when this process does.
// What a kill leaves behind is swept by the next tools/heavy.sh; see that file for the rule.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STOPS = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

/** Does nothing in CI (a machine per job) or inside a run that already has its root. */
export function privateTemp() {
  if (process.env['CI'] || process.env['KBC_TEST_TEMP']) return;
  const base =
    process.env['KBC_HEAVY_TEMP'] || join(homedir(), '.cache/kb-chat/tmp');
  mkdirSync(base, { recursive: true });
  // The name carries the owner: the sweep leaves the root of a process still alive.
  const root = mkdtempSync(join(base, `${process.pid}.`));
  process.env['KBC_TEST_TEMP'] = root;
  process.env['TMPDIR'] = root;
  // Chrome on macOS ignores TMPDIR.
  process.env['MAC_CHROMIUM_TMPDIR'] = root;
  process.once('exit', () => {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A server still writing there, say: the sweep takes it once this process is gone.
    }
  });
  // A signal with no handler would skip the `exit` event. One with a handler is that
  // handler's: the runners and the E2E server close down in theirs, and then exit.
  for (const [signal, code] of Object.entries(STOPS))
    process.once(signal, () => {
      if (process.listenerCount(signal) === 0) process.exit(code);
    });
}
