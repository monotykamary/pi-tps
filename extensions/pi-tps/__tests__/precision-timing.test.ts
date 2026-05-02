import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AssistantMessage } from '@mariozechner/pi-ai';
import { createTestFixture, activateExtension, tick } from './helpers';

describe('pi-tps extension — precision timing (performance.now())', () => {
  let fixture: ReturnType<typeof createTestFixture>;

  beforeEach(async () => {
    fixture = createTestFixture();
    await activateExtension(fixture);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Drive a full turn with mocked performance.now() timestamps.
   * This avoids real-timer flakiness and tests sub-millisecond precision
   * that Date.now() (1ms floor) would lose.
   *
   * `streamUpdates` provides timestamps for non-TTFT message_update events.
   * At least MIN_STREAM_UPDATES (5) entries with a non-zero span are now
   * required for inter-update TPS. Fewer updates falls back to generationMs
   * (if generationMs > 2× streamMs) or null.
   */
  function driveTurn(clocks: {
    turnStart: number;
    messageStart: number;
    firstUpdate: number;
    streamUpdates: number[];
    messageEnd: number;
    turnEnd?: number;
  }) {
    const { handlers, notifySpy, appendEntrySpy } = fixture;

    // Explicit sequence of performance.now() return values in call order:
    // turnStartMs, lastUpdateMs (both at turn start), message_start,
    // first message_update (TTFT), each streaming message_update,
    // message_end, turnEndMs
    const timestamps = [
      clocks.turnStart, // turnStartMs
      clocks.turnStart, // lastUpdateMs (same moment as turn start)
      clocks.messageStart, // message_start: currentMessageStartMs + lastUpdateMs reset
      clocks.firstUpdate, // message_update (TTFT): firstTokenMs
      ...clocks.streamUpdates, // streaming message_update events
      clocks.messageEnd, // message_end: generation time end
      clocks.turnEnd ?? clocks.messageEnd, // turnEndMs
    ];

    let callIdx = 0;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => {
      return timestamps[Math.min(callIdx++, timestamps.length - 1)];
    });

    const assistantMessage: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Short reply' }],
      api: 'openai-completions',
      provider: 'openai',
      model: 'gpt-4',
      usage: {
        input: 50,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 70,
        cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    };

    handlers['turn_start']?.({ type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    handlers['message_start']?.({ type: 'message_start', message: assistantMessage });
    // TTFT update
    handlers['message_update']?.({
      type: 'message_update',
      message: assistantMessage,
      assistantMessageEvent: { type: 'text_delta', delta: 't' },
    });
    // Streaming updates (each is a non-TTFT message_update)
    for (const _ts of clocks.streamUpdates) {
      handlers['message_update']?.({
        type: 'message_update',
        message: assistantMessage,
        assistantMessageEvent: { type: 'text_delta', delta: 't' },
      });
    }
    handlers['message_end']?.({ type: 'message_end', message: assistantMessage });
    handlers['turn_end']?.(
      { type: 'turn_end', turnIndex: 0, message: assistantMessage, toolResults: [] },
      fixture.mockCtx
    );

    spy.mockRestore();
    return { notifySpy, appendEntrySpy };
  }

  it('should produce realistic TPS with sufficient streaming updates (≥5)', () => {
    const { notifySpy, appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 200,
      firstUpdate: 200.123,
      streamUpdates: [400, 500, 600, 700, 800],
      messageEnd: 900,
    });

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;
    const tpsMatch = notification.match(/TPS (\d+(?:\.\d+)?) tok\/s/);
    expect(tpsMatch).toBeTruthy();
    const tps = parseFloat(tpsMatch![1]);
    // 20 tokens / 0.4s (streamMs: 800 - 400) = 50.0 TPS
    expect(tps).toBeGreaterThanOrEqual(40);
    expect(tps).toBeLessThanOrEqual(60);

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.timing.generationMs).toBeGreaterThanOrEqual(690);
    expect(data.timing.ttftMs).toBeGreaterThanOrEqual(190);
    expect(data.timing.streamMs).toBe(400); // 800 - 400
  });

  it('should capture sub-millisecond TTFT precision', () => {
    const { appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 23.456,
      firstUpdate: 23.579,
      streamUpdates: [100, 200, 300, 400, 523],
      messageEnd: 523.456,
    });

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.timing.ttftMs).toBeGreaterThanOrEqual(23);
    expect(data.timing.ttftMs).toBeLessThanOrEqual(24);
  });

  it('should produce null TPS when all streaming updates arrive in a burst (≤4 updates)', () => {
    // Simulates the read-command case: updates fire in quick burst with few chunks.
    // With only 1 post-TTFT update, updateCount=1 < MIN_STREAM_UPDATES=5.
    const { notifySpy, appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 100,
      firstUpdate: 100.05,
      streamUpdates: [100.05], // 1 post-TTFT update
      messageEnd: 100.5,
    });

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;
    // TPS shown as dash — not enough chunks for meaningful rate
    expect(notification).toContain('TPS —');

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.timing.generationMs).toBeGreaterThan(0);
    expect(data.timing.streamMs).toBe(0);
    expect(data.tps).toBeNull();
  });

  it('should use performance.now() consistently across all timing events', () => {
    const { handlers, appendEntrySpy } = fixture;
    const spy = vi.spyOn(performance, 'now');
    // turn_start(2), message_start(1), message_update-TTFT(1),
    // 5 streaming updates(5), message_end(1), turn_end(1) = 11 calls
    // indices: 0-1=turn_start, 2=message_start, 3=TTFT,
    // 4-8=streaming, 9=message_end, 10=turn_end
    const timestamps = [0, 0, 100, 100.001, 100.5, 101, 101.2, 101.4, 101.8, 102, 102];
    let callIdx = 0;
    spy.mockImplementation(() => timestamps[Math.min(callIdx++, timestamps.length - 1)]);

    const assistantMessage: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hi world test example' }],
      api: 'openai-completions',
      provider: 'openai',
      model: 'gpt-4',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
      stopReason: 'stop',
      timestamp: Date.now(),
    };

    handlers['turn_start']?.({ type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    handlers['message_start']?.({ type: 'message_start', message: assistantMessage });
    // TTFT update
    handlers['message_update']?.({
      type: 'message_update',
      message: assistantMessage,
      assistantMessageEvent: { type: 'text_delta', delta: 'H' },
    });
    // Streaming updates (5 = MIN_STREAM_UPDATES)
    for (let i = 0; i < 5; i++) {
      handlers['message_update']?.({
        type: 'message_update',
        message: assistantMessage,
        assistantMessageEvent: { type: 'text_delta', delta: 'i' },
      });
    }
    handlers['message_end']?.({ type: 'message_end', message: assistantMessage });
    handlers['turn_end']?.(
      { type: 'turn_end', turnIndex: 0, message: assistantMessage, toolResults: [] },
      fixture.mockCtx
    );

    const callCount = spy.mock.calls.length;
    spy.mockRestore();

    expect(callCount).toBeGreaterThanOrEqual(4);

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.timing.generationMs).toBeGreaterThan(1);
    // Inter-update span: 101.8 - 100.5 = 1.3ms
    expect(data.timing.streamMs).toBeCloseTo(1.3, 1); // last stream(101.8) - first stream(100.5)
  });

  // ─── Compound gate tests (MIN_STREAM_UPDATES + generationMs fallback) ───

  it('should fallback to generationMs TPS when few chunks but generation time >> burst span', () => {
    // 2 post-TTFT updates (updateCount=2), generationMs (200ms) is >= 50ms floor
    const { notifySpy, appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 50,
      firstUpdate: 50.1,
      streamUpdates: [50.15, 50.3],
      messageEnd: 250,
    });

    expect(notifySpy).toHaveBeenCalledOnce();
    const [, data] = appendEntrySpy.mock.calls[0];
    // Falls back to generationMs: 20 tokens / 0.2s = 100 TPS
    const notification = notifySpy.mock.calls[0][0] as string;
    expect(notification).not.toContain('TPS —');

    const tpsMatch = notification.match(/TPS (\d+(?:\.\d+)?) tok\/s/);
    expect(tpsMatch).toBeTruthy();
    const tps = parseFloat(tpsMatch![1]);
    expect(tps).toBeGreaterThanOrEqual(70);
    expect(tps).toBeLessThanOrEqual(130);

    expect(data.tps).not.toBeNull();
  });

  it('should produce null TPS for fast burst where generationMs ≈ streamMs', () => {
    // 2 post-TTFT updates, generationMs (0.3ms) is NOT > 2× streamMs (0.2ms)
    const { notifySpy, appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 100,
      firstUpdate: 100.1,
      streamUpdates: [100.15, 100.3],
      messageEnd: 100.4,
    });

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;
    expect(notification).toContain('TPS —');

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.tps).toBeNull();
    // Structurally unidentifiable: too few chunks, no reliable timebase
    expect(data.timing.streamMs).toBeGreaterThan(0);
    expect(data.timing.generationMs).toBeLessThan(5);
  });

  it('should return null TPS for exactly 4 post-TTFT updates (just below gate)', () => {
    const { notifySpy, appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 100,
      firstUpdate: 100.1,
      streamUpdates: [101, 102, 103, 104],
      messageEnd: 105,
    });

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;
    expect(notification).toContain('TPS —');

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.tps).toBeNull();
    expect(data.timing.streamMs).toBe(3); // 104 - 101
  });

  it('should return realistic TPS for exactly 5 post-TTFT updates (at gate)', () => {
    const { notifySpy, appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 100,
      firstUpdate: 100.1,
      streamUpdates: [150, 200, 250, 300, 350],
      messageEnd: 400,
    });

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;
    expect(notification).not.toContain('TPS —');

    // 20 tokens / 0.2s (streamMs: 350 - 150) = 100 TPS
    const tpsMatch = notification.match(/TPS (\d+(?:\.\d+)?) tok\/s/);
    expect(tpsMatch).toBeTruthy();
    const tps = parseFloat(tpsMatch![1]);
    expect(tps).toBeGreaterThanOrEqual(90);
    expect(tps).toBeLessThanOrEqual(110);

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.tps).not.toBeNull();
    expect(data.timing.streamMs).toBe(200); // 350 - 150
  });

  it('should allow very high measured TPS when updateCount >= MIN_STREAM_UPDATES and avgGap >= 1ms', () => {
    // 5 updates over 4ms (1ms avg gap) with 20 tokens → 5000 TPS
    // This should NOT be capped — it's a legitimate measurement with enough
    // temporal samples and meaningful inter-chunk gaps.
    const { notifySpy, appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 100,
      firstUpdate: 100.1,
      streamUpdates: [101.1, 102.1, 103.1, 104.1, 105.1],
      messageEnd: 105.5,
    });

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;
    expect(notification).not.toContain('TPS —');

    // 20 tokens / 0.004s (streamMs: 105.1 - 101.1 = 4ms) = 5000 TPS
    const tpsMatch = notification.match(/TPS (\d+(?:\.\d+)?) tok\/s/);
    expect(tpsMatch).toBeTruthy();
    const tps = parseFloat(tpsMatch![1]);
    expect(tps).toBeGreaterThanOrEqual(4_500);
    expect(tps).toBeLessThanOrEqual(5_500);

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.tps).toBeGreaterThanOrEqual(4_500);
  });

  it('should return null TPS when avg inter-chunk gap < 1ms (buffer-flush signature)', () => {
    // 5 updates over 1ms (0.25ms avg gap) — looks like a buffer flush,
    // even with enough update count.
    const { notifySpy, appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 100,
      firstUpdate: 100.1,
      streamUpdates: [100.2, 100.4, 100.6, 100.8, 101.0],
      messageEnd: 101.5,
    });

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;
    // Dispatch overhead dominates: can't distinguish from generation timing
    expect(notification).toContain('TPS —');

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.tps).toBeNull();
  });
});
