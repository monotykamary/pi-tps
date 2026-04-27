import { describe, it, expect } from 'vitest';

describe('formatDuration', () => {
  const importFormatDuration = async () => {
    const mod = await import('../index.js');
    return mod.formatDuration;
  };

  it('formats sub-minute durations with 1 decimal', async () => {
    const formatDuration = await importFormatDuration();
    expect(formatDuration(0.8)).toBe('0.8s');
    expect(formatDuration(1.0)).toBe('1.0s');
    expect(formatDuration(2.3)).toBe('2.3s');
    expect(formatDuration(9.9)).toBe('9.9s');
    expect(formatDuration(10.5)).toBe('10.5s');
    expect(formatDuration(45.0)).toBe('45.0s');
    expect(formatDuration(59.4)).toBe('59.4s');
  });

  it('formats minute+ durations as minutes and seconds', async () => {
    const formatDuration = await importFormatDuration();
    expect(formatDuration(60)).toBe('1m 0s');
    expect(formatDuration(90)).toBe('1m 30s');
    expect(formatDuration(300)).toBe('5m 0s');
    expect(formatDuration(323)).toBe('5m 23s');
    expect(formatDuration(3599)).toBe('59m 59s');
  });

  it('formats hour+ durations as hours and minutes', async () => {
    const formatDuration = await importFormatDuration();
    expect(formatDuration(3600)).toBe('1h 0m');
    expect(formatDuration(4500)).toBe('1h 15m');
    expect(formatDuration(7200)).toBe('2h 0m');
    expect(formatDuration(86399)).toBe('23h 59m');
  });

  it('formats day+ durations as days and hours', async () => {
    const formatDuration = await importFormatDuration();
    expect(formatDuration(86400)).toBe('1d 0h');
    expect(formatDuration(129600)).toBe('1d 12h');
    expect(formatDuration(172800)).toBe('2d 0h');
    expect(formatDuration(302400)).toBe('3d 12h');
    expect(formatDuration(518400)).toBe('6d 0h');
  });

  it('formats week+ durations as weeks and days', async () => {
    const formatDuration = await importFormatDuration();
    expect(formatDuration(604800)).toBe('1w 0d');
    expect(formatDuration(907200)).toBe('1w 3d');
    expect(formatDuration(1209600)).toBe('2w 0d');
    expect(formatDuration(1814400)).toBe('3w 0d');
    expect(formatDuration(2419200)).toBe('4w 0d');
  });

  it('formats month+ durations as months and days', async () => {
    const formatDuration = await importFormatDuration();
    expect(formatDuration(2592000)).toBe('1mo 0d');
    expect(formatDuration(2851200)).toBe('1mo 3d');
    expect(formatDuration(5184000)).toBe('2mo 0d');
    expect(formatDuration(7776000)).toBe('3mo 0d');
    expect(formatDuration(9504000)).toBe('3mo 2w');
  });

  it('handles large multi-month durations', async () => {
    const formatDuration = await importFormatDuration();
    expect(formatDuration(15552000)).toBe('6mo 0d');
    expect(formatDuration(31536000)).toBe('12mo 5d');
    expect(formatDuration(63072000)).toBe('24mo 1w');
  });

  it('rounds correctly for multi-unit durations', async () => {
    const formatDuration = await importFormatDuration();
    expect(formatDuration(89.9)).toBe('1m 30s');
    expect(formatDuration(90.1)).toBe('1m 30s');
  });
});
