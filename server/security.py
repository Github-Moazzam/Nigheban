"""
Passwords, session tokens, and the user codes people read aloud.

Kept apart from the routes because these four functions are the ones worth
being able to reason about without a web framework in the frame.
"""

import hashlib
import secrets
from contextlib import closing

from fastapi import HTTPException

from server.db import db


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
