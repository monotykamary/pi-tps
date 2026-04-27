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
    expect(mockPi.on).toHaveBeenCalledWith('session_tree', expect.any(Function));
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

    // Check format: TPS X.X tok/s · TTFT <duration> · <duration> · out X · in X
    expect(notification).toMatch(/TPS \d+\.\d tok\/s/);
    expect(notification).toMatch(/TTFT \d/); // TTFT has at least one digit
    expect(notification).toMatch(/out 200/);
    expect(notification).toMatch(/in 100/);

    expect(appendEntrySpy).toHaveBeenCalledOnce();
    const [type, data] = appendEntrySpy.mock.calls[0];
    expect(type).toBe('tps');
    expect(data.message).toContain('TPS');
    expect(data.timestamp).toBeTypeOf('number');
  });

  it('should restore notification on session resume if entry exists', async () => {
    mockEntries.push({
      type: 'custom',
      customType: 'tps',
      data: {
        message: 'TPS 42.0 tok/s · TTFT 1.2s · 5.0s · out 100 · in 50',
        timestamp: Date.now(),
      },
    });

    handlers['session_start']?.({ reason: 'resume' }, mockCtx);
    await tick(); // deferred via setTimeout(0)

    expect(notifySpy).toHaveBeenCalledOnce();
    expect(notifySpy).toHaveBeenCalledWith(
      'TPS 42.0 tok/s · TTFT 1.2s · 5.0s · out 100 · in 50',
      'info'
    );
  });

  it('should restore notification on session startup (continuing previous session)', async () => {
    mockEntries.push({
      type: 'custom',
      customType: 'tps',
      data: { message: 'TPS 42.0 tok/s · TTFT 1.0s · 3.0s', timestamp: Date.now() },
    });

    handlers['session_start']?.({ reason: 'startup' }, mockCtx);
    await tick(); // deferred via setTimeout(0)

    expect(notifySpy).toHaveBeenCalledOnce();
    expect(notifySpy).toHaveBeenCalledWith('TPS 42.0 tok/s · TTFT 1.0s · 3.0s', 'info');
  });

  it('should restore notification on session reload', async () => {
    mockEntries.push({
      type: 'custom',
      customType: 'tps',
      data: { message: 'TPS 42.0 tok/s · TTFT 1.0s · 3.0s', timestamp: Date.now() },
    });

    handlers['session_start']?.({ reason: 'reload' }, mockCtx);
    await tick(); // deferred via setTimeout(0)

    expect(notifySpy).toHaveBeenCalledOnce();
    expect(notifySpy).toHaveBeenCalledWith('TPS 42.0 tok/s · TTFT 1.0s · 3.0s', 'info');
  });

  it('should not restore notification on session start for new sessions', () => {
    mockEntries.push({
      type: 'custom',
      customType: 'tps',
      data: { message: 'TPS 42.0 tok/s · TTFT 1.0s · 3.0s', timestamp: Date.now() },
    });

    handlers['session_start']?.({ reason: 'new' }, mockCtx);

    expect(notifySpy).not.toHaveBeenCalled();
  });

  it('should restore notification on tree navigation', async () => {
    mockEntries.push({
      type: 'custom',
      customType: 'tps',
      data: { message: 'TPS 42.0 tok/s · TTFT 1.0s · 3.0s', timestamp: Date.now() },
    });

    handlers['session_tree']?.({ newLeafId: 'abc123', oldLeafId: 'def456' }, mockCtx);
    await tick(); // deferred via setTimeout(0)

    expect(notifySpy).toHaveBeenCalledOnce();
    expect(notifySpy).toHaveBeenCalledWith('TPS 42.0 tok/s · TTFT 1.0s · 3.0s', 'info');
  });

  it('should restore the most recent TPS entry on resume', async () => {
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
    await tick(); // deferred via setTimeout(0)

    expect(notifySpy).toHaveBeenCalledOnce();
    expect(notifySpy).toHaveBeenCalledWith('TPS 50.0 tok/s recent', 'info');
  });

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

    // Agent end event includes ALL session messages (simulating long session)
    // This tests that we only count messages that went through message_start/end
    const historicalMessage: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Historical from previous turns' }],
      api: 'openai-completions',
      provider: 'openai',
      model: 'gpt-4',
      usage: {
        input: 1000,
        output: 5000, // This should NOT be counted - it wasn't in the turn
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 6000,
        cost: {
          input: 0.001,
          output: 0.002,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.00375,
        },
      },
      stopReason: 'stop',
      timestamp: Date.now() - 100000, // Old message
    };

    const agentEndEvent: AgentEndEvent = {
      type: 'agent_end',
      // Session history includes old message + current turn messages
      messages: [historicalMessage, firstMessage, secondMessage],
    };

    handlers['agent_end']?.(agentEndEvent, mockCtx);

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;
    // Should only count current turn messages (100 + 80 = 180), not the 5000 from history
    expect(notification).toContain('out 180'); // 100 + 80
    expect(notification).toContain('in 80'); // 50 + 30
    expect(notification).not.toContain('out 5'); // Should not include the 5000 historical tokens
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

    // Should contain TTFT around 0-1s and total around 1-2s
    expect(notification).toMatch(/TTFT \d/);
    expect(notification).toMatch(/\d+s · out |\d+m \d+s · out/); // Total time
  });

  it('should calculate true generation TPS excluding TTFT and tool gaps', async () => {
    const turnStartEvent: TurnStartEvent = {
      type: 'turn_start',
      turnIndex: 0,
      timestamp: Date.now(),
    };

    // First assistant message (tool call)
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

    // Second assistant message (final response)
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

    // Simulate: true generation time excludes gaps
    handlers['turn_start']?.(turnStartEvent);
    await tick(100); // TTFT (excluded from generation TPS)

    // First message: 200ms pure generation
    handlers['message_start']?.({ type: 'message_start', message: firstMessage });
    await tick(200);
    handlers['message_end']?.({ type: 'message_end', message: firstMessage });

    // TOOL EXECUTION GAP: 1000ms (excluded from generation TPS)
    await tick(1000);

    // Second message: 400ms pure generation
    handlers['message_start']?.({ type: 'message_start', message: secondMessage });
    await tick(400);
    handlers['message_end']?.({ type: 'message_end', message: secondMessage });

    const agentEndEvent: AgentEndEvent = {
      type: 'agent_end',
      messages: [firstMessage, secondMessage],
    };

    handlers['agent_end']?.(agentEndEvent, mockCtx);

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;

    // True generation TPS: 1000 tokens / 0.6s (200ms + 400ms) = ~1667 TPS
    // TTFT and tool gaps are excluded - this is actual LLM inference speed
    const tpsMatch = notification.match(/TPS (\d+(?:\.\d+)?) tok\/s/);
    expect(tpsMatch).toBeTruthy();
    const tps = parseFloat(tpsMatch![1]);

    // Should be ~1667 (raw LLM speed), not ~588 (wall-clock with gaps)
    expect(tps).toBeGreaterThan(1000); // True generation is fast
    expect(tps).toBeLessThan(2000); // But not absurdly high
    expect(notification).toContain('out 1,000'); // 200 + 800 tokens
    expect(notification).toContain('in 600'); // 100 + 500 tokens
  });
});

describe('formatDuration', () => {
  // Dynamic import to access named export from module
  const importFormatDuration = async () => {
    const mod = await import('../index.js');
    return mod.formatDuration;
  };

  it('formats sub-minute durations as seconds only', async () => {
    const formatDuration = await importFormatDuration();
    expect(formatDuration(0.8)).toBe('1s'); // rounds up
    expect(formatDuration(1)).toBe('1s');
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(59.4)).toBe('59s');
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
    expect(formatDuration(2592000)).toBe('1mo 0d'); // exactly 30 days
    expect(formatDuration(2851200)).toBe('1mo 3d'); // 33 days = 1mo + 3d
    expect(formatDuration(5184000)).toBe('2mo 0d'); // exactly 60 days
    expect(formatDuration(7776000)).toBe('3mo 0d'); // exactly 90 days
    expect(formatDuration(9504000)).toBe('3mo 2w'); // 110 days = 3mo + 2w
  });

  it('handles large multi-month durations', async () => {
    const formatDuration = await importFormatDuration();
    expect(formatDuration(15552000)).toBe('6mo 0d');
    expect(formatDuration(31536000)).toBe('12mo 5d'); // ~365 days = 12mo + 5d (5 days remain after 12 months)
    expect(formatDuration(63072000)).toBe('24mo 1w'); // ~730 days = 24mo + 1w 3d → shows as 24mo 1w
  });

  it('rounds correctly', async () => {
    const formatDuration = await importFormatDuration();
    expect(formatDuration(45.3)).toBe('45s');
    expect(formatDuration(45.7)).toBe('46s');
    expect(formatDuration(89.9)).toBe('1m 30s');
    expect(formatDuration(90.1)).toBe('1m 30s');
  });
});
