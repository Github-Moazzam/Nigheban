# Nigehban

> *nigehbān* (نگہبان) — guardian, one who watches over

A personal-safety wristband and a family alert network that runs entirely on
your own hardware. Press a key on the band and the people who care about you
know within a second — where you are, and that you need them.

No cloud. The server is a laptop on the same Wi-Fi, so a young woman's live
location never leaves the room she is in.

---

## How it fits together

```
   ESP32 band  ──BLE──▶  Ward's phone  ──HTTP/WS──▶  Laptop server  ──WS──▶  Family phones
   (4x4 keypad)           (Expo app)                 (FastAPI + SQLite)       (Expo app)
```

One app, two roles. Everyone signs up the same way and everyone can both raise
and receive alerts — a mother watching a daughter runs the same code path as a
daughter watching her mother.

**Routing rule:** an alert raised by user X reaches every user linked to X, and
nobody else.

---

## What the band does

No firmware changes are needed for any of this — the gestures already exist.

| On the band | Event | Result |
|---|---|---|
| Key 4, one press | `sos` | SOS to the whole family, severity 5 |
| Key 1, triple tap | `sos` | Same |
| Key 1, one press | `checkin_ack` | **Stands down a live SOS**, else logs "I'm fine" |
| Key 1, hold 3 s | `interval_cycle` | Cycles the check-in interval |
| Key 1, hold 5 s | `armed` / `disarmed` | Toggles anti-snatch |
| Fall detected | `fall` | Severity 4 — asks before escalating |

Key 4 starts an SOS, key 1 ends it.

---

## Running it

### 1. The server

```bash
cd server
pip install fastapi "uvicorn[standard]"
python nigehban_server.py
```

It prints the address the phones need. The database is `server/nigehban.db` —
delete that file to reset everything.

On Windows the firewall blocks this by default. Once, as Administrator:

```powershell
New-NetFirewallRule -DisplayName "Nigehban dev servers" -Direction Inbound `
  -Action Allow -Protocol TCP -LocalPort 8000,8081 -Profile Any
```

### 2. The app

```bash
cd nigehban-app
npm install
npx expo start
```

The app finds the server by itself — it reads the host it was served from and
tries port 8000. Failing that it remembers the last address that worked, and
failing that it sweeps the subnet.

> **Two servers, easy to confuse.** Metro (port 8081) ships the JavaScript and
> is what the QR code points at. The Nigehban server (port 8000) holds accounts
> and alerts, and is what the login screen wants.

### 3. Bluetooth

BLE is a native module, so **Expo Go cannot load it**. Without a development
build the app falls back to simulated band buttons on the Home tab — every
other feature works normally.

For the real band:

```bash
npm install -g eas-cli
eas login && eas init
eas build -p android --profile development
```

Install the resulting APK on the ward's phone. The app detects which
environment it is in and switches on its own.

> The ESP32 accepts one BLE connection at a time. Close `nigehban_hub.py`
> before the phone will find the band.

---

## Try it in five minutes

1. Phone A: create an account, note the code (e.g. `NGB-4F2A`)
2. Phone B: create an account
3. Phone B → **FAMILY** → enter Phone A's code → **ADD**
4. Phone A → hold **SOS**
5. Phone B goes red, vibrates, shows the name and a live map pin
6. Phone B taps **I'M ON IT** → Phone A sees who is responding
7. Phone A taps **I'M SAFE** → Phone B's alarm clears
8. Phone B → **ASK FOR A CHECK-IN** → Phone A answers → Phone B sees it

All of that works without Bluetooth.

---

## Layout

```
server/nigehban_server.py   accounts, family links, alerts, live push
nigehban-app/
  App.js                    shell, alert takeover, band -> server wiring
  src/api.js                REST client, reconnecting socket, server discovery
  src/band.js               BLE, with a simulated fallback for Expo Go
  src/screens/              Auth · Home · Family · Alerts
nigehban_band_esp32/        firmware (Arduino)
nigehban_hub.py             laptop-side Guardian — check-in timer, snatch
                            detection, escalation ladder
EXECUTION_PLAN.md           build order, cut lines, demo script
```

`nigehban_hub.py` is the original laptop brain. It still runs the band on its
own and is the best rig for testing firmware without a phone. Its check-in and
escalation logic is the next thing to move into the app.

---

## Known limits

- **Foreground only.** The app must be open. Android kills background BLE
  without a foreground service.
- **Same Wi-Fi.** No internet relay — deliberate, but it does mean everyone
  shares a network. Venue Wi-Fi often isolates clients; use a phone hotspot.
- **Tokens do not expire.** Fine for a demo, not for deployment.
- **Android only.** iOS forbids background BLE scanning without a service-UUID
  filter and has no foreground-service equivalent.

---

## Security notes

`server/nigehban.db` and `events.jsonl` are gitignored on purpose — they hold
password hashes, live auth tokens and location history.

`config.json` ships with placeholder contacts and empty API keys. If you fill
in real phone numbers or a Telegram/CallMeBot key, take it out of version
control first.
