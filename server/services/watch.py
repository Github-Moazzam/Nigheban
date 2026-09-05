"""
The watch_state row: High Alert, the heartbeat, and when to buzz next.

The rule that reads this row is server/watch_lost.py, and it is kept pure.
This is only the part that has to touch the database.
"""

import time


def watch_row(c, uid):
    c.execute("INSERT INTO watch_state (user_id,last_beat) VALUES (%s,%s)"
              " ON CONFLICT (user_id) DO NOTHING", (uid, time.time()))
    return c.execute("SELECT * FROM watch_state WHERE user_id=%s", (uid,)).fetchone()


def arm_sos(c, uid, now=None):
    """Put the watch into an emergency: the mode, the silence clock, the questions.

    Factored out of POST /alert because the sweeper needs the identical write.
    An SOS the wearer pressed and an SOS the server raised out of a missed High
    Alert check-in are the same emergency by the time anybody hears about it,
    and if the two paths write different watch state they will drift -- and the
    one that drifts is the one that only runs when nobody answered.

    Three facts go down together:

    `mode='sos'` and the witnessed arming. Arming starts the silence clock, so
    it has to write the state the watchdog will judge that silence against.
    `on_arm` moves `last_beat` to now and refuses to inherit a stale band link,
    which is what stops a phone that has been idle all afternoon raising a
    `watch_lost` on top of its own SOS for a link that ended hours ago.

    `next_buzz_at`. The emergency asks its own check-ins from here -- every
    five minutes, and two answers in a row end it. Before this the column was
    High Alert's alone, so an SOS raised from an idle phone asked nothing and
    the only way out of it was the stand-down button.

    `sos_streak=0`. A new emergency starts nobody's run of answers over,
    including the run that was building against the last one.
    """
    from server import watch_lost as WL
    from server.config import BEAT_LOST_S, SOS_CHECKIN_EVERY_S

    now = now or time.time()
    row = watch_row(c, uid)
    armed = WL.on_arm(WL.Watch.from_row(row), now=now, beat_lost_s=BEAT_LOST_S)
    c.execute("UPDATE watch_state SET mode='sos', last_beat=%s, "
              "beat_band_link=%s, beat_armed=TRUE, "
              "lost_notified=FALSE, lost_rearm_at=NULL, link_lost_at=NULL, "
              "next_buzz_at=%s, sos_streak=0 "
              "WHERE user_id=%s",
              (armed.last_beat, armed.beat_band_link,
               now + SOS_CHECKIN_EVERY_S, uid))
