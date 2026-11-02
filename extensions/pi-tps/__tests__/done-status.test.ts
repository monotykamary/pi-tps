import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateExtension, createTestFixture, makeAssistantMessage } from './helpers';

describe('completion notification', () => {
  let fixture: ReturnType<typeof createTestFixture>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-02T19:11:00Z'));
    fixture = createTestFixture();
    await activateExtension(fixture);
  });

  afterEach(() => vi.useRealTimers());

  it('adds the local completion time only after the assistant settles', () => {
    const { handlers, mockCtx, notifySpy } = fixture;
    const message = makeAssistantMessage();
    handlers.before_agent_start?.({}, mockCtx);
    handlers.turn_start?.({ turnIndex: 0, timestamp: Date.now() }, mockCtx);
    vi.advanceTimersByTime(10);
    handlers.message_start?.({ message }, mockCtx);
    handlers.message_update?.({ message }, mockCtx);
    vi.advanceTimersByTime(100);
    handlers.message_end?.({ message }, mockCtx);
    handlers.turn_end?.({ turnIndex: 0, message, toolResults: [] }, mockCtx);
    expect(notifySpy).toHaveBeenCalled();
    expect(notifySpy.mock.calls.at(-1)?.[0]).not.toContain('done');
    handlers.agent_end?.({}, mockCtx);
    expect(notifySpy.mock.calls.at(-1)?.[0]).not.toContain('done');
    handlers.agent_settled?.({ aborted: false }, mockCtx);
    const clock = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    expect(notifySpy).toHaveBeenLastCalledWith(expect.stringContaining(` · done ${clock}`), 'info');
    expect(notifySpy.mock.calls.at(-1)?.[0]).toContain('TPS');
  });

  it('does not notify on abort or without a UI', () => {
    fixture.handlers.agent_settled?.({ aborted: true }, fixture.mockCtx);
    Object.assign(fixture.mockCtx, { hasUI: false });
    fixture.handlers.agent_settled?.({ aborted: false }, fixture.mockCtx);
    expect(fixture.notifySpy).not.toHaveBeenCalled();
  });

  it('does not reuse telemetry from a previous request', () => {
    const { handlers, mockCtx, notifySpy } = fixture;
    const message = makeAssistantMessage();
    handlers.turn_start?.({ turnIndex: 0, timestamp: Date.now() }, mockCtx);
    vi.advanceTimersByTime(10);
    handlers.message_start?.({ message }, mockCtx);
    handlers.message_update?.({ message }, mockCtx);
    vi.advanceTimersByTime(100);
    handlers.message_end?.({ message }, mockCtx);
    handlers.turn_end?.({ turnIndex: 0, message, toolResults: [] }, mockCtx);
    handlers.before_agent_start?.({}, mockCtx);
    handlers.agent_settled?.({ aborted: false }, mockCtx);
    expect(notifySpy.mock.calls.at(-1)?.[0]).toMatch(/^done /);
  });
});
