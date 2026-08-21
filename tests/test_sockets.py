"""Does the sweeper actually reach a connected phone?

    python tests/test_sockets.py

The REST tests prove the server decided the right thing. This proves it
arrived -- on the live socket, in the shape the app parses.
"""
import asyncio
import json
import time
import urllib.request

import websockets

BASE = "http://127.0.0.1:8000"


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
            m = json.loads(await asyncio.wait_for(ws.recv(), timeout=end - time.time()))
        except asyncio.TimeoutError:
            return None
        if m.get("t") == kind:
            return m
    return None


async def main():
    tag = int(time.time() * 1000) % 100000
    ward = call("/register", "POST", {"username": f"ward{tag}", "password": "pw12", "name": "Ward"})
    kin = call("/register", "POST", {"username": f"kin{tag}", "password": "pw12", "name": "Kin"})
    p = call("/pair", "POST", {}, ward["token"])
    call("/invite", "POST", {"code": p["code"]}, kin["token"])

    ok = 0
    async with websockets.connect(f"ws://127.0.0.1:8000/ws?token={ward['token']}") as w, \
               websockets.connect(f"ws://127.0.0.1:8000/ws?token={kin['token']}") as k:
        await wait_for(w, "ready", 5)
        await wait_for(k, "ready", 5)

        call("/watch/high_alert", "POST", {"on": True, "first_buzz_s": 5}, ward["token"])
        m = await wait_for(w, "buzz_now", 15)
        print(("  PASS" if m else "  FAIL"), "the sweeper buzzes a live phone:", m)
        ok += bool(m)

        # ...and if the phone ignores it, the family hears about it.
        call("/watch/high_alert", "POST", {"on": False}, ward["token"])
        call(f"/checkin/{ward['user_id']}", "POST", {"window": 5}, kin["token"])
        m = await wait_for(w, "checkin_req", 5)
        print(("  PASS" if m else "  FAIL"), "a manual check-in reaches the ward:",
              m and m.get("checkin_id") is not None)
        ok += bool(m and m.get("checkin_id"))

        a = await wait_for(k, "alert", 20)
        good = a and a["alert"]["kind"] == "checkin_missed" and a["alert"]["severity"] == 3
        print(("  PASS" if good else "  FAIL"),
              "silence escalates to the family over the socket:",
              a and a["alert"]["kind"], a and a["alert"]["note"])
        ok += bool(good)

    print(f"\n  {ok}/3 socket checks passed")
    return 0 if ok == 3 else 1


raise SystemExit(asyncio.run(main()))
