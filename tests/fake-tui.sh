#!/bin/sh
# Stands in for an interactive claude in a tmux pane: draws one frame and waits. FAKE_TUI_FRAME picks it.
[ "$1" = "--version" ] && { echo "2.1.280 (Claude Code)"; exit 0; }
cat "$(dirname "$0")/fixtures/${FAKE_TUI_FRAME:-pane-idle.txt}"
exec sleep 600
