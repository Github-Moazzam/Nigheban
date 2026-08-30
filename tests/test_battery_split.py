"""Two batteries, two devices — the server half (migrations 002 and 003).

    python server/nigehban_server.py      # in one terminal
    python tests/test_battery_split.py

Migration 002 gave the family two numbers instead of one. It did not give them
two *devices*: in virtual mode the phone runs the band firmware itself, so it
reports `band_link=true` -- correctly, the gestures work -- while there is no
wristband and no second cell behind it. The family screen then drew a band, and
a band battery, and both were the phone.

And because `band_batt` was written with COALESCE, a null never erased it. Link
a real band once, switch back to the phone, and that band's last reading stayed
on a safety screen for the life of the account, looking live.

So the phone now says which kind of band it has, every heartbeat, and this file
holds the server to the three rules that follow:

  1. a real band's two readings arrive apart and stay apart
  2. a virtual beat clears the band's reading rather than preserving it
  3. an OLD build -- no `virtual` field, no `band_batt` -- still must not erase
     a good reading, which is what COALESCE was there for in the first place

Rule 3 is the negative control. Without it rule 2 could pass by the server
simply throwing band_batt away on every beat, which would break every real
band instead.

What this cannot cover, and what needs a phone (L3): that the wearer's own
screens say N/A rather than showing the phone's charge twice, and that a band
below 20% raises `band_battery` and never `low_battery`.
"""
import json
import time
import urllib.request

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


def main():
    tag = int(time.time() * 1000) % 100000
    ward = call("/register", "POST", {"username": f"b{tag}", "password": "pw12", "name": "Ward"})
    kin = call("/register", "POST", {"username": f"bk{tag}", "password": "pw12", "name": "Kin"})

    p = call("/pair", "POST", {}, ward["token"])
    call("/invite", "POST", {"code": p["code"]}, kin["token"])

    def beat(**kw):
        body = {"mode": "high_alert", "band_link": True}
        body.update(kw)
        return call("/heartbeat", "POST", body, ward["token"])

    def seen():
        """What her family is looking at right now."""
        return call(f"/watch/{ward['user_id']}", token=kin["token"])

    # ---- 1. a real band: two numbers, told apart ---------------------------
    print("\n== a real band on the wrist ==")
    beat(virtual=False, phone_batt=88, band_batt=42)
    w = seen()
    check("the phone's battery is the phone's", w.get("phone_batt") == 88, w.get("phone_batt"))
    check("the band's battery is the band's", w.get("band_batt") == 42, w.get("band_batt"))
    check("...and the family is told it is a real band",
          w.get("band_virtual") is False, w.get("band_virtual"))

    # ---- 2. the negative control, run BEFORE the clear ---------------------
    # An older build sends neither field. That must not erase a reading the
    # family is looking at -- which is the entire reason for the COALESCE.
    print("\n== an older build, sending neither field ==")
    beat(phone_batt=71)
    w = seen()
    check("a beat with no band_batt leaves the last one standing",
          w.get("band_batt") == 42, w.get("band_batt"))
    check("...and the phone's own reading still updates",
          w.get("phone_batt") == 71, w.get("phone_batt"))
    check("...and it is still described as a real band",
          w.get("band_virtual") is False, w.get("band_virtual"))

    # ---- 3. she switches to the phone as her band -------------------------
    print("\n== the phone standing in for the band ==")
    beat(virtual=True, phone_batt=64, band_batt=None)
    w = seen()
    check("the family is told the phone is the band",
          w.get("band_virtual") is True, w.get("band_virtual"))
    check("the band's battery is cleared, not kept from the old band",
          w.get("band_batt") is None, w.get("band_batt"))
    check("...while the phone's own battery is reported normally",
          w.get("phone_batt") == 64, w.get("phone_batt"))
    check("...and the link itself is still up: virtual is a working watch",
          w.get("band_link") is True, w.get("band_link"))

    # ---- 4. and back again ------------------------------------------------
    # A band picked up after a spell in virtual mode has to be able to report.
    print("\n== back onto a real band ==")
    beat(virtual=False, phone_batt=60, band_batt=95)
    w = seen()
    check("the band's reading comes back", w.get("band_batt") == 95, w.get("band_batt"))
    check("...and it is a real band again", w.get("band_virtual") is False, w.get("band_virtual"))

    print(f"\n  {PASS} passed, {FAIL} failed\n")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
