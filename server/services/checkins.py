"""
Check-ins: a question with a deadline the SERVER owns.
"""

import time
from contextlib import closing

from server.config import RESPONDER_CHANNEL_ID
from server.db import db
from server.hub import HUB
from server.push import send_expo_push_notifications


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

    # Whoever asked, told once -- not once per open row. Two questions answered
    # by one press of "I'm fine" is one piece of news, and the person who asked
    # both should not get two identical popups for it.
    asked_by = {r["asked_by"] for r in rows if r["asked_by"]}
    for r in rows:
        if r["asked_by"]:
            await HUB.to(r["asked_by"], {"t": "checkin_ack", "checkin_id": r["id"],
                                         "by": who, "reason": r["reason"]})

    # The socket frame above only lands on an app that is open, and the person
    # who asked "are you okay?" is exactly the person who put the phone back in
    # their pocket to wait for the answer. Same reasoning as
    # notify_owner_of_ack, and the same channel: it vibrates and stays silent,
    # and severity 1 keeps it away from the siren and the takeover.
    if asked_by:
        await send_expo_push_notifications(
            list(asked_by),
            f"{who['name']} is fine",
            "They answered your check-in.",
            {"severity": 1, "t": "checkin_ack", "by": who["id"]},
            channel=RESPONDER_CHANNEL_ID,
            # An answer delivered half an hour late describes a worry that has
            # already resolved itself one way or the other.
            ttl=300,
            sound=None)

    return len(rows)
