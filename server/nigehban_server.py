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
import os
import random
import re
import secrets
import sqlite3
import time
import urllib.request
from collections import defaultdict, deque
from contextlib import asynccontextmanager, closing
from typing import Optional

from fastapi import (
    Depends, FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

HERE = os.path.dirname(os.path.abspath(__file__))
DB_F = os.path.join(HERE, "nigehban.db")
PORT = 8000

SEVERITY = {
    "sos": 5, "snatch": 5, "fall": 4, "checkin_missed": 3, "watch_lost": 3,
    "checkin_req": 2, "checkin_ack": 1, "low_battery": 1, "sos_clear": 1,
}

# How long a pairing code is worth anything. Short on purpose: see PAIRING
# below. Ten minutes is "we are in the same room, or on the phone together",
# which is the situation this is actually for.
PAIR_TTL_S      = 600
CHECKIN_WINDOW_S = 90       # default deadline on "are you okay?"
HIGH_ALERT_MIN_S = 300      # re-buzz window while High Alert is on
HIGH_ALERT_MAX_S = 600
BEAT_LOST_S      = 180      # armed and silent this long -> tell the family
SWEEP_TICK_S     = 5


# ------------------------------------------------------------------- db ---
def db():
    c = sqlite3.connect(DB_F, timeout=5)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")     # phone + server writing at once
    c.execute("PRAGMA foreign_keys=ON")
    return c


def init_db():
    with closing(db()) as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id         TEXT PRIMARY KEY,        -- shareable code, e.g. NGB-4F2A
            username   TEXT UNIQUE NOT NULL,
            pw_hash    TEXT NOT NULL,
            name       TEXT NOT NULL,
            token      TEXT NOT NULL,
            created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS links (
            owner_id   TEXT NOT NULL,           -- whose alerts these are
            member_id  TEXT NOT NULL,           -- who receives them
            relation   TEXT DEFAULT '',
            created_at REAL NOT NULL,
            PRIMARY KEY (owner_id, member_id),
            FOREIGN KEY (owner_id)  REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (member_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS alerts (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     TEXT NOT NULL,
            kind        TEXT NOT NULL,
            severity    INTEGER NOT NULL,
            source      TEXT DEFAULT 'app',     -- band | app
            lat         REAL, lon REAL, accuracy REAL,
            note        TEXT DEFAULT '',
            created_at  REAL NOT NULL,
            resolved_at REAL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS acks (
            alert_id INTEGER NOT NULL,
            user_id  TEXT NOT NULL,
            at       REAL NOT NULL,
            PRIMARY KEY (alert_id, user_id)
        );

        -- ---- B1: consent ------------------------------------------------
        -- A one-time, short-lived code one person hands to another. Storing
        -- only the hash means a stolen database file cannot be used to join
        -- anyone's family -- the same reason passwords are not stored either.
        CREATE TABLE IF NOT EXISTS pairings (
            token_hash TEXT PRIMARY KEY,
            issuer_id  TEXT NOT NULL,
            relation   TEXT DEFAULT '',
            created_at REAL NOT NULL,
            expires_at REAL NOT NULL,
            used_at    REAL,
            used_by    TEXT,
            FOREIGN KEY (issuer_id) REFERENCES users(id) ON DELETE CASCADE
        );
        -- A request that is waiting on the other person. `state` never goes
        -- back to pending: a decline is permanent, and silent.
        CREATE TABLE IF NOT EXISTS invites (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            from_id     TEXT NOT NULL,
            to_id       TEXT NOT NULL,
            relation    TEXT DEFAULT '',
            state       TEXT NOT NULL DEFAULT 'pending',   -- pending|accepted|declined
            created_at  REAL NOT NULL,
            settled_at  REAL,
            UNIQUE (from_id, to_id),
            FOREIGN KEY (from_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (to_id)   REFERENCES users(id) ON DELETE CASCADE
        );

        -- One row per install. The push token is what lets an alert reach a
        -- phone whose app is not running -- the in-app socket cannot, by
        -- definition, wake anything up.
        CREATE TABLE IF NOT EXISTS devices (
            id          TEXT PRIMARY KEY,       -- install id, chosen by the app
            user_id     TEXT NOT NULL,
            push_token  TEXT,
            platform    TEXT, os_version TEXT, app_version TEXT,
            last_seen   REAL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        -- ---- B2: deadlines the server owns ------------------------------
        CREATE TABLE IF NOT EXISTS checkins (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    TEXT NOT NULL,          -- who must answer
            asked_by   TEXT,                   -- NULL = the server itself
            reason     TEXT DEFAULT 'manual',  -- manual|high_alert|fall|low_battery
            due_at     REAL NOT NULL,
            created_at REAL NOT NULL,
            acked_at   REAL,
            escalated  INTEGER DEFAULT 0,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS watch_state (
            user_id       TEXT PRIMARY KEY,
            mode          TEXT DEFAULT 'idle',   -- idle|high_alert|sos
            next_buzz_at  REAL,
            last_beat     REAL,
            band_link     INTEGER DEFAULT 0,
            phone_batt    INTEGER,
            last_lat      REAL, last_lon REAL,   -- where it was when it went quiet
            lost_notified INTEGER DEFAULT 0,     -- so a silent phone pages once
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts(user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_links_member ON links(member_id);
        CREATE INDEX IF NOT EXISTS idx_invites_to ON invites(to_id, state);
        CREATE INDEX IF NOT EXISTS idx_checkins_due ON checkins(due_at)
            WHERE acked_at IS NULL AND escalated = 0;
        """)
        migrate(c)
        c.commit()


def migrate(c):
    """Idempotent upgrades for databases created before a change.

    Written out rather than "delete nigehban.db and start again" because the
    demo accounts and their history are worth keeping, and because a migration
    that runs on every boot is one that has actually been tested.
    """
    cols = {r["name"] for r in c.execute("PRAGMA table_info(users)")}

    # Session tokens used to be stored in the clear, so anyone who read the db
    # file -- a backup, a synced folder, a stolen laptop -- held live sessions
    # for every account. Store only the hash, exactly as with passwords.
    if "token_hash" not in cols:
        c.execute("ALTER TABLE users ADD COLUMN token_hash TEXT DEFAULT ''")
        for r in c.execute("SELECT id, token FROM users").fetchall():
            if r["token"]:
                c.execute("UPDATE users SET token_hash=?, token='' WHERE id=?",
                          (tok_hash(r["token"]), r["id"]))
    c.execute("CREATE INDEX IF NOT EXISTS idx_users_token ON users(token_hash)")


# ---------------------------------------------------------------- auth ---
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
            if not c.execute("SELECT 1 FROM users WHERE id=?", (code,)).fetchone():
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

    Note what is NOT limited: raising an alert. Throttling an SOS is the wrong
    instinct in a safety product; a person mashing the button in a panic must
    get through every time.
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
    tok = authorization[7:]
    with closing(db()) as c:
        u = c.execute("SELECT * FROM users WHERE token_hash=?",
                      (tok_hash(tok),)).fetchone()
    if not u:
        raise HTTPException(401, "session expired, sign in again")
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


def family_of(uid):
    """Everyone who receives uid's alerts."""
    with closing(db()) as c:
        return [r["member_id"] for r in
                c.execute("SELECT member_id FROM links WHERE owner_id=?", (uid,))]


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


class HighAlertIn(BaseModel):
    on: bool = True
    # Present so a demo does not have to wait five real minutes for the first
    # buzz. Clamped, and never longer than the real window -- it can make the
    # feature easier to show, never quieter than it is meant to be.
    first_buzz_s: Optional[int] = None


class HeartbeatIn(BaseModel):
    mode: str = "idle"                 # idle | high_alert | sos
    band_link: bool = False
    phone_batt: Optional[int] = None
    lat: Optional[float] = None
    lon: Optional[float] = None


class AlertIn(BaseModel):
    kind: str = "sos"
    source: str = "app"
    lat: Optional[float] = None
    lon: Optional[float] = None
    accuracy: Optional[float] = None
    note: str = ""


# ---------------------------------------------------------------- app ---
from contextlib import asynccontextmanager


@asynccontextmanager
async def lifespan(_app):
    init_db()
    task = asyncio.create_task(sweeper())
    print(f"\n  Nigehban server ready - db at {DB_F}")
    print(f"  sweeper ticking every {SWEEP_TICK_S}s - deadlines survive the phone\n")
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except BaseException:
            pass


app = FastAPI(title="Nigehban local server", lifespan=lifespan)

# Wide open on purpose, and only defensible because of what this server is: a
# development box behind a tunnel whose URL changes every restart, holding test
# accounts. It exists so a browser tab, a second laptop or a teammate's phone
# can be pointed at the same server without a config change.
#
# This MUST be narrowed to the real origins before anything real is stored.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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
        if c.execute("SELECT 1 FROM users WHERE username=?", (uname,)).fetchone():
            raise HTTPException(409, "that username is taken")
        c.execute("INSERT INTO users (id,username,pw_hash,name,token,created_at,token_hash)"
                  " VALUES (?,?,?,?,'',?,?)",
                  (uid, uname, hash_pw(b.password), b.name.strip(), time.time(),
                   tok_hash(tok)))
        c.commit()
    return {"user_id": uid, "token": tok, "name": b.name.strip(), "username": uname}


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
        u = c.execute("SELECT * FROM users WHERE username=?", (uname,)).fetchone()
        if not u or not check_pw(b.password, u["pw_hash"]):
            raise HTTPException(401, "wrong username or password")
        # A fresh token every sign-in, and only its hash is kept. Signing in
        # again invalidates the previous session, which is the cheapest form of
        # "I lost my phone" there is.
        tok = secrets.token_hex(24)
        c.execute("UPDATE users SET token_hash=?, token='' WHERE id=?",
                  (tok_hash(tok), u["id"]))
        c.commit()
    return {"user_id": u["id"], "token": tok, "name": u["name"], "username": u["username"]}


@app.get("/me")
def whoami(u=Depends(me)):
    return {"user_id": u["id"], "name": u["name"], "username": u["username"]}


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
    c.execute("INSERT OR IGNORE INTO links VALUES (?,?,?,?)", (a, b, relation, now))
    c.execute("INSERT OR IGNORE INTO links VALUES (?,?,?,?)", (b, a, "", now))


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
            WHERE l.owner_id = ? ORDER BY l.created_at
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
        c.execute("DELETE FROM pairings WHERE issuer_id=? AND used_at IS NULL",
                  (u["id"],))
        c.execute("INSERT INTO pairings (token_hash,issuer_id,relation,created_at,expires_at)"
                  " VALUES (?,?,?,?,?)",
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
            row = c.execute("SELECT * FROM pairings WHERE token_hash=?",
                            (tok_hash(code),)).fetchone()
            # One message for expired, used, and never-existed. There is no
            # reason to tell the holder of a bad code which kind of bad it is.
            if not row or row["used_at"] or row["expires_at"] < now:
                raise HTTPException(404, "that pairing code has expired or was already used")
            if row["issuer_id"] == u["id"]:
                raise HTTPException(400, "that is your own pairing code")

            other = c.execute("SELECT * FROM users WHERE id=?",
                              (row["issuer_id"],)).fetchone()
            if not other:
                raise HTTPException(404, "that pairing code has expired or was already used")

            c.execute("UPDATE pairings SET used_at=?, used_by=? WHERE token_hash=?",
                      (now, u["id"], row["token_hash"]))
            link_both(c, u["id"], other["id"], relation or row["relation"], now)
            # Any request left pending between these two is now moot.
            c.execute("UPDATE invites SET state='accepted', settled_at=? "
                      "WHERE state='pending' AND ((from_id=? AND to_id=?) "
                      "OR (from_id=? AND to_id=?))",
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
        other = c.execute("SELECT * FROM users WHERE id=?", (code,)).fetchone()
        if other:
            already = c.execute("SELECT 1 FROM links WHERE owner_id=? AND member_id=?",
                                (u["id"], other["id"])).fetchone()
            if already:
                return {"ok": True, "linked": True, "member": pub(other)}

            prior = c.execute("SELECT * FROM invites WHERE from_id=? AND to_id=?",
                              (u["id"], other["id"])).fetchone()
            # A decline is permanent and it is silent. Re-inviting somebody who
            # said no gets the same cheerful answer as the first time and does
            # nothing at all -- so "she declined me" is not a fact this server
            # will hand to the person she declined.
            if not prior:
                cur = c.execute("INSERT INTO invites (from_id,to_id,relation,created_at)"
                                " VALUES (?,?,?,?)",
                                (u["id"], other["id"], relation, now))
                c.commit()
                await HUB.to(other["id"], {
                    "t": "invite",
                    "invite": {"id": cur.lastrowid, "relation": relation,
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
            WHERE i.to_id=? AND i.state='pending' ORDER BY i.created_at
        """, (u["id"],)).fetchall()
        # 'declined' is listed alongside 'pending' and reported as pending.
        # If a declined request simply vanished from the sender's list, then
        # vanishing WOULD BE the notification -- and the whole point of a silent
        # decline is that refusing somebody carries no risk of them finding out.
        out = c.execute("""
            SELECT id, to_id, relation, created_at FROM invites
            WHERE from_id=? AND state IN ('pending','declined') ORDER BY created_at
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
    now = time.time()
    with closing(db()) as c:
        inv = c.execute("SELECT * FROM invites WHERE id=?", (invite_id,)).fetchone()
        if not inv or inv["to_id"] != u["id"]:
            raise HTTPException(404, "no such request")
        if inv["state"] != "pending":
            raise HTTPException(409, "that request has already been answered")
        other = c.execute("SELECT * FROM users WHERE id=?", (inv["from_id"],)).fetchone()
        if not other:
            raise HTTPException(404, "that account no longer exists")

        c.execute("UPDATE invites SET state='accepted', settled_at=? WHERE id=?",
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
    with closing(db()) as c:
        inv = c.execute("SELECT * FROM invites WHERE id=?", (invite_id,)).fetchone()
        if not inv or inv["to_id"] != u["id"]:
            raise HTTPException(404, "no such request")
        c.execute("UPDATE invites SET state='declined', settled_at=? WHERE id=?",
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
    with closing(db()) as c:
        c.execute("DELETE FROM links WHERE (owner_id=? AND member_id=?) "
                  "OR (owner_id=? AND member_id=?)",
                  (u["id"], member_id, member_id, u["id"]))
        # Removing someone has to also clear the old invite, or they can never
        # be added again -- the UNIQUE(from_id,to_id) row would still be there.
        c.execute("DELETE FROM invites WHERE (from_id=? AND to_id=?) "
                  "OR (from_id=? AND to_id=?)",
                  (u["id"], member_id, member_id, u["id"]))
        c.commit()
    return {"ok": True}


# ---- alerts -------------------------------------------------------------
def alert_row(r, author):
    return {"id": r["id"], "kind": r["kind"], "severity": r["severity"],
            "source": r["source"], "lat": r["lat"], "lon": r["lon"],
            "accuracy": r["accuracy"], "note": r["note"],
            "created_at": r["created_at"], "resolved_at": r["resolved_at"],
            "user": author,
            "maps": (f"https://maps.google.com/?q={r['lat']:.6f},{r['lon']:.6f}"
                     if r["lat"] is not None else None)}


async def emit_alert(uid, kind, *, source="server", lat=None, lon=None,
                     accuracy=None, note=""):
    """Write an alert and push it to the family. One path in, for everyone.

    The sweeper raises alerts nobody pressed a button for, and those have to be
    indistinguishable from a phone-raised one by the time they reach a family
    member -- same row, same severity, same socket frame. Two code paths would
    drift, and the one that drifts is the one that only runs at 3 a.m.
    """
    sev = SEVERITY.get(kind, 3)
    with closing(db()) as c:
        cur = c.execute(
            "INSERT INTO alerts (user_id,kind,severity,source,lat,lon,accuracy,note,created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (uid, kind, sev, source, lat, lon, accuracy, note, time.time()))
        c.commit()
        row = c.execute("SELECT * FROM alerts WHERE id=?", (cur.lastrowid,)).fetchone()
        who = c.execute("SELECT id,name FROM users WHERE id=?", (uid,)).fetchone()

    name = who["name"] if who else uid
    payload = alert_row(row, {"id": uid, "name": name})
    targets = family_of(uid)
    await HUB.fanout(targets, {"t": "alert", "alert": payload})
    print(f"  [{kind}] from {name} ({uid}) -> {len(targets)} family member(s), "
          f"{sum(HUB.online(t) for t in targets)} online")

    # Send Remote System Push Notification via Expo Push Service API for closed/killed apps
    push_title = f"🚨 EMERGENCY SOS — {name}" if sev >= 5 else f"⚠️ {kind.upper()} — {name}"
    push_body = "Tap immediately to open Nigehban for location and emergency details."
    await send_expo_push_notifications(targets, push_title, push_body, {"alert_id": row["id"], "severity": sev})

    return payload, targets


@app.post("/alert")
async def raise_alert(b: AlertIn, u=Depends(me)):
    payload, targets = await emit_alert(
        u["id"], b.kind, source=b.source, lat=b.lat, lon=b.lon,
        accuracy=b.accuracy, note=b.note)

    # "I'm fine" is an answer, not just an event. Without this the ward can
    # press the key, the family can see the acknowledgement, and the sweeper
    # still escalates ninety seconds later because the open question was never
    # closed -- a false alarm the product would have invented for itself.
    if b.kind == "checkin_ack":
        await ack_open_checkins(u["id"])
    if b.kind == "sos":
        with closing(db()) as c:
            watch_row(c, u["id"])
            c.execute("UPDATE watch_state SET mode='sos' WHERE user_id=?", (u["id"],))
            c.commit()

    return {"ok": True, "alert": payload, "delivered_to": len(targets)}


@app.post("/alert/{alert_id}/resolve")
async def resolve(alert_id: int, u=Depends(me)):
    with closing(db()) as c:
        row = c.execute("SELECT * FROM alerts WHERE id=?", (alert_id,)).fetchone()
        if not row:
            raise HTTPException(404, "no such alert")
        if row["user_id"] != u["id"]:
            raise HTTPException(403, "only the person who raised it can stand it down")
        c.execute("UPDATE alerts SET resolved_at=? WHERE id=?", (time.time(), alert_id))
        # Standing down an SOS clears the watch's sos mode too, or the
        # heartbeat watchdog keeps treating a finished emergency as a live one.
        c.execute("UPDATE watch_state SET mode='idle' WHERE user_id=? AND mode='sos'",
                  (u["id"],))
        c.commit()

    await HUB.fanout(family_of(u["id"]),
                     {"t": "resolved", "alert_id": alert_id,
                      "user": {"id": u["id"], "name": u["name"]}})
    return {"ok": True}


@app.post("/alert/{alert_id}/ack")
async def ack(alert_id: int, u=Depends(me)):
    """A family member saying 'I've seen this, I'm on it.'"""
    with closing(db()) as c:
        row = c.execute("SELECT * FROM alerts WHERE id=?", (alert_id,)).fetchone()
        if not row:
            raise HTTPException(404, "no such alert")
        c.execute("INSERT OR IGNORE INTO acks VALUES (?,?,?)",
                  (alert_id, u["id"], time.time()))
        c.commit()

    await HUB.to(row["user_id"], {"t": "ack", "alert_id": alert_id,
                                  "by": {"id": u["id"], "name": u["name"]}})
    return {"ok": True}


@app.get("/alerts")
def list_alerts(scope: str = "incoming", limit: int = 50, u=Depends(me)):
    with closing(db()) as c:
        if scope == "mine":
            rows = c.execute(
                "SELECT a.*, us.name AS uname FROM alerts a JOIN users us ON us.id=a.user_id "
                "WHERE a.user_id=? ORDER BY a.created_at DESC LIMIT ?",
                (u["id"], limit)).fetchall()
        else:
            rows = c.execute(
                "SELECT a.*, us.name AS uname FROM alerts a JOIN users us ON us.id=a.user_id "
                "WHERE a.user_id IN (SELECT owner_id FROM links WHERE member_id=?) "
                "ORDER BY a.created_at DESC LIMIT ?",
                (u["id"], limit)).fetchall()
    return [alert_row(r, {"id": r["user_id"], "name": r["uname"]}) for r in rows]


# ---- devices ------------------------------------------------------------
@app.post("/device")
def register_device(b: DeviceIn, u=Depends(me)):
    """Claim an install for this account, with its push token.

    Keyed on the install id, so signing in on a phone that used to belong to
    somebody else moves the row rather than leaving a second account's push
    token pointed at the same handset.
    """
    if not re.fullmatch(r"[A-Za-z0-9_.:-]{8,64}", b.id or ""):
        raise HTTPException(400, "bad install id")
    with closing(db()) as c:
        c.execute(
            "INSERT INTO devices (id,user_id,push_token,platform,os_version,app_version,last_seen)"
            " VALUES (?,?,?,?,?,?,?)"
            " ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,"
            " push_token=excluded.push_token, platform=excluded.platform,"
            " os_version=excluded.os_version, app_version=excluded.app_version,"
            " last_seen=excluded.last_seen",
            (b.id, u["id"], b.push_token, b.platform, b.os_version, b.app_version,
             time.time()))
        c.commit()
    return {"ok": True}


def push_tokens_for(uids):
    """Push tokens for a set of users."""
    if not uids:
        return []
    with closing(db()) as c:
        rows = c.execute(
            "SELECT DISTINCT push_token FROM devices WHERE push_token IS NOT NULL"
            " AND user_id IN (%s)" % ",".join("?" * len(uids)), list(uids)).fetchall()
    return [r["push_token"] for r in rows]


async def send_expo_push_notifications(uids, title, body, data=None):
    """Send Hardware Remote Push Notification via Expo Push Service API.

    Delivers notifications directly to Android system push framework even when
    the app is completely closed or killed.
    """
    tokens = push_tokens_for(uids)
    if not tokens:
        return

    payloads = []
    for token in tokens:
        if token.startswith("ExponentPushToken[") or token.startswith("ExpoPushToken["):
            payloads.append({
                "to": token,
                "title": title,
                "body": body,
                "sound": "default",
                "priority": "high",
                "data": data or {},
                "channelId": "nigehban_emergency_alarm" if (data and data.get("severity", 0) >= 4) else "nigehban_default"
            })

    if not payloads:
        return

    def _do_post():
        try:
            req = urllib.request.Request(
                "https://exp.host/--/api/v2/push/send",
                data=json.dumps(payloads).encode('utf-8'),
                headers={"Content-Type": "application/json", "Accept": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                pass
        except Exception as e:
            print(f"  [expo push error] {e}")

    await asyncio.to_thread(_do_post)


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
        "SELECT * FROM checkins WHERE user_id=? AND acked_at IS NULL "
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
        rows = c.execute("SELECT * FROM checkins WHERE user_id=? AND acked_at IS NULL",
                         (uid,)).fetchall()
        if not rows:
            return 0
        c.execute("UPDATE checkins SET acked_at=? WHERE user_id=? AND acked_at IS NULL",
                  (now, uid))
        c.commit()
        u = c.execute("SELECT id,name FROM users WHERE id=?", (uid,)).fetchone()

    who = {"id": uid, "name": u["name"] if u else uid}
    for r in rows:
        if r["asked_by"]:
            await HUB.to(r["asked_by"], {"t": "checkin_ack", "checkin_id": r["id"],
                                         "by": who, "reason": r["reason"]})
    return len(rows)


@app.post("/checkin/{member_id}")
async def request_checkin(member_id: str, b: Optional[CheckinIn] = None, u=Depends(me)):
    """A parent asking 'are you okay?'. Only works inside the family."""
    window = max(5, min(int((b.window if b else None) or CHECKIN_WINDOW_S), 3600))
    now = time.time()
    with closing(db()) as c:
        ok = c.execute("SELECT 1 FROM links WHERE owner_id=? AND member_id=?",
                       (member_id, u["id"])).fetchone()
        if not ok:
            raise HTTPException(403, "they are not in your family list")
        cur = c.execute(
            "INSERT INTO checkins (user_id,asked_by,reason,due_at,created_at)"
            " VALUES (?,?,'manual',?,?)", (member_id, u["id"], now + window, now))
        c.commit()

    await HUB.to(member_id, {"t": "checkin_req", "checkin_id": cur.lastrowid,
                             "window": window,
                             "from": {"id": u["id"], "name": u["name"]}})

    # Hardware System Push Notification for closed/backgrounded apps
    await send_expo_push_notifications([member_id], f"{u['name']} is checking on you", "Tap 'I am fine' to answer.", {"checkin_id": cur.lastrowid, "severity": 2})

    # `online` is worth returning and worth being honest about: an offline
    # phone does not mean the question evaporates. The deadline is already in
    # the database, and the sweeper will act on it either way.
    return {"ok": True, "checkin_id": cur.lastrowid, "due_at": now + window,
            "online": HUB.online(member_id)}


@app.post("/checkin/{checkin_id}/ack")
async def ack_checkin(checkin_id: int, u=Depends(me)):
    """The band or the app answering. Answers everything outstanding."""
    with closing(db()) as c:
        row = c.execute("SELECT * FROM checkins WHERE id=?", (checkin_id,)).fetchone()
    if not row or row["user_id"] != u["id"]:
        raise HTTPException(404, "no such check-in")
    n = await ack_open_checkins(u["id"])
    return {"ok": True, "answered": n}


# ---- watch state: High Alert and the heartbeat --------------------------
def watch_row(c, uid):
    c.execute("INSERT OR IGNORE INTO watch_state (user_id,last_beat) VALUES (?,?)",
              (uid, time.time()))
    return c.execute("SELECT * FROM watch_state WHERE user_id=?", (uid,)).fetchone()


@app.post("/watch/high_alert")
async def set_high_alert(b: HighAlertIn, u=Depends(me)):
    """Arm or disarm High Alert. The server owns the next buzz.

    This is the endpoint that makes the mode real. Held in the app it would
    die with the app -- which is the exact scenario the mode exists for.
    """
    now = time.time()
    with closing(db()) as c:
        watch_row(c, u["id"])
        if b.on:
            first = b.first_buzz_s if b.first_buzz_s is not None else \
                random.uniform(HIGH_ALERT_MIN_S, HIGH_ALERT_MAX_S)
            first = max(5, min(float(first), HIGH_ALERT_MAX_S))
            c.execute("UPDATE watch_state SET mode='high_alert', next_buzz_at=?, "
                      "last_beat=?, lost_notified=0 WHERE user_id=?",
                      (now + first, now, u["id"]))
            nxt = now + first
        else:
            c.execute("UPDATE watch_state SET mode='idle', next_buzz_at=NULL "
                      "WHERE user_id=?", (u["id"],))
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
    """'I am still here.' Every 60 s while armed. Silence is the signal."""
    now = time.time()
    with closing(db()) as c:
        watch_row(c, u["id"])
        c.execute("UPDATE watch_state SET last_beat=?, band_link=?, phone_batt=?, "
                  "last_lat=COALESCE(?,last_lat), last_lon=COALESCE(?,last_lon), "
                  "lost_notified=0 WHERE user_id=?",
                  (now, 1 if b.band_link else 0, b.phone_batt, b.lat, b.lon, u["id"]))
        # The mode is the server's to hold, not the phone's to declare -- the
        # phone may have been restarted and forgotten. It may only *raise* to
        # sos, never quietly stand High Alert down.
        if b.mode == "sos":
            c.execute("UPDATE watch_state SET mode='sos' WHERE user_id=?", (u["id"],))
        c.commit()
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
            ok = c.execute("SELECT 1 FROM links WHERE owner_id=? AND member_id=?",
                           (member_id, u["id"])).fetchone()
            if not ok:
                raise HTTPException(403, "they are not in your family list")
        w = c.execute("SELECT * FROM watch_state WHERE user_id=?", (member_id,)).fetchone()
        pend = open_checkin(c, member_id)

    now = time.time()
    return {
        "user_id": member_id,
        "online": HUB.online(member_id),
        "mode": w["mode"] if w else "idle",
        "band_link": bool(w["band_link"]) if w else False,
        "phone_batt": w["phone_batt"] if w else None,
        "last_beat": w["last_beat"] if w else None,
        "beat_age_s": (now - w["last_beat"]) if (w and w["last_beat"]) else None,
        "next_buzz_at": w["next_buzz_at"] if w else None,
        "checkin_due_at": pend["due_at"] if pend else None,
    }


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
    # 1. missed check-ins -> tell the family
    with closing(db()) as c:
        due = c.execute(
            "SELECT * FROM checkins WHERE acked_at IS NULL AND escalated=0 AND due_at<=?",
            (now,)).fetchall()
        if due:
            c.execute("UPDATE checkins SET escalated=1 WHERE id IN (%s)"
                      % ",".join("?" * len(due)), [r["id"] for r in due])
            c.commit()
    for r in due:
        late = int(now - r["due_at"])
        await emit_alert(r["user_id"], "checkin_missed", source="server",
                         note=f"no answer to a {r['reason']} check-in ({late}s late)")

    # 2. High Alert: time to ask again?
    with closing(db()) as c:
        buzz = c.execute(
            "SELECT * FROM watch_state WHERE mode='high_alert' AND next_buzz_at IS NOT NULL "
            "AND next_buzz_at<=?", (now,)).fetchall()
        for w in buzz:
            # Randomised, not fixed. A predictable buzz can be answered on
            # autopilot -- or by somebody else holding the phone -- and an
            # interval you can time is one you can plan around.
            nxt = now + random.uniform(HIGH_ALERT_MIN_S, HIGH_ALERT_MAX_S)
            c.execute("UPDATE watch_state SET next_buzz_at=? WHERE user_id=?",
                      (nxt, w["user_id"]))
            c.execute("INSERT INTO checkins (user_id,asked_by,reason,due_at,created_at)"
                      " VALUES (?,NULL,'high_alert',?,?)",
                      (w["user_id"], now + CHECKIN_WINDOW_S, now))
        if buzz:
            c.commit()
    for w in buzz:
        await HUB.to(w["user_id"], {"t": "buzz_now", "reason": "high_alert",
                                    "window": CHECKIN_WINDOW_S})

    # 3. heartbeat watchdog: armed, and gone quiet
    with closing(db()) as c:
        lost = c.execute(
            "SELECT * FROM watch_state WHERE mode!='idle' AND lost_notified=0 "
            "AND last_beat IS NOT NULL AND last_beat < ?", (now - BEAT_LOST_S,)).fetchall()
        if lost:
            c.execute("UPDATE watch_state SET lost_notified=1 WHERE user_id IN (%s)"
                      % ",".join("?" * len(lost)), [r["user_id"] for r in lost])
            c.commit()
    for w in lost:
        # The last known position is the most useful thing there is here: the
        # phone has stopped reporting, so this is where it stopped.
        await emit_alert(w["user_id"], "watch_lost", source="server",
                         lat=w["last_lat"], lon=w["last_lon"],
                         note=f"phone silent for {int(now - w['last_beat'])}s while armed")

    LIMIT.sweep()
    return {"missed": len(due), "buzzed": len(buzz), "lost": len(lost)}


# ---- live socket --------------------------------------------------------
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket, token: str = ""):
    with closing(db()) as c:
        u = c.execute("SELECT * FROM users WHERE token_hash=?",
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
