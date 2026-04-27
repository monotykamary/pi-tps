import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@mariozechner/pi-coding-agent';

// ─── Event types (mirrors extension/index.ts — not exported from pi's public API)

interface TurnStartEvent {
  type: 'turn_start';
  turnIndex: number;
  timestamp: number;
}

interface TurnEndEvent {
  type: 'turn_end';
  turnIndex: number;
  message: unknown;
  toolResults: unknown[];
}

interface MessageStartEvent {
  type: 'message_start';
  message: unknown;
}

interface MessageUpdateEvent {
  type: 'message_update';
  message: unknown;
}

interface MessageEndEvent {
  type: 'message_end';
  message: unknown;
}
import type { AssistantMessage } from '@mariozechner/pi-ai';

// Helper to advance time
const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

describe('pi-tps extension', () => {
  let mockPi: Partial<ExtensionAPI>;
  let handlers: Record<string, (...args: unknown[]) => void>;
  let commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }>;
  let notifySpy: ReturnType<typeof vi.fn>;
  let appendEntrySpy: ReturnType<typeof vi.fn>;
  let registerCommandSpy: ReturnType<typeof vi.fn>;
  let mockEntries: Array<{ type?: string; role?: string; customType?: string; data?: unknown }>;
  let mockCtx: ExtensionContext;

  const UIAPI = {} as any; // opaque, just need notify

  beforeEach(async () => {
    handlers = {};
    commands = {};
    notifySpy = vi.fn();
    appendEntrySpy = vi.fn();
    registerCommandSpy = vi.fn((name: string, options: any) => {
      commands[name] = options;
    });
    mockEntries = [];

    mockCtx = {
      hasUI: true,
      ui: { notify: notifySpy } as any,
      sessionManager: {
        getEntries: vi.fn().mockReturnValue(mockEntries),
        getBranch: vi.fn(),
        getSessionId: vi.fn(),
      },
      // Satisfy ExtensionContext requirements not used by the extension
      modelRegistry: undefined as any,
      model: undefined,
      cwd: '/tmp',
      isIdle: vi.fn(),
      signal: undefined,
      abort: vi.fn(),
      hasPendingMessages: vi.fn(),
      shutdown: vi.fn(),
      getContextUsage: vi.fn(),
      compact: vi.fn(),
      getSystemPrompt: vi.fn(),
    } as ExtensionContext;

    mockPi = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers[event] = handler;
        return mockPi as ExtensionAPI;
      }),
      appendEntry: appendEntrySpy,
      registerCommand: registerCommandSpy,
    };

    // Import fresh to trigger module load
    const { default: tpsExtension } = await import('../index.js');
    tpsExtension(mockPi as ExtensionAPI);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should register all required event handlers and commands', () => {
    expect(mockPi.on).toHaveBeenCalledWith('session_start', expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith('session_tree', expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith('turn_start', expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith('message_start', expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith('message_update', expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith('message_end', expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith('turn_end', expect.any(Function));
    expect(registerCommandSpy).toHaveBeenCalledWith(
      'tps-export',
      expect.objectContaining({
        description: expect.any(String),
        handler: expect.any(Function),
      })
    );
  });

  // ── Basic telemetry flow ─────────────────────────────────────────────────

  it('should show notification with TPS, TTFT (1 decimal), and total time', async () => {
    const now = Date.now();
    const turnStartEvent: TurnStartEvent = {
      type: 'turn_start',
      turnIndex: 0,
      timestamp: now,
    };

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

    const messageStartEvent: MessageStartEvent = {
      type: 'message_start',
      message: assistantMessage,
    };

    const messageUpdateEvent: MessageUpdateEvent = {
      type: 'message_update',
      message: assistantMessage,
      assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
    };

    const messageEndEvent: MessageEndEvent = {
      type: 'message_end',
      message: assistantMessage,
    };

    const turnEndEvent: TurnEndEvent = {
      type: 'turn_end',
      turnIndex: 0,
      message: assistantMessage,
      toolResults: [],
    };

    // Simulate the event sequence
    handlers['turn_start']?.(turnStartEvent);
    await tick(100); // TTFT delay
    handlers['message_start']?.(messageStartEvent);
    await tick(50); // streaming chunk
    handlers['message_update']?.(messageUpdateEvent);
    await tick(150); // more streaming
    handlers['message_update']?.(messageUpdateEvent);
    await tick(300); // final streaming
    handlers['message_end']?.(messageEndEvent);
    handlers['turn_end']?.(turnEndEvent, mockCtx);

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;

    // Check format: TPS X.X tok/s · TTFT X.Xs · X.Xs · out X · in X
    expect(notification).toMatch(/TPS \d+\.\d tok\/s/);
    expect(notification).toMatch(/TTFT \d+\.\ds/); // TTFT has 1 decimal
    expect(notification).toMatch(/out 200/);
    expect(notification).toMatch(/in 100/);

    // Verify structured telemetry was saved
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
  });

  // ── Rehydration ──────────────────────────────────────────────────────────

  it('should restore notification on session resume from structured telemetry', async () => {
    mockEntries.push({
      type: 'custom',
      customType: 'tps',
      data: {
        model: { provider: 'openai', modelId: 'gpt-4' },
        tokens: { input: 50, output: 100, cacheRead: 0, cacheWrite: 0, total: 150 },
        timing: {
          ttftMs: 1200,
          totalMs: 5000,
          generationMs: 4000,
          stallMs: 0,
          stallCount: 0,
          messageCount: 1,
        },
        tps: 25.0,
        timestamp: Date.now(),
      },
    });

    handlers['session_start']?.({ reason: 'resume' }, mockCtx);
    await tick(); // deferred via setTimeout(0)

    expect(notifySpy).toHaveBeenCalledOnce();
    const msg = notifySpy.mock.calls[0][0] as string;
    expect(msg).toMatch(/TPS 25\.0 tok\/s/);
    expect(msg).toMatch(/TTFT 1\.2s/);
    expect(msg).toMatch(/out 100/);
    expect(msg).toMatch(/in 50/);
    expect(notifySpy).toHaveBeenCalledWith(msg, 'info');
  });

  it('should ignore legacy entries and only rehydrate structured telemetry', async () => {
    mockEntries.push(
      {
        type: 'custom',
        customType: 'tps',
        data: {
          message: 'TPS 37.9 tok/s · TTFT 1s · 27s · out 998 · in 917',
          timestamp: Date.now() - 500,
        },
      },
      {
        type: 'custom',
        customType: 'tps',
        data: {
          model: { provider: 'openai', modelId: 'gpt-4' },
          tokens: { input: 273, output: 51, cacheRead: 0, cacheWrite: 0, total: 324 },
          timing: {
            ttftMs: 1000,
            totalMs: 3800,
            generationMs: 2400,
            stallMs: 1400,
            stallCount: 1,
            messageCount: 1,
          },
          tps: 18.0,
          timestamp: Date.now(),
        },
      }
    );

    handlers['session_start']?.({ reason: 'resume' }, mockCtx);
    await tick();

    expect(notifySpy).toHaveBeenCalledOnce();
    const msg = notifySpy.mock.calls[0][0];
    expect(msg).toContain('TPS 18.0');
    expect(msg).toContain('TTFT 1.0s');
    expect(msg).toContain('stall 1.4s×1');
    expect(msg).not.toContain('TPS 37.9');
  });

  it('should restore notification on session startup (continuing previous session)', async () => {
    mockEntries.push({
      type: 'custom',
      customType: 'tps',
      data: {
        model: { provider: 'openai', modelId: 'gpt-4' },
        tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 },
        timing: {
          ttftMs: 1000,
          totalMs: 3000,
          generationMs: 2000,
          stallMs: 0,
          stallCount: 0,
          messageCount: 1,
        },
        tps: 10.0,
        timestamp: Date.now(),
      },
    });

    handlers['session_start']?.({ reason: 'startup' }, mockCtx);
    await tick(); // deferred via setTimeout(0)

    expect(notifySpy).toHaveBeenCalledOnce();
    expect(notifySpy.mock.calls[0][0]).toMatch(/TPS 10\.0 tok\/s/);
  });

  it('should restore notification on session reload', async () => {
    mockEntries.push({
      type: 'custom',
      customType: 'tps',
      data: {
        model: { provider: 'openai', modelId: 'gpt-4' },
        tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 },
        timing: {
          ttftMs: 1000,
          totalMs: 3000,
          generationMs: 2000,
          stallMs: 0,
          stallCount: 0,
          messageCount: 1,
        },
        tps: 10.0,
        timestamp: Date.now(),
      },
    });

    handlers['session_start']?.({ reason: 'reload' }, mockCtx);
    await tick(); // deferred via setTimeout(0)

    expect(notifySpy).toHaveBeenCalledOnce();
  });

  it('should restore notification on tree navigation', async () => {
    mockEntries.push({
      type: 'custom',
      customType: 'tps',
      data: {
        model: { provider: 'openai', modelId: 'gpt-4' },
        tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 },
        timing: {
          ttftMs: 1000,
          totalMs: 3000,
          generationMs: 2000,
          stallMs: 0,
          stallCount: 0,
          messageCount: 1,
        },
        tps: 10.0,
        timestamp: Date.now(),
      },
    });

    handlers['session_tree']?.({ newLeafId: 'abc123', oldLeafId: 'def456' }, mockCtx);
    await tick(); // deferred via setTimeout(0)

    expect(notifySpy).toHaveBeenCalledOnce();
  });

  it('should rehydrate most recent structured entry, skipping legacy entries', async () => {
    mockEntries.push(
      {
        type: 'custom',
        customType: 'tps',
        data: { message: 'legacy 1', timestamp: Date.now() - 3000 },
      },
      {
        type: 'custom',
        customType: 'tps',
        data: {
          model: { provider: 'a', modelId: 'a-1' },
          tokens: { input: 5, output: 10, cacheRead: 0, cacheWrite: 0, total: 15 },
          timing: {
            ttftMs: 5000,
            totalMs: 10000,
            generationMs: 8000,
            stallMs: 0,
            stallCount: 0,
            messageCount: 1,
          },
          tps: 1.2,
          timestamp: Date.now() - 2000,
        },
      },
      {
        type: 'custom',
        customType: 'tps',
        data: { message: 'legacy 2', timestamp: Date.now() - 1000 },
      },
      {
        type: 'custom',
        customType: 'tps',
        data: {
          model: { provider: 'b', modelId: 'b-1' },
          tokens: { input: 50, output: 500, cacheRead: 0, cacheWrite: 0, total: 550 },
          timing: {
            ttftMs: 2000,
            totalMs: 8000,
            generationMs: 6000,
            stallMs: 500,
            stallCount: 1,
            messageCount: 2,
          },
          tps: 83.3,
          timestamp: Date.now(),
        },
      }
    );

    handlers['session_start']?.({ reason: 'resume' }, mockCtx);
    await tick();

    expect(notifySpy).toHaveBeenCalledOnce();
    const msg = notifySpy.mock.calls[0][0];
    expect(msg).toContain('TPS 83.3');
    expect(msg).toContain('stall');
    expect(msg).not.toContain('legacy');
  });

  // ── Token aggregation across multiple messages per turn ──────────────────

  it('should aggregate tokens from multiple assistant messages in current turn only', async () => {
    const turnStartEvent: TurnStartEvent = {
      type: 'turn_start',
      turnIndex: 0,
      timestamp: Date.now(),
    };

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

    // Simulate the event sequence
    handlers['turn_start']?.(turnStartEvent);
    await tick(100);
    handlers['message_start']?.({ type: 'message_start', message: firstMessage });
    await tick(50);
    handlers['message_update']?.(updateEvent);
    await tick(200);
    handlers['message_end']?.({ type: 'message_end', message: firstMessage });
    // Second message starts after first ends
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

    const turnEndEvent: TurnEndEvent = {
      type: 'turn_end',
      turnIndex: 0,
      message: secondMessage,
      toolResults: [],
    };

    handlers['turn_end']?.(turnEndEvent, mockCtx);

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;
    // Should only count current turn messages (100 + 80 = 180 output, 50 + 30 = 80 input)
    expect(notification).toContain('out 180');
    expect(notification).toContain('in 80');
  });

  // ── UI-less mode ─────────────────────────────────────────────────────────

  it('should skip notification and persist when hasUI is false', async () => {
    const noUiCtx = { ...mockCtx, hasUI: false };

    const turnStartEvent: TurnStartEvent = {
      type: 'turn_start',
      turnIndex: 0,
      timestamp: Date.now(),
    };

    const assistantMessage: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello' }],
      api: 'openai-completions',
      provider: 'openai',
      model: 'gpt-4',
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

    handlers['turn_start']?.(turnStartEvent);
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
    expect(appendEntrySpy).not.toHaveBeenCalled();
  });

  // ── Zero output ──────────────────────────────────────────────────────────

  it('should skip when no output tokens', async () => {
    const turnStartEvent: TurnStartEvent = {
      type: 'turn_start',
      turnIndex: 0,
      timestamp: Date.now(),
    };

    const assistantMessage: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'No tokens' }],
      api: 'openai-completions',
      provider: 'openai',
      model: 'gpt-4',
      usage: {
        input: 10,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 10,
        cost: { input: 0.001, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    };

    handlers['turn_start']?.(turnStartEvent);
    await tick(50);
    handlers['message_start']?.({ type: 'message_start', message: assistantMessage });
    await tick(50);
    handlers['message_end']?.({ type: 'message_end', message: assistantMessage });
    handlers['turn_end']?.(
      { type: 'turn_end', turnIndex: 0, message: assistantMessage, toolResults: [] },
      mockCtx
    );

    expect(notifySpy).not.toHaveBeenCalled();
    expect(appendEntrySpy).not.toHaveBeenCalled();
  });

  // ── Non-assistant message filtering ──────────────────────────────────────

  it('should ignore non-assistant messages for timing', async () => {
    const turnStartEvent: TurnStartEvent = {
      type: 'turn_start',
      turnIndex: 0,
      timestamp: Date.now(),
    };

    handlers['turn_start']?.(turnStartEvent);

    // Send non-assistant messages - should not affect timing
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

    // No assistant message = no telemetry
    handlers['turn_end']?.(
      { type: 'turn_end', turnIndex: 0, message: {}, toolResults: [] },
      mockCtx
    );

    expect(notifySpy).not.toHaveBeenCalled();
    expect(appendEntrySpy).not.toHaveBeenCalled();
  });

  // ── Missing turn_start ───────────────────────────────────────────────────

  it('should skip when turn_start was not called', () => {
    const assistantMessage: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello' }],
      api: 'openai-completions',
      provider: 'openai',
      model: 'gpt-4',
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

    // Don't call turn_start, just turn_end
    handlers['turn_end']?.(
      { type: 'turn_end', turnIndex: 0, message: assistantMessage, toolResults: [] },
      mockCtx
    );

    expect(notifySpy).not.toHaveBeenCalled();
    expect(appendEntrySpy).not.toHaveBeenCalled();
  });

  // ── True generation TPS (excluding TTFT and tool gaps) ──────────────────

  it('should calculate true generation TPS excluding TTFT and tool gaps', async () => {
    const turnStartEvent: TurnStartEvent = {
      type: 'turn_start',
      turnIndex: 0,
      timestamp: Date.now(),
    };

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

    // Simulate: true generation time excludes gaps
    handlers['turn_start']?.(turnStartEvent);
    await tick(100); // TTFT (excluded from generation TPS)

    // First message: 200ms pure generation
    handlers['message_start']?.({ type: 'message_start', message: firstMessage });
    await tick(50);
    handlers['message_update']?.(updateEvent);
    await tick(150);
    handlers['message_end']?.({ type: 'message_end', message: firstMessage });

    // TOOL EXECUTION GAP: 1000ms (excluded from generation TPS)
    await tick(1000);

    // Second message: 400ms pure generation
    handlers['message_start']?.({ type: 'message_start', message: secondMessage });
    await tick(100);
    handlers['message_update']?.({
      type: 'message_update',
      message: secondMessage,
      assistantMessageEvent: { type: 'text_delta', delta: 't' },
    });
    await tick(300);
    handlers['message_end']?.({ type: 'message_end', message: secondMessage });

    const turnEndEvent: TurnEndEvent = {
      type: 'turn_end',
      turnIndex: 0,
      message: secondMessage,
      toolResults: [],
    };

    handlers['turn_end']?.(turnEndEvent, mockCtx);

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;

    // True generation TPS: 1000 tokens / 0.6s (200ms + 400ms) = ~1666.7 TPS
    const tpsMatch = notification.match(/TPS (\d+(?:\.\d+)?) tok\/s/);
    expect(tpsMatch).toBeTruthy();
    const tps = parseFloat(tpsMatch![1]);
    expect(tps).toBeGreaterThan(1000); // True generation is fast
    expect(tps).toBeLessThan(2000);

    expect(notification).toContain('out 1,000');
    expect(notification).toContain('in 600');
  });

  // ── Stall detection ─────────────────────────────────────────────────────

  it('should detect stalls between message_update events', async () => {
    const now = Date.now();
    const turnStartEvent: TurnStartEvent = {
      type: 'turn_start',
      turnIndex: 0,
      timestamp: now,
    };

    const assistantMessage: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Response with a stall' }],
      api: 'openai-completions',
      provider: 'deepseek',
      model: 'deepseek-v4',
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

    const messageStartEvent: MessageStartEvent = {
      type: 'message_start',
      message: assistantMessage,
    };

    const updateEvent: MessageUpdateEvent = {
      type: 'message_update',
      message: assistantMessage,
      assistantMessageEvent: { type: 'text_delta', delta: 't' },
    };

    // Simulate streaming with a stall
    handlers['turn_start']?.(turnStartEvent);
    await tick(200); // TTFT
    handlers['message_start']?.(messageStartEvent);

    // Normal streaming
    handlers['message_update']?.(updateEvent);
    await tick(100);
    handlers['message_update']?.(updateEvent);

    // STALL: 800ms gap (> 500ms threshold)
    await tick(800);
    handlers['message_update']?.(updateEvent);

    // Normal streaming resumes
    await tick(100);
    handlers['message_update']?.(updateEvent);

    // Another stall: 600ms gap
    await tick(600);
    handlers['message_update']?.(updateEvent);

    await tick(50);
    handlers['message_end']?.({ type: 'message_end', message: assistantMessage });

    const turnEndEvent: TurnEndEvent = {
      type: 'turn_end',
      turnIndex: 0,
      message: assistantMessage,
      toolResults: [],
    };

    handlers['turn_end']?.(turnEndEvent, mockCtx);

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;

    expect(notification).toMatch(/stall \d+\.\ds×2/); // 2 stalls with decimal
    expect(notification).toContain('TPS');

    // Verify structured data
    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.timing.stallCount).toBe(2);
    // 800 + 600 = 1400, minus real-timer jitter margin
    expect(data.timing.stallMs).toBeGreaterThanOrEqual(1300);
  });

  it('should not flag short gaps as stalls', async () => {
    const now = Date.now();
    const turnStartEvent: TurnStartEvent = {
      type: 'turn_start',
      turnIndex: 0,
      timestamp: now,
    };

    const assistantMessage: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Smooth' }],
      api: 'openai-completions',
      provider: 'openai',
      model: 'gpt-4',
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

    const updateEvent: MessageUpdateEvent = {
      type: 'message_update',
      message: assistantMessage,
      assistantMessageEvent: { type: 'text_delta', delta: 't' },
    };

    handlers['turn_start']?.(turnStartEvent);
    await tick(100);
    handlers['message_start']?.({ type: 'message_start', message: assistantMessage });

    // Short gaps (< 500ms)
    handlers['message_update']?.(updateEvent);
    await tick(200);
    handlers['message_update']?.(updateEvent);
    await tick(300);
    handlers['message_update']?.(updateEvent);
    await tick(400); // borderline but < 500
    handlers['message_update']?.(updateEvent);

    await tick(50);
    handlers['message_end']?.({ type: 'message_end', message: assistantMessage });
    handlers['turn_end']?.(
      { type: 'turn_end', turnIndex: 0, message: assistantMessage, toolResults: [] },
      mockCtx
    );

    // No stall in output
    const notification = notifySpy.mock.calls[0][0] as string;
    expect(notification).not.toContain('stall');

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.timing.stallCount).toBe(0);
    expect(data.timing.stallMs).toBe(0);
  });

  // ── Model tracking ──────────────────────────────────────────────────────

  it('should capture model info from first assistant message', async () => {
    const turnStartEvent: TurnStartEvent = {
      type: 'turn_start',
      turnIndex: 0,
      timestamp: Date.now(),
    };

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

    handlers['turn_start']?.(turnStartEvent);
    await tick(100);
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
      mockCtx
    );

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.model).toEqual({ provider: 'neuralwatt', modelId: 'moonshotai/Kimi-K2.5' });
  });

  // ── Export command ──────────────────────────────────────────────────────

  const branchEntries = [
    {
      type: 'custom',
      customType: 'tps',
      data: { tps: 10 },
      id: '1',
      parentId: null,
      timestamp: '2026-01-01T00:00:00Z',
    },
    {
      type: 'custom',
      customType: 'neuralwatt-energy',
      data: { energy_joules: 100 },
      id: '2',
      parentId: null,
      timestamp: '2026-01-01T00:00:01Z',
    },
    { type: 'message', role: 'user', content: 'hello' },
  ];

  const allEntries = [
    ...branchEntries,
    {
      type: 'custom',
      customType: 'tps',
      data: { tps: 20 },
      id: '3',
      parentId: null,
      timestamp: '2026-01-01T00:00:02Z',
    },
  ];

  it('should export current branch custom entries by default', async () => {
    const exportCtx = {
      ...mockCtx,
      sessionManager: {
        getBranch: vi.fn().mockReturnValue(branchEntries),
        getSessionId: vi.fn().mockReturnValue('test-session-id'),
      },
    } as ExtensionCommandContext;

    await commands['tps-export'].handler('', exportCtx);

    // Should export 2 custom entries from branch (1 tps + 1 neuralwatt-energy)
    expect(notifySpy).toHaveBeenCalledOnce();
    const msg = notifySpy.mock.calls[0][0] as string;
    expect(msg).toContain('Exported 2 telemetry');
    expect(msg).toContain('pi-telemetry-branch-');
    expect(msg).toContain('/pi-telemetry/');
  });

  it('should export full session with --full flag', async () => {
    const exportCtx = {
      ...mockCtx,
      sessionManager: {
        getEntries: vi.fn().mockReturnValue(allEntries),
        getSessionId: vi.fn().mockReturnValue('test-session-id'),
      },
    } as ExtensionCommandContext;

    await commands['tps-export'].handler('--full', exportCtx);

    // Should export 3 custom entries (2 tps + 1 neuralwatt-energy)
    expect(notifySpy).toHaveBeenCalledOnce();
    const msg = notifySpy.mock.calls[0][0] as string;
    expect(msg).toContain('Exported 3 telemetry');
    expect(msg).toContain('pi-telemetry-full-');
  });

  it('should combine --full with customType filter', async () => {
    const exportCtx = {
      ...mockCtx,
      sessionManager: {
        getEntries: vi.fn().mockReturnValue(allEntries),
        getSessionId: vi.fn().mockReturnValue('test-session-id'),
      },
    } as ExtensionCommandContext;

    await commands['tps-export'].handler('tps --full', exportCtx);

    expect(notifySpy).toHaveBeenCalledOnce();
    const msg = notifySpy.mock.calls[0][0] as string;
    expect(msg).toContain('Exported 2 telemetry');
    expect(msg).toContain('pi-telemetry-full-tps-');
  });

  it('should filter branch by customType', async () => {
    const exportCtx = {
      ...mockCtx,
      sessionManager: {
        getBranch: vi.fn().mockReturnValue(branchEntries),
        getSessionId: vi.fn().mockReturnValue('test-session-id'),
      },
    } as ExtensionCommandContext;

    await commands['tps-export'].handler('tps', exportCtx);

    expect(notifySpy).toHaveBeenCalledOnce();
    const msg = notifySpy.mock.calls[0][0] as string;
    expect(msg).toContain('Exported 1 telemetry');
    expect(msg).toContain('pi-telemetry-branch-tps-');
  });

  it('should show warning when no matching entries found', async () => {
    const exportCtx = {
      ...mockCtx,
      sessionManager: {
        getBranch: vi.fn().mockReturnValue([{ type: 'message', role: 'user', content: 'hello' }]),
        getSessionId: vi.fn().mockReturnValue('test-session-id'),
      },
    } as ExtensionCommandContext;

    await commands['tps-export'].handler('nonexistent', exportCtx);

    expect(notifySpy).toHaveBeenCalledOnce();
    const msg = notifySpy.mock.calls[0][0] as string;
    expect(msg).toContain('No matching entries found');
    expect(msg).toContain('current-branch');
    expect(notifySpy).toHaveBeenCalledWith(msg, 'warning');
  });

  it('should use exact customType match (neuralwatt-energy, not energy)', async () => {
    const exportCtx = {
      ...mockCtx,
      sessionManager: {
        getBranch: vi.fn().mockReturnValue([
          {
            type: 'custom',
            customType: 'neuralwatt-energy',
            data: { energy_joules: 100 },
            id: '1',
            parentId: null,
            timestamp: '2026-01-01T00:00:00Z',
          },
          {
            type: 'custom',
            customType: 'energy',
            data: { joules: 50 },
            id: '2',
            parentId: null,
            timestamp: '2026-01-01T00:00:01Z',
          },
        ]),
        getSessionId: vi.fn().mockReturnValue('test-session-id'),
      },
    } as ExtensionCommandContext;

    // /tps-export neuralwatt-energy — should match exactly, not "energy"
    await commands['tps-export'].handler('neuralwatt-energy', exportCtx);

    expect(notifySpy).toHaveBeenCalledOnce();
    const msg = notifySpy.mock.calls[0][0] as string;
    expect(msg).toContain('Exported 1 telemetry');
    expect(msg).toContain('pi-telemetry-branch-neuralwatt-energy-');
  });

  it('should include model_change entries and re-chain parentIds', async () => {
    const entriesWithModelChange = [
      {
        type: 'model_change',
        id: 'mc1',
        parentId: null,
        timestamp: '2026-01-01T00:00:00Z',
        provider: 'test',
        modelId: 'test-model',
      },
      {
        type: 'message',
        id: 'msg1',
        parentId: 'mc1',
        timestamp: '2026-01-01T00:00:01Z',
        role: 'user',
        content: 'hello',
      },
      {
        type: 'custom',
        customType: 'tps',
        data: { tps: 10 },
        id: 'tps1',
        parentId: 'msg1',
        timestamp: '2026-01-01T00:00:02Z',
      },
      {
        type: 'message',
        id: 'msg2',
        parentId: 'tps1',
        timestamp: '2026-01-01T00:00:03Z',
        role: 'assistant',
        content: 'hi',
      },
      {
        type: 'model_change',
        id: 'mc2',
        parentId: 'msg2',
        timestamp: '2026-01-01T00:00:04Z',
        provider: 'other',
        modelId: 'other-model',
      },
      {
        type: 'custom',
        customType: 'tps',
        data: { tps: 20 },
        id: 'tps2',
        parentId: 'mc2',
        timestamp: '2026-01-01T00:00:05Z',
      },
    ];
    const exportCtx = {
      ...mockCtx,
      sessionManager: {
        getBranch: vi.fn().mockReturnValue(entriesWithModelChange),
        getSessionId: vi.fn().mockReturnValue('test-session-id'),
      },
    } as ExtensionCommandContext;

    await commands['tps-export'].handler('', exportCtx);

    expect(notifySpy).toHaveBeenCalledOnce();
    const msg = notifySpy.mock.calls[0][0] as string;
    // 2 tps + 2 model_change = 2 telemetry + 2 structural
    expect(msg).toContain('2 telemetry + 2 structural');

    // Verify file content: parentIds should be re-chained within exported entries
    const filepath = msg.split('→ ')[1];
    const fs = await import('fs');
    const content = fs.readFileSync(filepath, 'utf8');
    const lines = content
      .trim()
      .split('\n')
      .map((l: string) => JSON.parse(l));

    // model_change mc1: root → parentId should be null
    expect(lines.find((l: any) => l.id === 'mc1').parentId).toBeNull();
    // tps1: original parentId was msg1 (message), re-chained to mc1 (model_change)
    expect(lines.find((l: any) => l.id === 'tps1').parentId).toBe('mc1');
    // model_change mc2: original parentId was msg2 (message), re-chained to tps1
    expect(lines.find((l: any) => l.id === 'mc2').parentId).toBe('tps1');
    // tps2: original parentId was mc2, already in export → stays
    expect(lines.find((l: any) => l.id === 'tps2').parentId).toBe('mc2');
  });

  it('should include structural entries even with customType filter', async () => {
    const entriesWithModelChange = [
      {
        type: 'model_change',
        id: 'mc1',
        parentId: null,
        timestamp: '2026-01-01T00:00:00Z',
        provider: 'test',
        modelId: 'test-model',
      },
      {
        type: 'custom',
        customType: 'tps',
        data: { tps: 10 },
        id: 'tps1',
        parentId: 'mc1',
        timestamp: '2026-01-01T00:00:01Z',
      },
      {
        type: 'custom',
        customType: 'neuralwatt-energy',
        data: { energy_joules: 100 },
        id: 'ne1',
        parentId: 'tps1',
        timestamp: '2026-01-01T00:00:02Z',
      },
    ];
    const exportCtx = {
      ...mockCtx,
      sessionManager: {
        getBranch: vi.fn().mockReturnValue(entriesWithModelChange),
        getSessionId: vi.fn().mockReturnValue('test-session-id'),
      },
    } as ExtensionCommandContext;

    // Filter by 'tps' — should still include model_change structural entries
    await commands['tps-export'].handler('tps', exportCtx);

    expect(notifySpy).toHaveBeenCalledOnce();
    const msg = notifySpy.mock.calls[0][0] as string;
    // 1 tps (filtered) + 1 model_change (structural, always included)
    expect(msg).toContain('1 telemetry + 1 structural');
  });
});

// ── formatDuration (with 1-decimal sub-minute precision) ────────────────────

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
