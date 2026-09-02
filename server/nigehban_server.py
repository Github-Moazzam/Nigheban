#!/usr/bin/env python3
"""
NIGEHBAN SERVER — the local brain and database.

Runs on the laptop. Both phones talk to it over the Wi-Fi they share. Nothing
leaves the room, which is the point: this is a safety product, so the location
of a teenage girl should not be sitting in someone else's cloud during a demo.

    pip install fastapi "uvicorn[standard]"
    python nigehban_server.py

What it owns:
    accounts        one row per person, each with a short shareable code
    invites         a link REQUIRES both people to act -- see section B1 below
    family links    who is allowed to see whose alerts (always mutual)
    alerts          every SOS, check-in and resolution, append-only
    checkins        open questions with a deadline the SERVER owns
    watch_state     High Alert mode, next buzz, last heartbeat
    delivery        a live WebSocket per signed-in phone
    the sweeper     a 5 s tick that makes deadlines true with no phone attached

Routing rule, in one sentence: an alert raised by user X is pushed to every
user linked to X, and to nobody else.

Consent rule, in one sentence: a link exists only after two people have each
taken an action -- one issues, the other redeems, or one asks and the other
accepts. Nothing about a person is revealed before that.
"""

import asyncio
import hashlib
import json
import math
import os
import random
import re
import secrets
import threading
import psycopg
from psycopg.rows import dict_row
from dotenv import load_dotenv
load_dotenv()
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit
from collections import defaultdict, deque
from contextlib import asynccontextmanager, closing, contextmanager
from typing import Optional

from fastapi import (
    Depends, FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# The watch_lost rule, kept in its own module and kept pure: no database, no
# clock, no network. It is the one piece of this server whose bugs are only
# ever discovered at 2 a.m. by somebody's family, so it is the one piece that
# has to be exhaustively testable in milliseconds. See server/watch_lost.py for
# the rule itself and tests/test_watch_lost_transition.py for every case.
#
# Imported by path rather than as `server.watch_lost`: this file is run
# directly (`python server/nigehban_server.py`), so there is no package.
try:
    import watch_lost as WL
except ImportError:                                   # imported as a package
    from . import watch_lost as WL

PORT = 8000


def db_label():
    """host/dbname of DATABASE_URL, for the banner. Never the password."""
    p = urlsplit(os.environ.get("DATABASE_URL") or "")
    return f"{p.hostname}{p.path}" if p.hostname else "(DATABASE_URL not set)"

SEVERITY = {
    # A road accident sits with the SOS, not with the fall, and the difference
    # is not a matter of degree. A fall is one person on the ground, and the
    # thing that helps is somebody who knows them arriving. A crash is that
    # plus traffic still moving through it, and the useful responder is
    # whoever is closest -- which is what severity 5 buys: the Good Samaritan
    # fan-out, and every family member paged rather than the nearest few.
    "sos": 5, "snatch": 5, "accident": 5,
    "fall": 4, "checkin_missed": 3, "watch_lost": 3,
    "going_dark": 3, "checkin_req": 2, "checkin_ack": 1, "low_battery": 1,
    # The band stopping is a maintenance problem -- the phone is still
    # reachable by push. going_dark is the phone, and that closes every path.
    "band_battery": 1,
    "sos_clear": 1, "near_miss": 1,
}

# Kinds that are written down but never sent to anybody. A cancelled fall is
# the wearer's own record that the detector nearly fired -- useful for tuning
# the thresholds in Phase 5, and not something to wake four people over.
PRIVATE_KINDS = {"near_miss"}

# Good Samaritan: how far from a severity-5 alert a stranger can be and still
# be asked, and how coarse the pin they are shown is until they say yes.
SAMARITAN_RADIUS_M = 800
SAMARITAN_COARSE_M = 300
PRESENCE_FRESH_S   = 900

# How long a pairing code is worth anything. Short on purpose: see PAIRING
# below. Ten minutes is "we are in the same room, or on the phone together",
# which is the situation this is actually for.
PAIR_TTL_S      = 600
CHECKIN_WINDOW_S = 90       # default deadline on "are you okay?"

# ---- what an unanswered question turns into -------------------------------
#
# Every check-in that runs out used to become the same thing: `checkin_missed`,
# severity 3, "she did not answer". For a parent's question that is exactly
# right -- the only fact anyone has is the silence.
#
# For a fall or a crash it is a serious understatement, and the understatement
# is the dangerous direction. Something measured an impact, asked the wearer
# about it, and got nothing back. That is not "did not reply to a message", it
# is "was hit and is not responding", and it has a location attached. Sending
# that to a family as a severity-3 missed check-in buries the worst event the
# product can detect under the same heading as a teenager ignoring their phone.
#
# So the reason the question was asked decides what the silence means. Anything
# not named here is a question about nothing in particular and stays
# `checkin_missed`.
INCIDENT_ESCALATION = {
    "fall":     "fall",       # severity 4
    "accident": "accident",   # severity 5 -- see SEVERITY
}

# How long an incident check-in waits before it escalates, by reason.
#
# Shorter than the 90 s a parent's question gets, and deliberately so. A manual
# check-in is answered at the wearer's convenience; these two are answered by
# somebody who has just been hit, and every second of the window is a second in
# which nobody has been called. Forty-five seconds is long enough to find the
# phone in a pocket and short enough to matter.
#
# The accident window is the shorter of the two because the failure it guards
# against is the worse one -- a motorway, at night, with traffic still coming.
INCIDENT_WINDOW_S = {"fall": 45, "accident": 30}

HIGH_ALERT_MIN_S = 300      # re-buzz window while High Alert is on
HIGH_ALERT_MAX_S = 600
BEAT_LOST_S      = 180      # armed and silent this long -> tell the family
SWEEP_TICK_S     = 5


# ---- in-memory auth cache ------------------------------------------------
# me() hits the DB on every authenticated request. With Mumbai that is ~25ms
# and with Tokyo it was ~200ms — per call, before the endpoint even starts.
# Caching the token->user lookup for 60s removes that cost entirely for all
# but the first request in each window.  The entry expires naturally; a login
# that changes token_hash simply means the old entry stops being looked up
# (the app switches to the new token) and ages out.
_AUTH_CACHE = {}          # token_hash -> (user_dict, expires_at)
AUTH_CACHE_TTL = 60       # seconds


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
                    kwargs={"row_factory": dict_row, "autocommit": True},
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
        c = psycopg.connect(url, row_factory=dict_row)
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
    except Exception as e:
        print(f"  [schema] could not be checked ({type(e).__name__}: {e})")
        return
    missing = sorted(want - have)
    if missing:
        print("\n  *** watch_state is missing " + ", ".join(missing) + " ***")
        print("  Migrations 006-008 have not been applied. Every heartbeat will")
        print("  fail with UndefinedColumn until they are, and an armed phone")
        print("  that cannot report in gets reported lost. Fix it with:\n")
        print("      python server/migrate_pg.py\n")


def migrate(c):
    pass


def hash_pw(pw, salt=None):
    salt = salt or secrets.token_hex(8)
    h = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), 120_000).hex()
    return f"{salt}${h}"


def check_pw(pw, stored):
    try:
        salt, _ = stored.split("$", 1)
    except ValueError:
        return False
    return secrets.compare_digest(hash_pw(pw, salt), stored)


def tok_hash(tok: str) -> str:
    """Session and pairing tokens are stored hashed, never in the clear.

    These are already high-entropy random strings, so there is nothing to
    brute-force and no salt or work factor is called for -- a plain SHA-256 is
    the right tool. The point is only that the database is not a list of live
    credentials.
    """
    return hashlib.sha256(tok.encode()).hexdigest()


ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"      # no O/0/I/1


def new_code():
    """Short, unambiguous, readable aloud across a room. No O/0/I/1."""
    alphabet = ALPHABET
    with closing(db()) as c:
        for _ in range(50):
            code = "NGB-" + "".join(secrets.choice(alphabet) for _ in range(4))
            if not c.execute("SELECT 1 FROM users WHERE id=%s", (code,)).fetchone():
                return code
    raise HTTPException(500, "could not allocate an id")


# ------------------------------------------------------- rate limiting ---
class RateLimit:
    """A sliding window per (bucket, key), held in memory.

    Deliberately modest: one process, resets on restart, no Redis. It is not a
    defence against a botnet and does not pretend to be. What it does stop is
    the thing this server is actually exposed to -- somebody with a script
    walking the code space or the password space over a tunnel, which is
    otherwise unbounded and completely silent.

    Note what is NOT limited, and why each one is deliberate:

      /alert            Throttling an SOS is the wrong instinct in a safety
                        product; a person mashing the button in a panic must
                        get through every time.
      /heartbeat        A 429 here is indistinguishable from a dead phone. The
                        beat never reaches the UPDATE, last_beat goes stale,
                        and BEAT_LOST_S later the sweeper pages the family for
                        an emergency that is not happening. A rate limit that
                        invents an emergency is worse than no rate limit.

    Everything on the emergency path that IS limited -- ack, resolve, samaritan
    respond -- is limited generously: the ceiling is set to stop a script, not
    a frightened person pressing twice. When in doubt on this file, the bias is
    to let the request through.
    """

    def __init__(self):
        self.hits = defaultdict(deque)

    def check(self, bucket, key, limit, per_s, msg="too many attempts, wait a moment"):
        now = time.monotonic()
        q = self.hits[(bucket, key)]
        while q and now - q[0] > per_s:
            q.popleft()
        if len(q) >= limit:
            raise HTTPException(429, msg)
        q.append(now)

    def sweep(self, older_than=3600):
        now = time.monotonic()
        for k in [k for k, q in self.hits.items() if not q or now - q[-1] > older_than]:
            self.hits.pop(k, None)


LIMIT = RateLimit()


def client_ip(req: Request) -> str:
    """Best-effort caller identity for rate limiting.

    Behind ngrok every request arrives from 127.0.0.1, so the forwarded header
    is the only thing with any signal in it. It is also trivially spoofable by
    the caller, which is why it is used ONLY to bucket rate limits and never to
    authorise anything. Per-account limits sit alongside these for that reason.
    """
    xff = req.headers.get("x-forwarded-for", "")
    if xff:
        return xff.split(",")[0].strip()[:45]
    return (req.client.host if req.client else "?")[:45]


def me(authorization: Optional[str] = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "sign in first")
    th = tok_hash(authorization[7:])
    now = time.time()
    cached = _AUTH_CACHE.get(th)
    if cached and cached[1] > now:
        return dict(cached[0])
    with closing(db()) as c:
        u = c.execute("SELECT * FROM users WHERE token_hash=%s",
                      (th,)).fetchone()
    if not u:
        _AUTH_CACHE.pop(th, None)
        raise HTTPException(401, "session expired, sign in again")
    _AUTH_CACHE[th] = (dict(u), now + AUTH_CACHE_TTL)
    return dict(u)


# ------------------------------------------------------------ delivery ---
class Hub:
    """Live sockets, keyed by user. A phone may be signed in more than once."""

    def __init__(self):
        self.socks = {}          # user_id -> set[WebSocket]

    def add(self, uid, ws):
        self.socks.setdefault(uid, set()).add(ws)

    def drop(self, uid, ws):
        s = self.socks.get(uid)
        if s:
            s.discard(ws)
            if not s:
                self.socks.pop(uid, None)

    def online(self, uid):
        return uid in self.socks

    async def to(self, uid, msg):
        data = json.dumps(msg)
        for ws in list(self.socks.get(uid, ())):
            try:
                await ws.send_text(data)
            except Exception:
                self.drop(uid, ws)

    async def fanout(self, uids, msg):
        await asyncio.gather(*(self.to(u, msg) for u in uids), return_exceptions=True)


HUB = Hub()


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


def family_of(uid, c=None):
    """Everyone who receives uid's alerts."""
    with borrow(c) as c:
        return [r["member_id"] for r in
                c.execute("SELECT member_id FROM links WHERE owner_id=%s", (uid,))]


# ------------------------------------------------------------- schemas ---
class RegisterIn(BaseModel):
    username: str
    password: str
    name: str


class LoginIn(BaseModel):
    username: str
    password: str


class InviteIn(BaseModel):
    code: str                  # a PAIR-… pairing code, or an NGB-… user code
    relation: str = ""


class PairIn(BaseModel):
    relation: str = ""


class DeviceIn(BaseModel):
    id: str
    push_token: Optional[str] = None
    platform: Optional[str] = None
    os_version: Optional[str] = None
    app_version: Optional[str] = None


class CheckinIn(BaseModel):
    window: int = CHECKIN_WINDOW_S


class SelfCheckinIn(BaseModel):
    """A detector on the phone asking its own wearer whether they are all right.

    The one check-in nobody requested. `reason` is what fired -- see
    INCIDENT_ESCALATION -- and it is the field that decides what the silence
    becomes, so it is validated rather than trusted.

    `lat`/`lon` are where the incident happened, captured at the impact and not
    at the deadline; `note` is what the detector measured, in words a family
    member can read.
    """
    reason: str = "fall"
    window: Optional[int] = None
    lat: Optional[float] = None
    lon: Optional[float] = None
    note: str = ""
    # The phone's id for one incident, reused across retries, exactly like
    # AlertIn.client_id. An impact happens in the second the network is worst --
    # under a flyover, in a ditch -- so this request WILL be retried, and two
    # check-ins for one crash means two escalations and two pages.
    client_id: Optional[str] = None


class HighAlertIn(BaseModel):
    on: bool = True
    # Present so a demo does not have to wait five real minutes for the first
    # buzz. Clamped, and never longer than the real window -- it can make the
    # feature easier to show, never quieter than it is meant to be.
    first_buzz_s: Optional[int] = None


class HeartbeatIn(BaseModel):
    mode: str = "idle"                 # idle | high_alert | sos
    band_link: bool = False
    # Two batteries, and they fail independently: a flat band means the safety
    # device is off the air, a flat phone means every path to the family is
    # about to close. band_batt is None in virtual mode, where the phone *is*
    # the band and there is no second cell to report.
    #
    # phone_batt held band battery until migration 002 -- an older build still
    # sends it that way, which is why neither is trusted to imply the other.
    phone_batt: Optional[int] = None
    band_batt: Optional[int] = None
    # Which kind of band is behind band_link. In virtual mode the phone *is*
    # the band, so there is no second cell and the family must not be shown
    # one -- see migration 003. False by default, because a build old enough
    # not to send this field only ever had a real band to talk about.
    virtual: bool = False
    lat: Optional[float] = None
    lon: Optional[float] = None


class PresenceIn(BaseModel):
    lat: float
    lon: float


class AlertIn(BaseModel):
    kind: str = "sos"
    source: str = "app"
    lat: Optional[float] = None
    lon: Optional[float] = None
    accuracy: Optional[float] = None
    note: str = ""
    # The phone's id for one press, sent on the first attempt and on every
    # retry of it. Optional so an older build still works -- it just gets the
    # old duplicate-on-retry behaviour, which is the thing to fix by updating.
    client_id: Optional[str] = None


# ---------------------------------------------------------------- app ---
from contextlib import asynccontextmanager


@asynccontextmanager
async def lifespan(_app):
    init_db()
    task = asyncio.create_task(sweeper())
    print(f"\n  Nigehban server ready - db at {db_label()}")
    print(f"  sweeper ticking every {SWEEP_TICK_S}s - deadlines survive the phone\n")
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except BaseException:
            pass
        # Detached deliveries are usually an Expo call with a 5 s timeout, and
        # they are the last thing anyone wants dropped. Give them a moment to
        # land, then close the pool -- in that order, or the pool goes away
        # underneath a query still in flight.
        if _BACKGROUND:
            await asyncio.wait(set(_BACKGROUND), timeout=6)
        close_db()


app = FastAPI(title="Nigehban local server", lifespan=lifespan)

# CORS is now an allowlist, and the default is empty.
#
# Nothing in this project is a browser: the app is React Native, which does not
# enforce CORS at all, and the server hands out no HTML. So an empty allowlist
# costs exactly nothing today -- every real client keeps working -- while `*`
# was standing invitation for any page on the internet to drive this API with a
# token it had got hold of.
#
# Set ALLOWED_ORIGINS (comma-separated) when something that IS a browser needs
# in -- a web console, a dashboard. The failure mode of getting it wrong is a
# loud CORS error in the devtools console, not a silent one.
ALLOWED_ORIGINS = [
    o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"ok": True, "t": time.time()}


@app.post("/register")
def register(b: RegisterIn, req: Request):
    # Deliberately loose. Everyone in one room shares one public IP, so a
    # tight limit here does not stop a script -- it stops a demo, or a family
    # signing up together on the same Wi-Fi. It is a ceiling on automation,
    # not a queue.
    LIMIT.check("register", client_ip(req), 20, 600,
                "too many accounts from this network - try again in a few minutes")
    uname = b.username.strip().lower()
    if not re.fullmatch(r"[a-z0-9_.]{3,20}", uname):
        raise HTTPException(400, "username: 3-20 chars, letters/numbers/_/. only")
    if len(b.password) < 4:
        raise HTTPException(400, "password must be at least 4 characters")
    if not b.name.strip():
        raise HTTPException(400, "please enter your name")

    uid, tok = new_code(), secrets.token_hex(24)
    with closing(db()) as c:
        if c.execute("SELECT 1 FROM users WHERE username=%s", (uname,)).fetchone():
            raise HTTPException(409, "that username is taken")
        c.execute("INSERT INTO users (id,username,pw_hash,name,created_at,token_hash)"
                  " VALUES (%s,%s,%s,%s,%s,%s)",
                  (uid, uname, hash_pw(b.password), b.name.strip(), time.time(),
                   tok_hash(tok)))
        c.commit()
    return {"user_id": uid, "token": tok, "name": b.name.strip(), "username": uname, "role": "user"}


@app.post("/login")
def login(b: LoginIn, req: Request):
    uname = b.username.strip().lower()
    # Two buckets on purpose: per-account stops someone grinding one password
    # list against one person, per-IP stops the same script spraying one
    # password across many accounts.
    LIMIT.check("login_user", uname, 8, 300, "too many tries — wait five minutes")
    LIMIT.check("login_ip", client_ip(req), 60, 300,
                "too many tries from this network - wait five minutes")

    with closing(db()) as c:
        u = c.execute("SELECT * FROM users WHERE username=%s", (uname,)).fetchone()
        if not u or not check_pw(b.password, u["pw_hash"]):
            raise HTTPException(401, "wrong username or password")
        # A fresh token every sign-in, and only its hash is kept. Signing in
        # again invalidates the previous session, which is the cheapest form of
        # "I lost my phone" there is.
        tok = secrets.token_hex(24)
        c.execute("UPDATE users SET token_hash=%s WHERE id=%s",
                  (tok_hash(tok), u["id"]))
        c.commit()
    return {"user_id": u["id"], "token": tok, "name": u["name"], "username": u["username"], "role": u["role"]}


@app.get("/me")
def whoami(u=Depends(me)):
    # `role` is here so the app can re-read it on every launch. It is the only
    # field that can change underneath a signed-in phone -- promoting someone to
    # admin is done in the database, not in the app -- and without it the phone
    # would keep whatever role it was handed at sign-in until it signed in again.
    return {"user_id": u["id"], "name": u["name"], "username": u["username"],
            "role": u.get("role") or "user"}


# ---- family: pairing and consent ---------------------------------------
#
# THE RULE: a link exists only after two people have each taken an action.
#
# What was here before linked both accounts, in both directions, the instant
# anyone typed a code -- no acceptance, no notification, nothing to refuse.
# For a product whose users include people avoiding a stalker that is not a
# rough edge, it is the whole threat model walking in the front door. Two paths
# replace it, and both need two people:
#
#   1. PAIRING CODE (the good one). You generate a code, it lives ten minutes,
#      it works once. They enter it and you are linked immediately -- you
#      consented by issuing it, they consented by using it. Nothing is pending
#      because nothing is in doubt.
#
#   2. INVITE BY USER CODE (the fallback, for "add me when you get a chance").
#      Creates a request. Nothing whatsoever flows until they accept.
#
# Why the ten-minute code is the better primitive, and now the one the app
# leads with:
#
#   - A permanent code is a bearer secret that can never be taken back. One
#     screenshot, one glance over a shoulder, one old WhatsApp message and
#     someone holds a key to your location for as long as the account exists.
#     A pairing code is dead in ten minutes whether it was used or not.
#   - It is single-use, so a code shared with one person cannot quietly admit
#     a second.
#   - It carries no identity. `NGB-4F2A` is you forever and appears on your own
#     screen; `PAIR-...` is a coupon that expires.
#   - 40 bits of entropy against a ten-minute window and a rate limit is not
#     guessable. A four-character user code is ~1e6 possibilities, which is a
#     few hours of scripted guessing -- which is exactly why path 2 must never
#     say whether a code exists.


def link_both(c, a, b, relation, now):
    """Family is mutual: you each see the other's alerts.

    One-way links produce the demo-day surprise where the parent sees the
    child and the child never sees the parent's check-in. That it is mutual is
    now stated on the accept screen rather than assumed.
    """
    c.execute("INSERT INTO links VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING", (a, b, relation, now))
    c.execute("INSERT INTO links VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING", (b, a, "", now))


def pub(u, relation=""):
    """The only shape of another person we ever hand out."""
    return {"id": u["id"], "name": u["name"], "username": u["username"],
            "relation": relation}


@app.get("/family")
def family(u=Depends(me)):
    with closing(db()) as c:
        rows = c.execute("""
            SELECT us.id, us.name, us.username, l.relation, l.created_at
            FROM links l JOIN users us ON us.id = l.member_id
            WHERE l.owner_id = %s ORDER BY l.created_at
        """, (u["id"],)).fetchall()
    return [{**dict(r), "online": HUB.online(r["id"])} for r in rows]


@app.post("/pair")
def make_pairing_code(b: PairIn, u=Depends(me)):
    """Issue a one-time pairing code. Shown once, hashed at rest."""
    LIMIT.check("pair", u["id"], 20, 3600, "too many pairing codes - wait a while")
    now = time.time()
    half = lambda: "".join(secrets.choice(ALPHABET) for _ in range(4))
    tok = f"PAIR-{half()}-{half()}"
    with closing(db()) as c:
        # Only one live code at a time. If you generate a new one you have
        # decided the old one is loose; it should stop working that instant.
        c.execute("DELETE FROM pairings WHERE issuer_id=%s AND used_at IS NULL",
                  (u["id"],))
        c.execute("INSERT INTO pairings (token_hash,issuer_id,relation,created_at,expires_at)"
                  " VALUES (%s,%s,%s,%s,%s)",
                  (tok_hash(tok), u["id"], b.relation.strip(), now, now + PAIR_TTL_S))
        c.commit()
    return {"code": tok, "expires_at": now + PAIR_TTL_S, "ttl_s": PAIR_TTL_S}


@app.post("/invite")
async def invite(b: InviteIn, req: Request, u=Depends(me)):
    """Redeem a pairing code, or ask someone to accept you."""
    # The per-account limit is the real one: it is the bucket an attacker
    # cannot escape without making more accounts. The per-IP limit is a
    # backstop against exactly that, and is set loose enough that a family or a
    # classroom behind one NAT never meets it -- 120 an hour against a million
    # possible codes is still four and a half years to a coin flip.
    LIMIT.check("invite_user", u["id"], 10, 600,
                "too many attempts - check the code and wait a few minutes")
    LIMIT.check("invite_ip", client_ip(req), 120, 3600,
                "too many attempts from this network - wait a while")

    code = b.code.strip().upper().replace(" ", "")
    relation = b.relation.strip()
    now = time.time()

    # ---- path 1: a pairing code -----------------------------------------
    if code.startswith("PAIR-"):
        with closing(db()) as c:
            row = c.execute("SELECT * FROM pairings WHERE token_hash=%s",
                            (tok_hash(code),)).fetchone()
            # One message for expired, used, and never-existed. There is no
            # reason to tell the holder of a bad code which kind of bad it is.
            if not row or row["used_at"] or row["expires_at"] < now:
                raise HTTPException(404, "that pairing code has expired or was already used")
            if row["issuer_id"] == u["id"]:
                raise HTTPException(400, "that is your own pairing code")

            other = c.execute("SELECT * FROM users WHERE id=%s",
                              (row["issuer_id"],)).fetchone()
            if not other:
                raise HTTPException(404, "that pairing code has expired or was already used")

            c.execute("UPDATE pairings SET used_at=%s, used_by=%s WHERE token_hash=%s",
                      (now, u["id"], row["token_hash"]))
            link_both(c, u["id"], other["id"], relation or row["relation"], now)
            # Any request left pending between these two is now moot.
            c.execute("UPDATE invites SET state='accepted', settled_at=%s "
                      "WHERE state='pending' AND ((from_id=%s AND to_id=%s) "
                      "OR (from_id=%s AND to_id=%s))",
                      (now, u["id"], other["id"], other["id"], u["id"]))
            c.commit()

        await HUB.to(other["id"], {"t": "family_added", "user": pub(u)})
        print(f"  paired: {u['name']} <-> {other['name']}")
        return {"ok": True, "linked": True, "member": pub(other, relation)}

    # ---- path 2: a user code, which needs their acceptance --------------
    if not code.startswith("NGB-"):
        code = "NGB-" + code
    if code == u["id"]:
        raise HTTPException(400, "that is your own code")

    with closing(db()) as c:
        other = c.execute("SELECT * FROM users WHERE id=%s", (code,)).fetchone()
        if other:
            already = c.execute("SELECT 1 FROM links WHERE owner_id=%s AND member_id=%s",
                                (u["id"], other["id"])).fetchone()
            if already:
                return {"ok": True, "linked": True, "member": pub(other)}

            prior = c.execute("SELECT * FROM invites WHERE from_id=%s AND to_id=%s",
                              (u["id"], other["id"])).fetchone()
            # A decline is permanent and it is silent. Re-inviting somebody who
            # said no gets the same cheerful answer as the first time and does
            # nothing at all -- so "she declined me" is not a fact this server
            # will hand to the person she declined.
            if not prior:
                cur = c.execute("INSERT INTO invites (from_id,to_id,relation,created_at)"
                                " VALUES (%s,%s,%s,%s) RETURNING id",
                                (u["id"], other["id"], relation, now))
                invite_id = cur.fetchone()["id"]
                c.commit()
                await HUB.to(other["id"], {
                    "t": "invite",
                    "invite": {"id": invite_id, "relation": relation,
                               "created_at": now, "from": pub(u)}})
                print(f"  invite: {u['name']} -> {other['name']} (awaiting consent)")

    # Identical response whether or not that code belongs to anyone. Without
    # this the endpoint is a directory: guess codes until one comes back
    # differently and you have found a real person, with their real name, and
    # can start sending them requests.
    return {"ok": True, "linked": False, "pending": True}


@app.get("/invites")
def list_invites(u=Depends(me)):
    """Requests waiting on me, and requests I am waiting on."""
    with closing(db()) as c:
        inc = c.execute("""
            SELECT i.id, i.relation, i.created_at, us.id AS uid, us.name, us.username
            FROM invites i JOIN users us ON us.id = i.from_id
            WHERE i.to_id=%s AND i.state='pending' ORDER BY i.created_at
        """, (u["id"],)).fetchall()
        # 'declined' is listed alongside 'pending' and reported as pending.
        # If a declined request simply vanished from the sender's list, then
        # vanishing WOULD BE the notification -- and the whole point of a silent
        # decline is that refusing somebody carries no risk of them finding out.
        out = c.execute("""
            SELECT id, to_id, relation, created_at FROM invites
            WHERE from_id=%s AND state IN ('pending','declined') ORDER BY created_at
        """, (u["id"],)).fetchall()
    return {
        "incoming": [{"id": r["id"], "relation": r["relation"],
                      "created_at": r["created_at"],
                      "from": {"id": r["uid"], "name": r["name"],
                               "username": r["username"]}} for r in inc],
        # Outgoing carries the code that was typed and nothing else. Learning
        # someone's name by sending them a request they have not answered is
        # exactly the lookup this whole section exists to prevent.
        "outgoing": [{"id": r["id"], "to": r["to_id"], "relation": r["relation"],
                      "created_at": r["created_at"]} for r in out],
    }


@app.post("/invite/{invite_id}/accept")
async def accept_invite(invite_id: int, u=Depends(me)):
    LIMIT.check("invite_answer", u["id"], 30, 600,
                "too many invite answers - wait a few minutes")
    now = time.time()
    with closing(db()) as c:
        inv = c.execute("SELECT * FROM invites WHERE id=%s", (invite_id,)).fetchone()
        if not inv or inv["to_id"] != u["id"]:
            raise HTTPException(404, "no such request")
        if inv["state"] != "pending":
            raise HTTPException(409, "that request has already been answered")
        other = c.execute("SELECT * FROM users WHERE id=%s", (inv["from_id"],)).fetchone()
        if not other:
            raise HTTPException(404, "that account no longer exists")

        c.execute("UPDATE invites SET state='accepted', settled_at=%s WHERE id=%s",
                  (now, invite_id))
        link_both(c, other["id"], u["id"], inv["relation"], now)
        c.commit()

    await HUB.to(other["id"], {"t": "family_added", "user": pub(u)})
    print(f"  accepted: {u['name']} <-> {other['name']}")
    return {"ok": True, "member": pub(other, inv["relation"])}


@app.post("/invite/{invite_id}/decline")
def decline_invite(invite_id: int, u=Depends(me)):
    """Refuse, permanently. The other side is told nothing, ever.

    Not a missing feature. If declining sent a notification, then declining
    would be a thing you might not dare do -- and a product for people who are
    afraid of somebody must never make refusing them the risky option. To the
    sender this looks exactly like an invite nobody has opened yet.
    """
    # Shares a bucket with accept on purpose: the pair of them is one decision,
    # and a script walking invite ids should not get twice the budget by
    # alternating between the two endpoints.
    LIMIT.check("invite_answer", u["id"], 30, 600,
                "too many invite answers - wait a few minutes")
    with closing(db()) as c:
        inv = c.execute("SELECT * FROM invites WHERE id=%s", (invite_id,)).fetchone()
        if not inv or inv["to_id"] != u["id"]:
            raise HTTPException(404, "no such request")
        c.execute("UPDATE invites SET state='declined', settled_at=%s WHERE id=%s",
                  (time.time(), invite_id))
        c.commit()
    return {"ok": True}


@app.post("/family")
def add_family_gone():
    """The old auto-link. Fails closed rather than quietly linking anyone."""
    raise HTTPException(
        410, "this app is out of date - pairing now needs the other person to "
             "agree. Please update.")


@app.delete("/family/{member_id}")
def remove_family(member_id: str, u=Depends(me)):
    LIMIT.check("family_remove", u["id"], 20, 600,
                "too many changes to your family list - wait a few minutes")
    with closing(db()) as c:
        c.execute("DELETE FROM links WHERE (owner_id=%s AND member_id=%s) "
                  "OR (owner_id=%s AND member_id=%s)",
                  (u["id"], member_id, member_id, u["id"]))
        # Removing someone has to also clear the old invite, or they can never
        # be added again -- the UNIQUE(from_id,to_id) row would still be there.
        c.execute("DELETE FROM invites WHERE (from_id=%s AND to_id=%s) "
                  "OR (from_id=%s AND to_id=%s)",
                  (u["id"], member_id, member_id, u["id"]))
        c.commit()
    return {"ok": True}


# ---- alerts -------------------------------------------------------------
# ---- geography, for the Good Samaritan fan-out --------------------------
GEO_B32 = "0123456789bcdefghjkmnpqrstuvwxyz"


def geohash(lat, lon, precision=6):
    """Standard geohash. Six characters is a cell of roughly 1.2 x 0.6 km."""
    lat_r, lon_r = [-90.0, 90.0], [-180.0, 180.0]
    out, bit, ch, even = [], 0, 0, True
    while len(out) < precision:
        if even:
            mid = (lon_r[0] + lon_r[1]) / 2
            if lon > mid: ch = (ch << 1) | 1; lon_r[0] = mid
            else:         ch = ch << 1;       lon_r[1] = mid
        else:
            mid = (lat_r[0] + lat_r[1]) / 2
            if lat > mid: ch = (ch << 1) | 1; lat_r[0] = mid
            else:         ch = ch << 1;       lat_r[1] = mid
        even = not even
        bit += 1
        if bit == 5:
            out.append(GEO_B32[ch])
            bit, ch = 0, 0
    return "".join(out)


def metres_between(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def coarsen(lat, lon):
    """Snap to a ~330 m grid. What a stranger sees before they say yes."""
    step = SAMARITAN_COARSE_M / 111000.0
    return round(lat / step) * step, round(lon / step) * step


def nearby_strangers(uid, lat, lon, now=None):
    """Fresh presence within the radius, minus the person and their family.

    Every fresh row is scored rather than being narrowed by geohash prefix
    first. At this scale that is a handful of rows, and it avoids the cell-edge
    bug where the one person standing across the street from an emergency is in
    the neighbouring cell and never asked. The geohash is still stored, because
    the contract in B3.3 promises it and a real deployment would index on it.
    """
    now = now or time.time()
    known = set(family_of(uid)) | {uid}
    with closing(db()) as c:
        rows = c.execute("SELECT * FROM presence WHERE at > %s",
                         (now - PRESENCE_FRESH_S,)).fetchall()
    out = []
    for r in rows:
        if r["user_id"] in known:
            continue
        d = metres_between(lat, lon, r["lat"], r["lon"])
        if d <= SAMARITAN_RADIUS_M:
            out.append((r["user_id"], d))
    return sorted(out, key=lambda x: x[1])


def acks_for(alert_ids, c):
    """Who has answered each of these alerts, oldest first.

    One query for every alert in the response rather than one per row: the app
    asks for five at a time and each round trip to the pooler is ~150 ms.

    This exists because the answer used to live only in the websocket frame
    `/alert/{id}/ack` sends. A phone whose app was closed at that moment never
    heard it and had no way to ask afterwards, so reopening said "waiting for
    someone to answer" while somebody was already driving over -- BUG-008.
    The database always knew; nothing ever read it back.
    """
    ids = list(alert_ids)
    if not ids:
        return {}
    rows = c.execute(
        "SELECT k.alert_id, k.user_id, k.at, u.name FROM acks k"
        " JOIN users u ON u.id = k.user_id"
        " WHERE k.alert_id = ANY(%s) ORDER BY k.at", (ids,)).fetchall()
    out = {}
    for r in rows:
        out.setdefault(r["alert_id"], []).append(
            {"id": r["user_id"], "name": r["name"], "at": r["at"]})
    return out


def alert_row(r, author, acks=()):
    return {"id": r["id"], "kind": r["kind"], "severity": r["severity"],
            "source": r["source"], "lat": r["lat"], "lon": r["lon"],
            "accuracy": r["accuracy"], "note": r["note"],
            "created_at": r["created_at"], "resolved_at": r["resolved_at"],
            "user": author,
            # Always present, even when empty. The app replays these on every
            # restore, and "the key is missing" and "nobody has answered" have
            # to be the same thing to it or a stale build reads as a silence.
            "acks": list(acks),
            "maps": (f"https://maps.google.com/?q={r['lat']:.6f},{r['lon']:.6f}"
                     if r["lat"] is not None else None)}


async def emit_alert(uid, kind, *, source="server", lat=None, lon=None,
                     accuracy=None, note="", client_id=None):
    """Write an alert and push it to the family. One path in, for everyone.

    The sweeper raises alerts nobody pressed a button for, and those have to be
    indistinguishable from a phone-raised one by the time they reach a family
    member -- same row, same severity, same socket frame. Two code paths would
    drift, and the one that drifts is the one that only runs at 3 a.m.

    `client_id` is the phone's id for ONE press. A retry of that press finds
    the row already there and returns it untouched: no second row, no second
    page, no second alarm. See migration 004. Server-raised alerts pass None
    and stay free to repeat, because two missed check-ins really are two
    events.

    What leaves this function on the fast path is the database write and the
    socket fanout, and nothing else. The Expo calls and the samaritan sweep are
    handed to a background task, because the phone that pressed the button is
    holding a request open until this returns -- and it gives up after 8 s.
    """
    sev = SEVERITY.get(kind, 3)
    with closing(db()) as c:
        # ON CONFLICT DO NOTHING returns no row when this press is already
        # recorded, which is how a retry is recognised. RETURNING * saves the
        # SELECT that used to follow: every round trip here is ~150 ms to
        # ap-northeast-1 and the caller is counting them.
        cur = c.execute(
            "INSERT INTO alerts"
            " (user_id,kind,severity,source,lat,lon,accuracy,note,created_at,client_id)"
            " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)"
            " ON CONFLICT (user_id,client_id) WHERE client_id IS NOT NULL DO NOTHING"
            " RETURNING *",
            (uid, kind, sev, source, lat, lon, accuracy, note, time.time(), client_id))
        row = cur.fetchone()
        first_time = row is not None
        if row is None and client_id is not None:
            row = c.execute("SELECT * FROM alerts WHERE user_id=%s AND client_id=%s",
                            (uid, client_id)).fetchone()
        if row is None:
            # Only reachable if the row vanished between the two statements.
            raise HTTPException(500, "could not record the alert")
        c.commit()
        who = c.execute("SELECT id,name FROM users WHERE id=%s", (uid,)).fetchone()
        targets = [] if kind in PRIVATE_KINDS else family_of(uid, c)

    name = who["name"] if who else uid
    payload = alert_row(row, {"id": uid, "name": name})

    # The retry of a press that already landed. The family has been told;
    # telling them again is the bug this exists to stop. Hand the app the same
    # row it failed to hear about the first time and stop here.
    if not first_time:
        print(f"  [{kind}] from {name} ({uid}) -> retry of alert {row['id']}, already sent")
        return payload, targets

    # A near-miss is written down and told to nobody: it is the wearer's own
    # record that the fall detector nearly fired, not an event.
    if kind in PRIVATE_KINDS:
        print(f"  [{kind}] from {name} ({uid}) -> logged, nobody told")
        return payload, []

    await HUB.fanout(targets, {"t": "alert", "alert": payload})
    print(f"  [{kind}] from {name} ({uid}) -> {len(targets)} family member(s), "
          f"{sum(HUB.online(t) for t in targets)} online")

    # Everything below this line is slow, and none of it is something the
    # sender waits for. Expo is three sequential HTTP calls at a 5 s timeout,
    # and the samaritan sweep is a table scan plus a fourth -- up to 15 s of
    # work behind a client that hangs up at 8. Detaching it is not an
    # optimisation: a request that outlives the phone's patience gets retried,
    # and a retried SOS used to mean a second row and a second page.
    #
    # The task is held in a module-level set. Without a reference asyncio is
    # free to garbage-collect a running task, and the notification that goes
    # missing is the one nobody is watching for.
    _spawn(_deliver_out_of_band(payload, row, uid, name, kind, sev, lat, lon, targets),
           f"deliver:{row['id']}")

    return payload, targets


_BACKGROUND = set()


def _spawn(coro, name):
    """Run a coroutine detached, keep a reference, and never let it die quietly."""
    task = asyncio.create_task(coro, name=name)
    _BACKGROUND.add(task)
    task.add_done_callback(_BACKGROUND.discard)

    def _shout(t):
        if t.cancelled():
            return
        e = t.exception()
        if e:
            # A push that fails silently looks exactly like a push that worked.
            print(f"  [background:{name}] {type(e).__name__}: {e}")

    task.add_done_callback(_shout)
    return task


async def _deliver_out_of_band(payload, row, uid, name, kind, sev, lat, lon, targets):
    """The slow half of emit_alert, with nobody waiting on it."""
    # Send Remote System Push Notification via Expo Push Service API for closed/killed apps
    push_title = (f"EMERGENCY SOS - {name}" if sev >= 5
                  else f"{kind.replace('_', ' ').upper()} - {name}")
    push_body = "Tap immediately to open Nigehban for location and emergency details."
    await send_expo_push_notifications(targets, push_title, push_body,
                                       {"alert_id": row["id"], "severity": sev})

    # N3.3: the lock-screen takeover needs the app's own code to run, and on a
    # killed app only a data-only push gets it there. Sent second and on top of
    # the visible one above, never instead of it -- if the OS drops this in Doze
    # the family still has a notification to tap, which is what the tap routing
    # exists for. The payload carries what the headless task needs to build the
    # alarm without a network round trip, since it may have none.
    if sev >= 4:
        await send_expo_push_notifications(
            targets, None, None,
            {"alert_id": row["id"], "severity": sev, "kind": kind,
             "name": name, "maps": payload.get("maps")},
            silent=True)

    if sev >= 5 and lat is not None and lon is not None:
        await ask_samaritans(row, uid, lat, lon)


async def ask_samaritans(row, uid, lat, lon):
    """Ask strangers who are close, and tell them almost nothing (matrix #20).

    What goes out is a kind, a coarse pin and a distance. No name, no exact
    position, no way to work out whose alert it is. Somebody who is only
    curious learns that an emergency happened near a road junction, which is
    what they would have learned by hearing it. The rest is released by
    /samaritan/{id}/respond, and only to the person who committed to going.
    """
    near = nearby_strangers(uid, lat, lon)
    if not near:
        return
    clat, clon = coarsen(lat, lon)
    for who, dist in near[:20]:
        msg = {"t": "samaritan",
               "alert": {"id": row["id"], "kind": row["kind"],
                         "severity": row["severity"], "created_at": row["created_at"],
                         "lat": round(clat, 4), "lon": round(clon, 4),
                         "distance_m": int(round(dist / 50.0) * 50),
                         "maps": f"https://maps.google.com/?q={clat:.4f},{clon:.4f}"}}
        await HUB.to(who, msg)
    await send_expo_push_notifications(
        [w for w, _ in near[:20]],
        "Someone near you needs help",
        "A Nigehban emergency was raised close by. Open the app if you can go.",
        {"alert_id": row["id"], "severity": row["severity"], "samaritan": True})
    print(f"  [samaritan] alert {row['id']} -> {len(near[:20])} nearby stranger(s)")


@app.post("/alert")
async def raise_alert(b: AlertIn, u=Depends(me)):
    payload, targets = await emit_alert(
        u["id"], b.kind, source=b.source, lat=b.lat, lon=b.lon,
        accuracy=b.accuracy, note=b.note, client_id=b.client_id)

    # "I'm fine" is an answer, not just an event. Without this the ward can
    # press the key, the family can see the acknowledgement, and the sweeper
    # still escalates ninety seconds later because the open question was never
    # closed -- a false alarm the product would have invented for itself.
    if b.kind == "checkin_ack":
        await ack_open_checkins(u["id"])
    if b.kind == "sos":
        with closing(db()) as c:
            row = watch_row(c, u["id"])
            # An SOS arms the watch, and arming starts the silence clock -- so
            # it writes the same witnessed state High Alert does, through the
            # same rule. This is the fix for the case that used to page a
            # family for nothing: mode='sos' written against a `last_beat` from
            # hours ago satisfied the old watchdog's `mode != 'idle' AND
            # last_beat < now - 180` on the very next tick, so a wearer whose
            # phone had been idle and quiet all afternoon pressed SOS and their
            # family got a watch_lost on top of it -- for a link that had ended
            # long before, if it ever existed. `on_arm` moves last_beat to now
            # and refuses to inherit a stale band link, so there is no
            # retroactive transition left to find.
            armed = WL.on_arm(WL.Watch.from_row(row), now=time.time(),
                              beat_lost_s=BEAT_LOST_S)
            c.execute("UPDATE watch_state SET mode='sos', last_beat=%s, "
                      "beat_band_link=%s, beat_armed=TRUE, "
                      "lost_notified=FALSE, lost_rearm_at=NULL, link_lost_at=NULL "
                      "WHERE user_id=%s",
                      (armed.last_beat, armed.beat_band_link, u["id"]))
            c.commit()

    return {"ok": True, "alert": payload, "delivered_to": len(targets)}


@app.post("/alert/{alert_id}/resolve")
async def resolve(alert_id: int, u=Depends(me)):
    # Emergency path: generous. Standing an alert down is the thing that stops
    # four phones sirening, so the ceiling is set to stop a script walking
    # alert ids, not a wearer tapping the button again because the first tap
    # did not look like it worked.
    LIMIT.check("alert_resolve", u["id"], 60, 300,
                "too many stand-downs at once - wait a moment")
    with closing(db()) as c:
        row = c.execute("SELECT * FROM alerts WHERE id=%s", (alert_id,)).fetchone()
        if not row:
            raise HTTPException(404, "no such alert")
        if row["user_id"] != u["id"]:
            raise HTTPException(403, "only the person who raised it can stand it down")
        c.execute("UPDATE alerts SET resolved_at=%s WHERE id=%s", (time.time(), alert_id))
        # Standing down an SOS clears the watch's sos mode too, or the
        # heartbeat watchdog keeps treating a finished emergency as a live one.
        # `beat_armed` goes with it for the same reason as in /watch/high_alert:
        # the phone stops beating when it goes idle, and a witnessed "armed"
        # left behind would have the silence watchdog page the family three
        # minutes after the emergency was stood down.
        #
        # It falls back to High Alert rather than to idle when High Alert is
        # still armed. The emergency is over; the standing watch the wearer
        # switched on before it is not, and it was never the SOS's to end.
        # This is the other half of migration 008 -- with one column those two
        # states could not both be represented, so resolving an SOS silently
        # disarmed a High Alert that nobody had touched.
        c.execute("UPDATE watch_state SET "
                  "mode=CASE WHEN high_alert THEN 'high_alert' ELSE 'idle' END, "
                  "beat_armed=high_alert, "
                  "link_lost_at=CASE WHEN high_alert THEN link_lost_at ELSE NULL END "
                  "WHERE user_id=%s AND mode='sos'", (u["id"],))
        c.commit()

    await HUB.fanout(family_of(u["id"]),
                     {"t": "resolved", "alert_id": alert_id,
                      "user": {"id": u["id"], "name": u["name"]}})
    return {"ok": True}


# The channel the app files "somebody answered" under: it vibrates, and it makes
# no sound. Named here rather than inlined because both ack paths use it and it
# has to match `RESPONDER_CHANNEL_ID` in the app's notifications.js exactly -- a
# channel id Android does not recognise silently demotes the notification.
RESPONDER_CHANNEL_ID = "nigehban_sos_responder"


async def notify_owner_of_ack(row, responder, total, samaritan=False):
    """Tell the person in trouble that somebody is coming.

    The websocket frame above only lands if their app is open. It usually is
    not: the phone is in a pocket, the screen is off, and on Android the app may
    have been killed the moment it left the foreground. That was BUG-008 -- the
    answer existed on the server and reached the wearer nowhere.

    A visible push is the only delivery path that survives a terminated app, so
    it is the one used here. Deliberately NOT the silent/data push the family's
    siren rides on: that one exists to wake the app so it can take the lock
    screen over, and nothing here should take a screen over.

    Two things this must not do, both because the wearer may be in the middle of
    the emergency this is about:

      - No sound. Same reasoning as the wearer's own SOS notification: it could
        give away the position of somebody hiding from whoever they pressed the
        button about. The channel vibrates and stays quiet.
      - No band buzz. The wristband vibrating means exactly one thing already --
        "someone is checking on you, press the button to answer" -- and a person
        in danger must not be handed a button to press. Reusing that buzz for
        good news would make both meanings unreliable.
    """
    if row["resolved_at"]:
        # The emergency is over. Somebody acking a stood-down alert is tidying
        # up, not responding, and the wearer does not need to be told.
        return
    if responder["id"] == row["user_id"]:
        return

    name = responder["name"] or "Someone"
    title = (f"{name} is nearby and on the way" if samaritan
             else f"{name} is on the way")
    body = "They answered your SOS and can see your location."
    if total > 1:
        # The count is the reassuring part, and it is the part a single
        # notification cannot carry. Each responder gets their own push -- the
        # server cannot reach back and edit one already sitting on a locked
        # phone -- so each one says where things now stand.
        body = f"They answered your SOS. {total} people are on their way."

    await send_expo_push_notifications(
        [row["user_id"]], title, body,
        # severity stays low on purpose. The app routes >= 4 to the siren
        # channel and its background task fires the full-screen takeover at
        # >= 4, and neither belongs on the phone of the person who raised it.
        {"alert_id": row["id"], "responder": name, "severity": 1,
         "responders": total, "t": "ack"},
        channel=RESPONDER_CHANNEL_ID,
        # Same freshness rule as an emergency push. "Someone is on the way"
        # delivered half an hour late describes a situation that has moved on.
        ttl=300,
        sound=None)


@app.post("/alert/{alert_id}/ack")
async def ack(alert_id: int, u=Depends(me)):
    """A family member saying 'I've seen this, I'm on it.'"""
    # Emergency path: generous, for the same reason as resolve. A duplicate ack
    # is already harmless -- the ON CONFLICT below makes the second tap a
    # no-op -- so this ceiling exists only against a script.
    LIMIT.check("alert_ack", u["id"], 60, 300,
                "too many responses at once - wait a moment")
    with closing(db()) as c:
        row = c.execute("SELECT * FROM alerts WHERE id=%s", (alert_id,)).fetchone()
        if not row:
            raise HTTPException(404, "no such alert")
        # RETURNING tells a first ack apart from the same person tapping twice.
        # Without it a double tap sends a second push saying somebody new is
        # coming, which on a safety device is a lie, not a duplicate.
        at = time.time()
        first = c.execute(
            "INSERT INTO acks VALUES (%s,%s,%s) ON CONFLICT DO NOTHING"
            " RETURNING alert_id",
            (alert_id, u["id"], at)).fetchone() is not None
        c.commit()
        total = len(acks_for([alert_id], c).get(alert_id, ()))

    # `at` travels with the frame so the socket and the restore path agree.
    # Without it the app stamped arrival time, and a responder from ten minutes
    # ago redrew as "just now" the moment anything re-rendered.
    await HUB.to(row["user_id"], {"t": "ack", "alert_id": alert_id, "at": at,
                                  "by": {"id": u["id"], "name": u["name"]}})
    # Detached: Expo is a 5 s HTTP call and the family member who just tapped
    # "I'm on it" is holding this request open waiting for it to return.
    if first:
        _spawn(notify_owner_of_ack(row, {"id": u["id"], "name": u["name"]}, total),
               f"ack-push:{alert_id}:{u['id']}")
    return {"ok": True}


@app.get("/alerts")
def list_alerts(scope: str = "incoming", limit: int = 50, u=Depends(me)):
    with closing(db()) as c:
        if scope == "mine":
            rows = c.execute(
                "SELECT a.*, us.name AS uname FROM alerts a JOIN users us ON us.id=a.user_id "
                "WHERE a.user_id=%s ORDER BY a.created_at DESC LIMIT %s",
                (u["id"], limit)).fetchall()
        else:
            rows = c.execute(
                "SELECT a.*, us.name AS uname FROM alerts a JOIN users us ON us.id=a.user_id "
                "WHERE a.user_id IN (SELECT owner_id FROM links WHERE member_id=%s) "
                "ORDER BY a.created_at DESC LIMIT %s",
                (u["id"], limit)).fetchall()
        # Same connection, one extra round trip for the whole page.
        acks = acks_for([r["id"] for r in rows], c)
    return [alert_row(r, {"id": r["user_id"], "name": r["uname"]},
                      acks.get(r["id"], ()))
            for r in rows]


# ---- devices ------------------------------------------------------------
@app.post("/device")
def register_device(b: DeviceIn, u=Depends(me)):
    """Claim an install for this account, with its push token.

    Keyed on the install id, so signing in on a phone that used to belong to
    somebody else moves the row rather than leaving a second account's push
    token pointed at the same handset.
    """
    LIMIT.check("device_register", u["id"], 30, 600,
                "too many device registrations - wait a few minutes")
    # Brackets are allowed because builds up to now sent the Expo push token
    # itself as the install id, and "ExponentPushToken[...]" failed this check
    # -- so every registration 400'd, the devices table stayed empty, and no
    # alert was ever pushed to a closed app. The app now sends a real install
    # id; accepting the old shape means a handset that is already installed
    # starts working without waiting on a new build.
    if not re.fullmatch(r"[A-Za-z0-9_.:\[\]-]{8,64}", b.id or ""):
        raise HTTPException(400, "bad install id")
    with closing(db()) as c:
        c.execute(
            "INSERT INTO devices (id,user_id,push_token,platform,os_version,app_version,last_seen)"
            " VALUES (%s,%s,%s,%s,%s,%s,%s)"
            " ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,"
            " push_token=excluded.push_token, platform=excluded.platform,"
            " os_version=excluded.os_version, app_version=excluded.app_version,"
            " last_seen=excluded.last_seen",
            (b.id, u["id"], b.push_token, b.platform, b.os_version, b.app_version,
             time.time()))
        c.commit()
    return {"ok": True}


@app.delete("/device/{install_id}")
def stop_push_to_device(install_id: str, u=Depends(me)):
    """Stop pushing to this handset, because nobody is signed in on it any more.

    Sign-out used to be entirely local: the phone dropped its session and the
    server was never told. The row here kept this account's user_id and a live
    token, so every alert to this person's family went on being delivered to a
    handset they had signed out of -- name, alert kind, and the maps link to
    where they are. On a phone that has changed hands, a stranger reads it.

    **Only the token is cleared. The account is not touched.** Nothing about the
    user, their family, their history or their band changes, and the next
    sign-in on this phone fills the token straight back in through POST /device.
    `user_id` stays because the column is NOT NULL, and because there is no
    reason to disturb it: push_tokens_for() already filters on the token, so
    clearing that is the entire fix.

    Scoped with `AND user_id=%s` so a guessed install id cannot silence somebody
    else's phone. Deliberately idempotent -- signing out twice, or from a phone
    that never registered, is not an error and must not fail the sign-out.
    """
    # Generous, and it stays that way: a 429 on the way out would leave a live
    # push token on a handset the user believes they have signed out of, which
    # is the exact leak this endpoint was added to close.
    LIMIT.check("device_forget", u["id"], 60, 600,
                "too many sign-outs at once - wait a few minutes")
    with closing(db()) as c:
        c.execute("UPDATE devices SET push_token=NULL WHERE id=%s AND user_id=%s",
                  (install_id, u["id"]))
        c.commit()
    return {"ok": True}


def push_tokens_for(uids):
    """Push tokens for a set of users."""
    if not uids:
        return []
    with closing(db()) as c:
        rows = c.execute(
            "SELECT DISTINCT push_token FROM devices WHERE push_token IS NOT NULL"
            " AND push_token != ''"
            " AND user_id = ANY(%s)", (list(uids),)).fetchall()
    return [r["push_token"] for r in rows]


def forget_push_tokens(tokens):
    """Drop tokens Expo says are gone, so a dead install stops being retried.

    The row stays -- it is still that person's handset, and the next
    registration fills the token back in.
    """
    with closing(db()) as c:
        c.execute("UPDATE devices SET push_token=NULL WHERE push_token = ANY(%s)",
                  (list(tokens),))
        c.commit()
    print(f"  [expo push] forgot {len(tokens)} unregistered token(s)")


async def send_expo_push_notifications(uids, title, body, data=None, silent=False,
                                       channel=None, ttl=None, sound="default"):
    """Send Hardware Remote Push Notification via Expo Push Service API.

    Delivers notifications directly to Android system push framework even when
    the app is completely closed or killed.

    `silent=True` sends a data-only push: no title, no body, nothing shown. It
    exists for one reason, and it is the reason N3.3 works at all. Expo only
    runs the app's background notification task on a terminated app for a push
    carrying `data` and nothing else -- a push with a title is drawn by the
    system and the app is never woken. So the task that fires the lock-screen
    takeover can only be reached this way, and a severity-4-or-worse alert
    therefore goes out twice: once visibly, so something appears even if the
    silent one is dropped, and once silently, to start the siren.

    `channel`, `ttl` and `sound` override what severity would otherwise decide.
    They exist for the one push that travels the other way -- to the person in
    trouble rather than to the people being called. "Somebody answered" must not
    be filed on the DND-bypassing siren channel, and it stops being worth
    delivering long before the informational hour is up.

    On Android 8+ the channel owns the sound and `sound` here is redundant, but
    it is sent anyway: a phone whose channel was somehow created by an older
    build would otherwise fall back to "default" and make a noise next to
    somebody hiding.
    """
    tokens = push_tokens_for(uids)
    if not tokens:
        # Saying nothing here looked exactly like a successful send: the alert
        # fanned out, the log said "0 online", and that was the last line
        # printed. But "nobody has a push token" is the entire failure, not a
        # quiet edge case -- it is the difference between an alert that reaches
        # a closed phone and one that reaches nobody at all.
        print(f"  [expo push] no registered device among {len(uids)} target(s)"
              f" -- nothing sent (has the family member opened the app and"
              f" granted notifications?)")
        return

    sev = (data or {}).get("severity", 0)

    # How long this push is still worth delivering.
    #
    # Expo's default is four weeks, which for an emergency is not a default so
    # much as a bug: a severity-5 push queued while a phone was in a tunnel can
    # ring at 3 a.m. the next day, long after the wearer stood the alert down.
    # A family member woken by a siren for an emergency that ended yesterday
    # learns to distrust the siren, and that is the whole product.
    #
    # Five minutes for anything urgent -- long enough to survive a lift, a
    # tunnel or a moment of Doze, short enough that nothing arrives describing
    # a situation that has already moved on. It is deliberately not 0: "deliver
    # this instant or discard" would throw away real alerts over a two-second
    # network blip. An hour for the rest, which are informational.
    ttl = ttl if ttl is not None else (300 if sev >= 4 else 3600)

    payloads = []
    sent_tokens = []
    for token in tokens:
        if token.startswith("ExponentPushToken[") or token.startswith("ExpoPushToken["):
            if silent:
                # No title, no body, no sound, no channel. Anything shown here
                # would be a second visible notification for one emergency, and
                # -- the part that actually breaks it -- a push carrying a title
                # is handled by the system instead of being handed to the app,
                # so the background task would never run.
                payloads.append({
                    "to": token,
                    "priority": "high",
                    "ttl": ttl,
                    "data": data or {},
                    "_contentAvailable": True,
                })
            else:
                payloads.append({
                    "to": token,
                    "title": title,
                    "body": body,
                    "sound": sound,
                    "priority": "high",
                    "ttl": ttl,
                    "data": data or {},
                    "channelId": channel or ("nigehban_emergency_alarm" if sev >= 4
                                             else "nigehban_default")
                })
            sent_tokens.append(token)

    if not payloads:
        return

    dead = []

    def _do_post():
        try:
            req = urllib.request.Request(
                "https://exp.host/--/api/v2/push/send",
                data=json.dumps(payloads).encode('utf-8'),
                headers={"Content-Type": "application/json", "Accept": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                raw = resp.read().decode('utf-8')
            # Expo returns 200 even when every ticket failed (bad token,
            # DeviceNotRegistered, or -- the usual reason nothing arrives --
            # missing FCM V1 credentials for this project). Log each ticket's
            # status so a "why no push" question never needs the app rebuilt
            # to answer; see NIGEHBAN_BUILD_GUIDE.md / DEVELOPMENT_PLAN.md N3.1.
            try:
                tickets = json.loads(raw).get("data", [])
            except Exception:
                tickets = []
            ok = 0
            for token, ticket in zip(sent_tokens, tickets):
                status = ticket.get("status")
                if status == "ok":
                    ok += 1
                    continue
                details = ticket.get("details")
                detail = ticket.get("message") or details
                print(f"  [expo push ticket error] {token[:24]}... -> {status}: {detail}")
                if isinstance(details, dict) and details.get("error") == "DeviceNotRegistered":
                    dead.append(token)
            kind = "silent" if silent else "visible"
            print(f"  [expo push/{kind}] {ok}/{len(sent_tokens)} accepted by Expo")
        except urllib.error.HTTPError as e:
            # "HTTP Error 400: Bad Request" on its own says nothing, and this is
            # the one failure mode where Expo does explain itself: a 4xx body is
            # JSON carrying a `code` and a `message` that name the actual
            # problem. PUSH_TOO_MANY_EXPERIENCE_IDS -- push tokens minted by two
            # different EAS projects batched into one request -- is the usual
            # one after the project id changes, and it is invisible without this.
            try:
                body = e.read().decode('utf-8', 'replace')
            except Exception:
                body = '(no body)'
            print(f"  [expo push error] HTTP {e.code} {e.reason} -- {body[:600]}")
        except Exception as e:
            print(f"  [expo push error] {e}")

    await asyncio.to_thread(_do_post)
    if dead:
        await asyncio.to_thread(forget_push_tokens, dead)


# ---- check-ins: questions with a deadline -------------------------------
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


@app.post("/checkin/self")
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

    print(f"  {reason} check-in for {u['name']} - {left}s to answer")
    return {"ok": True, "checkin_id": checkin_id, "due_at": due_at,
            "reason": reason, "window": left}


@app.post("/checkin/{member_id}")
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


@app.post("/checkin/{checkin_id}/ack")
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


# ---- watch state: High Alert and the heartbeat --------------------------
def watch_row(c, uid):
    c.execute("INSERT INTO watch_state (user_id,last_beat) VALUES (%s,%s)"
              " ON CONFLICT (user_id) DO NOTHING", (uid, time.time()))
    return c.execute("SELECT * FROM watch_state WHERE user_id=%s", (uid,)).fetchone()


@app.post("/watch/high_alert")
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
            first = b.first_buzz_s if b.first_buzz_s is not None else \
                random.uniform(HIGH_ALERT_MIN_S, HIGH_ALERT_MAX_S)
            first = max(5, min(float(first), HIGH_ALERT_MAX_S))
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
            c.execute("UPDATE watch_state SET high_alert=FALSE, next_buzz_at=NULL, "
                      "mode=CASE WHEN mode='high_alert' THEN 'idle' ELSE mode END, "
                      "beat_armed=CASE WHEN mode='high_alert' THEN FALSE "
                      "                ELSE beat_armed END, "
                      "link_lost_at=CASE WHEN mode='high_alert' THEN NULL "
                      "                  ELSE link_lost_at END "
                      "WHERE user_id=%s",
                      (u["id"],))
            nxt = None
        c.commit()
    print(f"  high alert {'ON' if b.on else 'off'} for {u['name']}")
    await HUB.fanout(family_of(u["id"]), {
        "t": "watch_updated",
        "user_id": u["id"],
        "mode": "high_alert" if b.on else "idle"
    })
    return {"ok": True, "mode": "high_alert" if b.on else "idle", "next_buzz_at": nxt}


@app.post("/heartbeat")
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
        c.commit()

    # No alert is raised from here any more. A drop starts the grace window
    # (`link_lost_at`, written above) and the sweeper pages two minutes later
    # if the band has not come back. The two lines this endpoint can move
    # through are worth seeing in the log, because between them lies every
    # brief Bluetooth drop the family is deliberately not being told about.
    if nxt.link_lost_at is not None and prev.link_lost_at is None:
        print(f"  [watch_lost] {u['name']}: {decision.reason} "
              f"({int(WL.WATCH_LOST_DELAY_S)}s)")
    elif prev.link_lost_at is not None and nxt.link_lost_at is None:
        print(f"  [watch_lost] {u['name']}: {decision.reason} — nobody paged")
    return {"ok": True, "t": now}


@app.get("/watch/{member_id}")
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


# ---- B3.3 / B3.4: the Good Samaritan --------------------------------------
@app.post("/presence")
def put_presence(b: PresenceIn, u=Depends(me)):
    """Where you are, rounded, so a stranger's emergency can find you.

    One row per person, overwritten -- this is a presence, not a trail. It is
    stored at about a hundred metres, it is only read while it is fresh, and
    the only thing it is ever used for is deciding who to ask.
    """
    # The app posts this at most every five minutes (PRESENCE_EVERY_MS), but a
    # failed post clears its own throttle and retries on the next fix, so the
    # honest ceiling is well above the happy-path rate.
    LIMIT.check("presence", u["id"], 30, 600,
                "too many presence updates - wait a few minutes")
    lat, lon = round(b.lat, 3), round(b.lon, 3)
    with closing(db()) as c:
        c.execute("INSERT INTO presence (user_id,geohash6,lat,lon,at) VALUES (%s,%s,%s,%s,%s) "
                  "ON CONFLICT(user_id) DO UPDATE SET geohash6=excluded.geohash6, "
                  "lat=excluded.lat, lon=excluded.lon, at=excluded.at",
                  (u["id"], geohash(b.lat, b.lon), lat, lon, time.time()))
        c.commit()
    return {"ok": True, "geohash6": geohash(b.lat, b.lon)}


@app.post("/samaritan/{alert_id}/respond")
async def samaritan_respond(alert_id: int, u=Depends(me)):
    """"I'm going." The only thing that releases a name and an exact pin.

    Committing is the price of the detail, and it is logged with the responder
    against the alert -- so the person in trouble knows exactly who is on the
    way, and so a stranger who wanted the address rather than to help has to
    put their own name to the request.
    """
    # The one limit here that is about disclosure rather than load: this
    # endpoint hands out a name and an exact position, so the ceiling bounds
    # how many alert ids one account can walk. A genuine responder answers one
    # alert; thirty in ten minutes is not a person helping.
    LIMIT.check("samaritan_respond", u["id"], 30, 600,
                "too many responses - wait a few minutes")
    with closing(db()) as c:
        row = c.execute("SELECT * FROM alerts WHERE id=%s", (alert_id,)).fetchone()
        if not row:
            raise HTTPException(404, "no such alert")
        if row["severity"] < 5:
            raise HTTPException(403, "only a severity-5 alert asks for strangers")
        if row["resolved_at"]:
            raise HTTPException(410, "that alert has been stood down")
        at = time.time()
        c.execute("INSERT INTO samaritans VALUES (%s,%s,%s) ON CONFLICT DO NOTHING",
                  (alert_id, u["id"], at))
        first = c.execute(
            "INSERT INTO acks VALUES (%s,%s,%s) ON CONFLICT DO NOTHING"
            " RETURNING alert_id",
            (alert_id, u["id"], at)).fetchone() is not None
        c.commit()
        who = c.execute("SELECT id,name FROM users WHERE id=%s", (row["user_id"],)).fetchone()
        acks = acks_for([alert_id], c).get(alert_id, [])

    payload = alert_row(row, {"id": row["user_id"], "name": who["name"] if who else row["user_id"]},
                        acks)
    responder = {"id": u["id"], "name": u["name"]}
    await HUB.to(row["user_id"], {"t": "ack", "alert_id": alert_id, "at": at,
                                  "by": responder, "samaritan": True})
    await HUB.fanout(family_of(row["user_id"]),
                     {"t": "samaritan_on_way", "alert_id": alert_id, "by": responder})
    if first:
        _spawn(notify_owner_of_ack(row, responder, len(acks), samaritan=True),
               f"ack-push:{alert_id}:{u['id']}")
    return {"ok": True, "alert": payload}


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
# ---- live socket --------------------------------------------------------
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket, token: str = ""):
    with closing(db()) as c:
        u = c.execute("SELECT * FROM users WHERE token_hash=%s",
                      (tok_hash(token),)).fetchone()
    if not u:
        await ws.close(code=4401)
        return

    uid = u["id"]
    await ws.accept()
    HUB.add(uid, ws)
    print(f"  {u['name']} ({uid}) came online")
    try:
        await ws.send_text(json.dumps({"t": "ready", "user_id": uid, "name": u["name"]}))
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if msg.get("t") == "ping":
                await ws.send_text(json.dumps({"t": "pong"}))
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        HUB.drop(uid, ws)
        print(f"  {u['name']} ({uid}) went offline")


if __name__ == "__main__":
    import socket
    import uvicorn

    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80)); ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()

    # If a tunnel is already up, its address is the one worth printing: it is
    # the only one that works from a phone on mobile data.
    tunnel = None
    try:
        import urllib.request
        with urllib.request.urlopen("http://127.0.0.1:4040/api/tunnels", timeout=1) as r:
            for t in json.load(r).get("tunnels", []):
                if t.get("proto") == "https":
                    tunnel = t["public_url"]
                    break
    except Exception:
        pass

    print("=" * 66)
    print("  NIGEHBAN SERVER")
    print(f"  Same Wi-Fi:      http://{ip}:{PORT}")
    if tunnel:
        print(f"  From anywhere:   {tunnel}   <-- put this in the phones")
    else:
        print("  From anywhere:   run scripts/dev-tunnel.ps1 to open a tunnel")
    print("=" * 66)
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")
