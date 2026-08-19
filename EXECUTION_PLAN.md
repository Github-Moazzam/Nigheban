# Nigehban — Execution Plan

Personal-safety wristband with a family alert network. Everything runs on your
own hardware: an ESP32 band, two Android phones, and a laptop that is both the
database and the server.

---

## 1. The shape of the system

```
   ESP32 band  ──BLE──▶  Ward's phone  ──HTTP/WS──▶  Laptop server  ──WS──▶  Family phones
   (keypad)                (Expo app)                (FastAPI+SQLite)         (Expo app)
```

One app, not two. Everyone signs up the same way and everyone can both raise
and receive alerts — a mother watching a daughter is the same code path as a
daughter watching her mother.

**Routing rule:** an alert raised by user X reaches every user linked to X, and
nobody else. It is enforced in one SQL query, and there is a test that proves a
stranger's feed comes back empty.

---

## 2. What is already done

| Piece | State | Where |
|---|---|---|
| Band firmware | **Working, unchanged** | `nigehban_band_esp32/` |
| Keypad wired as 2 buttons | **Working** — key 1 and key 4 confirmed | — |
| Guardian logic (check-in, snatch, escalation) | **Working** in Python | `nigehban_hub.py` |
| Local server: accounts, family, alerts, live push | **Written and tested** | `server/nigehban_server.py` |
| Expo app: login, family, alerts, SOS, BLE | **Written, bundles clean** | `nigehban-app/` |
| Simulated band for Expo Go | **Working** | `src/band.js` |

The server has an end-to-end test covering the happy path *and* the negative
cases: an unknown code is rejected, a stranger cannot stand down someone else's
alert, and a stranger's alert feed is empty.

---

## 3. Firmware — nothing to change

The band already emits every event the app needs.

| On the band | Event | App behaviour |
|---|---|---|
| Key 4, one press | `sos` src `button_b` | Raises SOS, severity 5 |
| Key 1, triple tap | `sos` src `triple_tap` | Raises SOS, severity 5 |
| Key 1, one press | `checkin_ack` | **Stands down a live SOS**, else logs a check-in |
| Key 1, hold 3 s | `interval_cycle` | Cycles check-in interval |
| Key 1, hold 5 s | `armed` / `disarmed` | Toggles anti-snatch |
| Falls / no motion | `fall` | Raises severity 4 |

That gives **start and stop of an SOS from the wristband** with zero firmware
edits — key 4 starts it, key 1 ends it.

> If triple-tap is unreliable on the membrane pad, raise `CLICK_GAP_MS` at
> line 38 of the sketch from `420` to `600` and re-upload. Key 4 is the
> reliable SOS — use that one live.

---

## 4. Running it today

### 4.1 Start the server (laptop)

```bash
cd server
pip install fastapi "uvicorn[standard]"
python nigehban_server.py
```

It prints the address to type into both phones:

```
==============================================================
  NIGEHBAN SERVER
  Put this in both phones:   http://192.168.1.5:8000
==============================================================
```

The database is `server/nigehban.db`. Delete that file to reset everything.

### 4.1b Open the firewall — do this once, or nothing will connect

Windows classifies most networks as **Public** and blocks inbound connections
there. The phones will fail with "cannot reach the server" while everything
else looks perfect. In PowerShell **as Administrator**:

```powershell
New-NetFirewallRule -DisplayName "Nigehban dev servers" -Direction Inbound `
  -Action Allow -Protocol TCP -LocalPort 8000,8081 -Profile Any
```

**Diagnostic before you blame the app:** open `http://<laptop-ip>:8000/health`
in the *phone's browser*. `{"ok":true}` means the network is fine and any
remaining problem is in the app. A timeout means firewall or Wi-Fi.

> Venue and guest Wi-Fi often isolate clients from each other. If the health
> check times out on a network you do not control, start a hotspot on one phone
> and join the laptop and the other phone to it.

### 4.2 Start the app

```bash
cd nigehban-app
npx expo start          # add --dev-client once the APK is installed
```

Scan the QR on both phones. Laptop and both phones must be on the same Wi-Fi.

**There are two servers on the laptop and they are easy to confuse:**

| | Job | Port | Where you use it |
|---|---|---|---|
| Metro (`npx expo start`) | ships the JavaScript | 8081 | the QR code |
| Nigehban (`nigehban_server.py`) | accounts, family, alerts | **8000** | typed on the login screen |

Same IP, different ports. The login screen wants the **:8000** one.

### 4.3 The five-minute proof

1. Phone A: create an account (`ali` / `1234`), note the code — e.g. `NGB-4F2A`
2. Phone B: create an account (`ammi` / `1234`)
3. Phone B → **FAMILY** → type Phone A's code → **ADD**
4. Phone A → hold **SOS**
5. Phone B goes red, vibrates, shows Ali's name and a **SEE WHERE THEY ARE**
   button that opens the real GPS pin in Maps
6. Phone B taps **I'M ON IT** → Phone A sees "Ammi has seen your alert"
7. Phone A taps **I'M SAFE — STAND DOWN** → Phone B's alarm clears
8. Phone B → **FAMILY** → **ASK FOR A CHECK-IN** → Phone A gets a sheet →
   **I AM FINE** → Phone B sees the answer

All of that works in Expo Go, with no Bluetooth, using the simulated band
buttons on the Home tab.

---

## 5. Getting the real band into the phone

BLE is a native module. **Expo Go cannot load it** — that is a hard limit, not
a configuration problem. You need a development build.

This machine has no Java, no Android SDK and no Android Studio, so building
locally would mean an ~8 GB install. Use EAS Build instead:

```bash
npm install -g eas-cli
eas login                       # free Expo account
eas init                        # fills in extra.eas.projectId in app.json
eas build -p android --profile development
```

Roughly 10–20 minutes in the queue. You get an APK URL — install it on the
ward's phone. After that, `npx expo start --dev-client` and JS changes reload
exactly like Expo Go.

The app detects which environment it is in on its own:

- **Expo Go** → simulated band, buttons on the Home tab
- **Dev build** → real BLE, `CONNECT TO BAND` scans for `Nigehban-01`

No code changes between them.

> The ESP32 accepts **one** BLE connection. Close `nigehban_hub.py` before the
> phone will find the band.

---

## 6. Build order, with cut lines

Each stage is demoable on its own, so if time runs out you stop at something
that works rather than something half-finished.

| # | Stage | Proves | State |
|---|---|---|---|
| A | Server runs, two accounts, mutual family link | The data model | **done** |
| B | SOS from phone A appears on phone B | The routing | **done** |
| C | Location attached, opens in Maps | It is actionable | **done** |
| D | Check-in request and answer | Two-way care | **done** |
| E | Real band over BLE raises the SOS | The hardware is real | **needs EAS build** |
| F | Band key 1 stands the SOS down | Start *and* stop | **needs EAS build** |
| G | Background service so it works with the screen off | It survives a pocket | not started |

**If you must cut, cut G.** A judge will not lock the phone. Stage E is the one
worth spending time on — pressing a key on a wristband and watching another
person's phone go red across the room is the entire pitch in one gesture.

---

## 7. Known limits — say these before a judge asks

- **Foreground only.** The app must be open. Android kills background BLE
  without a foreground service; that is stage G.
- **Same Wi-Fi.** No internet relay. That is a deliberate privacy choice — a
  girl's live location never leaves the room — but it does mean the phones and
  laptop share a network. At a venue, use a phone hotspot if the guest Wi-Fi
  isolates clients from each other.
- **Tokens do not expire.** Fine for a demo; a real deployment needs refresh.
- **No WhatsApp yet.** In-app alerts only, by choice — see below.

---

## 8. What comes after the demo

1. **Foreground service** — `expo-task-manager` + a persistent notification, so
   the band stays connected in a pocket. This is the difference between a demo
   and a product.
2. **WhatsApp fan-out** for family who have not installed the app. CallMeBot is
   five minutes of work, but note it issues **one API key per recipient** —
   store the key per family member, not one globally.
3. **Move the Guardian logic into the app.** `nigehban_hub.py` already contains
   a proven check-in timer, disconnect grace window and escalation ladder. The
   field names in the server schema were chosen to match its instance variables
   so the port is transcription, not redesign.
4. **Internet relay** as an opt-in, so a parent in another city still gets the
   alert.

---

## 9. File map

```
Nigheban/
├── server/
│   └── nigehban_server.py      accounts, family links, alerts, live push
├── nigehban-app/
│   ├── App.js                  shell, alert takeover, band→server wiring
│   ├── app.json                BLE + location plugins, Android permissions
│   ├── eas.json                development / preview / production profiles
│   └── src/
│       ├── api.js              REST client + reconnecting WebSocket
│       ├── band.js             BLE, with simulated fallback for Expo Go
│       ├── theme.js  ui.js     palette and shared components
│       └── screens/            Auth · Home · Family · Alerts
├── nigehban_band_esp32/        firmware (unchanged, working)
├── nigehban_hub.py             laptop Guardian — still the best band test rig
└── config.json                 hub settings
```

---

## 10. Demo script

> "This is Nigehban. The band is on my wrist, the app is on my phone, and my
> mother's phone is over there. Everything runs on this laptop — no cloud, so
> her location never leaves this room."

1. Show both phones signed in, family list on each
2. Press **key 4** on the band
3. Mother's phone goes red and vibrates — name, time, **SEE WHERE THEY ARE**
4. Open the map — the real pin
5. She taps **I'M ON IT**; your phone confirms she has seen it
6. Press **key 1** on the band — her alarm clears
7. She taps **ASK FOR A CHECK-IN**; your band buzzes; you press key 1; she sees
   the answer

Then say the honest part: *"Right now the app has to be open. The next build
puts it in a foreground service so it works from a pocket."* Naming your own
limit is stronger than hoping nobody asks.
