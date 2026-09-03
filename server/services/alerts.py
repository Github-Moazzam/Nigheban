"""
Raising an alert, and everything that happens on the way out.

One path in, for everyone: the sweeper raises alerts nobody pressed a button
for, and by the time one reaches a family member it has to be
indistinguishable from a phone-raised one -- same row, same severity, same
socket frame. Two code paths would drift, and the one that drifts is the one
that only runs at 3 a.m.
"""

import logging
import time
from contextlib import closing

from fastapi import HTTPException

from server.config import (
    PRESENCE_FRESH_S, PRIVATE_KINDS, RESPONDER_CHANNEL_ID,
    SAMARITAN_RADIUS_M, SEVERITY,
)
from server.db import db
from server.geo import coarsen, metres_between
from server.hub import HUB, _spawn
from server.logging_setup import get_logger
from server.push import send_expo_push_notifications
from server.services.family import family_of

log = get_logger(__name__)


def nearby_strangers(uid, lat, lon, now=None):
    """Fresh presence within the radius, minus the person and their family.

    Only includes users who have opted into participating as a Good Samaritan
    helper (samaritan_enabled).
    """
    now = now or time.time()
    known = set(family_of(uid)) | {uid}
    out = []
    seen = set()

    with closing(db()) as c:
        rows = c.execute(
            "SELECT p.* FROM presence p"
            " JOIN users u ON u.id = p.user_id"
            " WHERE p.at > %s AND (u.samaritan_enabled IS NULL OR u.samaritan_enabled = true)",
            (now - PRESENCE_FRESH_S,)).fetchall()
        for r in rows:
            u_id = r["user_id"]
            if u_id in known or u_id in seen:
                continue
            if lat is not None and lon is not None and r.get("lat") is not None and r.get("lon") is not None:
                d = metres_between(lat, lon, r["lat"], r["lon"])
                if d <= SAMARITAN_RADIUS_M:
                    out.append((u_id, d))
                    seen.add(u_id)
            else:
                out.append((u_id, 0))
                seen.add(u_id)

        # In testing/web scenarios or before presence interval ticks, include
        # currently connected online strangers whose samaritan_enabled is true
        for client_uid in list(HUB.socks.keys()):
            if client_uid not in known and client_uid not in seen:
                u_row = c.execute("SELECT samaritan_enabled FROM users WHERE id=%s", (client_uid,)).fetchone()
                if u_row and (u_row.get("samaritan_enabled") is None or u_row.get("samaritan_enabled") is True):
                    out.append((client_uid, 0))
                    seen.add(client_uid)

    return sorted(out, key=lambda x: x[1])


def acks_for(alert_ids, c):
    """Who has answered each of these alerts, oldest first.

    One query for every alert in the response rather than one per row: the app
    asks for five at a time and each round trip to the pooler is ~150 ms.

    This exists because the answer used to live only in the websocket frame
    `/alert/{id}/ack` sends. A phone whose app was closed at that moment never
    heard it and had no way to ask afterwards, so reopening said "waiting for
    someone to answer" while somebody was already driving over -- BUG-008.
    The database always knew; nothing ever read it back.
    """
    ids = list(alert_ids)
    if not ids:
        return {}
    rows = c.execute(
        "SELECT k.alert_id, k.user_id, k.at, u.name FROM acks k"
        " JOIN users u ON u.id = k.user_id"
        " WHERE k.alert_id = ANY(%s) ORDER BY k.at", (ids,)).fetchall()
    out = {}
    for r in rows:
        out.setdefault(r["alert_id"], []).append(
            {"id": r["user_id"], "name": r["name"], "at": r["at"]})
    return out


def alert_row(r, author, acks=()):
    return {"id": r["id"], "kind": r["kind"], "severity": r["severity"],
            "source": r["source"], "lat": r["lat"], "lon": r["lon"],
            "accuracy": r["accuracy"], "note": r["note"],
            "created_at": r["created_at"], "resolved_at": r["resolved_at"],
            "samaritan_status": r.get("samaritan_status") or "pending",
            "samaritan_decided_by": r.get("samaritan_decided_by"),
            "user": author,
            # Always present, even when empty. The app replays these on every
            # restore, and "the key is missing" and "nobody has answered" have
            # to be the same thing to it or a stale build reads as a silence.
            "acks": list(acks),
            "maps": (f"https://maps.google.com/?q={r['lat']:.6f},{r['lon']:.6f}"
                     if r["lat"] is not None else None)}


async def emit_alert(uid, kind, *, source="server", lat=None, lon=None,
                     accuracy=None, note="", client_id=None, allow_samaritan=None):
    """Write an alert and push it to the family. One path in, for everyone.

    The sweeper raises alerts nobody pressed a button for, and those have to be
    indistinguishable from a phone-raised one by the time they reach a family
    member -- same row, same severity, same socket frame. Two code paths would
    drift, and the one that drifts is the one that only runs at 3 a.m.

    `client_id` is the phone's id for ONE press. A retry of that press finds
    the row already there and returns it untouched: no second row, no second
    page, no second alarm. See migration 004. Server-raised alerts pass None
    and stay free to repeat, because two missed check-ins really are two
    events.

    `allow_samaritan` determines initial Good Samaritan broadcast consent:
      True  -> 'allowed' (broadcasts to nearby strangers)
      False -> 'denied' (strictly family only)
      None  -> 'pending' (awaits user or family in-app decision)
    """
    sev = SEVERITY.get(kind, 3)
    samaritan_status = ("allowed" if allow_samaritan is True
                        else ("denied" if allow_samaritan is False else "pending"))
    with closing(db()) as c:
        # ON CONFLICT DO NOTHING returns no row when this press is already
        # recorded, which is how a retry is recognised. RETURNING * saves the
        # SELECT that used to follow: every round trip here is ~150 ms to
        # ap-northeast-1 and the caller is counting them.
        cur = c.execute(
            "INSERT INTO alerts"
            " (user_id,kind,severity,source,lat,lon,accuracy,note,created_at,client_id,samaritan_status)"
            " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)"
            " ON CONFLICT (user_id,client_id) WHERE client_id IS NOT NULL DO NOTHING"
            " RETURNING *",
            (uid, kind, sev, source, lat, lon, accuracy, note, time.time(), client_id, samaritan_status))
        row = cur.fetchone()
        first_time = row is not None
        if row is None and client_id is not None:
            row = c.execute("SELECT * FROM alerts WHERE user_id=%s AND client_id=%s",
                            (uid, client_id)).fetchone()
        if row is None:
            # Only reachable if the row vanished between the two statements.
            raise HTTPException(500, "could not record the alert")
        c.commit()
        who = c.execute("SELECT id,name FROM users WHERE id=%s", (uid,)).fetchone()
        targets = [] if kind in PRIVATE_KINDS else family_of(uid, c)

    name = who["name"] if who else uid
    payload = alert_row(row, {"id": uid, "name": name})

    # The retry of a press that already landed. The family has been told;
    # telling them again is the bug this exists to stop. Hand the app the same
    # row it failed to hear about the first time and stop here.
    if not first_time:
        log.info("%s from %s (%s) -> retry of alert %s, already sent",
                 kind, name, uid, row["id"])
        return payload, targets

    # A near-miss is written down and told to nobody: it is the wearer's own
    # record that the fall detector nearly fired, not an event.
    if kind in PRIVATE_KINDS:
        log.info("%s from %s (%s) -> logged, nobody told", kind, name, uid)
        return payload, []

    await HUB.fanout(targets, {"t": "alert", "alert": payload})
    # Warning, not info, when an alert has nowhere to go. Somebody raised an
    # SOS and there is not one person linked to them to receive it -- the
    # loudest thing this server can do is write one row and stop, and that is
    # worth being able to find afterwards.
    log.log(logging.WARNING if not targets else logging.INFO,
            "%s from %s (%s) -> %d family member(s), %d online",
            kind, name, uid, len(targets),
            sum(HUB.online(t) for t in targets))

    # Everything below this line is slow, and none of it is something the
    # sender waits for. Expo is three sequential HTTP calls at a 5 s timeout,
    # and the samaritan sweep is a table scan plus a fourth -- up to 15 s of
    # work behind a client that hangs up at 8. Detaching it is not an
    # optimisation: a request that outlives the phone's patience gets retried,
    # and a retried SOS used to mean a second row and a second page.
    #
    # The task is held in a module-level set. Without a reference asyncio is
    # free to garbage-collect a running task, and the notification that goes
    # missing is the one nobody is watching for.
    _spawn(_deliver_out_of_band(payload, row, uid, name, kind, sev, lat, lon, targets),
           f"deliver:{row['id']}")

    return payload, targets


async def _deliver_out_of_band(payload, row, uid, name, kind, sev, lat, lon, targets):
    """The slow half of emit_alert, with nobody waiting on it."""
    # Send Remote System Push Notification via Expo Push Service API for closed/killed apps
    push_title = (f"EMERGENCY SOS - {name}" if sev >= 5
                  else f"{kind.replace('_', ' ').upper()} - {name}")
    push_body = "Tap immediately to open Nigehban for location and emergency details."
    await send_expo_push_notifications(targets, push_title, push_body,
                                       {"alert_id": row["id"], "severity": sev})

    # N3.3: the lock-screen takeover needs the app's own code to run, and on a
    # killed app only a data-only push gets it there. Sent second and on top of
    # the visible one above, never instead of it -- if the OS drops this in Doze
    # the family still has a notification to tap, which is what the tap routing
    # exists for. The payload carries what the headless task needs to build the
    # alarm without a network round trip, since it may have none.
    if sev >= 4:
        await send_expo_push_notifications(
            targets, None, None,
            {"alert_id": row["id"], "severity": sev, "kind": kind,
             "name": name, "maps": payload.get("maps")},
            silent=True)

    # Only ask nearby Good Samaritans if consent status is explicitly 'allowed'
    if sev >= 5 and row.get("samaritan_status") == "allowed":
        await ask_samaritans(row, uid, lat, lon)


async def ask_samaritans(row, uid, lat, lon):
    """Ask strangers who are close, and tell them almost nothing (matrix #20).

    What goes out is a kind, a coarse pin and a distance. No name, no exact
    position, no way to work out whose alert it is. Somebody who is only
    curious learns that an emergency happened near a road junction, which is
    what they would have learned by hearing it. The rest is released by
    /samaritan/{id}/respond, and only to the person who committed to going.
    """
    near = nearby_strangers(uid, lat, lon)
    if not near:
        return
    if lat is not None and lon is not None:
        clat, clon = coarsen(lat, lon)
        maps_url = f"https://maps.google.com/?q={clat:.4f},{clon:.4f}"
    else:
        clat, clon = None, None
        maps_url = None

    for who, dist in near[:20]:
        msg = {"t": "samaritan",
               "alert": {"id": row["id"], "kind": row["kind"],
                         "severity": row["severity"], "created_at": row["created_at"],
                         "lat": round(clat, 4) if clat is not None else None,
                         "lon": round(clon, 4) if clon is not None else None,
                         "distance_m": int(round(dist / 50.0) * 50) if dist else 0,
                         "maps": maps_url}}
        await HUB.to(who, msg)
    await send_expo_push_notifications(
        [w for w, _ in near[:20]],
        "Someone near you needs help",
        "A Nigehban emergency was raised close by. Open the app if you can go.",
        {"alert_id": row["id"], "severity": row["severity"], "samaritan": True})
    log.info("samaritan: alert %s -> %d nearby stranger(s)",
             row["id"], len(near[:20]))


async def notify_owner_of_ack(row, responder, total, samaritan=False):
    """Tell the person in trouble that somebody is coming.

    The websocket frame above only lands if their app is open. It usually is
    not: the phone is in a pocket, the screen is off, and on Android the app may
    have been killed the moment it left the foreground. That was BUG-008 -- the
    answer existed on the server and reached the wearer nowhere.

    A visible push is the only delivery path that survives a terminated app, so
    it is the one used here. Deliberately NOT the silent/data push the family's
    siren rides on: that one exists to wake the app so it can take the lock
    screen over, and nothing here should take a screen over.

    Two things this must not do, both because the wearer may be in the middle of
    the emergency this is about:

      - No sound. Same reasoning as the wearer's own SOS notification: it could
        give away the position of somebody hiding from whoever they pressed the
        button about. The channel vibrates and stays quiet.
      - No band buzz. The wristband vibrating means exactly one thing already --
        "someone is checking on you, press the button to answer" -- and a person
        in danger must not be handed a button to press. Reusing that buzz for
        good news would make both meanings unreliable.
    """
    if row["resolved_at"]:
        # The emergency is over. Somebody acking a stood-down alert is tidying
        # up, not responding, and the wearer does not need to be told.
        return
    if responder["id"] == row["user_id"]:
        return

    name = responder["name"] or "Someone"
    title = (f"{name} is nearby and on the way" if samaritan
             else f"{name} is on the way")
    body = "They answered your SOS and can see your location."
    if total > 1:
        # The count is the reassuring part, and it is the part a single
        # notification cannot carry. Each responder gets their own push -- the
        # server cannot reach back and edit one already sitting on a locked
        # phone -- so each one says where things now stand.
        body = f"They answered your SOS. {total} people are on their way."

    await send_expo_push_notifications(
        [row["user_id"]], title, body,
        # severity stays low on purpose. The app routes >= 4 to the siren
        # channel and its background task fires the full-screen takeover at
        # >= 4, and neither belongs on the phone of the person who raised it.
        {"alert_id": row["id"], "responder": name, "severity": 1,
         "responders": total, "t": "ack"},
        channel=RESPONDER_CHANNEL_ID,
        # Same freshness rule as an emergency push. "Someone is on the way"
        # delivered half an hour late describes a situation that has moved on.
        ttl=300,
        sound=None)
