import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createTestFixture, activateExtension, tick, makeAssistantMessage } from './helpers';

/**
 * Coverage for the blended $/M-tokens notification field:
 *   rateUsdPerMTokens = effectiveCost / (tokens.total / 1_000_000)
 *
 * effectiveCost is:
 *   - the Neuralwatt billed cost when stashed via the `neuralwatt:turn-energy`
 *     event (energy-based, what the user actually pays)
 *   - otherwise the list-price compute cost from message.usage.cost.total
 *
 * Only one source contributes per turn (no double-counting): when both are
 * present the billed cost wins outright.
 */

function makeMessageWithCost(opts: {
  input: number;
  output: number;
  costTotal: number;
  provider?: string;
  model?: string;
}): AssistantMessage {
  const { input, output, costTotal, provider = 'openai', model = 'gpt-4' } = opts;
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'Hello' }],
    api: 'openai-completions',
    provider,
    model,
    usage: {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: costTotal,
      },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

/** Drive a minimal turn that yields primary-branch null TPS (burst) but valid telemetry. */
async function runBurstTurn(
  fixture: ReturnType<typeof createTestFixture>,
  message: AssistantMessage,
  turnIndex = 0
) {
  const { handlers, mockCtx } = fixture;
  handlers['turn_start']?.({ type: 'turn_start', turnIndex, timestamp: Date.now() });
  await tick(50);
  handlers['message_start']?.({ type: 'message_start', message });
  await tick(50);
  handlers['message_update']?.({
    type: 'message_update',
    message,
    assistantMessageEvent: { type: 'text_delta', delta: 't' },
  });
  handlers['message_end']?.({ type: 'message_end', message });
  handlers['turn_end']?.({ type: 'turn_end', turnIndex, message, toolResults: [] }, mockCtx);
}

describe('pi-tps extension — blended $/M-tokens rate', () => {
  let fixture: ReturnType<typeof createTestFixture>;

  beforeEach(async () => {
    fixture = createTestFixture();
    await activateExtension(fixture);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows list-price $/M rate in the banner from message.usage.cost.total', async () => {
    // 1000 in + 1000 out = 2000 tokens; cost.total = $0.008 → $4.00/M
    const message = makeMessageWithCost({ input: 1000, output: 1000, costTotal: 0.008 });

    await runBurstTurn(fixture, message);

    const { notifySpy, appendEntrySpy } = fixture;
    expect(notifySpy).toHaveBeenCalledOnce();
    const banner = notifySpy.mock.calls[0][0] as string;
    expect(banner).toContain('$4.00/M');
    expect(banner).not.toMatch(/\$.*\/M.*\$.*\/M/); // exactly one rate segment

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.rateUsdPerMTokens).toBe(4.0);
  });

  it('uses Neuralwatt billed cost over list-price when the energy event fires first', async () => {
    // Same token volume, but billed cost differs from list price.
    // 2000 tokens; list cost.total = $0.008 ($4.00/M); billed = $0.006 ($3.00/M)
    const message = makeMessageWithCost({
      input: 1000,
      output: 1000,
      costTotal: 0.008,
      provider: 'neuralwatt',
      model: 'moonshotai/Kimi-K2.5',
    });

    // Simulate the neuralwatt provider's turn_end running BEFORE ours: it emits
    // the per-turn energy event, which our listener stashes keyed by turnIndex.
    fixture.emitEvent('neuralwatt:turn-energy', {
      costUsd: 0.006,
      energyJoules: 21.6,
      turnIndex: 0,
    });

    await runBurstTurn(fixture, message, 0);

    const { notifySpy, appendEntrySpy } = fixture;
    expect(notifySpy).toHaveBeenCalledOnce();
    const banner = notifySpy.mock.calls[0][0] as string;
    // Billed ($3.00/M) wins over list-price ($4.00/M)
    expect(banner).toContain('$3.00/M');
    expect(banner).not.toContain('$4.00/M');

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.rateUsdPerMTokens).toBe(3.0);
    // The cost block still carries the list-price compute cost separately.
    expect(data.cost).toEqual(expect.objectContaining({ total: 0.008 }));
  });

  it('null rate when totalTokens is zero (degenerate)', async () => {
    const message = makeMessageWithCost({ input: 0, output: 1000, costTotal: 0.008 });
    message.usage.totalTokens = 0;

    await runBurstTurn(fixture, message);

    const { appendEntrySpy, notifySpy } = fixture;
    const banner = notifySpy.mock.calls[0][0] as string;
    expect(banner).not.toMatch(/\$.*\/M/);
    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.rateUsdPerMTokens).toBeNull();
  });

  it('null rate when cost is unavailable', async () => {
    // No usage.cost at all → effectiveCost null → rate null.
    const message = makeAssistantMessage({ output: 500, input: 500 });
    // Strip the cost block that makeAssistantMessage adds.
    (message.usage as any).cost = null;
    // Allow the isAssistantMessage guard to still pass: it only checks input/output.
    await runBurstTurn(fixture, message);

    const { appendEntrySpy } = fixture;
    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.rateUsdPerMTokens).toBeNull();
    expect(data.cost).toBeNull();
  });

  it('falls back to list-price rate when billed-cost event misses (out-of-order load)', async () => {
    // Neuralwatt turn but the energy event never arrives (provider loaded after
    // us). Must not block or crash — falls back to the list-price compute rate.
    const message = makeMessageWithCost({
      input: 500,
      output: 500,
      costTotal: 0.004, // $4.00/M for 1000 tokens
      provider: 'neuralwatt',
      model: 'moonshotai/Kimi-K2.5',
    });

    await runBurstTurn(fixture, message);

    const { notifySpy } = fixture;
    const banner = notifySpy.mock.calls[0][0] as string;
    expect(banner).toContain('$4.00/M');
  });

  it('ignores neuralwatt:turn-energy payloads lacking a numeric turnIndex', async () => {
    // Defensive: malformed event must not pollute the cache.
    fixture.emitEvent('neuralwatt:turn-energy', { costUsd: 0.006, energyJoules: 21.6 }); // no turnIndex
    const message = makeMessageWithCost({ input: 1000, output: 1000, costTotal: 0.008 });

    await runBurstTurn(fixture, message);

    const { notifySpy } = fixture;
    const banner = notifySpy.mock.calls[0][0] as string;
    // Falls back to list-price since no valid turnIndex-keyed entry landed.
    expect(banner).toContain('$4.00/M');
  });

  it('rehydrates a rate segment from structured telemetry on session resume', async () => {
    const { handlers, notifySpy, mockEntries } = fixture;

    mockEntries.push({
      type: 'custom',
      customType: 'tps',
      data: {
        model: { provider: 'openai', modelId: 'gpt-4' },
        tokens: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0, total: 2000 },
        timing: {
          ttftMs: 1000,
          totalMs: 3000,
          generationMs: 2000,
          stallMs: 0,
          stallCount: 0,
          messageCount: 1,
        },
        tps: 10.0,
        rateUsdPerMTokens: 4.0,
        timestamp: Date.now(),
      },
    });

    handlers['session_start']?.({ reason: 'resume' }, fixture.mockCtx);
    await tick();

    expect(notifySpy).toHaveBeenCalledOnce();
    const banner = notifySpy.mock.calls[0][0] as string;
    expect(banner).toContain('$4.00/M');
  });

  it('rehydrates older telemetry without a rate field without crashing (omits the segment)', async () => {
    const { handlers, notifySpy, mockEntries } = fixture;

    mockEntries.push({
      type: 'custom',
      customType: 'tps',
      data: {
        model: { provider: 'openai', modelId: 'gpt-4' },
        tokens: { input: 50, output: 100, cacheRead: 0, cacheWrite: 0, total: 150 },
        timing: {
          ttftMs: 1000,
          totalMs: 3000,
          generationMs: 2000,
          stallMs: 0,
          stallCount: 0,
          messageCount: 1,
        },
        tps: 10.0,
        // rateUsdPerMTokens intentionally absent (pre-feature entry)
        timestamp: Date.now(),
      },
    });

    handlers['session_start']?.({ reason: 'resume' }, fixture.mockCtx);
    await tick();

    expect(notifySpy).toHaveBeenCalledOnce();
    const banner = notifySpy.mock.calls[0][0] as string;
    expect(banner).not.toMatch(/\$.*\/M/);
  });

  it('falls back to a persisted neuralwatt-energy entry when the live event is missed', async () => {
    const now = Date.now();
    const message = makeMessageWithCost({
      input: 1000,
      output: 1000,
      costTotal: 0.008, // list price: $4.00/M
      provider: 'neuralwatt',
      model: 'moonshotai/Kimi-K2.5',
    });

    // Provider appended its energy entry before pi-tps handled turn_end.
    fixture.mockEntries.push({
      type: 'custom',
      customType: 'neuralwatt-energy',
      data: { energy_joules: 21.6, cost_usd: 0.006 }, // $3.00/M for 2000 tokens
      timestamp: now,
    });

    const { handlers, notifySpy, appendEntrySpy } = fixture;
    handlers['turn_start']?.({ type: 'turn_start', turnIndex: 0, timestamp: now - 100 });
    await tick(50);
    handlers['message_start']?.({ type: 'message_start', message });
    await tick(50);
    handlers['message_update']?.({
      type: 'message_update',
      message,
      assistantMessageEvent: { type: 'text_delta', delta: 'H' },
    });
    handlers['message_end']?.({ type: 'message_end', message });
    handlers['turn_end']?.(
      { type: 'turn_end', turnIndex: 0, message, toolResults: [] },
      fixture.mockCtx
    );

    expect(notifySpy).toHaveBeenCalledOnce();
    const banner = notifySpy.mock.calls[0][0] as string;
    expect(banner).toContain('$3.00/M');
    expect(banner).not.toContain('$4.00/M');

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.rateUsdPerMTokens).toBe(3.0);
  });

  it('ignores stale neuralwatt-energy entries from before this turn', async () => {
    const now = Date.now();
    const message = makeMessageWithCost({
      input: 1000,
      output: 1000,
      costTotal: 0.008, // list price: $4.00/M
      provider: 'neuralwatt',
      model: 'moonshotai/Kimi-K2.5',
    });

    fixture.mockEntries.push({
      type: 'custom',
      customType: 'neuralwatt-energy',
      data: { energy_joules: 1, cost_usd: 9999 }, // absurd cost, should be ignored
      timestamp: now - 1000,
    });

    const { handlers, notifySpy } = fixture;
    handlers['turn_start']?.({ type: 'turn_start', turnIndex: 0, timestamp: now });
    await tick(50);
    handlers['message_start']?.({ type: 'message_start', message });
    await tick(50);
    handlers['message_update']?.({
      type: 'message_update',
      message,
      assistantMessageEvent: { type: 'text_delta', delta: 'H' },
    });
    handlers['message_end']?.({ type: 'message_end', message });
    handlers['turn_end']?.(
      { type: 'turn_end', turnIndex: 0, message, toolResults: [] },
      fixture.mockCtx
    );

    expect(notifySpy).toHaveBeenCalledOnce();
    const banner = notifySpy.mock.calls[0][0] as string;
    expect(banner).toContain('$4.00/M');
    expect(banner).not.toContain('$9999');
  });
});
