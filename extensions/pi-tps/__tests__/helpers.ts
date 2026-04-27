import { vi } from 'vitest';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@mariozechner/pi-coding-agent';
import type { AssistantMessage } from '@mariozechner/pi-ai';

// ─── Event types (mirrors extension/index.ts — not exported from pi's public API) ────

export interface TurnStartEvent {
  type: 'turn_start';
  turnIndex: number;
  timestamp: number;
}

export interface TurnEndEvent {
  type: 'turn_end';
  turnIndex: number;
  message: unknown;
  toolResults: unknown[];
}

export interface MessageStartEvent {
  type: 'message_start';
  message: unknown;
}

export interface MessageUpdateEvent {
  type: 'message_update';
  message: unknown;
}

export interface MessageEndEvent {
  type: 'message_end';
  message: unknown;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Advance real time by ms (for integration-style timing tests) */
export const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

/** Create a standard AssistantMessage with overridable fields */
export function makeAssistantMessage(
  overrides: { output?: number; input?: number; provider?: string; model?: string } = {}
): AssistantMessage {
  const { output = 20, input = 10, provider = 'openai', model = 'gpt-4' } = overrides;

  return {
    role: 'assistant',
    content: [{ type: 'text' as const, text: 'Hello' }],
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
        input: 0.001,
        output: 0.002,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.003,
      },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

// ─── Mock setup ──────────────────────────────────────────────────────────────

export interface TestFixture {
  mockPi: Partial<ExtensionAPI>;
  handlers: Record<string, (...args: unknown[]) => void>;
  commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }>;
  notifySpy: ReturnType<typeof vi.fn>;
  appendEntrySpy: ReturnType<typeof vi.fn>;
  eventsEmitSpy: ReturnType<typeof vi.fn>;
  registerCommandSpy: ReturnType<typeof vi.fn>;
  mockEntries: Array<{ type?: string; role?: string; customType?: string; data?: unknown }>;
  mockCtx: ExtensionContext;
}

/**
 * Create a fresh set of mocks for one test.
 * Call `activateExtension()` on the result to wire up the extension.
 */
export function createTestFixture(): TestFixture {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
  const notifySpy = vi.fn();
  const appendEntrySpy = vi.fn();
  const registerCommandSpy = vi.fn((name: string, options: any) => {
    commands[name] = options;
  });
  const mockEntries: Array<{
    type?: string;
    role?: string;
    customType?: string;
    data?: unknown;
  }> = [];

  const mockCtx = {
    hasUI: true,
    ui: { notify: notifySpy } as any,
    sessionManager: {
      getEntries: vi.fn().mockReturnValue(mockEntries),
      getBranch: vi.fn(),
      getSessionId: vi.fn(),
    },
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
  } as any as ExtensionContext;

  const eventsEmitSpy = vi.fn();

  const mockPi: Partial<ExtensionAPI> = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers[event] = handler;
      return mockPi as ExtensionAPI;
    }),
    appendEntry: appendEntrySpy,
    registerCommand: registerCommandSpy,
    events: { emit: eventsEmitSpy, on: vi.fn() },
  };

  return {
    mockPi,
    handlers,
    commands,
    notifySpy,
    appendEntrySpy,
    eventsEmitSpy,
    registerCommandSpy,
    mockEntries,
    mockCtx,
  };
}

/** Import the extension module and wire it to the test fixture's mockPi */
export async function activateExtension(fixture: TestFixture) {
  const { default: tpsExtension } = await import('../index.js');
  tpsExtension(fixture.mockPi as ExtensionAPI);
}
