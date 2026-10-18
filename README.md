# pi-turnkit

Turn-scoped modes for pi: prefix a prompt with a mark and that turn runs with
a different model / thinking level. The mark is stripped before the model sees
it; everything is restored when the turn ends.

```text
❯ +plan the refactor of the parser   (think hard)
❯ _summarize the last commit         (cheap model)
❯ =qué hay en esta imagen ~/foto.png  (vision model)
❯ ?plan the migration off the parser    (read-only plan mode)
```

## Modes

| Mark | Name | Default |
|---|---|---|
| `+` | think | thinking `max`, session model |
| `_` | cheap | `glm-5.3-flash` |
| `=` | vision | `zai/glm-5.3-flash` |
| `?` | plan | read-only planning turn (no config) |

## Configuration

Persisted in `$PI_HOME/extensions-config/turnkit.json`, first match wins:

1. `/turnkit config <mark> <provider/model> [level]` (persisted)
2. CLI flags / env vars per mode
3. Built-in defaults

```text
/turnkit                                    show config for every mode
/turnkit config + zai/glm-5.3 xhigh        think on glm-5.3 at xhigh
/turnkit config _ ollama/gemma4:latest     cheap on local gemma
/turnkit config = ollama/gemma4:latest        vision on local gemma
/turnkit config + high                      keep model, thinking high
/turnkit reset +                           clear one mode
/turnkit reset                             clear all
```

Flags and env vars: `--think-model` / `PI_THINK_MODEL`,
`--think-level` / `PI_THINK_LEVEL`, `--cheap-model` / `PI_USE_CHEAP_MODEL`,
`--vision-model` / `PI_VISION_MODEL`.

## Details

- `__init__.py fails` (double mark) and a lone mark are not treated as marked.
- `?` plan turns inject a read-only guideline into the system prompt and hard-block
  mutating tools (`write`, `edit`, `bash`, non-read-only MCP tools) via the
  `tool_call` event.
- Mid-turn prompts keep the running turn's config (`_` warns).
- Thinking levels are clamped by pi to what the model supports.

## Install

```bash
pi install git:https://github.com/kcurtet/pi-turnkit
```

## How it works

- `input` event: detects the mark, strips it, records the mode for the turn.
- `agent_start`: saves current model/thinking level, applies the mode's config.
- `agent_end`: restores everything and reports what answered.

Inspired by [midudev/better-claude](https://github.com/midudev/better-claude)
(`think-hard`, `use-haiku` plugins).

MIT © kcurtet
