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

  it('should return null TPS when streaming span is <50ms even with genuine high-speed generation', () => {
    // 5 updates over 4ms (1ms avg gap) with 20 tokens → 5000 TPS if measured.
    // But effectiveStreamMs=4ms is below the 50ms reliability floor: we can't
    // distinguish genuine 5000 tok/s generation from a buffer-flush dispatch
    // of pre-generated tokens in under 50ms. So we return null rather than
    // risk overshooting.
    //
    // This also fails the fallback: generationMs (5.5ms) < 50ms → null.
    const { notifySpy, appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 100,
      firstUpdate: 100.1,
      streamUpdates: [101.1, 102.1, 103.1, 104.1, 105.1],
      messageEnd: 105.5,
    });

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;
    // Span too short for reliable generation speed — null is correct
    expect(notification).toContain('TPS —');

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.tps).toBeNull();
  });

  it('should fallback to effective-genMs TPS when stall dominates stream window (stall-before-stream)', () => {
    // Real-world bug: a stall between TTFT and the first stream update
    // causes firstStreamUpdateMs to be set AFTER the stall, making
    // streamMs only cover the post-stall burst. Without the stall guard,
    // TPS = output / streamMs gives wildly inflated values (e.g. 1934 tok/s
    // from a 121ms burst within a 5843ms generation window).
    //
    // Timeline: TTFT at 2600ms, stall of ~4200ms, then 10 updates in 90ms.
    // The stall is detected on the second message_update (first stream update),
    // so firstStreamUpdateMs = 6800ms (post-stall) and streamMs = 90ms.
    // stallMs (4200) > streamMs (90), so primary branch is skipped.
    // Fallback: effectiveGenMs = generationMs - stallMs = 6900 - 4200 = 2700ms.
    // TPS = 20 / 2.7 ≈ 7.4 tok/s (sane, not 222).
    const { notifySpy, appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 100,
      firstUpdate: 2600, // TTFT
      streamUpdates: [
        // Second update (first stream update) arrives after ~4200ms stall
        6800, 6810, 6820, 6830, 6840, 6850, 6860, 6870, 6880, 6890,
      ],
      messageEnd: 7000,
      turnEnd: 7000,
    });

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;
    expect(notification).not.toContain('TPS —');

    const tpsMatch = notification.match(/TPS (\d+(?:\.\d+)?) tok\/s/);
    expect(tpsMatch).toBeTruthy();
    const tps = parseFloat(tpsMatch![1]);

    // Must NOT be in the thousands — fallback gives effective-genMs TPS
    // effectiveGenMs = 6900 - 4200 = 2700ms → 20 / 2.7 ≈ 7.4 tok/s
    expect(tps).toBeLessThan(30);
    expect(tps).toBeGreaterThan(3);

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.timing.stallMs).toBeGreaterThanOrEqual(4000);
    expect(data.timing.streamMs).toBeLessThanOrEqual(100);
    // stallMs > streamMs → primary branch skipped, fallback used
    expect(data.tps).toBeLessThan(30);
  });

  it('should compute generation TPS with stall subtraction via fallback when stalls dominate active time', () => {
    // A stall occurs WITHIN the streaming window (between two updates).
    // stallMs (2000) > effectiveStreamMs (800) → the stall dominates the
    // streaming window, so PRIMARY is skipped. FALLBACK gives effective-genMs
    // rate: includes TTFT, so it underestimates, but never overshoots.
    const { notifySpy, appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 100,
      firstUpdate: 100.1,
      // 10 updates: first 5 in a burst, then a 2s stall, then 5 more
      streamUpdates: [200, 300, 400, 500, 600, 2600, 2700, 2800, 2900, 3000],
      messageEnd: 3100,
    });

    expect(notifySpy).toHaveBeenCalledOnce();
    const [, data] = appendEntrySpy.mock.calls[0];
    // streamMs = 3000 - 200 = 2800ms (includes the 2s stall)
    expect(data.timing.streamMs).toBe(2800);
    // stallMs should include the ~2000ms gap
    expect(data.timing.stallMs).toBeGreaterThanOrEqual(1900);
    // stallMs (2000) > effectiveStreamMs (800) → PRIMARY skipped
    // FALLBACK: effectiveGenMs = max(3000 - 2000, 50) = 1000ms
    // TPS = 20 / 1.0 = 20.0 tok/s (includes TTFT, underestimates gen speed)
    const tpsMatch = (notifySpy.mock.calls[0][0] as string).match(/TPS (\d+(?:\.\d+)?) tok\/s/);
    expect(tpsMatch).toBeTruthy();
    const tps = parseFloat(tpsMatch![1]);
    expect(tps).toBeGreaterThanOrEqual(15);
    expect(tps).toBeLessThanOrEqual(30);
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

  // ─── Stall guard edge cases ────────────────────────────────────────────────

  it('should use wall-clock streamMs (no stall subtraction) when stallMs is zero', () => {
    // Baseline: no stalls, primary branch uses raw streamMs.
    const { appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 100,
      firstUpdate: 100.1,
      streamUpdates: [200, 300, 400, 500, 600],
      messageEnd: 700,
    });

    const [, data] = appendEntrySpy.mock.calls[0];
    // streamMs = 600 - 200 = 400ms
    expect(data.timing.streamMs).toBe(400);
    expect(data.timing.stallMs).toBe(0);
    // 20 tokens / 0.4s = 50 tok/s
    expect(data.tps).toBe(50);
  });

  it('should fallback when effectiveStreamMs < 50ms even though stallMs < streamMs', () => {
    // Critical edge case: streamMs=1051, stallMs=998 → effectiveStreamMs=53ms.
    // The 53ms remainder could be a buffer-flush dispatch of pre-generated
    // tokens after a 998ms stall, not sustained inference. The 50ms floor
    // catches this: effectiveStreamMs < 50ms → fall to fallback (genMs).
    const { notifySpy, appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 100,
      firstUpdate: 100.1,
      // 6 updates with gaps: 10ms, 10ms, 10ms, 10ms, 998ms (stall), 10ms
      // streamMs = 1148.1 - 110.1 = 1038ms
      // stallMs ≈ 998ms
      // effectiveStreamMs = 1038 - 998 = 40ms < 50ms → FALLBACK
      streamUpdates: [110.1, 120.1, 130.1, 140.1, 1138.1, 1148.1],
      messageEnd: 1200,
    });

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.timing.streamMs).toBeGreaterThan(1000);
    expect(data.timing.stallMs).toBeGreaterThanOrEqual(900);
    // Fallback: effectiveGenMs = max(1100 - 998, 50) = 102ms
    // 20 / 0.102 = ~196 tok/s (includes TTFT, so underestimates gen speed)
    const tpsMatch = (notifySpy.mock.calls[0][0] as string).match(/TPS (\d+(?:\.\d+)?) tok\/s/);
    expect(tpsMatch).toBeTruthy();
    const tps = parseFloat(tpsMatch![1]);
    expect(tps).toBeLessThan(300); // not inflated (not 500+)
    expect(tps).toBeGreaterThan(0);
  });

  it('should fallback when effectiveStreamMs < 50ms at stallMs ≈ streamMs boundary', () => {
    // streamMs ≈ 530ms, stallMs ≈ 500ms → effectiveStreamMs ≈ 30ms < 50ms
    // Falls to fallback: effectiveGenMs (includes TTFT, underestimates)
    const { notifySpy, appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 100,
      firstUpdate: 100.1,
      streamUpdates: [600.1, 1100.1, 1110.1, 1120.1, 1130.1],
      messageEnd: 1200,
    });

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.timing.stallMs).toBeGreaterThanOrEqual(400);
    // Should NOT be inflated (not 600+)
    expect(data.tps).toBeLessThan(200);
    expect(data.tps).not.toBeNull();
  });

  it('should produce null TPS when both primary and fallback conditions fail', () => {
    // Few updates AND short generation time
    const { notifySpy, appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 10,
      firstUpdate: 10.1,
      streamUpdates: [10.15, 10.2], // only 2 updates, genMs < 50ms
      messageEnd: 10.5,
    });

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;
    expect(notification).toContain('TPS —');

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.tps).toBeNull();
  });

  it('should compute generation TPS via PRIMARY branch when stallMs < effectiveStreamMs', () => {
    // A moderate stall occurs within the streaming window but doesn't
    // dominate it: 500ms stall in a 2000ms window → effectiveStreamMs = 1500ms.
    // stallMs (500) < effectiveStreamMs (1500) → PRIMARY branch fires.
    // Generation TPS = 20 / 1.5 = 13.3 tok/s (raw inference speed)
    const { notifySpy, appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 100,
      firstUpdate: 100.1,
      // Updates: 5 at 200ms gaps, 500ms stall, then 5 at 200ms gaps
      // streamMs = 4900 - 200 = 4700ms
      // stallMs = 500ms
      // effectiveStreamMs = 4700 - 500 = 4200ms
      // stallMs (500) < effectiveStreamMs (4200) → PRIMARY
      streamUpdates: [200, 400, 600, 800, 1000, 1500, 1700, 1900, 2100, 2300],
      messageEnd: 2500,
    });

    expect(notifySpy).toHaveBeenCalledOnce();
    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.timing.streamMs).toBe(2100); // 2300 - 200
    expect(data.timing.stallMs).toBeGreaterThanOrEqual(400);
    // PRIMARY: effectiveStreamMs = 2100 - 500 = 1600ms
    // 20 / 1.6 = 12.5 tok/s
    const tpsMatch = (notifySpy.mock.calls[0][0] as string).match(/TPS (\d+(?:\.\d+)?) tok\/s/);
    expect(tpsMatch).toBeTruthy();
    const tps = parseFloat(tpsMatch![1]);
    expect(tps).toBeGreaterThanOrEqual(10);
    expect(tps).toBeLessThanOrEqual(20);
    // Verify: this should match output / (effectiveStreamMs / 1000)
    const effectiveStreamMs = data.timing.streamMs - data.timing.stallMs;
    expect(data.tps).toBeCloseTo(20 / (effectiveStreamMs / 1000), 0);
  });

  it('should fallback when stallMs exactly equals effectiveStreamMs (50/50 boundary)', () => {
    // streamMs = 2000, stallMs = 1000, effectiveStreamMs = 1000
    // stallMs(1000) < effectiveStreamMs(1000)? NO (equal) → FALLBACK
    // This prevents counting buffer-flush dispatches as generation.
    const { notifySpy, appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 100,
      firstUpdate: 100.1,
      // streamMs = 2100 - 100 = 2000ms
      // stall from 600→1600 = 1000ms
      streamUpdates: [100, 200, 300, 400, 500, 1600, 1700, 1800, 1900, 2100],
      messageEnd: 2200,
    });

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.timing.streamMs).toBe(2000);
    expect(data.timing.stallMs).toBeGreaterThanOrEqual(900);
    // stallMs ≈ effectiveStreamMs → FALLBACK (includes TTFT)
    expect(data.tps).not.toBeNull();
    expect(data.tps!).toBeLessThan(50); // no inflation
  });

  it('should handle stall-before-stream with zero streamMs (all updates in one tick after stall)', () => {
    // TTFT, then a long stall, then ALL stream updates arrive in the same tick
    // → streamMs = 0 (or near-zero) → primary fails, fallback kicks in
    const { notifySpy, appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 100,
      firstUpdate: 5000, // TTFT at 5s
      // All stream updates arrive simultaneously (buffered after stall)
      streamUpdates: [6000, 6000, 6000, 6000, 6000],
      messageEnd: 6100,
    });

    const [, data] = appendEntrySpy.mock.calls[0];
    // streamMs ≈ 0 → primary fails (streamMs < MIN_STREAM_MS)
    // Fallback: generationMs >= 50ms → effectiveGenMs
    expect(data.timing.streamMs).toBeLessThan(5);
    expect(data.tps).not.toBeNull();
    expect(data.tps).toBeLessThan(100); // no inflation
  });

  it('should produce consistent TPS for multi-message turn with stalls', () => {
    // Two messages per turn, each with a stall.
    // The stall detector resets on message_start, so stalls should be
    // tracked per-message but accumulated across the turn.
    const { handlers, notifySpy, appendEntrySpy } = fixture;

    const msg1: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'First' }],
      api: 'openai-completions',
      provider: 'openai',
      model: 'gpt-4',
      usage: {
        input: 50,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 150,
        cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
      },
      stopReason: 'toolUse',
      timestamp: Date.now(),
    };
    const msg2: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Second' }],
      api: 'openai-completions',
      provider: 'openai',
      model: 'gpt-4',
      usage: {
        input: 50,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 150,
        cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    };

    const timestamps = [
      0, // turn_start (turnStartMs)
      0, // turn_start (lastUpdateMs)
      100, // message_start 1 (currentMessageStartMs)
      200, // message_update TTFT 1
      300, // message_update stream 1
      400, // message_update stream 2
      500, // message_update stream 3
      600, // message_update stream 4
      700, // message_update stream 5
      1200, // message_update stream 6 (500ms stall gap)
      1300, // message_end 1 (generationMs end)
      1400, // message_start 2 (resets stall tracking)
      1500, // message_update TTFT 2
      1600, // message_update stream 1
      1700, // message_update stream 2
      1800, // message_update stream 3
      1900, // message_update stream 4
      2000, // message_update stream 5
      2500, // message_update stream 6 (500ms stall gap)
      2600, // message_end 2
      2600, // turn_end
    ];
    let callIdx = 0;
    const spy = vi
      .spyOn(performance, 'now')
      .mockImplementation(() => timestamps[Math.min(callIdx++, timestamps.length - 1)]);

    handlers['turn_start']?.({ type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    handlers['message_start']?.({ type: 'message_start', message: msg1 });
    handlers['message_update']?.({
      type: 'message_update',
      message: msg1,
      assistantMessageEvent: { type: 'text_delta', delta: 't' },
    }); // TTFT
    for (let i = 0; i < 6; i++) {
      handlers['message_update']?.({
        type: 'message_update',
        message: msg1,
        assistantMessageEvent: { type: 'text_delta', delta: 't' },
      }); // stream
    }
    handlers['message_end']?.({ type: 'message_end', message: msg1 });
    handlers['message_start']?.({ type: 'message_start', message: msg2 }); // resets stall
    handlers['message_update']?.({
      type: 'message_update',
      message: msg2,
      assistantMessageEvent: { type: 'text_delta', delta: 't' },
    }); // TTFT
    for (let i = 0; i < 6; i++) {
      handlers['message_update']?.({
        type: 'message_update',
        message: msg2,
        assistantMessageEvent: { type: 'text_delta', delta: 't' },
      }); // stream
    }
    handlers['message_end']?.({ type: 'message_end', message: msg2 });
    handlers['turn_end']?.(
      { type: 'turn_end', turnIndex: 0, message: msg2, toolResults: [] },
      fixture.mockCtx
    );
    spy.mockRestore();

    expect(notifySpy).toHaveBeenCalledOnce();
    const [, data] = appendEntrySpy.mock.calls[0];
    // Two messages, each with 100 output, total output = 200
    expect(data.tokens.output).toBe(200);
    expect(data.timing.messageCount).toBe(2);
    // Should have stalls from both messages
    expect(data.timing.stallCount).toBeGreaterThanOrEqual(2);
    // TPS should be sane (not in the thousands)
    expect(data.tps).toBeLessThan(200);
  });
});
