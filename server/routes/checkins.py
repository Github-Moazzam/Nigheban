"""
Asking whether somebody is all right, and hearing back.

The deadline is NOT here -- it is the sweeper's, which is the whole point:
the phone asks and answers, the server decides when time is up.
"""

import time
from contextlib import closing
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from server.config import CHECKIN_WINDOW_S, INCIDENT_ESCALATION, INCIDENT_WINDOW_S
from server.db import db
from server.deps import me
from server.hub import HUB
from server.logging_setup import get_logger
from server.push import send_expo_push_notifications
from server.ratelimit import LIMIT
from server.schemas import CheckinIn, SelfCheckinIn
from server.services.checkins import ack_open_checkins


log = get_logger(__name__)

router = APIRouter()


# ---- check-ins: questions with a deadline -------------------------------


@router.post("/checkin/self")
async def open_incident_checkin(b: SelfCheckinIn, u=Depends(me)):
    """A detector fired. Ask the wearer, and tell NOBODY yet.

    This is the endpoint that makes "a fall does not page your family" true.

    The phone could hold this question by itself -- it has a clock and a screen
    -- and for a while it did. The reason it cannot is the same reason the
    sweeper exists at all: the scenarios this feature is FOR are the ones where
    the phone stops being able to do anything a second after the impact. It
    lands in a gutter and the screen breaks. The battery, already at 4%, goes
    flat. An OEM battery manager kills the app because the screen has been off
    for a minute. A rider is thrown one way and the phone the other.

    In every one of those, a local timer means the question is asked, nobody
    answers, and nothing ever happens -- the exact failure the product exists to
    prevent, arrived at silently. Once the deadline is a row in this table, the
    phone can be destroyed in the crash and the family is still told.

    So: this writes the question down, buzzes the wrist through the socket if
    the phone is still there to relay it, and returns. Nothing goes to the
    family from here. The sweeper escalates it, and only if nobody answers.
    """
    reason = b.reason if b.reason in INCIDENT_ESCALATION else "fall"
    # Generous, because throttling this is throttling the detector. The band's
    # own refractory windows are the real rate limit; this only stops a wedged
    # client hammering the table.
    LIMIT.check("checkin_self", u["id"], 30, 300,
                "too many incident check-ins - wait a moment")

    window = b.window if b.window is not None else INCIDENT_WINDOW_S[reason]
    window = max(10, min(int(window), 600))
    now = time.time()

    note = b.note[:400]

    with closing(db()) as c:
        # Idempotent on the phone's incident id -- see migration 005. The
        # RETURNING is empty when the insert was swallowed as a duplicate,
        # which is the retry case and is a success, not an error.
        row = None
        if b.client_id:
            row = c.execute(
                "INSERT INTO checkins (user_id,asked_by,reason,due_at,created_at,"
                " lat,lon,note,client_id) VALUES (%s,NULL,%s,%s,%s,%s,%s,%s,%s)"
                " ON CONFLICT (user_id,client_id) WHERE client_id IS NOT NULL"
                " DO NOTHING RETURNING id,due_at,acked_at",
                (u["id"], reason, now + window, now,
                 b.lat, b.lon, note, b.client_id)).fetchone()
            if row is None:
                # Already open from the first attempt. Hand back that row's
                # deadline, not a fresh one: the countdown the wearer is looking
                # at must not restart every time the network retries.
                row = c.execute(
                    "SELECT id,due_at,acked_at FROM checkins"
                    " WHERE user_id=%s AND client_id=%s",
                    (u["id"], b.client_id)).fetchone()
        else:
            row = c.execute(
                "INSERT INTO checkins (user_id,asked_by,reason,due_at,created_at,"
                " lat,lon,note) VALUES (%s,NULL,%s,%s,%s,%s,%s,%s)"
                " RETURNING id,due_at,acked_at",
                (u["id"], reason, now + window, now,
                 b.lat, b.lon, note)).fetchone()
        c.commit()

    checkin_id, due_at = row["id"], row["due_at"]

    # A retry that arrives after the wearer has already pressed "I'm fine".
    #
    # It happens in exactly the situation this endpoint is written for: the
    # first request timed out in a dead zone, the wearer answered from the wrist
    # in the meantime, and the phone's retry lands afterwards. Falling through
    # would buzz them and re-open a countdown for an incident they have already
    # settled -- the app telling somebody they might be hurt after they said
    # they were not, which is precisely how a person stops trusting it.
    #
    # Nothing to escalate either: the row is acked, so the sweeper will not
    # touch it. Answering the retry honestly is the whole job here.
    if row["acked_at"] is not None:
        return {"ok": True, "checkin_id": checkin_id, "due_at": due_at,
                "reason": reason, "window": 0, "already_answered": True}

    # Down the socket so the app can put the countdown on screen and buzz the
    # band. `system: True` is how the phone tells this apart from a parent
    # asking -- there is no `from` to show, and the wording has to be "we think
    # you fell", not "Ammi is checking on you".
    # `left`, not the window that was asked for. On a retry of a request that
    # already succeeded, some of the window has gone -- and a countdown that
    # restarts at 30 every time the network stutters is a countdown the sweeper
    # is going to end before the screen does.
    # `round`, not `int`. `now` was read before the insert, so on a fresh
    # question this is 29.98 seconds rather than 30 -- and truncating turned a
    # 30-second accident window into a reported 29, which is the app sizing its
    # progress bar off a number the server does not actually mean. Rounding
    # reports the window that was granted, and still shrinks honestly on a
    # retry, where the time really has gone.
    left = max(0, round(due_at - now))
    await HUB.to(u["id"], {"t": "checkin_req", "checkin_id": checkin_id,
                           "window": left, "due_at": due_at,
                           "system": True, "reason": reason, "note": note})

    # And to the OS, because the likeliest state of this app one second after a
    # crash is "not running". A push is the only channel left that can put a
    # full-screen question in front of somebody, and severity 4 is what
    # notifications.js escalates to a heads-up alarm rather than a quiet row.
    # Deliberately NOT paired with the silent data-only push that a severity-4
    # ALERT gets. That one exists to drive the lock-screen takeover in
    # bgNotifications.js, and that task reads `alert_id` and builds a screen
    # that says a FAMILY MEMBER is in trouble. Firing it here would take the
    # wearer's own screen over with somebody else's emergency -- their own,
    # mislabelled -- at the exact moment they need to find one button. The
    # visible push above is already on the DND-bypassing alarm channel, which
    # is the part that has to work.
    await send_expo_push_notifications(
        [u["id"]],
        "Are you okay?" if reason == "fall" else "Was that an accident?",
        "Tap to say you are fine. Your family is told if you do not answer.",
        {"checkin_id": checkin_id, "severity": 4, "reason": reason})

    log.info("%s check-in for %s - %ss to answer", reason, u["name"], left)
    return {"ok": True, "checkin_id": checkin_id, "due_at": due_at,
            "reason": reason, "window": left}


@router.post("/checkin/{member_id}")
async def request_checkin(member_id: str, b: Optional[CheckinIn] = None, u=Depends(me)):
    """A parent asking 'are you okay?'. Only works inside the family."""
    # This one buzzes somebody else's wrist, so the limit is a courtesy bound
    # as much as a load one -- a family member should not be able to make a
    # wristband vibrate on demand all afternoon.
    LIMIT.check("checkin_ask", u["id"], 20, 600,
                "too many check-in requests - wait a few minutes")
    window = max(5, min(int((b.window if b else None) or CHECKIN_WINDOW_S), 3600))
    now = time.time()
    with closing(db()) as c:
        ok = c.execute("SELECT 1 FROM links WHERE owner_id=%s AND member_id=%s",
                       (member_id, u["id"])).fetchone()
        if not ok:
            raise HTTPException(403, "they are not in your family list")
        cur = c.execute(
            "INSERT INTO checkins (user_id,asked_by,reason,due_at,created_at)"
            " VALUES (%s,%s,'manual',%s,%s) RETURNING id",
            (member_id, u["id"], now + window, now))
        checkin_id = cur.fetchone()["id"]
        c.commit()

    # `due_at` is the deadline in the server's own clock. The phone renders a
    # countdown from it and never invents one: a message that arrives late must
    # show the time that is actually left, not a fresh ninety seconds.
    await HUB.to(member_id, {"t": "checkin_req", "checkin_id": checkin_id,
                             "window": window, "due_at": now + window,
                             "from": {"id": u["id"], "name": u["name"]}})

    # Hardware System Push Notification for closed/backgrounded apps
    await send_expo_push_notifications([member_id], f"{u['name']} is checking on you", "Tap 'I am fine' to answer.", {"checkin_id": checkin_id, "severity": 2})

    # `online` is worth returning and worth being honest about: an offline
    # phone does not mean the question evaporates. The deadline is already in
    # the database, and the sweeper will act on it either way.
    return {"ok": True, "checkin_id": checkin_id, "due_at": now + window,
            "online": HUB.online(member_id)}


@router.post("/checkin/{checkin_id}/ack")
async def ack_checkin(checkin_id: int, u=Depends(me)):
    """The band or the app answering. Answers everything outstanding."""
    # Nearly the /heartbeat case: this is someone answering "yes, I'm fine",
    # and a 429 here leaves the check-in open for the sweeper to escalate --
    # the family gets paged because the answer was rate-limited, not because
    # it never came. Set high enough that only a script can reach it.
    LIMIT.check("checkin_ack", u["id"], 60, 300,
                "too many answers at once - wait a moment")
    with closing(db()) as c:
        row = c.execute("SELECT * FROM checkins WHERE id=%s", (checkin_id,)).fetchone()
    if not row or row["user_id"] != u["id"]:
        raise HTTPException(404, "no such check-in")
    n = await ack_open_checkins(u["id"])
    return {"ok": True, "answered": n}
