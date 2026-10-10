#!/bin/sh
# The local API from a shell, with curl only. Copy what you need.
#   sh curl.sh health
#   sh curl.sh send telegram:123456 "The backup finished."
#   sh curl.sh ask  telegram:123456 "What is on my list today?"
#   sh curl.sh turn telegram:123456 "Summarise today's mail."   # queued; the answer goes to the chat
#   sh curl.sh events telegram:123456                            # watch the chat live (owner's token)
# Text goes into JSON, so this uses jq to quote it. Contract: GET /openapi.json on the same socket.
set -eu
STATE=${ANGELIA_STATE_DIR:-$HOME/.angelia}
SOCK=$STATE/api.sock
TOKEN=${ANGELIA_API_TOKEN:-$(cat "$STATE/api.token")}

api() { # api METHOD PATH [JSON]
  if [ $# -ge 3 ]; then
    curl -sS --fail-with-body --unix-socket "$SOCK" -X "$1" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$3" "http://localhost$2"
  else
    curl -sS --fail-with-body --unix-socket "$SOCK" -X "$1" -H "Authorization: Bearer $TOKEN" "http://localhost$2"
  fi
  echo
}
body() { jq -cn --arg key "$1" --arg text "$2" '{key: $key, text: $text}'; }

case "${1:-}" in
  health) api GET /healthz ;;
  send) api POST /send "$(body "$2" "$3")" ;;
  ask) api POST /ask "$(body "$2" "$3")" ;;
  turn) api POST /turn "$(body "$2" "$3")" ;;
  events) curl -sSN --unix-socket "$SOCK" -H "Authorization: Bearer $TOKEN" "http://localhost/events?key=$(jq -rn --arg k "$2" '$k|@uri')" ;;
  *) sed -n '2,8p' "$0"; exit 2 ;;
esac
