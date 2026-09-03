"""
Live websocket delivery, and the detached-task set that outlives a request.

HUB is a module-level singleton holding every open socket in the process, so
this module must be imported as `server.hub` from everywhere -- a second copy
would be a second registry that the first one cannot deliver to.

_spawn lives here rather than with the alerts because it is the same concern:
work that has to finish after the phone that triggered it has hung up.
"""

import asyncio
import json

from server.logging_setup import get_logger

log = get_logger(__name__)


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
            # Error, with the traceback: this task is a delivery nobody is
            # waiting on, so the log is the only place its failure exists.
            log.error("background task %s failed", name, exc_info=e)

    task.add_done_callback(_shout)
    return task
