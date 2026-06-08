import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createTestFixture, activateExtension } from './helpers';

describe('pi-tps extension — dynamic TPS cap', () => {
  let fixture: ReturnType<typeof createTestFixture>;

  beforeEach(async () => {
    fixture = createTestFixture();
    await activateExtension(fixture);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Drive a turn with mocked performance.now() timestamps.
   * Set `isToolCall: true` to simulate a tool_execution_start during the turn.
   */
  function driveTurn(clocks: {
    turnStart: number;
    messageStart: number;
    firstUpdate: number;
    streamUpdates: number[];
    messageEnd: number;
    turnEnd?: number;
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

    const assistantMessage: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Response' }],
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

    // Simulate tool_execution_start if this is a tool call turn
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

  // ── Cap is set by reliable streaming turns ────────────────────────────────

  it('should set the TPS cap from a reliable streaming turn (primary branch, no tool call)', () => {
    // 20 tokens / 0.4s = 50 TPS from primary branch
    const { appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 200,
      firstUpdate: 200.123,
      streamUpdates: [400, 500, 600, 700, 800],
      messageEnd: 900,
    });

    const [, data] = appendEntrySpy.mock.calls[0];
    // TPS should be ~50, and isPrimaryBranch should be true
    expect(data.tps).toBeGreaterThanOrEqual(40);
    expect(data.tps).toBeLessThanOrEqual(60);
    expect(data.isPrimaryBranch).toBe(true);
  });

  // ── Cap is applied to tool-call turns ─────────────────────────────────────

  it('should clamp tool-call TPS to the cap set by a prior streaming turn', () => {
    // Turn 1: reliable streaming response → sets cap at ~50 TPS
    driveTurn({
      turnStart: 0,
      messageStart: 200,
      firstUpdate: 200.123,
      streamUpdates: [400, 500, 600, 700, 800],
      messageEnd: 900,
    });

    // Turn 2: tool call with fallback TPS (2 updates, 100ms generationMs)
    // Without cap: 20 tokens / 0.055s ≈ 363 TPS (inflated)
    // With cap: min(363, 50) = 50 TPS
    const { appendEntrySpy, notifySpy } = driveTurn({
      turnStart: 0,
      messageStart: 100,
      firstUpdate: 100.1,
      streamUpdates: [100.15, 100.3],
      messageEnd: 200,
      isToolCall: true,
    });

    const [, data] = appendEntrySpy.mock.calls[1];
    expect(data.tps).not.toBeNull();
    // Must be clamped to the ~50 TPS cap, not the inflated fallback value
    expect(data.tps).toBeLessThanOrEqual(55);
    expect(data.tps).toBeGreaterThan(0);
  });

  // ── Tool calls do not set the cap ────────────────────────────────────────

  it('should not let tool-call turns set the cap', () => {
    // Turn 1: tool call → no cap exists yet, TPS is null
    const { appendEntrySpy: spy1 } = driveTurn({
      turnStart: 0,
      messageStart: 100,
      firstUpdate: 100.1,
      streamUpdates: [100.15, 100.3],
      messageEnd: 200,
      isToolCall: true,
    });
    const [, data1] = spy1.mock.calls[0];
    // No cap → tool call TPS is null
    expect(data1.tps).toBeNull();

    // Turn 2: reliable streaming response at ~50 TPS → sets the cap
    const { appendEntrySpy: spy2 } = driveTurn({
      turnStart: 0,
      messageStart: 200,
      firstUpdate: 200.123,
      streamUpdates: [400, 500, 600, 700, 800],
      messageEnd: 900,
    });
    const [, data2] = spy2.mock.calls[1];
    expect(data2.tps).toBeGreaterThanOrEqual(40);
    expect(data2.tps).toBeLessThanOrEqual(60);

    // Turn 3: another tool call — should now be clamped to 50
    const { appendEntrySpy: spy3 } = driveTurn({
      turnStart: 0,
      messageStart: 100,
      firstUpdate: 100.1,
      streamUpdates: [100.15, 100.3],
      messageEnd: 200,
      isToolCall: true,
    });
    const [, data3] = spy3.mock.calls[2];
    expect(data3.tps).not.toBeNull();
    expect(data3.tps).toBeLessThanOrEqual(55);
  });

  // ── Cold start: no cap yet ────────────────────────────────────────────────

  it('should show null TPS for tool calls when no cap exists yet', () => {
    const { notifySpy, appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 100,
      firstUpdate: 100.1,
      streamUpdates: [100.15, 100.3],
      messageEnd: 200,
      isToolCall: true,
    });

    const notification = notifySpy.mock.calls[0][0] as string;
    // No streaming turn has set the cap yet → tool call TPS is null
    expect(notification).toContain('TPS —');

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.tps).toBeNull();
  });

  // ── Non-tool-call fallback turns are not clamped ──────────────────────────

  it('should not clamp non-tool-call fallback TPS', () => {
    // Turn 1: set cap at ~50 TPS from a reliable streaming turn
    driveTurn({
      turnStart: 0,
      messageStart: 200,
      firstUpdate: 200.123,
      streamUpdates: [400, 500, 600, 700, 800],
      messageEnd: 900,
    });

    // Turn 2: non-tool-call fallback (e.g. short burst response)
    // This should NOT be clamped — only tool calls get capped
    const { appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 100,
      firstUpdate: 100.1,
      streamUpdates: [100.15, 100.3],
      messageEnd: 200,
      isToolCall: false,
    });

    const [, data] = appendEntrySpy.mock.calls[1];
    expect(data.tps).not.toBeNull();
    // Non-tool-call fallback TPS is uncapped — may be high
    expect(data.tps).toBeGreaterThan(50);
  });

  // ── Cap is per-model ──────────────────────────────────────────────────────

  it('should maintain separate caps per model', () => {
    // Turn 1: openai/gpt-4 streaming → sets cap at ~50 TPS
    driveTurn({
      turnStart: 0,
      messageStart: 200,
      firstUpdate: 200.123,
      streamUpdates: [400, 500, 600, 700, 800],
      messageEnd: 900,
    });

    // Turn 2: deepseek/deepseek-v3 tool call → no cap for deepseek yet, uncapped
    // Use driveTurn with a different provider/model to avoid the gpt-4 cap
    const { handlers, appendEntrySpy } = fixture;
    const deepseek: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hi' }],
      api: 'openai-completions',
      provider: 'deepseek',
      model: 'deepseek-v3',
      usage: {
        input: 50,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 70,
        cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
      },
      stopReason: 'toolUse',
      timestamp: Date.now(),
    };

    let callIdx = 0;
    const timestamps = [0, 0, 100, 100.1, 100.15, 100.3, 300, 300];
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => {
      return timestamps[Math.min(callIdx++, timestamps.length - 1)];
    });

    handlers['turn_start']?.({ type: 'turn_start', turnIndex: 1, timestamp: Date.now() });
    handlers['message_start']?.({ type: 'message_start', message: deepseek });
    handlers['message_update']?.({
      type: 'message_update',
      message: deepseek,
      assistantMessageEvent: { type: 'text_delta', delta: 't' },
    });
    handlers['message_update']?.({
      type: 'message_update',
      message: deepseek,
      assistantMessageEvent: { type: 'text_delta', delta: 't' },
    });
    handlers['message_update']?.({
      type: 'message_update',
      message: deepseek,
      assistantMessageEvent: { type: 'text_delta', delta: 't' },
    });
    handlers['tool_execution_start']?.({
      type: 'tool_execution_start',
      toolCallId: 'call_1',
      toolName: 'bash',
      args: {},
    });
    handlers['message_end']?.({ type: 'message_end', message: deepseek });
    handlers['turn_end']?.(
      { type: 'turn_end', turnIndex: 1, message: deepseek, toolResults: [] },
      fixture.mockCtx
    );
    spy.mockRestore();

    const [, data2] = appendEntrySpy.mock.calls[1];
    // DeepSeek has no cap yet → tool call TPS is null
    expect(data2.tps).toBeNull();
  });

  // ── Cap only goes up ──────────────────────────────────────────────────────

  it('should only raise the cap, never lower it', () => {
    // Turn 1: sets cap at ~50 TPS
    driveTurn({
      turnStart: 0,
      messageStart: 200,
      firstUpdate: 200.123,
      streamUpdates: [400, 500, 600, 700, 800],
      messageEnd: 900,
    });

    // Turn 2: slower streaming response at ~25 TPS → cap stays at 50
    const { appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 200,
      firstUpdate: 200.123,
      streamUpdates: [600, 800, 1000, 1200, 1400],
      messageEnd: 1500,
    });

    const [, data2] = appendEntrySpy.mock.calls[1];
    // This turn's TPS is 25, but the cap should still be 50
    expect(data2.tps).toBeGreaterThanOrEqual(15);
    expect(data2.tps).toBeLessThanOrEqual(35);

    // Turn 3: tool call → should be capped at 50, not 25
    const { appendEntrySpy: spy3 } = driveTurn({
      turnStart: 0,
      messageStart: 100,
      firstUpdate: 100.1,
      streamUpdates: [100.15, 100.3],
      messageEnd: 200,
      isToolCall: true,
    });

    const [, data3] = spy3.mock.calls[2];
    expect(data3.tps).not.toBeNull();
    // Capped at 50 (the higher of the two streaming measurements)
    expect(data3.tps).toBeLessThanOrEqual(55);
  });
});
