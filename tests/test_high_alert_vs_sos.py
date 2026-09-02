"""High Alert and SOS are two different facts, and one column held both.

    python server/nigehban_server.py      # in one terminal
    python tests/test_high_alert_vs_sos.py

`mode` was answering "which alert is live" and "is High Alert armed" at once,
and POST /alert wrote 'sos' over it. The sweeper asked its High Alert check-ins
with `WHERE mode='high_alert'`, so pressing SOS ended them -- not for the
duration of the emergency, for good -- while the phone went on drawing a
countdown to a `next_buzz_at` nothing would ever match again. Found in the
field on a row whose next buzz was eighty-seven minutes overdue.

It broke the other way too: standing High Alert down wrote mode='idle' flatly,
which quietly downgraded a live SOS and stood the heartbeat watchdog down with
it.

Every check below is one of those two directions, plus the read a wearer's
phone uses to recover a question the websocket never delivered. End to end
because the bug lived in the seam between an endpoint and a SQL predicate,
which is exactly what a unit test of either one would have missed.

See migrations/008_high_alert_own_column.sql.
"""
import json
import os
import time
import urllib.error
import urllib.request

import psycopg
from psycopg.rows import dict_row
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"))
BASE = os.environ.get("NGB", "http://127.0.0.1:8000")
DB = os.environ["DATABASE_URL"]
PASS = FAIL = 0


def check(name, ok, extra=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}   {extra}")


def call(path, method="GET", body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            return r.status, json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw


def mkuser(tag):
    u = f"{tag}{int(time.time() * 1000) % 1000000}"
    st, r = call("/register", "POST", {"username": u, "password": "pw12", "name": tag.title()})
    assert st == 200, r
    return r


ward, fam = mkuser("hw"), mkuser("hf")
W, F = ward["token"], fam["token"]
call("/invite", "POST", {"code": ward["user_id"], "relation": "friend"}, F)
_, pend = call("/invites", token=W)
call(f"/invite/{pend['incoming'][0]['id']}/accept", "POST", token=W)
UID = ward["user_id"]
db = psycopg.connect(DB, row_factory=dict_row, autocommit=True)


def row():
    return db.execute("SELECT * FROM watch_state WHERE user_id=%s", (UID,)).fetchone()


def watch():
    return call(f"/watch/{UID}", token=W)[1]


print("\n== an SOS no longer ends High Alert's check-ins ==")
call("/watch/high_alert", "POST", {"on": True, "first_buzz_s": 400}, W)
r = row()
check("arming sets the flag and the mode", r["high_alert"] and r["mode"] == "high_alert", r)

_, a = call("/alert", "POST", {"kind": "sos"}, W)
r = row()
check("an SOS raises the mode", r["mode"] == "sos", r["mode"])
check("...and does NOT disarm High Alert", r["high_alert"] is True, r["high_alert"])

# The buzz is due in 5s now; the sweeper must still find this row.
db.execute("UPDATE watch_state SET next_buzz_at=%s WHERE user_id=%s",
           (time.time() + 2, UID))
print("     waiting 10s for a buzz DURING the SOS...")
time.sleep(10)
w = watch()
check("the sweeper still asks its check-in mid-SOS", w["checkin_due_at"] is not None, w)
check("...and the recovery read carries the id to answer it with",
      w["checkin_id"] is not None and w["checkin_reason"] == "high_alert", w)
check("...and says High Alert is armed even though mode says sos",
      w["mode"] == "sos" and w["high_alert"] is True, w)

st, _ = call(f"/checkin/{w['checkin_id']}/ack", "POST", token=W)
check("the recovered id really answers the question", st == 200, st)
check("...and the question is closed", watch()["checkin_id"] is None)

print("\n== resolving the SOS falls back to High Alert, not to idle ==")
call(f"/alert/{a['alert']['id']}/resolve", "POST", token=W)
r = row()
check("mode returns to high_alert", r["mode"] == "high_alert", r["mode"])
check("...still armed", r["high_alert"] is True, r)
check("...and still counted as armed by the watchdog", r["beat_armed"] is True, r)

print("\n== standing High Alert down during an SOS leaves the SOS alone ==")
call("/watch/high_alert", "POST", {"on": True, "first_buzz_s": 500}, W)
_, a2 = call("/alert", "POST", {"kind": "sos"}, W)
call("/watch/high_alert", "POST", {"on": False}, W)
r = row()
check("High Alert is off", r["high_alert"] is False, r)
check("...the SOS is untouched", r["mode"] == "sos", r["mode"])
check("...and the watch is still armed", r["beat_armed"] is True, r)
check("...with no more buzzes scheduled", r["next_buzz_at"] is None, r)

call(f"/alert/{a2['alert']['id']}/resolve", "POST", token=W)
r = row()
check("resolving now DOES fall back to idle, High Alert being off",
      r["mode"] == "idle" and r["beat_armed"] is False, r)

db.close()
print(f"\n  {PASS} passed, {FAIL} failed\n")
raise SystemExit(1 if FAIL else 0)
