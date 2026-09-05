"""One broken branch must not swallow another branch's alert.

    python tests/test_sweeper_branch_isolation.py

No server, no database and no network: the sweeper's `db` is swapped for a
fake that raises on whichever query this test wants to break.

WHAT THIS GUARDS, and why it needed a file separate from
test_sweeper_recovers.py:

That file covers ONE escalation failing -- `_guard` catches it and puts the
row's own latch back, so the next tick retries. This covers the layer above
it, which had no cover at all.

`sweep_once` does its four deadline checks against a single pooled connection
and only THEN sends anything. Each check writes a latch first -- `escalated`,
`lost_notified`, a cleared `link_lost_at` -- so that a condition which stays
true pages a family once rather than every five seconds. The pool is
autocommit, so those latches are durable the instant they are written, several
statements before the alerts they stand for exist.

So an exception anywhere in branches 2, 3 or 4 used to leave the function
entirely. `sweeper()` caught it, logged one line, and ticked again -- and
branch 1's rows were now sitting at `escalated=TRUE` with no alert ever sent
and no query that could find them again. The family was not told late. They
were never told, and the log said "sweep failed, still ticking".

It was found the way these things are: a `high_alert` check-in in a real
database, latched, with no alert anywhere and a wearer whose family heard
nothing. The widened branch-2 query (`OR mode='sos'`, so an SOS asks its own
check-ins) is exactly the kind of change that makes a branch newly capable of
raising, which is what turned a latent bug into an observed one.

Each branch now catches its own failure. A broken branch costs that branch one
tick and nothing else.
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from server import sweeper as S       # noqa: E402  (the path above comes first)

PASS = FAIL = 0
EXECUTED = []


def check(name, cond, extra=None):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}" + (f"\n        {extra}" if extra else ""))


class FakeCur:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows

    def fetchone(self):
        return self._rows[0] if self._rows else None


class FakeConn:
    """Answers each SELECT from `plan`; raises on any needle listed in `boom`."""

    def __init__(self, plan, boom=()):
        self.plan = plan
        self.boom = boom

    def execute(self, sql, params=None):
        flat = " ".join(sql.split())
        EXECUTED.append((flat, params))
        for needle in self.boom:
            if needle in flat:
                raise RuntimeError(f"boom: {needle}")
        for needle, rows in self.plan:
            if needle in flat:
                return FakeCur(rows)
        return FakeCur([])

    def commit(self):
        pass

    def close(self):
        pass


def checkin(i, uid, reason="manual"):
    return {"id": i, "user_id": uid, "reason": reason, "due_at": 900.0,
            "created_at": 800.0, "acked_at": None, "escalated": False,
            "lat": None, "lon": None, "note": ""}


def latched():
    return [(s, p) for s, p in EXECUTED
            if s.startswith("UPDATE checkins SET escalated=TRUE")]


def released():
    return [(s, p) for s, p in EXECUTED
            if s.startswith("UPDATE checkins SET escalated=FALSE")]


S.LIMIT = type("L", (), {"sweep": staticmethod(lambda *a, **k: None)})()
NOW = 1000.0

# Branch 2 opens a real row, so it needs a RETURNING id to come back.
BUZZ_PLAN = ("INSERT INTO checkins", [{"id": 99}])


async def main():
    due = [checkin(1, "u1"), checkin(2, "u2")]

    # ---- the bug, one branch at a time -----------------------------------
    #
    # Each of these breaks a DIFFERENT later branch and asserts the same
    # thing: branch 1 latched two check-ins, so branch 1's two alerts must
    # still go out. Before the fix every one of these sent nothing at all.
    for label, needle in [
        ("the check-in schedule", "FROM watch_state WHERE (high_alert=TRUE OR mode='sos')"),
        ("the heartbeat watchdog", "WHERE mode!='idle'"),
        ("the grace window", "WHERE link_lost_at IS NOT NULL"),
    ]:
        EXECUTED.clear()
        paged = []

        async def emit(uid, kind, **kw):
            paged.append(uid)
            return {}, []

        S.db = lambda: FakeConn(
            [("FROM checkins WHERE acked_at IS NULL", due), BUZZ_PLAN],
            boom=(needle,))
        S.emit_alert = emit
        r = await S.sweep_once(NOW)

        check(f"{label} failing still pages the missed check-ins",
              paged == ["u1", "u2"], paged)
        check(f"...and the tick still returns a result rather than raising",
              isinstance(r, dict) and r.get("missed") == 2, r)
        check(f"...and no latch is wrongly released",
              released() == [], released())

    # ---- branch 1's own failure is the opposite default ------------------
    #
    # If the SELECT worked and the latch UPDATE did not, those rows are NOT
    # latched. Escalating them now would page the family and then page them
    # again on the next tick, when the same rows come back unlatched. One
    # escalation five seconds late beats two escalations on time.
    EXECUTED.clear()
    paged = []

    async def emit2(uid, kind, **kw):
        paged.append(uid)
        return {}, []

    S.db = lambda: FakeConn(
        [("FROM checkins WHERE acked_at IS NULL", due), BUZZ_PLAN],
        boom=("UPDATE checkins SET escalated=TRUE",))
    S.emit_alert = emit2
    r = await S.sweep_once(NOW)
    check("a failed latch escalates nobody, rather than escalating twice",
          paged == [], paged)
    check("...and the tick survives it", isinstance(r, dict) and r["missed"] == 0, r)

    # ---- the happy path is untouched -------------------------------------
    EXECUTED.clear()
    paged = []

    async def emit3(uid, kind, **kw):
        paged.append(uid)
        return {}, []

    S.db = lambda: FakeConn([("FROM checkins WHERE acked_at IS NULL", due), BUZZ_PLAN])
    S.emit_alert = emit3
    r = await S.sweep_once(NOW)
    check("with nothing broken, both check-ins page exactly once",
          paged == ["u1", "u2"] and len(latched()) == 1, (paged, latched()))
    check("...and nothing is released", released() == [] and r["failed"] == 0, r)

    # ---- the claim is atomic, so two sweepers cannot both take a row ----
    #
    # This project runs a deployed server and a laptop against the SAME
    # database as a matter of routine, and docs/AWS_DEPLOYMENT.md 1.1 names the
    # consequence: a latch is a column, and two processes reading it in the
    # same tick both find it unset and both page the family. It was found the
    # hard way -- a laptop on new code racing a deployed box on old code for
    # the same missed check-in, escalating it to a different KIND of alert
    # depending on who won the tick.
    #
    # Structural rather than behavioural: modelling SKIP LOCKED in a fake
    # connection would be testing the fake. What is worth pinning is that
    # selecting and latching are ONE statement, because the moment they are two
    # the race is back and it stays invisible until a family is paged twice.
    claim = [q for q, _ in EXECUTED
             if q.startswith("UPDATE checkins SET escalated=TRUE")]
    check("rows are claimed in a single statement, not read then marked",
          len(claim) == 1, claim)
    check("...and the claim skips rows another sweeper already holds",
          bool(claim) and "FOR UPDATE SKIP LOCKED" in claim[0], claim)
    check("...and it hands back the rows it actually took",
          bool(claim) and claim[0].rstrip().endswith("RETURNING *"), claim)
    bare = [q for q, _ in EXECUTED
            if q.startswith("SELECT") and "FROM checkins" in q and "acked_at IS NULL" in q]
    check("...so nothing reads the due rows without claiming them", bare == [], bare)

    print(f"\n  {PASS} passed, {FAIL} failed\n")
    return 1 if FAIL else 0


raise SystemExit(asyncio.run(main()))
