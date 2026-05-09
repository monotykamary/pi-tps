import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createTestFixture, activateExtension } from './helpers';
import type { MessageUpdateEvent } from './helpers';

/**
 * Tests partial stall reduction in the fallback branch.
 *
 * When stalls dominate the effective generation window (effectiveGenMs < 200ms
 * OR stallMs > 85% of generationMs), the raw TPS would explode because the
 * denominator is tiny. Partial reduction divides stallMs by 2 before subtracting
 * it, giving a much larger safe denominator and a saner TPS.
 */
describe('pi-tps extension — partial stall reduction', () => {
  let fixture: ReturnType<typeof createTestFixture>;

  beforeEach(async () => {
    fixture = createTestFixture();
    await activateExtension(fixture);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Drive a full turn with mocked performance.now() so every
   * timestamp is deterministic (no real timers needed).
   */
  function driveTurn(clocks: {
    turnStart: number;
    messageStart: number;
    firstUpdate: number;
    streamUpdates: number[];
    messageEnd: number;
    turnEnd?: number;
  }) {
    const { handlers, appendEntrySpy } = fixture;

    const timestamps = [
      clocks.turnStart,
      clocks.turnStart,
      clocks.messageStart,
      clocks.firstUpdate,
      ...clocks.streamUpdates,
      clocks.messageEnd,
      clocks.turnEnd ?? clocks.messageEnd,
    ];

    let callIdx = 0;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => {
      return timestamps[Math.min(callIdx++, timestamps.length - 1)];
    });

    const assistantMessage: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text' as const, text: 'x'.repeat(5000) }],
      api: 'openai-completions',
      provider: 'openai',
      model: 'gpt-4',
      usage: {
        input: 100,
        output: 5000,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 5100,
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
    return { appendEntrySpy };
  }

  it('partially reduces stalls when effectiveGenMs is tiny', () => {
    // generationMs ~ 50_300, stallMs ~ 50_120
    // effectiveGenMs = 50_300 - 50_120 = 180  (< ACTIVE_TIME_THRESHOLD=200)
    // stallMs (50_120) > effectiveGenMs (180) → partial reduction kicks in
    // safeGenMs = max(50_300 - 50_120/2, 50) = max(25_240, 50) = 25_240
    // raw = 5_000 / 25.24 = 198.1
    // Without partial reduction: 5_000 / 0.18 = 27_778
    const { appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 100,
      firstUpdate: 200,
      streamUpdates: [250, 300],
      messageEnd: 50400,
    });

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.tps).not.toBeNull();
    expect(data.tps).toBeLessThan(300);
    expect(data.tps).toBeGreaterThan(50);
  });

  it('partially reduces stalls when stallMs dominates generationMs', () => {
    // generationMs = 15_000, stallMs = 13_500
    // effectiveGenMs = 1_500  (>200 so absolute threshold NOT hit)
    // BUT stallMs/genMs ratio = 90% > STALL_DOMINANCE_RATIO (85%)
    // → partial reduction kicks in via ratio branch
    // safeGenMs = max(15_000 - 13_500/2, 50) = max(8_250, 50) = 8_250
    // raw = 5_000 / 8.25 = 606
    // Without partial reduction: 5_000 / 1.5 = 3_333
    const { appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 50,
      firstUpdate: 150,
      streamUpdates: [300, 800],
      messageEnd: 15050,
    });

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.tps).not.toBeNull();
    expect(data.tps).toBeLessThan(700);
    expect(data.tps).toBeGreaterThan(100);
  });
});
