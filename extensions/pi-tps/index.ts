/**
 * pi-tps — Tokens-per-second tracker for pi
 *
 * Tracks LLM generation speed (tokens/second) after every agent turn,
 * shows TTFT (time to first token) and TPS metrics, and restores
 * notifications on session resume.
 *
 * Originally from: https://github.com/badlogic/pi-mono/blob/main/.pi/extensions/tps.ts
 */

import type { AssistantMessage, Message } from '@mariozechner/pi-ai';
import type { ExtensionAPI, AgentEndEvent, ExtensionContext } from '@mariozechner/pi-coding-agent';

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

interface TPSData {
  message: string;
  timestamp: number;
}

interface TurnTiming {
  turnStartMs: number;
  firstTokenMs: number | null;
  lastTokenMs: number | null;
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
  if (!message || typeof message !== 'object') return false;
  const role = (message as { role?: unknown }).role;
  return role === 'assistant';
}

function formatNumber(num: number): string {
  return num.toLocaleString();
}

function calculateStats(event: AgentEndEvent, timing: TurnTiming): string | null {
  // Aggregate token usage from all assistant messages
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
  if (!timing.firstTokenMs || !timing.lastTokenMs) return null;

  const ttftMs = timing.firstTokenMs - timing.turnStartMs;
  const generationMs = timing.lastTokenMs - timing.firstTokenMs;
  const totalMs = timing.lastTokenMs - timing.turnStartMs;

  if (generationMs <= 0) return null;

  const generationSeconds = generationMs / 1000;
  const tps = output / generationSeconds;
  const ttftSeconds = ttftMs / 1000;
  const totalSeconds = totalMs / 1000;

  return `TPS ${tps.toFixed(1)} tok/s · TTFT ${ttftSeconds.toFixed(1)}s · ${totalSeconds.toFixed(1)}s · out ${formatNumber(output)} · in ${formatNumber(input)}`;
}

export default function tpsExtension(pi: ExtensionAPI) {
  // Current turn timing state
  let currentTiming: TurnTiming | null = null;
  // Track if we've seen any assistant messages in this turn
  let hasSeenAssistantMessage = false;

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

  // Track when a turn starts (request sent to LLM)
  pi.on('turn_start', (event: TurnStartEvent) => {
    currentTiming = {
      turnStartMs: event.timestamp,
      firstTokenMs: null,
      lastTokenMs: null,
    };
    hasSeenAssistantMessage = false;
  });

  // Track when a message starts (first token received)
  pi.on('message_start', (event: MessageStartEvent) => {
    if (!currentTiming) return;
    if (!isAssistantMessage(event.message)) return;

    // Only capture TTFT for the first assistant message
    if (!hasSeenAssistantMessage) {
      currentTiming.firstTokenMs = Date.now();
      hasSeenAssistantMessage = true;
    }
  });

  // Track when a message ends
  pi.on('message_end', (event: MessageEndEvent) => {
    if (!currentTiming) return;
    if (!isAssistantMessage(event.message)) return;

    // Update last token time for each assistant message
    currentTiming.lastTokenMs = Date.now();
  });

  // Calculate and display stats when agent loop ends
  pi.on('agent_end', (event: AgentEndEvent, ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    if (!currentTiming) return;

    const timing = currentTiming;
    currentTiming = null;
    hasSeenAssistantMessage = false;

    const message = calculateStats(event, timing);
    if (!message) return;

    // Show notification immediately
    ctx.ui.notify(message, 'info');

    // Save to session for restoration on resume
    pi.appendEntry('tps', { message, timestamp: Date.now() });
  });
}
