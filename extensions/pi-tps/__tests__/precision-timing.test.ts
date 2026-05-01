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
   * At least 2 entries with a non-zero span are required for inter-update TPS.
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

  it('should produce realistic TPS for short generation spans with performance.now()', () => {
    const { notifySpy, appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 200,
      firstUpdate: 200.123,
      streamUpdates: [400, 600],
      messageEnd: 700,
    });

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;
    const tpsMatch = notification.match(/TPS (\d+(?:\.\d+)?) tok\/s/);
    expect(tpsMatch).toBeTruthy();
    const tps = parseFloat(tpsMatch![1]);
    // 20 tokens / 0.2s (inter-update span: 600ms - 400ms) = 100.0 TPS
    expect(tps).toBeGreaterThanOrEqual(90);
    expect(tps).toBeLessThanOrEqual(110);

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.timing.generationMs).toBeGreaterThanOrEqual(490);
    expect(data.timing.ttftMs).toBeGreaterThanOrEqual(190);
    expect(data.timing.streamMs).toBe(200); // 600 - 400
  });

  it('should capture sub-millisecond TTFT precision', () => {
    const { appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 23.456,
      firstUpdate: 23.579,
      streamUpdates: [100, 200, 523],
      messageEnd: 523.456,
    });

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.timing.ttftMs).toBeGreaterThanOrEqual(23);
    expect(data.timing.ttftMs).toBeLessThanOrEqual(24);
  });

  it('should produce null TPS when all streaming updates arrive in a burst', () => {
    // Simulates the read-command case: all updates fire in the same event loop tick,
    // so the inter-update span is 0ms — a degenerate measurement.
    const { notifySpy, appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 100,
      firstUpdate: 100.05,
      streamUpdates: [100.05], // same tick as TTFT → streamMs = 0
      messageEnd: 100.5,
    });

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;
    // TPS should be absent (null) — can't measure rate from a burst
    expect(notification).not.toMatch(/TPS/);

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.timing.generationMs).toBeGreaterThan(0);
    expect(data.timing.streamMs).toBe(0); // burst: no measurable span
    expect(data.tps).toBeNull();
  });

  it('should use performance.now() consistently across all timing events', () => {
    const { handlers, appendEntrySpy } = fixture;
    const spy = vi.spyOn(performance, 'now');
    // turn_start(2), message_start(1), message_update-TTFT(1),
    // 2 streaming updates(2), message_end(1), turn_end(1) = 8 calls
    const timestamps = [0, 0, 100, 100.001, 100.5, 101, 101.234, 101.234];
    let callIdx = 0;
    spy.mockImplementation(() => timestamps[Math.min(callIdx++, timestamps.length - 1)]);

    const assistantMessage: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hi' }],
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
    // Streaming updates
    handlers['message_update']?.({
      type: 'message_update',
      message: assistantMessage,
      assistantMessageEvent: { type: 'text_delta', delta: 'i' },
    });
    handlers['message_update']?.({
      type: 'message_update',
      message: assistantMessage,
      assistantMessageEvent: { type: 'text_delta', delta: '!' },
    });
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
    // Inter-update span: 101 - 100.5 = 0.5ms
    expect(data.timing.streamMs).toBe(0.5);
  });
});
