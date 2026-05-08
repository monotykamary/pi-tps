import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createTestFixture, activateExtension, tick, makeAssistantMessage } from './helpers';
import type {
  TurnStartEvent,
  TurnEndEvent,
  MessageStartEvent,
  MessageUpdateEvent,
  MessageEndEvent,
} from './helpers';

describe('pi-tps extension — telemetry flow', () => {
  let fixture: ReturnType<typeof createTestFixture>;

  beforeEach(async () => {
    fixture = createTestFixture();
    await activateExtension(fixture);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Basic telemetry flow ─────────────────────────────────────────────────

  it('should show notification with TPS, TTFT (1 decimal), and total time', async () => {
    const { handlers, notifySpy, appendEntrySpy } = fixture;
    const now = Date.now();
    const assistantMessage: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello world' }],
      api: 'openai-completions',
      provider: 'openai',
      model: 'gpt-4',
      usage: {
        input: 100,
        output: 200,
        cacheRead: 50,
        cacheWrite: 25,
        totalTokens: 375,
        cost: {
          input: 0.001,
          output: 0.002,
          cacheRead: 0.0005,
          cacheWrite: 0.00025,
          total: 0.00375,
        },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    };

    handlers['turn_start']?.({ type: 'turn_start', turnIndex: 0, timestamp: now });
    await tick(100);
    handlers['message_start']?.({ type: 'message_start', message: assistantMessage });
    await tick(50);
    handlers['message_update']?.({
      type: 'message_update',
      message: assistantMessage,
      assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
    }); // TTFT
    await tick(50);
    handlers['message_update']?.({
      type: 'message_update',
      message: assistantMessage,
      assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
    }); // stream 1
    await tick(50);
    handlers['message_update']?.({
      type: 'message_update',
      message: assistantMessage,
      assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
    }); // stream 2
    await tick(50);
    handlers['message_update']?.({
      type: 'message_update',
      message: assistantMessage,
      assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
    }); // stream 3
    await tick(50);
    handlers['message_update']?.({
      type: 'message_update',
      message: assistantMessage,
      assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
    }); // stream 4
    await tick(50);
    handlers['message_update']?.({
      type: 'message_update',
      message: assistantMessage,
      assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
    }); // stream 5
    await tick(300);
    handlers['message_end']?.({ type: 'message_end', message: assistantMessage });
    handlers['turn_end']?.(
      { type: 'turn_end', turnIndex: 0, message: assistantMessage, toolResults: [] },
      fixture.mockCtx
    );

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;
    expect(notification).toMatch(/TPS \d+\.\d tok\/s/);
    expect(notification).toMatch(/TTFT \d+\.\ds/);
    expect(notification).toMatch(/out 200/);
    expect(notification).toMatch(/in 100/);

    expect(appendEntrySpy).toHaveBeenCalledOnce();
    const [type, data] = appendEntrySpy.mock.calls[0];
    expect(type).toBe('tps');
    expect(data.model).toEqual({ provider: 'openai', modelId: 'gpt-4' });
    expect(data.tokens).toEqual({
      input: 100,
      output: 200,
      cacheRead: 50,
      cacheWrite: 25,
      total: 375,
    });
    expect(data.timing.ttftMs).toBeGreaterThan(0);
    expect(data.timing.totalMs).toBeGreaterThan(0);
    expect(data.timing.generationMs).toBeGreaterThan(0);
    expect(data.timing.messageCount).toBe(1);
    expect(data.tps).toBeGreaterThan(0);
    expect(data.timestamp).toBeTypeOf('number');

    // Verify event was emitted with the same telemetry
    expect(fixture.eventsEmitSpy).toHaveBeenCalledOnce();
    expect(fixture.eventsEmitSpy.mock.calls[0][0]).toBe('tps:telemetry');
    expect(fixture.eventsEmitSpy.mock.calls[0][1]).toEqual(data);
  });

  // ── Token aggregation across multiple messages per turn ──────────────────

  it('should aggregate tokens from multiple assistant messages in current turn only', async () => {
    const { handlers, notifySpy } = fixture;

    const firstMessage: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'First' }],
      api: 'openai-completions',
      provider: 'openai',
      model: 'gpt-4',
      usage: {
        input: 50,
        output: 100,
        cacheRead: 25,
        cacheWrite: 10,
        totalTokens: 185,
        cost: {
          input: 0.001,
          output: 0.002,
          cacheRead: 0.0005,
          cacheWrite: 0.00025,
          total: 0.00375,
        },
      },
      stopReason: 'toolUse',
      timestamp: Date.now(),
    };

    const secondMessage: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Second' }],
      api: 'openai-completions',
      provider: 'openai',
      model: 'gpt-4',
      usage: {
        input: 30,
        output: 80,
        cacheRead: 15,
        cacheWrite: 5,
        totalTokens: 130,
        cost: {
          input: 0.001,
          output: 0.002,
          cacheRead: 0.0005,
          cacheWrite: 0.00025,
          total: 0.00375,
        },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    };

    const updateEvent: MessageUpdateEvent = {
      type: 'message_update',
      message: firstMessage,
      assistantMessageEvent: { type: 'text_delta', delta: 't' },
    };

    handlers['turn_start']?.({ type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    await tick(100);
    handlers['message_start']?.({ type: 'message_start', message: firstMessage });
    await tick(50);
    handlers['message_update']?.(updateEvent);
    await tick(200);
    handlers['message_end']?.({ type: 'message_end', message: firstMessage });
    await tick(50);
    handlers['message_start']?.({ type: 'message_start', message: secondMessage });
    await tick(50);
    handlers['message_update']?.({
      type: 'message_update',
      message: secondMessage,
      assistantMessageEvent: { type: 'text_delta', delta: 't' },
    });
    await tick(150);
    handlers['message_end']?.({ type: 'message_end', message: secondMessage });
    handlers['turn_end']?.(
      { type: 'turn_end', turnIndex: 0, message: secondMessage, toolResults: [] },
      fixture.mockCtx
    );

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;
    expect(notification).toContain('out 180');
    expect(notification).toContain('in 80');
  });

  // ── Model tracking ──────────────────────────────────────────────────────

  it('should capture model info from first assistant message', async () => {
    const { handlers, appendEntrySpy } = fixture;

    const assistantMessage: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello' }],
      api: 'openai-completions',
      provider: 'neuralwatt',
      model: 'moonshotai/Kimi-K2.5',
      usage: {
        input: 10,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 30,
        cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    };

    handlers['turn_start']?.({ type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    await tick(100);
    handlers['message_start']?.({ type: 'message_start', message: assistantMessage });
    await tick(50);
    handlers['message_update']?.({
      type: 'message_update',
      message: assistantMessage,
      assistantMessageEvent: { type: 'text_delta', delta: 'H' },
    }); // TTFT
    await tick(50);
    handlers['message_update']?.({
      type: 'message_update',
      message: assistantMessage,
      assistantMessageEvent: { type: 'text_delta', delta: 'i' },
    });
    await tick(50);
    handlers['message_update']?.({
      type: 'message_update',
      message: assistantMessage,
      assistantMessageEvent: { type: 'text_delta', delta: 'i' },
    });
    await tick(50);
    handlers['message_update']?.({
      type: 'message_update',
      message: assistantMessage,
      assistantMessageEvent: { type: 'text_delta', delta: 'i' },
    });
    await tick(50);
    handlers['message_update']?.({
      type: 'message_update',
      message: assistantMessage,
      assistantMessageEvent: { type: 'text_delta', delta: 'i' },
    });
    await tick(50);
    handlers['message_update']?.({
      type: 'message_update',
      message: assistantMessage,
      assistantMessageEvent: { type: 'text_delta', delta: 'i' },
    });
    await tick(50);
    handlers['message_end']?.({ type: 'message_end', message: assistantMessage });
    handlers['turn_end']?.(
      { type: 'turn_end', turnIndex: 0, message: assistantMessage, toolResults: [] },
      fixture.mockCtx
    );

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.model).toEqual({ provider: 'neuralwatt', modelId: 'moonshotai/Kimi-K2.5' });
  });

  // ── UI-less mode ─────────────────────────────────────────────────────────

  it('should persist and emit telemetry but skip notification when hasUI is false', async () => {
    const { handlers, notifySpy, appendEntrySpy, eventsEmitSpy } = fixture;
    const noUiCtx = { ...fixture.mockCtx, hasUI: false };

    const assistantMessage = makeAssistantMessage({ output: 20, input: 10 });

    handlers['turn_start']?.({ type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    await tick(50);
    handlers['message_start']?.({ type: 'message_start', message: assistantMessage });
    await tick(50);
    handlers['message_update']?.({
      type: 'message_update',
      message: assistantMessage,
      assistantMessageEvent: { type: 'text_delta', delta: 'H' },
    });
    await tick(50);
    handlers['message_end']?.({ type: 'message_end', message: assistantMessage });
    handlers['turn_end']?.(
      { type: 'turn_end', turnIndex: 0, message: assistantMessage, toolResults: [] },
      noUiCtx
    );

    expect(notifySpy).not.toHaveBeenCalled();
    expect(appendEntrySpy).toHaveBeenCalledOnce();
    expect(appendEntrySpy.mock.calls[0][0]).toBe('tps');
    expect(eventsEmitSpy).toHaveBeenCalledOnce();
    expect(eventsEmitSpy.mock.calls[0][0]).toBe('tps:telemetry');
    expect(eventsEmitSpy.mock.calls[0][1]).toEqual(appendEntrySpy.mock.calls[0][1]);
  });

  // ── Zero output ──────────────────────────────────────────────────────────

  it('should skip when no output tokens', async () => {
    const { handlers, notifySpy, appendEntrySpy } = fixture;

    const assistantMessage = makeAssistantMessage({ output: 0, input: 10 });

    handlers['turn_start']?.({ type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    await tick(50);
    handlers['message_start']?.({ type: 'message_start', message: assistantMessage });
    await tick(50);
    handlers['message_end']?.({ type: 'message_end', message: assistantMessage });
    handlers['turn_end']?.(
      { type: 'turn_end', turnIndex: 0, message: assistantMessage, toolResults: [] },
      fixture.mockCtx
    );

    expect(notifySpy).not.toHaveBeenCalled();
    expect(appendEntrySpy).not.toHaveBeenCalled();
  });

  // ── Non-assistant message filtering ──────────────────────────────────────

  it('should ignore non-assistant messages for timing', async () => {
    const { handlers, notifySpy, appendEntrySpy } = fixture;

    handlers['turn_start']?.({ type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    handlers['message_start']?.({
      type: 'message_start',
      message: { role: 'user', content: 'Hello' },
    });
    await tick(100);
    handlers['message_end']?.({ type: 'message_end', message: { role: 'user', content: 'Hello' } });
    handlers['message_start']?.({
      type: 'message_start',
      message: { role: 'system', content: 'System' },
    });
    await tick(50);
    handlers['message_end']?.({
      type: 'message_end',
      message: { role: 'system', content: 'System' },
    });
    handlers['turn_end']?.(
      { type: 'turn_end', turnIndex: 0, message: {}, toolResults: [] },
      fixture.mockCtx
    );

    expect(notifySpy).not.toHaveBeenCalled();
    expect(appendEntrySpy).not.toHaveBeenCalled();
  });

  // ── True generation TPS (excluding TTFT and tool gaps) ──────────────────

  it('should calculate true generation TPS excluding TTFT and tool gaps', async () => {
    const { handlers, notifySpy } = fixture;

    const firstMessage: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Let me check that...' }],
      api: 'openai-completions',
      provider: 'openai',
      model: 'gpt-4',
      usage: {
        input: 100,
        output: 200,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 300,
        cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
      },
      stopReason: 'toolUse',
      timestamp: Date.now(),
    };

    const secondMessage: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Here is the detailed answer...' }],
      api: 'openai-completions',
      provider: 'openai',
      model: 'gpt-4',
      usage: {
        input: 500,
        output: 800,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1300,
        cost: { input: 0.005, output: 0.008, cacheRead: 0, cacheWrite: 0, total: 0.013 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    };

    const updateEvent: MessageUpdateEvent = {
      type: 'message_update',
      message: firstMessage,
      assistantMessageEvent: { type: 'text_delta', delta: 't' },
    };

    handlers['turn_start']?.({ type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    await tick(100); // TTFT (excluded from generation TPS)

    handlers['message_start']?.({ type: 'message_start', message: firstMessage });
    await tick(50);
    handlers['message_update']?.(updateEvent); // TTFT
    await tick(50);
    handlers['message_update']?.(updateEvent); // streaming
    await tick(50);
    handlers['message_update']?.(updateEvent); // streaming
    await tick(50);
    handlers['message_update']?.(updateEvent); // streaming
    await tick(50);
    handlers['message_end']?.({ type: 'message_end', message: firstMessage });

    // TOOL EXECUTION GAP: 1000ms (excluded from generation TPS)
    await tick(1000);

    handlers['message_start']?.({ type: 'message_start', message: secondMessage });
    await tick(100);
    handlers['message_update']?.({
      type: 'message_update',
      message: secondMessage,
      assistantMessageEvent: { type: 'text_delta', delta: 't' },
    }); // TTFT
    await tick(100);
    handlers['message_update']?.({
      type: 'message_update',
      message: secondMessage,
      assistantMessageEvent: { type: 'text_delta', delta: 't' },
    }); // streaming
    await tick(100);
    handlers['message_update']?.({
      type: 'message_update',
      message: secondMessage,
      assistantMessageEvent: { type: 'text_delta', delta: 't' },
    }); // streaming
    await tick(100);
    handlers['message_update']?.({
      type: 'message_update',
      message: secondMessage,
      assistantMessageEvent: { type: 'text_delta', delta: 't' },
    }); // streaming
    await tick(100);
    handlers['message_end']?.({ type: 'message_end', message: secondMessage });

    handlers['turn_end']?.(
      { type: 'turn_end', turnIndex: 0, message: secondMessage, toolResults: [] },
      fixture.mockCtx
    );

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;

    const tpsMatch = notification.match(/TPS (\d+(?:\.\d+)?) tok\/s/);
    expect(tpsMatch).toBeTruthy();
    const tps = parseFloat(tpsMatch![1]);
    // Inter-update TPS: 3+3=6 streaming updates across two messages.
    // Span includes tool gap but still well under 100K (burst artifact).
    expect(tps).toBeGreaterThan(50);
    expect(tps).toBeLessThan(2000);

    expect(notification).toContain('out 1K');
    expect(notification).toContain('in 600');
  });

  // ── Inter-update TPS ──────────────────────────────────────────────────

  it('should produce null TPS for burst delivery (all updates in same tick)', async () => {
    // Simulates the read-command case: all message_updates fire within
    // a single event loop tick, so the inter-update span is 0ms.
    const { handlers, notifySpy, appendEntrySpy } = fixture;

    const assistantMessage: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Done' }],
      api: 'openai-completions',
      provider: 'openai',
      model: 'gpt-4',
      usage: {
        input: 291,
        output: 46,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 337,
        cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    };

    const updateEvent = {
      type: 'message_update' as const,
      message: assistantMessage,
      assistantMessageEvent: { type: 'text_delta' as const, delta: 't' },
    };

    handlers['turn_start']?.({ type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    await tick(50);
    handlers['message_start']?.({ type: 'message_start', message: assistantMessage });
    // All updates fire without any tick gap — simulates SSE burst
    handlers['message_update']?.(updateEvent); // TTFT
    handlers['message_update']?.(updateEvent); // streaming (same tick)
    handlers['message_update']?.(updateEvent); // streaming (same tick)
    handlers['message_update']?.(updateEvent); // streaming (same tick)
    handlers['message_end']?.({ type: 'message_end', message: assistantMessage });
    handlers['turn_end']?.(
      { type: 'turn_end', turnIndex: 0, message: assistantMessage, toolResults: [] },
      fixture.mockCtx
    );

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;
    // No TPS number displayed — burst delivery can't produce meaningful rate
    expect(notification).toContain('TPS —');

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.tps).toBeNull();
    expect(data.timing.streamMs).toBeLessThan(1); // burst: sub-ms span
    // Other telemetry still present
    expect(notification).toContain('TTFT');
    expect(notification).toContain('out 46');
  });

  it('should produce null TPS with only TTFT update and no streaming updates', async () => {
    const { handlers, notifySpy, appendEntrySpy } = fixture;

    const assistantMessage = makeAssistantMessage({ output: 20, input: 10 });

    handlers['turn_start']?.({ type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    await tick(50);
    handlers['message_start']?.({ type: 'message_start', message: assistantMessage });
    await tick(50);
    // Only TTFT update — no subsequent streaming updates
    handlers['message_update']?.({
      type: 'message_update',
      message: assistantMessage,
      assistantMessageEvent: { type: 'text_delta', delta: 'H' },
    });
    await tick(50);
    handlers['message_end']?.({ type: 'message_end', message: assistantMessage });
    handlers['turn_end']?.(
      { type: 'turn_end', turnIndex: 0, message: assistantMessage, toolResults: [] },
      fixture.mockCtx
    );

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;
    expect(notification).toContain('TPS —');

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.tps).toBeNull();
    expect(data.timing.streamMs).toBeNull(); // no streaming updates at all
  });

  it('should calculate inter-update TPS from streaming updates', async () => {
    const { handlers, notifySpy, appendEntrySpy } = fixture;

    const assistantMessage: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'A longer response' }],
      api: 'openai-completions',
      provider: 'openai',
      model: 'gpt-4',
      usage: {
        input: 100,
        output: 500,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 600,
        cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    };

    const updateEvent = {
      type: 'message_update' as const,
      message: assistantMessage,
      assistantMessageEvent: { type: 'text_delta' as const, delta: 't' },
    };

    handlers['turn_start']?.({ type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    await tick(100);
    handlers['message_start']?.({ type: 'message_start', message: assistantMessage });
    await tick(50); // TTFT
    handlers['message_update']?.(updateEvent); // TTFT
    await tick(100);
    handlers['message_update']?.(updateEvent); // streaming #1
    await tick(100);
    handlers['message_update']?.(updateEvent); // streaming #2
    await tick(100);
    handlers['message_update']?.(updateEvent); // streaming #3
    await tick(100);
    handlers['message_update']?.(updateEvent); // streaming #4
    await tick(100);
    handlers['message_update']?.(updateEvent); // streaming #5
    await tick(100);
    handlers['message_end']?.({ type: 'message_end', message: assistantMessage });
    handlers['turn_end']?.(
      { type: 'turn_end', turnIndex: 0, message: assistantMessage, toolResults: [] },
      fixture.mockCtx
    );

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;
    const tpsMatch = notification.match(/TPS (\d+(?:\.\d+)?) tok\/s/);
    expect(tpsMatch).toBeTruthy();
    const tps = parseFloat(tpsMatch![1]);
    // Inter-update span ~500ms (5 gaps of ~100ms between streaming updates)
    // 500 tokens / 0.5s ≈ 1000 TPS (real timer is approximate, so just check sane range)
    expect(tps).toBeGreaterThan(400);
    expect(tps).toBeLessThan(5000); // no 452K burst artifact

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.tps).toBeGreaterThan(0);
    expect(data.timing.streamMs).toBeGreaterThan(0);
  });

  // ── Missing turn_start ───────────────────────────────────────────────────

  it('should skip when turn_start was not called', () => {
    const { handlers, notifySpy, appendEntrySpy } = fixture;

    const assistantMessage = makeAssistantMessage({ output: 20, input: 10 });

    handlers['turn_end']?.(
      { type: 'turn_end', turnIndex: 0, message: assistantMessage, toolResults: [] },
      fixture.mockCtx
    );

    expect(notifySpy).not.toHaveBeenCalled();
    expect(appendEntrySpy).not.toHaveBeenCalled();
  });
});
