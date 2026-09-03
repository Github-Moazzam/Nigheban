"""
Accounts: register, sign in, who am I, settings, and the band PIN.
"""

import re
import secrets
import time
from contextlib import closing

from fastapi import APIRouter, Depends, HTTPException, Request

from server.db import db
from server.deps import me
from server.ratelimit import LIMIT, client_ip
from server.schemas import BandPinIn, LoginIn, RegisterIn, SettingsIn
from server.security import check_pw, hash_pw, new_code, tok_hash


router = APIRouter()


@router.post("/register")
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


@router.post("/login")
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
    return {
        "user_id": u["id"],
        "token": tok,
        "name": u["name"],
        "username": u["username"],
        "role": u["role"],
        "samaritan_enabled": u.get("samaritan_enabled", True) if u.get("samaritan_enabled") is not None else True,
    }


@router.get("/me")
def whoami(u=Depends(me)):
    # `role` is here so the app can re-read it on every launch. It is the only
    # field that can change underneath a signed-in phone -- promoting someone to
    # admin is done in the database, not in the app -- and without it the phone
    # would keep whatever role it was handed at sign-in until it signed in again.
    return {
        "user_id": u["id"],
        "name": u["name"],
        "username": u["username"],
        "role": u.get("role") or "user",
        "samaritan_enabled": u.get("samaritan_enabled", True) if u.get("samaritan_enabled") is not None else True,
    }


@router.patch("/me/settings")
def update_settings(b: SettingsIn, u=Depends(me)):
    with closing(db()) as c:
        if b.samaritan_enabled is not None:
            c.execute("UPDATE users SET samaritan_enabled=%s WHERE id=%s",
                      (b.samaritan_enabled, u["id"]))
            c.commit()
    return {"ok": True, "samaritan_enabled": b.samaritan_enabled}


# ---- the band PIN, held against the account ----------------------------
#
# Escrow for a six-digit wristband PIN, so a wearer who has forgotten it is not
# reduced to a factory reset -- which also wipes the band's name and forces
# every phone in the family to pair again.
#
# It exists because of a rule elsewhere that is correct and stays: pressing
# Disconnect makes the phone forget the PIN. That is what makes Disconnect a
# real answer to "somebody else has my phone", and it is also precisely what
# removes the local copy in the one situation somebody needs it back.
#
# READ server/migrations/009_band_pin_escrow.sql BEFORE TRUSTING THIS. The
# column is plaintext and has to be -- the entire purpose is to hand it back to
# a person, so it cannot be hashed. Anybody who can read the table, or sign in
# as the user, gets the PIN. This is an accepted interim position with the
# trade understood, not a finished design; the migration lists what replaces it.
#
# Three rules hold here regardless:
#
#   1. `band_pin` is never added to /me or /login. It leaves the server through
#      exactly one endpoint, the one below whose whole job is to return it.
#   2. Reads are rate limited per account. A stolen session should not be able
#      to walk anything, and this is the only endpoint that hands back a secret
#      it did not receive in the request.
#   3. It is never logged.


@router.put("/me/band-pin")
def put_band_pin(b: BandPinIn, u=Depends(me)):
    """Remember this account's band PIN. Called whenever the band accepts one."""
    pin = (b.band_pin or "").strip()
    if not (len(pin) == 6 and pin.isdigit()):
        raise HTTPException(400, "a band PIN is six digits")
    with closing(db()) as c:
        c.execute("UPDATE users SET band_pin=%s WHERE id=%s", (pin, u["id"]))
        c.commit()
    # Deliberately does not echo the PIN back. The caller already has it, and a
    # value that is never in a response is a value that is never in a log.
    return {"ok": True}


@router.get("/me/band-pin")
def get_band_pin(req: Request, u=Depends(me)):
    """Hand the PIN back to its owner. The app gates this behind its own PIN."""
    # Generous enough that a person retrying past a flaky tunnel is fine, tight
    # enough that a stolen token cannot be used to farm this quietly.
    LIMIT.check("band_pin_read", u["id"], 10, 3600,
                "too many attempts - wait a while")
    LIMIT.check("band_pin_read_ip", client_ip(req), 30, 3600,
                "too many attempts - wait a while")
    with closing(db()) as c:
        row = c.execute("SELECT band_pin FROM users WHERE id=%s",
                        (u["id"],)).fetchone()
    pin = (row or {}).get("band_pin") if row else None
    # `null` rather than a 404: "this account never stored one" is an ordinary
    # answer with its own screen behind it, not an error.
    return {"band_pin": pin}
