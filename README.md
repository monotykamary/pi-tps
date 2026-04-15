# pi-tps

### Tokens-per-second tracker for pi

**[Install](#install)** · **[How it works](#how-it-works)**

See your LLM generation speed (tokens/second) after every agent turn.

---

## Quick start

```bash
pi install https://github.com/yourusername/pi-tps
```

## What's included

|               |                                                           |
| ------------- | --------------------------------------------------------- |
| **Extension** | Tracks token usage and displays TPS after each agent turn |

### Features

- **Automatic timing**: Measures wall-clock time from `agent_start` to `agent_end`
- **Token aggregation**: Sums up all assistant message tokens (input, output, cache read/write)
- **TPS calculation**: Computes `output_tokens / elapsed_seconds`
- **UI notification**: Displays formatted stats via `ctx.ui.notify()`

## Install

```bash
pi install https://github.com/yourusername/pi-tps
```

<details>
<summary>Manual install</summary>

```bash
cp -r extensions/pi-tps ~/.pi/agent/extensions/
```

Then `/reload` in pi.

</details>

---

## How it works

The extension hooks into pi's lifecycle events:

1. **`agent_start`**: Captures the start timestamp
2. **`agent_end`**: Calculates elapsed time, aggregates token usage from all assistant messages, computes TPS, and displays the notification

### Output format

```
TPS 42.5 tok/s. out 1,234, in 567, cache r/w 890/123, total 2,814, 29.0s
```

| Field     | Description                              |
| --------- | ---------------------------------------- |
| `TPS`     | Tokens per second (output / elapsed)     |
| `out`     | Output tokens from the LLM               |
| `in`      | Input tokens sent to the LLM             |
| `cache r` | Cache read tokens                        |
| `cache w` | Cache write tokens                       |
| `total`   | Total tokens (input + output)            |
| `s`       | Elapsed time in seconds                  |

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
