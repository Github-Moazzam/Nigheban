# Nigehban — Phased Execution Plan

Bano Qabil × Alibaba Cloud Hackathon · 4 people · 5 days · Thu 20 → Mon 24 Aug 2026.

This file is the engineering companion: contracts, schema, skeletons, commands,
the dependency map and the acceptance matrix. The visual board lives in the
shareable sprint page.

> The original plan is in git history at commit `42488af`. It described an ESP32
> prototype and is superseded, not deleted.

---

## 0. Scope decision

Nine features in five days with four people is roughly 160 person-hours of new
work against about 140 available. Two features are deliberately moved out of the
sprint and into a **fully designed v2 roadmap** (§13):

| Moved to v2 | Why it is the right cut |
|---|---|
| **Offline / no-phone operation** (BLE mesh SOS) | Needs beacon firmware, background relay scanning, and a crypto scheme on the server. Highest wow, highest risk, and it is the feature most likely to fail live on a venue's crowded 2.4 GHz band. |
| **Anti-snatching / theft lockdown** | Needs a Kotlin CameraX module capturing with no preview surface on a locked device — the single highest-variance task on the board — plus device-admin, OSS upload and WhatsApp fan-out. |

Cutting these is not a retreat. It converts a sprint that would have shipped nine
half-features into one that ships seven complete ones, and it turns §13 into a
pitch asset: a roadmap designed to the wire-protocol level is stronger evidence
of engineering judgement than a broken live demo.

**In the 5 days:** identity & pairing · remote check-in · instant SOS ·
low-battery failsafe · High Alert mode · accident & fall detection · Good
Samaritan · Alibaba Cloud deployment · Android background survival.

---

## 1. Corrections to the previous plan

| Old claim | What the plan has to account for |
|---|---|
| "Band firmware — working, unchanged" | Accurate for what it is. The ESP32 sketch is a **deliberate stand-in for early testing** — it says so in its own header, and it speaks the frozen protocol so the app never changes when the hardware does. That was the right call. The planning point is only that *porting* it to the XIAO is **a full day of work the old plan did not budget**. The board is in hand, so it starts Day 1. |
| "Fall detection: `fall` event exists" | `HAS_IMU 0` — compiled out, never run. The code path targets an external **MPU6050 you do not need**: the XIAO Sense has an LSM6DS3TR-C on board. Delete that path rather than porting it. |
| — | The ESP32 band is **already your spare**. A second working band on demo day normally costs a day of building; you have one for free, so keep it flashed with the final gesture map and charged. |
| "Guardian logic — working in Python" | True, and **stranded**. `nigehban_hub.py` is not wired into the app or the server. |
| — | `POST /family` links two accounts **without the other person's consent**. Safety bug in a product for people avoiding stalkers. Fix in Phase 0. |

---

## 2. Roles, and why they can run in parallel

| | Track | Owns |
|---|---|---|
| **M1** | App | React Native screens, client state machine, phone sensors, alert UX |
| **M2** | Android platform | Config plugins, foreground service, push, OEM survival — **JavaScript**, see §7.0 |
| **M3** | Cloud | FastAPI, database, ECS deployment, escalation sweeper, geo, Qwen |
| **M4** | Firmware | nRF52840 port, IMU, soldering, power → **integration QA from Phase 5** |

### 2.1 The two contracts, frozen at hour zero

Nothing below works unless these are agreed and written down **before anyone
opens an editor**. They are what convert four people from a queue into four
parallel tracks.

1. **The BLE contract** — newline-delimited JSON over Nordic UART (§5). Frozen
   across the ESP32 → nRF52840 port, so M4 can rewrite the radio layer without
   M1 noticing.
2. **The API contract** — endpoint paths and payload shapes (§6.2). M1 codes
   against them before M3 has implemented them.

### 2.2 The three stand-ins that remove the waiting

Already in the repo, and the reason Phase 0 has zero handoffs:

| Stand-in | Removes the dependency | Where |
|---|---|---|
| Simulated band | M1 needs no hardware to build every screen | `src/band.js` — `simulate()` |
| **nRF Connect** (generic BLE app) | M4 verifies firmware without the Nigehban app | phone app store |
| curl / the existing test | M3 builds and verifies the server without phones | `server/` |

Rule for the week: **if you are waiting for someone, you are using the wrong
stand-in.**

---

## 3. Dependency map

### 3.1 Fully parallel — start immediately, blocked by nobody

| M1 · App | M2 · Native | M3 · Server | M4 · Firmware |
|---|---|---|---|
| Replace the LAN subnet sweep with a configurable base URL (https/wss) | Write the config plugin: permissions + foreground-service types | Run the server locally + `ngrok http 8000` — a public HTTPS URL in two minutes | Install the **Seeed nRF52 Boards** core (Adafruit Bluefruit, *not* mbed) |
| Build the client state machine: `idle · checkin_pending · high_alert · sos_live` | Queue the first EAS dev build | Publish the API contract (§6.2) so M1 and M2 can code against it today | Blink, then advertise as `Nigehban-01`, verify in nRF Connect |
| Build check-in countdown, High Alert panel, watch-status tile against **mocked** responses | Foreground-service spike with a dummy task | Schema additions + new endpoints + the sweeper, verified with curl | Port `Button`, `Pattern`, `onGesture`, `handleCommand` verbatim onto `bleuart` |
| Device registration payload | Add `@notifee/react-native`; FCM project, alarm channel, full-screen intent (test with curl) | **Fix pairing consent** + rate-limit code lookups | Solder the motor driver: transistor + flyback diode + 100 µF bulk cap |
| Wire `expo-battery` thresholds | OEM onboarding screen with per-vendor deep links | **File Alibaba account verification** — 5 minutes of forms, then it just waits (§4, Phase 4) | Real battery ADC on `P0.31`, enable via `P0.14`, calibrate against a multimeter |
| | | | IMU bring-up at `0x6A`, fall state machine, CSV logging to serial |

That is roughly a full day each with **no handoffs at all**.

> **Why the account paperwork is in Phase 0 but the deployment is not.** Identity
> checks and credit approval can take hours to a day and no engineering
> compresses that. Filing it costs five minutes now and removes the only
> external-latency risk from Phase 4. Everything else about the cloud waits until
> there is a working system to lift.

### 3.2 The joins — work that must wait

| # | Join | Needs | Unblocked when | Mitigation |
|---|---|---|---|---|
| **J1** | Real band ↔ real app | M4's firmware **and** M2's dev build (BLE is a native module — Expo Go can never load it) | Phase 1 | M1 uses the simulated band until then; M2 queues the build in hour one |
| **J2** | App ↔ server | M3's ngrok HTTPS URL | Phase 1 | ngrok removes the same-Wi-Fi requirement on day one, without any cloud |
| **J3** | Foreground service ↔ server | M3's `/heartbeat` + push fan-out | Phase 2 | Payloads agreed in §6.2 on Day 1, so M2 codes against them first |
| **J4** | Safety features ↔ sweeper | M3's server-side deadlines | Phase 3 | M1 mocks the WebSocket messages |
| **J5** | Everything ↔ cloud | A feature-complete, working system | Phase 4 | Deployment is a lift-and-shift of something already proven, not a debugging session |
| **J6** | QA ↔ everything | A release APK against the cloud | Phase 5 | — |

### 3.3 Critical path

```
M4 firmware port ──────────▶ J1 ──┐
                                  ├──▶ Phase 2 ──▶ Phase 3 ──▶ freeze
M2 foreground service ─────▶ J3 ──┘

M1 and M3 carry slack.
```

**The two longest poles are the firmware port (M4) and background survival (M2).**
If M1 or M3 finishes early they help M2 or M4 — not each other. Write this on a
wall; it is the single most common way a four-person hackathon team loses a day.

---

## 4. The phases

**Build local, prove it works, then deploy.** Phases 0–3 run entirely on the
laptop with ngrok providing the public HTTPS URL. Alibaba Cloud is Phase 4, and
it is a lift-and-shift of a system that already works — not a place to debug
features and infrastructure at the same time. That ordering is the difference
between a three-hour deployment and a two-day one.

```
PHASE 0        PHASE 1      PHASE 2      PHASE 3      PHASE 4     PHASE 5    PHASE 6
parallel  ──▶  converge ──▶ survive ──▶  features ──▶ deploy ──▶  harden ──▶ present
 Day 1         D1 pm/D2 am    Day 2        Day 3      D3 pm/D4 am  Day 4 pm    Day 5
   │             │              │            │            │
   └─ local ─────┴──── ngrok ───┴────────────┘            └─ Alibaba ECS ──▶
```

### Phase 0 · Independent Launch — Day 1, 08:00 → 18:00
Four tracks, zero handoffs. Everything in §3.1. Server runs on the laptop;
`ngrok http 8000` gives it a public HTTPS address in two minutes.
**Exit:** each track demonstrable on its own — band blinks and advertises, server
answers over HTTPS through the tunnel, app runs against a mock, dev build
installed.

### Phase 1 · First Join — Day 1 evening → Day 2 morning
The halves meet: J1 and J2 close.
**Exit gate:** a button press on a **XIAO nRF52840** raises an SOS that appears on
a second phone **over the internet** — both phones on mobile data, not on your
Wi-Fi. The laptop is still in the loop; that is expected at this phase.

### Phase 2 · Survive the Pocket — Day 2
The hardest engineering day. Foreground service, BLE reconnect, boot receiver,
full-screen alarm, OEM onboarding (M2); timers moved off the phone into the
server sweeper, `/heartbeat` and its watchdog (M3); check-in round-trip and the
low-battery failsafe (M1); IMU fall state machine and final gesture map (M4).
**Evening, 30 minutes, M3:** a throwaway deploy spike — ECS + Docker + Caddy +
a stub FastAPI returning `{"ok":true}` over HTTPS. Prove the *pipeline* now, so
Phase 4 is only moving the real app onto something already known to work.
**Exit gate:** phone locked, screen off, **app swiped from Recents**, 20 minutes in
a pocket → press the band → the family phone rings with a full-screen alarm.
Then kill the app on the family phone and repeat.

### Phase 3 · Feature Complete — Day 3
Everything still local through ngrok. Remote check-in, High Alert (server
scheduled, randomised 5–10 min), low battery + going-dark, accident fusion,
Good Samaritan, Qwen Urdu dispatch, WhatsApp fan-out.
**Exit gate:** every in-scope feature runs end-to-end on two phones. This is the
moment the product is *done* — everything after it is deployment and polish.

### Phase 4 · Deployment — Day 3 evening → Day 4 midday
M3 leads; nobody else changes behaviour while it happens.

1. Lift and shift the working FastAPI onto ECS behind Caddy, **unchanged**.
2. Point the app's base URL at the real hostname — a one-line change, because
   M1 made it configurable in Phase 0. Keep ngrok alive in parallel until the
   cloud passes the same tests.
3. Migrate the database only after the app is green on the cloud.
4. Kill ngrok. Re-run the Phase 1, 2 and 3 exit gates against the cloud.

**Exit gate:** every feature works with the laptop physically shut, and the word
"ngrok" appears nowhere in the demo.

### Phase 5 · Harden, Freeze & QA — Day 4 afternoon
**Feature freeze 14:00, no exceptions.** M4 runs the acceptance matrix (§11) on
three phones including the worst OEM you own. Fall thresholds calibrated against
the logged CSV. Fallback video recorded — non-negotiable. ECS disk snapshotted,
credentials written down in one place the whole team can reach.
**Exit gate:** 20/20 on the release APK against the cloud; video on two laptops.

### Phase 6 · Rehearse & Present — Day 5
No code except a crash fix, and two people must agree. Three timed dress
rehearsals with real hardware, standing up. Ten slides. Contingency drills: no
venue Wi-Fi, dead band, unreachable server, phone reboot.
**Exit gate:** the full demo run three consecutive times with no unrecovered
failure, inside the time limit, on the network you will actually use.

### Phase 7 · Post-hackathon — §13
Mesh SOS and anti-theft lockdown, designed and ready to build.

---

## 5. Protocol — frozen, do not change

### Band → phone (newline JSON over NUS TX `6E400003-…`)

```json
{"t":"evt","e":"sos","seq":12,"ms":48210,"bat":87,"src":"double_tap"}
```

| `e` | Gesture | Server alert kind | Sev |
|---|---|---|---|
| `sos` | double-tap | `sos` | 5 |
| `checkin_ack` | single press | `checkin_ack`, or stands down a live SOS | 1 |
| `high_alert_on` / `high_alert_off` | hold 3 s | arms/disarms High Alert | — |
| `fall` | IMU state machine | `fall` | 4 |
| `hb` | every 10 s | heartbeat only, never an alert | — |

*Reserved for v2, emit but ignore server-side for now:* `armed` / `disarmed`
and `beacon_mode`. **No gesture is bound to either.** Anti-snatch is deferred,
and the 4-tap binding this section originally reserved for `armed` cannot be
used: 2+ taps is SOS, so a 4-tap `armed` would let an over-tapped SOS arm
anti-snatch instead of calling for help. v2 needs a different affordance.

### Phone → band (NUS RX `6E400002-…`)

```json
{"t":"cmd","c":"checkin_req","window":90}
{"t":"cmd","c":"buzz","n":2}
{"t":"cmd","c":"alarm"}
{"t":"cmd","c":"ack"}
```

The existing `handleCommand()` already implements all four — keep it verbatim.

---

## 6. Server

### 6.1 Schema additions

```sql
-- consent on pairing (fixes the safety bug)
CREATE TABLE invites (
    id         INTEGER PRIMARY KEY,
    from_id    TEXT NOT NULL,
    to_id      TEXT NOT NULL,
    relation   TEXT DEFAULT '',
    state      TEXT NOT NULL DEFAULT 'pending',   -- pending|accepted|declined
    created_at REAL NOT NULL,
    UNIQUE (from_id, to_id)
);

CREATE TABLE devices (
    id         TEXT PRIMARY KEY,        -- install id
    user_id    TEXT NOT NULL,
    push_token TEXT,
    platform   TEXT, os_version TEXT, app_version TEXT,
    last_seen  REAL
);

CREATE TABLE checkins (
    id         INTEGER PRIMARY KEY,
    user_id    TEXT NOT NULL,           -- who must answer
    asked_by   TEXT,                    -- NULL = system (high alert / fall)
    reason     TEXT,                    -- manual|high_alert|fall|low_battery
    due_at     REAL NOT NULL,
    acked_at   REAL,
    escalated  INTEGER DEFAULT 0
);

CREATE TABLE watch_state (
    user_id      TEXT PRIMARY KEY,
    mode         TEXT DEFAULT 'idle',   -- idle|high_alert|sos
    next_buzz_at REAL,
    last_beat    REAL,
    band_link    INTEGER DEFAULT 0,
    phone_batt   INTEGER
);

CREATE TABLE presence (                 -- Good Samaritan
    user_id    TEXT PRIMARY KEY,
    geohash6   TEXT NOT NULL,
    lat REAL, lon REAL,                 -- rounded to ~100 m
    updated_at REAL NOT NULL
);
CREATE INDEX idx_presence_geo ON presence(geohash6, updated_at);
```

### 6.2 New endpoints — ☑ built 22 Aug 2026 except the last two

| Method | Path | Purpose | |
|---|---|---|---|
| `POST` | `/device` | register install id + push token | ☑ |
| `POST` | `/heartbeat` | `{mode, band_link, phone_batt, lat, lon}` every 60 s while armed | ☑ |
| `POST` | `/pair` | issue a one-time, ten-minute pairing code | ☑ new |
| `POST` | `/invite` | redeem a pairing code, or ask by user code | ☑ |
| `GET` | `/invites` | what is waiting on me, and what I am waiting on | ☑ new |
| `POST` | `/invite/{id}/accept` | creates the mutual link | ☑ |
| `POST` | `/invite/{id}/decline` | permanent, and silent | ☑ new |
| `POST` | `/checkin/{member_id}` | creates a `checkins` row with `due_at` | ☑ |
| `POST` | `/checkin/{id}/ack` | band or app answers | ☑ |
| `POST` | `/watch/high_alert` | arm/disarm; server owns `next_buzz_at` | ☑ |
| `GET` | `/watch/{member_id}` | family-facing health: band link, service, last beat | ☑ |
| `POST` | `/presence` | coarse location for Good Samaritan | ☐ |
| `POST` | `/samaritan/{alert_id}/respond` | "I'm going" — releases a coarse pin, logs the responder | ☐ |

`POST /family` is **gone** — it returns 410 rather than failing open for an old
build. Two paths replace it and both need two people to act; the reasoning is in
§13 of [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md).

### 6.3 The sweeper — the piece that makes it work with the app killed

☑ **Built 22 Aug 2026** as `sweeper()` / `sweep_once()` in
`server/nigehban_server.py`. The sketch below is what was implemented, plus a
latch column on each branch (`escalated`, `lost_notified`) so a condition that
stays true pages the family once rather than every five seconds.

One asyncio task, 5-second tick, ported from `Guardian` in `nigehban_hub.py`:

```python
async def sweeper():
    while True:
        now = time.time()
        # 1. missed check-ins -> escalate to family
        for c in due_checkins(now):
            escalate(c.user_id, "checkin_missed", sev=3)
        # 2. high alert: time to buzz again?
        for w in high_alert_users(now):
            push_to(w.user_id, {"t": "buzz_now"})
            create_checkin(w.user_id, reason="high_alert", window=60)
            w.next_buzz_at = now + random.uniform(300, 600)   # randomised
        # 3. heartbeat watchdog: phone gone silent while armed
        for w in armed_users_silent_for(now, 3 * 60):
            escalate(w.user_id, "watch_lost", sev=3)
        await asyncio.sleep(5)
```

**Design rule: the phone is an actuator, never a timekeeper.** Every deadline
lives here. This is what makes check-in, High Alert and the low-battery failsafe
survive the app being killed — and it is the honest answer to "what if her phone
is dead?" while the mesh is still in v2.

---

## 7. Android platform work

### 7.0 The stack, and who writes what

Everything the team writes is **JavaScript**. Nobody writes Kotlin in the 5-day
scope.

```
your code        App.js, src/*.js         React 19.2 + React Native 0.86
     ↓
Expo SDK 57      expo-location · expo-notifications · expo-clipboard
                 expo-network · expo-battery (to add)
     ↓
native module    react-native-ble-plx     ← why Expo Go cannot run the real band
     ↓
generated shell  android/                 ← 110 lines of Kotlin nobody wrote
     ↓
EAS Build        → APK
```

`MainActivity.kt` and `MainApplication.kt` were generated by `expo prebuild`
from `app.json`. They are boilerplate; nobody has edited them and nobody needs
to.

**Three run modes, all already configured in this repo:**

| Mode | What it is | Consequence |
|---|---|---|
| Expo Go | Expo's sandbox app | Cannot load `react-native-ble-plx` — which is exactly why `band.js` falls back to `simulate()` |
| Dev build | Your own Expo Go with your native modules compiled in | `expo-dev-client` + the `development` profile in `eas.json` |
| Prebuild | `expo prebuild` generates `android/` from `app.json` | The source of the Kotlin above |

**What actually needs native code:**

| Task | How | Language |
|---|---|---|
| Manifest permissions, `foregroundServiceType` | Expo config plugin (§7.1) | **JS** |
| Foreground service keeping BLE alive | `expo-location` + `expo-task-manager` | **JS** |
| BLE connect / reconnect | `react-native-ble-plx` | **JS** |
| Receiving high-priority push | `expo-notifications` | **JS** |
| Alarm-importance channel, DND bypass | `expo-notifications` | **JS** |
| Opening OEM autostart screens | `expo-intent-launcher` | **JS** |
| Full-screen intent over the lock screen | ~~`@notifee/react-native`~~ `modules/nigehban-alarm/` | **thin native, ours** |
| Restart the service after reboot | ~~Notifee, or~~ a small receiver | thin native |
| Verify `isIgnoringBatteryOptimizations()` | small native call | thin native |

~~**Add `@notifee/react-native` in Phase 0.**~~ **Superseded 26 Aug 2026.**
Invertase archived Notifee on 7 Apr 2026 and it never supported the New
Architecture, which Expo 57 / RN 0.86 requires — so the plan's one "via
library" row had no library behind it. Full-screen intents and the looping
siren are now ~200 lines of Kotlin in
[`nigehban-app/modules/nigehban-alarm/`](nigehban-app/modules/nigehban-alarm/),
a local Expo module that autolinks out of `modules/` with no config entry.

This does move M2's bar: the role now needs someone who can *read* Kotlin, not
only someone comfortable with Android concepts. It is a small, bounded file and
the trade was deliberate — the alternative was putting the emergency siren
behind a five-month-old community fork with a single maintainer.

> A local module under `modules/` is **not** subject to the `/android` trap
> below. It is source, it is committed, and `expo prebuild --clean` picks it up
> through autolinking rather than wiping it.

> **The trap that costs a day.** `/android` is gitignored (line 41 of
> `nigehban-app/.gitignore`) because it is generated output. Hand-edit
> `MainApplication.kt` or drop a Kotlin file into `android/`, and the next
> `expo prebuild --clean` — or any EAS build from a clean checkout — **silently
> deletes it**. Native changes must live in a committed place: a **config
> plugin** (`plugins/withNigehbanAndroid.js`) for manifest and gradle edits, or a
> **local Expo module** (`npx create-expo-module --local` → `modules/`) for real
> native code.

### 7.1 The config plugin

`nigehban-app/plugins/withNigehbanAndroid.js`, referenced from `app.json`:

```js
const { withAndroidManifest, AndroidConfig } = require('expo/config-plugins');

const PERMS = [
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE',
  'android.permission.FOREGROUND_SERVICE_LOCATION',
  'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
  'android.permission.RECEIVE_BOOT_COMPLETED',
  'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
  'android.permission.USE_FULL_SCREEN_INTENT',
  'android.permission.SCHEDULE_EXACT_ALARM',
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.WAKE_LOCK',
];

module.exports = (config) => withAndroidManifest(config, (cfg) => {
  const m = cfg.modResults;
  AndroidConfig.Permissions.ensurePermissions(m, PERMS);

  // expo-location declares its own service; widen its type so the same
  // service legally covers the BLE link too.
  const app = AndroidConfig.Manifest.getMainApplicationOrThrow(m);
  for (const s of app.service ?? []) {
    if ((s.$['android:name'] || '').includes('expo.modules.location')) {
      s.$['android:foregroundServiceType'] = 'location|connectedDevice|dataSync';
    }
  }
  return cfg;
});
```

Add `"./plugins/withNigehbanAndroid"` to `plugins` in `app.json`, and drop
`usesCleartextTraffic` once the cloud has TLS.

**The foreground service, the Expo-native way** — this keeps the JS runtime
alive, which is what keeps `react-native-ble-plx` and the WebSocket alive:

```js
await Location.startLocationUpdatesAsync(WATCH_TASK, {
  accuracy: Location.Accuracy.Balanced,
  timeInterval: 60_000,
  distanceInterval: 50,
  pausesUpdatesAutomatically: false,
  foregroundService: {
    notificationTitle: 'Nigehban is watching',
    notificationBody: 'Band connected · tap to open',
    notificationColor: '#63BE93',
    killServiceOnDestroy: false,
  },
});
```

**Timers:** WorkManager (15-min floor) is a *watchdog only* — is the service
alive, is BLE connected, is the socket up. `AlarmManager.setExactAndAllowWhileIdle`
is the only client-side timer that fires in Doze. The real failsafe is the server
sweeper in §6.3.

**OEM autostart deep links** — wrap every one in try/catch; class names differ by
vendor version, so fall back to `ACTION_APPLICATION_DETAILS_SETTINGS`:

```
Xiaomi   com.miui.securitycenter/com.miui.permcenter.autostart.AutoStartManagementActivity
Huawei   com.huawei.systemmanager/.startupmgr.ui.StartupNormalAppListActivity
Oppo     com.coloros.safecenter/.permission.startup.StartupAppListActivity
Vivo     com.vivo.permissionmanager/.activity.BgStartUpManagerActivity
Samsung  com.samsung.android.lool/com.samsung.android.sm.ui.battery.BatteryActivity
```

---

## 8. Firmware — nRF52840 skeleton

Board: **Seeed nRF52 Boards** (Adafruit Bluefruit core), *not* the mbed variant.
Bluefruit ships `BLEUart` — literally the Nordic UART Service the app already
speaks — and `addManufacturerData()`, which v2's beacon will need.

```cpp
#include <bluefruit.h>
#include "LSM6DS3.h"

#define PIN_BTN     D2      // INPUT_PULLUP, other leg to GND
#define PIN_MOTOR   D1      // -> 1k -> NPN base (never direct)

BLEUart bleuart;
LSM6DS3 imu(I2C_MODE, 0x6A);          // on-board on the Sense

void setup() {
  pinMode(PIN_BTN, INPUT_PULLUP);
  pinMode(PIN_MOTOR, OUTPUT); digitalWrite(PIN_MOTOR, LOW);

  // real battery: enable divider on P0.14, read P0.31 — calibrate vs multimeter
  pinMode(PIN_VBAT_ENABLE, OUTPUT); digitalWrite(PIN_VBAT_ENABLE, LOW);
  analogReadResolution(12);

  Bluefruit.begin();
  Bluefruit.setName("Nigehban-01");
  Bluefruit.setTxPower(4);
  bleuart.begin();

  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addService(bleuart);
  Bluefruit.Advertising.addName();
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(32, 244);
  Bluefruit.Advertising.start(0);

  imu.begin();
}

void send(const String &json) {                 // replaces gTx->notify()
  Serial.println(json);
  if (Bluefruit.connected()) {
    String l = json + "\n";
    bleuart.write(l.c_str(), l.length());
  }
}

void loop() {
  buttonTick(&gBtn);      // KEEP from the ESP32 sketch, unchanged
  feedbackTick();         // KEEP — non-blocking pattern player
  imuTick();              // NEW — fall state machine
  while (bleuart.available()) { /* accumulate to '\n' -> handleCommand() */ }
}
```

### Fall thresholds — starting points, calibrate in Phase 5

```
free-fall   |a| < 0.4 g    for >= 100 ms
impact      |a| > 2.5 g    within 800 ms of free-fall
stillness   sigma(|a|) < 0.15 g for 1.5 s
+ orientation change > 60 deg
```

Log every candidate to serial as CSV from Phase 2 onward. You cannot collect this
data retroactively, and untuned thresholds are the fastest way to lose a judge's
trust: a bag falling off a chair must not page a mother at 2 a.m.

### Phone-side fusion (M1)

```
10 s speed ring buffer from GPS
candidate: >= 8 m/s (~29 km/h) dropping below 1.5 m/s inside 2 s
           or phone accelerometer > 4 g

one signal alone  -> severity 4 -> 30 s countdown check-in
both within 5 s   -> severity 5 -> 15 s countdown
unacknowledged    -> automatic SOS with location
acknowledged      -> logged as a near-miss
```

---

## 9. Circuit

```
BUTTON      D2 ──┬── [tactile SW] ── GND
                 └── 100 nF ── GND        (optional; firmware debounces 35 ms)

MOTOR       3V3 ─┬─────────┬──────────┐
                 │         │          │
              [MOTOR]  [1N4148]   [100 uF]     <- bulk cap, close to motor
                 │     cathode^        │
                 ├─────────┘           │
              collector               GND
            D1 ─[1k]─ base   (2N2222 / S8050)
              emitter ── GND

            MOSFET alternative (better): D1 ─[100R]─ gate (2N7002 / AO3400),
            gate ─[100k]─ GND, drain ── motor(−), source ── GND

BATTERY     3.7 V LiPo 250–400 mAh → B+ / B− via JST-PH.
            Meter polarity first. Use a connector, not solder.
```

**Never drive the motor from a GPIO pin** — a coin ERM pulls 60–100 mA at start,
a pin supplies a few. The flyback diode stops the inductive kick resetting the
MCU; the 100 µF cap stops the motor's inrush browning out the radio mid-notify.
*If the band disconnects whenever it buzzes, that cap is what's missing.*

Board facts: IMU `0x6A` (power gate `P1.08`, INT `P0.11`) · charger BQ25101,
`P0.13` LOW = 100 mA · charge status `P0.17` · battery divider enable `P0.14`,
read `P0.31` · 3.3 V logic, ~2 mA standard drive per pin.

Power: advertise at 100 ms, longer connection interval when idle · IMU 26 Hz
still / 104 Hz for 3 s after motion · LED off in normal operation · never
`delay()` in `loop()`.

---

## 10. Runbook

### 10.1 Phases 0–3 — local, with ngrok as the transport

```bash
cd server && python nigehban_server.py     # laptop, port 8000
ngrok http 8000                            # public HTTPS URL in two minutes
```

This is the whole development environment for three days. What it buys you:

- **No same-Wi-Fi requirement.** Both phones can be on mobile data from Day 1,
  which is also how you will demo, so you test the real network shape early.
- **HTTPS and WSS for free**, so the app is written against the transport it will
  ship with — no cleartext-to-TLS surprise on Day 4.
- **Zero cloud dependency** while the features are still moving.

What to know before you lean on it:

- The free URL changes on every restart. This is exactly why M1's first Phase 0
  task is a configurable base URL, and why the swap in Phase 4 is one line.
- WebSocket upgrade works fine over the tunnel. Send
  `ngrok-skip-browser-warning: true` anyway.
- The tunnel dies when the laptop lid closes, and so does your demo.
- **Judges will notice a tunnel to a laptop.** ngrok is the development
  transport, never the presented architecture — it must be gone by the end of
  Phase 4.

### 10.2 Phase 4 target — Alibaba Cloud

```
ECS: 2 vCPU / 4 GB, Ubuntu 22.04
Region: ap-southeast-1 (Singapore) or me-central-1 (Dubai) — nearest to Pakistan
Security group inbound: 22 (your IP only), 80, 443.  Never expose 8000.
docker compose: caddy + api + redis;  RDS external
```

```
nigehban.example.com {
    reverse_proxy api:8000
}
```

Caddy issues and renews Let's Encrypt certificates itself — that is what lets you
delete `usesCleartextTraffic: true` from the manifest, and it answers the
security question judges ask.

**Deployment order — one change at a time, verify between each:**

| # | Step | Verify before continuing |
|---|---|---|
| 1 | ECS + security group + Docker + Caddy | `curl https://host/health` from outside |
| 2 | The FastAPI app, **unchanged**, same SQLite file | Phase 1 gate passes against the cloud |
| 3 | App base URL repointed; ngrok still running in parallel | Phases 2 and 3 gates pass against the cloud |
| 4 | Database migrated to RDS Postgres | Full acceptance matrix |
| 5 | Redis, Model Studio, CloudMonitor | Each as its feature needs it |
| 6 | Kill ngrok | Nothing references the tunnel |

**Hard cut lines:**

- **Postgres/RDS** — if step 4 is not clean by Day 4 midday, keep SQLite on the
  ECS with a snapshot to OSS. A working demo on SQLite beats a broken one on RDS,
  and no judge deducts for it.
- **The whole cloud** — if account verification or ECS collapses entirely, you
  demo on ngrok and say so plainly. It costs you the Alibaba points but not the
  product. This is precisely why the account paperwork is filed on Day 1 and the
  pipeline is spiked on Day 2 evening: so this fallback never gets used.

Services and the one-line reason for each — put this on a slide:

| Service | Doing what |
|---|---|
| ECS | The API and the escalation sweeper — the piece that must not be a laptop |
| ApsaraDB RDS | Accounts, family links, alert history, devices, presence |
| Redis / Tair | WebSocket fan-out across workers, rate limits |
| Model Studio (Qwen) | Scores severity and writes the Urdu dispatch message |
| CloudMonitor | The dashboard you put on a slide |

### 10.3 Same-Wi-Fi fallback, for when the tunnel is down

```bash
cd server && python nigehban_server.py     # prints the LAN address
cd nigehban-app && npx expo start --dev-client
```

Windows firewall, once, as Administrator:

```powershell
New-NetFirewallRule -DisplayName "Nigehban dev servers" -Direction Inbound `
  -Action Allow -Protocol TCP -LocalPort 8000,8081 -Profile Any
```

Diagnostic before blaming the app: open `http://<laptop-ip>:8000/health` in the
**phone's** browser. `{"ok":true}` means the network is fine.

---

## 11. Acceptance matrix — Phase 5, three phones, release APK, against the cloud

| # | Test | Pass condition |
|---|---|---|
| 1 | Register two accounts, invite, accept | Link is mutual only **after** acceptance |
| 2 | Invite left unaccepted | No alerts flow either way |
| 3 | Guess a code / hammer `/family` | Rate-limited |
| 4 | SOS from app, both foreground | Family takeover < 2 s |
| 5 | SOS from band, phone locked | Family phone **rings** with siren |
| 6 | SOS with the family app killed | Full-screen intent fires from push |
| 7 | Stand down from the band | Family alarm clears |
| 8 | Check-in request, phone locked | Band buzzes; ack clears within the window |
| 9 | Check-in ignored 90 s | **Server** escalates, not the phone |
| 10 | App swiped away, 20 min in a pocket | Band still connected, SOS still works |
| 11 | Phone rebooted | Service restarts, reconnects in < 60 s |
| 12 | Band out of range 5 min, then return | Auto-reconnect, no user action |
| 13 | Battery to 20 % | Family alerted + last buzz delivered |
| 14 | Battery to 5 % | `going_dark`; family screen shows last-seen |
| 15 | High Alert armed | Buzz at randomised 5–10 min; miss → alert |
| 16 | High Alert disarm without PIN | Refused |
| 17 | Fall: drop the band from 1.5 m | Detected, countdown appears |
| 18 | Fall: phone slides off a sofa | **No** alert (false-positive check) |
| 19 | Kill the service from OEM settings | Family's watch-status goes amber within 3 min |
| 20 | Good Samaritan on a severity-5 alert | Nearby non-family user is pushed; no name or exact pin until "I'm going" |

Record pass/fail with a timestamp. Anything failing on the demo path outranks
every unbuilt feature.

---

## 12. Cut lines, decided in advance

| Cut | When | Fallback |
|---|---|---|
| Good Samaritan | Day 3, 18:00 | Roadmap slide; it is the only stretch feature left in scope |
| Qwen Urdu dispatch | Day 3, 21:00 | Template messages already work in `RiskEngine._template` |
| Postgres / RDS | Day 4 midday | SQLite on ECS + OSS snapshot |
| The cloud entirely | Day 4, 14:00 | Demo on ngrok and say so — costs Alibaba points, not the product |
| Scream detection (PDM mic) | Do not start it | v2 |
| Token refresh, full rate limiting | Ship rate limits, cut refresh | Roadmap slide, stated out loud |

---

## 13. v2 — designed, not built

Both of these are cut from the sprint and specified here to the wire-protocol
level. Build them after the hackathon; **show this section during it.**

### 13.1 Operating without a phone — BLE mesh SOS

The problem it solves: the phone is dead, lost, or taken, and the band alone
cannot reach the internet.

**Band.** After 60 s with no central, stop connectable advertising and beacon
every 2 s. The payload rides in manufacturer-specific data and fits inside the
31-byte legacy advertisement:

```
[ver:1][band_id:2][counter:4][tag:8]   = 15 bytes

tag     = first 8 bytes of AES-128-CMAC(band_key, ver‖band_id‖counter)
counter = incremented per beacon session, persisted in flash
```

**Relay phone.** Registers a scan with
`BluetoothLeScanner.startScan(filters, settings, PendingIntent)` — filtering
happens inside the Bluetooth controller and delivery arrives as a broadcast
**even when the app's process is dead.** This one API is what makes the feature
realistic rather than aspirational. On a hit it POSTs
`{payload_b64, lat, lon, rssi, seen_at}` and shows the relaying user nothing at
all, ever.

**Server.** Look up `band_id`, recompute the tag with that band's key, reject
anything whose counter is not greater than the last seen. Raise an SOS attributed
to the **owner**, at the relay's coarse position, marked `source: mesh`.

```sql
CREATE TABLE relays (
    band_id TEXT NOT NULL,
    counter INTEGER NOT NULL,
    seen_at REAL NOT NULL,
    PRIMARY KEY (band_id, counter)      -- replay protection
);
-- devices gains: band_id TEXT, band_key BLOB   (provisioned at pairing)
```

**Privacy properties — this is the part worth presenting:**

- The relay learns nothing: ciphertext plus an identifier that rotates.
- The rolling counter blocks replay *and* long-term tracking of the wearer by a
  fixed ID.
- The server does learn the relay's position; round it to 100 m and drop the
  relaying user's id after 24 hours.
- The family gets a position accurate to BLE range — tens of metres, not one.
  Claim that honestly; it is still actionable.

**Why it was cut:** beacon firmware + offloaded background scanning + a crypto
scheme is three tracks of new work, and a crowded 2.4 GHz hall is the worst place
on earth to debug advertising.

### 13.2 Anti-snatching / theft lockdown

Four taps arm it. The app records `L0`, the last GPS fix while the band was
connected, and `T0`.

The trip needs **two independent signals**, and that is the whole feature — a BLE
disconnect alone happens every time you put your phone on a table:

```
disconnect, not preceded by a clean disarm
   └─▶ 12 s grace, reconnect attempts throughout
        └─▶ distance(L0, now) > 75 m within 90 s
            OR sustained speed > 2.5 m/s for 15 s
             └─▶ LOCKDOWN
```

Lockdown then: lock the screen via `DevicePolicyManager.lockNow()` (needs a
`DeviceAdminReceiver` the user activates during onboarding); capture front and
back silently using CameraX `ImageCapture` bound to `ProcessLifecycleOwner` with
**no preview surface**; queue the upload with retry to a presigned OSS PUT (a
thief's phone loses signal in a car — the queue is the feature); WhatsApp
fan-out via CallMeBot, which issues **one API key per recipient**, so store it on
the family-link row and not in global config; and raise a severity-5 alert
carrying the **last ten GPS points** so the family sees direction of travel
rather than one stale pin.

**Ethics, to be stated before anyone asks.** Silent capture is legally restricted
in some countries and loaded everywhere. The defensible framing, which must be
built and not merely claimed: photos are taken only after two independent signals
confirm a theft, they are encrypted at rest in a private bucket, and an OSS
lifecycle rule deletes them after 30 days.

**Why it was cut:** capturing with no preview surface on a locked device is the
highest-variance task on the board, and it is entangled with device-admin
approval, object storage and a third-party messaging API.

### 13.3 The rest of the roadmap

| Upgrade | Note |
|---|---|
| LRA + DRV2605L haptics | A coin ERM through a fabric strap is a weak buzz. This is the fix. |
| Scream detection on the PDM mic | On-device only — no audio ever leaves the wrist, which is the line that makes it acceptable. |
| Cellular band (NB-IoT / LTE-M) | Removes the phone from the critical path entirely; makes §13.1 a fallback rather than the answer. |
| Token refresh + full auth hardening | Currently tokens never expire. Fine for a demo, not for a product. |
| iOS | BLE background on iOS is a different discipline: state restoration, no foreground services. |

---

## 14. File map

```
Nigheban/
├── EXECUTION_PLAN.md           this file — phases, contracts, schema, skeletons
├── README.md                   what the project is and how to run it
├── server/nigehban_server.py   accounts, family, alerts, live push  [+ sweeper]
├── nigehban-app/
│   ├── App.js                  shell, alert takeover, band→server wiring
│   ├── plugins/                [Phase 0] withNigehbanAndroid.js
│   └── src/
│       ├── api.js              REST + reconnecting WS  [+ configurable base URL]
│       ├── band.js             BLE (NUS) + the simulated band that unblocks M1
│       └── screens/            Auth · Home · Family · Alerts
├── nigehban_band_nrf52/        [Phase 0] the real firmware
├── nigehban_band_esp32/        stand-in — keep it as a spare demo band
├── nigehban_hub.py             Guardian logic — the source for the server sweeper
└── config.json                 hub settings (DashScope keys go here)
```
