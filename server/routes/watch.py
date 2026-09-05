"""
High Alert, the heartbeat, and what a family member is shown about it.
"""

import time
from contextlib import closing

from fastapi import APIRouter, Depends, HTTPException

from server import watch_lost as WL
from server.config import BEAT_LOST_S, CHECKIN_EVERY_S
from server.db import db
from server.deps import me
from server.hub import HUB
from server.logging_setup import get_logger
from server.ratelimit import LIMIT
from server.schemas import HeartbeatIn, HighAlertIn
from server.services.checkins import open_checkin
from server.services.family import family_of
from server.services.watch import watch_row


log = get_logger(__name__)

router = APIRouter()


# ---- watch state: High Alert and the heartbeat --------------------------


@router.post("/watch/high_alert")
async def set_high_alert(b: HighAlertIn, u=Depends(me)):
    """Arm or disarm High Alert. The server owns the next buzz.

    This is the endpoint that makes the mode real. Held in the app it would
    die with the app -- which is the exact scenario the mode exists for.
    """
    LIMIT.check("high_alert", u["id"], 40, 300,
                "too many High Alert changes - wait a moment")
    now = time.time()
    with closing(db()) as c:
        row = watch_row(c, u["id"])
        if b.on:
            # Five minutes, flat. It was `random.uniform(300, 600)` -- jitter
            # so a wearer could not learn the rhythm, which is a threat nobody
            # has, and it cost the only number that matters here: how long
            # silence can last before anybody knows about it. At the top of
            # that range a wearer could be taken a second after answering and
            # not be missed for ten minutes. See CHECKIN_EVERY_S.
            first = b.first_buzz_s if b.first_buzz_s is not None else CHECKIN_EVERY_S
            first = max(5, min(float(first), CHECKIN_EVERY_S))
            # Arming starts the silence clock, so it also has to write the
            # witnessed state the watchdog will judge that silence against.
            # `on_arm` inherits the band link only if the last beat is recent
            # enough to still be true -- a phone silent since morning is armed
            # with no witnessed link at all, so going quiet again cannot page
            # anyone about a band that was already gone. See watch_lost.py.
            armed = WL.on_arm(WL.Watch.from_row(row), now=now, beat_lost_s=BEAT_LOST_S)
            # `high_alert` is the armed flag and the sweeper's check-ins run on
            # it. `mode` is only ever the HIGHEST live alert, so arming High
            # Alert during an emergency must not demote a live SOS to something
            # less serious -- see migration 008.
            c.execute("UPDATE watch_state SET high_alert=TRUE, "
                      "mode=CASE WHEN mode='sos' THEN 'sos' ELSE 'high_alert' END, "
                      "next_buzz_at=%s, last_beat=%s, beat_band_link=%s, "
                      "beat_armed=TRUE, lost_notified=FALSE, lost_rearm_at=NULL, "
                      "link_lost_at=NULL WHERE user_id=%s",
                      (now + first, now, armed.beat_band_link, u["id"]))
            nxt = now + first
            after = None
        else:
            # Standing down clears the witnessed armed flag as well as the
            # mode. The phone stops beating the moment it goes idle, so leaving
            # `beat_armed` true would leave the silence watchdog holding a
            # snapshot that says "armed" for a watch its wearer just switched
            # off -- and it would page the family three minutes later.
            #
            # Every CASE below reads the row as it was BEFORE this statement,
            # and they all ask the same question: was High Alert the live
            # alert? If an SOS is running, this switch turns the check-ins off
            # and touches nothing else. Writing mode='idle' flatly here -- as
            # it did -- stood a live emergency down along with the schedule,
            # and took the heartbeat watchdog with it.
            #
            # `next_buzz_at` gets the same CASE as everything else here, and
            # it did not until an SOS started asking its own check-ins.
            #
            # Clearing it flatly was right while the column was High Alert's
            # alone. It is now the schedule for BOTH questions, so switching
            # High Alert off during an emergency used to take the SOS's
            # five-minute check-ins with it -- silently, and for the whole
            # emergency. That is the same class of bug as migration 008: one
            # column answering two questions, and a write for one of them
            # destroying the answer to the other. The wearer loses the only way
            # out of the alert that does not involve finding a button.
            cur = c.execute(
                "UPDATE watch_state SET high_alert=FALSE, "
                "next_buzz_at=CASE WHEN mode='sos' THEN next_buzz_at "
                "                  ELSE NULL END, "
                "mode=CASE WHEN mode='high_alert' THEN 'idle' ELSE mode END, "
                "beat_armed=CASE WHEN mode='high_alert' THEN FALSE "
                "                ELSE beat_armed END, "
                "link_lost_at=CASE WHEN mode='high_alert' THEN NULL "
                "                  ELSE link_lost_at END "
                "WHERE user_id=%s RETURNING mode, next_buzz_at",
                (u["id"],))
            after = cur.fetchone()
            nxt = after["next_buzz_at"] if after else None
        c.commit()
    # The mode as the row now stands, not as this switch would like it to be.
    # Standing High Alert down during an emergency leaves an SOS running, and
    # answering "mode: idle" to that is the app being told the emergency is
    # over -- by the one endpoint that deliberately does not end it.
    mode = "high_alert" if b.on else (after["mode"] if after else "idle")
    log.info("high alert %s for %s", "ON" if b.on else "off", u["name"])
    await HUB.fanout(family_of(u["id"]), {
        "t": "watch_updated",
        "user_id": u["id"],
        "mode": mode,
    })
    return {"ok": True, "mode": mode, "high_alert": bool(b.on), "next_buzz_at": nxt}


@router.post("/heartbeat")
def heartbeat(b: HeartbeatIn, u=Depends(me)):
    """'I am still here.' Every 60 s while armed. Silence is the signal.

    And, since the band-link fix, the other half of that: this is also where a
    *reported* loss arrives. The phone is alive and healthy and telling us
    itself that the band is gone -- which is the disconnect event, as close to
    first-hand as this server ever gets to one. The app fires a beat the
    instant the link changes while armed rather than waiting out the minute,
    so this path sees the drop within a second or two of it happening.

    Seeing it is not reporting it. What a drop starts here is a two-minute
    grace window (`link_lost_at`); the sweeper pages if the band is still gone
    when it runs out, and a later beat saying the band is back cancels the
    whole thing. Bluetooth drops for reasons that are not emergencies, and the
    family hears about none of them.

    Sync rather than async on purpose: this is the highest-frequency endpoint
    in the product, its work is blocking database calls, and it no longer
    awaits anything -- so FastAPI running it in a threadpool keeps every beat
    in the field off the event loop the sweeper and the sockets share.
    """
    now = time.time()
    with closing(db()) as c:
        prev_row = watch_row(c, u["id"])
        # The state as it stood BEFORE this beat is applied. Everything the
        # watch_lost rule needs is read here, while the row still describes the
        # moment before the disconnect -- once the UPDATE below lands, that
        # moment is gone. See server/watch_lost.py.
        prev = WL.Watch.from_row(prev_row)

        # The mode is the server's to hold, not the phone's to declare -- the
        # phone may have been restarted and forgotten. It may only *raise* to
        # sos, never quietly stand High Alert down.
        #
        # Worked out before the write because the rule needs both sides of it:
        # `prev.mode` is the pre-disconnect armed state (the one that wins the
        # race, per the rule), and `mode_after` is what the new witnessed
        # snapshot records.
        mode_after = "sos" if b.mode == "sos" else prev.mode

        # `virtual` goes in alongside `band_link` because the two together are
        # the only honest answer to "is there a wristband". In virtual mode the
        # phone runs the firmware itself and reports band_link=true, and a
        # watch_lost raised off that tells a family a band stopped answering
        # when there was never a band. So virtual mode is inert to this rule in
        # both directions -- it never qualifies, and it never counts as the
        # disconnect either, not even on the beat that switches a real band
        # over to it. `nxt.beat_band_link` comes back already meaning the
        # physical link and nothing else.
        decision, nxt = WL.on_heartbeat(prev, band_link=bool(b.band_link),
                                        virtual=bool(b.virtual),
                                        mode_after=mode_after, now=now,
                                        beat_lost_s=BEAT_LOST_S)

        # COALESCE on the batteries for the same reason as the position: an
        # older build sends no band_batt at all, and a null from it must not
        # erase a good reading the family is looking at.
        #
        # Virtual mode is the one case where a null *is* the reading: the phone
        # is the band, there is no second cell, and COALESCE would otherwise
        # keep showing whatever a real band last said -- for as long as the
        # account exists. So that case clears the column outright.
        #
        # `lost_notified` is no longer cleared unconditionally here. It used to
        # be, and that was the flap: a band bouncing in and out of range at the
        # edge of a corridor cleared the latch on every re-link and paged the
        # family again on every re-drop. The rule decides when the latch comes
        # off, and it waits out `lost_rearm_at` first.
        # One transaction around both, because a beat is one fact. If the first
        # write lands and the raise to sos does not, the row says the wearer
        # reported in at `now` while the mode stays whatever it was -- a beat
        # that quietly threw away the emergency it was carrying.
        with c.transaction():
            c.execute("UPDATE watch_state SET last_beat=%s, band_link=%s, band_virtual=%s, "
                      "phone_batt=COALESCE(%s,phone_batt), "
                      "band_batt=CASE WHEN %s THEN NULL ELSE COALESCE(%s,band_batt) END, "
                      "last_lat=COALESCE(%s,last_lat), last_lon=COALESCE(%s,last_lon), "
                      "beat_band_link=%s, beat_armed=%s, "
                      "lost_notified=%s, lost_rearm_at=%s, link_lost_at=%s "
                      "WHERE user_id=%s",
                      (now, bool(b.band_link), bool(b.virtual),
                       b.phone_batt, bool(b.virtual), b.band_batt,
                       b.lat, b.lon,
                       nxt.beat_band_link, nxt.beat_armed,
                       nxt.lost_notified, nxt.lost_rearm_at, nxt.link_lost_at,
                       u["id"]))
            # The raise to sos stays its own statement rather than joining the
            # UPDATE above: `mode` is written by /alert and /alert/{id}/resolve too,
            # and writing back the value read a few lines ago would quietly undo a
            # stand-down that landed in between.
            if b.mode == "sos":
                c.execute("UPDATE watch_state SET mode='sos' WHERE user_id=%s", (u["id"],))

    # No alert is raised from here any more. A drop starts the grace window
    # (`link_lost_at`, written above) and the sweeper pages two minutes later
    # if the band has not come back. The two lines this endpoint can move
    # through are worth seeing in the log, because between them lies every
    # brief Bluetooth drop the family is deliberately not being told about.
    if nxt.link_lost_at is not None and prev.link_lost_at is None:
        log.info("watch_lost %s: %s (%ss)",
                 u["name"], decision.reason, int(WL.WATCH_LOST_DELAY_S))
    elif prev.link_lost_at is not None and nxt.link_lost_at is None:
        log.info("watch_lost %s: %s - nobody paged", u["name"], decision.reason)
    return {"ok": True, "t": now}


@router.get("/watch/{member_id}")
def watch_of(member_id: str, u=Depends(me)):
    """Family-facing health: is her watch actually working right now?

    The honest version of a safety product's home screen. A silent failure --
    app killed, band unpaired, phone flat -- should be visible on an ordinary
    Tuesday, not discovered during an emergency.
    """
    with closing(db()) as c:
        if member_id != u["id"]:
            ok = c.execute("SELECT 1 FROM links WHERE owner_id=%s AND member_id=%s",
                           (member_id, u["id"])).fetchone()
            if not ok:
                raise HTTPException(403, "they are not in your family list")
        w = c.execute("SELECT * FROM watch_state WHERE user_id=%s", (member_id,)).fetchone()
        pend = open_checkin(c, member_id)
        # Who asked, when a person did. On the same connection rather than a
        # second checkout: this endpoint is polled by every family screen.
        asker = None
        if pend and pend["asked_by"]:
            row = c.execute("SELECT name FROM users WHERE id=%s",
                            (pend["asked_by"],)).fetchone()
            asker = row["name"] if row else None

    now = time.time()
    return {
        "user_id": member_id,
        "online": HUB.online(member_id),
        "mode": w["mode"] if w else "idle",
        # Separate from `mode` since migration 008: an SOS raises the mode
        # above it without ending it, so "is High Alert armed" cannot be read
        # off the mode any more.
        "high_alert": bool(w["high_alert"]) if w else False,
        "band_link": bool(w["band_link"]) if w else False,
        # The family screen has to say which device it is looking at. Without
        # this it showed "band connected" for a phone standing in for one.
        "band_virtual": bool(w["band_virtual"]) if w else False,
        "phone_batt": w["phone_batt"] if w else None,
        "band_batt": w["band_batt"] if w else None,
        "last_beat": w["last_beat"] if w else None,
        "beat_age_s": (now - w["last_beat"]) if (w and w["last_beat"]) else None,
        "next_buzz_at": w["next_buzz_at"] if w else None,
        "checkin_due_at": pend["due_at"] if pend else None,
        # The id and the reason, not just the deadline. `checkin_due_at` alone
        # told the family screen a question was open; it did not give the
        # WEARER'S phone enough to answer one, and answering is the whole
        # point. With these two a phone that missed the socket frame -- the
        # app was backgrounded, killed, out of signal -- can pick the question
        # up when it comes back and put it on screen with the deadline that is
        # actually left, rather than the question expiring unasked and the
        # family being told she did not answer.
        "checkin_id": pend["id"] if pend else None,
        "checkin_reason": pend["reason"] if pend else None,
        "checkin_from": ({"id": pend["asked_by"], "name": asker}
                         if pend and pend["asked_by"] and asker else None),
    }
