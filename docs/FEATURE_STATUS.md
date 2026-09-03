# Nigehban — Feature Status & Test Guide

**Audited:** 29 Aug 2026, against branch `bugs-fix` @ `e4acff5`, by reading the
working tree — not the plans. Where this document and
[DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) disagree, this one was checked
against the code more recently; where the code disagrees with both, the code
wins and this file is wrong.

One rule runs through everything below, and it is the reason this repo has the
history it has:

> **A feature is "done" when it has been observed working, not when the code
> reads correctly.** Every serious defect this project has shipped looked like
> working software from the UI. Nothing throws, nothing logs, the screen says
> the right thing, and the alert does not arrive.

So each feature here carries a **status**, an **evidence** line (what actually
proved it), and a **test** (the cheapest way for you to prove it again).

---

## Since this audit — 1 Sep 2026

The 29 Aug audit below is left as it was written. This section is what has
changed since, because a status file that is quietly edited in place stops being
evidence of anything. **[BUG_LIST.md](BUG_LIST.md) is the live defect record**
— it carries the cause and the fix for each item named here.

**Done since, and observed on hardware** (Samsung, Android 14, release APK on
`fix/ble-scan-throttle`, 1 Sep):

- **The band has a lock and a name** (3 Sep). It used to advertise an open
  Nordic UART Service: anybody in range with nRF Connect could subscribe to
  every press and heartbeat, or write `{"c":"alarm"}` and buzz it flat. It now
  pairs with a six-digit passkey *and* stays mute behind `{"c":"auth"}` over
  that encrypted link — two locks, because a bond proves a phone paired once
  and not that it still should be here, so changing the PIN is what actually
  revokes a phone. The wearer can also rename the band; the name lives in the
  nRF52's flash and goes out in the advertisement, so Android's Bluetooth list
  follows it. Pressing **Disconnect** forgets the PIN, losing signal does not.
  Full reasoning, protocol and the honest limits of legacy passkey pairing:
  [BAND_PIN_AND_NAME.md](BAND_PIN_AND_NAME.md).

- **The offline SOS queue** — the item §5 called "highest-value on this list".
  Local-first dispatch, unsent alerts persisted, flushed on reconnect, and
  delivery state rendered honestly. §3.3's caveat and Blocker #3 are corrected
  below; [alertQueue.js](../nigehban-app/src/alertQueue.js),
  [tests/test_offline_queue.py](../tests/test_offline_queue.py).
- **The BLE scan throttle** (BUG-002) — the app could drive itself into
  Android's 5-scans-per-30-seconds limit and never escape without a manual
  Bluetooth toggle.
- **The wearer can now see their own emergency.** A live SOS survives the app
  being swiped away (BUG-005), the wearer's own phone shows a sticky
  notification for it (BUG-006), and the band buzzes to confirm the press
  (BUG-007). Before this the SOS went out correctly and the wearer had no way
  to know.

  *Since revised on `feat/press-feedback-and-link-led`: the band's buzz used to
  fire at local dispatch, so it confirmed "sent" for an alert that might still
  be sitting in the offline queue. The press now gets a tick from the band and
  the confirmation waits until the server answers.
  [BAND_FEEDBACK_SPEC.md](BAND_FEEDBACK_SPEC.md).*
- **One notification per emergency** instead of two or three (BUG-009).
- **Sign-out no longer leaves the previous account's band paired** (BUG-001).

**Done since, not yet on a device:**

- **Responders survive a closed app** (BUG-008, `fix/responder-notifications`).
  A family member answering now pushes a silent-but-vibrating notification to
  the wearer, and the responder list is restored when the app reopens. The push
  is the part still needing a phone: force-stopped app, screen off.

**New problems found since, all open.** These were found by using the thing, and
most of them were invisible from the UI:

| # | What | Severity |
|---|---|---|
| BUG-010 | The band only reconnects while the screen is on — `retrySoon` is a `setTimeout`, and Android stops those when the activity is not visible | High |
| BUG-011 | Every SOS from a killed app also raises a false `watch_lost`, so a contradictory alert lands beside a real emergency | High |
| BUG-012 | Any band's SOS beacon fires on **every** Nigehban phone in range — an emergency raised on the wrong account, to the wrong family | Critical — 💤 stale |
| BUG-013 | A stranger's press silently discards your own band's SOS | Critical — 💤 stale |
| BUG-014 | A band reboot can discard the next real press | High — 💤 stale |
| BUG-015 | Nothing restores the band link after an OEM kills the app — the wearer carries a band that looks linked and is not | High |
| BUG-016 | Advertising fields fail silently once they no longer fit in 31 bytes | Low today |

💤 **stale** — the defect is still in the code, but the band's beacon wake was
switched off on 1 Sep 2026, so nothing can currently reach it. It is not fixed;
it comes back with the feature. See
[BAND_WAKE_DISABLED.md](BAND_WAKE_DISABLED.md).

Still open from the original nine: **BUG-003** (`lastError` is collected and
rendered by nothing), **BUG-004** (the `error:` status path can still put a raw
library string on screen), and the **`presentAlarm` finding** at the end of
BUG-009 — the lock-screen takeover appears not to be firing on the test device,
which matters because §3.11 below treats it as observed and working.

**What that does to the scoreboard:** the ✅ column is stronger than it reads
below on the app's own behaviour and weaker on the band link. Nothing in the
band's connection story should be treated as settled until BUG-010 and BUG-015
are fixed.

**The beacon path is switched off as of 1 Sep 2026** — BUG-012 and BUG-013 made
it unsafe with more than one band in the room, and rather than fix them now the
feature was disabled behind two booleans, with the code left in place
([BAND_WAKE_DISABLED.md](BAND_WAKE_DISABLED.md)). The consequence to hold on to
while reading anything below about the band: **an SOS only leaves the wrist
while the app or its foreground service is alive.** On an OEM that runs `kill
-9` on a Recents swipe, a press with the app killed reaches nobody, which is
the pre-`3d5efb9` behaviour restored on purpose.

---

## 0. Scoreboard

**28 tracked capabilities.**

| Bucket | Count | What it means |
|---|---|---|
| ✅ **Working — observed** | **15** | Someone has watched it work end to end |
| ◐ **Built — not yet observed** | **4** | Code is in the tree and reviewed; nobody has run it on a device |
| ◑ **Partially built** | **2** | One half works, the other half is missing |
| ☐ **Not built** | **7** | Of which **2 are deliberate v2 cuts**, designed but out of scope |

### ✅ Working — observed (15)

| # | Feature | Where |
|---|---|---|
| 1 | Accounts — register, sign in, hashed session tokens, server-owned role | [`server/nigehban_server.py`](../server/nigehban_server.py), [`Auth.js`](../nigehban-app/src/screens/Auth.js) |
| 2 | Two-party pairing & consent — 10-min pairing code, permanent `NGB-` code, accept/decline, rate limits | [`Family.js`](../nigehban-app/src/screens/Family.js), [`AddFamily.js`](../nigehban-app/src/screens/user/AddFamily.js) |
| 3 | Instant SOS — app button **and** band double-tap → family takeover with a map pin | [`App.js`](../nigehban-app/App.js), [`Home.js`](../nigehban-app/src/screens/Home.js) |
| 4 | Stand-down and "I'M ON IT" — from the app or from the band's single press | [`SosLiveView.js`](../nigehban-app/src/components/SosLiveView.js), [`SosLive.js`](../nigehban-app/src/screens/user/SosLive.js) |
| 5 | Remote check-in with a **server-owned** deadline, and escalation when it passes | [`sweeper()`](../server/nigehban_server.py), [`CheckinBanner.js`](../nigehban-app/src/components/CheckinBanner.js) |
| 6 | High Alert — server-held randomised 5–10 min re-buzz, PIN-gated disarm | [`HighAlertPanel.js`](../nigehban-app/src/components/HighAlertPanel.js), [`PinSheet.js`](../nigehban-app/src/components/PinSheet.js) |
| 7 | Heartbeat watchdog + watch-status tile (3 min of silence while armed → `watch_lost`) | [`watch.js`](../nigehban-app/src/watch.js), [`WatchStatusTile.js`](../nigehban-app/src/components/WatchStatusTile.js) |
| 8 | Good Samaritan — coarse anonymous fan-out within 800 m, identity released only on "I'm going" | [`SamaritanCall.js`](../nigehban-app/src/components/SamaritanCall.js) |
| 9 | Live WebSocket delivery, reconnect, and a 30 s keep-alive ping | [`api.js`](../nigehban-app/src/api.js) |
| 10 | Push to a **force-stopped** app, lock-screen full-screen takeover, looping siren | [`modules/nigehban-alarm/`](../nigehban-app/modules/nigehban-alarm/), [`bgNotifications.js`](../nigehban-app/src/bgNotifications.js) |
| 11 | Notification tap routing — a tapped push opens the right alert, even from a cold start | [`notifications.js`](../nigehban-app/src/notifications.js) |
| 12 | Virtual band — the phone runs the firmware's own gesture engine | [`virtualBand.js`](../nigehban-app/src/virtualBand.js), [`Band.js`](../nigehban-app/src/screens/Band.js) |
| 13 | Real BLE band link — connect, gestures, 10 s heartbeat, battery %, scan/connect fault recovery | [`band.js`](../nigehban-app/src/band.js), [`nigehban_band_nrf52.ino`](../nigehban_band_nrf52/nigehban_band_nrf52.ino) |
| 14 | Design system + **two role shells** — admin console (5 tabs) and end-user shell (3 tabs) | [`theme.js`](../nigehban-app/src/theme.js), [`UserShell.js`](../nigehban-app/src/screens/UserShell.js) |
| 15 | Postgres/Supabase database + idempotent migration runner | [`supabase_migration.sql`](../server/supabase_migration.sql), [`migrate_pg.py`](../server/migrate_pg.py) |

### ◐ Built — not yet observed on a device (4)

| # | Feature | Why it is not ticked |
|---|---|---|
| 16 | **Two batteries told apart** — `band_battery` (sev 1) vs `low_battery`/`going_dark` (phone) | Landed 29 Aug; §6.2 of [BACKGROUND_SERVICE_AND_OTHER_FEATURES.md](BACKGROUND_SERVICE_AND_OTHER_FEATURES.md) is unticked |
| 17 | **Foreground service starts on the right condition** (band linked *or* armed) | Commit `ac31682`, untested on hardware |
| 18 | **BLE link survives the app being closed** — module-scope manager, adopt-on-remount, auto-relink by id | Commit `59fc02d` says so itself; §7.3 of [BRANCH_NOTES](BRANCH_NOTES_ble-close-app-bug.md) is unticked |
| 19 | **DND-bypass emergency channel** end to end | Code fixed 26 Aug; nobody has put a phone in Do Not Disturb and fired an SOS |

### ◑ Partially built (2)

| # | Feature | Done | Missing |
|---|---|---|---|
| 20 | **Fall & accident detection** | `HAS_IMU 1`: both state machines on the band and on the phone, `impact` gated on GPS speed, the question routed through `/checkin/self` so the sweeper escalates with the app dead, `near_miss` written and told to nobody | **Thresholds are still the literature's starting values** — the drop tests and the false-positive set in [FALL_AND_ACCIDENT.md](FALL_AND_ACCIDENT.md) have not been run on the band yet. Wake-on-motion is deferred, so the IMU costs 0.4–0.5 mA of the 200–400 µA idle budget |
| 21 | **Android background survival** | Foreground service, BLE reconnect loop, scan timeout, battery-optimisation prompt, OEM deep links | **N2.3** boot receiver · **N2.4** WorkManager watchdog. A rebooted phone does not come back on its own |

### ☐ Not built (7)

| # | Feature | Note |
|---|---|---|
| 22 | **Cloud deployment** (Alibaba ECS, Docker, Caddy, TLS) | Nothing exists — no Dockerfile, no compose, no Caddyfile, no account. Everything runs off a laptop + ngrok |
| 23 | **Qwen severity scoring / Urdu dispatch text** | Exists only in the legacy [`nigehban_hub.py`](../nigehban_hub.py); not in the server. Pre-agreed cut line |
| 24 | **WhatsApp fan-out** | Same — CallMeBot path lives in the hub, not the server |
| 25 | **Security hardening** | **Three of four closed 1 Sep 2026.** CORS is an empty-by-default allowlist · `usesCleartextTraffic` off on production builds · every write endpoint rate limited but `/alert` and `/heartbeat`, which are exempt on purpose. **Still open: tokens never expire** (B4.4) |
| 26 | **Band hardware build** | Motor driver (transistor + flyback + 100 µF), LiPo via JST-PH, power budget. No haptic feedback on the real band today |
| 27 | **BLE mesh SOS — working with no phone** | **v2, deliberate cut.** Designed to the wire-protocol level in [EXECUTION_PLAN §13.1](EXECUTION_PLAN.md) |
| 28 | **Anti-snatch / theft lockdown** | **v2, deliberate cut.** Firmware keeps `gArmed` and an unbound hold-5s gesture; the alert path is testable via the console's SNATCH button |

---

## 1. Set up a test rig — do this first

Nothing below can be tested until this works, and **on this checkout it does
not** — see [Blocker #1](#6-blockers-ranked).

### 1.1 Prerequisites

- Python 3.10+
- Node 18+
- Postgres 14+ **or** a Supabase project
- [ngrok](https://ngrok.com) — free tier is enough
- An Expo/EAS account, only if you need a dev build (BLE, push, alarm)

### 1.2 Database — the one setting that decides everything

```bash
cp .env.example .env
```

Then set **`DATABASE_URL`** in `.env` at the repo root. There is no second place
to configure a database, on purpose: pointing a query at the wrong one is easy
to do and hard to notice, because both databases answer.

**Local Postgres:**

```bash
createdb nigehban
psql -d nigehban -f server/supabase_migration.sql
```
```
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/nigehban
```

**Supabase** (database only — there is no deployed server): Dashboard → SQL
Editor → paste `server/supabase_migration.sql` → Run. Then take the URI from
Project Settings → Database → Connection string.

Either way, apply migrations **before** starting the server:

```bash
cd server && python migrate_pg.py
```

> **Ordering bites here.** Migration → restart server → build app. Backwards,
> every `/heartbeat` fails on a missing column, no heartbeats are recorded, and
> three minutes later the sweeper pages **every armed user's entire family**
> with `watch_lost`.

Confirm you are on the database you think you are:

```bash
python scripts/db.py "select count(*) from users"
```

### 1.3 The server

```bash
pip install -r requirements.txt
python server/nigehban_server.py
```

It prints `host/dbname` in the startup banner. Read it. Port 8000.

### 1.4 A tunnel, so phones off your Wi-Fi can reach it

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev-tunnel.ps1
```
```bash
./scripts/dev-tunnel.sh
```

Set `NIGEHBAN_NGROK_DOMAIN` in `.env` to a reserved domain, or the address
changes every restart and has to be re-pasted into every phone.

### 1.5 The app

```bash
cd nigehban-app
npm install
npx expo start        # phones, via Expo Go
npm run web           # browser, fastest loop
```

Paste the server address into the app's address box. The rule
([`api.js`](../nigehban-app/src/api.js)): a bare IPv4 or `localhost` gets `http://`,
anything else gets `https://`.

### 1.6 A development build — needed for BLE, push, the alarm, the service

```bash
npm install -g eas-cli
eas login && eas init
eas build -p android --profile development
```

**Expo Go cannot test the killed-app path at all.** Since SDK 53 it cannot
receive a push to a terminated app, it has no BLE module, and it has no native
alarm. Four of the five most important rows in the acceptance matrix need this
APK.

### 1.7 Which role am I?

The role lives on the server row and is re-read on every launch. To make an
account an admin (five tabs, wire log, diagnostics):

```bash
python scripts/db.py "update users set role='admin' where username='srk'"
```

Everyone else gets the three-tab end-user shell. **Only the shell forks** — the
takeover, check-in sheet, Samaritan call and fall window render for both.

---

## 2. The five test levels

Test each feature at the **lowest** level that can prove it. Climbing a level
costs an order of magnitude more time.

| Level | Rig | Proves |
|---|---|---|
| **L0** | Server + `python tests/*.py` | Routing, consent, deadlines, escalation — no phone at all |
| **L1** | `npm run web` + browser | Auth, pairing, the socket, the gesture engine, state machine |
| **L2** | Two phones, Expo Go, virtual band | The whole product loop across the internet, no hardware |
| **L3** | Two phones, **dev-build APK** | BLE, push, foreground service, lock-screen alarm |
| **L4** | Dev build + the real nRF52 band | Reconnect after a kill, haptics, power budget, IMU |

---

## 3. Feature by feature — status and how to prove it

### 3.1 Accounts, sign-in, roles ✅

**Status:** working. Session tokens are stored as SHA-256, and a fresh sign-in
invalidates the previous session.

**Test (L0):**
```bash
curl -X POST localhost:8000/register -H "Content-Type: application/json" \
  -d '{"name":"Ali","username":"ali","password":"secret123"}'
curl localhost:8000/me -H "Authorization: Bearer <token>"
```
Then prove the database is not a list of live sessions:
```bash
python scripts/db.py "select username, token, length(token_hash) from users"
```
`token` must be empty on every row; `length(token_hash)` must be 64.

**What failure looks like:** a plaintext token in that column means a copied
database is every account, signed in.

---

### 3.2 Pairing and consent ✅

**Status:** working. Two paths, one rule — a link requires two people to have
each done something.

| Path | Consent | Result |
|---|---|---|
| Pairing code (`POST /pair` → `POST /invite`) | One issues, the other redeems inside 10 minutes | Linked immediately |
| Permanent `NGB-` code (`POST /invite` → `POST /invite/{id}/accept`) | One asks, the other accepts | Linked on acceptance |

**Test (L2), the important one:**

1. Phone A → FAMILY → **MAKE A PAIRING CODE**. Read it to Phone B.
2. Phone B enters it. They are linked at once.
3. Now the other path: Phone A invites Phone B by their permanent `NGB-` code.
   **Phone B must get nothing they can act on until they accept**, and Phone A
   must see no name, no confirmation that the code even exists.
4. Phone B **declines**. Phone A's list must go on saying *"asked, not answered
   yet"* forever, and re-inviting must return the same cheerful response while
   doing nothing.

**Test (L0), the parts a UI cannot show you:**
```bash
# An invite to a code that exists and one to a code that does not
# must return byte-identical responses.
curl -X POST localhost:8000/invite -H "Authorization: Bearer $T" \
  -H "Content-Type: application/json" -d '{"code":"NGB-ZZZZ"}'
```

**What failure looks like:** any response that distinguishes a real code from a
fake one turns the endpoint into a directory — four characters from a 32-symbol
alphabet is a million guesses, and every hit would come back with a real
person's real name. That is precisely the question someone hiding from somebody
needs the server not to answer.

---

### 3.3 Instant SOS ✅ *(with one serious caveat)*

**Status:** working — from the app button, from the virtual band's double-tap,
and from the real band's double-press.

**Evidence:** proved end to end through `https://<id>.ngrok-free.app` with both
phones on mobile data; band → phone → server → family observed 27 Aug 2026.

**Test (L2) — the five-minute loop:**

1. Phone A: hold **SOS** (or BAND tab → double-tap).
2. Phone B goes red, vibrates, shows the name **and a live map pin**.
3. Phone B taps **I'M ON IT** → Phone A sees who is responding.
4. Phone A taps **I'M SAFE** (or single-taps the band) → Phone B's alarm clears.

**Check the map pin specifically.** Load the Home/Dashboard screen first and
*allow* the location prompt — that fills the cache `lastKnownFix()` reads. An
SOS raised from the BAND tab or from a backgrounded app used to carry no
coordinates at all, which is most of the value gone.

> ### ✅ The caveat above is fixed — corrected 1 Sep 2026
>
> This used to read: *"`App.js` dispatches `SOS_RAISED` only after `POST /alert`
> succeeds, and unsent alerts are not queued — with no connectivity the alert is
> lost, not delayed."* That is no longer true, and leaving it standing would
> send someone to rebuild what exists.
>
> [`App.js`](../nigehban-app/App.js) now dispatches **locally first** and vibrates
> before the network call is attempted, so the SOS screen appears with no
> connectivity at all. A failed send is persisted by
> [`alertQueue.js`](../nigehban-app/src/alertQueue.js) and flushed when the socket
> comes back, on every return to the foreground, and on a 30 s timer while
> anything is still queued. The screen distinguishes *"Sent to 3 people"* from
> *"Not yet — waiting for signal"* rather than showing one for both.
>
> **What is still true:** a queued alert has reached nobody. The phone holds it
> honestly, and says so, but a wearer in a dead zone still has no family member
> looking at it. That is the limit the v2 band mesh exists to remove.
>
> **To reproduce the good behaviour:** kill the tunnel, press SOS, watch the
> screen say *"waiting for signal"*; restore the tunnel and watch it flush.

---

### 3.4 Remote check-in ✅

**Status:** working, and the deadline is **server-owned** — which is the part
that makes it true when the app has been killed.

**Test (L2):**

1. Phone B → **ASK FOR A CHECK-IN** on Phone A.
2. Phone A buzzes and shows a live countdown to the server's `due_at`.
3. Answer it → Phone B is told.
4. Now do it again and **ignore it**, with Phone A's app **force-quit**. Ninety
   seconds later Phone B gets a severity-3 `checkin_missed` marked
   `source: server`.

**Test (L0) — the same thing with nothing connected to anything:**
```bash
python server/nigehban_server.py     # one terminal
python tests/test_samaritan_and_checkin.py
python tests/test_sockets.py
```

> `tests/test_consent_and_sweeper.py` also covers this — but **read
> [Blocker #2](#6-blockers-ranked) before you trust its output.**

---

### 3.5 High Alert ✅

**Status:** working, server-owned. Armed in one tap; disarmed behind four
digits. That asymmetry is the feature.

**Test (L2):**

1. Phone A → **ARM HIGH ALERT** (or hold the band key 3 s).
2. Phone B's FAMILY tab shows `ARMED` in sub-second real time.
3. **Close Phone A's app entirely.** The server goes on buzzing on its own
   randomised 5–10 min schedule, and each buzz opens a real check-in row — so
   ignoring the server's buzz escalates by exactly the same path as ignoring a
   parent.
4. Try to disarm without the PIN. It must be refused.

**Test (L0)** — shorten `HIGH_ALERT_MIN_S`/`HIGH_ALERT_MAX_S` in
[`nigehban_server.py`](../server/nigehban_server.py) if you do not want to wait
five minutes.

**Why the next buzz is shown only to the minute:** the interval is randomised
precisely so it cannot be timed by somebody watching.

---

### 3.6 Fall detection ◑

**Status:** **phone side works, band side does not exist.**

| | State |
|---|---|
| Phone accelerometer state machine at 104 Hz | ✅ [`virtualBand.js`](../nigehban-app/src/virtualBand.js) |
| 30 s (sev 4) / 15 s (sev 5) countdown, vibrating through the last five seconds | ✅ [`FallCountdown.js`](../nigehban-app/src/components/FallCountdown.js) |
| "I'm fine" writes a `near_miss` the server records and tells nobody | ✅ |
| Hold-to-cancel on the end-user shell, plus one press on the band | ✅ [`DisarmPad.js`](../nigehban-app/src/screens/user/DisarmPad.js) — **the PIN was removed from this screen on 2 Sep 2026.** Asking somebody who has just hit the ground to recall a passcode in 45 s was buying a false alarm, and the band's single tap already walked past the gate. A 1.5 s hold answers the real threat (a pocket) without a memory test. The PIN still gates High Alert disarm, family removal and the SOS drop, where there is an adversary. See [FALL_AND_ACCIDENT.md](FALL_AND_ACCIDENT.md) |
| **On the band** | ✅ `#define HAS_IMU 1` — LSM6DS3TR-C at 100 Hz, range set to 16 g explicitly |
| **Crash detection** | ✅ `impact` reported by the band, classified against GPS speed in [`motion.js`](../nigehban-app/src/motion.js) |
| **Escalation survives the app being killed** | ✅ `POST /checkin/self` → `checkins` row → the sweeper raises `fall`/`accident` |
| **Threshold calibration** | ❌ still the starting values. `{"c":"imucal","on":1}` streams the CSV; the protocol is in [FALL_AND_ACCIDENT.md](FALL_AND_ACCIDENT.md) |

**Test (L2):** BAND tab → **FORCE FALL**, or actually drop the phone onto a
cushion. The countdown appears; cancelling writes a `near_miss` that the family
never sees.

**Test that must also pass (matrix #18):** slide a phone off a sofa and get
**no** alert. A bag falling off a chair must not page a mother at 2 a.m.

**Blocked by:** [Blocker #6](#6-blockers-ranked).

---

### 3.7 Battery failsafes ◐

**Status:** the split is written and reviewed; **nobody has watched it fire.**

There used to be one number for two batteries. The app read `band.battery` — in
BLE mode the *wristband's* ADC — sent it as `phone_batt`, and told the family
*"phone about to die."* A wearer at 4 % band and 90 % phone paged his family
about the wrong device.

| Alert | Fires on | Severity | Family sees |
|---|---|---|---|
| `band_battery` | **Band** ≤ 20 % | 1 | "Band battery low" |
| `low_battery` | **Phone** ≤ 20 % | 1 | "Phone battery low" |
| `going_dark` | **Phone** ≤ 5 % | 3 | "Phone about to die" |

The split is not cosmetic: a flat band means the safety device is off the air
while the phone is still reachable by push; a flat phone closes every path to
the family, **including that push**.

**Test (L3):**

- [ ] Family view of a BLE wearer shows **two** numbers: `PHONE BATTERY 68 %`
      and `BAND · Linked · 41 %`.
- [ ] Drain the **phone** below 20 % → "Phone battery low".
- [ ] Drain the **phone** below 5 % → "Phone about to die" + a critical toast.
- [ ] Band below 20 % → **"Band battery low", not a phone warning.** This is
      the one that proves the original bug is dead.
- [ ] Virtual mode → band battery reads `—`, and **only one** alert fires.
- [ ] Charge above the threshold and drop below again → it fires a second time
      (the latch re-arms at +3 %).

To exercise the band alert without fighting the ADC, pin the level with the
firmware's own command: `{"c":"bat","v":10}`.

**Caveat:** with the ADC in its current state (see
[Blocker #5](#6-blockers-ranked)) `band_battery` may fire **never** — which is
a pass for the alert path, not a failure.

---

### 3.8 Watch health / heartbeat watchdog ✅ *(noisy)*

**Status:** working. The phone beats every 60 s while armed; 180 s of silence
raises `watch_lost` at severity 3, carrying the last position reported.

**Test (L2):** arm Phone A, then kill its app (or turn off its network). Within
three minutes Phone B's watch-status tile goes amber at the same 180 s the
server uses — so the screen and the sweeper never disagree in front of a user —
and the family is told.

> **Known defect, not a test failure.** `watch_lost` fires whenever Android
> merely *backgrounds* the app, because the heartbeat is a JS `setInterval`.
> The proposed fix is a high-priority data push and a ~30 s wait before
> declaring it: a backgrounded phone answers, a dead one does not. The name is
> also wrong — it reads to a family member as *the wristband died*, and it is
> about the phone. [Blocker #10](#6-blockers-ranked).

---

### 3.9 Good Samaritan ✅

**Status:** working. A severity-5 alert carrying a position fans an
**anonymous, coarse** copy out to fresh presences within 800 m. Before "I'm
going" there is no name and the pin is snapped to a 300 m grid; saying yes
releases the name and the exact position, and puts the responder's own name on
the alert.

**Test (L0):**
```bash
python tests/test_samaritan_and_checkin.py
```
This checks the promise on the live socket, which is where the app reads it.

**Test (L2):** three accounts, two of them *not* family, all reporting presence
near each other. Raise an SOS on one; the stranger's phone must show a call with
**no name and a coarse pin**, and only after **I'M GOING** does the identity and
exact position arrive on both sides.

---

### 3.10 Live delivery — socket, reconnect, keep-alive ✅

**Status:** working, including the failure mode that used to be invisible.

A carrier NAT drops an idle mobile connection without telling either end:
`onclose` never fires, `readyState` stays OPEN, and the header goes on showing
**connected** while every buzz and every alert lands in a pipe that ends
nowhere. There is now a 30 s ping with a 10 s pong deadline.

**Test (L1) — easiest in a browser:** DevTools → Network → **WS** → the `/ws`
row → Messages. `{"t":"ping"}` out every 30 s, `{"t":"pong"}` back.

To exercise the *timeout* branch rather than the happy path: comment out the
server's `pong` reply in `ws_endpoint()`, restart, and watch the header chip
cycle **connected → offline → connected** on a ~40 s period.

---

### 3.11 Surviving a killed app — push, lock-screen alarm, siren ✅

**Status:** **working, observed on hardware 29 Aug 2026.** This is the hardest
thing in the repo and the box most worth re-checking after any build.

Three independent mechanisms, and which one you need depends on what has to
survive:

| Mechanism | Keeps working when | Used for |
|---|---|---|
| FCM / Expo push | The app is fully dead | Alerts arriving from the server |
| Foreground service | The app is off screen or swiped from Recents | Holding the BLE link, sending heartbeats |
| Native alarm module | Screen locked, app dead | The lock-screen takeover and siren |

For severity ≥ 4 the server sends **two** pushes: the visible one, and a
**data-only** one that starts a headless runtime and fires the native alarm.
Sent in addition, never instead — Doze can drop the silent one, and then the
visible notification and its tap routing are what is left.

**Test (L3), ten seconds, one phone:**

Setup tab → diagnostics panel. Four rows must read:

| Row | Green means |
|---|---|
| Watch notification | `running` |
| Server push | `registered` — the *server* accepted the token, not just the phone holding one |
| Lock-screen takeover | `full alarm` (`vibration only` = Expo Go; the screen will not light up) |
| Alarm on a killed app | `listening` |
| Full-screen permission | `granted` — **Android 14+ only, and a red row here is the one thing every other green row cannot tell you** |

Then press **TEST THE LOCK-SCREEN ALARM** and lock the phone immediately. It
must light up on its own, show Nigehban *over* the lock screen, and sound. It
stops itself after ten seconds.

**Test (L3), the real thing (matrix #6):**

1. Phone B: sign in, then **force-stop** Nigehban from Android settings — not
   swipe-away, force-stop.
2. Lock it, put it down.
3. Phone A: BAND tab → double-tap.
4. Phone B wakes, takes over the lock screen, and sounds.

If a notification appears but the screen stays dark, the silent push was
dropped (usually Doze) and the visible push is doing its job as the fallback.
**That is a degraded pass, not a failure.**

**Also verify the tap:** tapping the push must open *that alert*, not a bare
Home screen — including on a cold start.

> ### ⚠ Added 1 Sep 2026 — the takeover may not actually be firing
>
> BUG-009 found the websocket path posting its fallback notification, and that
> path posts **only** when `presentAlarm()` returns false. So on that device the
> native alarm module was either absent from the build or throwing. The ✅ above
> is from 29 Aug and is not being withdrawn, but "a notification appeared"
> cannot distinguish a working takeover from a broken one — which is exactly the
> failure mode this document opens by warning about.
>
> Re-run the L3 test above and watch the **screen**, not the shade. If it stays
> dark, the row this file calls observed is not.

### The wearer's own side — added 1 Sep 2026

The three mechanisms above are all about the **family's** phone. The wearer's
own phone had nothing: the SOS went out from a swiped-away app, the family was
paged, and the wearer had no way to tell. That group is now fixed —
[BUG-005](BUG_LIST.md), 006, 007 — and BUG-008 adds the missing half, a
notification when somebody answers.

**Test (L3):** raise an SOS, force-stop the app, screen off. Have a family
member tap **I'M ON IT**. The wearer's phone must buzz, show *"<name> is on the
way"*, and **make no sound** — it is silent on purpose, because the person it
reaches may be hiding. Reopen the app: the responder must be listed, with a
truthful elapsed time rather than "just now".

---

### 3.12 Foreground service — when it runs ◐

**Status:** the condition logic is new and **untested on hardware**.

It used to run for anybody signed in. That is the wrong question: a family
member watching from across town held a permanent service, a permanent
notification, and the **"Allow location all the time"** prompt for a process
with nothing to keep alive.

It now runs on either of two independent conditions: **a band is linked**, or
**the phone is armed at all**.

| Phone | Service |
|---|---|
| BLE mode, band linked | On |
| Virtual mode, armed (the phone *is* the band) | On |
| BLE mode, armed, band out of range | On |
| Signed in, idle, no band — a family watcher | **Off** |
| Band unlinked with DISCONNECT, idle | **Off** |

**Test (L3):**

- [ ] **Virtual mode, armed, app swiped from Recents, wait 5 minutes → the
      family is told nothing.** *The most important one.* An earlier version of
      this change broke exactly this case.
- [ ] Band linked, walk out of range → notification **stays up**, band
      reconnects on its own when you return.
- [ ] Band linked, app swiped from Recents → notification stays up.
- [ ] DISCONNECT while idle → notification **disappears**.
- [ ] Sign in on an idle, band-less phone → **no notification**, and **no
      "Allow location all the time" prompt**.
- [ ] Fire an SOS at that band-less phone → the alert still arrives. (Proves
      the push path needs no service.)

**Known cosmetic defect:** the Setup screen's *"Watch notification: not
running"* row is amber with a warning triangle — which, after this change, is
the **correct** state for every family member's phone, so a healthy phone now
reads as broken. [Blocker #11](#6-blockers-ranked).

---

### 3.13 The band — firmware and BLE ✅ / ◑

**Status:** the link works. The hardware around it does not exist yet.

| | State |
|---|---|
| Advertise, NUS, connect, gesture map, frozen protocol | ✅ verified 27 Aug 2026 |
| Line framing — explicit chunking, retry only the failed piece | ✅ (the fault that made everything else look broken) |
| Scan by service UUID, 10 s timeout, one connect guard, data watchdog | ✅ |
| **Pairing + PIN + user-set band name** | ✅ observed on hardware 3 Sep 2026 — [BAND_PIN_AND_NAME.md](BAND_PIN_AND_NAME.md) |
| Battery ADC | ◑ code written, **unstable and uncalibrated** |
| IMU / fall / impact | ✅ `HAS_IMU 1`, both machines live · ❌ thresholds uncalibrated, IMU power cost not measured |
| Motor driver, LiPo, power budget, enclosure | ❌ not built |
| Reconnect after the app is killed | ◐ written `59fc02d`, **not observed** |
| Spare band | ✗ **struck** — the ESP32 was retired; there is no spare |

**Test (L4):**

- [ ] Band reconnects on its own after the app is force-stopped and reopened.
- [ ] The link survives a rotation without leaking a second BLE manager.
- [ ] The direct-connect-by-id path hits before the scan fallback (visible in
      the dev log as `BAND direct connect failed:` only when it misses).
- [ ] DISCONNECT actually forgets the band and does **not** trigger the retry.
- [x] First link to an unknown band: Android asks for the passkey, the app then
      asks for the same six digits, and the band goes live. Both prompts appear
      exactly once per phone.
- [x] Renaming the band changes what Android's own Bluetooth list calls it, not
      just what the app prints.
- [ ] Pressing **Disconnect** forgets the PIN; walking out of range does not.
      Prove both, in that order, on the same phone.
- [ ] **The Phase 2 exit gate:** phone locked, screen off, app swiped from
      Recents, 20 minutes in a pocket, press the band, the family phone rings.

**Three traps that will cost you an hour each:**

1. **The band accepts one BLE connection at a time.** Close `nigehban_hub.py`,
   close nRF Connect, and kill the app's previous run. A connected band is not
   advertising, so nothing else can see it. If a scan finds nothing, reset the
   band first.
2. **On Android 12+, grant location *and* switch Location Services on**, or the
   scan returns zero results with no error and no callback. `BLUETOOTH_SCAN` is
   declared without `neverForLocation`, so the OS treats scanning as
   location-capable.
3. **A Metro reload restarts the JS without closing the native BLE
   connection**, leaving the band linked to a context that no longer exists —
   so it stops advertising and the next scan cannot find it.
4. **The first operation against the band always fails, and that is normal.**
   Android does not pair on connect — it pairs the first time something touches
   an attribute that demands it, fails *that* operation with
   `InsufficientAuthentication`, raises its dialog, and never goes back to what
   it was doing. The subscribe is that operation, so it is retried until the
   bond exists. Classify these on `attErrorCode` (5/8/12/15), never on
   `errorCode` — 403 is `CharacteristicNotifyChangeFailed`, not "unauthorized",
   and reading it as the latter files every pairing as a hardware fault.
5. **Upgrading a band from pre-lock firmware needs the bond cleared on the
   phone.** The old build required no pairing; a phone reconnecting with a bond
   the band never made fails encryption, and no app can clear an Android bond.

---

### 3.14 Shells, onboarding, diagnostics ✅

**Status:** working. One design system (Outfit + Space Grotesk, semantic tokens,
`ui.js` kit, 48 pt minimum targets, no emoji), two role shells, an OEM
onboarding flow that reads the vendor from `Platform.constants.Manufacturer` and
shows only that vendor's instructions.

**Test (L3):** a fresh install on an untouched Xiaomi must reach a working armed
state without anyone opening Settings by hand. Every deep link is wrapped, falls
back to the app-settings page, and leaves the manual steps on screen for when a
class name has moved.

**Also check:** empty, offline, loading and permission-denied states on every
screen — including the server-offline banner that says plainly that an alert
raised now would reach nobody.

---

## 4. Acceptance matrix — current standing

The 20 rows from [EXECUTION_PLAN §11](EXECUTION_PLAN.md), with today's honest
state. Q2 wants all of them re-run on **three phones including the worst OEM you
own**, on the **release** APK, against the **cloud**. None of that has happened.

| # | Test | State | Note |
|---|---|---|---|
| 1 | Register two accounts, invite, accept | ✅ | L0 + L2 |
| 2 | Invite left unaccepted moves no alerts | ✅ | L0 |
| 3 | Guess a code / hammer the endpoint → rate-limited | ✅ | L0 |
| 4 | SOS from app, both foreground, takeover < 2 s | ✅ | L2 |
| 5 | SOS from band, phone locked, family **rings** | ✅ | L3 |
| 6 | SOS with the family app **killed** → full-screen intent | ✅ | Observed 29 Aug |
| 7 | Stand down from the band → family alarm clears | ✅ | L2/L4 |
| 8 | Check-in, phone locked, band buzzes, ack in window | ✅ | L3 |
| 9 | Check-in ignored 90 s → **server** escalates | ✅ | L0 |
| 10 | App swiped away, 20 min in a pocket, SOS still works | ◐ | The **press** works — confirmed 1 Sep, and the wearer is now told (BUG-005/006/007). The **link** is not safe on an OEM that kills the process (BUG-015) |
| 11 | Phone rebooted → service back in < 60 s | ❌ | **No boot receiver (N2.3)** |
| 12 | Band out of range 5 min, then return → auto-reconnect | ❌ | **Observed failing 1 Sep — BUG-010.** Reconnects with the screen on; does not with the screen off |
| 13 | **Phone** battery to 20 % → `low_battery` | ◐ | Untested |
| 13b | **Band** battery to 20 % → `band_battery`, not a phone warning | ◐ | Untested; ADC may never trip it |
| 14 | **Phone** battery to 5 % → `going_dark` | ◐ | Untested |
| 15 | High Alert buzz at 5–10 min; miss → alert | ✅ | L2 |
| 16 | High Alert disarm without PIN → refused | ✅ | L1/L2 |
| 17 | Fall: drop the band from 1.5 m | ◐ | Code is live; the drop tests themselves are unrun. [Protocol](FALL_AND_ACCIDENT.md) |
| 18 | Fall: phone slides off a sofa → **no** alert | ◐ | Never measured against real CSV |
| 18b | Hard impact at 40 km/h → accident check-in → family told if unanswered | ◐ | Bench path testable via FAKE SPEED + FORCE CRASH; in-vehicle tests unrun |
| 19 | Kill the service from OEM settings → family amber in 3 min | ✅ | L2 |
| 20 | Good Samaritan on a severity-5 alert | ✅ | L0 |

**Tally: 11 pass · 5 unverified · 4 fail · (row 18 counted as unverified).**
Row 12 moved from unverified to fail on 1 Sep — it was written, then run.
That is the tally doing its job: a box only leaves ◐ by being tested, and it can
leave in either direction.

---

## 5. What is left, by track

### App (M1)
- [x] **Offline SOS queue** — dispatch locally *first*, persist unsent alerts,
      flush on reconnect, and render delivery state honestly: *"sent to 3"* vs
      *"not delivered yet, retrying"*. **Done and observed 1 Sep 2026**;
      [alertQueue.js](../nigehban-app/src/alertQueue.js).
- [ ] **Make the band link restore itself** — the highest-value item on this
      list now. BUG-010 (the retry timer does not fire with the screen off) and
      BUG-015 (nothing survives an OEM kill to retry at all). BUG-010 has to
      land first: BUG-015's fix needs a timer that actually fires.
- [ ] **Put a band id in the beacon** — BUG-012 and BUG-013. Any band's press is
      accepted by every Nigehban phone in range, and a stranger's press can
      discard your own band's SOS. **The beacon wake is switched off** because
      of these two ([BAND_WAKE_DISABLED.md](BAND_WAKE_DISABLED.md)), so this is
      no longer a fix to schedule — it is the precondition for turning the
      feature back on, and it needs new firmware on every band in the field.
- [ ] Surface `lastError` (BUG-003), and stop the `error:` path putting raw
      library strings on screen (BUG-004) — one change, since the second needs
      the first.
- [ ] Find out why `presentAlarm()` is not firing on the test device — the
      lock-screen takeover is meant to be the primary emergency signal and the
      notification fallback is currently doing its job. See the end of BUG-009.
- [ ] Port the band's nag timeout (~10 lines from
      [`nigehban_band_nrf52.ino:644-648`](../nigehban_band_nrf52/nigehban_band_nrf52.ino#L644-L648))
      into `virtualBand.js`, closing both a test gap and a real firmware/JS
      divergence. *(The plan cites line 577 for this; the code has moved — it
      is at 644 today.)*
- [ ] Fix the Setup screen's watch-notification row: compare **expected**
      against **actual** instead of reporting a correctly-idle phone as broken.
- [ ] A **local** notification when the band has been disconnected for a few
      minutes, cleared on reconnect — not a family page. A flat wristband is
      maintenance; paging five relatives for it teaches them to swipe alerts
      away.
- [ ] Changing the server address after sign-in (it is still only on Auth).

### Server (M3)
- [ ] **B3.5** Qwen severity scoring + Urdu dispatch text *(pre-agreed cut)*
- [ ] **B3.6** WhatsApp fan-out *(pre-agreed cut)*
- [ ] **B4.1** Rate limits on every write endpoint (today: auth and pairing only)
- [ ] **B4.2** Structured logging keyed by alert id
- [ ] **B4.3** Redis/Tair for WS fan-out — only if more than one worker ships
- [ ] Fix `watch_lost` false positives: data push + ~30 s wait before declaring
- [ ] Rename `watch_lost` and its copy — it is about the phone, not the band
- [ ] Group the push batch by project so one stale token cannot fail a family's
      whole send
- [ ] Directional links (*A may watch B, without B watching A*) — a schema
      change, cheapest before there is real data

### Android platform (M2)
- [ ] **N2.3** Boot receiver — service restarts and reconnects in < 60 s
- [ ] **N2.4** WorkManager watchdog (service alive? BLE connected? socket up?)
      — **watchdog only**; the 15-minute floor makes it useless as a timer
- [ ] **N1.4** Drop `usesCleartextTraffic` once the cloud has TLS
- [ ] Later: `FOREGROUND_SERVICE_CONNECTED_DEVICE` instead of the location
      service, which is the only reason `ACCESS_BACKGROUND_LOCATION` is needed
      at all; and `CompanionDeviceManager`, the real Android answer for a
      wristband

### Firmware (M4)
- [ ] **F2.3** Fix the battery ADC — longer acquisition time, or median-of-N
      with a gap between samples. A median rejects the alternating outlier; a
      mean does not. **Delete `BAND_LOW_STREAK` from `App.js` when this lands.**
- [ ] **F2.3** Calibrate `VBAT_DIVIDER_COMP` (`2.961F`, marked `// VERIFY`)
      against a multimeter
- [ ] **F3.1–F3.3** IMU at `0x6A`, fall state machine, **CSV logging to serial
      from day one** — this data cannot be collected retroactively
- [ ] **F4.1–F4.3** Motor driver (transistor + flyback + 100 µF bulk cap),
      LiPo via JST-PH, power budget. *If the band disconnects whenever it
      buzzes, the 100 µF cap is what is missing.*
- [x] Fix [`nigehban_hub.py`](../nigehban_hub.py) — it looked for the exact
      name `Nigehban-01` against a band called `Nigehban-02`. It now matches on
      the NUS service UUID, which is the identity and cannot be renamed; a name
      is only consulted when `config.json` names one because two bands are in
      range. It also pairs and sends `{"c":"auth"}`, since the band no longer
      answers a peer it has not checked

### Deployment (M3)
- [ ] **D0** Alibaba account verification — 5 minutes, then it waits hours
- [ ] **D1** Pipeline spike: throwaway ECS + Docker + Caddy + a stub returning
      `{"ok":true}` over HTTPS
- [ ] **D2** `Dockerfile`, `docker-compose.yml`, `Caddyfile` under `deploy/`;
      Caddy issuing and renewing Let's Encrypt itself
- [ ] **D3** Re-run the Phase 1/2/3 gates against the cloud, then kill ngrok

### QA (M4)
- [ ] **Q2.1** All 20 matrix rows, three phones, release APK, against the cloud
- [ ] **Q2.3** Fallback video — **non-negotiable**, stored on two laptops
- [ ] **Q3** Timed rehearsals + contingency drills (no venue Wi-Fi · dead band ·
      unreachable server · phone reboot)

---

## 6. Blockers, ranked

Ordered by *what stops you first*, not by size.

### 1. `.env` has no `DATABASE_URL` — the server will not start
**Severity: blocks everything.** The root `.env` on this checkout contains only
`NIGEHBAN_NGROK_DOMAIN`. The server is **Postgres-only** and raises
`DATABASE_URL not set in .env` on the first query.
**Fix:** §1.2 above. Five minutes.

### 2. The flagship test suite silently checks the wrong database
**Severity: high — it reports green while proving nothing.**
[`tests/test_consent_and_sweeper.py`](../tests/test_consent_and_sweeper.py) still
opens **SQLite** at `server/nigehban.db` for its B1 section. That file still
exists and still holds **93 users from the SQLite era** — so the checks connect,
find no plaintext tokens, and **PASS against a database the server has not used
in days.**

This is trap #5 from the branch notes happening to the test suite itself: *two
databases both answer.* Port those three queries to `psycopg` reading
`DATABASE_URL`, or delete the section. Until then, `test_samaritan_and_checkin.py`
and `test_sockets.py` are the only automated proof you can trust.

### 3. ~~An SOS needs the server, and unsent alerts are not queued~~ — FIXED
**Resolved 1 Sep 2026.** Local-first dispatch plus a persisted queue that
flushes on reconnect; see §3.3 above. A dead zone now delays an alert instead of
destroying it.

**Replaced by:** the band link does not restore itself (BUG-010, BUG-015). The
same class of failure — the product looks fine and quietly is not — has simply
moved from the alert path to the connection under it.

### 4. Push tokens minted under the old EAS `projectId`
**Severity: high — one stale token silences a whole family.** The EAS project
moved (`ac29701a…` → `c9294627-…`). Every token already in `devices` belongs to
the old project, and `send_expo_push_notifications` batches every target into
**one** POST; Expo rejects a mixed batch with `PUSH_TOO_MANY_EXPERIENCE_IDS` — a
400 that fails **the whole batch**.
**Fix:** `python scripts/db.py "select * from devices"`, purge the old rows,
have each phone re-register on the new build. `python scripts/push_doctor.py list`
fetches the delivery receipt the server never asks for.

### 5. The band's battery ADC is unstable, not merely uncalibrated
**Severity: medium.** Consecutive heartbeats alternate between `mv:4085`/93 %
and `mv:3699`/39 % on one board, on one continuous `seq`. The divider's source
impedance (~338 k) is far too high for the SAADC's default acquisition window,
and averaging 8 back-to-back reads does not help because every sample is equally
under-settled. `App.js` works around it with a 3-reading streak requirement.
**Blast radius was reduced, not removed:** since the battery split this only
drives a severity-1 notice, where it used to raise "phone about to die."

### 6. The fall thresholds have never met a real wrist
**Severity: medium.** `HAS_IMU` is now `1` and both detectors run, so rows 17
and 18 are reachable — but every threshold is still the value the literature
and the phone suggested, and **untuned thresholds are the fastest way to lose
trust: a bag falling off a chair must not page a mother at 2 a.m.**

The capture path exists now (`{"c":"imucal","on":1}` streams 100 Hz CSV to USB
serial) and [FALL_AND_ACCIDENT.md](FALL_AND_ACCIDENT.md) carries the drop
heights, the surfaces and — the half that matters more — the false-positive set
that must stay silent. Until that has been run, treat the numbers as guesses.

A second, quieter cost rides along: polling the IMU at 100 Hz draws 0.4–0.5 mA
against a 200–400 µA idle budget, so **the 1–2 week battery claim does not
survive this feature unchanged.** The fix is the part's own wake-on-motion
interrupt, which is deferred.

### 7. The band hardware does not exist
**Severity: medium.** No motor driver, no LiPo, no power budget. The band cannot
buzz, so every check-in and High Alert prompt on the real hardware is silent —
the wearer has to be looking at the phone, which defeats the wristband.

### 8. There is no spare band
**Severity: medium, and it is a demo risk, not a code one.** The ESP32 was
retired and its sketch deleted, so a dead or bricked XIAO now costs the live
hardware demo entirely. If a second XIAO is in budget it is the cheapest
insurance on the board — the firmware flashes onto it unchanged.

### 9. Nothing is deployed
**Severity: medium.** The server is a process on a laptop; phones reach it
through ngrok. No Dockerfile, no compose, no Caddyfile, no Alibaba account. The
ngrok URL changes every restart unless a reserved domain is set. **D0 (account
verification) takes five minutes and then waits hours** — file it before it is
on the critical path.

### 10. `watch_lost` fires when nothing is wrong
**Severity: medium — it teaches the family to ignore alerts.** It means *the
phone went silent while armed*, but it fires whenever Android backgrounds the
app, because the heartbeat is a JS `setInterval`. It is also badly named: it
reads as *the wristband died* and it is about the phone.

### 11. A healthy phone reads as broken on the Setup screen
**Severity: low, high confusion cost.** After the foreground-service change,
*"Watch notification: not running"* is the **correct** state for every family
watcher's phone — and it is rendered amber with a warning triangle. The
**START WATCH NOTIFICATION NOW** button also force-starts past the gate, and the
gate silently wins back on the next state change.

### 12. A rebooted phone never comes back
**Severity: medium.** No boot receiver (N2.3), no watchdog (N2.4). Matrix row 11
fails by construction.

### 13. Security items that are fine for a tunnelled dev box and not for a host
**Severity: must-fix before deployment. Three of the four are fixed as of
1 Sep 2026; one remains.**

**Still open — tokens never expire.** Hashing limits a stolen *database*; it
does nothing about a stolen *phone*, and the token sits in plain AsyncStorage.
This is B4.4 and it is the one item here with a hazard of its own: the app has
no 401 branch, so a session ending while the phone is backgrounded stops the
heartbeat silently and the sweeper pages the family for an emergency that is
not happening. Expiry must not ship before that branch does.

**Closed:**
- **CORS** is an allowlist read from `ALLOWED_ORIGINS`, empty by default.
  Nothing in the project is a browser, so this costs nothing today.
- **Cleartext** is off on production builds. `app.config.js` gates
  `usesCleartextTraffic` on the EAS build profile; dev and preview keep it, so
  LAN testing against a laptop still works.
- **Rate limits** now cover every write endpoint except two. `/alert` and
  `/heartbeat` are exempt on purpose and the reasoning is in the `RateLimit`
  docstring: a 429 on either one is indistinguishable from a dead phone, so a
  rate limit there would invent the emergency it is meant to protect.

### 14. `nigehban_hub.py` cannot find the band — FIXED
Matched the exact name `Nigehban-01` against a band called `Nigehban-02`, so the
laptop bridge failed for the same reason the app once did. It now filters on the
NUS service UUID instead, which is the right fix twice over: the name was never
the identity, and it is now user-settable, so any name match would go blind the
first time somebody renamed their band. `config.json` gained `band_pin`, and the
bridge pairs and authenticates like the app does.

### 15. iOS is not supported and is not planned
**Severity: scope, stated plainly.** iOS forbids background BLE scanning without
a service-UUID filter and has no foreground-service equivalent.

---

## 7. Traps — read these before you trust a green result

Every one of these has already cost this project real time.

1. **A build can be green and ship nothing.** An unanchored `android/` in the
   root `.gitignore` kept a whole hand-written Kotlin module out of git, so
   every EAS build compiled without it. Autolinking skips absent modules,
   Gradle compiled nothing, and `requireOptionalNativeModule` returned null —
   all three by design, none of them complaining. `plugins/withNativeModuleGuard.js`
   now fails the build instead. **Verify a native change by inspecting the dex,
   not by the build going green.**
2. **`??` stops at the first non-null value.** A payload-shape chain always
   matched `payload.data`, which is always present and had no alert id — so
   every push to a closed app found nothing and went back to sleep, while every
   diagnostic read green.
3. **A JS fallback looks exactly like a working feature** until the process is
   dead, which is the only case that matters.
4. **The heartbeat is not telemetry — its absence is the alert.** Anything that
   stops the process while armed pages the family.
5. **Two databases both answer.** Always check which one you are on. This has
   already caught the test suite (Blocker #2).
6. **Verifying a transport is not verifying a message.** nRF Connect proved
   bytes moved across the characteristic. It could not prove a *line* arrived —
   and a line is the unit the protocol is made of. 23 of every 86 bytes were
   being dropped and it looked like a pass.
7. **Never hand-edit `android/`.** It is gitignored generated output, silently
   deleted by the next `expo prebuild --clean` or any EAS build from a clean
   checkout. Native changes live in the config plugin or a local Expo module —
   nowhere else.
8. **Migration before server before app.** Backwards, every `/heartbeat` fails
   on a missing column and the sweeper pages every armed user's entire family.

The pattern is the same every time: **the failure was invisible from the UI, and
something downstream had a good reason not to complain.** When you add something
here, make its silence loud in the place it happens.

---

## 8. Where the detail lives

| Document | What it is for |
|---|---|
| [README.md](../README.md) | What the product is, and how to run it |
| [EXECUTION_PLAN.md](EXECUTION_PLAN.md) | Phases, frozen protocol, schema, circuit, the v2 designs |
| [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) | The same work sliced by workstream; §14 is the silent-failure pass |
| [BACKGROUND_SERVICE_AND_OTHER_FEATURES.md](BACKGROUND_SERVICE_AND_OTHER_FEATURES.md) | The foreground service, the battery split, the database setup |
| [BRANCH_NOTES_ble-close-app-bug.md](BRANCH_NOTES_ble-close-app-bug.md) | The BLE link, the native alarm, the killed-app push path |
| [TESTING_WITHOUT_HARDWARE.md](TESTING_WITHOUT_HARDWARE.md) | The virtual band, the browser loop, the two-phone test |
| [NIGEHBAN_BUILD_GUIDE.md](NIGEHBAN_BUILD_GUIDE.md) | Building the band |
| [firmware/README.md](../firmware/README.md) | Bench sketches `t1`–`t6`, and the `VBAT_ENABLE` hardware warning |
