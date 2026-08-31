# Branch notes — `fix/ble-close-app-bug`

**Last updated:** 29 Aug 2026 · **Base:** `main` @ `66f09a1` · **Head:** `1f14d48`

The one sentence this branch exists for:

> **Everything the product does in an emergency has to keep working after Android
> has killed the app** — the BLE link to the band, the push that wakes the phone,
> and the siren that takes over the lock screen.

Three separate mechanisms all failed in that same state, for three unrelated
reasons, and each one looked fine from the UI. This document records what was
changed, why, what the actual defect was in each case, and what is still open.

---

## 1. Where the work lives

| Commit | Scope | Status |
|---|---|---|
| `59fc02d` | BLE link survives a closed app | **on `main`** |
| `66f09a1` | `scripts/push_doctor.py`, `scripts/bench.py` | **on `main`** (branch base) |
| `e652a58` | `dev-tunnel.ps1` dependency check bug | branch only |
| `d4d7213` | Native lock-screen alarm rebuilt + `.gitignore` fix + build guard | branch only |
| `11fd9a4` | EAS project moved to the new account | branch only |
| `c79894d` | Headless push payload parsing + notification fallback | branch only |
| `7b40286` | Android 14 full-screen-intent permission surfaced in Setup | branch only |
| `9cb366c` | Expo push error body logged by the server | branch only |
| `d0c0e0c` | `scripts/db.py` | branch only |
| `6474484` | Short-alarm-on-locked-screen fix (`App.js`, `NigehbanAlarmModule.kt`) | branch only — **not yet written up below** |
| `1f14d48` | `.gitignore` update | branch only |

The first two commits were made on `main` directly before the branch was cut, so
`git log main..HEAD` does not show them — but they are the first half of this
same bug, so they are documented here.

---

## 2. BLE: the link died with the process — `59fc02d`

### The problem

Close the app (or let Android recycle it) and the band dropped back to
advertising — the blinking light. Reopening the app left it idle until somebody
went to the Band screen and pressed **CONNECT** by hand. On a safety device,
that is the wristband being decorative for however many hours nobody thought
about it.

### Why it happened — three distinct causes

1. **The BLE link was owned by the React tree.** `BleManager`, the connected
   device, and both subscriptions lived in `useRef`s. Android tears a component
   tree down and rebuilds it for reasons that have nothing to do with the user
   being finished with the band — rotation, a config change, the activity being
   recycled while the process is still alive. Everything in a ref died with the
   tree, and the manager rebuilt on the next mount was a *second* native client
   that could not see the first one's connection. The link was both lost **and**
   leaked.

2. **Nothing kept the process alive.** A GATT connection belongs to the Android
   process. The foreground service is the only thing that keeps that process
   running once the app is off screen or swiped from Recents, and it was only
   started once somebody signed in — not when a real band was the chosen radio.

3. **Nothing reconnected on a cold start.** Even with a remembered band, there
   was no auto-link path.

### What was changed

- **[band.js:46-75](nigehban-app/src/band.js#L46-L75)** — `manager`, `linked`,
  `notifySub` and `dropSub` moved to **module scope**, which has the same
  lifetime as the link itself. Released by `disconnect()`, or by Android when
  the process finally dies, and by nothing else.
- **[band.js:520-548](nigehban-app/src/band.js#L520-L548)** — a new tree
  *adopts* an existing live link instead of building a new one, after checking
  `isConnected()` (the device object can outlive the connection it describes).
- **[band.js:33](nigehban-app/src/band.js#L33), [band.js:408-425](nigehban-app/src/band.js#L408-L425)** —
  the band id is persisted under `nigehban.band.id` on the first link and cleared
  only on an explicit DISCONNECT. Its presence is the standing instruction *"this
  phone wants that band"*. A reconnect now goes **straight at the known id**
  (6 s cap) before falling back to the 10 s scan — which matters because a band
  that just went back to advertising is usually not in the OS scan cache.
- **[band.js:550-567](nigehban-app/src/band.js#L550-L567)** — cold-start
  auto-relink, gated on `autoLink`.
- **[bandLink.js:53-59](nigehban-app/src/bandLink.js#L53-L59)** — `autoLink` waits
  for the stored mode to load. BLE is not the default, so before that read lands
  every launch looks like virtual mode and the relink would never fire.
- **[App.js:353-356](nigehban-app/App.js#L353-L356)** — the foreground service now
  starts whenever BLE is the chosen mode, not only after sign-in.
- **Stale GATT cache is now detected** rather than reported as success. Android
  caches a bonded device's service table, so after a firmware change it hands
  back the *old* service list without asking the band. The old code said
  "connected" while every read and write failed. Now the NUS service is verified
  after discovery and the failure names the fix (forget the band in Android
  Bluetooth settings).

### Status

**Written, reviewed, not yet observed on hardware.** The commit message says as
much. See §7.

---

## 3. Diagnostics that were missing — `66f09a1`, `e652a58`, `scripts/db.py`

These are not the fix; they are what made the rest of the fix findable.

- **[scripts/push_doctor.py](scripts/push_doctor.py)** — the server logs stopped at
  *"accepted by Expo"*, which only means Expo **queued** the message. Whether FCM
  actually delivered it lives in the push *receipt*, a second call the server
  never makes. This script makes it: `list`, `list --user Ali`, `send --user Ali`.
- **[scripts/bench.py](scripts/bench.py)** — endpoint latency, n iterations.
- **[scripts/db.py](scripts/db.py)** *(new, untracked)* — one SQL statement against
  the database **the server actually uses**, reading `DATABASE_URL` from the
  repo's own `.env`. There is no second connection string to keep in sync.
  Pointing a query at the wrong database was otherwise easy to do and hard to
  notice, because both databases answer.
- **[scripts/dev-tunnel.ps1:105-127](scripts/dev-tunnel.ps1#L105-L127)** — the
  dependency check itself was the bug. It ran all four imports in one
  `python -c`, so the message could not name what was missing; worse, Windows
  PowerShell wraps a native command's redirected stderr in `ErrorRecord`s, which
  under `$ErrorActionPreference = 'Stop'` **killed the script on Python's own
  traceback** — the check crashed instead of printing the install line three
  lines below it. Now: one import at a time, `$ErrorActionPreference` relaxed for
  the duration, and the message names the missing modules.

---

## 4. The big one: the native alarm was never in any APK — `d4d7213`

### The problem

The lock-screen takeover and looping siren (N3.3 / N3.4) had been written on
26 Aug and recorded in the plan as *"compiles on the next EAS build"*. It never
compiled. **Every build was green and every APK shipped without the feature.**

### Why it happened

The repo's **root `.gitignore` carried an unanchored `android/`**, which matches
a directory of that name at *any* depth. So
`nigehban-app/modules/nigehban-alarm/android/` — handwritten Kotlin, not
generated output — never entered git, and therefore never entered the tarball
EAS builds from.

Three mechanisms then each declined to complain, every one of them for an
individually good reason:

- autolinking **skips** a module whose native directory is absent,
- Gradle had nothing to compile, and so compiled nothing,
- `requireOptionalNativeModule` **returns null rather than throwing** — by
  design, so the app does not die on a platform where the module is legitimately
  missing.

The JS fallback (`Vibration.vibrate`) then ran instead, which looks like a
working alarm right up until the app is killed — because that fallback needs the
app's JavaScript to still be running, which is the exact case the feature exists
for.

### What was changed

- **[.gitignore:52-56](.gitignore#L52-L56)** — the unanchored `android/` and `ios/`
  removed. The generated folders are still ignored by
  [nigehban-app/.gitignore:40-41](nigehban-app/.gitignore#L40-L41), where `/ios`
  and `/android` are **anchored to the app directory**. The reasoning is written
  into the file so nobody re-adds them.
- **[NigehbanAlarmModule.kt](nigehban-app/modules/nigehban-alarm/android/src/main/java/com/nigehban/alarm/NigehbanAlarmModule.kt)**
  (348 lines) + `build.gradle` + module manifest now actually in git.
- **[plugins/withNativeModuleGuard.js](nigehban-app/plugins/withNativeModuleGuard.js)** —
  a config plugin that **fails the build** when a module under `modules/`
  declares Android native code that is not present to compile. It runs inside a
  `withDangerousMod`, so it fires during `expo prebuild` — which is what EAS runs,
  against the **uploaded** files. That is the only place the mismatch was ever
  observable: the same check on the authoring machine passes, because there the
  sources are sitting right there. `expo start` is deliberately left alone, so a
  missing native module never blocks JS work. Registered at
  [app.json:80](nigehban-app/app.json#L80).
- **[app.json:39-41](nigehban-app/app.json#L39-L41)** — `ACCESS_BACKGROUND_LOCATION`,
  `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION` added.

### How the Kotlin works (four decisions worth not re-litigating)

1. **The channel is deliberately silent and still.** A notification channel plays
   its sound and vibration exactly once and Android gives no way to loop them —
   so a `MediaPlayer` (`isLooping = true`) and `VibrationEffect.createWaveform(pattern, 0)`
   own the audio and the buzzing instead. That is the "until dismissed" half.
2. **Audio goes out on `STREAM_ALARM`.** `setBypassDnd(true)` is silently ignored
   without Notification Policy Access, which this app does not have. `USAGE_ALARM`
   audio is exempt from Do Not Disturb by default. The alarm stream *is* the DND
   answer.
3. **`CATEGORY_CALL` + `setFullScreenIntent`** — the same pair an incoming-call
   screen uses. The launched activity has to cooperate: `withNigehbanAndroid.js`
   sets `android:showWhenLocked` and `android:turnScreenOn`, or the SOS comes up
   *behind* the lock screen with the display still off.
4. **The alert id rides on the launching intent.** A full-screen intent is not a
   notification tap, so `expo-notifications` never sees it and
   `subscribeNotificationTaps` never fires. `consumeLaunchAlertId()` is how a cold
   start learns which emergency woke it — read once and removed, or the app
   reopens an emergency that ended days ago.

---

## 5. EAS project moved to the new account — `11fd9a4`

[app.json:88-96](nigehban-app/app.json#L88-L96): `owner` `moaxxx` → **`srk1122`**,
`extra.eas.projectId` `ac29701a…` → **`c9294627-3ef6-4ff8-91b6-9ecf73bad0c0`**.

**This has a consequence that is easy to miss, and it is now an open item — see
§7.2.** An Expo push token is minted against a specific EAS project. Every token
already sitting in the `devices` table belongs to the *old* project.
`send_expo_push_notifications` batches every target's token into **one** POST to
`exp.host`, and Expo rejects a batch that mixes projects with
`PUSH_TOO_MANY_EXPERIENCE_IDS` — a 400 that fails **the whole batch**, so nobody
gets the push, not just the stale phone.

---

## 6. What the alarm rebuild still needed — `c79894d`, `7b40286`, `9cb366c`

### 6.1 The silent push woke the app and then did nothing

**[bgNotifications.js:65-113](nigehban-app/src/bgNotifications.js#L65-L113)** —
this is the defect that made the whole killed-app path a no-op.

`extractAlert` picked a payload shape with a `??` chain:

```js
const d = payload?.data?.notification?.data
  ?? payload?.notification?.data
  ?? payload?.data      // <-- always truthy
  ?? payload ?? {};
```

`payload.data` is **always** present on a background notification, so the chain
always stopped there, and the object it found had no `alert_id` — so the task
reported "no alert" and returned, for **every push a closed app ever received**.
The phone woke up, ran the task, found nothing, and went back to sleep.

The real shape for a *headless* notification is documented in
`expo-notifications`' own `NotificationTaskPayload`: `notification` is **null**
and the data arrives as a **JSON string** in `data.dataString`, because Android's
`NotificationSerializer` writes it that way for anything sent through the Expo
push service. Nothing in the SDK parses it for you.

The rewrite builds a candidate list — the two `dataString` shapes parsed first,
then the five already-running object shapes — and **tries every candidate for an
alert id** instead of trusting the first non-null one.

### 6.2 A floor under a takeover that did not happen

**[bgNotifications.js:115-147](nigehban-app/src/bgNotifications.js#L115-L147)** —
`presentAlarm` returning `false` means the native module was not in this binary,
so all it managed was `Vibration.vibrate` — and a vibration started from a
headless task stops when Android tears that task down seconds later. Without a
fallback, the killed-app path could end in **nothing at all**.

`notifyIfNothingShown` checks `getPresentedNotificationsAsync()` for the same
alert id before posting, because the server already sends a visible push
alongside the silent one and both land on the same emergency channel. The check
can still lose the race — the two pushes arrive independently. **That direction
is chosen on purpose:** two notifications is a nuisance, none is the product
failing.

### 6.3 Android 14 quietly downgrades the takeover

Since Android 14, `USE_FULL_SCREEN_INTENT` is **no longer granted at install** to
anything that is not a calling or alarm-clock app, and there is no runtime
prompt for it — only a Settings page. Declaring it in the manifest is now
necessary and **not sufficient**. When it is missing, `setFullScreenIntent` does
not fail; it degrades to an ordinary heads-up notification, which is
indistinguishable from the alarm simply not working.

- **[NigehbanAlarmModule.kt:147-163](nigehban-app/modules/nigehban-alarm/android/src/main/java/com/nigehban/alarm/NigehbanAlarmModule.kt#L147-L163)** —
  `canUseFullScreenIntent()` and `openFullScreenIntentSettings()`.
- **[alarm.js:51-68](nigehban-app/src/alarm.js#L51-L68)** — JS wrappers returning
  `true` / `false` / `null`, where `null` means *the question does not apply*
  (Android 13 and below, Expo Go, web) so a caller can tell "not allowed" from
  "not asked".
- **[Setup.js:463-479](nigehban-app/src/screens/Setup.js#L463-L479)** — a red
  **"Full-screen permission: blocked"** row with an **ALLOW FULL-SCREEN ALERTS**
  button. Only `false` gets a row, and it is a loud one: every other diagnostic
  on that screen can read green while the takeover is being held back.

### 6.4 The server now says *why* a push failed

**[nigehban_server.py:1089-1101](server/nigehban_server.py#L1089-L1101)** — a bare
`HTTP Error 400: Bad Request` says nothing, and this is the one failure mode
where Expo does explain itself: a 4xx body is JSON carrying a `code` and a
`message`. The handler prints the body. This is what makes §5's
`PUSH_TOO_MANY_EXPERIENCE_IDS` visible instead of invisible.

---

## 7. What is left

### 7.1 Blocking — must happen before anything here can be called done

- [x] **Build it.** Done on `11fd9a4` via EAS. Confirmed by dex inspection rather
      than by the build going green, which is what fooled everyone last time:
      the old APK had `NigehbanAlarm` in *no* dex file; the new one has it in
      `classes2.dex`, alongside `canUseFullScreenIntent` and
      `consumeLaunchAlertId`. `withNativeModuleGuard` also ran and passed.
- [x] **Setup → TEST THE LOCK-SCREEN ALARM** — siren heard on device.
- [x] **Full-screen permission granted** on the Android 14+ test phone.
- [x] **Verify the killed-app path on hardware.** **Observed 29 Aug 2026.** App
      swiped out of Recents, phone locked, a real SOS fired from a second phone
      on a different account — the full-screen takeover came up with the siren,
      not a plain notification.

      This was the only box in this section that could catch the defect it was
      written for: every *other* box here was passing while a real SOS to a
      closed app still produced one silent notification. That it now takes over
      means `c79894d` is in the installed build and the whole chain holds end to
      end — server → Expo → FCM → headless task → `extractAlert` parsing
      `dataString` → native alarm.

**§7.1 is now clear.** Everything remaining on this branch is §7.2–§7.5.

### 7.2 Push tokens after the account move (§5)

- [ ] **Purge every push token minted under the old `projectId`** from the
      `devices` table, and have each phone re-register on the new build.
      `python scripts/db.py "select * from devices"` and
      `python scripts/push_doctor.py list` are the two tools for this.
- [ ] Consider **grouping the batch by project/experience** in
      `send_expo_push_notifications` so one stale token cannot fail the send for
      the whole family. Today the batch is all-or-nothing.

### 7.3 Verification on hardware — the BLE half (§2)

The Phase 2 exit gate, unchanged: **phone locked, screen off, app swiped from
Recents, 20 minutes in a pocket, press the band, the family phone rings.**

- [ ] Band reconnects on its own after the app is force-stopped and reopened.
- [ ] Link survives a rotation / config change without leaking a second manager.
- [ ] Direct-connect-by-id path hits before the scan fallback (visible in the dev
      log as `BAND direct connect failed:` only when it misses).
- [ ] DISCONNECT actually forgets the band and does **not** trigger the retry.

### 7.4 Still open from the plan, untouched by this branch

- [ ] **N2.3** — boot receiver: service restarts and reconnects in under 60 s.
- [ ] **N2.4** — WorkManager watchdog (is the service alive, is BLE connected, is
      the socket up). **Watchdog only** — the 15-minute floor makes it useless as
      a timer.
- [ ] **N1.4** — drop `usesCleartextTraffic` once the cloud has TLS (D2).
- [ ] **N3.2** — the DND-bypass channel is fixed in code but still not verified
      end-to-end on a device under Do Not Disturb.
- [ ] `virtualBand.js` never implements the band's nag timeout, so the
      phone-as-band cannot produce `checkin_missed` — ~10 lines to port from
      `nigehban_band_nrf52.ino:577`, and it closes both a test gap and a real
      firmware/JS divergence.

### 7.5 Known risks left in deliberately

- **Duplicate emergency notification.** §6.2 can post a second notification when
  it loses the race with the visible push. Accepted: a duplicate beats a silence.
- **Alarm volume is not restored if the process dies mid-alarm.** The stream is
  raised to maximum and handed back on stop; a killed process leaves it up. The
  right direction to fail in, and cheaper than the machinery to guarantee
  otherwise.
- **MTU stays at 23.** The central drives negotiation and Android has closed its
  exchange window by the time the app asks. With correct chunking this is
  inefficient (5 packets per line, not 1), not broken — an optimisation, and
  moving `requestMTU` back into `connect()` is exactly what broke the
  subscription once already. Do not pull that lever without a way to see the
  error.

---

## 8. The lesson this branch keeps re-teaching

Every defect in §2, §4 and §6.1 shared one shape: **the failure was invisible
from the UI, and something downstream had a good reason not to complain.**
Autolinking skips absent modules by design. `requireOptionalNativeModule`
returns null by design. A `??` chain stops at the first non-null value by
design. A JS vibration fallback looks exactly like a working alarm — until the
process is dead, which is the only case that matters.

The response has been to make each silence loud in the place it happens:
`withNativeModuleGuard` fails the build, the Setup screen shows the Android 14
permission, the server prints the Expo error body, `push_doctor.py` fetches the
receipt the server never asked for. That is the part worth keeping when the
next one of these turns up.
