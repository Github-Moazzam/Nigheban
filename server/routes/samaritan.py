"""
Good Samaritan: where a stranger is, and their commitment to go.
"""

import time
from contextlib import closing

from fastapi import APIRouter, Depends, HTTPException

from server.db import db
from server.deps import me
from server.geo import geohash
from server.hub import HUB, _spawn
from server.ratelimit import LIMIT
from server.schemas import PresenceIn
from server.services.alerts import acks_for, alert_row, notify_owner_of_ack
from server.services.family import family_of


router = APIRouter()


# ---- B3.3 / B3.4: the Good Samaritan --------------------------------------
@router.post("/presence")
def put_presence(b: PresenceIn, u=Depends(me)):
    """Where you are, rounded, so a stranger's emergency can find you.

    One row per person, overwritten -- this is a presence, not a trail. It is
    stored at about a hundred metres, it is only read while it is fresh, and
    the only thing it is ever used for is deciding who to ask.
    """
    # The app posts this at most every five minutes (PRESENCE_EVERY_MS), but a
    # failed post clears its own throttle and retries on the next fix, so the
    # honest ceiling is well above the happy-path rate.
    LIMIT.check("presence", u["id"], 30, 600,
                "too many presence updates - wait a few minutes")
    lat, lon = round(b.lat, 3), round(b.lon, 3)
    with closing(db()) as c:
        c.execute("INSERT INTO presence (user_id,geohash6,lat,lon,at) VALUES (%s,%s,%s,%s,%s) "
                  "ON CONFLICT(user_id) DO UPDATE SET geohash6=excluded.geohash6, "
                  "lat=excluded.lat, lon=excluded.lon, at=excluded.at",
                  (u["id"], geohash(b.lat, b.lon), lat, lon, time.time()))
        c.commit()
    return {"ok": True, "geohash6": geohash(b.lat, b.lon)}


@router.post("/samaritan/{alert_id}/respond")
async def samaritan_respond(alert_id: int, u=Depends(me)):
    """"I'm going." The only thing that releases a name and an exact pin.

    Committing is the price of the detail, and it is logged with the responder
    against the alert -- so the person in trouble knows exactly who is on the
    way, and so a stranger who wanted the address rather than to help has to
    put their own name to the request.
    """
    # The one limit here that is about disclosure rather than load: this
    # endpoint hands out a name and an exact position, so the ceiling bounds
    # how many alert ids one account can walk. A genuine responder answers one
    # alert; thirty in ten minutes is not a person helping.
    LIMIT.check("samaritan_respond", u["id"], 30, 600,
                "too many responses - wait a few minutes")
    with closing(db()) as c:
        row = c.execute("SELECT * FROM alerts WHERE id=%s", (alert_id,)).fetchone()
        if not row:
            raise HTTPException(404, "no such alert")
        if row["severity"] < 5:
            raise HTTPException(403, "only a severity-5 alert asks for strangers")
        if row["resolved_at"]:
            raise HTTPException(410, "that alert has been stood down")
        at = time.time()
        c.execute("INSERT INTO samaritans VALUES (%s,%s,%s) ON CONFLICT DO NOTHING",
                  (alert_id, u["id"], at))
        first = c.execute(
            "INSERT INTO acks VALUES (%s,%s,%s) ON CONFLICT DO NOTHING"
            " RETURNING alert_id",
            (alert_id, u["id"], at)).fetchone() is not None
        c.commit()
        who = c.execute("SELECT id,name FROM users WHERE id=%s", (row["user_id"],)).fetchone()
        acks = acks_for([alert_id], c).get(alert_id, [])

    payload = alert_row(row, {"id": row["user_id"], "name": who["name"] if who else row["user_id"]},
                        acks)
    responder = {"id": u["id"], "name": u["name"]}
    await HUB.to(row["user_id"], {"t": "ack", "alert_id": alert_id, "at": at,
                                  "by": responder, "samaritan": True})
    await HUB.fanout(family_of(row["user_id"]),
                     {"t": "samaritan_on_way", "alert_id": alert_id, "by": responder})
    if first:
        _spawn(notify_owner_of_ack(row, responder, len(acks), samaritan=True),
               f"ack-push:{alert_id}:{u['id']}")
    return {"ok": True, "alert": payload}
