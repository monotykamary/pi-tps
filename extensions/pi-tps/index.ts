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
  totalGenerationMs: number; // Accumulated active generation time only
  currentMessageStartMs: number | null; // Track when current message started
  assistantMessages: AssistantMessage[]; // Messages generated in THIS turn only
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
  if (!message || typeof message !== 'object') return false;
  const role = (message as { role?: unknown }).role;
  return role === 'assistant';
}

function formatNumber(num: number): string {
  return num.toLocaleString();
}

/**
 * Format duration in seconds to human-readable string.
 * Rules: no decimals, up to 2 units, includes weeks.
 * Exported for testing.
 */
export function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) {
    return `${Math.round(totalSeconds)}s`;
  }

  const seconds = Math.round(totalSeconds);
  const units = [
    { label: 'mo', seconds: 30 * 24 * 60 * 60 }, // 30 days
    { label: 'w', seconds: 7 * 24 * 60 * 60 },
    { label: 'd', seconds: 24 * 60 * 60 },
    { label: 'h', seconds: 60 * 60 },
    { label: 'm', seconds: 60 },
    { label: 's', seconds: 1 },
  ];

  const parts: { value: number; label: string }[] = [];
  let remaining = seconds;

  // First pass: extract all units with non-zero values
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    if (remaining >= unit.seconds) {
      const value = Math.floor(remaining / unit.seconds);
      parts.push({ value, label: unit.label });
      remaining %= unit.seconds;
    }
  }

  // If we only found one unit, add the next smaller unit as zero
  // Skip 'w' (weeks) when the primary unit is 'mo' (months) for better readability
  if (parts.length === 1) {
    const firstUnitIndex = units.findIndex((u) => u.label === parts[0].label);
    if (firstUnitIndex < units.length - 1) {
      let nextIndex = firstUnitIndex + 1;
      // Skip weeks when showing months - go directly to days
      if (parts[0].label === 'mo' && units[nextIndex].label === 'w') {
        nextIndex++;
      }
      if (nextIndex < units.length) {
        parts.push({ value: 0, label: units[nextIndex].label });
      }
    }
  }

  // Return up to 2 most significant units
  const top2 = parts.slice(0, 2);
  return top2.map((p) => `${p.value}${p.label}`).join(' ');
}

function calculateStats(event: AgentEndEvent, timing: TurnTiming): string | null {
  // Aggregate token usage ONLY from assistant messages generated in this turn
  // (not all messages from the session history)
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let totalTokens = 0;

  for (const message of timing.assistantMessages) {
    input += message.usage.input || 0;
    output += message.usage.output || 0;
    cacheRead += message.usage.cacheRead || 0;
    cacheWrite += message.usage.cacheWrite || 0;
    totalTokens += message.usage.totalTokens || 0;
  }

  if (output <= 0) return null;
  if (!timing.firstTokenMs || !timing.lastTokenMs) return null;

  const ttftMs = timing.firstTokenMs - timing.turnStartMs;
  const totalMs = timing.lastTokenMs - timing.turnStartMs;

  // Wall-clock time from turn start to completion (includes TTFT + tool gaps)
  const wallClockMs = timing.lastTokenMs - timing.turnStartMs;
  if (wallClockMs <= 0) return null;

  const generationSeconds = wallClockMs / 1000;
  const tps = output / generationSeconds;

  const ttftFormatted = formatDuration(ttftMs / 1000);
  const totalFormatted = formatDuration(totalMs / 1000);

  return `TPS ${tps.toFixed(1)} tok/s · TTFT ${ttftFormatted} · ${totalFormatted} · out ${formatNumber(output)} · in ${formatNumber(input)}`;
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
      totalGenerationMs: 0,
      currentMessageStartMs: null,
      assistantMessages: [],
    };
    hasSeenAssistantMessage = false;
  });

  // Track when a message starts (first token received)
  pi.on('message_start', (event: MessageStartEvent) => {
    if (!currentTiming) return;
    if (!isAssistantMessage(event.message)) return;

    const now = Date.now();

    // Only capture TTFT for the first assistant message
    if (!hasSeenAssistantMessage) {
      currentTiming.firstTokenMs = now;
      hasSeenAssistantMessage = true;
    }

    // Track when this specific message started (for generation time calculation)
    currentTiming.currentMessageStartMs = now;
  });

  // Track when a message ends
  pi.on('message_end', (event: MessageEndEvent) => {
    if (!currentTiming) return;
    if (!isAssistantMessage(event.message)) return;

    const now = Date.now();

    // Update last token time for the overall turn
    currentTiming.lastTokenMs = now;

    // Accumulate active generation time for this message only
    if (currentTiming.currentMessageStartMs) {
      const messageGenerationMs = now - currentTiming.currentMessageStartMs;
      currentTiming.totalGenerationMs += messageGenerationMs;
      currentTiming.currentMessageStartMs = null;
    }

    // Store this message to count its tokens later (only current turn's messages)
    currentTiming.assistantMessages.push(event.message as AssistantMessage);
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
