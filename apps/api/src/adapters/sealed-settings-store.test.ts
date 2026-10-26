import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemorySettingsStore } from './memory-settings-store.js';
import { SealedSettingsStore } from './sealed-settings-store.js';
import { SecretBox } from './secret-box.js';

const setup = () => {
  const inner = new MemorySettingsStore();
  const sealer = new SecretBox(randomBytes(32));
  const warnings: string[] = [];
  const store = new SealedSettingsStore({
    store: inner,
    sealer,
    warn: (m) => warnings.push(m),
  });
  return { inner, sealer, store, warnings };
};

describe('SealedSettingsStore (KBC-022 AC-9)', () => {
  it('writes keys sealed and reads them back open', async () => {
    const { inner, store } = setup();
    await store.write('p', {
      version: 1,
      ai: { keys: { openrouter: 'sk-plain-123' } },
    });
    expect(JSON.stringify(await inner.read('p'))).not.toContain('sk-plain-123');
    expect(await store.read('p')).toEqual({
      version: 1,
      ai: { keys: { openrouter: 'sk-plain-123' } },
    });
  });

  it('migrates a plain key on read: the stored file becomes sealed', async () => {
    const { inner, store } = setup();
    await inner.write('p', { ai: { keys: { anthropic: 'sk-ant-old-9999' } } });
    expect(await store.read('p')).toEqual({
      ai: { keys: { anthropic: 'sk-ant-old-9999' } },
    });
    expect(JSON.stringify(await inner.read('p'))).not.toContain('old-9999');
  });

  it('drops a key sealed with another master key, warning without the value', async () => {
    const { inner, store, warnings } = setup();
    const other = new SecretBox(randomBytes(32)).seal('sk-foreign');
    await inner.write('p', { ai: { keys: { openai: other } } });
    expect(await store.read('p')).toEqual({ ai: { keys: {} } });
    expect(warnings.join()).toContain('openai');
    expect(warnings.join()).not.toContain('sk-foreign');
  });

  it('passes through documents without keys', async () => {
    const { store } = setup();
    expect(await store.read('none')).toBeNull();
    await store.write('q', { version: 1 });
    expect(await store.read('q')).toEqual({ version: 1 });
  });
});
