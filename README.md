# Nigehban

> *nigehbān* (نگہبان) — **guardian, one who watches over**

**A personal-safety wristband and a family alert network.** Press a button on the
band and the people who care about you know within a second — where you are, and
that you need them. Fall down and say nothing, and they find out anyway.

Built for the **Bano Qabil × Alibaba Cloud Hackathon**.

|  |  |
|---|---|
| **Band** | Seeed Studio XIAO nRF52840 Sense · Arduino C++ · BLE 5.0 · on-board LSM6DS3TR-C IMU |
| **App** | React Native (Expo SDK 57) · Android · one hand-written Kotlin native module |
| **Server** | FastAPI · Postgres · WebSockets · a 5-second escalation sweeper |
| **Scale** | 28 REST endpoints + 1 socket · 11 tables · ~17k lines app · 2.7k server · 2.2k firmware |
| **Proof** | 10 automated tests that need no phone, and a defect register that names its own failures |

---

## The problem

Every personal-safety app on the store has the same hole in it: **it assumes you
can reach your phone, unlock it, find the app, and press a button.** The
situations these apps exist for are precisely the situations where you cannot do
any of those four things.

And the second hole is worse, because it is invisible: **an app that has been
killed by Android is indistinguishable, from the outside, from an app that is
working.** The screen says *protected*. The service was reaped forty minutes ago.
Nobody finds out until an emergency does not get through.

Nigehban answers both. A button on your wrist, so no phone is needed to raise an
alarm. And **every deadline lives on the server**, so when a phone goes quiet,
somebody is told that it went quiet — the silence is itself the alert.

---

## How it fits together

```
   Band ──BLE──▶ Ward's phone ──HTTPS/WSS──▶ Server ──WS + push──▶ Family phones
  (XIAO           (Expo app)                (FastAPI)              (Expo app)
   nRF52840
   Sense)                                   ┌──────────────┐
                                            │   SWEEPER    │  every 5 s:
                                            │ deadlines    │  missed check-ins,
                                            │ nobody's     │  High Alert buzzes,
                                            │ phone owns   │  heartbeat watchdog
                                            └──────────────┘
```

**One app, two roles.** Everyone signs up the same way and everyone can both
raise and receive alerts — a mother watching a daughter runs the same code path
as a daughter watching her mother.

**Routing rule:** an alert raised by user X reaches every user linked to X, and
nobody else.

---

## See it work in five minutes — no hardware needed

The wristband is **not required** to demo any of this. The phone can run the
band's own firmware — the same gesture engine, the same event JSON on the wire.

```bash
pip install -r requirements.txt
python server/migrate_pg.py            # idempotent
python server/nigehban_server.py
```
```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev-tunnel.ps1   # server + public HTTPS tunnel
```
```bash
cd nigehban-app && npm install && npx expo start
```

Then, on two phones:

| # | Do this | Watch this |
|---|---|---|
| 1 | Both phones: create an account | |
| 2 | Phone A → **FAMILY** → **MAKE A PAIRING CODE**; Phone B enters it | Linked. Two people had to act |
| 3 | Phone A: hold **SOS** | Phone B goes red, vibrates, shows the name and a **live map pin** |
| 4 | Phone B: **I'M ON IT** | Phone A sees who is responding |
| 5 | Phone A: **I'M SAFE** | Phone B's alarm clears |
| 6 | Phone B: **ASK FOR A CHECK-IN** | Phone A gets a live 90 s countdown → answers → Phone B is told |
| 7 | Phone A: **ARM HIGH ALERT** | Phone B's FAMILY tab flips to `ARMED` in sub-second real time |
| 8 | **Now force-quit Phone A entirely.** Ask for a check-in and ignore it | 90 s later Phone B gets a severity-3 alert marked `source: server` |

**Step 8 is the one to watch.** It is the whole thesis of the product: the
escalation happened with the wearer's app dead, because the deadline was never
the phone's to keep.

Full instructions: [docs/TESTING_WITHOUT_HARDWARE.md](docs/TESTING_WITHOUT_HARDWARE.md).

---

## What it does — the full feature set

### 🤝 Identity, pairing and consent

- **Accounts** — register, sign in, session tokens stored **hashed** (SHA-256), role owned by the server row, never by the client.
- **Two-party pairing, two paths.** A **10-minute, single-use pairing code** for when you are in the same room, or an invite to somebody's permanent `NGB-` code that **they** must accept.
- **Nothing is shared in either direction until both people have acted.** Declining is permanent and silent.
- **The code space cannot be walked.** An invite to a code that does not exist returns a byte-identical response to one that does — so the endpoint cannot be turned into a directory of who has an account. That is precisely the question somebody hiding from an abuser needs the server *not* to answer.
- **Removing a family member is PIN-gated**, because the person most likely to want it removed is not the wearer.

### 🚨 Emergency

- **Instant SOS** from the app button *or* a **double-tap on the band**, with a live map pin.
- **Family takeover** — the receiving phone goes full-screen red, vibrates, sirens, and shows the name and position.
- **"I'M ON IT"** puts the responder's name in front of the wearer, so they know somebody is actually coming.
- **Stand-down** from the app or from a **single press on the band** — clears every family member's alarm at once.
- **Good Samaritan fan-out.** A severity-5 alert carrying a position is offered **anonymously and coarsely** to non-family users within **800 m** — no name, pin snapped to a 300 m grid. Only when a stranger says **I'M GOING** is the identity and the exact position released, and their name is attached to the alert.
- **The severity ladder decides what happens**, and it is a deliberate design, not a number:

| Severity | Kinds | What it buys |
|---|---|---|
| **5** | `sos` · `accident` · `snatch` | Every family member paged **plus** the Good Samaritan fan-out |
| **4** | `fall` | Lock-screen takeover and siren |
| **3** | `checkin_missed` · `watch_lost` · `going_dark` | The family is told, no siren |

  A **missed High Alert check-in is not on this table** — it is an `sos`, severity 5. High Alert is armed deliberately by somebody who has decided the next stretch of their evening needs watching, and its whole contract is *ask me every five minutes, and if I stop answering, something is wrong*. Delivering the moment that contract comes true as the quietest alert in the product was exactly backwards. The Good Samaritan broadcast stays **pending** on that path: the alert exists *because* the person could not answer, and their silence is not consent to show strangers where they are — the wearer or a family member allows it from the app.
| **2** | `checkin_req` | A question, with a countdown |
| **1** | `low_battery` · `band_battery` · `checkin_ack` · `sos_clear` · `near_miss` | Notice, or private record |

  A road crash sits with the SOS and not with the fall, and that is not a matter of degree: a fall is one person on the ground and what helps is somebody who knows them; a crash is that plus traffic still moving through it, and the useful responder is whoever is nearest.

### 👁 The watch — deadlines nobody's phone owns

- **Remote check-in.** A family member asks *"are you okay?"*; the band buzzes and the wearer has a **server-owned 90-second window**. Miss it and the family is told — *with the wearer's app force-quit*.
- **High Alert.** Armed in one tap, disarmed only behind **four digits**. That asymmetry is the feature. While armed the **server** buzzes every **five minutes**, and each buzz opens a real check-in row — so ignoring the server escalates by exactly the same path as ignoring a parent. Miss one and it becomes an **SOS**, not a footnote.

  The interval used to be randomised between five and ten minutes, so a wearer could not learn the rhythm. That bought unpredictability against somebody gaming their own safety device — not a real threat — and it cost the only number that matters: at the top of that range a person could be taken a second after answering and not be missed for ten minutes. Five flat halves the worst case and makes the promise sayable in one sentence.

- **An SOS asks its own check-ins, and two answers end it.** Every five minutes while an alert is live, on the same rhythm, worded differently: this is the question answered to *get out* of something rather than to stay clear of it. Two in a row — ten minutes of a person still able to answer — and the server stands the alert down itself and tells the family they are safe. Missing one raises nothing (they are already being sirened about) and puts the run back to zero. Before this, an SOS raised from an idle phone asked nothing at all and could only be left by pressing a button, which is exactly what somebody being followed home cannot reach for.

- **Live location.** An alert used to carry one position: the fix baked in when the button went down. For a fall in a kitchen that is the whole answer; for a snatch it is the answer for about thirty seconds. A live alert now reports **every 10 seconds for the first 20 minutes, then every 30**, and the trail is kept — so the family see not just *where* but *which way*. Tracking outlives the stand-down by **half an hour at 30 s**, because "I'm safe" gets pressed at the top of a street she still has to walk down.

- **A map that actually moves, and a link you can send to the police.** Every "see where they are" in this product used to be `maps.google.com/?q=<lat>,<lon>` — a photograph. The family member opens it during a siren, sees a pin, and that pin is still there twenty minutes later while she is a kilometre away. That is not fixable from our side: nothing lets an app push a new position into somebody else's maps app.

  So the map is **our own page**. It asks the server where she is every five seconds and the marker moves on its own, with the trail behind it and a Directions button that always routes to the *current* position. The app embeds that same page, so the family and whoever they phoned are never looking at two different answers.

  The link is the part that matters most in practice, because **the person who needs it usually does not have the app**: the police, a rickshaw driver, the cousin who never installed anything. It is 32 characters of HMAC — unguessable, un-enumerable, stored only as a hash — and it **dies with the tracking window**, so a link forwarded into a WhatsApp group cannot become a permanent window into somebody's movements.

  It rides the Android **foreground service** that was already running, so the fixes keep going out with the app backgrounded, swiped out of Recents, or killed — and unsent fixes buffer through a dead zone and flush as one batch. The cadence and the stop condition are the **server's**, restated in the answer to every fix: a tracker whose stop condition lives only in the app runs for ever the one time the frame telling it to stop goes missing. The wearer is told it is on, in the app and in the service notification.
- **Heartbeat watchdog.** The phone beats every 60 s while armed. **Three minutes of silence raises `watch_lost`**, carrying the last position reported.
- **`watch_lost` is a rule about a transition, not a reading.** It fires only when a live link to a *physical* band and a running alert were both true and *then* the link went away — and a drop starts a 120-second clock rather than an alert, so a sleeve or a microwave costs nothing. See below for why this rewrite matters.
- **Watch-status tile.** The family's screen shows the health of the watch itself — armed, band linked, last heartbeat — at the **same 180 s threshold the server uses**, so the screen and the sweeper never disagree in front of a user.

### 🩺 Detection

- **Fall detection on the band** — LSM6DS3TR-C at 100 Hz, range set explicitly to 16 g, free-fall → impact → stillness state machine.
- **Crash detection** — a second detector, `impact`, for the falls that never free-fall. A car hitting something has no weightless stage at all, so the same machine cannot catch it. The band reports the impact and the **phone classifies it against GPS speed**.
- **A fall asks you first.** A 30 s (severity 4) or 15 s (severity 5) countdown, vibrating through the last five seconds. **Only silence reaches your family.**
- **Cancelling writes a `near_miss`** the server records and tells nobody — data for tuning thresholds, not a reason to wake four people.
- **The escalation survives the app being killed**, because the question is routed through `POST /checkin/self` and it is the *sweeper* that raises the `fall` or `accident` alert.
- **Cancelling a fall needs no PIN — on purpose.** Asking somebody who has just hit the ground to recall a passcode in 45 seconds was buying false alarms, and the band's single tap already walked past the gate. A 1.5-second hold answers the real threat (a pocket) without a memory test. The PIN stays where there is an adversary: High Alert disarm, family removal, the SOS drop.

### 📡 Delivery — the part that is hard

Three independent mechanisms, because which one you need depends on what has to survive:

| Mechanism | Keeps working when | Used for |
|---|---|---|
| FCM / Expo push | The app is **fully dead** | Alerts arriving from the server |
| Foreground service | The app is off-screen or swiped from Recents | Holding the BLE link, sending heartbeats |
| **Native alarm module** (Kotlin, in-house) | **Screen locked, app dead** | Lock-screen takeover and looping siren |

- For severity ≥ 4 the server sends **two** pushes: the visible one, and a **data-only** one that starts a headless runtime and fires the native alarm. Sent *in addition*, never instead — Doze can drop the silent one, and then the visible notification and its tap routing are what is left.
- **Notification tap routing** opens *that alert*, even from a cold start.
- **DND-bypass emergency channel.**
- **Offline SOS queue.** The press is dispatched **locally first** and vibrates before the network is even attempted, so the SOS screen appears with no connectivity at all. Unsent alerts are persisted and flushed on reconnect, on every return to foreground, and on a 30 s timer. The screen says *"Sent to 3 people"* or *"Not yet — waiting for signal"* — **never one for both**.
- **A dead socket that looks alive is handled.** A carrier NAT drops an idle mobile connection without telling either end: `onclose` never fires, `readyState` stays OPEN, and the header goes on saying **connected** while every alert lands in a pipe that ends nowhere. There is a 30 s ping with a 10 s pong deadline.
- **The wearer's own side is covered too** — a sticky notification for their own live SOS, a silent-but-vibrating notification when somebody answers (silent on purpose: the person it reaches may be hiding), and the responder list restored when the app reopens.

### ⌚ The band

| Gesture | Event | Result |
|---|---|---|
| Double-tap | `sos` | SOS to the whole family, severity 5, live map pin |
| Single press | `checkin_ack` | Answers a check-in, or **stands down a live SOS** |
| Hold 3 s | `high_alert_on` / `off` | Arms High Alert |
| Fall detected | `fall` | Severity 4 — starts a countdown before escalating |
| Hard impact | `impact` | Classified against GPS speed → `accident` (severity 5) |
| every 10 s | `hb` | Heartbeat: battery and link state, never an alert |

- **The band↔phone protocol is newline-delimited JSON over the Nordic UART Service, and it is frozen.**
- **What the wrist tells you.** Every press gets a tick as the button goes *down*, so two taps are felt as two — you can tell *"that did not register, press again"* from *"that registered and failed, go find your phone"*. The **confirmation** comes separately, once the *phone* knows the answer, because the band cannot: a successful BLE write only means the phone heard the press, not that anybody was paged. **One firm buzz** — the family knows. **Three medium pulses** — saved, not yet sent. **Two long heavy buzzes** — it did not go.
- **The band is locked, twice.** It pairs with a six-digit passkey, *and then* asks for the same six digits again over that encrypted link before it will emit a single event or obey a single command. Two locks, because a bond proves a phone paired once — not that it still should be here. **Changing the PIN is what actually revokes a phone**, and the first lock cannot do that on its own.
- **The wearer can name their band**, and the name lives in the nRF52's flash and goes out in the advertisement — so Android's own Bluetooth list and nRF Connect follow it.
- **A forgotten PIN is recoverable** — it is held against the account (migration 009), with rate-limited guesses, the old PIN required to change it, and a button-through-boot way out on the hardware itself.
- **Two batteries, told apart.** `band_battery` (severity 1) is the wristband; `low_battery` and `going_dark` (severity 3) are the phone. Not cosmetic: a flat band means the safety device is off the air *while the phone is still reachable by push*; a flat phone closes every path to the family, **including that push**.

### 📱 Android survival, and the app itself

- **Foreground service that runs on the right condition** — a band is linked, *or* the phone is armed. A family member watching from across town gets no permanent service, no permanent notification, and no *"Allow location all the time"* prompt for a process with nothing to keep alive.
- **OEM onboarding.** Xiaomi, Huawei, Oppo and Vivo kill foreground services silently. The app reads the vendor from `Platform.constants.Manufacturer` and shows **only that vendor's** instructions, every deep link wrapped and falling back to the app-settings page, with the manual steps left on screen for when a class name moves.
- **A diagnostics panel** that reports what is actually true — push token *accepted by the server*, not merely held by the phone; `full alarm` vs `vibration only`; the Android 14+ full-screen permission, which is the one thing every other green row cannot tell you.
- **Two role shells** on one codebase — a five-tab admin console with a wire log, and a three-tab end-user shell. Only the *shell* forks; the takeover, check-in sheet, Samaritan call and fall window render for both.
- **One design system** — Outfit + Space Grotesk, semantic tokens, a `ui.js` component kit, 48 pt minimum touch targets, no emoji, and empty/offline/loading/permission-denied states on every screen — including a server-offline banner that says plainly that an alert raised right now would reach nobody.
- **App-security PIN** cleared on sign-out, so a shared handset does not carry the last account's lock.

---

## Six decisions worth a judge's five minutes

**1. The phone is an actuator, never a timekeeper.**
Every deadline — check-in windows, High Alert intervals, escalation timers — lives on the server, in a five-second sweeper task. The phone buzzes the band and reports back; if it goes quiet, the server notices and tells the family. This is what makes the product work when Android kills the app, when the battery dies, or when the phone is taken. It is also the one part that **cannot be demonstrated with client code**:

```bash
python server/nigehban_server.py            # one terminal
python tests/test_consent_and_sweeper.py    # another
```

A check-in created there escalates on its own deadline with nothing connected to anything.

**2. The protocol was frozen at hour zero, which bought a phone that *is* the band.**
Because the band↔phone contract was fixed before anyone opened an editor, [`virtualBand.js`](nigehban-app/src/virtualBand.js) could port the firmware's gesture engine to JavaScript and emit **byte-identical** events. The consequence is that firmware and app work ran in parallel for five days, the entire product loop is demoable with no hardware in the room, and the hardware demo has a software understudy if a board dies on stage.

**3. `watch_lost` was rewritten from a *reading* into a *transition*.**
It used to be a query: the sweeper selected rows whose columns happened to look bad at the moment it ran — which pages a family for a state that was never entered. Every SOS from a killed app also raised a contradictory `watch_lost` beside the real emergency. The fix was not the one-line `UPDATE` the bug report planned; the rule was lifted into its own module, [`server/watch_lost.py`](server/watch_lost.py), as **pure functions**, and the row now records *what was witnessed at the beat* rather than what is true at sweep time. The states that get it wrong are the ones nobody can stage on a desk — a band dropping in the same second an SOS is pressed, a link flapping in a stairwell — so they are asserted directly, with no server and no database:

```bash
python tests/test_watch_lost_transition.py
```

**4. Consent is a safety feature, so it is enforced where a UI cannot lie about it.**
`POST /family` used to link two accounts without the other person's agreement. In a product for people avoiding stalkers that is not a rough edge, it is the whole threat model inverted. Both pairing paths now require two people to have each *done* something, and the non-enumerable invite response is tested at the protocol level rather than checked by eye.

**5. Rate limits stop exactly where they would invent an emergency.**
Every write endpoint is rate limited **except `/alert` and `/heartbeat`**, and the reasoning is written into the `RateLimit` docstring: a 429 on either one is indistinguishable, from the server's side, from a dead phone. A rate limit there would manufacture the emergency it exists to protect against.

**6. The project keeps a register of its own failures, and the register is the interesting document.**
[docs/BUG_LIST.md](docs/BUG_LIST.md) carries 19 filed defects with symptom, cause, fix and — where it applies — the reason a fix was *rejected*. It records that BUG-010 reproduces on a Samsung and **not** on a Vivo, and concludes that the fix therefore *must not be verified on the Vivo*. It marks four defects **stale** rather than fixed: still in the code, unreachable because the feature that reached them was switched off, and returning the day it comes back.

That habit came from being burned. One `android/` line in a `.gitignore` kept a hand-written Kotlin module out of git, so **every EAS build compiled without it** — autolinking skips absent modules, Gradle compiled nothing, and `requireOptionalNativeModule` returned null, all three by design and none of them complaining. The build was green. The feature was not there. There is now a config plugin, [`withNativeModuleGuard.js`](nigehban-app/plugins/withNativeModuleGuard.js), that fails the build instead.

> **The rule the whole repo runs on:** a feature is done when it has been
> *observed working*, not when the code reads correctly. Every serious defect
> this project has shipped looked like working software from the UI.

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
query at the wrong database is easy to do and hard to notice, **because both
databases answer**. On a fresh database load `server/supabase_migration.sql`
once first, then let `migrate_pg.py` carry it forward.

The server prints the host and database name it connected to on startup. Read
that line before debugging anything.

> **Ordering bites here.** Migration → server → app. Backwards, every
> `POST /heartbeat` fails on a missing column, no heartbeats are recorded, and
> three minutes later the sweeper pages **every armed user's entire family**.

To reach it from phones on mobile data — which is how you will demo:

```bash
ngrok http 8000          # or: scripts/dev-tunnel.ps1  (server + tunnel, self-verifying)
```

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

> **Two servers, easy to confuse.** Metro (port 8081) ships the JavaScript and
> is what the QR code points at. The Nigehban server (port 8000, or your ngrok
> URL) holds accounts and alerts, and is what the login screen wants.

`npm run web` opens the same app in a browser for a much faster loop — auth,
family, the live socket and the virtual band all work there.

### 3. Bluetooth and the real band

BLE is a native module, so **Expo Go cannot load it**. Without a development
build the app falls back to simulated band buttons — every other feature works
normally, which is exactly what let app work proceed before hardware existed.

```bash
npm install -g eas-cli
eas login && eas init
eas build -p android --profile development
```

Install the resulting APK on the ward's phone; the app detects its environment
and switches on its own.

**Four traps, each of which has cost this project an hour:**

1. **The band accepts one BLE connection at a time.** Close `nigehban_hub.py`, close nRF Connect, and kill the app's previous run — a connected band is not advertising, so nothing else can see it. If a scan finds nothing, reset the band first.
2. **On Android 12+, grant location *and* switch Location Services on**, or the scan returns zero results with no error and no callback. `BLUETOOTH_SCAN` is declared without `neverForLocation`, so the OS treats scanning as location-capable.
3. **Upgrading a band from pre-lock firmware: forget it in Android's Bluetooth settings first.** The old build needed no pairing and this one does; a phone reconnecting with a stale bond fails encryption, and no app can clear an Android bond for you.
4. **The first operation against the band always fails, and that is normal.** Android does not pair on connect — it pairs the first time something touches an attribute that demands it, fails *that* operation, raises its dialog, and never goes back to what it was doing. The subscribe is that operation, so it is retried until the bond exists.

Firmware: open [`nigehban_band_nrf52/nigehban_band_nrf52.ino`](nigehban_band_nrf52/nigehban_band_nrf52.ino)
in the Arduino IDE. Change `DEFAULT_PAIR_PIN` before flashing, or set it from
the app on first link. Bench bring-up sketches, one unknown each, are in
[`firmware/`](firmware/).

---

## Repository layout

```
server/
  nigehban_server.py        28 endpoints + /ws: accounts, family links, alerts,
                            live push, and the five-second sweeper
  watch_lost.py             the absence rule, as pure functions
  migrations/               9 numbered, idempotent
  supabase_migration.sql    the base schema — 11 tables

nigehban-app/
  App.js                    shell, alert takeover, band -> server wiring
  src/api.js                REST client, reconnecting socket, ping/pong deadline
  src/band.js               BLE link, pairing, PIN auth, reconnect
  src/virtualBand.js        the phone AS the band — the .ino ported to JS
  src/bandLink.js           one seam, two radios: real BLE or virtual
  src/alertQueue.js         local-first dispatch, persisted, flushed on reconnect
  src/watch.js              heartbeat: the silence the server watches for
  src/state.js              the client state machine, transitions as data
  src/motion.js             impact classified against GPS speed
  src/alarm.js              one seam: native lock-screen alarm, or vibration
  src/bgNotifications.js    the silent push that wakes a killed app's siren
  src/security.js           the four digits in front of the things with an adversary
  src/theme.js  src/ui.js   design system: tokens, type scale, component kit
  modules/nigehban-alarm/   Kotlin: full-screen intent + siren until dismissed
  plugins/                  config plugins, incl. the native-module build guard
  src/components/           CheckinBanner · HighAlertPanel · WatchStatusTile
                            FallCountdown · SosLiveView · SamaritanCall · PinSheet
                            BandPinEntry
  src/screens/              Auth · Home · Band · Family · Alerts · Setup
  src/screens/user/         the end-user shell: Dashboard · SosLive · AddFamily
                            DisarmPad · UserAlerts · UserSettings

nigehban_band_nrf52/        the band firmware (Arduino, ~2.2k lines)
firmware/t1..t7/            bench bring-up sketches, one unknown each
tests/                      10 suites: consent, sweeper, samaritan, sockets,
                            offline queue, watch_lost, battery split, sign-out
scripts/dev-tunnel.*        server + public HTTPS tunnel, self-verifying
scripts/db.py               "which database am I actually on?"
nigehban_hub.py             the original laptop Guardian — still the best rig
                            for testing firmware with no phone in the room
docs/                       plans, specs, the defect register
```

---

## Testing — five levels, and the rule for choosing one

Test each feature at the **lowest** level that can prove it. Climbing a level
costs an order of magnitude more time.

| Level | Rig | Proves |
|---|---|---|
| **L0** | Server + `python tests/*.py` | Routing, consent, deadlines, escalation — **no phone at all** |
| **L1** | `npm run web` + browser | Auth, pairing, the socket, the gesture engine, the state machine |
| **L2** | Two phones, Expo Go, virtual band | The whole product loop across the internet, **no hardware** |
| **L3** | Two phones, **dev-build APK** | BLE, push, foreground service, lock-screen alarm |
| **L4** | Dev build + the real nRF52 band | Reconnect after a kill, haptics, power budget, IMU |

---

## Where it honestly stands

**28 tracked capabilities:** 15 observed working end to end · 4 built but not yet
watched on a device · 2 partially built · 7 not built, **of which 2 are
deliberate v2 cuts** designed to the wire-protocol level rather than left vague.

The full scoreboard, with an *evidence* line and a *how to prove it again* line
for every single row, is [docs/FEATURE_STATUS.md](docs/FEATURE_STATUS.md).

**Known limits, stated plainly:**

- **No GPS or cellular on the band.** Location always comes from the phone. If the phone is gone, the heartbeat watchdog tells the family with the last known position — the BLE mesh that would let the band reach help directly is designed but not built.
- **An SOS survives a dead network, but nobody is reached until signal returns.** The press is queued honestly and the screen says so, so the alert is *delayed* rather than lost — but a phone with no signal still reaches no family member. That is the limit the v2 mesh exists to remove.
- **An SOS only leaves the wrist while the app or its foreground service is alive.** The band *could* raise one from a killed app by putting the press in its BLE advertisement. That path was **switched off on 1 Sep 2026**: it carried no band identity, so one band's press was accepted by every Nigehban phone in range and raised as the wrong person's emergency, while swallowing the second wearer's own press. The code is still there behind two booleans, and the cost of bringing it back — new firmware on every band in the field — is written down in [docs/BAND_WAKE_DISABLED.md](docs/BAND_WAKE_DISABLED.md).
- **The band's reconnect is the open front.** It failed to come back with the screen off, because the retry was a JS `setTimeout` and Android freezes those when the Activity is paused. A fix landed on 3 Sep 2026 — a native `onStateChange` listener plus `autoConnect` pushed into the Android BLE stack, which can wait indefinitely — and it is **not yet device-verified**. Nothing in the band's connection story should be treated as settled until it is.
- **Fall thresholds have never met a real wrist.** Both detectors run, but every threshold is still the literature's starting value. The capture path exists (`{"c":"imucal","on":1}` streams 100 Hz CSV to serial) and [docs/FALL_AND_ACCIDENT.md](docs/FALL_AND_ACCIDENT.md) carries the drop heights *and* the false-positive set that must stay silent — because untuned thresholds are the fastest way to lose trust: a bag falling off a chair must not page a mother at 2 a.m.
- **Tokens do not expire.** Fine for a tunnelled dev box, must change before deployment. Access+refresh was considered and *rejected*: it does not address a stolen phone, where both credentials sit in the same storage, and rotation races with the 60 s heartbeat in a way that logs a wearer out mid-emergency. B4.4 is a sliding session window instead.
- **The band hardware is not finished.** The motor driver, LiPo and enclosure are specified but unbuilt, so the real band cannot buzz yet.
- **Nothing is deployed.** The server runs on a laptop behind ngrok; the Alibaba ECS + Docker + Caddy pipeline is designed and not stood up.
- **Android only.** iOS forbids background BLE scanning without a service-UUID filter and has no foreground-service equivalent. Stated as scope, not as an oversight.

---

## Roadmap

Designed to the wire-protocol level in [docs/EXECUTION_PLAN.md](docs/EXECUTION_PLAN.md) §13, not yet built:

- **Working with no phone at all** — the band beacons an encrypted, replay-proof SOS; any nearby Nigehban phone relays it silently and learns nothing about who sent it.
- **Anti-snatching lockdown** — a BLE disconnect *plus* the phone travelling away from where it disconnected locks the screen, captures silently, and alerts the family with the direction of travel.
- Cloud deployment on Alibaba ECS behind Caddy · Qwen severity scoring and Urdu dispatch text · WhatsApp fan-out · LRA haptics · on-device scream detection · a cellular band · token refresh · iOS.

---

## Security notes

- **Session tokens are stored hashed.** A copied database is not a list of live sessions.
- **The band will not talk to a phone that cannot prove itself** — encrypted, MITM-protected characteristics, plus a second application-level PIN over that link. The honest limits of legacy passkey pairing are written down rather than glossed over: [docs/BAND_PIN_AND_NAME.md](docs/BAND_PIN_AND_NAME.md).
- **CORS is an allowlist that is empty by default** (`ALLOWED_ORIGINS`).
- **Release builds refuse plain HTTP.** `usesCleartextTraffic` is gated on the EAS build profile, so dev and preview keep LAN testing and production does not.
- **`.env` and `events.jsonl` are gitignored on purpose** — the first holds the database password, the second holds location history. `config.json` ships with placeholder contacts and empty API keys; if you fill in real numbers or a Telegram/CallMeBot/DashScope key, take it out of version control first.
- **Still open:** tokens never expire (B4.4), and the expiry must not ship before the app grows a 401 branch — a session ending while the phone is backgrounded would stop the heartbeat silently and page the family for an emergency that is not happening.

---

## Where the detail lives

| Document | What it is for |
|---|---|
| [docs/FEATURE_STATUS.md](docs/FEATURE_STATUS.md) | **Start here.** Every capability, its status, its evidence, and how to prove it again |
| [docs/BUG_LIST.md](docs/BUG_LIST.md) | The defect register — symptom, cause, fix, and rejected fixes |
| [docs/EXECUTION_PLAN.md](docs/EXECUTION_PLAN.md) | Phases, the frozen protocol, schema, circuit, the v2 designs |
| [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md) | The same work sliced by workstream; §14 is the silent-failure pass |
| [docs/TESTING_WITHOUT_HARDWARE.md](docs/TESTING_WITHOUT_HARDWARE.md) | The virtual band, the browser loop, the two-phone test |
| [docs/BAND_PIN_AND_NAME.md](docs/BAND_PIN_AND_NAME.md) | The two locks, the protocol, and the way out of a forgotten PIN |
| [docs/BAND_FEEDBACK_SPEC.md](docs/BAND_FEEDBACK_SPEC.md) | What each buzz means, and why the confirmation is separate from the tick |
| [docs/FALL_AND_ACCIDENT.md](docs/FALL_AND_ACCIDENT.md) | Both detectors, the thresholds, and the calibration protocol |
| [docs/BAND_WAKE_DISABLED.md](docs/BAND_WAKE_DISABLED.md) | Why the beacon path is off, and what it costs to bring it back |
| [docs/BACKGROUND_SERVICE_AND_OTHER_FEATURES.md](docs/BACKGROUND_SERVICE_AND_OTHER_FEATURES.md) | The foreground service, the battery split, database setup |
| [docs/NIGEHBAN_BUILD_GUIDE.md](docs/NIGEHBAN_BUILD_GUIDE.md) | Building the physical band |
| [firmware/README.md](firmware/README.md) | Bench sketches `t1`–`t7`, and the `VBAT_ENABLE` hardware warning |

---

## The team

Built for the **Bano Qabil × Alibaba Cloud Hackathon** by:

- **Muhammad Moazzam Khan**
- **Muhammad Usman**
- **Muhammad Kazim**
- **Asjal Amir**



---

## Copyright

**Copyright © 2026 the Nigehban team. All rights reserved.**

This is an unreleased hackathon project. No licence is granted to use, copy,
modify or distribute this software or the Nigehban name without the written
permission of the authors.

Third-party components keep their own licences — Expo and React Native (MIT, see
[`nigehban-app/LICENSE`](nigehban-app/LICENSE)), FastAPI, `react-native-ble-plx`,
and the Outfit and Space Grotesk typefaces (SIL Open Font License).

---

<p align="center">
  <em>نگہبان — one who watches over.</em>
</p>
