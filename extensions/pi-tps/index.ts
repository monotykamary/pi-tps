/**
 * pi-tps — Tokens-per-second tracker for pi
 *
 * Tracks LLM generation speed (tokens/second) after every agent turn
 * and displays a persistent widget with detailed token usage stats.
 */

import type { AssistantMessage } from '@mariozechner/pi-ai';
import type { ExtensionAPI, AgentEndEvent, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { Text, truncateToWidth } from '@mariozechner/pi-tui';
import type { TUI } from '@mariozechner/pi-tui';

function isAssistantMessage(message: unknown): message is AssistantMessage {
  if (!message || typeof message !== 'object') return false;
  const role = (message as { role?: unknown }).role;
  return role === 'assistant';
}

interface TPSStats {
  tps: number;
  output: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  elapsedSeconds: number;
  timestamp: number;
}

const statsStore = new Map<string, TPSStats>();

function calculateStats(event: AgentEndEvent, startMs: number): TPSStats | null {
  const elapsedMs = Date.now() - startMs;
  if (elapsedMs <= 0) return null;

  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let totalTokens = 0;

  for (const message of event.messages) {
    if (!isAssistantMessage(message)) continue;
    input += message.usage.input || 0;
    output += message.usage.output || 0;
    cacheRead += message.usage.cacheRead || 0;
    cacheWrite += message.usage.cacheWrite || 0;
    totalTokens += message.usage.totalTokens || 0;
  }

  if (output <= 0) return null;

  const elapsedSeconds = elapsedMs / 1000;
  const tps = output / elapsedSeconds;

  return {
    tps,
    output,
    input,
    cacheRead,
    cacheWrite,
    totalTokens,
    elapsedSeconds,
    timestamp: Date.now(),
  };
}

function createWidgetRenderer(stats: TPSStats): (tui: TUI, theme: unknown) => Text {
  return (_tui: TUI, _theme: unknown) => {
    const width = process.stdout.columns || 120;

    const parts = [
      `TPS ${stats.tps.toFixed(1)} tok/s`,
      `out ${stats.output.toLocaleString()}`,
      `in ${stats.input.toLocaleString()}`,
      `cache r/w ${stats.cacheRead.toLocaleString()}/${stats.cacheWrite.toLocaleString()}`,
      `total ${stats.totalTokens.toLocaleString()}`,
      `${stats.elapsedSeconds.toFixed(1)}s`,
    ];

    const content = parts.join(' │ ');
    return new Text(truncateToWidth(content, width), 0, 0);
  };
}

function getSessionKey(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId();
}

export default function tpsExtension(pi: ExtensionAPI) {
  const startTimes = new Map<string, number>();

  // Restore widget on session start/resume if we have cached stats
  pi.on('session_start', (event, ctx) => {
    if (!ctx.hasUI) return;
    // Only restore for existing sessions (resume, fork, switch), not new ones
    if (event.reason === 'startup' || event.reason === 'reload') return;

    const key = getSessionKey(ctx);
    const stats = statsStore.get(key);
    if (stats) {
      ctx.ui.setWidget('tps', createWidgetRenderer(stats));
    }
  });

  pi.on('agent_start', (_event, ctx) => {
    const key = getSessionKey(ctx);
    startTimes.set(key, Date.now());
  });

  pi.on('agent_end', (event, ctx) => {
    if (!ctx.hasUI) return;

    const key = getSessionKey(ctx);
    const startMs = startTimes.get(key);
    startTimes.delete(key);

    if (startMs === undefined) return;

    const stats = calculateStats(event, startMs);
    if (!stats) return;

    // Persist stats for session resume
    statsStore.set(key, stats);

    // Also show transient notification
    const message = `TPS ${stats.tps.toFixed(1)} tok/s. out ${stats.output.toLocaleString()}, in ${stats.input.toLocaleString()}, cache r/w ${stats.cacheRead.toLocaleString()}/${stats.cacheWrite.toLocaleString()}, total ${stats.totalTokens.toLocaleString()}, ${stats.elapsedSeconds.toFixed(1)}s`;
    ctx.ui.notify(message, 'info');

    // Set persistent widget that survives across turns
    ctx.ui.setWidget('tps', createWidgetRenderer(stats));
  });
}
