"""A failed escalation must be retried, not silently dropped.

    python tests/test_sweeper_recovers.py

No server, no database and no network. The sweeper's `db` is swapped for a fake
that records every statement it is given, and `emit_alert` for one that fails
on demand.

WHAT THIS GUARDS, and why it is worth a file of its own:

The sweeper latches before it acts. `escalated`, `lost_notified` and a cleared
`link_lost_at` are written and committed BEFORE the alerts they stand for go
out, so that a condition which stays true pages a family once instead of every
five seconds. That ordering is right for the happy path and used to be fatal
off it: any failure in between -- a pool timeout, a dropped session, one
unusual row -- was caught by the loop in sweeper(), printed, and forgotten,
with the latch left set. The row could never match its query again, so the
family was not told late. They were never told.

It failed the whole batch too. One flat loop, one exception, and everybody
after the failing row was abandoned in the same tick.

So every escalation now runs inside `_guard`, which puts its own latch back
when it fails. The trade is a small chance of paging twice against the
certainty of not paging at all, and in a safety product that is not close.
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from server import sweeper as S       # noqa: E402  (the path above comes first)

PASS = FAIL = 0
EXECUTED = []              # (sql, params) for every statement, all connections


def check(name, cond, extra=None):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}" + (f"\n        {extra}" if extra else ""))


# ---- the fake database ---------------------------------------------------
class FakeCur:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows

    def fetchone(self):
        return self._rows[0] if self._rows else None


class FakeConn:
    """Answers each SELECT from `plan`, records everything, commits nothing."""

    def __init__(self, plan):
        self.plan = plan

    def execute(self, sql, params=None):
        flat = " ".join(sql.split())
        EXECUTED.append((flat, params))
        for needle, rows in self.plan:
            if needle in flat:
                return FakeCur(rows)
        return FakeCur([])

    def commit(self):
        pass

    def close(self):
        pass


def updates(fragment):
    """Only the UPDATEs, and only what they SET.

    `fragment` is matched against the statement, but the caller passes the
    `SET ...` clause rather than the bare column. That precision is now load
    bearing: the sweeper claims its rows with a single
    `UPDATE ... WHERE id IN (SELECT ... WHERE escalated=FALSE ...) RETURNING *`,
    so a statement that RELEASES no latch at all still contains the text
    "escalated=FALSE" inside its subquery. Matching the column alone reported
    every claim as a release.
    """
    return [(s, p) for s, p in EXECUTED
            if s.startswith("UPDATE") and fragment in s]


def checkin(i, uid):
    return {"id": i, "user_id": uid, "reason": "manual", "due_at": 900.0,
            "created_at": 800.0, "acked_at": None, "escalated": False}


def watch(uid, **kw):
    r = {"user_id": uid, "last_beat": 1000.0, "last_lat": 1.0, "last_lon": 2.0,
         "link_lost_at": None, "mode": "high_alert", "high_alert": True,
         "next_buzz_at": None, "lost_notified": False, "lost_rearm_at": None,
         "beat_band_link": True, "beat_armed": True}
    r.update(kw)
    return r


# The real one sweeps its own rate-limit table; nothing here needs that.
S.LIMIT = type("L", (), {"sweep": staticmethod(lambda *a, **k: None)})()

NOW = 1000.0


async def main():
    # ---- one bad row does not take the batch down ------------------------
    due = [checkin(1, "u1"), checkin(2, "u2"), checkin(3, "u3")]
    EXECUTED.clear()
    tried = []

    async def flaky(uid, kind, **kw):
        tried.append(uid)
        if uid == "u2":
            raise RuntimeError("pool timeout on the way out")
        return {}, []

    S.db = lambda: FakeConn([("FROM checkins WHERE acked_at IS NULL", due)])
    S.emit_alert = flaky
    result = await S.sweep_once(NOW)

    check("a failing escalation does not abandon the rest of the batch",
          tried == ["u1", "u2", "u3"], tried)
    check("the failed check-in's latch is released, and only that one",
          updates("SET escalated=FALSE")
          == [("UPDATE checkins SET escalated=FALSE WHERE id=%s", (2,))],
          updates("SET escalated=FALSE"))
    check("a tick reports how many escalations failed",
          result.get("failed") == 1 and result.get("missed") == 3, result)

    # ---- a successful tick leaves every latch alone ----------------------
    EXECUTED.clear()

    async def fine(uid, kind, **kw):
        return {}, []

    S.emit_alert = fine
    result = await S.sweep_once(NOW)
    check("nothing is released when every escalation goes out",
          updates("SET escalated=FALSE") == [] and result["failed"] == 0,
          updates("SET escalated=FALSE"))

    # ---- the band-gone branch restores the countdown as well -------------
    #
    # Its latch is two columns, not one. `link_lost_at` is cleared for every
    # row whose window is up, and without putting that back the grace branch
    # cannot find the row again -- nor will the silence branch, because the
    # phone in this case is still beating. Releasing `lost_notified` alone
    # would look like a fix and retry nothing.
    EXECUTED.clear()
    S.db = lambda: FakeConn([
        ("FROM checkins WHERE acked_at IS NULL", []),
        ("high_alert=TRUE", []),
        ("mode!='idle'", []),
        ("link_lost_at IS NOT NULL", [watch("u9", link_lost_at=800.0, mode="sos")]),
    ])

    async def always_fails(*a, **kw):
        raise RuntimeError("Expo unreachable")

    S.emit_alert = always_fails
    await S.sweep_once(NOW)
    released = updates("SET lost_notified=FALSE")
    check("a failed band-gone page restores link_lost_at, not just the latch",
          len(released) == 1 and released[0][1] == (800.0, "u9")
          and "link_lost_at=%s" in released[0][0], released)

    # ---- and if even the release fails, it says so instead of dying ------
    def broken():
        raise RuntimeError("database unreachable")

    S.db = broken
    try:
        S._unlatch("checkin 7", "UPDATE checkins SET escalated=FALSE WHERE id=%s",
                   (7,))
        check("a latch release that itself fails is logged, not raised", True)
    except Exception as e:
        check("a latch release that itself fails is logged, not raised", False,
              repr(e))


asyncio.run(main())
print(f"\n  {PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)
