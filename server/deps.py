"""
`me()` -- the FastAPI dependency every authenticated endpoint hangs off.

It is the single place a bearer token turns into a user row, which is why the
cache in front of it is here rather than spread across the routes.
"""

import time
from contextlib import closing
from typing import Optional

from fastapi import Header, HTTPException

from server.db import db
from server.security import tok_hash


# ---- in-memory auth cache ------------------------------------------------
# me() hits the DB on every authenticated request. With Mumbai that is ~25ms
# and with Tokyo it was ~200ms — per call, before the endpoint even starts.
# Caching the token->user lookup for 60s removes that cost entirely for all
# but the first request in each window.  The entry expires naturally; a login
# that changes token_hash simply means the old entry stops being looked up
# (the app switches to the new token) and ages out.
_AUTH_CACHE = {}          # token_hash -> (user_dict, expires_at)
AUTH_CACHE_TTL = 60       # seconds


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
