"""
The connection pool, and the only two ways to get a connection out of it.

`db()` borrows one. `borrow(c)` uses the caller's if there is one. Everything
else in the server goes through those, which is what keeps the count of live
Supabase sessions bounded -- see the comment on the pool below for what
happens when it is not.

_POOL is a module-level singleton and `close_db()` reassigns it, so this module
must be imported as `server.db` from everywhere. Importing it flatly as `db`
would give the process a second pool against the same fifteen-connection cap.
"""

import os
import threading
from contextlib import closing, contextmanager
from urllib.parse import urlsplit

import psycopg
from psycopg.rows import dict_row

from server.logging_setup import get_logger

log = get_logger(__name__)


def db_label():
    """host/dbname of DATABASE_URL, for the banner. Never the password."""
    p = urlsplit(os.environ.get("DATABASE_URL") or "")
    return f"{p.hostname}{p.path}" if p.hostname else "(DATABASE_URL not set)"


# ------------------------------------------------------------------- db ---
# One pool for the process, and it is not an optimisation.
#
# Supabase's session-mode pooler hands out FIFTEEN client connections to the
# whole project, and the old db() opened a brand new one for every query. A
# single SOS touches the database five or six times on its way out, so two
# phones and the 5 s sweeper were enough to hit
#
#     FATAL: (EMAXCONNSESSION) max clients reached in session mode
#
# and once that starts, EVERY endpoint 500s -- including /me, so the app
# cannot even sign in and retry. A cap below the ceiling turns that cliff into
# a queue: the sixteenth caller waits a moment for a connection instead of
# taking the server down with it. Keep DB_POOL_MAX under 15, and lower it
# again if a second process (scripts/db.py, a test run, a stray uvicorn) is
# sharing the same project.
DB_POOL_MAX       = int(os.environ.get("DB_POOL_MAX", "8"))
DB_POOL_TIMEOUT_S = float(os.environ.get("DB_POOL_TIMEOUT_S", "15"))

# A ceiling on how long ONE statement may run, enforced by Postgres itself.
#
# Without it a query that hangs -- a lock it will never get, a pooler that
# accepted the bytes and went away -- holds its pool slot for ever. There are
# eight slots. Eight hung queries is not a slow server, it is a total outage:
# every endpoint that touches the database blocks for DB_POOL_TIMEOUT_S and
# then 500s, `/me` included, so the app cannot even sign in to retry.
#
# Ten seconds is far above anything here. The slowest real query in this server
# is the presence scan behind a samaritan sweep, and that is milliseconds
# against a table this size; the round trip to ap-northeast-1 is ~150 ms. So
# anything still running at ten seconds is stuck, not slow, and failing it
# frees the slot for the next SOS.
DB_STATEMENT_TIMEOUT_MS = int(os.environ.get("DB_STATEMENT_TIMEOUT_MS", "10000"))

# Passed to libpq on every connection, pooled or not.
_CONNECT_OPTIONS = f"-c statement_timeout={DB_STATEMENT_TIMEOUT_MS}"

try:
    from psycopg_pool import ConnectionPool
except ImportError:                                   # pragma: no cover
    ConnectionPool = None

_POOL = None
_POOL_LOCK = threading.Lock()


def _pool():
    """The process-wide pool, opened on first use."""
    global _POOL
    if _POOL is None:
        with _POOL_LOCK:
            if _POOL is None:
                url = os.environ.get("DATABASE_URL")
                if not url:
                    raise Exception("DATABASE_URL not set in .env")
                _POOL = ConnectionPool(
                    url, name="nigehban",
                    min_size=1, max_size=DB_POOL_MAX,
                    timeout=DB_POOL_TIMEOUT_S, max_idle=120.0,
                    # Prove the connection is alive before handing it out.
                    #
                    # The default is no check at all, and the failure it lets
                    # through is the classic one: Supabase's pooler drops a
                    # session it considers idle, or a NAT between here and Tokyo
                    # forgets the mapping, and neither tells this end. The socket
                    # looks open because nothing has been written to it. The pool
                    # hands out the corpse, the query dies with "server closed
                    # the connection unexpectedly", and the caller gets a 500 --
                    # classically the FIRST request after a quiet spell, which
                    # for this server means the first request after a quiet
                    # night. check_connection costs one round trip on checkout
                    # and turns that into a transparent reconnect.
                    check=ConnectionPool.check_connection,
                    kwargs={"row_factory": dict_row, "autocommit": True,
                            "options": _CONNECT_OPTIONS},
                    open=True,
                )
    return _POOL


class _Pooled:
    """A borrowed connection that answers to `close()`.

    Every call site in this file is `with closing(db()) as c:`, and that is the
    right shape -- so rather than rewrite thirty-six of them, closing a pooled
    connection hands it back instead of dropping the socket we want to keep.
    Everything else is the psycopg connection, untouched.
    """
    __slots__ = ("_conn", "_pool", "_returned")

    def __init__(self, pool, conn):
        self._pool = pool
        self._conn = conn
        self._returned = False

    def __getattr__(self, name):
        return getattr(object.__getattribute__(self, "_conn"), name)

    def close(self):
        if not self._returned:
            self._returned = True
            self._pool.putconn(self._conn)


def db():
    if ConnectionPool is None:                        # pragma: no cover
        # No pool installed: the old one-connection-per-query behaviour, which
        # works against a local Postgres and falls over against the Supabase
        # pooler. `pip install -r requirements.txt` fixes it.
        url = os.environ.get("DATABASE_URL")
        if not url:
            raise Exception("DATABASE_URL not set in .env")
        c = psycopg.connect(url, row_factory=dict_row, options=_CONNECT_OPTIONS)
        c.autocommit = True
        return c
    p = _pool()
    return _Pooled(p, p.getconn())


def close_db():
    """Give every connection back at shutdown, so a restart is not racing the
    old process for the same fifteen slots."""
    global _POOL
    if _POOL is not None:
        _POOL.close()
        _POOL = None


def init_db():
    """The schema is applied by `python server/migrate_pg.py`, not from here.

    But the server has to know whether that was actually run, because it does
    not fail the way a missing schema should. `watch_state` gained three
    columns with migration 006, and starting this build against a database
    without them does not break at boot: it breaks on the first POST
    /heartbeat, as an UndefinedColumn inside a 500, once a minute, per armed
    phone. Every one of those is a wearer's "I am still here" being thrown
    away -- and after three minutes of them the sweeper decides she has gone
    quiet. A safety product silently converting a forgotten migration into
    missed heartbeats is the worst reading of that mistake available.

    So it is checked once, at startup, where somebody is looking at the
    terminal. It prints and does not raise: a server that refuses to start
    reaches nobody at all, and everything except the watch_lost transition
    works perfectly well against the older schema.
    """
    want = {"beat_band_link", "beat_armed", "lost_rearm_at", "link_lost_at",
            "high_alert"}
    try:
        with closing(db()) as c:
            have = {r["column_name"] for r in c.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema='public' AND table_name='watch_state'").fetchall()}
            # Migration 010, checked here for the same reason: nothing fails
            # when it is missing. POST /register goes on working, and the only
            # symptom is one person, some time later, who cannot sign in with
            # the right password because a second account holds their username
            # and /login answers with whichever row Postgres reached first.
            uniq = c.execute(
                "SELECT 1 FROM pg_indexes WHERE schemaname='public'"
                " AND tablename='users' AND indexname='users_username_uniq'"
            ).fetchone()
    except Exception as e:
        log.warning("schema could not be checked (%s: %s)", type(e).__name__, e)
        return
    missing = sorted(want - have)
    if missing:
        print("\n  *** watch_state is missing " + ", ".join(missing) + " ***")
        print("  Migrations 006-008 have not been applied. Every heartbeat will")
        print("  fail with UndefinedColumn until they are, and an armed phone")
        print("  that cannot report in gets reported lost. Fix it with:\n")
        print("      python server/migrate_pg.py\n")
    if not uniq:
        print("\n  *** users.username is not unique ***")
        print("  Migration 010 has not been applied. Two people can register the")
        print("  same username, and one of them then cannot sign in at all -- with")
        print("  the correct password, and no error that says why. Fix it with:\n")
        print("      python server/migrate_pg.py\n")


def migrate(c):
    pass


@contextmanager
def borrow(c=None):
    """Use the caller's connection if there is one, else take one from the pool.

    Every helper in this file used to open its own. That was free against a
    Postgres on the same laptop and is not free against a pooler in Tokyo --
    one SOS made nine trips, which is most of the 8 s the app waits before it
    decides the alert never sent and raises it again.
    """
    if c is not None:
        yield c
    else:
        with closing(db()) as fresh:
            yield fresh
