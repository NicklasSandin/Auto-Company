#!/bin/bash
# ============================================================
# Auto Company — Reset Consensus to Day 0
# ============================================================
# Returns the company to its initial Day 0 state by removing
# memories/consensus.md.
#
# Day 0 is the ABSENCE of the file, not a skeleton: auto-loop.sh
# substitutes "No consensus file found. This is the very first cycle."
# when it cannot read it, and PROMPT.md's Cycle 1 rule takes over from
# there. Seeding a skeleton instead would satisfy validate_consensus()
# on the next cycle even if the agent wrote nothing, turning a genuine
# failure into a false OK.
#
# memories/ is gitignored, so git cannot recover the file. The previous
# consensus is archived by default.
#
# Usage:
#   ./reset-consensus.sh              # Archive, then reset
#   ./reset-consensus.sh --force      # Skip the confirmation countdown
#   ./reset-consensus.sh --no-archive # Delete without archiving
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONSENSUS_FILE="$PROJECT_DIR/memories/consensus.md"
# The loop's own per-cycle rollback snapshot. It must go too: restore_consensus()
# in auto-loop.sh copies it back after a failed cycle, which would resurrect the
# consensus this script just reset.
ROLLBACK_FILE="$CONSENSUS_FILE.bak"
PID_FILE="$PROJECT_DIR/.auto-loop.pid"

FORCE=0
ARCHIVE=1

while [ $# -gt 0 ]; do
    case "$1" in
        --force|-f)
            FORCE=1
            ;;
        --no-archive)
            ARCHIVE=0
            ;;
        --help|-h)
            echo "Usage:"
            echo "  ./reset-consensus.sh              # Archive the current consensus, then reset to Day 0"
            echo "  ./reset-consensus.sh --force      # Skip the confirmation countdown"
            echo "  ./reset-consensus.sh --no-archive # Delete without archiving"
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            echo "Try --help." >&2
            exit 1
            ;;
    esac
    shift
done

# A reset while a cycle is in flight is a race: the running agent may write
# consensus.md back, or a failing cycle may restore the rollback snapshot.
if [ -f "$PID_FILE" ]; then
    existing_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
        echo "Error: the loop is running (PID $existing_pid)."
        echo "Stop it first, then reset:"
        echo "  make stop"
        echo "  make reset-consensus"
        exit 1
    fi
    echo "Note: removing stale PID file (process $existing_pid is not running)."
    rm -f "$PID_FILE"
fi

if [ ! -f "$CONSENSUS_FILE" ] && [ ! -f "$ROLLBACK_FILE" ]; then
    echo "Already at the Day 0 state (no consensus file present)."
    exit 0
fi

if [ "$FORCE" -eq 0 ]; then
    echo "This will reset all company progress recorded in memories/consensus.md."
    if [ "$ARCHIVE" -eq 1 ]; then
        echo "A copy will be archived alongside it. Ctrl+C to cancel."
    else
        echo "No copy will be kept (--no-archive). Ctrl+C to cancel."
    fi
    sleep 3
fi

if [ -f "$CONSENSUS_FILE" ]; then
    if [ "$ARCHIVE" -eq 1 ]; then
        archive_file="$PROJECT_DIR/memories/consensus-$(date '+%Y%m%d-%H%M%S').archive.md"
        mv "$CONSENSUS_FILE" "$archive_file"
        echo "Archived previous consensus: ${archive_file#"$PROJECT_DIR"/}"
    else
        rm -f "$CONSENSUS_FILE"
        echo "Removed memories/consensus.md"
    fi
fi

if [ -f "$ROLLBACK_FILE" ]; then
    rm -f "$ROLLBACK_FILE"
    echo "Removed the loop's rollback snapshot (memories/consensus.md.bak)"
fi

echo "Consensus reset to the initial Day 0 state."
echo "The next cycle will be told: 'No consensus file found. This is the very first cycle.'"
