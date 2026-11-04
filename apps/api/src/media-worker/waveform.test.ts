import { describe, expect, it } from 'vitest';
import { PeakMeter, waveformArgs } from './waveform.js';

const samples = (...levels: number[]) => {
  const bytes = Buffer.alloc(levels.length * 2);
  levels.forEach((level, index) => bytes.writeInt16LE(level, index * 2));
  return bytes;
};

describe('PeakMeter (KBC-066)', () => {
  it('keeps the loudest sample of each window, in either direction', () => {
    const meter = new PeakMeter(4_000);
    meter.read(samples(100, -16_384, 0, 32_767));
    expect([...meter.result()]).toEqual([128, 255]);
  });

  it('reads a sample split between two chunks', () => {
    const meter = new PeakMeter(8_000);
    const bytes = samples(-32_768, 16_384);
    meter.read(bytes.subarray(0, 3));
    meter.read(bytes.subarray(3));
    expect([...meter.result()]).toEqual([255, 128]);
  });

  it('counts the last short window and nothing after it', () => {
    const meter = new PeakMeter(10);
    meter.read(samples(32_767));
    expect([...meter.result()]).toEqual([255]);
    expect([...new PeakMeter(10).result()]).toEqual([]);
  });
});

describe('waveformArgs', () => {
  it('decodes to raw mono samples on stdout, audio only', () => {
    const args = waveformArgs('a.m4a');
    expect(args).toContain('s16le');
    expect(args).toContain('-vn');
    expect(args.at(-1)).toBe('pipe:1');
  });
});
