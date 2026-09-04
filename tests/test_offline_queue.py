"""The server half of the offline SOS queue (c40a7e0).

    python server/nigehban_server.py      # in one terminal
    python tests/test_offline_queue.py

The queue itself lives on the phone -- AsyncStorage, a reconnect listener, an
amber banner -- and none of that can run here. But when signal returns,
`flushQueue` in nigehban-app/src/alertQueue.js does exactly one thing the
server can see:

    POST /alert  { kind, source, lat, lon, accuracy, note }

...where lat/lon are Point A, the fix taken when the button was pressed, and
the note has "Current location: <Point B>" appended -- where the phone is now.
The server cannot tell that request apart from a button pressed a second ago,
which is the whole design. So what is checkable without a phone is the
contract: when an alert that has been sitting in a queue finally arrives, is
it handled correctly?

What this file does NOT cover, and what still needs two phones (L2):
  - the AsyncStorage entry surviving a cold start
  - the flush firing on the WebSocket rising edge
  - standing down a queued alert dropping the whole queue rather than one item
  - the "Alert saved on this device" banner and the delivery-state copy

OPEN DESIGN QUESTION, pinned by section 2 below: a queued alert is written with
`created_at = time.time()` at arrival, and AlertIn has no field for when the
button was actually pressed. The phone records `queuedAt` and then throws it
away. So an SOS pressed in a dead zone and delivered twenty minutes later
reaches the family stamped "just now". Her own screen counts from the real
press; theirs does not agree. Fixing that is a schema change (a pressed_at on
AlertIn) and a product decision, not a bug to quietly patch here.
"""
import asyncio
import os
import json
import time
import urllib.error
import urllib.request

import websockets

# Point at a deployed server with NGB, e.g.
#   NGB=https://your-host python tests/test_offline_queue.py
# Nothing here touches the database directly, so a remote run needs no
# credentials -- it only creates throwaway accounts and alerts.
BASE = os.environ.get("NGB", "http://127.0.0.1:8000")
WS = BASE.replace("https://", "wss://").replace("http://", "ws://") + "/ws?token="

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
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.loads(r.read().decode() or "null")


async def wait_for(ws, kind, timeout):
    end = time.time() + timeout
    while time.time() < end:
        try:
            m = json.loads(await asyncio.wait_for(ws.recv(), timeout=max(0.01, end - time.time())))
        except (asyncio.TimeoutError, TimeoutError):
            return None
        if m.get("t") == kind:
            return m
    return None


# She pressed the button here, in a dead zone, and walked while she waited for
# signal. Point A is where the danger was; Point B is where the phone is now.
POINT_A  = (24.86080, 67.00110)
POINT_B  = (24.87400, 67.01500)      # ~1.7 km away
NEAR_A   = (24.86220, 67.00230)      # a stranger ~200 m from where she pressed

# How long the alert sat in the queue before signal came back.
QUEUED_FOR_S = 900


def flushed(kind="sos", lat=POINT_A[0], lon=POINT_A[1], note=None):
    """The exact body flushQueue sends after a spell with no signal."""
    if note is None:
        note = f"Current location: {POINT_B[0]:.5f}, {POINT_B[1]:.5f}"
    body = {"kind": kind, "source": "app", "note": note}
    if lat is not None:
        body.update({"lat": lat, "lon": lon, "accuracy": 12})
    return body


async def main():
    tag = int(time.time() * 1000) % 100000
    ward = call("/register", "POST", {"username": f"q{tag}", "password": "pw12", "name": "Ward"})
    kin = call("/register", "POST", {"username": f"qk{tag}", "password": "pw12", "name": "Kin"})
    near = call("/register", "POST", {"username": f"qn{tag}", "password": "pw12", "name": "Neighbour"})

    p = call("/pair", "POST", {}, ward["token"])
    call("/invite", "POST", {"code": p["code"]}, kin["token"])

    # The stranger is near Point A -- where she pressed, not where she is now.
    call("/presence", "POST", {"lat": NEAR_A[0], "lon": NEAR_A[1]}, near["token"])

    url = WS
    async with websockets.connect(url + ward["token"]) as w, \
               websockets.connect(url + kin["token"]) as k, \
               websockets.connect(url + near["token"]) as n:
        for sock in (w, k, n):
            await wait_for(sock, "ready", 5)

        # ---- 1. a late alert is still an alert ----------------------------
        print("\n== a queued SOS, delivered late ==")
        sent_at = time.time()
        sos = call("/alert", "POST", flushed(), ward["token"])
        alert_id = sos["alert"]["id"]

        got = await wait_for(k, "alert", 8)
        check("a flushed alert reaches the family", bool(got), got)
        check("...at severity 5, like any other SOS",
              bool(got) and got["alert"]["severity"] == 5, got)
        check("...and the server counts the delivery",
              sos.get("delivered_to", 0) >= 1, sos.get("delivered_to"))

        a = got["alert"] if got else {}
        check("the map pin is Point A, where she pressed the button",
              abs(a.get("lat", 0) - POINT_A[0]) < 1e-6
              and abs(a.get("lon", 0) - POINT_A[1]) < 1e-6, a.get("lat"))
        check("...and the note carries Point B, where she is now",
              "Current location:" in (a.get("note") or ""), a.get("note"))
        check("...so the family gets a map link for the danger, not the drift",
              bool(a.get("maps")) and f"{POINT_A[0]:.6f}" in a["maps"], a.get("maps"))

        # ---- 2. what the delay costs -------------------------------------
        # Documenting the current contract, not asserting it is right. See the
        # open design question at the top of this file.
        print("\n== what the queue cannot carry ==")
        drift = abs(a.get("created_at", 0) - sent_at)
        check("a queued alert is stamped when it arrives, not when it was pressed",
              drift < 5, f"created_at is {drift:.1f}s from the POST")
        print(f"     the button was pressed {QUEUED_FOR_S}s before this POST, and")
        print("     nothing in the request could say so -- AlertIn has no field for it.")

        # ---- 3. strangers are still asked, and asked about Point A --------
        print("\n== the Good Samaritan still fires on a flushed alert ==")
        # 'pending' until somebody opts in; without this the checks below pass
        # vacuously, because nothing is ever sent to anybody.
        call(f"/alert/{alert_id}/samaritan-optin", "POST", {"action": "allow"},
             ward["token"])
        asked = await wait_for(n, "samaritan", 8)
        check("a stranger near Point A is asked", bool(asked), asked)
        if asked:
            sa = asked["alert"]
            check("...told no name", "user" not in sa and "name" not in sa, sa)
            check("...given only a coarse pin",
                  abs(sa["lat"] - POINT_A[0]) > 0.0004 or abs(sa["lon"] - POINT_A[1]) > 0.0004,
                  f"{sa['lat']},{sa['lon']}")
            check("...and sent toward where she pressed, not where she is",
                  abs(sa["lat"] - POINT_B[0]) > 0.005, f"{sa['lat']} vs B {POINT_B[0]}")

        call(f"/alert/{alert_id}/resolve", "POST", None, ward["token"])
        mine = call("/alerts?scope=mine", token=ward["token"])
        row = next((x for x in mine if x["id"] == alert_id), None)
        check("a flushed alert can be stood down like any other",
              bool(row) and row["resolved_at"] is not None, row)

        # ---- 4. a queued fall is not a queued SOS -------------------------
        print("\n== severity still decides who is told ==")
        fall = call("/alert", "POST", flushed(kind="fall"), ward["token"])
        call(f"/alert/{fall['alert']['id']}/samaritan-optin", "POST",
             {"action": "allow"}, ward["token"])
        fell = await wait_for(k, "alert", 8)
        check("a flushed fall reaches the family", bool(fell), fell)
        check("...at severity 4", bool(fell) and fell["alert"]["severity"] == 4, fell)
        quiet = await wait_for(n, "samaritan", 3)
        check("...but strangers are not asked about a fall", quiet is None, quiet)

        # ---- 5. no signal often means no GPS either -----------------------
        print("\n== queued in a dead zone with no fix at all ==")
        dead = call("/alert", "POST", flushed(lat=None, note=""), ward["token"])
        call(f"/alert/{dead['alert']['id']}/samaritan-optin", "POST",
             {"action": "allow"}, ward["token"])
        blind = await wait_for(k, "alert", 8)
        check("an alert with no position still reaches the family", bool(blind), blind)
        check("...and says so honestly rather than inventing a pin",
              bool(blind) and blind["alert"]["lat"] is None
              and blind["alert"]["maps"] is None, blind)
        nobody = await wait_for(n, "samaritan", 3)
        check("...and no stranger is sent anywhere", nobody is None, nobody)

    print(f"\n  {PASS} passed, {FAIL} failed\n")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
