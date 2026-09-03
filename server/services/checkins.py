"""
Check-ins: a question with a deadline the SERVER owns.
"""

import time
from contextlib import closing

from server.db import db
from server.hub import HUB


#
# A check-in is a question with a deadline attached, and the deadline lives
# here. That is the whole point. The phone asks, the phone buzzes, the phone
# answers -- but the phone does not decide when time is up, because the case
# that matters is precisely the one where the phone is dead, off, taken, or
# killed by an OEM battery manager.


def open_checkin(c, uid):
    """The oldest question this person still owes an answer to."""
    return c.execute(
        "SELECT * FROM checkins WHERE user_id=%s AND acked_at IS NULL "
        "ORDER BY due_at LIMIT 1", (uid,)).fetchone()


async def ack_open_checkins(uid, by="app"):
    """Answer everything outstanding, and tell whoever asked.

    Deliberately answers *all* of them rather than the oldest. If a parent
    asked, and then High Alert asked again, one press of "I'm fine" means the
    person is fine -- leaving a second question open so it can escalate ninety
    seconds later would be a false alarm the product invented for itself.
    """
    now = time.time()
    with closing(db()) as c:
        rows = c.execute("SELECT * FROM checkins WHERE user_id=%s AND acked_at IS NULL",
                         (uid,)).fetchall()
        if not rows:
            return 0
        c.execute("UPDATE checkins SET acked_at=%s WHERE user_id=%s AND acked_at IS NULL",
                  (now, uid))
        c.commit()
        u = c.execute("SELECT id,name FROM users WHERE id=%s", (uid,)).fetchone()

    who = {"id": uid, "name": u["name"] if u else uid}
    for r in rows:
        if r["asked_by"]:
            await HUB.to(r["asked_by"], {"t": "checkin_ack", "checkin_id": r["id"],
                                         "by": who, "reason": r["reason"]})
    return len(rows)
