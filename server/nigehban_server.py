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
    family links    who is allowed to see whose alerts (always mutual)
    alerts          every SOS, check-in and resolution, append-only
    delivery        a live WebSocket per signed-in phone

Routing rule, in one sentence: an alert raised by user X is pushed to every
user linked to X, and to nobody else.
"""

import asyncio
import hashlib
import json
import os
import re
import secrets
import sqlite3
import time
from contextlib import asynccontextmanager, closing
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

HERE = os.path.dirname(os.path.abspath(__file__))
DB_F = os.path.join(HERE, "nigehban.db")
PORT = 8000

SEVERITY = {
    "sos": 5, "snatch": 5, "fall": 4, "checkin_missed": 3,
    "checkin_req": 2, "checkin_ack": 1, "low_battery": 1, "sos_clear": 1,
}


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
        CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts(user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_links_member ON links(member_id);
        """)
        c.commit()


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


def new_code():
    """Short, unambiguous, readable aloud across a room. No O/0/I/1."""
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    with closing(db()) as c:
        for _ in range(50):
            code = "NGB-" + "".join(secrets.choice(alphabet) for _ in range(4))
            if not c.execute("SELECT 1 FROM users WHERE id=?", (code,)).fetchone():
                return code
    raise HTTPException(500, "could not allocate an id")


def me(authorization: Optional[str] = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "sign in first")
    tok = authorization[7:]
    with closing(db()) as c:
        u = c.execute("SELECT * FROM users WHERE token=?", (tok,)).fetchone()
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


class AddFamilyIn(BaseModel):
    code: str
    relation: str = ""


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
    print(f"\n  Nigehban server ready - db at {DB_F}\n")
    yield


app = FastAPI(title="Nigehban local server", lifespan=lifespan)


@app.get("/health")
def health():
    return {"ok": True, "t": time.time()}


@app.post("/register")
def register(b: RegisterIn):
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
        c.execute("INSERT INTO users VALUES (?,?,?,?,?,?)",
                  (uid, uname, hash_pw(b.password), b.name.strip(), tok, time.time()))
        c.commit()
    return {"user_id": uid, "token": tok, "name": b.name.strip(), "username": uname}


@app.post("/login")
def login(b: LoginIn):
    with closing(db()) as c:
        u = c.execute("SELECT * FROM users WHERE username=?",
                      (b.username.strip().lower(),)).fetchone()
        if not u or not check_pw(b.password, u["pw_hash"]):
            raise HTTPException(401, "wrong username or password")
        tok = secrets.token_hex(24)
        c.execute("UPDATE users SET token=? WHERE id=?", (tok, u["id"]))
        c.commit()
    return {"user_id": u["id"], "token": tok, "name": u["name"], "username": u["username"]}


@app.get("/me")
def whoami(u=Depends(me)):
    return {"user_id": u["id"], "name": u["name"], "username": u["username"]}


# ---- family -------------------------------------------------------------
@app.get("/family")
def family(u=Depends(me)):
    with closing(db()) as c:
        rows = c.execute("""
            SELECT us.id, us.name, us.username, l.relation, l.created_at
            FROM links l JOIN users us ON us.id = l.member_id
            WHERE l.owner_id = ? ORDER BY l.created_at
        """, (u["id"],)).fetchall()
    return [{**dict(r), "online": HUB.online(r["id"])} for r in rows]


@app.post("/family")
async def add_family(b: AddFamilyIn, u=Depends(me)):
    code = b.code.strip().upper()
    if not code.startswith("NGB-"):
        code = "NGB-" + code
    if code == u["id"]:
        raise HTTPException(400, "that is your own code")

    with closing(db()) as c:
        other = c.execute("SELECT * FROM users WHERE id=?", (code,)).fetchone()
        if not other:
            raise HTTPException(404, f"no one is using the code {code}")
        now = time.time()
        # Family is mutual: adding someone means you each see the other's
        # alerts. One-way links produce the demo-day surprise where the parent
        # sees the child but the child never sees the parent's check-in.
        c.execute("INSERT OR IGNORE INTO links VALUES (?,?,?,?)",
                  (u["id"], other["id"], b.relation, now))
        c.execute("INSERT OR IGNORE INTO links VALUES (?,?,?,?)",
                  (other["id"], u["id"], "", now))
        c.commit()

    await HUB.to(other["id"], {"t": "family_added",
                               "user": {"id": u["id"], "name": u["name"]}})
    return {"ok": True, "member": {"id": other["id"], "name": other["name"],
                                   "username": other["username"]}}


@app.delete("/family/{member_id}")
def remove_family(member_id: str, u=Depends(me)):
    with closing(db()) as c:
        c.execute("DELETE FROM links WHERE (owner_id=? AND member_id=?) "
                  "OR (owner_id=? AND member_id=?)",
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


@app.post("/alert")
async def raise_alert(b: AlertIn, u=Depends(me)):
    sev = SEVERITY.get(b.kind, 3)
    with closing(db()) as c:
        cur = c.execute(
            "INSERT INTO alerts (user_id,kind,severity,source,lat,lon,accuracy,note,created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (u["id"], b.kind, sev, b.source, b.lat, b.lon, b.accuracy, b.note, time.time()))
        c.commit()
        row = c.execute("SELECT * FROM alerts WHERE id=?", (cur.lastrowid,)).fetchone()

    author = {"id": u["id"], "name": u["name"]}
    payload = alert_row(row, author)
    targets = family_of(u["id"])
    await HUB.fanout(targets, {"t": "alert", "alert": payload})

    print(f"  [{b.kind}] from {u['name']} ({u['id']}) -> "
          f"{len(targets)} family member(s), {sum(HUB.online(t) for t in targets)} online")
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


# ---- checking in on someone --------------------------------------------
@app.post("/checkin/{member_id}")
async def request_checkin(member_id: str, u=Depends(me)):
    """A parent asking 'are you okay?'. Only works inside the family."""
    with closing(db()) as c:
        ok = c.execute("SELECT 1 FROM links WHERE owner_id=? AND member_id=?",
                       (member_id, u["id"])).fetchone()
    if not ok:
        raise HTTPException(403, "they are not in your family list")
    await HUB.to(member_id, {"t": "checkin_req",
                             "from": {"id": u["id"], "name": u["name"]}})
    return {"ok": True, "online": HUB.online(member_id)}


# ---- live socket --------------------------------------------------------
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket, token: str = ""):
    with closing(db()) as c:
        u = c.execute("SELECT * FROM users WHERE token=?", (token,)).fetchone()
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

    print("=" * 62)
    print("  NIGEHBAN SERVER")
    print(f"  Put this in both phones:   http://{ip}:{PORT}")
    print("=" * 62)
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")
