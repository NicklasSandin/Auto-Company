# Local Model Setup (Codex CLI + LM Studio)

Runs the autonomous loop against a model on your own machine instead of a cloud API. Pick which model to use at the start of every session with `make start-local`.

## Read this first: what you give up

The loop can drive two engines. Local models go through **Codex CLI**, and Codex is not Claude Code:

| Feature | Claude Code (`ENGINE=claude`) | Codex CLI (`ENGINE=codex`) |
|---|---|---|
| `.claude/agents/` — the 14 expert personas | Yes, spawned as real subagents | **Ignored** |
| `.claude/skills/` — the 30+ skill arsenal | Yes, via the Skill tool | **Ignored** |
| `CLAUDE.md` — charter and guardrails | Yes | **Ignored** (Codex reads `AGENTS.md`) |
| Agent Teams | Yes | **No** |
| The loop, consensus baton, dashboard | Yes | Yes |

So on a local model you keep the 24/7 loop, `memories/consensus.md` as the cross-cycle baton, the circuit breaker, and the dashboard — but the "14-agent company" becomes one model reading `PROMPT.md` and role-playing those personas inside a single context. It cannot spawn them.

Also be realistic about capability. Every cycle must write `memories/consensus.md` containing these three exact headings or `validate_consensus()` marks the cycle failed:

```
# Auto Company Consensus
## Next Action
## Company State
```

A 7-8B model will miss that more often than a frontier model, so expect `[FAIL]` cycles and occasional trips of the 5-error circuit breaker. Raise `MAX_CONSECUTIVE_ERRORS` in `.auto-loop.env` if it gets in the way.

## Prerequisites

1. **LM Studio** — <https://lmstudio.ai/download>. Launch it once so it bootstraps the `lms` CLI into `~/.lmstudio/bin/lms`.
2. **Codex CLI** with `--oss` support: `codex --help` should list `--oss` and `--local-provider`.
3. **jq**.

### GPU acceleration

LM Studio ships three llama.cpp runtimes and picks one automatically. Check what it selected and what it can see:

```bash
~/.lmstudio/bin/lms runtime ls
~/.lmstudio/bin/lms runtime survey
```

On AMD, note that **ROCm does not support Polaris cards** (RX 400/500 series, `gfx803`) — it was dropped years ago. The **Vulkan** runtime is the one that works there, and LM Studio generally selects it on its own:

```
llama.cpp-linux-x86_64-vulkan-avx2@2.31.2   ✓   GGUF
```

```
GPU/ACCELERATORS                                               VRAM
AMD Radeon RX 580 2048SP (RADV POLARIS10) (Vulkan, Discrete)   8.00 GiB
```

If `runtime ls` shows a different engine selected, switch with `lms runtime select`.

## Download a model

```bash
~/.lmstudio/bin/lms get qwen/qwen3-8b -y --gguf
```

`-y` accepts the quantization LM Studio picks for your hardware. Pick a size that fits your VRAM — on 8GB, a Q4 quant of a 7-8B model fits fully on the GPU; anything much larger spills to CPU and slows down sharply. Tool-calling reliability matters more than raw size here, because Codex's agentic loop depends on it.

Models land in `~/.lmstudio/models` by default. If that partition is tight, change the models directory in LM Studio's **My Models** settings.

## Pick a model and run

```bash
make models              # what is available, with a GPU-fit hint
make start-local         # pick, then run the loop in the foreground
make start-local-daemon  # pick, then restart the systemd daemon with it
```

`make start-local` looks like this:

```
Local models available (LM Studio, Vulkan):

  1) qwen3-8b                          4.7 GB    Q4_K_M    ctx 40960   fits in VRAM
  2) qwen2.5-coder-7b-instruct         4.4 GB    Q4_K_M    ctx 32768   fits in VRAM

Choose [1-2]: 1

Selected: qwen3-8b
Wrote:    .auto-loop.env  (ENGINE=codex, CODEX_OSS=1, CODEX_LOCAL_PROVIDER=lmstudio)
```

Non-interactive:

```bash
./scripts/local/select-model.sh --model qwen3-8b --start
```

## How the selection is applied

The picker writes four keys into `.auto-loop.env`:

```bash
ENGINE=codex
CODEX_OSS=1
CODEX_LOCAL_PROVIDER=lmstudio
MODEL=qwen3-8b
```

`auto-loop.sh` reads that file (only `KEY=VALUE` lines, never sourced) and turns it into:

```bash
codex exec -c sandbox_mode="danger-full-access" -o <file> \
  --oss --local-provider lmstudio -m qwen3-8b "<prompt>"
```

Real environment variables still win over the file, so `MODEL=other make start` overrides a saved choice for one run. Because the file is what the systemd unit reads too, the dashboard's Start button uses the same model you picked.

## Switching back to a cloud engine

```bash
sed -i '/^CODEX_OSS=/d; /^CODEX_LOCAL_PROVIDER=/d; /^MODEL=/d' .auto-loop.env
sed -i 's/^ENGINE=codex/ENGINE=claude/' .auto-loop.env
```

## Troubleshooting

### `OSS setup failed: LM Studio is not responding`

Codex needs the LM Studio server up. The picker starts it, but by hand:

```bash
~/.lmstudio/bin/lms server start
~/.lmstudio/bin/lms server status
```

### `No LLMs are downloaded in LM Studio yet`

An embedding model does not count. Check with `lms ls --llm` and download a chat model.

### Cycles fail instantly with no cost recorded

Look at the newest `logs/cycle-*.log` — it holds the engine's full output. For local models the usual causes are the server not running, or a `MODEL` value that is not actually downloaded (`make models` lists valid keys).

### `exceed_context_size_error` on every cycle

```
request (9054 tokens) exceeds the available context size (8192 tokens)
```

Codex sends a fixed system prompt plus tool definitions ahead of anything of ours. Measured at **9,255 tokens for a two-word reply**, so a model loaded with an 8K window fails before it ever sees `PROMPT.md`. Load with real headroom:

```bash
~/.lmstudio/bin/lms load <model> -c 32768 --gpu max -y
```

`select-model.sh` does this for you and refuses any model whose maximum context is below `CODEX_MIN_CTX` (12288 by default). Check what a context size costs in VRAM before loading:

```bash
~/.lmstudio/bin/lms load <model> -c 32768 --estimate-only -y
```

### `Jinja Exception: System message must be at the beginning`

```
Engine protocol predict request returned 500:
  Error: Jinja Exception: System message must be at the beginning.
```

The model's own chat template is rejecting Codex's message layout. Some fine-tunes ship a strict guard:

```jinja
{%- if message.role == "system" %}
    {%- if not loop.first %}
        {{- raise_exception('System message must be at the beginning.') }}
    {%- endif %}
```

Codex places a system message after a user message, so every call dies. Note this is **not** predictable from `trainedForToolUse`, which such models often still report as `true`.

The fix is to replace that model's prompt template with one that renders a late system message instead of raising:

```jinja
{%- if message.role == "system" %}
    {%- if not loop.first %}
        {{- '<|im_start|>system\n' + content + '<|im_end|>' + '\n' }}
    {%- endif %}
```

Deleting the `raise_exception` alone is wrong — that branch emits nothing, so Codex's instructions would be silently dropped rather than reaching the model.

Set this in LM Studio's GUI under **My Models → the model → Prompt Template**. Writing it into `~/.lmstudio/.internal/user-concrete-model-default-config/.../<model>.gguf.json` as an `llm.prediction.promptTemplate` field does **not** work — the server ignores it. Easiest path is simply to pick a model whose stock template has no such guard.

### Generation is very slow

Confirm the GPU is really being used with `lms runtime survey`, and check the model is not larger than VRAM. `lms ps` shows what is loaded and where.

For scale: Qwen3-8B Q4_K_M on an RX 580 (8GB, Vulkan) took just over **14 minutes** for a single Cycle 1 brainstorm, landing right on a 900s `CYCLE_TIMEOUT_SECONDS`. It was only recorded as `[OK]` because `auto-loop.sh` has a soft-timeout path that keeps the progress when the consensus file validates and changed. Budget accordingly — raise `CYCLE_TIMEOUT_SECONDS` well above the default if cycles are being cut off mid-thought.

### The model ignores the agents and skills

Expected. See the table at the top — that machinery is Claude Code only.
