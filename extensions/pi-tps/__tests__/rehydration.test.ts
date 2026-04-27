import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestFixture, activateExtension, tick } from './helpers';

describe('pi-tps extension — rehydration', () => {
  let fixture: ReturnType<typeof createTestFixture>;

  beforeEach(async () => {
    fixture = createTestFixture();
    await activateExtension(fixture);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Helper to make a structured TPS entry */
  function makeTpsEntry(
    data: {
      provider?: string;
      modelId?: string;
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      total?: number;
      ttftMs?: number;
      totalMs?: number;
      generationMs?: number;
      stallMs?: number;
      stallCount?: number;
      messageCount?: number;
      tps?: number;
    } = {}
  ) {
    return {
      type: 'custom' as const,
      customType: 'tps',
      data: {
        model: { provider: data.provider ?? 'openai', modelId: data.modelId ?? 'gpt-4' },
        tokens: {
          input: data.input ?? 10,
          output: data.output ?? 20,
          cacheRead: data.cacheRead ?? 0,
          cacheWrite: data.cacheWrite ?? 0,
          total: data.total ?? 30,
        },
        timing: {
          ttftMs: data.ttftMs ?? 1000,
          totalMs: data.totalMs ?? 3000,
          generationMs: data.generationMs ?? 2000,
          stallMs: data.stallMs ?? 0,
          stallCount: data.stallCount ?? 0,
          messageCount: data.messageCount ?? 1,
        },
        tps: data.tps ?? 10.0,
        timestamp: Date.now(),
      },
    };
  }

  it('should restore notification on session resume from structured telemetry', async () => {
    const { handlers, notifySpy, mockEntries } = fixture;

    mockEntries.push(
      makeTpsEntry({
        input: 50,
        output: 100,
        total: 150,
        ttftMs: 1200,
        totalMs: 5000,
        generationMs: 4000,
        tps: 25.0,
      })
    );

    handlers['session_start']?.({ reason: 'resume' }, fixture.mockCtx);
    await tick();

    expect(notifySpy).toHaveBeenCalledOnce();
    const msg = notifySpy.mock.calls[0][0] as string;
    expect(msg).toMatch(/TPS 25\.0 tok\/s/);
    expect(msg).toMatch(/TTFT 1\.2s/);
    expect(msg).toMatch(/out 100/);
    expect(msg).toMatch(/in 50/);
    expect(notifySpy).toHaveBeenCalledWith(msg, 'info');
  });

  it('should ignore legacy entries and only rehydrate structured telemetry', async () => {
    const { handlers, notifySpy, mockEntries } = fixture;

    mockEntries.push(
      {
        type: 'custom',
        customType: 'tps',
        data: {
          message: 'TPS 37.9 tok/s · TTFT 1s · 27s · out 998 · in 917',
          timestamp: Date.now() - 500,
        },
      },
      makeTpsEntry({
        input: 273,
        output: 51,
        total: 324,
        ttftMs: 1000,
        totalMs: 3800,
        generationMs: 2400,
        stallMs: 1400,
        stallCount: 1,
        tps: 18.0,
      })
    );

    handlers['session_start']?.({ reason: 'resume' }, fixture.mockCtx);
    await tick();

    expect(notifySpy).toHaveBeenCalledOnce();
    const msg = notifySpy.mock.calls[0][0];
    expect(msg).toContain('TPS 18.0');
    expect(msg).toContain('TTFT 1.0s');
    expect(msg).toContain('stall 1.4s×1');
    expect(msg).not.toContain('TPS 37.9');
  });

  it('should restore notification on session startup (continuing previous session)', async () => {
    const { handlers, notifySpy, mockEntries } = fixture;

    mockEntries.push(makeTpsEntry({ tps: 10.0 }));

    handlers['session_start']?.({ reason: 'startup' }, fixture.mockCtx);
    await tick();

    expect(notifySpy).toHaveBeenCalledOnce();
    expect(notifySpy.mock.calls[0][0]).toMatch(/TPS 10\.0 tok\/s/);
  });

  it('should restore notification on session reload', async () => {
    const { handlers, notifySpy, mockEntries } = fixture;

    mockEntries.push(makeTpsEntry({ tps: 10.0 }));

    handlers['session_start']?.({ reason: 'reload' }, fixture.mockCtx);
    await tick();

    expect(notifySpy).toHaveBeenCalledOnce();
  });

  it('should restore notification on tree navigation', async () => {
    const { handlers, notifySpy, mockEntries } = fixture;

    mockEntries.push(makeTpsEntry({ tps: 10.0 }));

    handlers['session_tree']?.({ newLeafId: 'abc123', oldLeafId: 'def456' }, fixture.mockCtx);
    await tick();

    expect(notifySpy).toHaveBeenCalledOnce();
  });

  it('should rehydrate most recent structured entry, skipping legacy entries', async () => {
    const { handlers, notifySpy, mockEntries } = fixture;

    mockEntries.push(
      {
        type: 'custom',
        customType: 'tps',
        data: { message: 'legacy 1', timestamp: Date.now() - 3000 },
      },
      makeTpsEntry({
        provider: 'a',
        modelId: 'a-1',
        input: 5,
        output: 10,
        total: 15,
        ttftMs: 5000,
        totalMs: 10000,
        generationMs: 8000,
        tps: 1.2,
      }),
      {
        type: 'custom',
        customType: 'tps',
        data: { message: 'legacy 2', timestamp: Date.now() - 1000 },
      },
      makeTpsEntry({
        provider: 'b',
        modelId: 'b-1',
        input: 50,
        output: 500,
        total: 550,
        ttftMs: 2000,
        totalMs: 8000,
        generationMs: 6000,
        stallMs: 500,
        stallCount: 1,
        messageCount: 2,
        tps: 83.3,
      })
    );

    handlers['session_start']?.({ reason: 'resume' }, fixture.mockCtx);
    await tick();

    expect(notifySpy).toHaveBeenCalledOnce();
    const msg = notifySpy.mock.calls[0][0];
    expect(msg).toContain('TPS 83.3');
    expect(msg).toContain('stall');
    expect(msg).not.toContain('legacy');
  });
});
