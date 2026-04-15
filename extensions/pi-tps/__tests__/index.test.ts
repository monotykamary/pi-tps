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
  let setWidgetSpy: ReturnType<typeof vi.fn>;
  let mockSessionManager: { getSessionId: ReturnType<typeof vi.fn> };
  let mockCtx: ExtensionContext;

  beforeEach(async () => {
    handlers = {};
    notifySpy = vi.fn();
    setWidgetSpy = vi.fn();
    // Use unique session key per test to avoid state leakage
    const testId = Math.random().toString(36).substring(7);
    mockSessionManager = { getSessionId: vi.fn().mockReturnValue(`test-session-${testId}`) };

    mockUI = {
      notify: notifySpy,
      setWidget: setWidgetSpy,
    };

    mockCtx = {
      hasUI: true,
      ui: mockUI as UIAPI,
      sessionManager: mockSessionManager as unknown as ExtensionContext['sessionManager'],
    } as ExtensionContext;

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

  it('should register agent_start, agent_end, and session_start handlers', () => {
    expect(mockPi.on).toHaveBeenCalledWith('agent_start', expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith('agent_end', expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith('session_start', expect.any(Function));
  });

  it('should calculate TPS correctly for single assistant message', async () => {
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

    handlers['agent_start']?.({}, mockCtx);
    await tick();
    handlers['agent_end']?.(mockEvent, mockCtx);

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;
    expect(notification).toContain('TPS');
    expect(notification).toContain('tok/s');
    expect(notification).toContain('out 200');
    expect(notification).toContain('in 100');

    // Widget should be set
    expect(setWidgetSpy).toHaveBeenCalledWith('tps', expect.any(Function));
  });

  it('should persist widget on session resume if stats exist', async () => {
    // First, generate some stats
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

    handlers['agent_start']?.({}, mockCtx);
    await tick();
    handlers['agent_end']?.(mockEvent, mockCtx);

    expect(setWidgetSpy).toHaveBeenCalledWith('tps', expect.any(Function));

    // Clear and simulate session resume (reason: 'switch' should restore widget)
    setWidgetSpy.mockClear();
    handlers['session_start']?.({ reason: 'switch' }, mockCtx);

    // Widget should be restored
    expect(setWidgetSpy).toHaveBeenCalledWith('tps', expect.any(Function));
  });

  it('should not restore widget on session start for new sessions', async () => {
    // Simulate session start for new session (reason: 'startup')
    handlers['session_start']?.({ reason: 'startup' }, mockCtx);
    expect(setWidgetSpy).not.toHaveBeenCalled();
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

    handlers['agent_start']?.({}, mockCtx);
    await tick();
    handlers['agent_end']?.(mockEvent, mockCtx);

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;
    expect(notification).toContain('out 180'); // 100 + 80
    expect(notification).toContain('in 80'); // 50 + 30
  });

  it('should skip notification and widget when hasUI is false', async () => {
    const mockEvent: AgentEndEvent = {
      messages: [],
    };

    const noUiCtx = {
      ...mockCtx,
      hasUI: false,
    };

    handlers['agent_start']?.({}, noUiCtx);
    await tick();
    handlers['agent_end']?.(mockEvent, noUiCtx);

    expect(notifySpy).not.toHaveBeenCalled();
    expect(setWidgetSpy).not.toHaveBeenCalled();
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

    handlers['agent_start']?.({}, mockCtx);
    await tick();
    handlers['agent_end']?.(mockEvent, mockCtx);

    expect(notifySpy).not.toHaveBeenCalled();
    expect(setWidgetSpy).not.toHaveBeenCalled();
  });

  it('should ignore non-assistant messages', async () => {
    const mockEvent: AgentEndEvent = {
      messages: [
        { role: 'user', content: 'Hello' } as unknown as AssistantMessage,
        { role: 'system', content: 'System prompt' } as unknown as AssistantMessage,
      ],
    };

    handlers['agent_start']?.({}, mockCtx);
    await tick();
    handlers['agent_end']?.(mockEvent, mockCtx);

    expect(notifySpy).not.toHaveBeenCalled();
    expect(setWidgetSpy).not.toHaveBeenCalled();
  });

  it('should not restore widget on session resume if no stats', () => {
    handlers['session_start']?.({ reason: 'switch' }, mockCtx);
    expect(setWidgetSpy).not.toHaveBeenCalled();
  });
});
