"""
The live socket. One per signed-in phone; the registry is server/hub.py.
"""

import json
from contextlib import closing

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from server.db import db
from server.hub import HUB
from server.security import tok_hash


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
