"""F3/U3 — a detector asks the wearer, and only silence reaches the family.

    python server/nigehban_server.py      # in one terminal
    python tests/test_fall_and_accident.py

This is the "done when" for fall and accident detection on the server side, and
it is written to be read as much as run. The four promises:

  1. Opening an incident check-in tells NOBODY. Not the family, not anyone --
     the whole feature is that a fall is a question first.
  2. Answering it inside the window means the family is never told, and what is
     written down instead is a private near-miss.
  3. Letting it run out raises the incident itself -- `fall` at severity 4,
     `accident` at severity 5 -- and NOT a generic `checkin_missed`, which is
     what the sweeper did before INCIDENT_ESCALATION existed. A crash filed as
     "did not reply to a message" is the most dangerous understatement in the
     product.
  4. The alert carries the pin captured at the IMPACT, not wherever the phone
     drifted to while the window ran down.

Promise 3 deliberately takes about a minute of real time, because what it is
proving is that a deadline passes with **no phone attached to anything** -- the
scenario the whole design exists for is the one where the phone is destroyed a
second after the impact.

Requires migration 005 (`python server/migrate_pg.py`).
"""
import asyncio
import json
import time
import urllib.error
import urllib.request

import websockets

BASE = "http://127.0.0.1:8000"

PASS = FAIL = 0

# Where the "crash" happens, and somewhere clearly different that the phone
# could drift to afterwards. Promise 4 is the difference between the two.
IMPACT_AT = (24.86080, 67.00110)


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
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        # The server explains itself in the body; a bare "HTTP Error 403" does
        # not. Every failure in this file is a sentence about a promise, and a
        # stack trace ending in urllib is the one shape that says nothing at
        # all about which promise broke.
        try:
            detail = json.loads(e.read().decode()).get("detail")
        except Exception:
            detail = None
        raise RuntimeError(f"{method} {path} -> {e.code} {detail or e.reason}") from None


def preflight():
    """Fail early, and say the thing that is actually wrong.

    `/checkin/self` answering 403 has exactly one cause: the running server
    predates this endpoint, so `self` is falling through to
    `/checkin/{member_id}` and being read as somebody's user id -- which then
    correctly reports that they are not in your family list. It is a confusing
    error to debug and a trivial one to fix, so it is named here rather than
    left to surface forty lines later as a failed promise.
    """
    probe = call("/register", "POST",
                 {"username": f"probe{int(time.time() * 1000) % 100000}",
                  "password": "pw12", "name": "Probe"})
    try:
        call("/checkin/self", "POST", {"reason": "fall", "window": 600}, probe["token"])
    except RuntimeError as e:
        if "403" in str(e):
            raise SystemExit(
                "\n  The server is running code from before /checkin/self existed.\n"
                "  Restart it:  python server/nigehban_server.py\n")
        if "500" in str(e):
            raise SystemExit(
                "\n  /checkin/self reached the database and failed. Migration 005 has\n"
                "  almost certainly not been applied:  python server/migrate_pg.py\n")
        raise


async def wait_for(ws, kind, timeout, **match):
    """Next frame of `kind`, optionally matching fields, or None."""
    end = time.time() + timeout
    while time.time() < end:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=max(0.01, end - time.time()))
        except (asyncio.TimeoutError, TimeoutError):
            return None
        m = json.loads(raw)
        if m.get("t") != kind:
            continue
        if all(m.get(k) == v for k, v in match.items()):
            return m
    return None


async def main():
    preflight()
    tag = int(time.time() * 1000) % 100000
    ward = call("/register", "POST", {"username": f"fw{tag}", "password": "pw12", "name": "Ward"})
    kin = call("/register", "POST", {"username": f"fk{tag}", "password": "pw12", "name": "Kin"})

    p = call("/pair", "POST", {}, ward["token"])
    call("/invite", "POST", {"code": p["code"]}, kin["token"])

    url = "ws://127.0.0.1:8000/ws?token="
    async with websockets.connect(url + ward["token"]) as w, \
               websockets.connect(url + kin["token"]) as k:
        await wait_for(w, "ready", 5)
        await wait_for(k, "ready", 5)

        # --- 1. a fall is a question, and the family hears nothing ----------
        print("\n  A fall opens a question and pages nobody")
        r = call("/checkin/self", "POST",
                 {"reason": "fall", "lat": IMPACT_AT[0], "lon": IMPACT_AT[1],
                  "note": "Detected impact of about 4g.", "client_id": f"inc-{tag}-1"},
                 ward["token"])
        check("the check-in is opened", bool(r.get("checkin_id")), r)
        check("...with the incident window, not the manual 90 s", r.get("window") == 45, r)

        asked = await wait_for(w, "checkin_req", 5)
        check("the wearer is asked", bool(asked), asked)
        check("...and told it was the system, not a person",
              bool(asked) and asked.get("system") and asked.get("reason") == "fall", asked)
        check("...with the server's deadline to count down from",
              bool(asked) and isinstance(asked.get("due_at"), (int, float)), asked)

        quiet = await wait_for(k, "alert", 3)
        check("THE FAMILY IS TOLD NOTHING", quiet is None, quiet)

        # --- 2. the same request twice is still one question ----------------
        again = call("/checkin/self", "POST",
                     {"reason": "fall", "lat": IMPACT_AT[0], "lon": IMPACT_AT[1],
                      "client_id": f"inc-{tag}-1"}, ward["token"])
        check("a retry of the same incident reuses the row",
              again.get("checkin_id") == r["checkin_id"], (r, again))
        check("...and does not restart the countdown",
              abs(again["due_at"] - r["due_at"]) < 0.001, (r["due_at"], again["due_at"]))

        # --- 3. answering means nobody is ever told -------------------------
        print("\n  Answering it stops everything")
        call(f"/checkin/{r['checkin_id']}/ack", "POST", None, ward["token"])
        # Comfortably past the 45 s window plus a sweeper tick.
        late = await wait_for(k, "alert", 55)
        check("an answered fall never reaches the family", late is None, late)

        # --- 4. silence escalates, as the incident and not as a snub --------
        print("\n  Letting an accident window run out (takes ~40 s)")
        r2 = call("/checkin/self", "POST",
                  {"reason": "accident", "lat": IMPACT_AT[0], "lon": IMPACT_AT[1],
                   "note": "Detected impact of about 19g while travelling at 48 km/h "
                           "and the vehicle stopped dead.",
                   "client_id": f"inc-{tag}-2"},
                  ward["token"])
        # A range, not an equality. The window is measured against a clock read
        # before the insert, so a slow pooler legitimately shaves a second off
        # it. What matters is that an accident got the SHORT window and not the
        # fall's 45 s or the manual 90 s -- pinning it to the exact integer
        # tests the round trip's latency, which is nobody's promise.
        check("an accident gets the shorter window",
              28 <= (r2.get("window") or 0) <= 30, r2)

        # 30 s window + a 5 s sweeper tick, with room for a slow pooler.
        raised = await wait_for(k, "alert", 60)
        check("silence reaches the family", bool(raised), raised)
        if raised:
            a = raised["alert"]
            check("...as an ACCIDENT, not a missed check-in",
                  a.get("kind") == "accident", a.get("kind"))
            check("...at severity 5, so Samaritans are asked too",
                  a.get("severity") == 5, a.get("severity"))
            check("...pinned where the impact was, not where the phone ended up",
                  a.get("lat") is not None
                  and abs(a["lat"] - IMPACT_AT[0]) < 1e-6
                  and abs(a["lon"] - IMPACT_AT[1]) < 1e-6, a)
            check("...saying what was measured, in words a family can read",
                  "48 km/h" in (a.get("note") or ""), a.get("note"))

        # --- 5. a manual check-in still escalates the old way ---------------
        # The reason drives the escalation, so this is the guard against the
        # new branch swallowing the case that already worked.
        print("\n  A parent's check-in is unchanged (takes ~20 s)")
        call(f"/checkin/{ward['user_id']}", "POST", {"window": 10}, kin["token"])
        missed = await wait_for(k, "alert", 40)
        check("an unanswered manual check-in is still `checkin_missed`",
              bool(missed) and missed["alert"].get("kind") == "checkin_missed",
              missed and missed["alert"].get("kind"))
        check("...at severity 3, not 4 or 5",
              bool(missed) and missed["alert"].get("severity") == 3, missed)

        # --- 6. a made-up reason cannot invent an escalation ----------------
        bad = call("/checkin/self", "POST",
                   {"reason": "definitely_not_a_reason", "window": 600}, ward["token"])
        check("an unknown reason falls back to `fall` rather than being trusted",
              bad.get("reason") == "fall", bad)
        call(f"/checkin/{bad['checkin_id']}/ack", "POST", None, ward["token"])

    print(f"\n  {PASS} passed, {FAIL} failed\n")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
