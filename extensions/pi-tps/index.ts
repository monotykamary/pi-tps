/**
 * pi-tps — Tokens-per-second tracker for pi
 *
 * Captures structured telemetry at every LLM turn (per-API-call).
 * Tracks real-time TPS via token-by-token updates, detects inference
 * stalls (GPU queuing / request queuing pauses), and persists telemetry
 * as custom entries in the session JSONL for provider debugging.
 *
 * Originally from: https://github.com/badlogic/pi-mono/blob/main/.pi/extensions/tps.ts
 */

import { writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import type { AssistantMessage } from '@mariozechner/pi-ai';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@mariozechner/pi-coding-agent';

// ─── Event types (not exported from pi's public API) ────────────────────────
// These mirror the internal types in @mariozechner/pi-coding-agent's
// dist/core/extensions/types.d.ts. When pi starts exporting them, replace
// these local definitions with imports.

interface TurnStartEvent {
  type: 'turn_start';
  turnIndex: number;
  timestamp: number;
}

interface TurnEndEvent {
  type: 'turn_end';
  turnIndex: number;
  message: unknown;
  toolResults: unknown[];
}

interface MessageStartEvent {
  type: 'message_start';
  message: unknown;
}

interface MessageUpdateEvent {
  type: 'message_update';
  message: unknown;
}

interface MessageEndEvent {
  type: 'message_end';
  message: unknown;
}

interface SessionTreeEvent {
  type: 'session_tree';
  newLeafId: string | null;
  oldLeafId: string | null;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Minimum gap between token updates to count as a stall (ms) */
const STALL_THRESHOLD_MS = 500;

// ─── Data types ─────────────────────────────────────────────────────────────

/** Structured telemetry persisted per turn in the session JSONL */
interface TurnTelemetry {
  model: { provider: string; modelId: string };
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  timing: {
    ttftMs: number | null; // time to first token
    totalMs: number; // wall clock: turn_start → turn_end
    generationMs: number; // wall clock streaming time (message_start → message_end per message)
    streamMs: number | null; // inter-update span: first streaming update → last streaming update
    stallMs: number; // accumulated gaps > STALL_THRESHOLD_MS
    stallCount: number; // how many discrete stall events
    messageCount: number; // assistant messages in this turn
  };
  tps: number | null; // output / (streamMs / 1000), null when burst/degenerate
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  } | null;
  timestamp: number;
}

/** In-memory state accumulated during one LLM turn */
interface TurnTiming {
  turnStartMs: number;
  lastUpdateMs: number;
  firstTokenMs: number | null;
  currentMessageStartMs: number | null;
  assistantMessages: AssistantMessage[];
  totalGenerationMs: number;
  // Inter-update TPS tracking: measures the streaming span between
  // the first and last non-TTFT message_update events.
  updateCount: number; // number of message_update events after the first (TTFT) one
  firstStreamUpdateMs: number | null; // timestamp of first non-TTFT update
  lastStreamUpdateMs: number; // timestamp of most recent non-TTFT update
  stallMs: number;
  stallCount: number;
  inStall: boolean;
  messageCount: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isAssistantMessage(message: unknown): message is AssistantMessage {
  if (!message || typeof message !== 'object') return false;
  const msg = message as Record<string, unknown>;
  if (msg.role !== 'assistant') return false;
  // Guard: ensure usage exists with required numeric fields before downstream access.
  if (typeof msg.usage !== 'object' || msg.usage === null) return false;
  const usage = msg.usage as Record<string, unknown>;
  if (typeof usage.input !== 'number' || typeof usage.output !== 'number') return false;
  return true;
}

function formatNumber(num: number): string {
  return num.toLocaleString();
}

/**
 * Format duration in seconds to human-readable string.
 * Sub-minute values show 1 decimal (e.g. "2.3s" for TTFT precision).
 * Rules: no decimals, up to 2 units, includes years.
 * @internal Exported for testing only.
 */
export function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }

  const seconds = Math.round(totalSeconds);
  const units = [
    { label: 'y', seconds: 365 * 24 * 60 * 60 }, // 365 days
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
      // Skip weeks when showing months, skip months+weeks when showing years —
      // go directly to days for a cleaner display
      if (parts[0].label === 'mo' && units[nextIndex].label === 'w') {
        nextIndex++;
      } else if (parts[0].label === 'y' && units[nextIndex].label === 'mo') {
        nextIndex += 2; // skip mo and w, land on d
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

/**
 * Compose the human-readable display string from structured telemetry.
 */
function composeDisplayString(t: TurnTelemetry): string {
  const parts: string[] = [];
  parts.push(t.tps !== null ? `TPS ${t.tps.toFixed(1)} tok/s` : 'TPS —');
  if (t.timing.ttftMs !== null) {
    parts.push(`TTFT ${formatDuration(t.timing.ttftMs / 1000)}`);
  }
  parts.push(formatDuration(t.timing.totalMs / 1000));
  parts.push(`out ${formatNumber(t.tokens.output)}`);
  parts.push(`in ${formatNumber(t.tokens.input)}`);
  if (t.timing.stallMs > 0) {
    const stallStr = formatDuration(t.timing.stallMs / 1000);
    parts.push(`stall ${stallStr}×${t.timing.stallCount}`);
  }
  return parts.join(' · ');
}

/**
 * Build structured TurnTelemetry from accumulated turn timing.
 * Returns null if the turn had no meaningful LLM output.
 */
function buildTelemetry(timing: TurnTiming, turnEndMs: number): TurnTelemetry | null {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let totalTokens = 0;
  let costInput = 0;
  let costOutput = 0;
  let costCacheRead = 0;
  let costCacheWrite = 0;
  let costTotal = 0;
  let hasCost = false;
  let model: { provider: string; modelId: string } | null = null;

  for (const message of timing.assistantMessages) {
    input += message.usage.input || 0;
    output += message.usage.output || 0;
    cacheRead += message.usage.cacheRead || 0;
    cacheWrite += message.usage.cacheWrite || 0;
    totalTokens += message.usage.totalTokens || 0;
    if (message.usage.cost) {
      costInput += message.usage.cost.input || 0;
      costOutput += message.usage.cost.output || 0;
      costCacheRead += message.usage.cost.cacheRead || 0;
      costCacheWrite += message.usage.cost.cacheWrite || 0;
      costTotal += message.usage.cost.total || 0;
      hasCost = true;
    }
    if (!model && message.provider && message.model) {
      model = { provider: message.provider, modelId: message.model };
    }
  }

  if (output <= 0) return null;
  if (!timing.firstTokenMs) return null;
  if (!model) return null;

  const totalMs = turnEndMs - timing.turnStartMs;

  // Inter-update TPS: measures the streaming span between the first and
  // last non-TTFT message_update events.
  //
  // Three-branch gate:
  //   Primary:   ≥5 updates, avg inter-chunk gap ≥1ms → streamMs is genuine
  //              generation timing, not buffer-flush dispatch overhead.
  //   Fallback:  ≥2 updates, totalGenerationMs ≥50ms → conservative rate
  //              using the full generation window (includes TTFT, so it
  //              underestimates — by design, to avoid overshooting).
  //   Else:      null — structurally unidentifiable.
  //
  // The avg inter-chunk gap is the key signal: buffer flushes dispatch
  // chunks with ~0.3–0.5ms gaps (network overhead only), while genuine
  // streaming at 3000 TPS with 5-token chunks has ~1.7ms gaps. A 1ms
  // threshold cleanly separates the two regimes without capping TPS by
  // magnitude — a legitimate 5000 TPS provider with 10-token chunks
  // still passes (2ms gaps), and future faster hardware with larger
  // batches passes too.
  const MIN_STREAM_MS = 1;
  const MIN_STREAM_UPDATES = 5;
  const MIN_INTER_CHUNK_MS = 1;
  const MIN_GENERATION_MS = 50;

  const streamMs =
    timing.updateCount > 0 && timing.firstStreamUpdateMs !== null
      ? timing.lastStreamUpdateMs - timing.firstStreamUpdateMs
      : null;

  const avgInterChunkGap =
    streamMs !== null && timing.updateCount > 1 ? streamMs / (timing.updateCount - 1) : 0;

  // ── Generation TPS ────────────────────────────────────────────────────
  // Raw inference speed: output / (active streaming time / 1000).
  // Excludes BOTH TTFT and known stalls — this is the speed at which the
  // model was actually producing tokens during active generation.
  //
  // The stall-before-stream bug: when a stall occurs between TTFT and the
  // first stream update, firstStreamUpdateMs is set AFTER the stall, making
  // streamMs only cover the post-stall burst. Subtracting stallMs from
  // streamMs gives the "active generation" span, but when stallMs ≥ streamMs
  // the result is unreliable — the post-stall cluster could be a buffer-flush
  // dispatch of pre-generated tokens, not sustained inference.
  //
  // Three guard conditions prevent inflation:
  //  1. stallMs < streamMs: prevents stall-before-stream where
  //     firstStreamUpdateMs lands AFTER the stall.
  //  2. effectiveStreamMs >= 50ms: the active span must be long enough to
  //     distinguish genuine generation from a dispatch artifact.
  //  3. stallMs < effectiveStreamMs: when stalls exceed active generation
  //     time (e.g. 998ms stall, 53ms active), the "active" span is likely
  //     a buffer-flush burst of pre-generated tokens, not sustained
  //     inference. Requiring stall time < active time ensures the
  //     streaming window is dominated by generation, not stalls.
  //
  // Three-branch gate:
  //   Primary:   all 3 guards pass → output / (effectiveStreamMs / 1000)
  //   Fallback:  ≥2 updates, generationMs ≥50ms
  //              → output / (effectiveGenMs / 1000)
  //              Includes TTFT, underestimates, but never overshoots.
  //   Else:      null — structurally unidentifiable.
  let tps: number | null = null;
  if (
    streamMs !== null &&
    streamMs >= MIN_STREAM_MS &&
    timing.updateCount >= MIN_STREAM_UPDATES &&
    avgInterChunkGap >= MIN_INTER_CHUNK_MS &&
    timing.stallMs < streamMs && // stalls must not dominate streaming span
    streamMs - timing.stallMs >= MIN_GENERATION_MS && // effective span must be measurable
    timing.stallMs < streamMs - timing.stallMs // stall time < active time
  ) {
    // Active generation time: streaming window minus known stalls.
    // streamMs already excludes TTFT; subtracting stallMs gives the
    // time the model was actually generating tokens.
    const effectiveStreamMs = streamMs - timing.stallMs;
    const raw = output / (effectiveStreamMs / 1000);
    tps = Math.round(raw * 10) / 10;
  } else if (timing.updateCount >= 2 && timing.totalGenerationMs >= MIN_GENERATION_MS) {
    // Fallback: use generationMs (message_start → message_end) minus
    // stalls. This includes TTFT, so it underestimates generation speed,
    // but it's safe — no inflation possible.
    const effectiveGenMs = Math.max(timing.totalGenerationMs - timing.stallMs, MIN_GENERATION_MS);
    const raw = output / (effectiveGenMs / 1000);
    tps = Math.round(raw * 10) / 10;
  } else {
    tps = null;
  }

  return {
    model,
    tokens: { input, output, cacheRead, cacheWrite, total: totalTokens },
    timing: {
      ttftMs: timing.firstTokenMs - timing.turnStartMs,
      totalMs,
      generationMs: timing.totalGenerationMs,
      streamMs,
      stallMs: timing.stallMs,
      stallCount: timing.stallCount,
      messageCount: timing.messageCount,
    },
    tps,
    cost: hasCost
      ? {
          input: costInput,
          output: costOutput,
          cacheRead: costCacheRead,
          cacheWrite: costCacheWrite,
          total: costTotal,
        }
      : null,
    timestamp: Date.now(),
  };
}

// ─── Extension ──────────────────────────────────────────────────────────────

export default function tpsExtension(pi: ExtensionAPI) {
  // Current turn timing state
  let currentTiming: TurnTiming | null = null;

  // Cached session entries for argument completion (captured on session_start / session_tree)
  let cachedEntries: Array<{ type?: string; customType?: string }> = [];

  // ── Rehydration ─────────────────────────────────────────────────────────

  /**
   * Restore the most recent TPS notification on resume.
   * Supports both structured (TurnTelemetry) and legacy ({ message, timestamp })
   * entries for backwards compatibility with older session files.
   * Deferred via setTimeout so it survives TUI clear+rebuild.
   */
  function restoreTPSNotification(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === 'custom' && entry.customType === 'tps') {
        const data = entry.data as Record<string, unknown> | null;
        if (!data) continue;
        // Structured format (current): has model field
        if (data.model) {
          const message = composeDisplayString(data as unknown as TurnTelemetry);
          setTimeout(() => {
            ctx.ui.notify(message, 'info');
          }, 0);
          break;
        }
        // Legacy format: { message: string, timestamp: number }
        if (typeof data.message === 'string') {
          setTimeout(() => {
            ctx.ui.notify(data.message as string, 'info');
          }, 0);
          break;
        }
      }
    }
  }

  // Restore notification on session start/resume — skip only brand-new sessions
  pi.on('session_start', (_event, ctx) => {
    // Restore for all reasons including startup/reload (they may continue a previous session)
    cachedEntries = ctx.sessionManager.getEntries();
    restoreTPSNotification(ctx);
  });

  // Restore notification after /tree navigation (same session, different branch)
  pi.on('session_tree', (_event: SessionTreeEvent, ctx: ExtensionContext) => {
    cachedEntries = ctx.sessionManager.getEntries();
    restoreTPSNotification(ctx);
  });

  // ── Turn timing ─────────────────────────────────────────────────────────

  // Track when a turn starts (request sent to LLM)
  pi.on('turn_start', (_event: TurnStartEvent) => {
    currentTiming = {
      turnStartMs: performance.now(),
      lastUpdateMs: performance.now(),
      firstTokenMs: null,
      currentMessageStartMs: null,
      assistantMessages: [],
      totalGenerationMs: 0,
      updateCount: 0,
      firstStreamUpdateMs: null,
      lastStreamUpdateMs: 0,
      stallMs: 0,
      stallCount: 0,
      inStall: false,
      messageCount: 0,
    };
  });

  // Track when a message starts. In pi, message_start fires at stream
  // creation (before any tokens), so we defer TTFT to the first
  // message_update which carries the first real token.
  pi.on('message_start', (event: MessageStartEvent) => {
    if (!currentTiming) return;
    if (!isAssistantMessage(event.message)) return;

    const now = performance.now();

    // Track when THIS message started streaming (for generation TPS)
    currentTiming.currentMessageStartMs = now;
    currentTiming.messageCount++;

    // Reset stall-tracking clock so tool-execution gaps between
    // messages don't get counted as inference stalls.
    currentTiming.lastUpdateMs = now;
    currentTiming.inStall = false;
  });

  // Track token-by-token updates during streaming (real-time TPS & stall detection).
  // The first message_update is the effective first token (message_start fires
  // at stream creation, before any content arrives).
  pi.on('message_update', (event: MessageUpdateEvent) => {
    if (!currentTiming) return;
    if (!isAssistantMessage(event.message)) return;

    const now = performance.now();

    // First token: capture TTFT and seed stall timing, then bail.
    // No stall detection on this event — the gap from message_start to
    // first message_update is provider parsing overhead, not a stall.
    if (currentTiming.firstTokenMs === null) {
      currentTiming.firstTokenMs = now;
      currentTiming.lastUpdateMs = now;
      return;
    }

    // Track inter-update streaming span for TPS calculation
    currentTiming.updateCount++;
    if (currentTiming.firstStreamUpdateMs === null) {
      currentTiming.firstStreamUpdateMs = now;
    }
    currentTiming.lastStreamUpdateMs = now;

    const gap = now - currentTiming.lastUpdateMs;

    // Detect stall: gap exceeds threshold. The full gap counts as stall
    // time — the threshold is a detection gate, not a duration discount.
    if (gap >= STALL_THRESHOLD_MS) {
      if (!currentTiming.inStall) {
        currentTiming.stallCount++;
      }
      currentTiming.inStall = true;
      currentTiming.stallMs += gap;
    } else {
      currentTiming.inStall = false;
    }

    currentTiming.lastUpdateMs = now;
  });

  // Track when a message ends
  pi.on('message_end', (event: MessageEndEvent) => {
    if (!currentTiming) return;
    if (!isAssistantMessage(event.message)) return;

    const now = performance.now();

    // Accumulate ACTUAL streaming time for this message (true generation time)
    if (currentTiming.currentMessageStartMs) {
      const messageGenerationMs = now - currentTiming.currentMessageStartMs;
      currentTiming.totalGenerationMs += messageGenerationMs;
      currentTiming.currentMessageStartMs = null;
    }

    // Store this message to count its tokens later (only current turn's messages)
    currentTiming.assistantMessages.push(event.message);
    currentTiming.lastUpdateMs = now;
  });

  // ── Persist telemetry ───────────────────────────────────────────────────

  // Calculate, display, and persist telemetry at the end of each LLM turn
  pi.on('turn_end', (_event: TurnEndEvent, ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    if (!currentTiming) return;

    const timing = currentTiming;
    currentTiming = null;

    const turnEndMs = performance.now();
    const telemetry = buildTelemetry(timing, turnEndMs);
    if (!telemetry) return;

    // Show notification immediately (composed from structured data)
    const message = composeDisplayString(telemetry);
    ctx.ui.notify(message, 'info');

    // Persist structured telemetry to session for export and rehydration
    pi.appendEntry('tps', telemetry);

    // Keep argument completion cache in sync with new entries
    cachedEntries.push({ type: 'custom', customType: 'tps' });
  });

  // ── Export command ──────────────────────────────────────────────────────

  pi.registerCommand('tps-export', {
    description:
      'Export telemetry + session structure (model changes, branch points) as JSONL (--full for all branches, filter by customType)',
    getArgumentCompletions: (argumentPrefix: string) => {
      // Offer --full flag
      if ('--full'.startsWith(argumentPrefix)) {
        return [{ value: '--full', label: '--full (all branches, not just current)' }];
      }
      // Collect all unique customType values from cached session entries
      const customTypes = new Set<string>();
      for (const entry of cachedEntries) {
        if (entry.type === 'custom' && entry.customType) {
          customTypes.add(entry.customType);
        }
      }
      return Array.from(customTypes)
        .filter((ct) => ct.startsWith(argumentPrefix))
        .map((ct) => ({ value: ct, label: ct }));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      // Default: current branch. --full: entire session.
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const full = tokens.includes('--full');
      const filterType = tokens.filter((t) => t !== '--full').join(' ') || null;

      // Collect entries: custom entries (+ optional customType filter) + structural entries
      // Structural entries (model_change, branch_summary) are always included so the
      // exported parentId tree is fully resolvable and the web inspector can show
      // model switches and branch points.
      const entries = full ? ctx.sessionManager.getEntries() : ctx.sessionManager.getBranch();
      const isStructural = (e: { type: string }) =>
        e.type === 'model_change' || e.type === 'branch_summary';

      const exportedEntries = entries.filter(
        (e) =>
          isStructural(e) || (e.type === 'custom' && (!filterType || e.customType === filterType))
      );

      if (exportedEntries.length === 0) {
        const scope = full ? 'all-entries' : 'current-branch';
        ctx.ui.notify(`No matching entries found in ${scope}`, 'warning');
        return;
      }

      // Re-chain parentIds so the exported entries form a valid tree.
      // Original parentIds often point to message entries (not in the export).
      // We walk up the full session tree until we find the nearest ancestor
      // that IS in the export, giving us a self-contained tree structure.
      const byId = new Map<string, (typeof entries)[number]>(entries.map((e) => [e.id, e]));
      const exportedIds = new Set(exportedEntries.map((e) => e.id));

      const rechainParentId = (entry: (typeof exportedEntries)[number]): string | null => {
        let current: string | null = entry.parentId;
        while (current) {
          if (exportedIds.has(current)) return current;
          const parent = byId.get(current);
          current = parent?.parentId ?? null;
        }
        return null;
      };

      const rechained = exportedEntries.map((e) => ({
        ...e,
        parentId: rechainParentId(e),
      }));

      // Write to tmp directory
      const cacheBase = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
      const dir = join(cacheBase, 'pi-telemetry');
      mkdirSync(dir, { recursive: true });

      const sessionId = ctx.sessionManager.getSessionId?.() ?? 'unknown';
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const scopeParts = [full ? 'full' : 'branch', filterType].filter(Boolean);
      const scope = scopeParts.join('-');
      const filename = `pi-telemetry-${scope}-${sessionId.slice(0, 8)}-${timestamp}.jsonl`;
      const filepath = join(dir, filename);

      const content = rechained.map((e) => JSON.stringify(e)).join('\n') + '\n';
      writeFileSync(filepath, content);

      const structuralCount = exportedEntries.filter((e) => isStructural(e)).length;
      const customCount = exportedEntries.length - structuralCount;
      const parts: string[] = [];
      if (customCount > 0) parts.push(`${customCount} telemetry`);
      if (structuralCount > 0) parts.push(`${structuralCount} structural`);
      const summary = parts.length > 0 ? parts.join(' + ') : `${exportedEntries.length} entries`;
      ctx.ui.notify(`Exported ${summary} → ${filepath}`, 'info');
    },
  });
}
