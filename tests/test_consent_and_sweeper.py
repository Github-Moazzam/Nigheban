"""B1 (consent) and B2 (the sweeper), end to end against a running server.

    python server/nigehban_server.py      # in one terminal
    python tests/test_consent_and_sweeper.py

This is the "done when" for both milestones, and it is written to be read as
much as run: every check is a sentence about what the product promises. The
B2 half deliberately takes about a minute, because what it is proving is that
deadlines pass with nothing connected to anything.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

import psycopg
from psycopg.rows import dict_row

BASE = os.environ.get("NGB", "http://127.0.0.1:8000")

PASS = FAIL = 0


def db():
    """The same database the server uses, and only that one.

    This used to open `server/nigehban.db` with sqlite3, which is trap #5 from
    the branch notes happening to the test suite itself: two databases both
    answer. The read half passed against a stale file the server had not
    touched in days, and the write half updated a row nothing would ever read,
    so the watchdog section failed while the code it tested was fine.

    DATABASE_URL is read from the environment first, then from the repo-root
    `.env` -- this script is run directly, so nothing else loads it.
    """
    url = os.environ.get("DATABASE_URL")
    if not url:
        env = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env")
        try:
            with open(env) as fh:
                for line in fh:
                    if line.strip().startswith("DATABASE_URL"):
                        url = line.split("=", 1)[1].strip()
                        break
        except OSError:
            pass
    if not url:
        sys.exit("DATABASE_URL not set, and no .env at the repo root -- "
                 "the suite cannot check the database the server is using.")
    return psycopg.connect(url, row_factory=dict_row, autocommit=True)


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
    # The same header the app sends, so NGB= can point at a tunnel. Note that
    # ngrok's free tier caps requests per minute and this suite is a burst of
    # about a hundred, so a tunnel run may drop connections that localhost
    # never would -- that is ngrok, not the server.
    req.add_header("ngrok-skip-browser-warning", "true")
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
    u = f"{tag}{int(time.time() * 1000) % 100000}"
    st, r = call("/register", "POST", {"username": u, "password": "pw12", "name": tag.title()})
    assert st == 200, r
    return r


print("\n== B1: nobody is linked without two people acting ==")
alice = mkuser("alice")
bob = mkuser("bob")
mal = mkuser("mallory")
A, B, M = alice["token"], bob["token"], mal["token"]

st, r = call("/family", "POST", {"code": bob["user_id"]}, A)
check("the old auto-link endpoint is gone (410)", st == 410, f"got {st}")

st, r = call("/invite", "POST", {"code": bob["user_id"], "relation": "friend"}, A)
check("inviting by user code creates a request, not a link",
      st == 200 and r.get("linked") is False and r.get("pending") is True, r)
check("the invite response leaks nothing about who was invited",
      "member" not in r and "name" not in json.dumps(r), r)

_, fam_a = call("/family", token=A)
_, fam_b = call("/family", token=B)
check("no link exists on either side yet", fam_a == [] and fam_b == [],
      f"{fam_a} / {fam_b}")

_, r = call("/alert", "POST", {"kind": "sos"}, A)
check("an unaccepted invite moves no alerts", r.get("delivered_to") == 0, r)
_, r = call("/alert", "POST", {"kind": "sos"}, B)
check("...in the other direction either", r.get("delivered_to") == 0, r)

st, inv = call("/invites", token=B)
pend = [i for i in inv["incoming"] if i["from"]["id"] == alice["user_id"]]
check("the request is waiting for Bob to answer", len(pend) == 1, inv)
_, out = call("/invites", token=A)
check("Alice's outgoing request shows the code and no name",
      out["outgoing"] and out["outgoing"][0]["to"] == bob["user_id"]
      and "name" not in json.dumps(out["outgoing"]), out)

st, r = call(f"/invite/{pend[0]['id']}/accept", "POST", token=B)
check("Bob can accept", st == 200, r)
_, fam_a = call("/family", token=A)
_, fam_b = call("/family", token=B)
check("accepting links both directions",
      [m["id"] for m in fam_a] == [bob["user_id"]]
      and [m["id"] for m in fam_b] == [alice["user_id"]], f"{fam_a} / {fam_b}")
_, r = call("/alert", "POST", {"kind": "sos"}, A)
check("now the alert reaches the family", r.get("delivered_to") == 1, r)

print("\n== B1: the code space is not a directory ==")
st1, r1 = call("/invite", "POST", {"code": "NGB-ZZZZ"}, M)
st2, r2 = call("/invite", "POST", {"code": alice["user_id"]}, M)
check("a real code and a made-up one answer identically",
      (st1, r1) == (st2, r2), f"{st1} {r1}  vs  {st2} {r2}")

print("\n== B1: a decline is permanent, and silent ==")
_, inv = call("/invites", token=A)
mine = [i for i in inv["incoming"] if i["from"]["id"] == mal["user_id"]]
check("Alice sees Mallory's request", len(mine) == 1, inv)
st, r = call(f"/invite/{mine[0]['id']}/decline", "POST", token=A)
check("Alice can decline", st == 200, r)
_, out = call("/invites", token=M)
still = [i for i in out["outgoing"] if i["to"] == alice["user_id"]]
check("to Mallory it still looks unanswered - a decline is not announced",
      len(still) == 1, out)
st, r = call("/invite", "POST", {"code": alice["user_id"]}, M)
check("re-inviting after a decline gets the same cheerful answer",
      st == 200 and r.get("pending") is True, r)
_, inv = call("/invites", token=A)
check("...and does nothing at all - no new request appears",
      not [i for i in inv["incoming"] if i["from"]["id"] == mal["user_id"]], inv)
_, fam_a = call("/family", token=A)
check("Mallory is still not in Alice's family",
      mal["user_id"] not in [m["id"] for m in fam_a], fam_a)

print("\n== B1: pairing codes ==")
st, p = call("/pair", "POST", {"relation": "mother"}, B)
check("Bob can issue a pairing code",
      st == 200 and p["code"].startswith("PAIR-") and p["ttl_s"] == 600, p)
st, r = call("/invite", "POST", {"code": p["code"]}, M)
check("redeeming it links immediately - both people acted",
      st == 200 and r.get("linked") is True, r)
_, fam_b = call("/family", token=B)
check("Bob's family now has Mallory", mal["user_id"] in [m["id"] for m in fam_b], fam_b)
st, r = call("/invite", "POST", {"code": p["code"]}, A)
check("the same code cannot be used twice", st == 404, f"{st} {r}")
st, p2 = call("/pair", "POST", {}, B)
st, r = call("/invite", "POST", {"code": p2["code"]}, B)
check("you cannot redeem your own pairing code", st == 400, f"{st} {r}")
st, p3 = call("/pair", "POST", {}, B)
st, r = call("/invite", "POST", {"code": p2["code"]}, A)
check("issuing a new code kills the previous one", st == 404, f"{st} {r}")

print("\n== B1: rate limits ==")
# A fresh account, so the assertion is about the per-account bucket rather
# than the per-network one -- which a second run of this suite within the
# hour would otherwise be sharing.
guess = mkuser("guesser")
sts = [call("/invite", "POST", {"code": f"NGB-QQ{i:02d}"}, guess["token"])[0]
       for i in range(14)]
check("code guessing is throttled", 429 in sts, sts)
sts = [call("/login", "POST", {"username": bob["username"], "password": "nope"})[0]
       for _ in range(12)]
check("password guessing is throttled", 429 in sts, sts)

print("\n== B1: the database is not a list of live sessions ==")
con = db()
# Stronger than the old row-by-row check: on Postgres the column is gone
# entirely, so a plaintext token cannot be stored even by accident.
cols = [r["column_name"] for r in con.execute(
    "SELECT column_name FROM information_schema.columns "
    "WHERE table_name='users'").fetchall()]
check("the schema has no plaintext token column at all", "token" not in cols, cols)
rows = con.execute("SELECT token_hash FROM users").fetchall()
check("hashes are there instead", all(len(r["token_hash"] or "") == 64 for r in rows))
prs = con.execute("SELECT token_hash FROM pairings").fetchall()
check("pairing codes are stored hashed too",
      all(len(r["token_hash"]) == 64 for r in prs), prs)
st, r = call("/me", token=A)
check("a real token still works", st == 200 and r["user_id"] == alice["user_id"], r)
# Alice's own stored hash, not an arbitrary row -- so this cannot pass merely
# because some unrelated user happened to have a null one.
mine = con.execute("SELECT token_hash FROM users WHERE id=%s",
                   (alice["user_id"],)).fetchone()
check("a live session is stored as a hash", len(mine["token_hash"] or "") == 64, mine)
st, r = call("/me", token=mine["token_hash"])
check("the stored hash is not itself a usable token", st == 401, f"{st} {r}")

print("\n== B2: deadlines with no phone attached ==")
# Alice asks Bob, Bob never answers. Nothing is connected to anything.
st, r = call(f"/checkin/{bob['user_id']}", "POST", {"window": 5}, A)
check("a check-in can be created with a short deadline",
      st == 200 and r["checkin_id"], r)
_, w = call(f"/watch/{bob['user_id']}", token=A)
check("the family can see a question is outstanding", w["checkin_due_at"] is not None, w)
print("     waiting 12s for the sweeper...")
time.sleep(12)
_, alerts = call("/alerts?scope=incoming", token=A)
missed = [a for a in alerts if a["kind"] == "checkin_missed"
          and a["user"]["id"] == bob["user_id"]]
check("an unanswered check-in escalates on its own", len(missed) == 1, alerts[:2])
check("...at severity 3", missed and missed[0]["severity"] == 3, missed[:1])
check("...and is marked as coming from the server, not a phone",
      missed and missed[0]["source"] == "server", missed[:1])

n_before = len(missed)
time.sleep(7)
_, alerts = call("/alerts?scope=incoming", token=A)
again = [a for a in alerts if a["kind"] == "checkin_missed"
         and a["user"]["id"] == bob["user_id"]]
check("a stale deadline pages the family once, not every tick",
      len(again) == n_before, f"{n_before} -> {len(again)}")

print("\n== B2: answering stops the escalation ==")
st, r = call(f"/checkin/{bob['user_id']}", "POST", {"window": 6}, A)
_, r2 = call("/alert", "POST", {"kind": "checkin_ack", "source": "band"}, B)
check("'I'm fine' from the band answers the open question", r2["ok"], r2)
_, w = call(f"/watch/{bob['user_id']}", token=A)
check("nothing is outstanding any more", w["checkin_due_at"] is None, w)
before = len([a for a in call("/alerts?scope=incoming", token=A)[1]
              if a["kind"] == "checkin_missed"])
time.sleep(10)
after = len([a for a in call("/alerts?scope=incoming", token=A)[1]
             if a["kind"] == "checkin_missed"])
check("no escalation follows an answered check-in", before == after, f"{before} -> {after}")

print("\n== B2: High Alert is the server's mode, not the app's ==")
st, r = call("/watch/high_alert", "POST", {"on": True, "first_buzz_s": 5}, B)
check("High Alert can be armed", st == 200 and r["mode"] == "high_alert", r)
# 12s, not 9. The deadline is +5s and the sweeper ticks every 5s on a phase set
# when the server booted, so the buzz can legitimately land anywhere in
# [+5s, +10s). Asserting at +9s failed about one run in five for no reason but
# the phase -- and a check that goes red at random on the one assertion proving
# the server keeps asking without a phone is a check people learn to ignore.
print("     waiting 12s for the buzz...")
time.sleep(12)
_, w = call(f"/watch/{bob['user_id']}", token=A)
check("the server asked on its own - a new question is open",
      w["checkin_due_at"] is not None, w)
check("and it scheduled the next one 5-10 minutes out",
      w["next_buzz_at"] and 290 < w["next_buzz_at"] - time.time() < 610,
      w.get("next_buzz_at"))
call("/alert", "POST", {"kind": "checkin_ack"}, B)
st, r = call("/watch/high_alert", "POST", {"on": False}, B)
check("and it can be stood down", st == 200 and r["mode"] == "idle", r)

print("\n== B2: the heartbeat watchdog ==")
st, r = call("/heartbeat", "POST",
             {"mode": "high_alert", "band_link": True, "phone_batt": 71,
              "lat": 24.86, "lon": 67.01}, B)
check("a phone can report in", st == 200, r)
_, w = call(f"/watch/{bob['user_id']}", token=A)
check("the family sees the band link and the battery",
      w["band_link"] is True and w["phone_batt"] == 71 and w["beat_age_s"] < 5, w)

call("/watch/high_alert", "POST", {"on": True, "first_buzz_s": 590}, B)
call("/heartbeat", "POST", {"mode": "high_alert", "band_link": True,
                            "lat": 24.86, "lon": 67.01}, B)
con2 = db()
con2.execute("UPDATE watch_state SET last_beat=%s WHERE user_id=%s",
             (time.time() - 400, bob["user_id"]))
con2.close()
print("     phone has 'gone silent'; waiting 8s...")
time.sleep(8)
_, alerts = call("/alerts?scope=incoming", token=A)
lost = [a for a in alerts if a["kind"] == "watch_lost" and a["user"]["id"] == bob["user_id"]]
check("a phone that goes quiet while armed tells the family", len(lost) == 1, alerts[:2])
check("...with the last position it reported",
      lost and lost[0]["lat"] is not None and lost[0]["maps"], lost[:1])
call("/heartbeat", "POST", {"mode": "high_alert"}, B)
time.sleep(7)
_, alerts = call("/alerts?scope=incoming", token=A)
lost2 = [a for a in alerts if a["kind"] == "watch_lost" and a["user"]["id"] == bob["user_id"]]
check("a phone that comes back does not page again", len(lost2) == 1, f"{len(lost2)}")
call("/watch/high_alert", "POST", {"on": False}, B)

print(f"\n  {PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)
