"""
Raising, acknowledging and standing down an alert.

These are thin on purpose: emit_alert in server/services/alerts.py is the
one path in, and the sweeper uses the same one with no HTTP in front.
"""

import time
from contextlib import closing

from fastapi import APIRouter, Depends, HTTPException

from server.db import db
from server.deps import me
from server.hub import HUB, _spawn
from server.ratelimit import LIMIT
from server.schemas import AlertIn, LocationIn, SamaritanOptIn
from server.services.alerts import (
    acks_for, alert_row, ask_samaritans, emit_alert, notify_owner_of_ack,
    record_fixes, resolve_alert, tracked_alert, tracking_plan,
)
from server.services.checkins import ack_open_checkins
from server.services.family import family_of
from server.services.watch import arm_sos


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
        # An SOS arms the watch, starts the silence clock and starts the
        # five-minute check-ins, and all three are one write -- see arm_sos,
        # which the sweeper's own escalation path calls too so that an SOS
        # nobody pressed lands in exactly the same state as one somebody did.
        with closing(db()) as c:
            arm_sos(c, u["id"], time.time())
            c.commit()

    # What the phone should do about location from here. Sent back with the
    # alert rather than compiled into the app, because the cadence is a product
    # decision and a phone in somebody's pocket cannot be redeployed.
    live = (tracking_plan(payload["id"], payload["created_at"])
            if payload["severity"] >= 4 else None)
    return {"alert": payload, "delivered_to": len(targets), "tracking": live}


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
    """The wearer standing their own alert down.

    Thin, deliberately. Everything this used to do inline now lives in
    `resolve_alert`, because a thumb on a button stopped being the only way an
    emergency can end: two answered check-ins end one by themselves, and that
    path has no request behind it. Two implementations of "the emergency is
    over" is one implementation that leaves the watch in `sos` for ever, and it
    would be the one that only runs when nobody is looking.
    """
    # Emergency path: generous. Standing an alert down is the thing that stops
    # four phones sirening, so the ceiling is set to stop a script walking
    # alert ids, not a wearer tapping the button again because the first tap
    # did not look like it worked.
    LIMIT.check("alert_resolve", u["id"], 60, 300,
                "too many stand-downs at once - wait a moment")
    return await resolve_alert(alert_id, u["id"])


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


# ---- live location ------------------------------------------------------


@router.post("/location")
async def report_location(b: LocationIn, u=Depends(me)):
    """Where she is now. The other half of an alert that only ever had a start.

    Not addressed to an alert id, and that is the design rather than a
    shortcut. The phone frequently does not know which emergency it is in: an
    SOS raised by the sweeper out of a missed check-in has an id this handset
    has never seen, and the process most likely to be reporting -- restarted
    headless by the foreground service, with no memory of the last five minutes
    -- knows nothing but its own position. So it sends a fix and the server
    decides what the fix is about. See `tracked_alert`.

    Takes a LIST, because the case worth designing for is not the ten-second
    ping that arrives on time. It is the eight minutes of them buffered under a
    flyover that all arrive together the moment there is signal -- and sending
    those one at a time would be nine round trips from a phone whose battery
    and signal are both already the thing at stake.

    Answers 200 with `tracking: null` when there is nothing to attach a fix to.
    That is the ordinary shape of a phone reporting a moment after a stand-down
    it has not heard about yet, and it is the server telling it to stop, not an
    error to retry.
    """
    # Sized for the fast cadence with room for a flush: ten seconds apart is
    # six a minute, a batch counts once, and the ceiling is here to stop a
    # wedged client hammering the table rather than to ration an emergency.
    LIMIT.check("location", u["id"], 120, 300,
                "too many position reports - wait a moment")
    pts = ([p.model_dump() for p in b.points] if b.points
           else ([{"lat": b.lat, "lon": b.lon, "accuracy": b.accuracy, "at": b.at}]
                 if b.lat is not None and b.lon is not None else []))
    # A cap, so one bad client cannot post a day of history in a single body.
    # The newest are the ones worth keeping if anything has to go.
    r = await record_fixes(u["id"], pts[-200:], name=u["name"]) if pts else None

    if r is None:
        # Either there were no usable fixes, or there is nothing to attach them
        # to. Both answer the same question -- what should this phone be doing?
        # -- so an empty body is a legitimate way to ask it, and the app uses
        # exactly that to recover after being killed: the plan on disk went
        # with the process, and this is how it gets a new one without the app
        # having to know the product's own cadence policy.
        with closing(db()) as c:
            row = tracked_alert(c, u["id"])
        if not row:
            return {"ok": True, "accepted": 0, "tracking": None}
        plan = tracking_plan(row["id"], row["created_at"])
        plan["until"] = row["track_until"]
        plan["resolved"] = row["resolved_at"] is not None
        return {"ok": True, "accepted": 0, "tracking": plan}

    plan = tracking_plan(r["alert_id"], r["created_at"])
    # The window, restated on every report. It is what stops a phone tracking
    # for ever if the frame that would have told it to stop never arrived --
    # the app is holding a deadline it re-learns six times a minute, rather
    # than one it was handed once and has to remember through a restart.
    plan["until"] = r["track_until"]
    plan["resolved"] = r["resolved"]
    return {"ok": True, "accepted": r["accepted"], "tracking": plan}


@router.get("/alert/{alert_id}/track")
def alert_track(alert_id: int, limit: int = 500, u=Depends(me)):
    """The path behind a live alert, for whoever is allowed to see it.

    `alerts.live_lat/lon` is where she is; this is how she got there, and the
    two answer different questions. A single moving pin says "she is at the
    canal bridge"; the trail behind it says she has been walking north for four
    minutes at a steady pace, which is the difference between a family member
    driving to a place and driving to meet someone.

    Same audience as the alert itself: the person it is about, and their
    family. A Good Samaritan who answered gets the coarse pin the fan-out gave
    them and no history -- being close enough to help is not being close enough
    to learn where somebody has been.
    """
    limit = max(1, min(limit, 2000))
    with closing(db()) as c:
        row = c.execute("SELECT * FROM alerts WHERE id=%s", (alert_id,)).fetchone()
        if not row:
            raise HTTPException(404, "no such alert")
        if u["id"] != row["user_id"] and u["id"] not in set(family_of(row["user_id"], c)):
            raise HTTPException(403, "not authorised to see this alert")
        # Newest first out of the database so the cap keeps the RECENT end of a
        # long walk, then flipped, because a path is drawn oldest to newest.
        pts = c.execute(
            "SELECT at,lat,lon,accuracy FROM alert_track WHERE alert_id=%s"
            " ORDER BY at DESC LIMIT %s", (alert_id, limit)).fetchall()
    return {"alert_id": alert_id,
            "track_until": row["track_until"],
            "resolved_at": row["resolved_at"],
            "points": [dict(p) for p in reversed(pts)]}


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
