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
| **The band** | Seeed Studio XIAO nRF52840 **Sense** — BLE 5.0, on-board LSM6DS3TR-C IMU and PDM mic, BQ25101 LiPo charger |
| **Stand-in** | `nigehban-app/src/virtualBand.js` — the phone runs the band's own gesture engine, so no hardware is needed to build or test |
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
and is **frozen** — the firmware and the virtual band on the phone emit byte-identical
events, which is what lets firmware and app work be done in parallel.

**What the wrist tells you.** Every press gets a tick as the button goes down,
so two taps are felt as two — you can tell "that did not register, press again"
from "that registered and failed, go find your phone". The confirmation comes
separately, once the *phone* knows the answer, because the band cannot: a
successful write only means the phone heard the press, not that anybody was
paged. One firm buzz means the family knows; three medium pulses mean it is
saved but not yet sent; two long heavy buzzes mean it did not go. Full
reasoning in [docs/BAND_FEEDBACK_SPEC.md](docs/BAND_FEEDBACK_SPEC.md).

---

## No band yet? Nothing is blocked

The wristband is not required to build or test any of this. The phone can run
the band's firmware itself — the same gesture engine, the same event JSON on
the wire — and one command puts the server behind a public HTTPS tunnel so
testers on mobile data anywhere can reach it.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev-tunnel.ps1
```
```bash
./scripts/dev-tunnel.sh          # macOS / Linux / WSL / Git Bash
```

Then open the **BAND** tab in the app. Read
[TESTING_WITHOUT_HARDWARE.md](TESTING_WITHOUT_HARDWARE.md) first — it is short,
and it covers the two-phone test that proves the whole product loop.

---

## Running it

### 1. The server

```bash
pip install -r requirements.txt
python server/migrate_pg.py        # applies server/migrations/*.sql, idempotent
python server/nigehban_server.py
```

The server is **Postgres only**. It reads `DATABASE_URL` from the repo-root
`.env` and there is no second place to configure it, on purpose: pointing a
query at the wrong database is easy to do and hard to notice, because both
databases answer. On a fresh database, load `server/supabase_migration.sql`
once first, then let `migrate_pg.py` carry it forward.

The server prints the host and database name it connected to on startup. Read
that line before debugging anything — it is the cheapest way to catch the
mistake above.

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

For a faster loop while working on anything that is not BLE, push or the
foreground service, `npm run web` opens the same app in a browser — auth,
family, the live socket and the virtual band all work there. See §2b of
[TESTING_WITHOUT_HARDWARE.md](TESTING_WITHOUT_HARDWARE.md) for what does not,
and why.

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

> **The band is locked.** It pairs with a six-digit passkey and then asks for
> the same six digits again over the encrypted link before it will say anything
> at all. A freshly flashed band uses the factory PIN in `DEFAULT_PAIR_PIN` at
> the top of the sketch — change it there before flashing, or from the app on
> first link. The wearer can also rename the band, and the new name goes out in
> the advertisement, so Android and nRF Connect follow it too.
> [docs/BAND_PIN_AND_NAME.md](docs/BAND_PIN_AND_NAME.md) has the protocol, the
> two-lock reasoning, and the button-through-boot way out of a forgotten PIN.

> **Upgrading a band from older firmware: forget it in Android's Bluetooth
> settings first.** The old build needed no pairing and this one does; a phone
> reconnecting with a stale bond fails encryption, and no app can clear an
> Android bond for you.

> The band accepts one BLE connection at a time. Close `nigehban_hub.py` before
> the phone will find it. The same applies to nRF Connect, and to the app's own
> previous run — a connected band is not advertising, so nothing else can see
> it. If a scan finds nothing, reset the band first.

> **On Android 12+, grant location and switch Location Services on**, or the
> scan returns nothing at all. `BLUETOOTH_SCAN` is declared without
> `neverForLocation`, so the OS treats scanning as location-capable and delivers
> zero results until both are satisfied — with no error and no callback. The app
> asks for the permission; it cannot flip the system toggle for you.

---

## Try it in five minutes

1. Phone A: create an account
2. Phone B: create an account
3. Phone A → **FAMILY** → **MAKE A PAIRING CODE**; Phone B enters it
4. Phone A → hold **SOS**
5. Phone B goes red, vibrates, shows the name and a live map pin
6. Phone B taps **I'M ON IT** → Phone A sees who is responding
7. Phone A taps **I'M SAFE** → Phone B's alarm clears
8. Phone B → **ASK FOR A CHECK-IN** → Phone A sees live 90s countdown banner → answers → Phone B sees it
9. Phone A → **ARM HIGH ALERT** → Phone B's **FAMILY** tab updates in sub-second real-time with `ARMED` watch health status tile
10. Unanswered check-in (90 s) → **Server Sweeper** automatically escalates to a Severity 3 alert to Phone B

All of that works without Bluetooth, using the simulated band.

---

## Layout

```
EXECUTION_PLAN.md           phases, contracts, schema, circuit, v2 designs
DEVELOPMENT_PLAN.md         milestones and workstream status
server/nigehban_server.py   accounts, family links, alerts, live push, sweeper
nigehban-app/
  App.js                    shell, alert takeover, band -> server wiring
  src/api.js                REST client, reconnecting socket
  src/band.js               BLE, with a simulated fallback for Expo Go
  src/virtualBand.js        the phone AS the band — the .ino ported to JS
  src/bandLink.js           one seam, two radios: real BLE or virtual
  src/watch.js              heartbeat: the silence the server watches for
  src/state.js              the client state machine, transitions as data
  src/theme.js  src/ui.js   the design system: tokens, type scale, component kit
  src/fonts.js              Outfit + Space Grotesk, loaded without blocking
  src/alarm.js              one seam: native lock-screen alarm, or vibration
  src/bgNotifications.js    the silent push that wakes a killed app's siren
  modules/nigehban-alarm/   Kotlin: full-screen intent + siren until dismissed
  src/security.js           the four digits in front of disarming High Alert
  src/components/           CheckinBanner · HighAlertPanel · WatchStatusTile
                            FallCountdown · SosLiveView · SamaritanCall · PinSheet
  src/screens/              Auth · Home · Band · Family · Alerts · Setup
tests/                      consent + sweeper + samaritan, end to end, no phone needed
nigehban_band_nrf52/        the band firmware (Arduino)
firmware/t1..t6/            bench bring-up sketches, one unknown each
scripts/dev-tunnel.*        server + public HTTPS tunnel, self-verifying
nigehban_hub.py             laptop-side Guardian — check-in timer, disconnect
                            grace, escalation ladder, Qwen risk engine
```

`nigehban_hub.py` is the original laptop brain. It still drives the band on its
own and is the best rig for testing firmware without a phone. Its check-in and
escalation logic **now lives in the server** as well, where a deadline survives
the phone being killed — the server's copy is the authoritative one.

---

## Design rule

**The phone is an actuator, never a timekeeper.** Every deadline — check-in
windows, High Alert intervals, escalation timers — lives on the server, in a
five-second sweeper task. The phone buzzes the band and reports back; if it goes
quiet, the server notices and tells the family. This is what makes the product
work when Android kills the app, when the battery dies, or when the phone is
taken, and it is the one part you cannot demonstrate with client code:

```bash
python server/nigehban_server.py      # in one terminal
python tests/test_consent_and_sweeper.py
```

A check-in created there escalates on its own deadline with nothing connected
to anything.

> `watch_lost` needs migration 006. Run `python server/migrate_pg.py` after
> pulling this — without it every `POST /heartbeat` fails with
> `UndefinedColumn`, which is a wearer's "I am still here" being thrown away
> once a minute. The server checks at startup and says so in the terminal.

The one exception to the end-to-end rule is `watch_lost` — the alert that pages
a family about an absence. It fires on a *transition* (there was a live band
link, an alert was running, and then the link went), and the states that get it
wrong are the ones nobody can stage on a desk: a band dropping in the same
second an SOS is pressed, a phone silent since lunch, a link flapping in a
stairwell. So the rule lives in `server/watch_lost.py` as pure functions and is
asserted directly, with no server and no database:

```bash
python tests/test_watch_lost_transition.py
```

---

## Known limits

- **No GPS or cellular on the band.** Location always comes from the phone. If
  the phone is gone, the server's heartbeat watchdog tells the family with the
  last known position — the BLE mesh that would let the band reach help directly
  is designed but not built (see the roadmap).
- **`watch_lost` needs a real wristband, and virtual mode cannot raise it at
  all.** The alert fires on one transition: a live link to a *physical* band,
  an alert running, and then the link goes. Virtual mode reports
  `band_link=true` because the phone runs the band's firmware itself, but there
  is no wristband to lose — so a virtual-mode phone that dies mid-SOS raises no
  `watch_lost`, and neither does switching a linked band over to virtual mode.
  The SOS itself still pages the family; what they do not get is a second alert
  about a device that was never in play. `physical_link` and the `if virtual:`
  branch in `server/watch_lost.py` are the two places that decide it.
- **Android only.** iOS forbids background BLE scanning without a service-UUID
  filter and has no foreground-service equivalent.
- **Some OEMs will still kill the app.** Xiaomi, Huawei and Oppo kill foreground
  services silently. The app ships an onboarding flow for the required toggles,
  and the family's screen shows the watch's own health so a silent failure is
  visible before an emergency rather than during one.
- **Tokens do not expire.** Fine for a demo, not for deployment. Access+refresh
  was considered and rejected: it does not address a stolen phone, where both
  credentials sit in the same storage, and rotation races with the 60 s
  heartbeat in a way that logs a wearer out mid-emergency. B4.4 is a sliding
  session window instead.
- **An SOS survives a dead network, but nobody is reached until signal returns.**
  The press is dispatched locally first, persisted, and flushed automatically on
  reconnect, and the SOS screen says *"not delivered yet, retrying"* rather than
  looking identical to a delivered one. So the alert is delayed rather than
  lost — but a phone with no signal still reaches no family member, and the
  band's own path to help without a phone is the v2 mesh in the roadmap below.
- **The wristband does not reliably come back on its own.** Walk out of range
  and return: it reconnects with the screen on, and does not with the screen off
  — the retry is a `setTimeout`, and Android stops those when the activity is
  not visible (BUG-010). On an OEM that kills the process on a Recents swipe,
  nothing is left alive to retry at all, and the phone stays deaf until someone
  opens the app (BUG-015). Both are open, with the beacon-identity defects found
  alongside them, in [docs/BUG_LIST.md](docs/BUG_LIST.md).
- **An SOS only leaves the wrist while the app or its foreground service is
  alive.** The band could raise an SOS with the app killed, by putting the press
  in its advertisement for a scan registered with Android itself. That path was
  **switched off on 1 Sep 2026** — it carried no band identity, so one band's
  press was accepted by every Nigehban phone in range and raised as the wrong
  person's emergency (BUG-012), while swallowing the second wearer's own press
  (BUG-013). The code is still there behind two booleans; the reasoning, the
  cost and the steps to bring it back are in
  [docs/BAND_WAKE_DISABLED.md](docs/BAND_WAKE_DISABLED.md).

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

`.env` and `events.jsonl` are gitignored on purpose — `.env` holds the database
password inside `DATABASE_URL`, and `events.jsonl` holds location history. The
account data itself (password hashes, hashed session tokens) lives in Postgres,
never in the repo.

`config.json` ships with placeholder contacts and empty API keys. If you fill in
real phone numbers or a Telegram/CallMeBot/DashScope key, take it out of version
control first.

**The band will not talk to a phone that cannot prove itself.** Its UART
characteristics require an encrypted, MITM-protected link, so connecting means
pairing with a six-digit passkey — and then the firmware asks for the same six
digits again over that link before it sends a single event or obeys a single
command. The second lock is what makes changing the PIN revoke a phone that is
already bonded, which the first cannot do on its own. Full reasoning, and an
honest note on what legacy passkey pairing does not protect against, in
[docs/BAND_PIN_AND_NAME.md](docs/BAND_PIN_AND_NAME.md).

**Pairing takes two people.** Adding someone needs both of you to act: you make
a pairing code that lives ten minutes and works once, or you ask by their
permanent code and they accept. Nothing is shared in either direction until
that has happened, declining is permanent and silent, and an invite to a code
that does not exist looks exactly like one to a code that does — so the code
space cannot be walked to find out who has an account. Session tokens are
stored hashed. The reasoning is in §13 of
[DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md), and
[tests/](tests/) is the proof.

CORS is an allowlist that is empty by default (`ALLOWED_ORIGINS`), every write
endpoint is rate limited except the two where a 429 would invent an emergency,
and release builds refuse plain http.

**Still open:** tokens do not expire. That is fine for a tunnelled dev box
holding test accounts and must change before deployment — the design argument
is in [DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md) under B4.4.
