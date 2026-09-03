"""
The sliding-window rate limiter, and the caller identity it buckets on.

Read the class docstring before adding a limit to anything: what is NOT
limited here is a set of deliberate decisions, and /heartbeat in particular is
one where a 429 would invent an emergency.
"""

import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request


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
