"""
The 5-second tick that makes deadlines true with no phone attached.

This is the half of the server that does not wait to be asked. A check-in runs
out, High Alert comes round again, a heartbeat stops -- and the phone that
should have reported may be dead, off, taken, or killed by an OEM battery
manager, which is precisely the case the product exists for.

sweep_once is factored out so a test can drive one tick directly.
"""

import asyncio
import time
from contextlib import closing

from server import watch_lost as WL
from server.config import (
    BEAT_LOST_S, CHECKIN_EVERY_S, CHECKIN_WINDOW_S, ESCALATION,
    RESPONDER_CHANNEL_ID, SOS_CHECKIN_EVERY_S, SOS_SAFE_STREAK, SWEEP_TICK_S,
)
from server.db import db
from server.hub import HUB
from server.logging_setup import get_logger
from server.push import send_expo_push_notifications
from server.ratelimit import LIMIT
from server.services.alerts import emit_alert, tracking_plan
from server.services.watch import arm_sos

log = get_logger(__name__)


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
        except Exception:
            # A sweeper that dies takes every deadline with it, silently. It
            # logs and keeps ticking instead.
            #
            # Reaching here is now close to unreachable, and that is the
            # point. Each of the four branches catches its own failure (see
            # sweep_once) and each escalation catches its own (see _guard), so
            # what is left for this handler is the pool itself going away
            # between them. Nothing is latched on that path, so the next tick
            # finds the same rows and tries again.
            log.exception("sweep failed, still ticking")
        await asyncio.sleep(SWEEP_TICK_S)


async def sweep_once(now):
    """One tick, factored out so a test can drive it directly.

    EVERY BRANCH IS ISOLATED, and that is not defensive habit -- it is the one
    invariant this function has to hold. Each branch sets a latch (`escalated`,
    `lost_notified`) and the alert it stands for is sent further down, AFTER
    this connection is handed back. The pool is autocommit, so those latches
    are durable the moment they are written.

    So a branch that raises used to take every other branch's ALERT with it
    while leaving every other branch's LATCH in place: the exception left
    sweep_once entirely, the loop in sweeper() logged a line, and the rows
    could never match their queries again. Nobody was paged late; nobody was
    paged at all. Seen in testing as a `checkin_missed` row sitting at
    `escalated=TRUE` with no alert anywhere and a wearer whose family were
    never told -- exactly the failure the latches exist to make impossible.

    A failure in one branch now costs that branch one tick. The per-item
    `_guard` calls below stay as they are: they cover a single escalation
    failing, this covers the query around it.
    """
    # One connection for all three deadline checks.  Each was a separate pool
    # checkout before, costing three round trips to the pooler every five
    # seconds -- just to learn that nothing happened.
    with closing(db()) as c:
        # 1. missed check-ins -> tell the family
        #
        # `due` is emptied if ANYTHING here fails, and that is the opposite
        # default to the branches below. A failure between the SELECT and the
        # UPDATE means these rows are NOT latched, so escalating them now would
        # page the family and then page them again on the next tick, when the
        # same rows come back. An escalation that happens twice is worse than
        # one that happens five seconds late.
        due = []
        try:
            # CLAIMED, not read-then-marked. One statement, and that is the
            # whole point of it.
            #
            # This was a SELECT followed by an UPDATE, which is correct exactly
            # as long as one sweeper exists. Two of them -- a laptop and the
            # deployed box against the same database, which is the normal state
            # of this project during development -- can both run the SELECT
            # before either runs the UPDATE, and then both escalate the same
            # silence. A family paged twice for one missed check-in is how a
            # family learns to distrust the pages, and docs/AWS_DEPLOYMENT.md
            # §1.1 names it as the reason this server must be a singleton.
            #
            # `FOR UPDATE SKIP LOCKED` makes the claim atomic: each row is
            # handed to exactly one sweeper and the other simply does not see
            # it. That does not make two instances a good idea -- HUB and LIMIT
            # are still per-process -- but it does mean the failure is now a
            # wasted tick rather than a duplicated emergency.
            due = c.execute(
                "UPDATE checkins SET escalated=TRUE WHERE id IN ("
                "  SELECT id FROM checkins"
                "   WHERE acked_at IS NULL AND escalated=FALSE AND due_at<=%s"
                "   FOR UPDATE SKIP LOCKED) RETURNING *", (now,)).fetchall()
        except Exception:
            log.exception(
                "sweep: the missed-check-in branch failed -- nothing is latched,"
                " so the next tick finds the same rows")
            due = []

        # 2. Time to ask again?
        #
        # On `high_alert`, not on `mode='high_alert'`. `mode` is the highest
        # live alert and POST /alert overwrites it with 'sos', so this query
        # used to stop matching the moment an emergency was raised -- and never
        # matched again, because nothing puts 'high_alert' back. Arm High
        # Alert, press SOS, and the check-ins ended there for good while the
        # phone went on drawing a countdown to `next_buzz_at`. See migration
        # 008.
        #
        # `OR mode='sos'` is the other half of that, and it is new. An SOS now
        # asks its own check-ins on the same five-minute rhythm, whether or not
        # High Alert was ever armed -- because the question "are you all right
        # NOW" is worth asking hardest during an emergency, and because two
        # answers to it in a row are what ends one. Before this, an SOS raised
        # from an idle phone asked nothing at all and could only be left by
        # pressing a button.
        try:
            # Claimed the same way, and for the same reason: two sweepers
            # both finding `next_buzz_at` in the past is two check-ins opened
            # for one schedule slot, which is two wrists buzzed and two
            # deadlines to miss. Moving the schedule forward IS the claim, so
            # it has to be the statement that selects the rows.
            #
            # The new deadline is computed in SQL rather than in Python because
            # it differs per row -- an emergency and a standing watch are on
            # their own intervals -- and the claim has to be one statement.
            # RETURNING hands back the updated row, so `next_buzz_at` on it is
            # already the next one; `mode` is untouched and still says which
            # question this is.
            buzz = c.execute(
                "UPDATE watch_state SET next_buzz_at = %s + CASE WHEN mode='sos'"
                "   THEN %s ELSE %s END"
                " WHERE user_id IN ("
                "   SELECT user_id FROM watch_state"
                "    WHERE (high_alert=TRUE OR mode='sos') AND next_buzz_at IS NOT NULL"
                "      AND next_buzz_at<=%s FOR UPDATE SKIP LOCKED)"
                " RETURNING *",
                (now, SOS_CHECKIN_EVERY_S, CHECKIN_EVERY_S, now)).fetchall()
            opened = {}
            for w in buzz:
                # The reason is the mode, and it decides what the silence means.
                # An unanswered `high_alert` becomes an SOS (see ESCALATION); an
                # unanswered `sos` raises nothing, because the family are already
                # being sirened about this person -- it only resets the streak.
                reason = "sos" if w["mode"] == "sos" else "high_alert"
                nxt = w["next_buzz_at"]
                cur = c.execute("INSERT INTO checkins (user_id,asked_by,reason,due_at,created_at)"
                                " VALUES (%s,NULL,%s,%s,%s) RETURNING id",
                                (w["user_id"], reason, now + CHECKIN_WINDOW_S, now))
                opened[w["user_id"]] = (cur.fetchone()["id"], nxt, reason)
        except Exception:
            log.exception(
                "sweep: the check-in schedule branch failed -- every other branch in this"
                " tick still runs")
            buzz, opened = [], {}

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
        try:
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
        except Exception:
            log.exception(
                "sweep: the heartbeat-watchdog branch failed -- every other branch in this"
                " tick still runs")
            lost = []

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
        try:
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
        except Exception:
            log.exception(
                "sweep: the grace-window branch failed -- every other branch in this"
                " tick still runs")
            waiting, elapsed, gone = [], [], []

        if due or buzz or lost or waiting:
            c.commit()

    # Process results after releasing the connection -- emit_alert and HUB.to
    # each need their own, and holding one while awaiting would starve the pool.
    #
    # Everything above this line is already written down and committed:
    # `escalated`, `lost_notified`, a cleared `link_lost_at`. Those latches make
    # a condition that stays true page a family once instead of every five
    # seconds, and they are set BEFORE the alert they stand for goes out.
    #
    # That ordering used to be silently fatal. A pool timeout, a dropped
    # Supabase session, one unusual row -- the exception left the tick, the loop
    # in sweeper() caught it and printed a line, and the latch stayed set. The
    # row could never match its query again, so the family was not told late;
    # they were never told. And because this was one flat run of loops, the
    # first failure abandoned everyone else in the same batch too.
    #
    # So each item is attempted on its own now, and a failure puts its own latch
    # back for the next tick to find. That trades a small chance of paging twice
    # -- if the alert row landed and only the fanout failed -- against the
    # certainty of not paging at all. In a safety product that is not a close
    # call, and a duplicate is a thing a family can see and understand.
    failed = 0

    for r in due:
        ok = await _guard(
            f"checkin {r['id']} ({r['reason']}) for {r['user_id']}",
            ("UPDATE checkins SET escalated=FALSE WHERE id=%s", (r["id"],)),
            _escalate_missed_checkin, r, now)
        failed += not ok

    for w in buzz:
        checkin_id, nxt, reason = opened[w["user_id"]]
        # No latch to put back, and deliberately so. The check-in row is already
        # written, so the deadline is real whether or not this knock is ever
        # heard, and the sweeper escalates it on time either way. Re-running the
        # knock next tick would only move `next_buzz_at` again.
        ok = await _guard(f"{reason} knock for {w['user_id']}", None,
                          _knock, w, checkin_id, nxt, reason, now)
        failed += not ok

    for w in lost:
        ok = await _guard(
            f"watch_lost (phone silent) for {w['user_id']}",
            ("UPDATE watch_state SET lost_notified=FALSE, lost_rearm_at=NULL"
             " WHERE user_id=%s", (w["user_id"],)),
            _page_phone_silent, w, now)
        failed += not ok

    for r, d in elapsed:
        if not d.notify:
            # Worth a line each: these are the disconnects the family was
            # deliberately not told about, and "why did nobody hear anything"
            # is a question this product has to be able to answer afterwards.
            log.info("watch_lost %s: %s", r["user_id"], d.reason)
            continue
        # Both halves go back here, not just the latch. `link_lost_at` was
        # cleared for every row whose window was up, and without it the grace
        # branch cannot find this row again -- nor will the silence branch,
        # because the phone in this case is still beating, which is the entire
        # reason it is a separate branch.
        ok = await _guard(
            f"watch_lost (band gone) for {r['user_id']}",
            ("UPDATE watch_state SET lost_notified=FALSE, lost_rearm_at=NULL,"
             " link_lost_at=%s WHERE user_id=%s",
             (r["link_lost_at"], r["user_id"])),
            _page_band_gone, r, now)
        failed += not ok

    LIMIT.sweep()
    return {"missed": len(due), "buzzed": len(buzz),
            "lost": len(lost), "band_gone": len(gone), "failed": failed}


# ---- one escalation at a time, and what to undo if it does not go ---------


def _unlatch(what, sql, params):
    """Put a latch back, so the next tick retries the alert that never went."""
    try:
        with closing(db()) as c:
            c.execute(sql, params)
            c.commit()
        log.warning("%s: latch released, the next tick will try again", what)
    except Exception as e:
        # The alert failed and so did its undo, which nearly always means the
        # database is unreachable rather than that this row is unusual. There is
        # nowhere left to write the intention down, so say so as loudly as the
        # log allows -- this is the one path where somebody is not told and
        # never will be.
        log.error("%s: FAILED, and its latch could not be released (%s: %s)"
                  " -- this escalation is lost", what, type(e).__name__, e)


async def _guard(what, release, fn, *args):
    """Run one escalation. Never raises; puts its latch back if it fails.

    `release` is the (sql, params) that undoes the latch, or None where there
    is nothing to undo. The arguments are built inside `fn` rather than at the
    call site so that a bad row -- a missing column on an unmigrated database,
    a null where one was not expected -- is caught here as well.
    """
    try:
        await fn(*args)
        return True
    except Exception:
        log.exception("%s: failed", what)
        if release:
            _unlatch(what, *release)
        return False


async def _escalate_missed_checkin(r, now):
    late = int(now - r["due_at"])

    # What the silence means depends on what was asked. A parent's question
    # going unanswered is `checkin_missed` and always was. A fall or a crash
    # going unanswered is the incident itself -- see ESCALATION -- and it
    # carries the pin captured at the impact rather than nothing at all,
    # because "she is not answering" and "she is not answering, here" are not
    # the same message to send a family at 2 a.m.
    kind = ESCALATION.get(r["reason"], "checkin_missed")

    # The question an emergency asked, going unanswered. Nothing is raised.
    #
    # The family already have a live SOS about this exact person sirening on
    # their phones; a `checkin_missed` on top of it is a second, quieter alert
    # saying less about the same thing, arriving while they are driving. What
    # the silence actually costs the wearer is the way out: the run of answers
    # that would have stood the alert down goes back to zero, so the next two
    # have to be consecutive again. That is the whole meaning of a missed one.
    if r["reason"] == "sos":
        with closing(db()) as c:
            c.execute("UPDATE watch_state SET sos_streak=0 WHERE user_id=%s",
                      (r["user_id"],))
            c.commit()
        log.info("%s missed an SOS check-in (%ss late) - safe streak reset",
                 r["user_id"], late)
        return

    # High Alert's question, going unanswered. This is an emergency.
    #
    # It used to be `checkin_missed`: severity 3, no siren, a line in a list.
    # But High Alert is armed on purpose by somebody who decided the next hour
    # needed watching, and its entire contract is "ask me every five minutes,
    # and if I stop answering, something is wrong". The moment that contract
    # comes true is the wrong moment for the quietest alert in the product.
    #
    # The pin is the last position the heartbeat reported, not one from the
    # check-in row -- a High Alert question is not about a place, so it carries
    # none. Sixty seconds old at worst, and from here the live tracker takes
    # over: `arm_sos` puts the watch into `sos`, which is what the phone's
    # location loop and the next five-minute check-in both hang off.
    if kind == "sos":
        with closing(db()) as c:
            w = c.execute("SELECT * FROM watch_state WHERE user_id=%s",
                          (r["user_id"],)).fetchone()
            # Already covered. Raise nothing.
            #
            # The sequence that gets here: High Alert asks, the wearer says
            # nothing and presses SOS instead -- or the band does -- and ninety
            # seconds later the question she never answered runs out. The
            # family are already being sirened about this exact person, and a
            # second severity-5 row would be a second siren, a second takeover
            # and a second Good Samaritan decision for one emergency.
            #
            # The condition is a live ALERT, not `mode='sos'`, and the
            # difference is the whole point of writing it down. `arm_sos` below
            # sets the mode BEFORE emit_alert goes out -- deliberately -- so if
            # the send then fails, _guard puts the `escalated` latch back and
            # the next tick arrives at a row whose mode already says sos. A
            # mode check would look at that and conclude the family had been
            # told, when the truth is that nobody has been and nobody now ever
            # will be. Reading the alerts table instead makes the retry work,
            # because it asks the question that actually matters: does an
            # emergency about this person exist?
            live = c.execute(
                "SELECT id FROM alerts WHERE user_id=%s AND resolved_at IS NULL"
                " AND severity>=5 ORDER BY created_at DESC LIMIT 1",
                (r["user_id"],)).fetchone()
            if live:
                log.info("%s missed a high-alert check-in while alert %s is live"
                         " (%ss late) - already covered",
                         r["user_id"], live["id"], late)
                return
            # Ordered deliberately: the watch goes into `sos` BEFORE the alert
            # goes out. The alert is what wakes four phones, and by the time
            # anybody taps it the row they are looking at has to be one the
            # tracker is already writing positions to. The other order leaves a
            # window -- small, and exactly the width of an Expo round trip --
            # in which the family have a live emergency and the server does not
            # think anybody is in one.
            arm_sos(c, r["user_id"], now)
            c.commit()
        lat = w["last_lat"] if w else None
        lon = w["last_lon"] if w else None
        placed = (" The pin is where their phone last reported." if lat is not None
                  else " There was no position fix, so this alert has no pin.")
        payload, targets = await emit_alert(
            r["user_id"], "sos", source="server", lat=lat, lon=lon,
            # `allow_samaritan=None` -- pending, not allowed. Nobody consented
            # to this: the alert exists BECAUSE the person could not answer,
            # and reading their silence as permission to show their position to
            # strangers is the one inference this product must never make. The
            # wearer or a family member allows it from the app.
            allow_samaritan=None,
            note=("High Alert was on and a check-in went unanswered for "
                  f"{late}s past its deadline." + placed
                  + " Their location updates live from here."
                  " Try calling; if there is no answer, treat this as real."))
        # The wearer's own phone, which has been told nothing so far. It needs
        # this twice over: to put the SOS screen up so one tap can stand down
        # what may well be a false alarm, and to start the location loop that
        # `arm_sos` has just made the server expect.
        #
        # Quiet, on the responder channel, for the same reason the wearer's own
        # SOS notification is: they may be hiding from whoever this is about,
        # and a siren from their own pocket is the last thing that should give
        # them away.
        await HUB.to(r["user_id"], {
            "t": "sos_started", "alert": payload, "reason": "missed_checkin",
            # The same block POST /alert hands back, because this phone has to
            # start reporting its position and has no reply to read it off:
            # nobody made a request. Without it the one emergency where the
            # wearer is least able to help would be the one with no live
            # location -- which is exactly backwards.
            "tracking": tracking_plan(payload["id"], payload["created_at"])})
        await send_expo_push_notifications(
            [r["user_id"]], "Your family has been alerted",
            "You did not answer a check-in. Open Nigehban to stand it down if you are safe.",
            {"alert_id": payload["id"], "severity": 2, "t": "sos_started"},
            channel=RESPONDER_CHANNEL_ID, sound=None)
        log.info("high-alert check-in missed by %s (%ss late) -> SOS, %d family member(s)",
                 r["user_id"], late, len(targets))
        return

    if kind == "checkin_missed":
        await emit_alert(r["user_id"], "checkin_missed", source="server",
                         note=f"no answer to a {r['reason']} check-in ({late}s late)")
        return

    what = ("A fall was detected" if kind == "fall"
            else "A road accident was detected")

    # `.get`, not `[...]`, and this is not defensive habit -- it is the
    # sweeper. Migration 005 adds `lat`, `lon` and `note`, and on a database
    # where it has not been applied yet a KeyError here would stop this
    # escalation dead. _guard catches it and puts the latch back, so the next
    # tick tries again rather than the family never hearing -- but a retry
    # that fails the same way every five seconds is not a fix. Degrading to a
    # placeless alert sends something; raising sends nothing.
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


# What the five-minute knock says, and it is not the same sentence twice.
#
# High Alert's question is routine: nothing has happened, this is the standing
# arrangement, answer it and the arrangement continues. The SOS one is asked
# with the family already alerted and sirens already running, so it has to
# carry the thing the wearer most needs to know and cannot otherwise learn --
# that answering is now the way OUT, and that it takes two.
_KNOCK = {
    "high_alert": ("Nigehban is checking on you",
                   "Tap 'I am fine' to answer."),
    "sos": ("Are you safe now?",
            f"Your SOS is still live. Answer {SOS_SAFE_STREAK} check-ins in a row"
            " and Nigehban stands it down."),
}


async def _knock(w, checkin_id, nxt, reason, now):
    """The five-minute question: buzz the wrist, and push in case it cannot."""
    await HUB.to(w["user_id"], {"t": "buzz_now", "reason": reason,
                                "checkin_id": checkin_id,
                                "window": CHECKIN_WINDOW_S,
                                "due_at": now + CHECKIN_WINDOW_S,
                                "next_buzz_at": nxt,
                                # How close this answer is to ending it. The
                                # wearer's screen counts up to SOS_SAFE_STREAK
                                # rather than making them guess.
                                "streak": w["sos_streak"] if reason == "sos" else None,
                                "streak_needed": SOS_SAFE_STREAK})
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
    title, body = _KNOCK.get(reason, _KNOCK["high_alert"])
    # The SOS knock goes out on the responder channel: it vibrates and makes no
    # sound. Every other notification the wearer gets during an emergency
    # already obeys that rule -- see notify_owner_of_ack -- and for the same
    # reason, which is that the person being asked may be hiding from whoever
    # the alert is about.
    await send_expo_push_notifications(
        [w["user_id"]], title, body,
        {"checkin_id": checkin_id, "severity": 2, "reason": reason,
         "due_at": now + CHECKIN_WINDOW_S},
        channel=RESPONDER_CHANNEL_ID if reason == "sos" else None,
        sound=None if reason == "sos" else "default")


async def _page_phone_silent(w, now):
    """The phone itself went quiet while armed, with a band linked."""
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


async def _page_band_gone(r, now):
    """The band went away, the grace window ran out, and it has not come back."""
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
