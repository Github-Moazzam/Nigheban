"""U3/U4 server support: check-in payloads, private near-misses, Good Samaritan.

    python server/nigehban_server.py      # in one terminal
    python tests/test_samaritan_and_checkin.py

Three promises the UI is built on top of, checked on the live socket because
that is where the app reads them:

  1. A check-in carries the server's deadline and its own id, so the phone can
     render a real countdown and can answer the buzz it was sent (matrix #15).
  2. A cancelled fall is written down and told to nobody.
  3. A stranger near a severity-5 alert is asked, is told nothing that
     identifies anyone, and gets the name and the exact pin only after saying
     they are going (matrix #20).
"""
import asyncio
import json
import time
import urllib.request

import websockets

BASE = "http://127.0.0.1:8000"

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


# Somewhere in Karachi, plus two neighbours: one across the street, one an
# unhelpful five kilometres away.
HERE      = (24.86080, 67.00110)
CLOSE_BY  = (24.86220, 67.00230)      # ~200 m
FAR_AWAY  = (24.90500, 67.05000)      # ~6 km


async def main():
    tag = int(time.time() * 1000) % 100000
    ward = call("/register", "POST", {"username": f"w{tag}", "password": "pw12", "name": "Ward"})
    kin = call("/register", "POST", {"username": f"k{tag}", "password": "pw12", "name": "Kin"})
    near = call("/register", "POST", {"username": f"n{tag}", "password": "pw12", "name": "Neighbour"})
    far = call("/register", "POST", {"username": f"f{tag}", "password": "pw12", "name": "Faraway"})

    p = call("/pair", "POST", {}, ward["token"])
    call("/invite", "POST", {"code": p["code"]}, kin["token"])

    call("/presence", "POST", {"lat": CLOSE_BY[0], "lon": CLOSE_BY[1]}, near["token"])
    call("/presence", "POST", {"lat": FAR_AWAY[0], "lon": FAR_AWAY[1]}, far["token"])

    url = "ws://127.0.0.1:8000/ws?token="
    async with websockets.connect(url + ward["token"]) as w, \
               websockets.connect(url + kin["token"]) as k, \
               websockets.connect(url + near["token"]) as n, \
               websockets.connect(url + far["token"]) as f:
        for sock in (w, k, n, f):
            await wait_for(sock, "ready", 5)

        # ---- 1. a check-in knows its own deadline and its own id ----------
        call(f"/checkin/{ward['user_id']}", "POST", {"window": 90}, kin["token"])
        req = await wait_for(w, "checkin_req", 8)
        check("a check-in request reaches the phone", bool(req))
        check("...carrying the server's deadline",
              bool(req) and isinstance(req.get("due_at"), (int, float)), req)
        check("...and an id the phone can answer",
              bool(req) and bool(req.get("checkin_id")), req)
        if req:
            answered = call(f"/checkin/{req['checkin_id']}/ack", "POST", None, ward["token"])
            check("answering that id closes the question", answered.get("answered", 0) >= 1)

        # ---- 2. a cancelled fall is nobody else's business ----------------
        call("/alert", "POST", {"kind": "near_miss", "source": "band",
                                "note": "peak 3.1g"}, ward["token"])
        leaked = await wait_for(k, "alert", 2)
        check("a near miss is not sent to the family", leaked is None, leaked)
        mine = call("/alerts?scope=mine", token=ward["token"])
        check("...but it is kept for the wearer",
              any(a["kind"] == "near_miss" for a in mine))

        # ---- 3. the Good Samaritan ---------------------------------------
        sos = call("/alert", "POST", {"kind": "sos", "source": "app",
                                      "lat": HERE[0], "lon": HERE[1], "accuracy": 12},
                   ward["token"])
        alert_id = sos["alert"]["id"]

        asked = await wait_for(n, "samaritan", 8)
        check("a stranger nearby is asked", bool(asked))
        if asked:
            a = asked["alert"]
            check("...and is told no name", "user" not in a and "name" not in a, a)
            check("...and only a coarse pin",
                  abs(a["lat"] - HERE[0]) > 0.0004 or abs(a["lon"] - HERE[1]) > 0.0004,
                  f"{a['lat']},{a['lon']} vs {HERE}")
            check("...with a distance they can judge",
                  isinstance(a.get("distance_m"), int) and a["distance_m"] <= 800, a)

        ignored = await wait_for(f, "samaritan", 2)
        check("somebody five kilometres away is not asked", ignored is None, ignored)

        full = call(f"/samaritan/{alert_id}/respond", "POST", None, near["token"])
        got = full["alert"]
        check("saying 'I'm going' releases the name", got["user"]["name"] == "Ward", got)
        check("...and the exact position",
              abs(got["lat"] - HERE[0]) < 1e-6 and abs(got["lon"] - HERE[1]) < 1e-6, got)

        told = await wait_for(w, "ack", 5)
        check("the person in trouble is told who is coming",
              bool(told) and told["by"]["name"] == "Neighbour" and told.get("samaritan"), told)

        onway = await wait_for(k, "samaritan_on_way", 5)
        check("so is their family", bool(onway), onway)

        call(f"/alert/{alert_id}/resolve", "POST", None, ward["token"])
        try:
            call(f"/samaritan/{alert_id}/respond", "POST", None, far["token"])
            check("a stood-down alert stops releasing details", False)
        except urllib.error.HTTPError as e:
            check("a stood-down alert stops releasing details", e.code == 410, e.code)

    print(f"\n  {PASS} passed, {FAIL} failed\n")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
