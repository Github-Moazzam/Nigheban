#!/usr/bin/env python3
"""
NIGEHBAN BRIDGE — puts the hub's brain on the local network.

The laptop keeps the BLE link to the band (that part already works). This adds
a small WebSocket server so phones can watch and steer it:

    ward phone      shows status, streams real GPS up, taps "I'm OK"
    guardian phone  sees alerts, sees the ward on a map, asks for a check-in

Everything here is a thin skin over the existing Guardian. No decision logic
lives in this file -- it forwards commands into the same methods the keyboard
already drives, so the app can never disagree with the hub about what happened.

Protocol (newline-free JSON, one object per WebSocket message):

  server -> phone     {"t":"state",  ...}       every second
                      {"t":"event",  "e":"sos", ...}
                      {"t":"alert",  "kind":"sos", "severity":5, "text":"..."}

  phone  -> server    {"t":"role",   "role":"ward"|"guardian", "name":"Ali"}
                      {"t":"ack"}                        ward taps "I'm fine"
                      {"t":"cmd",    "c":"checkin_req"}   guardian asks
                      {"t":"cmd",    "c":"alarm"}         guardian buzzes band
                      {"t":"loc",    "lat":.., "lon":.., "acc":..}
"""

import asyncio
import json
import socket
import time
from datetime import datetime

PORT = 8765


def log(tag, msg):
    print(f"{datetime.now():%H:%M:%S} [{tag}] {msg}", flush=True)


def lan_ip():
    """Best guess at the address the phones should dial. Opening a UDP socket
    to a public IP makes the OS pick the interface it would really route out
    of -- no packet is sent, and it beats gethostbyname on multi-NIC laptops."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


class Bridge:
    def __init__(self, cfg, port=PORT):
        self.cfg = cfg
        self.port = port
        self.clients = {}          # ws -> {"role": str, "name": str}
        self.guardian = None
        self.loop = None
        self.recent = []           # last 40 events/alerts, replayed on connect
        self.phone_fix = None      # (lat, lon, accuracy_m, epoch) from the ward

    # ---- wiring ------------------------------------------------------------
    def attach(self, guardian):
        self.guardian = guardian
        guardian.bridge = self

    def roster(self):
        return [{"role": m["role"], "name": m["name"]} for m in self.clients.values()]

    # ---- outbound ----------------------------------------------------------
    def _fanout(self, data, only=None):
        for ws, meta in list(self.clients.items()):
            if only and meta["role"] != only:
                continue
            asyncio.create_task(self._send(ws, data))

    async def _send(self, ws, data):
        try:
            await ws.send(data)
        except Exception:
            self.clients.pop(ws, None)

    def emit(self, msg, only=None, remember=False):
        """Safe to call from anywhere -- sync code, another thread, whatever."""
        if remember:
            self.recent.append(msg)
            self.recent = self.recent[-40:]
        if not self.clients or not self.loop:
            return
        data = json.dumps(msg)
        try:
            self.loop.call_soon_threadsafe(self._fanout, data, only)
        except RuntimeError:
            pass

    def push_event(self, ev):
        if ev.get("e") == "hb":
            return                          # heartbeats are noise; state carries them
        self.emit({"t": "event", "at": time.time(),
                   **{k: v for k, v in ev.items() if k not in ("t", "ms", "seq")}},
                  remember=True)

    def push_alert(self, kind, severity, text, ctx):
        self.emit({"t": "alert", "at": time.time(), "kind": kind,
                   "severity": severity, "text": text, **ctx}, remember=True)

    def push_state(self):
        if self.clients:
            self.emit(self.snapshot())

    # ---- the one document both apps render ---------------------------------
    def snapshot(self):
        g = self.guardian
        now = time.time()
        if not g:
            return {"t": "state", "ready": False}

        lat, lon, acc, src = g.loc.get()
        return {
            "t": "state",
            "ready": True,
            "user_name": self.cfg.user_name,
            "link_up": g.link_up,
            "armed": g.armed,
            "battery": g.last_battery,
            "awaiting_ack": g.awaiting_ack,
            "ack_left": max(0, int(g.ack_deadline - now)) if g.awaiting_ack else 0,
            "next_checkin_in": max(0, int(g.next_checkin - now)),
            "interval_s": g.interval_s,
            "lat": round(lat, 6), "lon": round(lon, 6),
            "accuracy": int(acc), "loc_src": src,
            "dist_home": int(g.loc.distance_from_home_m(lat, lon)),
            "maps": f"https://maps.google.com/?q={lat:.6f},{lon:.6f}",
            "peers": self.roster(),
        }

    # ---- inbound -----------------------------------------------------------
    async def _on_message(self, ws, msg):
        g = self.guardian
        kind = msg.get("t")

        if kind == "role":
            self.clients[ws] = {"role": msg.get("role", "guardian"),
                                "name": msg.get("name", "phone")}
            log("bridge", f"{self.clients[ws]['name']} joined as "
                          f"{self.clients[ws]['role']}")
            self.push_state()
            return

        if not g:
            return

        if kind == "ack":
            # Identical to pressing 1 on the band. Routing it through on_event
            # means the app cannot invent an ack the Guardian disagrees with.
            await g.on_event({"e": "checkin_ack", "bat": g.last_battery,
                              "src": "app"})

        elif kind == "cmd":
            c = msg.get("c")
            if c == "checkin_req":
                who = self.clients.get(ws, {}).get("name", "a guardian")
                log("bridge", f"{who} asked for a check-in")
                g.next_checkin = time.time()      # the ticker prompts the band
            elif c == "alarm":
                await g.writer({"t": "cmd", "c": "alarm"})
                log("bridge", "guardian triggered the band alarm")
            elif c == "arm":
                await g.on_event({"e": "armed" if not g.armed else "disarmed",
                                  "bat": g.last_battery})

        elif kind == "loc":
            try:
                self.phone_fix = (float(msg["lat"]), float(msg["lon"]),
                                  float(msg.get("acc", 20)), time.time())
            except (KeyError, TypeError, ValueError):
                pass

    async def _handler(self, ws):
        self.clients[ws] = {"role": "guardian", "name": "phone"}
        try:
            await ws.send(json.dumps({"t": "hello", "user_name": self.cfg.user_name,
                                      "recent": self.recent[-20:]}))
            await ws.send(json.dumps(self.snapshot()))
            async for raw in ws:
                try:
                    await self._on_message(ws, json.loads(raw))
                except json.JSONDecodeError:
                    continue
                except Exception as e:
                    log("bridge", f"message error: {e}")
        except Exception:
            pass
        finally:
            meta = self.clients.pop(ws, None)
            if meta:
                log("bridge", f"{meta['name']} ({meta['role']}) left")

    async def serve(self):
        from websockets.asyncio.server import serve
        self.loop = asyncio.get_running_loop()
        ip = lan_ip()
        async with serve(self._handler, "0.0.0.0", self.port, ping_interval=20):
            log("bridge", f"listening on ws://{ip}:{self.port}  "
                          f"<- put this in both phones")
            await asyncio.Future()
