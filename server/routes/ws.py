"""
The live socket. One per signed-in phone; the registry is server/hub.py.
"""

import json
from contextlib import closing

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from server.db import db
from server.hub import HUB
from server.logging_setup import get_logger
from server.security import tok_hash


log = get_logger(__name__)

router = APIRouter()


# ---- live socket --------------------------------------------------------
@router.websocket("/ws")
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
    log.info("%s (%s) came online", u["name"], uid)
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
        # The ordinary way a socket ends: the app was closed, the screen went
        # off, the train went into a tunnel. Not worth a line.
        pass
    except Exception:
        # Anything else is a bug in here, and it used to be swallowed whole.
        # The symptom was invisible and looked like nothing at all: the socket
        # closed, the app reconnected 2.5 s later (see useLive in api.js), and
        # it did that for ever while the log stayed silent. A reconnect loop is
        # exactly what a flaky network looks like, so nobody would have gone
        # looking for a server-side exception.
        log.exception("socket for %s (%s) failed", u["name"], uid)
    finally:
        HUB.drop(uid, ws)
        log.info("%s (%s) went offline", u["name"], uid)
