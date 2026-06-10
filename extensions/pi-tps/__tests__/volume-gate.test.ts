import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createTestFixture, activateExtension } from './helpers';

describe('pi-tps extension — volume-based TPS gate', () => {
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
   * Customizable output token count for volume-based testing.
   *
   * Timestamp mapping (one performance.now() per handler call):
   *   [0] turn_start   → turnStartMs, lastUpdateMs
   *   [1] turn_start   → (second call — same init)
   *   [2] message_start → currentMessageStartMs, lastUpdateMs reset
   *   [3] message_update (TTFT) → firstTokenMs, lastUpdateMs
   *   [4..4+n-1] message_update (stream) → each streamUpdate timestamp
   *   [4+n] message_end → generation time end
   *   [5+n] turn_end → total time
   *
   * streamMs = last streamUpdate - first streamUpdate (not total window!)
   * updateCount = streamUpdates.length (post-TTFT events)
   */
  function driveTurn(clocks: {
    turnStart: number;
    messageStart: number;
    firstUpdate: number;
    streamUpdates: number[];
    messageEnd: number;
    turnEnd?: number;
    output: number;
    input?: number;
    isToolCall?: boolean;
  }) {
    const { handlers, notifySpy, appendEntrySpy } = fixture;

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

    const input = clocks.input ?? 50;
    const assistantMessage: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Response' }],
      api: 'openai-completions',
      provider: 'openai',
      model: 'gpt-4',
      usage: {
        input,
        output: clocks.output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: input + clocks.output,
        cost: {
          input: 0.001,
          output: 0.002,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.003,
        },
      },
      stopReason: clocks.isToolCall ? 'toolUse' : 'stop',
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

    if (clocks.isToolCall) {
      handlers['tool_execution_start']?.({
        type: 'tool_execution_start',
        toolCallId: 'call_123',
        toolName: 'bash',
        args: { command: 'ls' },
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

  // ── Primary branch: volume gate ────────────────────────────────────────

  it('should null TPS when primary-branch TPS exceeds plausibility ceiling', () => {
    // streamUpdates: [400, 450, 500, 550, 600] → streamMs = 200ms
    // 3000 tokens / 0.2s = 15,000 TPS — exceeds 10,000 ceiling
    const { appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 200,
      firstUpdate: 200.123,
      streamUpdates: [400, 450, 500, 550, 600],
      messageEnd: 700,
      output: 3000,
    });

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.tps).toBeNull();
    expect(data.isPrimaryBranch).toBe(false);
  });

  it('should preserve primary-branch TPS when it is within plausibility', () => {
    // streamUpdates: [400, 500, 600, 700, 800] → streamMs = 400ms
    // 1000 tokens / 0.4s = 2,500 TPS — well within 10,000 ceiling
    const { appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 200,
      firstUpdate: 200.123,
      streamUpdates: [400, 500, 600, 700, 800],
      messageEnd: 900,
      output: 1000,
    });

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.tps).not.toBeNull();
    expect(data.tps).toBeGreaterThanOrEqual(2000);
    expect(data.tps).toBeLessThanOrEqual(3000);
    expect(data.isPrimaryBranch).toBe(true);
  });

  it('should preserve primary-branch TPS for high volume with long enough window', () => {
    // streamUpdates: [500, 600, 700, 800, 1000] → streamMs = 500ms
    // 3000 tokens / 0.5s = 6,000 TPS — within ceiling
    const { appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 200,
      firstUpdate: 200.123,
      streamUpdates: [500, 600, 700, 800, 1000],
      messageEnd: 1100,
      output: 3000,
    });

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.tps).not.toBeNull();
    expect(data.tps).toBeGreaterThanOrEqual(5500);
    expect(data.tps).toBeLessThanOrEqual(6500);
    expect(data.isPrimaryBranch).toBe(true);
  });

  it('should null TPS for very large token volume over minimum effective span', () => {
    // streamUpdates: [400, 450, 500, 550, 600] → streamMs = 200ms
    // 5000 tokens / 0.2s = 25,000 TPS — well beyond ceiling
    const { appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 200,
      firstUpdate: 200.123,
      streamUpdates: [400, 450, 500, 550, 600],
      messageEnd: 700,
      output: 5000,
    });

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.tps).toBeNull();
    expect(data.isPrimaryBranch).toBe(false);
  });

  // ── Fallback branch: volume gate ───────────────────────────────────────

  it('should null TPS when fallback-branch TPS exceeds plausibility ceiling', () => {
    // 2 updates (fallback branch), generationMs = 200ms
    // 3000 tokens / 0.2s = 15,000 TPS — exceeds ceiling
    const { appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 50,
      firstUpdate: 50.1,
      streamUpdates: [50.15, 50.3],
      messageEnd: 250,
      output: 3000,
    });

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.tps).toBeNull();
  });

  it('should preserve fallback-branch TPS when it is within plausibility', () => {
    // 2 updates (fallback branch), generationMs = 200ms
    // 400 tokens / 0.2s = 2,000 TPS — within ceiling
    const { appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 50,
      firstUpdate: 50.1,
      streamUpdates: [50.15, 50.3],
      messageEnd: 250,
      output: 400,
    });

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.tps).not.toBeNull();
    expect(data.tps).toBeGreaterThanOrEqual(1500);
    expect(data.tps).toBeLessThanOrEqual(2500);
  });

  // ── Boundary: exactly at ceiling ──────────────────────────────────────

  it('should preserve TPS when exactly at the plausibility ceiling (not exceeded)', () => {
    // streamUpdates: [400, 450, 500, 550, 600] → streamMs = 200ms
    // 2000 tokens / 0.2s = 10,000 TPS — exactly at ceiling, not > ceiling
    const { appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 200,
      firstUpdate: 200.123,
      streamUpdates: [400, 450, 500, 550, 600],
      messageEnd: 700,
      output: 2000,
    });

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.tps).not.toBeNull();
    expect(data.tps).toBeGreaterThanOrEqual(9900);
    expect(data.tps).toBeLessThanOrEqual(10100);
    expect(data.isPrimaryBranch).toBe(true);
  });

  it('should null TPS just above the plausibility ceiling', () => {
    // streamUpdates: [400, 450, 500, 550, 600] → streamMs = 200ms
    // 2100 tokens / 0.2s = 10,500 TPS — just above threshold
    const { appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 200,
      firstUpdate: 200.123,
      streamUpdates: [400, 450, 500, 550, 600],
      messageEnd: 700,
      output: 2100,
    });

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.tps).toBeNull();
    expect(data.isPrimaryBranch).toBe(false);
  });

  // ── Notification display ──────────────────────────────────────────────

  it('should show TPS dash when volume gate nulls TPS', () => {
    const { notifySpy } = driveTurn({
      turnStart: 0,
      messageStart: 200,
      firstUpdate: 200.123,
      streamUpdates: [400, 450, 500, 550, 600],
      messageEnd: 700,
      output: 3000,
    });

    const notification = notifySpy.mock.calls[0][0] as string;
    expect(notification).toContain('TPS —');
  });

  // ── Interaction with dynamic TPS cap ──────────────────────────────────

  it('should not let volume-gated turns set the dynamic TPS cap', () => {
    // Turn 1: 3000 tokens / 0.2s = 15,000 TPS — volume gates to null.
    // The cap condition requires isPrimaryBranch && tps !== null,
    // both of which are false after the volume gate. So the cap
    // should NOT be set from this turn.
    driveTurn({
      turnStart: 0,
      messageStart: 200,
      firstUpdate: 200.123,
      streamUpdates: [400, 450, 500, 550, 600],
      messageEnd: 700,
      output: 3000,
    });

    const [, data1] = fixture.appendEntrySpy.mock.calls[0];
    expect(data1.tps).toBeNull();
    expect(data1.isPrimaryBranch).toBe(false);

    // Turn 2: reliable non-tool-call streaming at ~50 TPS (20 tokens / 0.4s)
    // This should set the cap at ~50 TPS, not at 15,000.
    // If the volume-gated turn had set the cap at 15,000, the cap
    // would be 15,000 and a subsequent tool call would be allowed
    // up to 15,000 — which is inflated.
    const { appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 200,
      firstUpdate: 200.123,
      streamUpdates: [400, 500, 600, 700, 800],
      messageEnd: 900,
      output: 20,
    });

    const [, data2] = appendEntrySpy.mock.calls[1];
    expect(data2.tps).not.toBeNull();
    expect(data2.tps).toBeGreaterThanOrEqual(40);
    expect(data2.tps).toBeLessThanOrEqual(60);
    expect(data2.isPrimaryBranch).toBe(true);
  });

  // ── Volume gate doesn't affect normal token counts ────────────────────

  it('should not affect TPS for normal token counts even at short effective span', () => {
    // streamUpdates: [400, 450, 500, 550, 600] → streamMs = 200ms
    // 20 tokens / 0.2s = 100 TPS — well within ceiling
    const { appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 200,
      firstUpdate: 200.123,
      streamUpdates: [400, 450, 500, 550, 600],
      messageEnd: 700,
      output: 20,
    });

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.tps).not.toBeNull();
    expect(data.tps).toBeGreaterThanOrEqual(80);
    expect(data.tps).toBeLessThanOrEqual(120);
    expect(data.isPrimaryBranch).toBe(true);
  });

  // ── High-output `read`-style burst ────────────────────────────────────

  it('should null TPS when provider dumps 1000+ tokens in a burst that passes timing gates', () => {
    // Real-world scenario: a provider spits out 1500 tokens in a single
    // fast burst. The timing gates pass (5+ updates with ≥1ms gaps,
    // 200ms+ effective span), but the rate is inflated because the
    // generation window is too short relative to the volume.
    // streamUpdates: [400, 450, 500, 550, 600] → streamMs = 200ms
    // 1500 tokens / 0.2s = 7,500 TPS — below 10,000 ceiling, passes gate
    // This is actually plausible for a very fast provider, so it should
    // NOT be nulled. Test that the gate is not overly aggressive.
    const { appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 200,
      firstUpdate: 200.123,
      streamUpdates: [400, 450, 500, 550, 600],
      messageEnd: 700,
      output: 1500,
    });

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.tps).not.toBeNull();
    // 1500 / 0.2 = 7,500 TPS — plausible, within ceiling
    expect(data.tps).toBeGreaterThanOrEqual(7000);
    expect(data.tps).toBeLessThanOrEqual(8000);
  });
});
