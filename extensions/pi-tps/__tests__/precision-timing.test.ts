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
   */
  function driveTurn(clocks: {
    turnStart: number;
    messageStart: number;
    firstUpdate: number;
    messageEnd: number;
  }) {
    const { handlers, notifySpy, appendEntrySpy } = fixture;
    const callLog: number[] = [];
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => {
      const next =
        callLog.length < Object.values(clocks).length
          ? Object.values(clocks)[callLog.length]
          : clocks.messageEnd;
      callLog.push(next);
      return next;
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
    handlers['message_update']?.({
      type: 'message_update',
      message: assistantMessage,
      assistantMessageEvent: { type: 'text_delta', delta: 't' },
    });
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
      messageEnd: 700,
    });

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;
    const tpsMatch = notification.match(/TPS (\d+(?:\.\d+)?) tok\/s/);
    expect(tpsMatch).toBeTruthy();
    const tps = parseFloat(tpsMatch![1]);
    // 20 tokens / 0.5s = 40.0 TPS
    expect(tps).toBeGreaterThanOrEqual(35);
    expect(tps).toBeLessThanOrEqual(45);

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.timing.generationMs).toBeGreaterThanOrEqual(490);
    expect(data.timing.ttftMs).toBeGreaterThanOrEqual(190);
  });

  it('should capture sub-millisecond TTFT precision', () => {
    const { appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 23.456,
      firstUpdate: 23.579,
      messageEnd: 523.456,
    });

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.timing.ttftMs).toBeGreaterThanOrEqual(23);
    expect(data.timing.ttftMs).toBeLessThanOrEqual(24);
  });

  it('should not lose telemetry when generation spans < 1ms with Date.now() resolution', () => {
    const { notifySpy, appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 100,
      firstUpdate: 100.05,
      messageEnd: 100.5,
    });

    expect(notifySpy).toHaveBeenCalledOnce();
    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.timing.generationMs).toBeGreaterThan(0);
    expect(data.tps).toBeGreaterThan(0);
  });

  it('should use performance.now() consistently across all timing events', () => {
    const { handlers, appendEntrySpy } = fixture;
    const spy = vi.spyOn(performance, 'now');
    const timestamps = [0, 100, 100.001, 101.234];
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
    handlers['message_update']?.({
      type: 'message_update',
      message: assistantMessage,
      assistantMessageEvent: { type: 'text_delta', delta: 'H' },
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
  });
});
