"""
Raising, acknowledging and standing down an alert.

These are thin on purpose: emit_alert in server/services/alerts.py is the
one path in, and the sweeper uses the same one with no HTTP in front.
"""

import time
from contextlib import closing

from fastapi import APIRouter, Depends, HTTPException

from server import watch_lost as WL
from server.config import BEAT_LOST_S
from server.db import db
from server.deps import me
from server.hub import HUB, _spawn
from server.ratelimit import LIMIT
from server.schemas import AlertIn, SamaritanOptIn
from server.services.alerts import (
    acks_for, alert_row, ask_samaritans, emit_alert, notify_owner_of_ack,
)
from server.services.checkins import ack_open_checkins
from server.services.family import family_of
from server.services.watch import watch_row


router = APIRouter()


# ---- alerts -------------------------------------------------------------


@router.post("/alert")
async def raise_alert(b: AlertIn, u=Depends(me)):
    payload, targets = await emit_alert(
        u["id"], b.kind, source=b.source, lat=b.lat, lon=b.lon,
        accuracy=b.accuracy, note=b.note, client_id=b.client_id,
        allow_samaritan=b.allow_samaritan)

    # "I'm fine" is an answer, not just an event. Without this the ward can
    # press the key, the family can see the acknowledgement, and the sweeper
    # still escalates ninety seconds later because the open question was never
    # closed -- a false alarm the product would have invented for itself.
    if b.kind == "checkin_ack":
        await ack_open_checkins(u["id"])
    if b.kind == "sos":
        with closing(db()) as c:
            row = watch_row(c, u["id"])
            # An SOS arms the watch, and arming starts the silence clock -- so
            # it writes the same witnessed state High Alert does, through the
            # same rule. This is the fix for the case that used to page a
            # family for nothing: mode='sos' written against a `last_beat` from
            # hours ago satisfied the old watchdog's `mode != 'idle' AND
            # last_beat < now - 180` on the very next tick, so a wearer whose
            # phone had been idle and quiet all afternoon pressed SOS and their
            # family got a watch_lost on top of it -- for a link that had ended
            # long before, if it ever existed. `on_arm` moves last_beat to now
            # and refuses to inherit a stale band link, so there is no
            # retroactive transition left to find.
            armed = WL.on_arm(WL.Watch.from_row(row), now=time.time(),
                              beat_lost_s=BEAT_LOST_S)
            c.execute("UPDATE watch_state SET mode='sos', last_beat=%s, "
                      "beat_band_link=%s, beat_armed=TRUE, "
                      "lost_notified=FALSE, lost_rearm_at=NULL, link_lost_at=NULL "
                      "WHERE user_id=%s",
                      (armed.last_beat, armed.beat_band_link, u["id"]))
            c.commit()

    return {"alert": payload, "delivered_to": len(targets)}


@router.post("/alert/{alert_id}/samaritan-optin")
async def samaritan_optin(alert_id: int, b: SamaritanOptIn, u=Depends(me)):
    """Allow or deny broadcasting an active emergency to nearby Good Samaritans.

    Callable by the victim or any of their family members. If the victim has
    explicitly denied it, family members cannot override.
    """
    if b.action not in ("allow", "deny"):
        raise HTTPException(400, "action must be 'allow' or 'deny'")

    with closing(db()) as c:
        row = c.execute("SELECT * FROM alerts WHERE id=%s", (alert_id,)).fetchone()
        if not row:
            raise HTTPException(404, "no such alert")
        if row["resolved_at"]:
            raise HTTPException(410, "that alert has been stood down")

        family = set(family_of(row["user_id"], c))
        if u["id"] != row["user_id"] and u["id"] not in family:
            raise HTTPException(403, "not authorised to manage this alert")

        # If victim explicitly denied, family cannot override
        if row.get("samaritan_status") == "denied" and u["id"] != row["user_id"]:
            raise HTTPException(403, "The person in trouble has chosen Family Only for this emergency.")

        new_status = "allowed" if b.action == "allow" else "denied"
        c.execute("UPDATE alerts SET samaritan_status=%s, samaritan_decided_by=%s WHERE id=%s",
                  (new_status, u["id"], alert_id))
        c.commit()
        targets = [row["user_id"]] + list(family)

    # Broadcast real-time status update to victim and all family members
    decided_by = {"id": u["id"], "name": u["name"]}
    await HUB.fanout(targets, {
        "t": "samaritan_status_update",
        "alert_id": alert_id,
        "samaritan_status": new_status,
        "decided_by": decided_by,
    })

    # If allowed, trigger fan-out to nearby strangers
    if new_status == "allowed" and row["severity"] >= 5:
        _spawn(ask_samaritans(row, row["user_id"], row["lat"], row["lon"]), f"samaritan-optin:{alert_id}")

    return {"ok": True, "alert_id": alert_id, "samaritan_status": new_status, "decided_by": decided_by}




@router.post("/alert/{alert_id}/resolve")
async def resolve(alert_id: int, u=Depends(me)):
    # Emergency path: generous. Standing an alert down is the thing that stops
    # four phones sirening, so the ceiling is set to stop a script walking
    # alert ids, not a wearer tapping the button again because the first tap
    # did not look like it worked.
    LIMIT.check("alert_resolve", u["id"], 60, 300,
                "too many stand-downs at once - wait a moment")
    with closing(db()) as c:
        row = c.execute("SELECT * FROM alerts WHERE id=%s", (alert_id,)).fetchone()
        if not row:
            raise HTTPException(404, "no such alert")
        if row["user_id"] != u["id"]:
            raise HTTPException(403, "only the person who raised it can stand it down")
        # Both writes or neither. Standing down is two facts -- the alert is
        # over, and the watch is no longer in `sos` -- and half of it is a
        # state the product has no name for: an alert marked resolved with the
        # watch still in sos, so the heartbeat watchdog goes on treating a
        # finished emergency as a live one and pages the family about it.
        with c.transaction():
            c.execute("UPDATE alerts SET resolved_at=%s WHERE id=%s", (time.time(), alert_id))
            # Standing down an SOS clears the watch's sos mode too, or the
            # heartbeat watchdog keeps treating a finished emergency as a live one.
            # `beat_armed` goes with it for the same reason as in /watch/high_alert:
            # the phone stops beating when it goes idle, and a witnessed "armed"
            # left behind would have the silence watchdog page the family three
            # minutes after the emergency was stood down.
            #
            # It falls back to High Alert rather than to idle when High Alert is
            # still armed. The emergency is over; the standing watch the wearer
            # switched on before it is not, and it was never the SOS's to end.
            # This is the other half of migration 008 -- with one column those two
            # states could not both be represented, so resolving an SOS silently
            # disarmed a High Alert that nobody had touched.
            c.execute("UPDATE watch_state SET "
                      "mode=CASE WHEN high_alert THEN 'high_alert' ELSE 'idle' END, "
                      "beat_armed=high_alert, "
                      "link_lost_at=CASE WHEN high_alert THEN link_lost_at ELSE NULL END "
                      "WHERE user_id=%s AND mode='sos'", (u["id"],))

    # Tell family members and all active connected Good Samaritans that alert is stood down
    targets = list(set(family_of(u["id"])) | set(HUB.socks.keys()))
    await HUB.fanout(targets,
                     {"t": "resolved", "alert_id": alert_id,
                      "user": {"id": u["id"], "name": u["name"]}})
    return {"ok": True}


@router.post("/alert/{alert_id}/ack")
async def ack(alert_id: int, u=Depends(me)):
    """A family member saying 'I've seen this, I'm on it.'"""
    # Emergency path: generous, for the same reason as resolve. A duplicate ack
    # is already harmless -- the ON CONFLICT below makes the second tap a
    # no-op -- so this ceiling exists only against a script.
    LIMIT.check("alert_ack", u["id"], 60, 300,
                "too many responses at once - wait a moment")
    with closing(db()) as c:
        row = c.execute("SELECT * FROM alerts WHERE id=%s", (alert_id,)).fetchone()
        if not row:
            raise HTTPException(404, "no such alert")
        # RETURNING tells a first ack apart from the same person tapping twice.
        # Without it a double tap sends a second push saying somebody new is
        # coming, which on a safety device is a lie, not a duplicate.
        at = time.time()
        first = c.execute(
            "INSERT INTO acks VALUES (%s,%s,%s) ON CONFLICT DO NOTHING"
            " RETURNING alert_id",
            (alert_id, u["id"], at)).fetchone() is not None
        c.commit()
        total = len(acks_for([alert_id], c).get(alert_id, ()))

    # `at` travels with the frame so the socket and the restore path agree.
    # Without it the app stamped arrival time, and a responder from ten minutes
    # ago redrew as "just now" the moment anything re-rendered.
    await HUB.to(row["user_id"], {"t": "ack", "alert_id": alert_id, "at": at,
                                  "by": {"id": u["id"], "name": u["name"]}})
    # Detached: Expo is a 5 s HTTP call and the family member who just tapped
    # "I'm on it" is holding this request open waiting for it to return.
    if first:
        _spawn(notify_owner_of_ack(row, {"id": u["id"], "name": u["name"]}, total),
               f"ack-push:{alert_id}:{u['id']}")
    return {"ok": True}


@router.get("/alerts")
def list_alerts(scope: str = "incoming", limit: int = 50, u=Depends(me)):
    # Clamped rather than trusted. `?limit=100000000` was a free table scan
    # against a pool of eight connections, and with a statement timeout now in
    # front of it that is a wasted slot rather than a wedged one -- but a
    # wasted slot during an emergency is still one an SOS cannot have.
    #
    # Clamped rather than rejected because there is no caller for whom a 422
    # here is more useful than the newest 200 alerts. The app asks for 50.
    limit = max(1, min(limit, 200))
    with closing(db()) as c:
        if scope == "mine":
            rows = c.execute(
                "SELECT a.*, us.name AS uname FROM alerts a JOIN users us ON us.id=a.user_id "
                "WHERE a.user_id=%s ORDER BY a.created_at DESC LIMIT %s",
                (u["id"], limit)).fetchall()
        else:
            rows = c.execute(
                "SELECT a.*, us.name AS uname FROM alerts a JOIN users us ON us.id=a.user_id "
                "WHERE a.user_id IN (SELECT owner_id FROM links WHERE member_id=%s) "
                "ORDER BY a.created_at DESC LIMIT %s",
                (u["id"], limit)).fetchall()
        # Same connection, one extra round trip for the whole page.
        acks = acks_for([r["id"] for r in rows], c)
    return [alert_row(r, {"id": r["user_id"], "name": r["uname"]},
                      acks.get(r["id"], ()))
            for r in rows]
