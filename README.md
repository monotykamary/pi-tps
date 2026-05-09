# pi-tps

### Tokens-per-second tracker for pi

**[Install](#install)** · **[Output format](#output-format)** · **[How it works](#how-it-works)** · **[Export](#export-command)** · **[Events](#telemetry-event)**

See your LLM generation speed, TTFT, and inference stalls after every agent turn. Handles multi-message turns, burst delivery, and stall-before-stream artifacts.

---

_Originally from [badlogic/pi-mono](https://github.com/badlogic/pi-mono/blob/main/.pi/extensions/tps.ts). Packaged as an installable pi extension._

---

## Quick start

```bash
pi install https://github.com/monotykamary/pi-tps
```

## What's included

|               |                                                                        |
| ------------- | ---------------------------------------------------------------------- |
| **Extension** | Tracks TPS, TTFT, stall time, token usage, and cost after each turn    |
| **Export**    | `/tps-export` command — dump telemetry as JSONL with session structure |

### Features

- **Accurate TPS**: Uses `performance.now()` sub-millisecond timing; excludes TTFT, tool-execution gaps, and network latency from generation speed
- **Stall detection**: Detects inference pauses (GPU queuing, request queuing) and subtracts them from generation TPS — no inflated rates
- **Burst discrimination**: Distinguishes genuine streaming from buffer-flush dispatch; shows `—` when the rate is structurally unidentifiable
- **Multi-message turns**: Aggregates tokens and timing across tool-call chains within one turn
- **Notification banner**: Shows a transient popup with TPS, TTFT, total time, tokens, and stalls
- **Persisted notifications**: Restored on session resume and `/tree` navigation (structured + legacy backward compatible)
- **Export command**: Dump telemetry as JSONL with automatic tree re-chaining for web inspectors
- **Extensible**: Emits `tps:telemetry` events so other extensions can react to telemetry

## Install

```bash
pi install https://github.com/monotykamary/pi-tps
```

<details>
<summary>Manual install</summary>

```bash
cp -r extensions/pi-tps ~/.pi/agent/extensions/
```

Then `/reload` in pi.

</details>

---

## Output format

```
TPS 42.5 tok/s · TTFT 1.2s · 29.7s · in 567 · out 1.2K · stall 4.3s×1
```

| Field   | Description                                                         |
| ------- | ------------------------------------------------------------------- |
| `TPS`   | Tokens per second (generation speed, excludes TTFT & stalls)        |
| `TTFT`  | Time to first token (seconds, 1 decimal)                            |
| `s`     | Total wall-clock time from request to completion                    |
| `in`    | Input tokens (human-readable: K/M/B)                                |
| `out`   | Output tokens (human-readable: K/M/B)                               |
| `stall` | Accumulated stall time × stall count (shown only when stalls exist) |

When TPS can't be determined (burst delivery, too few chunks), the field shows `—`:

```
TPS — · TTFT 0.8s · 1.3s · in 291 · out 46
```

Human-readable scaling (for token counts):

- `< 1K`: raw integer (`567`)
- `≥ 1K`: one decimal, drops `.0` (`1.2K`, `2K`, `15.3K`)
- `≥ 1M`: same pattern (`1.5M`)
- `≥ 1B`: same pattern (`1.2B`)

Duration formatting:

- `< 60s`: one decimal (`2.3s`, `45.0s`)
- `≥ 60s`: up to two units with no decimals (`1m 30s`, `2h 15m`, `3d 12h`, `1w 3d`, `1mo 0d`, `1y 0d`)

---

## How it works

The extension hooks into pi's lifecycle events. The critical detail: `message_start` fires at stream creation (before any tokens), so **TTFT is measured at the first `message_update`**, which carries the first real token content.

### Event sequence

```
turn_start         →  request sent to LLM, timer starts
message_start      →  stream created, stall-tracking reset for this message
message_update (1) →  first token arrives → TTFT captured
message_update (N) →  streaming tokens arrive → inter-update span & stall detection
message_end        →  message complete, generation time accumulated
turn_end           →  telemetry computed and displayed
```

### Timing breakdown

| Phase           | Measured by                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------- |
| **TTFT**        | `turn_start` → first `message_update`                                                        |
| **Generation**  | per-message wall clock (`message_start` → `message_end`), summed across messages in the turn |
| **Stream span** | first `message_update` (post-TTFT) → last `message_update` — the pure streaming window       |
| **Total**       | `turn_start` → last `message_end` in the turn                                                |

This approach excludes:

- **Network latency** (included in TTFT)
- **Tool-execution gaps** between messages (stall clock resets on each `message_start`)
- **Server queue time** (included in TTFT)

### Stall detection

Every `message_update` (after TTFT) measures the gap since the last update. Gaps ≥ 500ms are classified as inference stalls:

- The full gap is accumulated as `stallMs`
- Consecutive stalled updates count as one stall event
- Stalls are subtracted from the streaming window when computing generation TPS
- The stall clock resets at each `message_start`, so tool-execution gaps between messages are never counted as stalls

When a stall occurs **before** the first stream update (common in request-queuing scenarios), the TPS algorithm detects the artifact and falls back to a conservative estimate rather than producing an inflated rate.

### TPS algorithm (three-branch gate)

The extension uses a defense-in-depth strategy to produce reliable TPS:

1. **Primary** — Requires ≥5 streaming updates with ≥1ms average inter-chunk gap and stall time < active generation time. Subtracts stalls from the streaming window for pure generation speed.

2. **Fallback** — When primary conditions fail but ≥2 updates exist and total generation time ≥50ms. Uses the full generation window (includes TTFT, so it underestimates — safe by design). Applies partial stall reduction when stalls dominate.

3. **Null** — Returns `null` (displayed as `—`) when the timing is structurally unidentifiable: burst delivery (all tokens arrive in the same tick), too few chunks, or generation time too short for a reliable rate.

---

## Rehydration

When you resume a session (or navigate branches with `/tree`), pi-tps restores the most recent TPS notification — so you can see your last turn's stats after a reload.

Supports both the current structured `TurnTelemetry` format and legacy `{ message, timestamp }` entries for backward compatibility with session files created by earlier versions.

---

## Export command

Dump telemetry as JSONL for inspection or analysis:

```bash
/tps-export             # current branch, all custom entries
/tps-export --full      # all branches in the session
/tps-export tps         # current branch, filter by customType "tps"
/tps-export tps --full  # all branches, filter by customType "tps"
```

Each exported file is written to `~/.cache/pi-telemetry/pi-telemetry-{scope}-{sessionId}-{timestamp}.jsonl`.

The exporter includes **structural entries** (model_change, branch_summary) alongside telemetry entries so the exported tree is fully resolvable — the web inspector can show model switches and branch points. Parent IDs are automatically re-chained to point to the nearest ancestor that's included in the export, producing a self-contained tree.

---

## Telemetry event

After each turn, pi-tps emits a `tps:telemetry` event on pi's shared event bus. Other extensions can listen to build custom widgets, dashboards, or cost trackers.

```typescript
pi.events.on('tps:telemetry', (data) => {
  // data matches the TurnTelemetry structure below
  console.log(data.tps, data.tokens, data.timing);
});
```

The event payload:

| Field                 | Type             | Description                                         |
| --------------------- | ---------------- | --------------------------------------------------- |
| `tps`                 | `number \| null` | Tokens per second, or null when unidentifiable      |
| `model.provider`      | `string`         | Provider name (e.g. `openai`)                       |
| `model.modelId`       | `string`         | Model identifier (e.g. `gpt-4`)                     |
| `tokens.input`        | `number`         | Input tokens (summed across all assistant messages) |
| `tokens.output`       | `number`         | Output tokens generated by the LLM                  |
| `tokens.cacheRead`    | `number`         | Cache-read tokens (provider-dependent)              |
| `tokens.cacheWrite`   | `number`         | Cache-write tokens (provider-dependent)             |
| `tokens.total`        | `number`         | Total tokens (input + output + cache)               |
| `timing.ttftMs`       | `number \| null` | Time to first token in milliseconds                 |
| `timing.totalMs`      | `number`         | Total wall-clock time from request to completion    |
| `timing.generationMs` | `number`         | Streaming wall clock (message_start → message_end)  |
| `timing.streamMs`     | `number \| null` | Inter-update span: first → last streaming update    |
| `timing.stallMs`      | `number`         | Accumulated inference stall time in ms              |
| `timing.stallCount`   | `number`         | Number of discrete stall events                     |
| `timing.messageCount` | `number`         | Assistant messages in this turn                     |
| `cost.input`          | `number \| null` | Input token cost                                    |
| `cost.output`         | `number \| null` | Output token cost                                   |
| `cost.cacheRead`      | `number \| null` | Cache-read token cost                               |
| `cost.cacheWrite`     | `number \| null` | Cache-write token cost                              |
| `cost.total`          | `number \| null` | Total cost for this turn                            |
| `timestamp`           | `number`         | Unix timestamp (ms) when telemetry was computed     |

When `cost` is unavailable (provider doesn't report it), the entire `cost` object is `null`.

---

## Testing

```bash
# Install dependencies
npm install

# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Type check
npm run typecheck
```

---

## License

MIT
