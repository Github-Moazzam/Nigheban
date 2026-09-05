"""
Raising an alert, and everything that happens on the way out.

One path in, for everyone: the sweeper raises alerts nobody pressed a button
for, and by the time one reaches a family member it has to be
indistinguishable from a phone-raised one -- same row, same severity, same
socket frame. Two code paths would drift, and the one that drifts is the one
that only runs at 3 a.m.
"""

import base64
import hashlib
import hmac
import logging
import os
import time
from contextlib import closing

from fastapi import HTTPException

from server.config import (
    CHECKIN_EVERY_S, LIVE_FIX_FAST_FOR_S, LIVE_FIX_FAST_S, LIVE_FIX_SLOW_S,
    PRESENCE_FRESH_S, PRIVATE_KINDS, RESPONDER_CHANNEL_ID, SAMARITAN_RADIUS_M,
    SEVERITY, SHARE_MAX_S, TRACK_AFTER_STANDDOWN_EVERY_S, TRACK_AFTER_STANDDOWN_S,
)
from server.db import db
from server.geo import coarsen, metres_between
from server.hub import HUB, _spawn
from server.logging_setup import get_logger
from server.push import send_expo_push_notifications
from server.services.family import family_of

log = get_logger(__name__)


# What a push says a kind IS. Without this the shade got the column name with
# its underscore taken out -- "WATCH LOST - Ayesha", which reads as a lost
# gadget rather than as a person who has gone quiet, and "GOING DARK - Ayesha",
# which reads as nothing at all. The words here are the app's own headings, so
# the notification and the screen it opens agree.
PUSH_TITLE = {
    "sos": "{name} needs help",
    "snatch": "{name}'s band was torn off",
    "accident": "Road accident — {name}",
    "fall": "{name} may have fallen",
    "checkin_missed": "{name} did not answer a check-in",
    "watch_lost": "{name}'s watch went quiet while armed",
    "going_dark": "{name}'s phone is about to die",
    "low_battery": "{name}'s phone battery is low",
    "band_battery": "{name}'s band battery is low",
}

# And what to do about it. An emergency gets the urgent wording; the quiet
# kinds get the fact, because "tap immediately" over a low battery is how a
# family learns to ignore the ones that matter.
PUSH_BODY = {
    "checkin_missed": "Open Nigehban to see where they were.",
    "watch_lost": "Their phone stopped reporting. Open Nigehban to see where they were.",
    "going_dark": "Open Nigehban to see where they were.",
    "low_battery": "Open Nigehban for details.",
    "band_battery": "Open Nigehban for details.",
}


def nearby_strangers(uid, lat, lon, now=None):
    """Fresh presence within the radius, minus the person and their family.

    Only includes users who have opted into participating as a Good Samaritan
    helper (samaritan_enabled).

    A measured distance strictly under SAMARITAN_RADIUS_M is the only thing
    that puts anybody in this list. There used to be two ways around that -- a
    presence row with no coordinates was admitted at distance 0, and so was
    every open websocket, which meant the radius check was dead for anyone with
    the app in the foreground. A wearer five kilometres away was asked to walk
    to an emergency the app then described as a hundred metres off. If
    proximity cannot be shown, the person is not asked.
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
            if lat is None or lon is None or r.get("lat") is None or r.get("lon") is None:
                continue
            d = metres_between(lat, lon, r["lat"], r["lon"])
            if d < SAMARITAN_RADIUS_M:
                out.append((u_id, d))
                seen.add(u_id)

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
    # `.get` on everything migration 011 added, for the same reason the
    # sweeper uses it on migration 005's columns: this row may have come off a
    # database where 011 has not been applied, and a KeyError here would take
    # out the alert list, the restore path and the socket frame at once -- for
    # the sake of a pin.
    live_lat, live_lon = r.get("live_lat"), r.get("live_lon")
    # Where the pin goes. The live fix when there is one, the fix the alert was
    # raised with when there is not.
    #
    # These are two different facts and the app is handed both: `lat`/`lon` is
    # where it happened -- the roadside, the doorway, the moment the button
    # went down -- and it must not move, because it is what a family member
    # searches when the trail goes cold. `maps` is where to GO, which during a
    # snatch stops being the same place within a minute. The button on the
    # family's takeover says "SEE WHERE THEY ARE", and until this it opened a
    # map of where they had been.
    pin_lat = live_lat if live_lat is not None else r["lat"]
    pin_lon = live_lon if live_lon is not None else r["lon"]
    return {"id": r["id"], "kind": r["kind"], "severity": r["severity"],
            "source": r["source"], "lat": r["lat"], "lon": r["lon"],
            "accuracy": r["accuracy"], "note": r["note"],
            "created_at": r["created_at"], "resolved_at": r["resolved_at"],
            "samaritan_status": r.get("samaritan_status") or "pending",
            "samaritan_decided_by": r.get("samaritan_decided_by"),
            "user": author,
            # The moving half. `live_at` is the part that decides how the app
            # words it -- a fix from eight seconds ago is "where she is", one
            # from six minutes ago is "last seen", and only the timestamp can
            # tell those apart. Null throughout means nothing has been reported
            # since the alert was raised.
            "live_lat": live_lat, "live_lon": live_lon,
            "live_accuracy": r.get("live_accuracy"), "live_at": r.get("live_at"),
            "track_until": r.get("track_until"),
            # Always present, even when empty. The app replays these on every
            # restore, and "the key is missing" and "nobody has answered" have
            # to be the same thing to it or a stale build reads as a silence.
            "acks": list(acks),
            "maps": (f"https://maps.google.com/?q={pin_lat:.6f},{pin_lon:.6f}"
                     if pin_lat is not None else None),
            # The live page, as a path the app prefixes with its own server
            # URL. `maps` above stays -- it is the fallback for a build that
            # does not know about this yet, and the thing to hand somebody who
            # only wants a pin -- but this is the one that moves.
            "share_path": (share_path(r["id"]) if r["severity"] >= 4 else None),
            "maps_start": (f"https://maps.google.com/?q={r['lat']:.6f},{r['lon']:.6f}"
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
        # The shareable link, registered with the alert rather than on demand.
        # It has to exist before the first push goes out, because the family
        # member who taps that notification is the one who forwards the link --
        # and minting it lazily would mean the first person to ask creates it,
        # which during an emergency is a round trip nobody has time for.
        #
        # GUARDED, and this is the important part. A link is a convenience; the
        # alert is the product. If `alert_share` is missing -- a deploy that
        # restarted before its migration finished, a database rolled back --
        # then an unguarded INSERT here raises, POST /alert answers 500, and
        # pressing SOS does nothing at all. A missing map link would have taken
        # the emergency down with it. So it is attempted, and its failure costs
        # exactly the link: the alert is still written, the family are still
        # sirened, and `share_path` comes back null so the app falls through to
        # the static pin it used before any of this existed.
        if sev >= 4:
            try:
                ensure_share(c, row["id"], time.time() + SHARE_MAX_S)
            except Exception as e:
                log.warning("alert %s has no shareable link (%s: %s)"
                            " -- the alert itself is unaffected",
                            row["id"], type(e).__name__, e)
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
    push_title = PUSH_TITLE.get(kind, "{name} — " + kind.replace("_", " ")).format(name=name)
    push_body = PUSH_BODY.get(
        kind, "Tap immediately to open Nigehban for location and emergency details.")
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
                         "distance_m": int(round(dist / 50.0) * 50) if dist is not None else None,
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


async def resolve_alert(alert_id, uid, *, auto=False, note=""):
    """Stand an alert down. One path out, for the same reason there is one in.

    Until now this lived inside POST /alert/{id}/resolve, which was fine while
    a thumb on a button was the only way an emergency could end. It is not any
    more: two answered check-ins end one by themselves (see SOS_SAFE_STREAK),
    and that path has no request behind it, no `u` to read, and no business
    reimplementing the four writes and the fan-out that standing down actually
    is. Two implementations of "the emergency is over" is one implementation
    that leaves the watch in `sos` for ever, and it would be the one nobody
    watches run.

    Raises HTTPException so the route keeps the wording it always had. The
    automatic path never trips either: it has already read the row.

    `auto` travels all the way to the family's screen. "She stood it down" and
    "she answered twice and it stood itself down" are different facts about
    what a person did, and a family deciding whether to keep driving deserves
    the one that is true.
    """
    now = time.time()
    with closing(db()) as c:
        row = c.execute("SELECT * FROM alerts WHERE id=%s", (alert_id,)).fetchone()
        if not row:
            raise HTTPException(404, "no such alert")
        if row["user_id"] != uid:
            raise HTTPException(403, "only the person who raised it can stand it down")
        if row["resolved_at"]:
            # Already over. Not an error -- a second tap on a button that did
            # work, or the auto path racing the wearer's own thumb -- and doing
            # the fan-out again would tell the family a second time that an
            # emergency they have already stopped worrying about is over.
            #
            # `track_until` still goes back, and that is not tidiness. The
            # caller uses it to decide whether to keep reporting positions, and
            # answering a double tap with nothing would have the second tap
            # stop the walk home that the first tap started.
            return {"ok": True, "already": True,
                    "track_until": row["track_until"]}

        # Tracking outlives the stand-down. `track_until` is only extended for
        # the alerts that were actually being tracked -- an emergency -- and
        # never invented for a low-battery row that nobody was following.
        track_until = (now + TRACK_AFTER_STANDDOWN_S) if row["severity"] >= 4 else None

        # Both writes or neither. Standing down is two facts -- the alert is
        # over, and the watch is no longer in `sos` -- and half of it is a
        # state the product has no name for: an alert marked resolved with the
        # watch still in sos, so the heartbeat watchdog goes on treating a
        # finished emergency as a live one and pages the family about it.
        with c.transaction():
            c.execute("UPDATE alerts SET resolved_at=%s,"
                      " track_until=COALESCE(%s, track_until) WHERE id=%s",
                      (now, track_until, alert_id))
            # The link's clock follows the tracking window down. It was set to
            # the twelve-hour ceiling when the alert was raised; standing down
            # brings it in to half an hour, which is the honest answer to "how
            # long can whoever I sent this to still see me".
            #
            # NOT guarded, unlike the one in emit_alert, and the asymmetry is
            # deliberate. That one is inside a transaction whose other half is
            # "the emergency is over" -- and a stand-down that half-succeeded,
            # leaving the alert resolved while the link keeps working for
            # twelve hours, is the failure this column exists to prevent. If
            # this cannot be written the whole stand-down rolls back and the
            # wearer's phone reports it failed, which is recoverable. Sharing
            # somebody's position for eleven hours longer than they agreed is
            # not.
            if track_until:
                ensure_share(c, alert_id, track_until)
            # It falls back to High Alert rather than to idle when High Alert
            # is still armed. The emergency is over; the standing watch the
            # wearer switched on before it is not, and it was never the SOS's
            # to end. See migration 008.
            #
            # `next_buzz_at` goes with it, and that is new. The SOS was asking
            # its own five-minute check-ins (see arm_sos); leaving that column
            # set would have the sweeper go on asking them about an emergency
            # that is over, and clearing it flatly would leave a still-armed
            # High Alert with no next question -- silently, for ever, which is
            # the exact shape of the bug migration 008 was written for.
            c.execute("UPDATE watch_state SET "
                      "mode=CASE WHEN high_alert THEN 'high_alert' ELSE 'idle' END, "
                      "beat_armed=high_alert, "
                      "next_buzz_at=CASE WHEN high_alert THEN %s ELSE NULL END, "
                      "sos_streak=0, "
                      "link_lost_at=CASE WHEN high_alert THEN link_lost_at ELSE NULL END "
                      "WHERE user_id=%s AND mode='sos'", (now + CHECKIN_EVERY_S, uid))
        who = c.execute("SELECT id,name FROM users WHERE id=%s", (uid,)).fetchone()
        # Only the Good Samaritans who actually answered *this* alert -- not
        # every connected socket on the server. `samaritans` is keyed by
        # (alert_id, user_id), so a stranger who helped on some other alert,
        # or who was never asked about this one, is not in this list even if
        # they are online right now.
        responders = [r["user_id"] for r in c.execute(
            "SELECT user_id FROM samaritans WHERE alert_id=%s", (alert_id,))]

    name = who["name"] if who else uid
    targets = list(set(family_of(uid)) | set(responders))

    await HUB.fanout(targets, {
        "t": "resolved", "alert_id": alert_id,
        "user": {"id": uid, "name": name},
        "auto": bool(auto), "note": note,
        # The family screen keeps following for another half hour. Sent with
        # the stand-down rather than fetched afterwards, because the app that
        # most needs to know is the one that is about to stop listening.
        "track_until": track_until,
        "track_every_s": TRACK_AFTER_STANDDOWN_EVERY_S if track_until else None,
    })

    # The wearer's own phone, on its own frame.
    #
    # Not the family's `resolved` frame, which the app renders as "somebody
    # else is safe" and would show a person a notice about themselves. What
    # this phone needs is the two things only it can do: drop the SOS screen,
    # and take down the sticky "SOS is active" notification it posted -- which
    # is deliberately un-dismissable, so nothing else will ever remove it. An
    # emergency that ended an hour ago still claiming the lock screen is the
    # same lie as a screen showing nothing during a live one.
    #
    # It matters most for the automatic stand-down, where the wearer pressed
    # "I'm fine" at a check-in and never touched a stand-down button at all.
    await HUB.to(uid, {"t": "sos_cleared", "alert_id": alert_id,
                       "auto": bool(auto), "note": note,
                       "track_until": track_until,
                       "track_every_s": (TRACK_AFTER_STANDDOWN_EVERY_S
                                         if track_until else None)})

    # And a push, because the socket only lands on an app that is open and the
    # family member who was sirened awake at 2 a.m. has since put the phone
    # down. Being told an emergency is over is not optional news: without it
    # the last thing that phone ever said about this person is that they were
    # in trouble.
    #
    # Severity 1 and the responder channel: it vibrates, it does not sound, and
    # it stays away from the siren and the lock-screen takeover. Good news must
    # never arrive in the shape of an emergency.
    if row["severity"] >= 3 and targets:
        body = ("They answered two check-ins in a row, so Nigehban stood the alert down."
                if auto else "They stood the alert down themselves.")
        _spawn(send_expo_push_notifications(
            targets, f"{name} is safe", body,
            {"alert_id": alert_id, "severity": 1, "t": "resolved"},
            channel=RESPONDER_CHANNEL_ID, ttl=1800, sound=None),
            f"resolved-push:{alert_id}")

    # The wearer, but only when they did not do this themselves. A stand-down
    # somebody pressed needs no notification telling them they pressed it; one
    # the server decided on their behalf absolutely does, because the phone may
    # have been killed since and the frame above reached nothing.
    if auto:
        _spawn(send_expo_push_notifications(
            [uid], "Your SOS has been stood down",
            "You answered two check-ins, so Nigehban told your family you are safe.",
            {"alert_id": alert_id, "severity": 1, "t": "sos_cleared"},
            channel=RESPONDER_CHANNEL_ID, ttl=1800, sound=None),
            f"sos-cleared-push:{alert_id}")

    log.info("alert %s stood down by %s (%s)", alert_id, name,
             "two answered check-ins" if auto else "the wearer")
    return {"ok": True, "auto": bool(auto), "track_until": track_until}


def tracking_plan(alert_id, started):
    """How often this phone should report its position, and until when.

    Two intervals rather than one. The first twenty minutes of an emergency are
    when help is arriving and a pin that is thirty seconds old is thirty
    seconds of somebody driving to the wrong place; the hour after that is when
    the phone still has to be alive to be reached at all. A tracker that
    flattens the battery has closed every path to the family in order to keep
    one open.
    """
    started = started or time.time()
    return {"alert_id": alert_id,
            "fast_s": LIVE_FIX_FAST_S,
            "fast_until": started + LIVE_FIX_FAST_FOR_S,
            "slow_s": LIVE_FIX_SLOW_S,
            "after_standdown_s": TRACK_AFTER_STANDDOWN_EVERY_S}


def tracked_alert(c, uid, now=None):
    """The emergency this person's positions belong to, or None.

    "Which alert is this fix about" has to be the SERVER's question, not the
    phone's. The phone often does not know the answer: an SOS raised out of a
    missed High Alert check-in has an id the wearer's handset has never seen,
    and the phone that most needs to be reporting -- backgrounded, killed and
    restarted headless by the foreground service -- is exactly the one with no
    memory of what it was doing five minutes ago. So it sends a position and
    the server decides what it is a position for.

    Two alerts qualify, and the second is the one worth spelling out: an alert
    that has been stood down but is still inside its `track_until` window. The
    emergency is over and the journey is not -- see TRACK_AFTER_STANDDOWN_S.
    """
    now = now or time.time()
    return c.execute(
        "SELECT * FROM alerts WHERE user_id=%s AND severity>=4"
        " AND (resolved_at IS NULL"
        "      OR (track_until IS NOT NULL AND track_until > %s))"
        " ORDER BY created_at DESC LIMIT 1", (uid, now)).fetchone()


def _clean(points, now):
    """Drop what cannot be a position. Never raises on one bad point."""
    out = []
    for p in points or []:
        try:
            lat, lon = float(p["lat"]), float(p["lon"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
            continue
        at = p.get("at")
        try:
            at = float(at) if at is not None else now
        except (TypeError, ValueError):
            at = now
        # A fix from the future is a phone with a wrong clock, and trusting it
        # would park a pin at the head of the trail that nothing newer can ever
        # displace. A fix from more than a day ago is a buffer that outlived
        # its emergency.
        if at > now + 300 or at < now - 86400:
            at = now
        acc = p.get("accuracy")
        try:
            acc = float(acc) if acc is not None else None
        except (TypeError, ValueError):
            acc = None
        out.append({"lat": lat, "lon": lon, "at": at, "accuracy": acc})
    return sorted(out, key=lambda p: p["at"])


async def record_fixes(uid, points, name=None):
    """Where she is now. Written to the trail, and pushed to the family live.

    Takes a LIST because the interesting case is not the ten-second ping that
    arrives on time -- it is the eight minutes of them that were buffered under
    a flyover and arrive together the moment there is signal again. Sending
    those one at a time would mean nine round trips from a phone whose battery
    and signal are both the thing at stake, and the family would watch the pin
    crawl through history instead of jumping to where she actually is.

    Returns None when there is nothing to attach the fixes to. That is the
    ordinary case for a phone reporting a moment after a stand-down, and it is
    not an error: the tracking window is the server's to close, and a phone
    that has not noticed yet must not be given a 4xx for it.
    """
    now = time.time()
    pts = _clean(points, now)
    if not pts:
        return None

    with closing(db()) as c:
        row = tracked_alert(c, uid, now)
        if not row:
            return None

        # Anything not newer than what the row already holds is a duplicate or
        # a straggler from a buffer that has already been flushed. It goes in
        # the trail -- the path is a record and gaps in it are worth keeping --
        # but it must not become the live pin, or a late arrival would move the
        # family's map backwards.
        fresh = [p for p in pts if row["live_at"] is None or p["at"] > row["live_at"]]

        with c.transaction():
            # On a cursor, not on the connection: psycopg 3 puts `execute` on
            # both and `executemany` only on the cursor, so the obvious
            # spelling is an AttributeError -- at runtime, inside an emergency,
            # on the one code path that has no request waiting to be told.
            with c.cursor() as cur:
                cur.executemany(
                    "INSERT INTO alert_track (alert_id,at,lat,lon,accuracy)"
                    " VALUES (%s,%s,%s,%s,%s)",
                    [(row["id"], p["at"], p["lat"], p["lon"], p["accuracy"])
                     for p in pts])
            if fresh:
                newest = fresh[-1]
                c.execute("UPDATE alerts SET live_lat=%s, live_lon=%s,"
                          " live_accuracy=%s, live_at=%s WHERE id=%s",
                          (newest["lat"], newest["lon"], newest["accuracy"],
                           newest["at"], row["id"]))
                # The watch's own position too. The family's health screen and
                # a future `watch_lost` both read from here, and during an
                # emergency the ten-second fix is a great deal fresher than the
                # sixty-second heartbeat that normally writes it.
                c.execute("UPDATE watch_state SET last_lat=%s, last_lon=%s"
                          " WHERE user_id=%s", (newest["lat"], newest["lon"], uid))

        if name is None:
            u = c.execute("SELECT name FROM users WHERE id=%s", (uid,)).fetchone()
            name = u["name"] if u else uid
        responders = [r["user_id"] for r in c.execute(
            "SELECT user_id FROM samaritans WHERE alert_id=%s", (row["id"],))]

    # Everything the caller needs to answer the phone, carried out of the one
    # connection this function opens. The route used to check a second one out
    # of the pool just to re-read the row it had already had in its hand -- six
    # times a minute, per tracked emergency, against a pool of eight. See the
    # comment on DB_POOL_MAX in server/db.py for why that is not a small thing.
    about = {"alert_id": row["id"], "accepted": len(pts),
             "created_at": row["created_at"], "track_until": row["track_until"],
             "resolved": row["resolved_at"] is not None}

    if not fresh:
        return {**about, "live": False}

    newest = fresh[-1]
    # The wearer's own phone is in this list, and it is the sender.
    #
    # Echoing a fix back to the handset that just posted it looks like waste
    # and is the only honest way to draw its own screen. "Live location on" has
    # to mean "the server has my position", and the sending phone cannot know
    # that from the inside -- a request that was written to a socket and never
    # arrived looks identical to one that did. Without this the wearer's SOS
    # screen would show a confident green "Live" through an entire dead zone,
    # which is the one lie this screen must never tell.
    targets = list(set(family_of(uid)) | set(responders) | {uid})
    # No push. This is the one frame in the product that fires every ten
    # seconds, and a push per fix would be three hundred notifications an hour
    # to four phones -- which is not a busier version of the alert, it is the
    # end of anyone reading any of them. The emergency itself has already been
    # pushed, with its siren and its takeover; this only keeps the map under it
    # honest for whoever is looking at one.
    await HUB.fanout(targets, {
        "t": "live_location", "alert_id": row["id"],
        "user": {"id": uid, "name": name},
        "lat": newest["lat"], "lon": newest["lon"],
        "accuracy": newest["accuracy"], "at": newest["at"],
        "resolved": row["resolved_at"] is not None,
        "maps": f"https://maps.google.com/?q={newest['lat']:.6f},{newest['lon']:.6f}",
    })
    return {**about, "live": True, "at": newest["at"]}


# ---- the shareable live link -------------------------------------------


def _share_key():
    """The key the share tokens are derived from.

    `SHARE_SECRET` if it is set, and DATABASE_URL if it is not. The fallback
    looks like a shortcut and is a deliberate one: it needs no setup, it is
    already secret, it is stable across restarts -- which a random per-process
    key would not be, breaking every link on every deploy -- and HMAC is
    one-way, so a token can never leak anything about it. Rotating the database
    password invalidates outstanding links, which is harmless: none of them
    lives longer than about an hour anyway.
    """
    k = os.environ.get("SHARE_SECRET") or os.environ.get("DATABASE_URL") or ""
    return hashlib.sha256(("nigehban-share:" + k).encode()).digest()


def share_token(alert_id):
    """The token for one alert. Derived, not stored, and the same every time.

    Deriving rather than generating is what lets the database hold only a hash
    while the clear token stays recomputable. That matters for one specific
    reason: a family member opens the app an hour into an emergency and wants
    the link again to send to somebody else. If the token could not be
    recomputed, the only options would be storing a live credential in the
    database or MINTING A NEW ONE -- and a new one silently kills the link they
    already sent to the police.
    """
    mac = hmac.new(_share_key(), f"alert:{alert_id}".encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(mac).decode().rstrip("=")[:32]


def share_path(alert_id):
    """What the app appends to its own server URL. Deliberately not absolute.

    The server does not reliably know its own public address -- it sits behind
    a tunnel in development and a load balancer in production -- and guessing
    it wrong produces a link that looks right and goes nowhere. The app already
    knows which host it is talking to, so it composes the absolute URL and this
    stays honest.
    """
    return f"/t/{share_token(alert_id)}"


def ensure_share(c, alert_id, expires_at):
    """Register the link for this alert. Idempotent, and never rotates.

    ON CONFLICT DO UPDATE on the expiry alone: the token is derived from the
    alert id so it cannot change, and the window moves when a stand-down
    extends tracking. A second call is how the expiry follows `track_until`.
    """
    from server.security import tok_hash
    c.execute(
        "INSERT INTO alert_share (alert_id, token_hash, created_at, expires_at)"
        " VALUES (%s,%s,%s,%s)"
        " ON CONFLICT (alert_id) DO UPDATE SET expires_at=EXCLUDED.expires_at",
        (alert_id, tok_hash(share_token(alert_id)), time.time(), expires_at))


def resolve_share(token, now=None):
    """Token -> the alert it watches, or None if it is dead.

    Dead covers every way a link stops working, and they are all the same
    answer to whoever is holding it: expired, revoked, or the alert deleted.
    A link that has died must not distinguish between those, or it becomes an
    oracle for whether a given emergency ever existed.
    """
    now = now or time.time()
    try:
        row = _share_row(token)
    except Exception as e:
        # A public page, so it fails as "this link has ended" rather than as a
        # stack trace. Somebody standing in a road does not need to know that a
        # migration has not been applied.
        log.warning("share lookup failed (%s: %s)", type(e).__name__, e)
        return None
    if not row or row["revoked_at"]:
        return None
    if row["expires_at"] is not None and now > row["expires_at"]:
        return None
    return row


def _share_row(token):
    from server.security import tok_hash
    with closing(db()) as c:
        return c.execute(
            "SELECT s.*, a.user_id, a.kind, a.created_at AS raised_at,"
            "       a.resolved_at, a.track_until, a.live_lat, a.live_lon,"
            "       a.live_accuracy, a.live_at, a.lat, a.lon, u.name"
            "  FROM alert_share s"
            "  JOIN alerts a ON a.id = s.alert_id"
            "  JOIN users  u ON u.id = a.user_id"
            " WHERE s.token_hash=%s", (tok_hash(token),)).fetchone()


def share_trail(alert_id, limit=300):
    """The path behind the moving pin, oldest first."""
    with closing(db()) as c:
        pts = c.execute(
            "SELECT at,lat,lon FROM alert_track WHERE alert_id=%s"
            " ORDER BY at DESC LIMIT %s", (alert_id, limit)).fetchall()
    return [{"at": p["at"], "lat": p["lat"], "lon": p["lon"]} for p in reversed(pts)]
