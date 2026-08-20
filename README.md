# Nigehban

> *nigehbān* (نگہبان) — guardian, one who watches over

A personal-safety wristband and a family alert network. Press a button on the
band and the people who care about you know within a second — where you are, and
that you need them.

---

## How it fits together

```
   Band ──BLE──▶ Ward's phone ──HTTPS/WSS──▶ Server ──WS + push──▶ Family phones
  (XIAO           (Expo app)                (FastAPI)              (Expo app)
   nRF52840
   Sense)
```

One app, two roles. Everyone signs up the same way and everyone can both raise
and receive alerts — a mother watching a daughter runs the same code path as a
daughter watching her mother.

**Routing rule:** an alert raised by user X reaches every user linked to X, and
nobody else.

**Where the server runs.** Locally with an ngrok tunnel during development, then
on Alibaba Cloud ECS behind Caddy for the real deployment. The app takes a
configurable base URL, so moving between them is one setting.

---

## Hardware

| | |
|---|---|
| **Target band** | Seeed Studio XIAO nRF52840 **Sense** — BLE 5.0, on-board LSM6DS3TR-C IMU and PDM mic, BQ25101 LiPo charger |
| **Stand-in band** | `nigehban_band_esp32/` — an ESP32 sketch speaking the identical protocol, kept as a spare demo unit |
| **Peripherals** | one tactile button, a coin vibration motor behind an NPN or MOSFET driver, a 250–400 mAh LiPo |

> **The motor never connects straight to a GPIO pin.** A coin ERM pulls 60–100 mA
> at start and an nRF52840 pin supplies a couple. Transistor, flyback diode, and
> a 100 µF bulk cap — the wiring diagram and the reason for each part are in
> [EXECUTION_PLAN.md](EXECUTION_PLAN.md).

---

## What the band does

| Gesture | Event | Result |
|---|---|---|
| Double-tap | `sos` | SOS to the whole family, severity 5, with a live map pin |
| Single press | `checkin_ack` | Answers a check-in, or **stands down a live SOS** |
| Hold 3 s | `high_alert_on` / `off` | Arms High Alert — a buzz every 5–10 minutes that must be answered |
| Fall detected | `fall` | Severity 4 — starts a countdown before escalating |
| every 10 s | `hb` | Heartbeat: battery and link state, never an alert |

The band↔phone protocol is newline-delimited JSON over the Nordic UART Service
and is **frozen** — it is identical on the ESP32 and the nRF52840, which is what
lets firmware and app work be done in parallel.

---

## Running it

### 1. The server

```bash
cd server
pip install -r ../requirements.txt
python nigehban_server.py
```

The database is `server/nigehban.db` — delete that file to reset everything.

To reach it from phones on mobile data (which is how you will demo):

```bash
ngrok http 8000
```

Paste the resulting `https://…` URL into the app's server field.

To stay on the LAN instead, the server prints its own address on startup. On
Windows the firewall blocks this by default — once, as Administrator:

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

> **Two servers, easy to confuse.** Metro (port 8081) ships the JavaScript and is
> what the QR code points at. The Nigehban server (port 8000, or your ngrok URL)
> holds accounts and alerts, and is what the login screen wants.

### 3. Bluetooth

BLE is a native module, so **Expo Go cannot load it**. Without a development
build the app falls back to simulated band buttons on the Home tab — every other
feature works normally, which is exactly what lets app work proceed before the
hardware is ready.

For the real band:

```bash
npm install -g eas-cli
eas login && eas init
eas build -p android --profile development
```

Install the resulting APK on the ward's phone. The app detects which environment
it is in and switches on its own.

> The band accepts one BLE connection at a time. Close `nigehban_hub.py` before
> the phone will find it.

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

All of that works without Bluetooth, using the simulated band.

---

## Layout

```
EXECUTION_PLAN.md           phases, contracts, schema, circuit, v2 designs
server/nigehban_server.py   accounts, family links, alerts, live push
nigehban-app/
  App.js                    shell, alert takeover, band -> server wiring
  src/api.js                REST client, reconnecting socket
  src/band.js               BLE, with a simulated fallback for Expo Go
  src/screens/              Auth · Home · Family · Alerts
nigehban_band_esp32/        stand-in firmware (Arduino)
nigehban_hub.py             laptop-side Guardian — check-in timer, disconnect
                            grace, escalation ladder, Qwen risk engine
```

`nigehban_hub.py` is the original laptop brain. It still drives the band on its
own and is the best rig for testing firmware without a phone. Its check-in and
escalation logic is being moved into the server, where a deadline survives the
phone being killed.

---

## Design rule

**The phone is an actuator, never a timekeeper.** Every deadline — check-in
windows, High Alert intervals, escalation timers — lives on the server. The
phone buzzes the band and reports back; if it goes quiet, the server notices and
tells the family. This is what makes the product work when Android kills the app,
when the battery dies, or when the phone is taken.

---

## Known limits

- **No GPS or cellular on the band.** Location always comes from the phone. If
  the phone is gone, the server's heartbeat watchdog tells the family with the
  last known position — the BLE mesh that would let the band reach help directly
  is designed but not built (see the roadmap).
- **Android only.** iOS forbids background BLE scanning without a service-UUID
  filter and has no foreground-service equivalent.
- **Some OEMs will still kill the app.** Xiaomi, Huawei and Oppo kill foreground
  services silently. The app ships an onboarding flow for the required toggles,
  and the family's screen shows the watch's own health so a silent failure is
  visible before an emergency rather than during one.
- **Tokens do not expire.** Fine for a demo, not for deployment.

---

## Roadmap

Designed to the wire-protocol level in [EXECUTION_PLAN.md](EXECUTION_PLAN.md), not
yet built:

- **Working without a phone** — the band beacons an encrypted, replay-proof SOS;
  any nearby Nigehban phone relays it silently and learns nothing.
- **Anti-snatching lockdown** — a BLE disconnect *plus* the phone travelling away
  from where it disconnected locks the screen, captures silently and alerts the
  family with the direction of travel.
- LRA haptics, on-device scream detection, a cellular band, token refresh, iOS.

---

## Security notes

`server/nigehban.db` and `events.jsonl` are gitignored on purpose — they hold
password hashes, live auth tokens and location history.

`config.json` ships with placeholder contacts and empty API keys. If you fill in
real phone numbers or a Telegram/CallMeBot/DashScope key, take it out of version
control first.

**Pairing needs a consent step.** As committed, `POST /family` links two accounts
the moment someone types a code — no acceptance required. For a product whose
users are avoiding stalkers this is a real hole, and closing it is the first
server task in the plan.
