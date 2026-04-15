import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  ExtensionAPI,
  AgentEndEvent,
  UIAPI,
  ExtensionContext,
} from '@mariozechner/pi-coding-agent';
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

  it('should register agent_start, agent_end, and session_start handlers', () => {
    expect(mockPi.on).toHaveBeenCalledWith('session_start', expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith('agent_start', expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith('agent_end', expect.any(Function));
  });

  it('should show notification and save entry after agent_end', async () => {
    const mockMessage: AssistantMessage = {
      role: 'assistant',
      content: 'Hello world',
      usage: {
        input: 100,
        output: 200,
        cacheRead: 50,
        cacheWrite: 25,
        totalTokens: 375,
      },
    };

    const mockEvent: AgentEndEvent = {
      messages: [mockMessage],
    };

    handlers['agent_start']?.();
    await tick();
    handlers['agent_end']?.(mockEvent, mockCtx);

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;
    expect(notification).toContain('TPS');
    expect(notification).toContain('tok/s');
    expect(notification).toContain('out 200');
    expect(notification).toContain('in 100');

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
      data: { message: 'TPS 42.0 tok/s. out 100', timestamp: Date.now() },
    });

    handlers['session_start']?.({ reason: 'switch' }, mockCtx);

    expect(notifySpy).toHaveBeenCalledOnce();
    expect(notifySpy).toHaveBeenCalledWith('TPS 42.0 tok/s. out 100', 'info');
  });

  it('should not restore notification on session start for new sessions', () => {
    mockEntries.push({
      type: 'custom',
      customType: 'tps',
      data: { message: 'TPS 42.0 tok/s', timestamp: Date.now() },
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
    const mockMessages: AssistantMessage[] = [
      {
        role: 'assistant',
        content: 'First',
        usage: {
          input: 50,
          output: 100,
          cacheRead: 25,
          cacheWrite: 10,
          totalTokens: 185,
        },
      },
      {
        role: 'assistant',
        content: 'Second',
        usage: {
          input: 30,
          output: 80,
          cacheRead: 15,
          cacheWrite: 5,
          totalTokens: 130,
        },
      },
    ];

    const mockEvent: AgentEndEvent = {
      messages: mockMessages,
    };

    handlers['agent_start']?.();
    await tick();
    handlers['agent_end']?.(mockEvent, mockCtx);

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;
    expect(notification).toContain('out 180'); // 100 + 80
    expect(notification).toContain('in 80'); // 50 + 30
  });

  it('should skip notification when hasUI is false', async () => {
    const noUiCtx = { ...mockCtx, hasUI: false };
    const mockEvent: AgentEndEvent = {
      messages: [
        {
          role: 'assistant',
          content: 'Hello',
          usage: { input: 10, output: 20, totalTokens: 30 },
        } as AssistantMessage,
      ],
    };

    handlers['agent_start']?.();
    await tick();
    handlers['agent_end']?.(mockEvent, noUiCtx);

    expect(notifySpy).not.toHaveBeenCalled();
  });

  it('should skip notification when no output tokens', async () => {
    const mockMessage: AssistantMessage = {
      role: 'assistant',
      content: 'No tokens',
      usage: {
        input: 10,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 10,
      },
    };

    const mockEvent: AgentEndEvent = {
      messages: [mockMessage],
    };

    handlers['agent_start']?.();
    await tick();
    handlers['agent_end']?.(mockEvent, mockCtx);

    expect(notifySpy).not.toHaveBeenCalled();
    expect(appendEntrySpy).not.toHaveBeenCalled();
  });

  it('should ignore non-assistant messages', async () => {
    const mockEvent: AgentEndEvent = {
      messages: [
        { role: 'user', content: 'Hello' } as unknown as AssistantMessage,
        { role: 'system', content: 'System prompt' } as unknown as AssistantMessage,
      ],
    };

    handlers['agent_start']?.();
    await tick();
    handlers['agent_end']?.(mockEvent, mockCtx);

    expect(notifySpy).not.toHaveBeenCalled();
    expect(appendEntrySpy).not.toHaveBeenCalled();
  });

  it('should skip notification when agent_start was not called', () => {
    const mockEvent: AgentEndEvent = {
      messages: [
        {
          role: 'assistant',
          content: 'Hello',
          usage: { input: 10, output: 20, totalTokens: 30 },
        } as AssistantMessage,
      ],
    };

    // Don't call agent_start, just agent_end
    handlers['agent_end']?.(mockEvent, mockCtx);

    expect(notifySpy).not.toHaveBeenCalled();
    expect(appendEntrySpy).not.toHaveBeenCalled();
  });
});
