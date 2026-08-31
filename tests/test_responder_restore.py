"""BUG-008: the answer to an SOS survives the wearer's app being closed.

    python server/nigehban_server.py      # in one terminal
    python tests/test_responder_restore.py

The bug was that `ctx.responders` could only ever be filled by the live socket's
`ack` frame. A family member who answered while the wearer's app was closed was
recorded in the database and then told to nobody: reopening the app said
"waiting for someone to answer" while somebody was already on their way.

So the thing worth testing is the case the socket does NOT cover. The ward never
connects a socket here -- that is the point. Everything is checked through
`GET /alerts?scope=mine`, which is what the app calls on every cold start and
every return to the foreground.

The push notification that now goes out alongside this is deliberately not
asserted: it leaves the process through Expo, and a test that needed a real
device token would fail for reasons that have nothing to do with this contract.
What is checked is the part the phone reads back.
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


def live_alert(token, alert_id):
    """The alert as the app reads it back on reopening."""
    for a in call("/alerts?scope=mine&limit=5", token=token):
        if a["id"] == alert_id:
            return a
    return None


def main():
    tag = int(time.time() * 1000) % 100000
    ward = call("/register", "POST", {"username": f"w{tag}", "password": "pw12", "name": "Ward"})
    kin = call("/register", "POST", {"username": f"k{tag}", "password": "pw12", "name": "Kin"})
    other = call("/register", "POST", {"username": f"o{tag}", "password": "pw12", "name": "Cousin"})

    p = call("/pair", "POST", {}, ward["token"])
    call("/invite", "POST", {"code": p["code"]}, kin["token"])
    p2 = call("/pair", "POST", {}, ward["token"])
    call("/invite", "POST", {"code": p2["code"]}, other["token"])

    print("\nBUG-008 -- an answer given while the app was closed")

    # The ward raises an SOS and then, as far as this test is concerned, their
    # phone is off. No socket is opened for them anywhere below.
    sos = call("/alert", "POST", {"kind": "sos", "source": "app",
                                  "lat": 24.86080, "lon": 67.00110, "accuracy": 12},
               ward["token"])
    alert_id = sos["alert"]["id"]

    check("a fresh alert carries an empty responder list, not a missing one",
          sos["alert"].get("acks") == [], sos["alert"].get("acks"))

    before = live_alert(ward["token"], alert_id)
    check("nobody has answered yet", before is not None and before["acks"] == [], before)

    # ---- the answer nobody was listening for ------------------------------
    call(f"/alert/{alert_id}/ack", "POST", None, kin["token"])

    got = live_alert(ward["token"], alert_id)
    acks = (got or {}).get("acks") or []
    check("the answer survives to the next time the app asks", len(acks) == 1, acks)
    check("...naming who is coming", bool(acks) and acks[0]["name"] == "Kin", acks)
    check("...and when they said so, as epoch seconds the phone can age",
          bool(acks) and isinstance(acks[0]["at"], (int, float))
          and abs(acks[0]["at"] - time.time()) < 120, acks)

    # The app keys its responder list on id, and the SOS screen renders one row
    # per entry. A second tap from the same thumb must not become a second
    # person on the way.
    call(f"/alert/{alert_id}/ack", "POST", None, kin["token"])
    again = (live_alert(ward["token"], alert_id) or {}).get("acks") or []
    check("answering twice is still one person", len(again) == 1, again)

    call(f"/alert/{alert_id}/ack", "POST", None, other["token"])
    both = (live_alert(ward["token"], alert_id) or {}).get("acks") or []
    check("a second family member is a second person", len(both) == 2, both)
    check("...in the order they answered",
          [a["name"] for a in both] == ["Kin", "Cousin"], both)

    # A resolved alert keeps its acks: the wearer's own history should still be
    # able to say who came.
    call(f"/alert/{alert_id}/resolve", "POST", None, ward["token"])
    after = live_alert(ward["token"], alert_id)
    check("standing down does not erase who answered",
          after is not None and len(after["acks"]) == 2, after)

    print(f"\n  {PASS} passed, {FAIL} failed\n")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
