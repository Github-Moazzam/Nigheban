#!/usr/bin/env python3
"""
NIGEHBAN HUB — laptop stand-in for the Android app.

Everything the phone will eventually do, this does on your laptop today:
  connect to the band over BLE, run the check-in dead-man's switch, detect
  snatch/fall/low-battery, get a location, ask Qwen for a risk brief, and
  dispatch the alert to family.

Run:
    pip install bleak requests
    python nigehban_hub.py            # scan + connect to the band
    python nigehban_hub.py --sim      # no hardware: type events on the keyboard
    python nigehban_hub.py --list     # list nearby BLE devices

NOTE (22 Aug 2026): the Guardian logic below now also lives in
`server/nigehban_server.py` as the sweeper, and THAT copy is the authoritative
one -- it holds the deadlines that have to survive a phone being killed. This
file is kept because it is still the best rig for driving firmware with no
phone in the loop: one script, a keyboard, and a real BLE link.

Keyboard (works in both modes):
    1        button A single click   -> "I'm OK" check-in ack
    2        button B click          -> SOS
    3        button A double tap     -> SOS
    h3       hold 3s                 -> toggle High Alert
    h5       (no band gesture)       -> arm/disarm anti-snatch, for testing
                                        the snatch path; v2 will give it one
    fall     fall detected
    bat 15   set battery to 15%
    drop     simulate BLE loss
    now      force a check-in request right now
    q        quit
"""

import argparse
import asyncio
import json
import math
import os
import sys
import threading
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime

try:
    import requests
except ImportError:
    requests = None

NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
NUS_RX      = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"   # we write here
NUS_TX      = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"   # we subscribe here

HERE       = os.path.dirname(os.path.abspath(__file__))
CONFIG_F   = os.path.join(HERE, "config.json")
EVENT_LOG  = os.path.join(HERE, "events.jsonl")

BRIDGE     = None   # set in amain(); the phones' WebSocket server


# ----------------------------------------------------------------- config ---
@dataclass
class Config:
    device_name: str = "Nigehban-01"
    user_name: str = "Ali"

    checkin_interval_s: int = 120        # demo value; real default 30-60 min
    checkin_window_s: int = 45           # how long the user has to answer
    interval_cycle_s: list = field(default_factory=lambda: [120, 900, 1800, 3600])

    disconnect_grace_s: int = 10         # THE anti-false-alarm knob
    low_battery_pct: int = 20

    home_lat: float = 24.8607            # Karachi centre — set to your home
    home_lon: float = 67.0011
    home_radius_m: int = 150
    use_ip_location: bool = True         # coarse; the phone will use real GPS

    contacts: list = field(default_factory=lambda: [
        {"name": "Ammi", "phone": "+92300XXXXXXX"},
        {"name": "Bhai", "phone": "+92321XXXXXXX"},
    ])

    # --- delivery channels (all optional; console always works) -------------
    telegram_bot_token: str = ""
    telegram_chat_id: str = ""           # a group id works and is free
    callmebot_phone: str = ""            # +92... , WhatsApp, needs opt-in
    callmebot_apikey: str = ""

    # --- Alibaba Cloud Model Studio (Qwen) ---------------------------------
    dashscope_api_key: str = ""
    dashscope_base: str = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
    qwen_model: str = "qwen-plus"
    language: str = "urdu+english"

    @staticmethod
    def load():
        if os.path.exists(CONFIG_F):
            with open(CONFIG_F) as f:
                return Config(**json.load(f))
        c = Config()
        c.save()
        print(f"[hub] wrote a starter config to {CONFIG_F} — edit it and re-run")
        return c

    def save(self):
        with open(CONFIG_F, "w") as f:
            json.dump(asdict(self), f, indent=2)


def log(tag, msg):
    print(f"{datetime.now():%H:%M:%S} [{tag}] {msg}", flush=True)


def journal(rec):
    """Append-only event log. This file is your Pattern-of-Life training data."""
    rec = dict(rec)
    rec["wall"] = datetime.now().isoformat(timespec="seconds")
    with open(EVENT_LOG, "a") as f:
        f.write(json.dumps(rec) + "\n")


# --------------------------------------------------------------- location ---
class Location:
    def __init__(self, cfg):
        self.cfg = cfg
        self.cache = None
        self.cache_at = 0

    def get(self):
        """Returns (lat, lon, accuracy_m, source). The phone replaces this with
        FusedLocationProviderClient — same three numbers, much better accuracy."""
        # A phone on the network reports ~10 m; ip-api reports ~5000 m.
        # Prefer the phone whenever its fix is still fresh.
        if BRIDGE and BRIDGE.phone_fix:
            lat, lon, acc, at = BRIDGE.phone_fix
            if time.time() - at < 120:
                return (lat, lon, acc, "phone")
        if self.cfg.use_ip_location and requests:
            if self.cache and time.time() - self.cache_at < 120:
                return self.cache
            try:
                r = requests.get("http://ip-api.com/json/", timeout=4).json()
                if r.get("status") == "success":
                    self.cache = (r["lat"], r["lon"], 5000, "ip")
                    self.cache_at = time.time()
                    return self.cache
            except Exception as e:
                log("loc", f"ip lookup failed: {e}")
        return (self.cfg.home_lat, self.cfg.home_lon, 0, "config")

    def distance_from_home_m(self, lat, lon):
        R = 6371000.0
        p1, p2 = math.radians(self.cfg.home_lat), math.radians(lat)
        dp = math.radians(lat - self.cfg.home_lat)
        dl = math.radians(lon - self.cfg.home_lon)
        a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
        return 2 * R * math.asin(math.sqrt(a))

    @staticmethod
    def maps_link(lat, lon):
        return f"https://maps.google.com/?q={lat:.6f},{lon:.6f}"


# ------------------------------------------------------------ risk engine ---
class RiskEngine:
    """Turns a raw event into (severity 1-5, human message).
    With a DashScope key it calls Qwen; without one it uses templates, so the
    demo never dies because the internet did."""

    SEVERITY = {
        "sos": 5, "snatch": 5, "fall": 4,
        "checkin_missed": 3, "low_battery": 1, "disarmed": 1,
    }

    def __init__(self, cfg):
        self.cfg = cfg

    def assess(self, kind, ctx):
        sev = self.SEVERITY.get(kind, 2)
        msg = self._qwen(kind, sev, ctx) or self._template(kind, sev, ctx)
        return sev, msg

    def _template(self, kind, sev, ctx):
        u = self.cfg.user_name
        link = ctx.get("maps", "")
        t = ctx.get("time", "")
        head = {
            "sos":            f"🚨 EMERGENCY: {u} pressed the SOS on their Nigehban band.",
            "snatch":         f"🚨 POSSIBLE SNATCHING: {u}'s phone lost contact with the band and moved suddenly.",
            "fall":           f"⚠️ FALL DETECTED: {u}'s band detected a fall and there was no response.",
            "checkin_missed": f"⚠️ MISSED CHECK-IN: {u} did not answer the check-in prompt.",
            "low_battery":    f"🔋 {u}'s phone battery is low ({ctx.get('battery','?')}%). They are fine — the phone may switch off soon.",
        }.get(kind, f"Nigehban alert for {u}: {kind}")
        return (f"{head}\nTime: {t}\nLast location: {link}\n"
                f"Accuracy: ~{ctx.get('accuracy','?')} m | Distance from home: {ctx.get('dist_home','?')} m\n"
                f"(Severity {sev}/5 — auto-generated by Nigehban)")

    def _qwen(self, kind, sev, ctx):
        if not (self.cfg.dashscope_api_key and requests):
            return None
        system = (
            "You are Nigehban's emergency dispatcher for families in Pakistan. "
            "Given a JSON sensor event, write ONE short WhatsApp message to the "
            "user's family. Two lines of Roman Urdu first, then two lines of "
            "English. State what happened, the time, and include the maps link "
            "verbatim. Be calm and specific. Never invent facts not in the JSON. "
            "No preamble, output the message only."
        )
        payload = {
            "model": self.cfg.qwen_model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": json.dumps(
                    {"event": kind, "severity": sev, "user": self.cfg.user_name, **ctx})},
            ],
            "max_tokens": 300,
            "temperature": 0.3,
        }
        try:
            r = requests.post(
                f"{self.cfg.dashscope_base}/chat/completions",
                headers={"Authorization": f"Bearer {self.cfg.dashscope_api_key}",
                         "Content-Type": "application/json"},
                json=payload, timeout=12)
            r.raise_for_status()
            return r.json()["choices"][0]["message"]["content"].strip()
        except Exception as e:
            log("qwen", f"falling back to template: {e}")
            return None


# --------------------------------------------------------------- dispatch ---
class Notifier:
    def __init__(self, cfg):
        self.cfg = cfg

    def send(self, severity, text):
        banner = "=" * 68
        print(f"\n{banner}\n  DISPATCH  severity {severity}/5  ->  "
              f"{', '.join(c['name'] for c in self.cfg.contacts)}\n{banner}\n{text}\n{banner}\n",
              flush=True)
        threading.Thread(target=self._deliver, args=(text,), daemon=True).start()

    def _deliver(self, text):
        c = self.cfg
        if c.telegram_bot_token and c.telegram_chat_id and requests:
            try:
                requests.post(
                    f"https://api.telegram.org/bot{c.telegram_bot_token}/sendMessage",
                    json={"chat_id": c.telegram_chat_id, "text": text}, timeout=8)
                log("send", "telegram ok")
            except Exception as e:
                log("send", f"telegram failed: {e}")
        if c.callmebot_phone and c.callmebot_apikey and requests:
            try:
                requests.get("https://api.callmebot.com/whatsapp.php",
                             params={"phone": c.callmebot_phone, "text": text,
                                     "apikey": c.callmebot_apikey}, timeout=10)
                log("send", "whatsapp (callmebot) ok")
            except Exception as e:
                log("send", f"whatsapp failed: {e}")


# ------------------------------------------------------------- the brain ---
class Guardian:
    """All the logic that will move into the Android foreground service."""

    def __init__(self, cfg, writer):
        self.cfg = cfg
        self.writer = writer            # async fn(dict) -> sends a command to band
        self.loc = Location(cfg)
        self.risk = RiskEngine(cfg)
        self.notify = Notifier(cfg)

        self.armed = False
        self.high_alert = False              # hold 3 s, exec plan section 5
        self.link_up = False
        self.interval_idx = 0
        self.interval_s = cfg.checkin_interval_s
        self._interval_before_ha = self.interval_s
        self.awaiting_ack = False
        self.ack_deadline = 0.0
        self.next_checkin = time.time() + self.interval_s
        self.last_battery = 100
        self.low_bat_sent = False
        self.drop_at = None
        self.bridge = None          # set by Bridge.attach()

    # ---- context builder ---------------------------------------------------
    def context(self, extra=None):
        lat, lon, acc, src = self.loc.get()
        ctx = {
            "time": datetime.now().strftime("%I:%M %p, %d %b"),
            "lat": round(lat, 6), "lon": round(lon, 6),
            "accuracy": acc, "location_source": src,
            "maps": Location.maps_link(lat, lon),
            "dist_home": int(self.loc.distance_from_home_m(lat, lon)),
            "battery": self.last_battery,
            "armed": self.armed,
        }
        if extra:
            ctx.update(extra)
        return ctx

    def escalate(self, kind, extra=None):
        ctx = self.context(extra)
        sev, msg = self.risk.assess(kind, ctx)
        journal({"type": "alert", "kind": kind, "severity": sev, **ctx})
        self.notify.send(sev, msg)
        if self.bridge:
            self.bridge.push_alert(kind, sev, msg, ctx)

    # ---- events from the band ---------------------------------------------
    async def on_event(self, ev):
        e = ev.get("e", "")
        self.last_battery = ev.get("bat", self.last_battery)
        journal({"type": "band_event", **ev})
        if self.bridge:
            self.bridge.push_event(ev)

        if e == "hb":
            if self.last_battery <= self.cfg.low_battery_pct and not self.low_bat_sent:
                self.low_bat_sent = True
                self.escalate("low_battery")
            return

        log("band", f"{e}  {json.dumps({k: v for k, v in ev.items() if k not in ('t','ms','seq')})}")

        if e == "sos":
            await self.writer({"t": "cmd", "c": "alarm"})
            self.escalate("sos", {"trigger": ev.get("src", "band")})

        elif e == "checkin_ack":
            if self.awaiting_ack:
                self.awaiting_ack = False
                log("hub", "check-in acknowledged — nothing sent to family ✅")
            else:
                log("hub", "'I am OK' received outside a check-in window (noted)")
            self.next_checkin = time.time() + self.interval_s
            await self.writer({"t": "cmd", "c": "ack"})

        elif e == "checkin_missed":
            pass    # the hub owns escalation; band only nags locally

        elif e in ("high_alert_on", "high_alert_off"):
            # Hold 3 s, per EXECUTION_PLAN.md section 5. High Alert shortens the
            # check-in interval to its tightest setting; turning it off restores
            # whatever was in effect before, so it cannot silently leave the
            # wearer on a 2-minute nag for the rest of the day.
            if e == "high_alert_on":
                self._interval_before_ha = self.interval_s
                self.interval_s = min(self.cfg.interval_cycle_s)
            else:
                self.interval_s = self._interval_before_ha
            self.high_alert = (e == "high_alert_on")
            self.next_checkin = time.time() + self.interval_s
            log("hub", f"High Alert {'ON' if self.high_alert else 'off'} - "
                       f"checking in every {self.interval_s // 60} min")
            await self.writer({"t": "cmd", "c": "buzz", "n": 2 if self.high_alert else 1})

        elif e == "interval_cycle":
            # Legacy: the current firmware no longer emits this (hold 3 s became
            # High Alert). Kept so an older flashed band still behaves.
            cyc = self.cfg.interval_cycle_s
            self.interval_idx = (self.interval_idx + 1) % len(cyc)
            self.interval_s = cyc[self.interval_idx]
            self.next_checkin = time.time() + self.interval_s
            log("hub", f"check-in interval is now {self.interval_s // 60} min")
            await self.writer({"t": "cmd", "c": "buzz", "n": self.interval_idx + 1})

        elif e in ("armed", "disarmed"):
            self.armed = (e == "armed")
            log("hub", f"anti-snatch mode {'ARMED' if self.armed else 'disarmed'}")

        elif e == "fall":
            # a fall is not automatically an emergency — ask first, escalate if silent
            log("hub", "fall detected — asking the user to confirm they are OK")
            self.awaiting_ack = True
            self.ack_deadline = time.time() + self.cfg.checkin_window_s
            self._pending_kind = "fall"
            await self.writer({"t": "cmd", "c": "checkin_req",
                               "window": self.cfg.checkin_window_s})

    # ---- link state --------------------------------------------------------
    async def on_link(self, up):
        self.link_up = up
        if up:
            log("link", "band connected")
            self.drop_at = None
        else:
            log("link", "band disconnected")
            if self.armed:
                self.drop_at = time.time()      # start the grace window
                log("hub", f"armed + link lost — {self.cfg.disconnect_grace_s}s grace "
                           f"before calling it a snatch")

    # ---- 1 Hz tick ---------------------------------------------------------
    async def tick(self):
        now = time.time()

        # snatch confirmation after the grace window (the audit's key fix)
        if self.drop_at and not self.link_up:
            if now - self.drop_at >= self.cfg.disconnect_grace_s:
                self.drop_at = None
                log("hub", "grace window expired, link still down -> SNATCH")
                self.escalate("snatch", {"grace_s": self.cfg.disconnect_grace_s})

        # scheduled check-in
        if not self.awaiting_ack and now >= self.next_checkin:
            self.awaiting_ack = True
            self._pending_kind = "checkin_missed"
            self.ack_deadline = now + self.cfg.checkin_window_s
            log("hub", f"check-in due — prompting band ({self.cfg.checkin_window_s}s to answer)")
            await self.writer({"t": "cmd", "c": "checkin_req",
                               "window": self.cfg.checkin_window_s})

        # dead-man's switch expiry
        if self.awaiting_ack and now >= self.ack_deadline:
            self.awaiting_ack = False
            self.next_checkin = now + self.interval_s
            self.escalate(getattr(self, "_pending_kind", "checkin_missed"))

        if self.bridge:
            self.bridge.push_state()


# ------------------------------------------------------------- transports ---
class BleLink:
    def __init__(self, cfg, guardian_factory):
        self.cfg = cfg
        self.guardian_factory = guardian_factory
        self.client = None
        self.buf = ""

    async def write(self, obj):
        if not self.client or not self.client.is_connected:
            log("ble", f"(not connected, dropped command {obj.get('c')})")
            return
        data = (json.dumps(obj) + "\n").encode()
        try:
            await self.client.write_gatt_char(NUS_RX, data, response=False)
        except Exception as e:
            log("ble", f"write failed: {e}")

    async def run(self):
        from bleak import BleakScanner, BleakClient

        loop = asyncio.get_running_loop()
        guardian = self.guardian_factory(self.write)
        asyncio.create_task(ticker(guardian))
        asyncio.create_task(keyboard(guardian, self.write))

        while True:
            log("ble", f"scanning for '{self.cfg.device_name}' ...")
            try:
                dev = await BleakScanner.find_device_by_filter(
                    lambda d, ad: (d.name or "") == self.cfg.device_name, timeout=15)
            except Exception as e:
                # Adapter switched off or unplugged mid-run. Deliberately do NOT call
                # on_link(False) here -- the disconnect path already started the grace
                # window, and on_link resets drop_at on every call, so retrying would
                # push the deadline forward forever and the snatch would never fire.
                log("ble", f"adapter unavailable ({e.__class__.__name__}), retrying")
                await asyncio.sleep(3)
                continue
            if not dev:
                log("ble", "not found, retrying")
                continue

            def on_disconnect(_):
                # bleak may call this off the loop thread
                loop.call_soon_threadsafe(
                    lambda: loop.create_task(guardian.on_link(False)))

            try:
                async with BleakClient(dev, disconnected_callback=on_disconnect) as client:
                    self.client = client
                    await guardian.on_link(True)

                    def handler(_, data: bytearray):
                        self.buf += data.decode(errors="ignore")
                        while "\n" in self.buf:
                            line, self.buf = self.buf.split("\n", 1)
                            line = line.strip()
                            if not line:
                                continue
                            try:
                                msg = json.loads(line)
                            except json.JSONDecodeError:
                                continue
                            if msg.get("t") == "evt":
                                loop.create_task(guardian.on_event(msg))

                    await client.start_notify(NUS_TX, handler)
                    while client.is_connected:
                        await asyncio.sleep(1)
            except Exception as e:
                log("ble", f"connection error: {e}")
            finally:
                self.client = None
                await guardian.on_link(False)
                await asyncio.sleep(2)


class SimLink:
    """No hardware? The whole brain still runs, driven from the keyboard."""

    async def write(self, obj):
        c = obj.get("c")
        if c == "checkin_req":
            log("band", "📳 BUZZ BUZZ BUZZ — 'are you OK? press 1'")
        elif c == "alarm":
            log("band", "🔔 ALARM pattern playing")
        elif c == "buzz":
            log("band", f"📳 buzz x{obj.get('n', 1)}")

    async def run(self, guardian_factory):
        guardian = guardian_factory(self.write)
        await guardian.on_link(True)
        asyncio.create_task(ticker(guardian))
        await keyboard(guardian, self.write)


async def ticker(guardian):
    while True:
        try:
            await guardian.tick()
        except Exception as e:
            log("err", f"tick: {e}")
        await asyncio.sleep(1)


async def keyboard(guardian, writer):
    loop = asyncio.get_event_loop()
    q = asyncio.Queue()

    def reader():
        for line in sys.stdin:
            loop.call_soon_threadsafe(q.put_nowait, line.strip())

    threading.Thread(target=reader, daemon=True).start()

    while True:
        cmd = (await q.get()).lower()
        if cmd in ("q", "quit", "exit"):
            log("hub", "bye"); os._exit(0)
        elif cmd == "1":
            await guardian.on_event({"e": "checkin_ack", "bat": guardian.last_battery})
        elif cmd == "2":
            await guardian.on_event({"e": "sos", "src": "button_b", "bat": guardian.last_battery})
        elif cmd == "3":
            await guardian.on_event({"e": "sos", "src": "double_tap", "bat": guardian.last_battery})
        elif cmd == "h3":
            await guardian.on_event({
                "e": "high_alert_off" if guardian.high_alert else "high_alert_on",
                "bat": guardian.last_battery})
        elif cmd == "h5":
            await guardian.on_event({"e": "armed" if not guardian.armed else "disarmed",
                                     "bat": guardian.last_battery})
        elif cmd == "fall":
            await guardian.on_event({"e": "fall", "bat": guardian.last_battery})
        elif cmd.startswith("bat"):
            parts = cmd.split()
            v = int(parts[1]) if len(parts) > 1 else 15
            guardian.low_bat_sent = False
            await guardian.on_event({"e": "hb", "bat": v})
        elif cmd == "drop":
            await guardian.on_link(False)
        elif cmd == "up":
            await guardian.on_link(True)
        elif cmd == "now":
            guardian.next_checkin = time.time()
        else:
            log("hub", "keys: 1 2 3 h3 h5 fall 'bat 15' drop up now q")


# -------------------------------------------------------------------- main ---
async def amain():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sim", action="store_true", help="run without hardware")
    ap.add_argument("--list", action="store_true", help="list nearby BLE devices")
    args = ap.parse_args()

    cfg = Config.load()

    if args.list:
        from bleak import BleakScanner
        for d in await BleakScanner.discover(timeout=8):
            print(f"  {d.address}   {d.name}")
        return

    print(__doc__)
    log("hub", f"user={cfg.user_name}  check-in every {cfg.checkin_interval_s}s  "
               f"grace={cfg.disconnect_grace_s}s  qwen={'on' if cfg.dashscope_api_key else 'off (templates)'}")

    from nigehban_bridge import Bridge
    global BRIDGE
    BRIDGE = Bridge(cfg)

    async def _serve():
        try:
            await BRIDGE.serve()
        except Exception as e:
            log("bridge", f"could not start ({e}) -- phones will not connect")

    asyncio.create_task(_serve())

    def factory(writer):
        g = Guardian(cfg, writer)
        BRIDGE.attach(g)
        return g

    if args.sim:
        await SimLink().run(factory)
    else:
        await BleLink(cfg, factory).run()


if __name__ == "__main__":
    try:
        asyncio.run(amain())
    except KeyboardInterrupt:
        pass
