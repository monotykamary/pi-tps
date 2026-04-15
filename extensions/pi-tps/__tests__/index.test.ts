import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  ExtensionAPI,
  AgentEndEvent,
  UIAPI,
  ExtensionContext,
} from '@mariozechner/pi-coding-agent';

// Event types not exported from main package - define locally
interface TurnStartEvent {
  type: 'turn_start';
  turnIndex: number;
  timestamp: number;
}

interface MessageStartEvent {
  type: 'message_start';
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
  let mockUI: Partial<UIAPI>;
  let handlers: Record<string, (...args: unknown[]) => void>;
  let notifySpy: ReturnType<typeof vi.fn>;
  let appendEntrySpy: ReturnType<typeof vi.fn>;
  let mockEntries: Array<{ role: string; customType?: string; content: unknown }>;
  let mockCtx: ExtensionContext;

  beforeEach(async () => {
    handlers = {};
    notifySpy = vi.fn();
    appendEntrySpy = vi.fn();
    mockEntries = [];

    mockUI = {
      notify: notifySpy,
    };

    mockCtx = {
      hasUI: true,
      ui: mockUI as UIAPI,
      sessionManager: {
        getEntries: vi.fn().mockReturnValue(mockEntries),
      },
    } as unknown as ExtensionContext;

    mockPi = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers[event] = handler;
        return mockPi as ExtensionAPI;
      }),
      appendEntry: appendEntrySpy,
    };

    // Import fresh to trigger module load
    const { default: tpsExtension } = await import('../index.js');
    tpsExtension(mockPi as ExtensionAPI);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should register all required event handlers', () => {
    expect(mockPi.on).toHaveBeenCalledWith('session_start', expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith('turn_start', expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith('message_start', expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith('message_end', expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith('agent_end', expect.any(Function));
  });

  it('should show notification with TPS, TTFT, and total time', async () => {
    const turnStartEvent: TurnStartEvent = {
      type: 'turn_start',
      turnIndex: 0,
      timestamp: Date.now(),
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

    const messageEndEvent: MessageEndEvent = {
      type: 'message_end',
      message: assistantMessage,
    };

    const agentEndEvent: AgentEndEvent = {
      type: 'agent_end',
      messages: [assistantMessage],
    };

    // Simulate the event sequence
    handlers['turn_start']?.(turnStartEvent);
    await tick(100); // TTFT delay
    handlers['message_start']?.(messageStartEvent);
    await tick(500); // Generation time
    handlers['message_end']?.(messageEndEvent);
    handlers['agent_end']?.(agentEndEvent, mockCtx);

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;

    // Check format: TPS X.X tok/s · TTFT X.Xs · X.Xs · out X · in X
    expect(notification).toMatch(/TPS \d+\.\d tok\/s/);
    expect(notification).toMatch(/TTFT \d+\.\ds/);
    expect(notification).toMatch(/out 200/);
    expect(notification).toMatch(/in 100/);

    expect(appendEntrySpy).toHaveBeenCalledOnce();
    const [type, data] = appendEntrySpy.mock.calls[0];
    expect(type).toBe('tps');
    expect(data.message).toContain('TPS');
    expect(data.timestamp).toBeTypeOf('number');
  });

  it('should restore notification on session resume if entry exists', () => {
    mockEntries.push({
      type: 'custom',
      customType: 'tps',
      data: {
        message: 'TPS 42.0 tok/s · TTFT 1.2s · 5.0s · out 100 · in 50',
        timestamp: Date.now(),
      },
    });

    handlers['session_start']?.({ reason: 'switch' }, mockCtx);

    expect(notifySpy).toHaveBeenCalledOnce();
    expect(notifySpy).toHaveBeenCalledWith(
      'TPS 42.0 tok/s · TTFT 1.2s · 5.0s · out 100 · in 50',
      'info'
    );
  });

  it('should not restore notification on session start for new sessions', () => {
    mockEntries.push({
      type: 'custom',
      customType: 'tps',
      data: { message: 'TPS 42.0 tok/s · TTFT 1.0s · 3.0s', timestamp: Date.now() },
    });

    handlers['session_start']?.({ reason: 'startup' }, mockCtx);

    expect(notifySpy).not.toHaveBeenCalled();
  });

  it('should restore the most recent TPS entry on resume', () => {
    mockEntries.push(
      {
        type: 'custom',
        customType: 'tps',
        data: { message: 'TPS 10.0 tok/s old', timestamp: Date.now() - 1000 },
      },
      {
        type: 'custom',
        customType: 'tps',
        data: { message: 'TPS 50.0 tok/s recent', timestamp: Date.now() },
      }
    );

    handlers['session_start']?.({ reason: 'resume' }, mockCtx);

    expect(notifySpy).toHaveBeenCalledOnce();
    expect(notifySpy).toHaveBeenCalledWith('TPS 50.0 tok/s recent', 'info');
  });

  it('should aggregate tokens from multiple assistant messages', async () => {
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

    // Simulate the event sequence
    handlers['turn_start']?.(turnStartEvent);
    await tick(100);
    handlers['message_start']?.({ type: 'message_start', message: firstMessage });
    await tick(250);
    handlers['message_end']?.({ type: 'message_end', message: firstMessage });
    // Second message starts after first ends
    await tick(50);
    handlers['message_start']?.({ type: 'message_start', message: secondMessage });
    await tick(200);
    handlers['message_end']?.({ type: 'message_end', message: secondMessage });

    const agentEndEvent: AgentEndEvent = {
      type: 'agent_end',
      messages: [firstMessage, secondMessage],
    };

    handlers['agent_end']?.(agentEndEvent, mockCtx);

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;
    expect(notification).toContain('out 180'); // 100 + 80
    expect(notification).toContain('in 80'); // 50 + 30
  });

  it('should skip notification when hasUI is false', async () => {
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
    await tick(100);
    handlers['message_end']?.({ type: 'message_end', message: assistantMessage });
    handlers['agent_end']?.({ type: 'agent_end', messages: [assistantMessage] }, noUiCtx);

    expect(notifySpy).not.toHaveBeenCalled();
  });

  it('should skip notification when no output tokens', async () => {
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
    await tick(100);
    handlers['message_end']?.({ type: 'message_end', message: assistantMessage });
    handlers['agent_end']?.({ type: 'agent_end', messages: [assistantMessage] }, mockCtx);

    expect(notifySpy).not.toHaveBeenCalled();
    expect(appendEntrySpy).not.toHaveBeenCalled();
  });

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

    // No assistant message = no notification
    handlers['agent_end']?.({ type: 'agent_end', messages: [] }, mockCtx);

    expect(notifySpy).not.toHaveBeenCalled();
    expect(appendEntrySpy).not.toHaveBeenCalled();
  });

  it('should skip notification when turn_start was not called', () => {
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

    // Don't call turn_start, just agent_end
    handlers['agent_end']?.({ type: 'agent_end', messages: [assistantMessage] }, mockCtx);

    expect(notifySpy).not.toHaveBeenCalled();
    expect(appendEntrySpy).not.toHaveBeenCalled();
  });

  it('should calculate TTFT from turn_start to first message_start', async () => {
    const startTime = Date.now();
    const turnStartEvent: TurnStartEvent = {
      type: 'turn_start',
      turnIndex: 0,
      timestamp: startTime,
    };

    const assistantMessage: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Response' }],
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

    handlers['turn_start']?.(turnStartEvent);
    await tick(500); // 500ms TTFT
    const messageStartTime = Date.now();
    handlers['message_start']?.({ type: 'message_start', message: assistantMessage });
    await tick(1000); // 1000ms generation time
    handlers['message_end']?.({ type: 'message_end', message: assistantMessage });

    const agentEndEvent: AgentEndEvent = {
      type: 'agent_end',
      messages: [assistantMessage],
    };

    handlers['agent_end']?.(agentEndEvent, mockCtx);

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;

    // Should contain TTFT around 0.5s and total around 1.5s
    expect(notification).toMatch(/TTFT 0\.\ds/);
    expect(notification).toMatch(/1\.\ds · out/); // Total time
  });
});
