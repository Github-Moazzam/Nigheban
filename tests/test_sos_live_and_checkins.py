"""An SOS that keeps asking, keeps reporting, and can end by being answered.

    python server/nigehban_server.py      # in one terminal
    python tests/test_sos_live_and_checkins.py

Three changes to the emergency path, tested together because they are one flow
and the seams between them are where the bugs live:

  1. A missed HIGH ALERT check-in is an emergency, not a footnote. It used to
     be `checkin_missed` -- severity 3, no siren, a line in a list -- which is
     the quietest alert in the product delivered at the exact moment the
     contract the wearer armed ("ask me every five minutes, and if I stop
     answering, something is wrong") comes true. It is now `sos`, severity 5,
     with the Good Samaritan broadcast left PENDING because nobody consented
     to it: the alert exists because the person could not answer.

  2. An SOS asks its own check-ins, every five minutes, and answering two in a
     row stands it down. Before this an SOS raised from an idle phone asked
     nothing at all and could only be left by pressing a button -- which is
     exactly what somebody being followed home cannot reach for.

  3. The alert has a position that MOVES. `alerts.live_*` is the newest fix and
     `alert_track` is the trail behind it, and both stop when the server says
     so -- including the half hour after the stand-down, which is the walk home.

End to end and against a real database, because every one of these lives in the
seam between an endpoint, a SQL predicate and the five-second sweeper. A unit
test of any one of the three would have passed while the flow was broken.

RUN THIS WITH EXACTLY ONE SWEEPER ON THE DATABASE.

Not a style note -- it invalidates the results. This project routinely has a
laptop and the deployed AWS box pointed at the same Supabase, and each runs its
own five-second sweeper. Both poll the same `checkins` table, and whichever
wins a tick decides what a silence becomes; if the two are on different builds
the same test fails differently every run. Stop one of them, or point NGB at
whichever is under test:

    $env:NGB = "https://<the deployed host>"

See docs/AWS_DEPLOYMENT.md 1.1 -- the sweeper is a singleton by design.

See migration 011, ESCALATION and SOS_SAFE_STREAK in server/config.py.
"""
import json
import os
import secrets
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


# A fresh password per run, generated, never written down.
#
# The rest of the suite uses a shared literal, and a scanner flagged this file
# for repeating it. The scanner is right for a better reason than the one it
# gives: these accounts are registered against whatever database the run points
# at, and for this project that is routinely the production Supabase. A fixed,
# guessable password on throwaway accounts that hold a real family link -- and
# so can see a real person's alerts and position -- is a door left open in a
# safety product, however small.
#
# Generated once per process so the three users in a run share it and nothing
# has to be passed around. NGB_TEST_PW is the escape hatch for a run somebody
# needs to log into by hand afterwards.
TEST_PW = os.environ.get("NGB_TEST_PW") or secrets.token_urlsafe(18)


def mkuser(tag):
    u = f"{tag}{int(time.time() * 1000) % 1000000}"
    st, r = call("/register", "POST",
                 {"username": u, "password": TEST_PW, "name": tag.title()})
    assert st == 200, r
    return r


ward, fam, stranger = mkuser("lw"), mkuser("lf"), mkuser("lx")
W, F, X = ward["token"], fam["token"], stranger["token"]
call("/invite", "POST", {"code": ward["user_id"], "relation": "friend"}, F)
_, pend = call("/invites", token=W)
call(f"/invite/{pend['incoming'][0]['id']}/accept", "POST", token=W)
UID = ward["user_id"]
db = psycopg.connect(DB, row_factory=dict_row, autocommit=True)


def row():
    return db.execute("SELECT * FROM watch_state WHERE user_id=%s", (UID,)).fetchone()


def watch():
    return call(f"/watch/{UID}", token=W)[1]


def mine():
    return call("/alerts?scope=mine&limit=10", token=W)[1] or []


def due_now():
    """Drag every open question's deadline into the past.

    The sweeper's own five-minute schedule is not something a test can wait
    out, and faking it in the database is the honest way round that: the row is
    real, the deadline is real, and the code path that acts on it is the same
    one that runs at 3 a.m. Only the clock is impatient.
    """
    db.execute("UPDATE checkins SET due_at=%s WHERE user_id=%s AND acked_at IS NULL",
               (time.time() - 1, UID))


def buzz_now():
    """Bring the next scheduled check-in forward to right now."""
    db.execute("UPDATE watch_state SET next_buzz_at=%s WHERE user_id=%s",
               (time.time() - 1, UID))


def bail(why):
    """Stop with a verdict rather than a traceback.

    A test that dies on `None['id']` twenty lines after the real failure hides
    everything it had not got to yet, and buries the one line that mattered
    under a stack. Every stage below that depends on an earlier one checks it
    and says so here instead.
    """
    print(f"\n  CANNOT CONTINUE: {why}")
    print(f"\n  {PASS} passed, {FAIL} failed (the rest did not run)\n")
    print("  If the escalation did not happen, check that the SERVER is running")
    print("  the current code -- restart it -- and that migration 011 is applied:")
    print("      python server/migrate_pg.py")
    raise SystemExit(1)


def wait_for(fn, secs=14, every=1.0):
    """Poll until it is true, or give up. The sweeper ticks every five."""
    end = time.time() + secs
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(every)
    return fn()


# =========================================================================
print("\n== a missed High Alert check-in is an emergency, not a footnote ==")

before = {a["id"] for a in mine()}
call("/watch/high_alert", "POST", {"on": True, "first_buzz_s": 5}, W)
check("High Alert is armed", row()["high_alert"] is True, row())

print("     waiting for the sweeper to ask...")
q = wait_for(lambda: watch()["checkin_id"])
check("the server asked on its own", q is not None, watch())
check("...and the question is High Alert's",
      watch()["checkin_reason"] == "high_alert", watch())

# Nobody answers.
due_now()
print("     waiting for the silence to escalate...")
sos = wait_for(lambda: next((a for a in mine()
                             if a["id"] not in before and a["kind"] == "sos"), None))
check("silence becomes an SOS, not a checkin_missed", sos is not None,
      [a["kind"] for a in mine()][:4])
check("...at severity 5", sos and sos["severity"] == 5, sos and sos["severity"])
check("...raised by the server, not a phone",
      sos and sos["source"] == "server", sos and sos["source"])
# The one inference this product must never make. The alert exists BECAUSE the
# wearer could not answer a question, so reading that silence as permission to
# show their position to strangers would be the product consenting on behalf of
# somebody it has just decided may be in danger.
check("...and the Good Samaritan broadcast is NOT taken as consented",
      sos and sos["samaritan_status"] == "pending",
      sos and sos["samaritan_status"])
check("the watch is now in sos", row()["mode"] == "sos", row()["mode"])
check("...with High Alert still armed underneath it",
      row()["high_alert"] is True, row())
check("...and the next check-in already scheduled",
      row()["next_buzz_at"] is not None, row()["next_buzz_at"])

if not sos:
    bail("no SOS was raised from the missed High Alert check-in -- everything"
         " below depends on it")

# The family member can allow the broadcast the wearer was in no state to.
# The server always permitted this; nothing in the app ever asked.
st, r = call(f"/alert/{sos['id']}/samaritan-optin", "POST", {"action": "allow"}, F)
check("a family member can allow the broadcast on their behalf",
      st == 200 and r["samaritan_status"] == "allowed", (st, r))

# =========================================================================
print("\n== during an SOS, the five-minute question is the SOS's own ==")

buzz_now()
q2 = wait_for(lambda: watch()["checkin_id"])
check("the emergency asks its own check-in", q2 is not None, watch())
check("...and it is reasoned 'sos', not 'high_alert'",
      watch()["checkin_reason"] == "sos", watch()["checkin_reason"])

# =========================================================================
print("\n== a missed SOS check-in raises nothing and resets the run ==")

if not q2:
    bail("the SOS never asked its own check-in")
st, _ = call(f"/checkin/{q2}/ack", "POST", token=W)
check("the first answer lands", st == 200, st)
check("...and the run of answers is at one", row()["sos_streak"] == 1,
      row()["sos_streak"])

n_before = len(mine())
buzz_now()
q3 = wait_for(lambda: watch()["checkin_id"])
due_now()
print("     waiting for the missed SOS check-in...")
time.sleep(12)
# The family are already being sirened about this exact person. A second,
# quieter alert on top of it says less about the same thing and arrives while
# they are driving.
check("missing one raises no second alert", len(mine()) == n_before,
      f"{n_before} -> {len(mine())}")
check("...but the run of answers goes back to zero", row()["sos_streak"] == 0,
      row()["sos_streak"])
check("...and the SOS is still live",
      row()["mode"] == "sos" and not any(a["id"] == sos["id"] and a["resolved_at"]
                                         for a in mine()), row()["mode"])

# =========================================================================
print("\n== live location: a pin that moves, and a trail behind it ==")

st, r = call("/location", "POST", {"lat": 31.5204, "lon": 74.3587, "accuracy": 12}, W)
check("a fix is accepted", st == 200 and r["accepted"] == 1, (st, r))
check("...and the server hands back the cadence it wants",
      r["tracking"] and r["tracking"]["fast_s"] == 10 and r["tracking"]["slow_s"] == 30,
      r.get("tracking"))
check("...attached to the live alert",
      r["tracking"]["alert_id"] == sos["id"], r["tracking"])

# A batch, as a phone flushes after a dead zone. Sent one request, not five.
#
# The timestamps are AFTER the single fix above, which is the ordering a real
# flush has: the buffer holds what happened while there was no signal, and the
# signal came back afterwards. Dating them before the fix already on the row
# would be testing the opposite rule -- see the late-arrival check below, which
# tests that one deliberately.
now = time.time()
st, r = call("/location", "POST", {"points": [
    {"lat": 31.5210, "lon": 74.3590, "at": now + 1},
    {"lat": 31.5216, "lon": 74.3594, "at": now + 2},
    {"lat": 31.5223, "lon": 74.3599, "at": now + 3},
    {"lat": 31.5231, "lon": 74.3604, "at": now + 4},
]}, W)
check("a buffered batch is accepted whole", st == 200 and r["accepted"] == 4, (st, r))

a = db.execute("SELECT * FROM alerts WHERE id=%s", (sos["id"],)).fetchone()
check("the alert carries the NEWEST fix, not the first",
      a["live_lat"] and abs(a["live_lat"] - 31.5231) < 1e-6, a["live_lat"])
check("...and the trail behind it is kept",
      db.execute("SELECT count(*) n FROM alert_track WHERE alert_id=%s",
                 (sos["id"],)).fetchone()["n"] == 5)

# A straggler from a buffer that has already been flushed. It belongs in the
# trail -- the path is a record and gaps in it are worth keeping -- but it must
# NOT become the live pin, or a late arrival drags the family's map backwards
# to somewhere she has already left.
st, r = call("/location", "POST",
             {"lat": 31.4000, "lon": 74.2000, "at": now - 600}, W)
back = db.execute("SELECT live_lat FROM alerts WHERE id=%s", (sos["id"],)).fetchone()
check("a late fix is kept in the trail but does not move the pin backwards",
      st == 200 and abs(back["live_lat"] - 31.5231) < 1e-6, back["live_lat"])
check("...and it is still recorded in the path",
      db.execute("SELECT count(*) n FROM alert_track WHERE alert_id=%s",
                 (sos["id"],)).fetchone()["n"] == 6)

# `lat`/`lon` is where it happened and must not move: it is what a family
# member searches when the trail goes cold. `maps` is where to GO.
check("the original pin is untouched",
      a["lat"] is None or abs((a["lat"] or 0) - 31.5231) > 1e-6, a["lat"])
_, seen = call("/alerts?scope=incoming", token=F)
live_row = next((x for x in seen if x["id"] == sos["id"]), None)
check("the family's row points at the live fix",
      live_row and live_row["maps"] and "31.523" in live_row["maps"],
      live_row and live_row["maps"])

st, tr = call(f"/alert/{sos['id']}/track", token=F)
check("family can read the trail", st == 200 and len(tr["points"]) == 5, (st, tr))
check("...oldest first, so it draws as a path",
      tr["points"][0]["at"] <= tr["points"][-1]["at"], tr["points"][:1])
st, _ = call(f"/alert/{sos['id']}/track", token=X)
check("a stranger cannot", st == 403, st)

# =========================================================================
print("\n== two answered check-ins in a row end the emergency ==")

buzz_now()
q4 = wait_for(lambda: watch()["checkin_id"])
if not q4:
    bail("no check-in was opened for the first of the two safe answers")
call(f"/checkin/{q4}/ack", "POST", token=W)
check("one answer is not enough", row()["sos_streak"] == 1 and row()["mode"] == "sos",
      (row()["sos_streak"], row()["mode"]))
check("...and the alert is still live",
      not next(x for x in mine() if x["id"] == sos["id"])["resolved_at"])

buzz_now()
q5 = wait_for(lambda: watch()["checkin_id"])
if not q5:
    bail("no check-in was opened for the second of the two safe answers")
call(f"/checkin/{q5}/ack", "POST", token=W)

done = wait_for(lambda: next((x for x in mine() if x["id"] == sos["id"]
                              and x["resolved_at"]), None), 10)
check("two in a row stands the SOS down", done is not None,
      next(x for x in mine() if x["id"] == sos["id"]))
check("...the run is reset for next time", row()["sos_streak"] == 0, row()["sos_streak"])
# The emergency is over; the standing watch the wearer switched on before it is
# not, and it was never the SOS's to end. See migration 008.
check("...and it falls back to High Alert, which is still armed",
      row()["mode"] == "high_alert" and row()["high_alert"] is True,
      (row()["mode"], row()["high_alert"]))
check("...with High Alert's own next question scheduled",
      row()["next_buzz_at"] is not None, row()["next_buzz_at"])

# =========================================================================
print("\n== tracking outlives the stand-down, so the family see her get home ==")

a = db.execute("SELECT * FROM alerts WHERE id=%s", (sos["id"],)).fetchone()
check("a tracking window was granted past the stand-down",
      a["track_until"] and a["track_until"] > time.time() + 1500, a["track_until"])

st, r = call("/location", "POST", {"lat": 31.5240, "lon": 74.3610}, W)
check("positions are still accepted after 'I am safe'",
      st == 200 and r["tracking"] and r["tracking"]["resolved"] is True, (st, r))
check("...at the slower after-stand-down rhythm",
      r["tracking"]["after_standdown_s"] == 30, r["tracking"])

# And it is the SERVER that closes the window, not the phone. Winding the
# column back is the same thing as half an hour passing.
db.execute("UPDATE alerts SET track_until=%s WHERE id=%s", (time.time() - 1, sos["id"]))
st, r = call("/location", "POST", {"lat": 31.5250, "lon": 74.3620}, W)
check("once the window closes the server says stop",
      st == 200 and r["tracking"] is None, (st, r))

# An empty body is the phone asking "should I be tracking anything?" -- the
# recovery path after Android kills the process and the plan goes with it.
st, r = call("/location", "POST", {}, W)
check("an empty report is a question, and the answer is no",
      st == 200 and r["tracking"] is None, (st, r))

call("/watch/high_alert", "POST", {"on": False}, W)
db.close()
print(f"\n  {PASS} passed, {FAIL} failed\n")
raise SystemExit(1 if FAIL else 0)
