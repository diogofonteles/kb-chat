// Weekly usage report from the local log (KBC-006 FR-4): pnpm --filter @kb-chat/api usage-report
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseUsageLog } from '../adapters/jsonl-usage-log.js';
import { loadConfig } from '../config.js';
import { formatWeeklyUsage, weeklyUsage } from '../modules/usage/index.js';
import { parseSpendLedger } from '../adapters/jsonl-spend-ledger.js';

const { KB_CHAT_STATE_DIR } = loadConfig();
const read = (name: string) =>
  readFile(join(KB_CHAT_STATE_DIR, name), 'utf8').catch(() => '');

const events = parseUsageLog(await read('events.jsonl'));
const spend = parseSpendLedger(await read('spend.jsonl'));

const rows = weeklyUsage(events, spend);
process.stdout.write(
  rows.length === 0
    ? `Nenhum uso registrado em ${KB_CHAT_STATE_DIR}.\n`
    : `${formatWeeklyUsage(rows)}\n`,
);
