#!/bin/sh
# A tmux-hosted agent that writes the canary variables it can see into its folder, then behaves like
# fake-tui.sh. Values only for CANARY_*: a real token in the test runner's environment is never printed.
[ "$1" = "--version" ] && { echo "2.1.280 (Claude Code)"; exit 0; }
{ env | grep -E '^CANARY_'; env | grep -oE '^(TELEGRAM_BOT_TOKEN|ANTHROPIC_API_KEY)='; } | sort > ./pane-env.txt
exec "$(dirname "$0")/fake-tui.sh"
