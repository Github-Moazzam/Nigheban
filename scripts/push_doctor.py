#!/usr/bin/env python3
"""push_doctor -- find out why a closed-app push never arrives.

Your server logs stop at "accepted by Expo", which only means Expo *queued*
the message. Whether FCM actually delivered it is in the push *receipt*, a
separate call the server does not make. This script makes it.

Usage (run from the server box, or anywhere DATABASE_URL points at the same DB):

    python scripts/push_doctor.py list
    python scripts/push_doctor.py list --user Ali
    python scripts/push_doctor.py send  --user Ali          # send + fetch receipts
    python scripts/push_doctor.py send  --token 'ExponentPushToken[xxxx]'

Reads DATABASE_URL from the environment / server/.env, same as the server.
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.request

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError:
    sys.exit("pip install 'psycopg[binary]'  (same dep as the server)")

_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

try:
    from dotenv import load_dotenv
    # override=True: a stale/broken DATABASE_URL in the shell env must not win.
    for p in (os.path.join(_ROOT, ".env"), os.path.join(_ROOT, "server", ".env")):
        if os.path.exists(p):
            load_dotenv(p, override=True)
except ImportError:
    pass

EXPO_SEND = "https://exp.host/--/api/v2/push/send"
EXPO_RECEIPTS = "https://exp.host/--/api/v2/push/getReceipts"

_DSN_OVERRIDE = None


def _clean_dsn(raw):
    """Undo the common ways this value arrives mangled from a shell."""
    s = (raw or "").strip().strip('"').strip("'").strip()
    # e.g. a copy/paste that kept the assignment: `DATABASE_URL=postgresql://...`
    m = re.search(r"postgres(?:ql)?://\S+", s)
    return m.group(0) if m else s


def db():
    raw = _DSN_OVERRIDE or os.environ.get("DATABASE_URL")
    url = _clean_dsn(raw)
    if not url or not url.startswith(("postgres://", "postgresql://")):
        sys.exit(f"no usable DATABASE_URL (got {raw!r}). "
                 f"Pass it explicitly:  --dsn 'postgresql://user:pass@host:port/db'")
    host = re.sub(r"://[^@/]+@", "://***@", url)
    print(f"db: {host}")
    c = psycopg.connect(url, row_factory=dict_row)
    c.autocommit = True
    return c


def rows_for(user=None):
    q = ("SELECT d.id, d.push_token, d.platform, d.os_version, d.app_version,"
         " d.last_seen, u.name FROM devices d JOIN users u ON u.id = d.user_id")
    args = []
    if user:
        q += " WHERE u.name ILIKE %s"
        args.append(f"%{user}%")
    q += " ORDER BY d.last_seen DESC"
    with db() as c:
        return c.execute(q, args).fetchall()


def cmd_list(args):
    rows = rows_for(args.user)
    if not rows:
        if args.user:
            print(f"no user matches '{args.user}'. Names in the DB:")
            with db() as c:
                for u in c.execute("SELECT name FROM users ORDER BY name").fetchall():
                    print(f"  {u['name']}")
        else:
            print("no devices at all -- nobody has registered a push token")
        return
    for r in rows:
        age = time.time() - (r["last_seen"] or 0)
        tok = r["push_token"] or "(NULL -- registration never succeeded)"
        print(f"{r['name']:<16} {r['platform']:<8} app={r['app_version'] or '?':<10}"
              f" seen {age/3600:6.1f}h ago  {tok}")


def post(url, payload):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode())


def cmd_send(args):
    if args.token:
        tokens = [args.token]
    else:
        rows = rows_for(args.user)
        if not rows:
            print(f"no user matches '{args.user}' -- run `list` with no --user to see names")
            return
        tokens = [r["push_token"] for r in rows if r["push_token"]]
    if not tokens:
        print("user(s) matched, but push_token is NULL -- the phone never completed"
              " registration, OR a prior receipt error nulled it. Open the app on"
              " that phone while signed in, then retry."); return

    print(f"sending to {len(tokens)} token(s)")
    messages = []
    for t in tokens:
        # visible -- mirrors the server's real severity-5 SOS push
        messages.append({"to": t, "title": "EMERGENCY SOS - Nigehban test",
                         "body": "Test alert. If this shows on the locked phone, delivery works.",
                         "sound": "default", "priority": "high", "ttl": 300,
                         "channelId": "nigehban_emergency_alarm",
                         "data": {"alert_id": "push-doctor-test", "severity": 5,
                                  "kind": "sos", "name": "Nigehban test"}})
        # silent -- the one that wakes the lock-screen siren task. alert_id is
        # required or the headless task's extractAlert() returns null and the
        # siren never fires.
        messages.append({"to": t, "priority": "high", "ttl": 300,
                         "_contentAvailable": True,
                         "data": {"alert_id": "push-doctor-test", "severity": 5,
                                  "kind": "sos", "name": "Nigehban test", "maps": None}})

    tickets = post(EXPO_SEND, messages).get("data", [])
    ids = []
    for m, tk in zip(messages, tickets):
        st = tk.get("status")
        if st == "ok":
            ids.append(tk["id"])
            print(f"  ticket ok   {tk['id']}")
        else:
            print(f"  ticket FAIL {st}: {tk.get('message')} {tk.get('details')}")
    if not ids:
        print("\nEvery ticket was rejected at submit time -- fix the errors above"
              " (bad token / project mismatch)."); return

    wait = args.wait
    print(f"\nwaiting {wait}s for delivery receipts...")
    time.sleep(wait)
    receipts = post(EXPO_RECEIPTS, {"ids": ids}).get("data", {})
    print()
    for rid in ids:
        r = receipts.get(rid)
        if r is None:
            print(f"  {rid}  no receipt yet (Expo still trying -- rerun later)")
            continue
        st = r.get("status")
        if st == "ok":
            print(f"  {rid}  DELIVERED to FCM ok")
        else:
            err = (r.get("details") or {}).get("error")
            print(f"  {rid}  {st}: {r.get('message')}  error={err}")
            print("      -> " + {
                "DeviceNotRegistered": "token is dead (reinstall / rotated / app data cleared). "
                                       "The phone must reopen the app to re-register.",
                "MismatchSenderId": "this build's FCM sender id != the credentials Expo holds. "
                                    "Run `eas credentials` and re-upload the FCM V1 key.",
                "InvalidCredentials": "no / bad FCM V1 key on the EAS project. `eas credentials`.",
                "MessageTooBig": "payload over 4KB -- trim the data blob.",
                "MessageRateExceeded": "backing off; retry slower.",
            }.get(err, "see https://docs.expo.dev/push-notifications/sending-notifications/#individual-errors"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dsn", help="postgresql://... (overrides env / .env)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("list"); p.add_argument("--user")
    p = sub.add_parser("send")
    p.add_argument("--user"); p.add_argument("--token")
    p.add_argument("--wait", type=int, default=20)
    args = ap.parse_args()
    global _DSN_OVERRIDE
    _DSN_OVERRIDE = args.dsn
    {"list": cmd_list, "send": cmd_send}[args.cmd](args)


if __name__ == "__main__":
    main()
