#!/usr/bin/env bash
# NIGEHBAN — DEV TUNNEL (macOS / Linux / WSL / Git Bash)
#
# The counterpart to dev-tunnel.ps1. Same job: bring up the server and a public
# HTTPS tunnel, then print the one address that goes into the phones.
#
#     ./scripts/dev-tunnel.sh
#
# See the header of dev-tunnel.ps1 for why a tunnel rather than same-Wi-Fi.

set -euo pipefail

PORT=8000
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_PY="$ROOT/server/nigehban_server.py"

step() { printf '  %s\n' "$1"; }
bad()  { printf '  \033[31m%s\033[0m\n' "$1" >&2; }

printf '\n  \033[32mNIGEHBAN DEV TUNNEL\033[0m\n  -------------------\n'

[ -f "$SERVER_PY" ] || { bad "cannot find $SERVER_PY"; exit 1; }

PY=$(command -v python3 || command -v python || true)
[ -n "$PY" ] || { bad 'python is not on PATH'; exit 1; }

if ! "$PY" -c 'import fastapi, uvicorn' 2>/dev/null; then
  bad 'FastAPI is not installed. Run this first:'
  printf '      %s -m pip install -r requirements.txt\n' "$PY"
  exit 1
fi

command -v ngrok >/dev/null || {
  bad 'ngrok is not on PATH.'
  printf '      https://ngrok.com/download   (then: ngrok config add-authtoken <token>)\n'
  exit 1
}

# ---- the server ----------------------------------------------------------
listening() { curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; }

if listening; then
  step "server already listening on $PORT — leaving it alone"
else
  step "starting the server on $PORT"
  ( cd "$ROOT" && "$PY" "$SERVER_PY" >"$ROOT/.server.log" 2>&1 & )
  for _ in $(seq 1 50); do listening && break; sleep 0.4; done
  listening || { bad 'the server did not come up — see .server.log'; exit 1; }
fi

# ---- the tunnel ----------------------------------------------------------
# ngrok publishes its own state on 4040; asking it beats scraping the console.
tunnel_url() {
  curl -fsS --max-time 2 http://127.0.0.1:4040/api/tunnels 2>/dev/null \
    | "$PY" -c 'import json,sys
try:
    for t in json.load(sys.stdin).get("tunnels", []):
        if t.get("proto") == "https":
            print(t["public_url"]); break
except Exception:
    pass' 2>/dev/null
}

URL="$(tunnel_url || true)"
if [ -n "$URL" ]; then
  step 'a tunnel is already open — reusing it'
else
  step 'opening the tunnel'
  ( ngrok http "$PORT" --log=stdout >"$ROOT/.ngrok.log" 2>&1 & )
  for _ in $(seq 1 40); do
    sleep 0.6
    URL="$(tunnel_url || true)"
    [ -n "$URL" ] && break
  done
fi

if [ -z "$URL" ]; then
  bad 'ngrok did not report a tunnel.'
  printf '      Most often this is a missing authtoken:\n'
  printf '      ngrok config add-authtoken <token from dashboard.ngrok.com>\n'
  exit 1
fi

# ---- prove it end to end before claiming success -------------------------
# A tunnel that is up but not forwarding looks fine from here until you
# actually ask it something. One request now saves a confused tester later.
if curl -fsS --max-time 8 -H 'ngrok-skip-browser-warning: true' "$URL/health" | grep -q '"ok"'; then
  VERDICT='  \033[32mverified: the server answered through the tunnel\033[0m'
else
  VERDICT='  \033[33mWARNING: the tunnel is open but /health did not answer\033[0m'
fi

printf '\n  \033[32m==================================================================\033[0m\n'
printf '   PUT THIS IN THE PHONES\n\n'
printf '     \033[1m%s\033[0m\n\n' "$URL"
printf "$VERDICT\n"
printf '  \033[32m==================================================================\033[0m\n\n'
step 'ngrok inspector (every request, replayable): http://127.0.0.1:4040'
step 'this URL changes when ngrok restarts — re-run this script and re-paste'
printf '\n'
