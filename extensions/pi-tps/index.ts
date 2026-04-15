/**
 * pi-tps — Tokens-per-second tracker for pi
 *
 * Tracks LLM generation speed (tokens/second) after every agent turn,
 * shows a notification, and restores it on session resume.
 *
 * Originally from: https://github.com/badlogic/pi-mono/blob/main/.pi/extensions/tps.ts
 */

import type { AssistantMessage } from '@mariozechner/pi-ai';
import type { ExtensionAPI, AgentEndEvent, ExtensionContext } from '@mariozechner/pi-coding-agent';

interface TPSData {
  message: string;
  timestamp: number;
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
  if (!message || typeof message !== 'object') return false;
  const role = (message as { role?: unknown }).role;
  return role === 'assistant';
}

function calculateStats(event: AgentEndEvent, startMs: number): string | null {
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

  return `TPS ${tps.toFixed(1)} tok/s. out ${output.toLocaleString()}, in ${input.toLocaleString()}, cache r/w ${cacheRead.toLocaleString()}/${cacheWrite.toLocaleString()}, total ${totalTokens.toLocaleString()}, ${elapsedSeconds.toFixed(1)}s`;
}

export default function tpsExtension(pi: ExtensionAPI) {
  let agentStartMs: number | null = null;

  // Restore notification on session resume if we have saved stats
  pi.on('session_start', (event, ctx) => {
    if (!ctx.hasUI) return;
    // Only restore for existing sessions (resume, fork, switch), not new ones
    if (event.reason === 'startup' || event.reason === 'reload') return;

    const entries = ctx.sessionManager.getEntries();
    // Find the most recent TPS entry
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === 'custom' && entry.customType === 'tps') {
        const data = entry.data as TPSData;
        if (data?.message) {
          ctx.ui.notify(data.message, 'info');
        }
        break;
      }
    }
  });

  pi.on('agent_start', () => {
    agentStartMs = Date.now();
  });

  pi.on('agent_end', (event, ctx) => {
    if (!ctx.hasUI) return;
    if (agentStartMs === null) return;

    const startMs = agentStartMs;
    agentStartMs = null;

    const message = calculateStats(event, startMs);
    if (!message) return;

    // Show notification immediately
    ctx.ui.notify(message, 'info');

    // Save to session for restoration on resume
    pi.appendEntry('tps', { message, timestamp: Date.now() });
  });
}
