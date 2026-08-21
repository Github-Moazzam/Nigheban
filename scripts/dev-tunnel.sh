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

# ---- .env ----------------------------------------------------------------
# A plain KEY=VALUE file at the repo root, already gitignored, so a reserved
# domain lives with the project instead of in your shell profile -- and every
# teammate keeps their own without touching the repo.
#
# Deliberately parsed rather than sourced: `. .env` would execute it, which
# turns an innocuous-looking config file into arbitrary code.
#
# Precedence, most specific first:  the shell  >  .env
ENV_FILE="$ROOT/.env"
SQ="'"; DQ='"'
if [ -f "$ENV_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"
    [ "$key" = "$line" ] && continue          # no = on the line, skip it
    val="${line#*=}"
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    val="${val#"${val%%[![:space:]]*}"}"      # strip surrounding whitespace
    val="${val%"${val##*[![:space:]]}"}"
    # Strip one matching pair of surrounding quotes, either kind. Written
    # with $SQ/$DQ because a literal quote inside a case pattern is a good
    # way to write something that parses and then matches everything.
    case "$val" in
      "$DQ"*"$DQ") val="${val#$DQ}"; val="${val%$DQ}" ;;
      "$SQ"*"$SQ") val="${val#$SQ}"; val="${val%$SQ}" ;;
    esac
    # An already-exported variable wins, so a one-off override still works.
    if [ -z "${!key:-}" ]; then
      export "$key=$val"
    fi
  done < "$ENV_FILE"
  step 'loaded .env'
fi

[ -f "$SERVER_PY" ] || { bad "cannot find $SERVER_PY"; exit 1; }

# The venv first, deliberately. A global python that happens to be on PATH is
# the one without fastapi in it, and the check below would then tell you to
# install something you have already installed.
if [ -x "$ROOT/.venv/bin/python" ]; then
  PY="$ROOT/.venv/bin/python"
elif [ -x "$ROOT/.venv/Scripts/python.exe" ]; then   # a venv made on Windows
  PY="$ROOT/.venv/Scripts/python.exe"
else
  PY=$(command -v python3 || command -v python || true)
fi
[ -n "$PY" ] || { bad 'no python found -- python -m venv .venv, then pip install -r requirements.txt'; exit 1; }
step "python: $PY"

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

# A reserved domain stops the address in the phones from changing. Set it once:
#     export NIGEHBAN_NGROK_DOMAIN=overcoat-quizzical-chatty.ngrok-free.dev
DOMAIN="${NIGEHBAN_NGROK_DOMAIN:-}"

URL="$(tunnel_url || true)"

# A tunnel already up on the wrong address is worse than none: it looks like
# success, and every phone is pointed somewhere else. Free ngrok runs one
# agent at a time, so the fix is to close it rather than open a second.
if [ -n "$URL" ] && [ -n "$DOMAIN" ] && [ "${URL#*$DOMAIN}" = "$URL" ]; then
  bad "a tunnel is already open on $URL — that is not $DOMAIN"
  printf '      free ngrok allows one agent at a time. Close it, then re-run:\n'
  printf '      pkill ngrok\n'
  exit 1
fi

if [ -n "$URL" ]; then
  step 'a tunnel is already open — reusing it'
else
  if [ -n "$DOMAIN" ]; then
    # --url is the current flag; older CLIs spell it --domain.
    step "opening the tunnel on $DOMAIN"
    ( ngrok http "$PORT" --url="$DOMAIN" --log=stdout >"$ROOT/.ngrok.log" 2>&1 & )
  else
    step 'opening the tunnel (random address — see NIGEHBAN_NGROK_DOMAIN)'
    ( ngrok http "$PORT" --log=stdout >"$ROOT/.ngrok.log" 2>&1 & )
  fi
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
  if [ -n "$DOMAIN" ]; then
    printf '      Or an older ngrok that spells it --domain=%s\n' "$DOMAIN"
  fi
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
if [ -n "$DOMAIN" ]; then
  step 'this address is reserved — it survives restarts, so paste it once'
  step 'the phones keep working after a laptop reboot'
else
  step 'this URL changes when ngrok restarts — re-run this script and re-paste'
  step 'to stop that: reserve a domain at dashboard.ngrok.com, set NIGEHBAN_NGROK_DOMAIN'
fi
printf '\n'
