#!/bin/bash
# ============================================================
# Auto Company — Pick a Local Model for This Session
# ============================================================
# Lists the LLMs downloaded in LM Studio, asks which one to run,
# and records the choice in .auto-loop.env so every entry point
# (make start, the systemd unit, and the dashboard Start button)
# picks up the same model.
#
# The loop runs through Codex CLI in --oss mode, since that is the
# engine that speaks to a local provider. Note that ENGINE=codex does
# not use .claude/agents, .claude/skills or CLAUDE.md -- those are
# Claude Code features. See docs/local-model-setup.md.
#
# Usage:
#   ./select-model.sh                 # Pick, write .auto-loop.env, stop
#   ./select-model.sh --start         # Pick, then run the loop in the foreground
#   ./select-model.sh --daemon        # Pick, then restart the systemd unit
#   ./select-model.sh --model <key>   # Non-interactive
#   ./select-model.sh --list          # Just show what is available
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$PROJECT_DIR/.auto-loop.env"
PROVIDER="lmstudio"
# The RX 580 class of card reports 8 GiB. Anything materially smaller than
# that fits fully on the GPU; bigger spills to CPU and gets much slower.
VRAM_BYTES="${VRAM_BYTES:-8589934592}"
# Codex sends a fixed system prompt plus tool definitions before any of our
# own text. Measured at ~9,255 tokens for a two-word reply, so a model loaded
# with an 8K window fails every call with exceed_context_size_error before it
# ever sees PROMPT.md. Demand real headroom above that.
CODEX_MIN_CTX="${CODEX_MIN_CTX:-12288}"
CODEX_TARGET_CTX="${CODEX_TARGET_CTX:-32768}"

DO_START=0
DO_DAEMON=0
LIST_ONLY=0
CHOSEN=""

while [ $# -gt 0 ]; do
    case "$1" in
        --start)  DO_START=1 ;;
        --daemon) DO_DAEMON=1 ;;
        --list)   LIST_ONLY=1 ;;
        --model)  shift; CHOSEN="${1:-}"; [ -n "$CHOSEN" ] || { echo "--model needs a value" >&2; exit 1; } ;;
        --help|-h)
            sed -n '/^# Usage:/,/^# ===/p' "$0" | sed 's/^# \{0,1\}//; $d'
            exit 0
            ;;
        *) echo "Unknown option: $1" >&2; echo "Try --help." >&2; exit 1 ;;
    esac
    shift
done

find_lms() {
    if command -v lms >/dev/null 2>&1; then command -v lms; return 0; fi
    if [ -x "$HOME/.lmstudio/bin/lms" ]; then echo "$HOME/.lmstudio/bin/lms"; return 0; fi
    return 1
}

if ! LMS="$(find_lms)"; then
    echo "Error: the 'lms' CLI was not found."
    echo "Install LM Studio and launch it once to bootstrap the CLI:"
    echo "  https://lmstudio.ai/download"
    echo "It normally lands at ~/.lmstudio/bin/lms."
    exit 1
fi

command -v jq >/dev/null 2>&1 || { echo "Error: jq is required." >&2; exit 1; }

# "lms server status" exits 0 whether or not the server is up -- it succeeded at
# reporting the status either way -- so the exit code says nothing. Read the
# running flag out of --json instead, falling back to the text for older CLIs.
server_running() {
    local js
    js="$("$LMS" server status --json 2>/dev/null || true)"
    if [ -n "$js" ]; then
        [ "$(printf '%s' "$js" | jq -r '.running // false' 2>/dev/null)" = "true" ]
        return
    fi
    "$LMS" server status 2>/dev/null | grep -qi 'is running'
}

# Codex refuses to run in --oss mode unless the LM Studio server answers.
if ! server_running; then
    echo "LM Studio server is not running. Starting it..."
    "$LMS" server start >/dev/null 2>&1 || true
    if ! server_running; then
        echo "Error: could not start the LM Studio server. Try '$LMS server start' by hand." >&2
        exit 1
    fi
fi
LMS_PORT="$("$LMS" server status --json 2>/dev/null | jq -r '.port // empty' 2>/dev/null || true)"

models_json="$("$LMS" ls --llm --json 2>/dev/null || echo '[]')"
count="$(printf '%s' "$models_json" | jq 'length' 2>/dev/null || echo 0)"

if [ "$count" -eq 0 ]; then
    echo "No LLMs are downloaded in LM Studio yet (embedding models do not count)."
    echo "Download one, then run this again. For example:"
    echo "  $LMS get qwen/qwen3-8b -y --gguf"
    exit 1
fi

# Build the menu. Fields: modelKey, display, size, quant, context, fit hint.
menu="$(printf '%s' "$models_json" | jq -r --argjson vram "$VRAM_BYTES" --argjson minctx "$CODEX_MIN_CTX" '
    to_entries[] |
    (.value.sizeBytes // 0) as $sz |
    [
      (.key + 1 | tostring),
      .value.modelKey,
      (if $sz > 0 then (($sz / 1073741824) * 10 | round / 10 | tostring) + " GB" else "?" end),
      (.value.quantization.name // "-"),
      ((.value.maxContextLength // 0) | tostring),
      (if $sz == 0 then "unknown"
       elif $sz < ($vram * 78 / 100) then "fits in VRAM"
       elif $sz < $vram then "tight, may spill"
       else "partial offload (slow)" end),
      (if ((.value.maxContextLength // 0) < $minctx) then "CTX TOO SMALL"
       elif (.value.trainedForToolUse == false) then "not tool-trained"
       else "" end)
    ] | @tsv
')"

if [ "$LIST_ONLY" -eq 1 ]; then
    printf '%s\n' "  #  MODEL                                     SIZE      QUANT      CTX      GPU FIT"
    printf '%s\n' "$menu" | while IFS=$'\t' read -r n key sz q ctx fit warn; do
        printf '  %-2s %-41s %-9s %-10s %-8s %s%s\n' "$n" "$key" "$sz" "$q" "$ctx" "$fit" "${warn:+   <-- $warn}"
    done
    exit 0
fi

if [ -z "$CHOSEN" ]; then
    echo ""
    echo "Local models available (LM Studio, Vulkan):"
    echo ""
    printf '%s\n' "$menu" | while IFS=$'\t' read -r n key sz q ctx fit warn; do
        printf '  %s) %-40s %-9s %-9s ctx %-7s %s%s\n' "$n" "$key" "$sz" "$q" "$ctx" "$fit" "${warn:+   <-- $warn}"
    done
    echo ""
    if [ ! -t 0 ] && [ ! -r /dev/tty ]; then
        echo "Error: no terminal available to read a choice. Use --model <key>." >&2
        exit 1
    fi
    printf 'Choose [1-%s]: ' "$count"
    if [ -t 0 ]; then read -r reply; else read -r reply < /dev/tty; fi
    case "$reply" in
        ''|*[!0-9]*) echo "Not a number." >&2; exit 1 ;;
    esac
    if [ "$reply" -lt 1 ] || [ "$reply" -gt "$count" ]; then
        echo "Out of range." >&2; exit 1
    fi
    CHOSEN="$(printf '%s' "$models_json" | jq -r --argjson i "$((reply - 1))" '.[$i].modelKey')"
else
    # Validate a --model value against what is actually downloaded.
    if ! printf '%s' "$models_json" | jq -e --arg k "$CHOSEN" 'any(.[]; .modelKey == $k)' >/dev/null 2>&1; then
        echo "Error: '$CHOSEN' is not a downloaded LLM. Run with --list to see the options." >&2
        exit 1
    fi
fi

# Make sure the choice can actually serve Codex, then load it with a window
# big enough that the system prompt is not the whole budget.
model_ctx="$(printf '%s' "$models_json" | jq -r --arg k "$CHOSEN" '.[] | select(.modelKey == $k) | .maxContextLength // 0')"
if [ "${model_ctx:-0}" -lt "$CODEX_MIN_CTX" ]; then
    echo ""
    echo "Error: '$CHOSEN' caps out at ${model_ctx} tokens of context."
    echo "Codex's system prompt and tool definitions alone are around 9,000 tokens,"
    echo "so every cycle would fail with exceed_context_size_error. Pick a model with"
    echo "at least ${CODEX_MIN_CTX}."
    exit 1
fi

load_ctx="$CODEX_TARGET_CTX"
[ "$model_ctx" -lt "$load_ctx" ] && load_ctx="$model_ctx"

# Reload only when it is absent or already loaded with too small a window,
# since loading is the slow part.
loaded_ctx="$("$LMS" ps --json 2>/dev/null | jq -r --arg k "$CHOSEN" \
    'if type == "array" then (.[] | select((.modelKey // .identifier) == $k) | .contextLength // 0) else 0 end' 2>/dev/null | head -1)"
if [ "${loaded_ctx:-0}" -ge "$CODEX_MIN_CTX" ]; then
    echo "Already loaded with ${loaded_ctx} context; leaving it as is."
else
    echo "Loading $CHOSEN with ${load_ctx} context (GPU offload: max)..."
    if ! "$LMS" load "$CHOSEN" -c "$load_ctx" --gpu max -y >/dev/null 2>&1; then
        echo "Warning: 'lms load' failed. LM Studio may still just-in-time load it," >&2
        echo "but probably with its default window, which Codex will overflow." >&2
    fi
fi

upsert_env() {
    local key="$1" value="$2"
    touch "$ENV_FILE"
    if grep -qE "^${key}=" "$ENV_FILE" 2>/dev/null; then
        # Rewrite in place without a temp file rename, so the systemd unit's
        # EnvironmentFile path keeps pointing at the same inode.
        local body
        body="$(grep -vE "^${key}=" "$ENV_FILE")"
        printf '%s\n%s=%s\n' "$body" "$key" "$value" | sed '/^$/d' > "$ENV_FILE"
    else
        printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
    fi
}

upsert_env ENGINE codex
upsert_env CODEX_OSS 1
upsert_env CODEX_LOCAL_PROVIDER "$PROVIDER"
upsert_env MODEL "$CHOSEN"

echo ""
echo "Selected: $CHOSEN"
echo "Wrote:    ${ENV_FILE#"$PROJECT_DIR"/}  (ENGINE=codex, CODEX_OSS=1, CODEX_LOCAL_PROVIDER=$PROVIDER)"
echo "Server:   LM Studio on port ${LMS_PORT:-1234}"

if [ "$DO_DAEMON" -eq 1 ]; then
    if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user --version >/dev/null 2>&1; then
        echo "Error: systemctl --user unavailable; cannot restart the daemon." >&2
        exit 1
    fi
    rm -f "$PROJECT_DIR/.auto-loop-stop" "$PROJECT_DIR/.auto-loop-paused"
    systemctl --user restart auto-company.service
    echo "Restarted auto-company.service with the new model."
    exit 0
fi

if [ "$DO_START" -eq 1 ]; then
    echo "Starting the loop..."
    echo ""
    rm -f "$PROJECT_DIR/.auto-loop-stop"
    export ENGINE=codex CODEX_OSS=1 CODEX_LOCAL_PROVIDER="$PROVIDER" MODEL="$CHOSEN"
    exec "$PROJECT_DIR/scripts/core/auto-loop.sh"
fi

echo ""
echo "Next:"
echo "  make start                              # foreground"
echo "  systemctl --user restart auto-company.service   # daemon"
