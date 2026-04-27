import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AssistantMessage } from '@mariozechner/pi-ai';
import { createTestFixture, activateExtension, tick } from './helpers';
import type { TurnStartEvent, TurnEndEvent, MessageUpdateEvent } from './helpers';

describe('pi-tps extension — stall detection', () => {
  let fixture: ReturnType<typeof createTestFixture>;

  beforeEach(async () => {
    fixture = createTestFixture();
    await activateExtension(fixture);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should detect stalls between message_update events', async () => {
    const { handlers, notifySpy, appendEntrySpy } = fixture;

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

    const updateEvent: MessageUpdateEvent = {
      type: 'message_update',
      message: assistantMessage,
      assistantMessageEvent: { type: 'text_delta', delta: 't' },
    };

    handlers['turn_start']?.({ type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    await tick(200); // TTFT
    handlers['message_start']?.({ type: 'message_start', message: assistantMessage });

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
    handlers['turn_end']?.(
      { type: 'turn_end', turnIndex: 0, message: assistantMessage, toolResults: [] },
      fixture.mockCtx
    );

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;

    expect(notification).toMatch(/stall \d+\.\ds×2/);
    expect(notification).toContain('TPS');

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.timing.stallCount).toBe(2);
    expect(data.timing.stallMs).toBeGreaterThanOrEqual(1300);
  });

  it('should not flag short gaps as stalls', async () => {
    const { handlers, notifySpy, appendEntrySpy } = fixture;

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

    handlers['turn_start']?.({ type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
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
      fixture.mockCtx
    );

    const notification = notifySpy.mock.calls[0][0] as string;
    expect(notification).not.toContain('stall');

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.timing.stallCount).toBe(0);
    expect(data.timing.stallMs).toBe(0);
  });
});
