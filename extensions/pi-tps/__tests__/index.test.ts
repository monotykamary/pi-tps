import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ExtensionAPI, AgentEndEvent, UIAPI } from '@mariozechner/pi-coding-agent';
import type { AssistantMessage } from '@mariozechner/pi-ai';

describe('pi-tps extension', () => {
  let mockPi: Partial<ExtensionAPI>;
  let mockUI: Partial<UIAPI>;
  let handlers: Record<string, (...args: unknown[]) => void>;
  let notifySpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    handlers = {};
    notifySpy = vi.fn();
    mockUI = {
      notify: notifySpy,
    };

    mockPi = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers[event] = handler;
        return mockPi as ExtensionAPI;
      }),
    };

    // Import fresh to trigger module load
    const { default: tpsExtension } = await import('../index.js');
    tpsExtension(mockPi as ExtensionAPI);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should register agent_start and agent_end handlers', () => {
    expect(mockPi.on).toHaveBeenCalledWith('agent_start', expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith('agent_end', expect.any(Function));
  });

  it('should calculate TPS correctly for single assistant message', () => {
    // Setup
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

    const mockCtx = {
      hasUI: true,
      ui: mockUI as UIAPI,
    };

    // Simulate agent flow
    handlers['agent_start']?.();

    // Wait 1 second (mocked)
    vi.advanceTimersByTime(1000);

    handlers['agent_end']?.(mockEvent, mockCtx);

    // Verify notification was called with correct format
    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;
    expect(notification).toContain('TPS');
    expect(notification).toContain('tok/s');
    expect(notification).toContain('out 200');
    expect(notification).toContain('in 100');
  });

  it('should aggregate tokens from multiple assistant messages', () => {
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

    const mockCtx = {
      hasUI: true,
      ui: mockUI as UIAPI,
    };

    handlers['agent_start']?.();
    handlers['agent_end']?.(mockEvent, mockCtx);

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;
    expect(notification).toContain('out 180'); // 100 + 80
    expect(notification).toContain('in 80'); // 50 + 30
  });

  it('should skip notification when hasUI is false', () => {
    const mockEvent: AgentEndEvent = {
      messages: [],
    };

    const mockCtx = {
      hasUI: false,
      ui: mockUI as UIAPI,
    };

    handlers['agent_start']?.();
    handlers['agent_end']?.(mockEvent, mockCtx);

    expect(notifySpy).not.toHaveBeenCalled();
  });

  it('should skip notification when no output tokens', () => {
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

    const mockCtx = {
      hasUI: true,
      ui: mockUI as UIAPI,
    };

    handlers['agent_start']?.();
    handlers['agent_end']?.(mockEvent, mockCtx);

    expect(notifySpy).not.toHaveBeenCalled();
  });

  it('should ignore non-assistant messages', () => {
    const mockEvent: AgentEndEvent = {
      messages: [
        { role: 'user', content: 'Hello' } as unknown as AssistantMessage,
        { role: 'system', content: 'System prompt' } as unknown as AssistantMessage,
      ],
    };

    const mockCtx = {
      hasUI: true,
      ui: mockUI as UIAPI,
    };

    handlers['agent_start']?.();
    handlers['agent_end']?.(mockEvent, mockCtx);

    expect(notifySpy).not.toHaveBeenCalled();
  });
});
