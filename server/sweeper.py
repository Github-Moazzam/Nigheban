"""
The 5-second tick that makes deadlines true with no phone attached.

This is the half of the server that does not wait to be asked. A check-in runs
out, High Alert comes round again, a heartbeat stops -- and the phone that
should have reported may be dead, off, taken, or killed by an OEM battery
manager, which is precisely the case the product exists for.

sweep_once is factored out so a test can drive one tick directly.
"""

import asyncio
import random
import time
from contextlib import closing

from server import watch_lost as WL
from server.config import (
    BEAT_LOST_S, CHECKIN_WINDOW_S, HIGH_ALERT_MAX_S, HIGH_ALERT_MIN_S,
    INCIDENT_ESCALATION, SWEEP_TICK_S,
)
from server.db import db
from server.hub import HUB
from server.push import send_expo_push_notifications
from server.ratelimit import LIMIT
from server.services.alerts import emit_alert


# ---- the sweeper --------------------------------------------------------
async def sweeper():
    """One task, a five-second tick, and every deadline in the product.

    Ported from `Guardian` in nigehban_hub.py, which ran on the laptop and so
    stopped mattering the moment the laptop closed. Here it is the piece that
    makes the design rule true -- THE PHONE IS AN ACTUATOR, NEVER A TIMEKEEPER.
    A missed check-in escalates with no phone attached to anything. That is the
    honest answer to "what happens if her phone is dead", and it cannot be
    demonstrated by any amount of client code.

    Each branch is guarded by a latch column (`escalated`, `lost_notified`) so
    a condition that stays true pages the family once rather than every tick.
    """
    await asyncio.sleep(1)
    while True:
        try:
            await sweep_once(time.time())
        except asyncio.CancelledError:
            raise
        except Exception as e:
            # A sweeper that dies takes every deadline with it, silently. It
            # logs and keeps ticking instead.
            print(f"  [sweeper] {type(e).__name__}: {e}")
        await asyncio.sleep(SWEEP_TICK_S)


async def sweep_once(now):
    """One tick, factored out so a test can drive it directly."""
    # One connection for all three deadline checks.  Each was a separate pool
    # checkout before, costing three round trips to the pooler every five
    # seconds -- just to learn that nothing happened.
    with closing(db()) as c:
        # 1. missed check-ins -> tell the family
        due = c.execute(
            "SELECT * FROM checkins WHERE acked_at IS NULL AND escalated=FALSE AND due_at<=%s",
            (now,)).fetchall()
        if due:
            c.execute("UPDATE checkins SET escalated=TRUE WHERE id = ANY(%s)",
                      ([r["id"] for r in due],))

        # 2. High Alert: time to ask again?
        #
        # On `high_alert`, not on `mode='high_alert'`. `mode` is the highest
        # live alert and POST /alert overwrites it with 'sos', so this query
        # used to stop matching the moment an emergency was raised -- and never
        # matched again, because nothing puts 'high_alert' back. Arm High
        # Alert, press SOS, and the check-ins ended there for good while the
        # phone went on drawing a countdown to `next_buzz_at`. See migration
        # 008.
        buzz = c.execute(
            "SELECT * FROM watch_state WHERE high_alert=TRUE AND next_buzz_at IS NOT NULL "
            "AND next_buzz_at<=%s", (now,)).fetchall()
        opened = {}
        for w in buzz:
            nxt = now + random.uniform(HIGH_ALERT_MIN_S, HIGH_ALERT_MAX_S)
            c.execute("UPDATE watch_state SET next_buzz_at=%s WHERE user_id=%s",
                      (nxt, w["user_id"]))
            cur = c.execute("INSERT INTO checkins (user_id,asked_by,reason,due_at,created_at)"
                            " VALUES (%s,NULL,'high_alert',%s,%s) RETURNING id",
                            (w["user_id"], now + CHECKIN_WINDOW_S, now))
            opened[w["user_id"]] = (cur.fetchone()["id"], nxt)

        # 3. heartbeat watchdog: armed, WITH A BAND LINK, and then gone quiet
        #
        # The SQL is the cheap filter, not the rule. It narrows the table to
        # rows that could conceivably qualify -- still armed, not already
        # paged, silent past the deadline -- and `WL.on_silence` decides,
        # because the decision is about a transition and SQL over the current
        # row cannot see one.
        #
        # What the SQL alone used to decide, and got wrong twice over:
        #
        #   - `mode != 'idle'` is the mode NOW, and /alert writes it. A silent
        #     idle phone raising an SOS matched instantly and paged the family
        #     about a loss that never happened. `beat_armed` is the mode as it
        #     was at the last beat, and no endpoint can rewrite history into it.
        #   - `band_link` was never consulted at all, so an armed phone with no
        #     band in the room reported its wearer's watch lost. A link that
        #     never existed cannot be lost -- `beat_band_link` is that check.
        candidates = c.execute(
            "SELECT * FROM watch_state WHERE mode!='idle' AND lost_notified=FALSE "
            "AND last_beat IS NOT NULL AND last_beat < %s", (now - BEAT_LOST_S,)).fetchall()
        lost = [r for r in candidates
                if WL.on_silence(WL.Watch.from_row(r), now=now,
                                 beat_lost_s=BEAT_LOST_S).notify]
        if lost:
            # The latch AND the flap window, so a phone that comes back for one
            # beat and goes again does not page a second time.
            c.execute("UPDATE watch_state SET lost_notified=TRUE, lost_rearm_at=%s "
                      "WHERE user_id = ANY(%s)",
                      (now + WL.REARM_S, [r["user_id"] for r in lost]))

        # 4. the grace window: a band that went away and has not come back
        #
        # /heartbeat sees the disconnect and starts the clock; this is where it
        # runs out. Here rather than on the next heartbeat because the tick is
        # five seconds and a heartbeat is sixty -- a two-minute promise kept to
        # within seconds, instead of anything up to a minute late.
        #
        # It also means the countdown does not depend on the phone still
        # beating. If the band goes and then the phone dies too, this still
        # pages at the two-minute mark, and the latch it sets stops branch 3
        # adding a second alert about the same silence a minute later.
        waiting = c.execute(
            "SELECT * FROM watch_state WHERE link_lost_at IS NOT NULL "
            "AND link_lost_at <= %s", (now - WL.WATCH_LOST_DELAY_S,)).fetchall()
        elapsed = [(r, WL.on_grace_elapsed(WL.Watch.from_row(r), now=now,
                                           delay_s=WL.WATCH_LOST_DELAY_S))
                   for r in waiting]
        gone = [r for r, d in elapsed if d.notify]
        # Every row whose window is up stops counting, whether it pages or not.
        # A countdown abandoned because the wearer stood down must not sit in
        # the table being re-evaluated every five seconds for ever.
        if waiting:
            c.execute("UPDATE watch_state SET link_lost_at=NULL WHERE user_id = ANY(%s)",
                      ([r["user_id"] for r in waiting],))
        if gone:
            c.execute("UPDATE watch_state SET lost_notified=TRUE, lost_rearm_at=%s "
                      "WHERE user_id = ANY(%s)",
                      (now + WL.REARM_S, [r["user_id"] for r in gone]))

        if due or buzz or lost or waiting:
            c.commit()

    # Process results after releasing the connection -- emit_alert and HUB.to
    # each need their own, and holding one while awaiting would starve the pool.
    for r in due:
        late = int(now - r["due_at"])

        # What the silence means depends on what was asked. A parent's question
        # going unanswered is `checkin_missed` and always was. A fall or a crash
        # going unanswered is the incident itself -- see INCIDENT_ESCALATION --
        # and it carries the pin captured at the impact rather than nothing at
        # all, because "she is not answering" and "she is not answering, here"
        # are not the same message to send a family at 2 a.m.
        kind = INCIDENT_ESCALATION.get(r["reason"], "checkin_missed")
        if kind == "checkin_missed":
            await emit_alert(r["user_id"], "checkin_missed", source="server",
                             note=f"no answer to a {r['reason']} check-in ({late}s late)")
            continue

        what = ("A fall was detected" if kind == "fall"
                else "A road accident was detected")

        # `.get`, not `[...]`, and this is not defensive habit -- it is the
        # sweeper. Migration 005 adds `lat`, `lon` and `note`, and on a database
        # where it has not been applied yet a KeyError here does not just spoil
        # the wording: it is raised inside the tick, caught by the loop, and
        # EVERY deadline in the product stops passing -- missed check-ins, High
        # Alert, the heartbeat watchdog -- while the server goes on printing one
        # line every five seconds. Degrading to a placeless alert is bad; taking
        # the whole escalation engine down with it is unacceptable.
        #
        # `lat`/`lon` come off the check-in row rather than from watch_state.
        # The phone may have travelled a long way since -- carried in an
        # ambulance, or thrown down the road -- and the place worth sending
        # anyone is where the impact happened.
        lat, lon = r.get("lat"), r.get("lon")
        detail = r.get("note") or ""
        # Only claim a pin when there is one. A fall detected indoors with no
        # fix produces no coordinates, and telling a family "the pin is where it
        # happened" over an empty map is worse than saying nothing -- they go
        # looking at whatever the app last showed them.
        placed = (" The pin is where the impact happened." if lat is not None
                  else " There was no position fix, so this alert has no pin.")
        await emit_alert(
            r["user_id"], kind, source="detector", lat=lat, lon=lon,
            note=(f"{what}, and there was no answer within "
                  f"{int(r['due_at'] - r['created_at'])}s"
                  + (f". {detail}" if detail else ".")
                  + placed
                  + " Try calling; if there is no answer, treat this as real."))

    for w in buzz:
        checkin_id, nxt = opened[w["user_id"]]
        await HUB.to(w["user_id"], {"t": "buzz_now", "reason": "high_alert",
                                    "checkin_id": checkin_id,
                                    "window": CHECKIN_WINDOW_S,
                                    "due_at": now + CHECKIN_WINDOW_S,
                                    "next_buzz_at": nxt})
        # And a push, because the socket is not a delivery guarantee -- it is
        # a delivery *optimisation*. HUB.to writes to whatever sockets happen
        # to be open and drops the frame silently when there are none, which on
        # Android is most of the time: the app is backgrounded, or the OEM
        # killed it, or the phone is on a train.
        #
        # The row is already in the database at this point, so the deadline is
        # real whether or not the wearer ever hears the question. Ninety
        # seconds later the sweeper escalates it and the family is told she did
        # not answer -- a `checkin_missed` for a question that was never put to
        # her. A person's own check-in gets a push (see /checkin/ask); the
        # server's own knock was the one path that did not, and it is the path
        # that runs while nobody is watching.
        await send_expo_push_notifications(
            [w["user_id"]], "Nigehban is checking on you",
            "Tap 'I am fine' to answer.",
            {"checkin_id": checkin_id, "severity": 2, "reason": "high_alert",
             "due_at": now + CHECKIN_WINDOW_S})

    for w in lost:
        silent_s = int(now - w["last_beat"])
        mins = max(1, round(silent_s / 60))
        await emit_alert(w["user_id"], "watch_lost", source="server",
                         lat=w["last_lat"], lon=w["last_lon"],
                         note=(f"Armed, with the band linked, then went quiet "
                               f"{mins} min ago. "
                               "The phone lost signal, was switched off, or the app "
                               "was stopped — Nigehban cannot tell which. "
                               "The pin is where it last reported. "
                               "Try calling; if there is no answer, treat this as real."))

    for r, d in elapsed:
        if not d.notify:
            # Worth a line each: these are the disconnects the family was
            # deliberately not told about, and "why did nobody hear anything"
            # is a question this product has to be able to answer afterwards.
            print(f"  [watch_lost] {r['user_id']}: {d.reason}")
            continue
        away = int(now - r["link_lost_at"])
        # The pin and the wording both come from `link_lost_at`, not from now:
        # the alert is about a moment two minutes in the past, and saying so is
        # the difference between a family looking where she is and a family
        # looking where she was when it started.
        await emit_alert(
            r["user_id"], "watch_lost", source="server",
            lat=r["last_lat"], lon=r["last_lon"],
            note=(f"The band stopped answering {away}s ago, while an alert was "
                  "running, and has not come back. The phone is still reporting, "
                  "so this is the wristband: out of range, switched off, taken "
                  "off, or its battery is flat. The pin is where the phone was. "
                  "Try calling; if there is no answer, treat this as real."))

    LIMIT.sweep()
    return {"missed": len(due), "buzzed": len(buzz),
            "lost": len(lost), "band_gone": len(gone)}
