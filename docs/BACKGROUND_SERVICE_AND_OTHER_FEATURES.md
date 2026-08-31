# Background Service and Other Features

**Last updated:** 29 Aug 2026 · **Branch:** `fix/BG-service-runs-only-with-band`
· **Base:** `fix/ble-close-app-bug`

If you have just pulled this repo, read §0 and §1, then set up a database from
§4. Everything else is reference.

Companion document: [`BRANCH_NOTES_ble-close-app-bug.md`](BRANCH_NOTES_ble-close-app-bug.md)
covers the BLE link, the lock-screen alarm and the killed-app push path. This
one picks up where that left off.

---

## 0. What state this is in

Two pieces of work, both **written and reviewed, neither yet observed on a
phone**:

| Work | Status |
|---|---|
| Foreground service now starts and stops on the right condition | Committed (`ac31682`), **untested on hardware** |
| Two batteries — the band's and the phone's, told apart | In the working tree, **untested on hardware** |

Nothing here is proven until §6's checklist is ticked on a real device. That is
not boilerplate caution: every defect this project has had so far looked fine
from the UI and was caught only by testing the killed-app path directly. See §8.

**Verified before this branch:** an SOS from another account reaches a phone
whose app has been swiped out of Recents, on a locked screen, as a full-screen
takeover with a siren. That was the last blocking item on the previous branch.

---

## 1. The one problem behind all of it

> Android kills apps. Everything this product does in an emergency has to keep
> working after it has.

Three mechanisms answer that, and they are independent — which one you need
depends on what has to survive:

| Mechanism | Keeps working when | Used for |
|---|---|---|
| **FCM / Expo push** | The app is fully dead | Alerts arriving from the server |
| **Foreground service** | The app is off screen or swiped from Recents | Holding the BLE link, sending heartbeats |
| **Native alarm module** | Screen locked, app dead | The lock-screen takeover and siren |

The push path is the strongest and needs no process at all — it is how WhatsApp
delivers a message to a phone whose app is not running. The foreground service
is the weak one, and it exists only because two things genuinely cannot be done
by push: **a BLE connection belongs to the process**, and **the heartbeat is a
`setInterval` in JavaScript**.

---

## 2. The foreground service

### What it is

The sticky "Nigehban is watching" notification. While it is up, Android keeps
this app's process alive, which keeps the BLE link and the heartbeat alive.
Android 8+ requires the visible notification — it cannot be hidden.

Implemented in [`src/bgService.js`](nigehban-app/src/bgService.js) on top of
`expo-location`'s foreground-service option. The location updates are a means to
an end; the task body is deliberately a no-op.

### What changed

**It used to run whenever somebody was signed in.** That is the wrong question.
A family member watching from across town was running a permanent service,
holding a permanent notification, and being asked for **"Allow location all the
time"** — Android's most alarming permission and a Play Store review risk — for
a process with nothing to keep alive. Their alerts come by push, which works
with the app dead.

It now runs when the phone is **actually acting as a safety device**, which is
two independent conditions, either one sufficient
([`App.js`](nigehban-app/App.js), the `syncBackgroundWatch` effect):

1. **A band is linked** — `nigehban.band.id` exists *and* the app is in BLE
   mode. The GATT link belongs to the process, so losing the process drops the
   band back to advertising.
2. **The phone is armed at all** — `watchMode !== 'idle'`. The heartbeat only
   beats in that state, and that is exactly the state where three minutes of
   silence makes the server page the whole family with `watch_lost`. Kill an
   armed phone's process and it reports its own wearer missing.

| Phone | Service |
|---|---|
| BLE mode, band linked | On |
| Virtual mode, armed (the phone *is* the band) | On |
| BLE mode, armed, band out of range | On |
| Signed in, idle, no band — a family watcher | **Off** |
| Band unlinked by pressing DISCONNECT, idle | **Off** |

### Three things it deliberately does not key off

- **The live connection.** A band out of range is precisely when
  [`band.js`](nigehban-app/src/band.js)'s 3-second retry loop needs the process
  alive. Stopping the service there kills the thing doing the reconnecting.
- **`band.mode` alone.** DISCONNECT clears the stored band id but never touches
  the mode, so a deliberately unlinked phone would sit in BLE mode forever.
- **The stored band id alone.** Switching to virtual mode does not clear it, so
  a phone testing with the virtual band would hold a service for a band it is
  not using.

### The tri-state

`wantsBand()` in [`band.js`](nigehban-app/src/band.js) returns `true` / `false`
/ **`null`**, where null means *could not tell* — the same convention
[`alarm.js`](nigehban-app/src/alarm.js) uses for the Android 14 full-screen
permission.

This matters more than it looks. The obvious version reuses `recallBand()`,
which swallows a storage read error into `null`. Harmless on the connect path,
where it just falls back to a scan. Fatal here: a transient AsyncStorage hiccup
would read as "no band", stop the service, kill the process and **drop a live
BLE link**. `syncBackgroundWatch(null)` changes nothing instead.

The bias is deliberate. An extra minute of notification is a nuisance; a
wrongly stopped service is the emergency path failing.

---

## 3. The two batteries

### The bug

The app read `band.battery` — in BLE mode, the **wristband's** ADC reading from
[`nigehban_band_nrf52.ino`](nigehban_band_nrf52/nigehban_band_nrf52.ino) — sent
it to the server as `phone_batt`, and showed the family **"Phone about to die"**.

So a wearer at 4% band and 90% phone paged his family about the wrong device.
And a wearer whose phone was genuinely dying said nothing at all, because the
phone's own battery was never read anywhere outside `virtualBand.js`.

### The fix

Two numbers, carried and displayed apart, because they fail apart and mean
different things:

- **Flat band** — the safety device is off the air, but the phone can still be
  reached by push. Maintenance. Severity 1.
- **Flat phone** — every path to the family is about to close, *including* that
  push. Severity 3.

| Alert kind | Fires on | Family sees |
|---|---|---|
| `band_battery` (new, sev 1) | Band ≤ 20% | "Band battery low" |
| `low_battery` (sev 1) | **Phone** ≤ 20% | "Phone battery low" |
| `going_dark` (sev 3) | **Phone** ≤ 5% | "Phone about to die" |

Yes, the nRF52 measures its own battery — it always did. The divider on
`VBAT_ENABLE` (P0.14) is read on `PIN_VBAT` (P0.31) at 12-bit, averaged over 8
samples, and sent as `"bat"` in every event.

**Do not trust that number yet.** It is not merely uncalibrated — it is
*unstable*. [DEVELOPMENT_PLAN F2.3](DEVELOPMENT_PLAN.md) records consecutive
heartbeats alternating between `mv:4085`/**93%** and `mv:3699`/**39%**, on one
board, on one continuous `seq`. The divider's source impedance (~338k) is far
too high for the SAADC's default acquisition window, so each conversion is
dragged toward the previous one, and averaging 8 back-to-back reads does not
help because every sample is equally under-settled. `VBAT_DIVIDER_COMP` is
*also* an uncalibrated guess (`2.961F`, marked `// VERIFY`), but that is the
smaller problem.

Two consequences:

- The split above is what contains this. `going_dark` and `low_battery` now
  come from the phone's OS-reported battery, which is reliable; only the
  severity-1 `band_battery` rides the unstable reading. Before the split, this
  ADC could raise a severity-3 "phone about to die".
- `band_battery` requires **three consecutive** readings below the threshold
  (`BAND_LOW_STREAK` in `App.js`), because an alternating signal never produces
  two in a row. No hysteresis band survives a 54-point swing. That is a
  workaround; the fix is F2.3 in firmware — a longer acquisition time, or a
  median-of-N with a gap between samples. A median rejects the alternating
  outlier; a mean does not.

### Where they show up

- `usePhoneBattery()` in [`src/watch.js`](nigehban-app/src/watch.js) reads
  `expo-battery`. Already a dependency — **no new native module**, so an EAS
  build carries it with no config-plugin work.
- The heartbeat sends `phone_batt` and `band_batt` as separate fields, never
  substituted for one another. In virtual mode `band_batt` is `null` — there is
  no second cell — rather than a copy of the phone's reading.
- `/watch/{member_id}` returns both. Both family screens read that endpoint.
- [`WatchStatusTile.js`](nigehban-app/src/components/WatchStatusTile.js) shows
  `connected · 41%` on the band's own row, with `PHONE BATTERY` as its own
  column.
- [`Dashboard.js`](nigehban-app/src/screens/user/Dashboard.js) shows
  `PHONE BATTERY 68%` and `BAND · Linked · 41%`.

### Migration note

`phone_batt` **keeps its name** and finally becomes what it always claimed to
be. Rows written before migration 002 hold band battery under it. They are not
back-filled: the next heartbeat overwrites them, and the value is only ever read
as "right now". A family member glancing at the app before their wearer's next
heartbeat sees one stale, mislabelled number.

---

## 4. Database — local Postgres or Supabase

The server is **Postgres only**. `server/nigehban.db` is a leftover from the
SQLite era and is no longer read by anything; ignore it.

One setting decides everything: **`DATABASE_URL` in `.env` at the repo root.**
There is no second place to configure a database, and that is on purpose —
pointing a query at the wrong database is easy to do and hard to notice, because
both databases answer.

Start by copying the template:

```bash
cp .env.example .env
```

### Option A — local Postgres

Good for development. No network, no shared state, safe to wipe.

1. **Install Postgres** (any 14+). Windows: the EDB installer. macOS:
   `brew install postgresql@16`. Linux: your package manager.

2. **Create the database:**

   ```bash
   createdb nigehban
   ```

3. **Set `DATABASE_URL` in `.env`:**

   ```
   DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/nigehban
   ```

4. **Create the schema.** The file is named for Supabase but is plain Postgres —
   the only extension it needs is `pgcrypto`, which ships with standard
   installs:

   ```bash
   psql -d nigehban -f server/supabase_migration.sql
   ```

5. **Apply migrations:**

   ```bash
   cd server && python migrate_pg.py
   ```

### Option B — Supabase

**Database only.** There is no deployed server: `nigehban_server.py` runs on
your own machine and reaches Supabase over the internet, and phones reach *you*
through an ngrok tunnel (§5). Supabase is the shared database, not a host.

Use this when more than one person needs to see the same data, or when you want
your phone testing to survive a laptop reboot.

1. **Create a project** at supabase.com.

2. **Run the schema.** Dashboard → SQL Editor → New Query → paste
   `server/supabase_migration.sql` → Run.

3. **Get the connection string.** Project Settings → Database → Connection
   string → URI. Put it in `.env`:

   ```
   DATABASE_URL=postgresql://postgres:[PASSWORD]@db.xxxxx.supabase.co:5432/postgres
   ```

   `.env.example` also lists `SUPABASE_URL`, `SUPABASE_ANON_KEY` and
   `SUPABASE_SERVICE_ROLE_KEY`. The server does not currently use them — it
   talks to Postgres directly — but leave them filled if you have them. **The
   service-role key is secret and must never reach the app or a commit.**

4. **Apply migrations:**

   ```bash
   cd server && python migrate_pg.py
   ```

### Switching between them

Change `DATABASE_URL` and restart the server. Nothing else. To check which one
you are actually on, the server prints `host/dbname` in its startup banner, and:

```bash
python scripts/db.py "select count(*) from users"
```

runs against whatever `.env` says — the same string the server reads.

### Applying migrations — always use the runner

```bash
cd server && python migrate_pg.py
```

It applies every `migrations/*.sql` in name order, is idempotent by
construction, and reads `DATABASE_URL` from `.env` so there is no connection
string to retype. Re-running is safe; you will see `001_epoch_times.sql` applied
again as a no-op.

> **Ordering, and this one bites.** Run the migration **before** starting server
> code that uses the new column. Backwards, every `/heartbeat` fails on a
> missing column, no heartbeats are recorded, and three minutes later the
> sweeper pages **every armed user's entire family** with `watch_lost`.
>
> ```
> 1. python migrate_pg.py           ← column exists
> 2. restart the local server       ← code that writes to it
> 3. eas build                      ← app that sends it
> ```
>
> Since the server is a process on your laptop, "deploying" it is just
> restarting it — but the migration still has to land first, and on the Supabase
> database everyone shares, not only on your local one.
>
> App-before-server is safe: an old server ignores the unknown field, and the
> band percentage is simply absent until it catches up.

---

## 5. Running it

**How this actually runs today.** Nothing is deployed. The server is a process
on a developer's laptop; phones reach it through an ngrok tunnel; the database
is either local Postgres or Supabase (§4). The README's Alibaba Cloud / Caddy
deployment is future work, not the current setup — so "the server" below always
means the one running in your terminal.

**Server:**

```bash
pip install -r requirements.txt
python server/nigehban_server.py
```

It prints the LAN address and, if an ngrok tunnel is up, the public one. Port
8000.

**A tunnel, so phones off your Wi-Fi can reach it:**

```bash
./scripts/dev-tunnel.ps1        # or dev-tunnel.sh
```

**App:**

```bash
cd nigehban-app && npx expo start
```

Type the server address into the app's setup screen. The rule
([`api.js`](nigehban-app/src/api.js)): a bare IPv4 or `localhost` gets `http://`,
anything else gets `https://`.

**A real build** — needed for BLE, the foreground service, and the lock-screen
alarm, none of which exist in Expo Go:

```bash
cd nigehban-app && eas build --platform android --profile development
```

---

## 6. Testing checklist

Tick these on a real device. Nothing in §2 or §3 is proven until they are.

### 6.1 Foreground service — when it runs

- [ ] **Virtual mode, armed, app swiped from Recents, wait 5 minutes → the
      family is told nothing.** *The most important one.* This is the case an
      earlier version of this change broke: it stopped the service on any phone
      with no BLE band, which includes virtual mode, where the phone *is* the
      band and is armed.
- [ ] Band linked, walk out of range → notification **stays up**, band
      reconnects on its own when you return.
- [ ] Band linked, app swiped from Recents → notification stays up.
- [ ] Press DISCONNECT while idle → notification **disappears**.
- [ ] Sign in on an idle phone with no band → **no notification at all**, and
      **no "Allow location all the time" prompt**.
- [ ] Fire an SOS at that band-less phone → the alert still arrives. (Proves the
      push path does not need the service.)
- [ ] Switch a previously-linked phone to virtual mode while idle →
      notification disappears.

### 6.2 Batteries

- [ ] Family view of a BLE wearer shows **two** numbers: `PHONE BATTERY 68%` and
      `BAND · Linked · 41%`.
- [ ] Drain the **phone** below 20% → family gets **"Phone battery low"**.
- [ ] Drain the **phone** below 5% → family gets **"Phone about to die"**, and
      the wearer sees the critical toast.
- [ ] Band below 20% → family gets **"Band battery low"**, *not* a phone
      warning. **This is the one that proves the original bug is dead.**
      Needs three consecutive low readings (~3 minutes), and with the ADC in
      its current state it may fire *never* — which is a pass, not a failure.
      To exercise the alert path itself rather than the ADC, pin the level with
      the firmware's own command: `{"c":"bat","v":10}` sets `gBatteryForced`
      so the reading stops alternating.
- [ ] Virtual mode → band battery reads `—` / absent, and **only one** battery
      alert fires, not two.
- [ ] Charge back above threshold, drop below again → the alert fires a second
      time (the latch re-arms).

### 6.3 Regression — things that were already working

- [ ] SOS from another account to a phone with the app swiped away, screen
      locked → **full-screen takeover with siren**, not a plain notification.
- [ ] Band reconnects on its own after the app is force-stopped and reopened.
- [ ] Link survives a rotation without leaking a second BLE manager.
- [ ] DISCONNECT actually forgets the band and does not trigger the retry loop.

### 6.4 Database

- [ ] `python scripts/db.py "select phone_batt, band_batt from watch_state"`
      returns both columns with sensible values.
- [ ] The server's startup banner names the database you expect.

---

## 7. What is still open

### Next up

- [ ] **Setup screen reports a healthy phone as broken.** The "Watch
      notification: not running" row is amber with a warning triangle. After §2
      that is the *correct* state for every family member's phone, so it now
      looks like a fault. The row needs to compare **expected** against
      **actual**: green when it should run and does, red when it should and does
      not, neutral "not needed — no band linked, not armed" otherwise. The
      **"START WATCH NOTIFICATION NOW"** button also force-starts past the gate,
      and the gate silently wins back on the next state change.
- [ ] **Band disconnected for a long time tells nobody.** There is no alert of
      any kind for a dropped band today. It should be a **local** notification
      on the wearer's phone after a few minutes of failed retries, cleared on
      reconnect — not a family page. A flat wristband is maintenance; paging
      five relatives for it teaches them to swipe alerts away.
- [ ] **`watch_lost` fires when nothing is wrong.** It means *the phone went
      silent while armed*, but it fires whenever Android backgrounds the app,
      because the heartbeat is a JS `setInterval`. Proposed fix: before
      declaring it, have the server send a high-priority data push and wait ~30
      seconds. A merely backgrounded phone answers; a dead one does not. That
      turns it from "the app got backgrounded" into "this phone is genuinely
      unreachable". The headless push path is already proven to work.
- [ ] **`watch_lost` is also badly named.** It reads to a family member as *the
      wristband died*. It is about the phone. Rename it and its copy.

### Carried over

- [ ] **N2.3** — boot receiver: service restarts and reconnects within 60 s.
- [ ] **N2.4** — WorkManager watchdog (is the service alive, is BLE connected).
      Watchdog only; the 15-minute floor makes it useless as a timer.
- [ ] **§7.2 of the branch notes** — purge push tokens minted under the old EAS
      `projectId`, and group the push batch by project so one stale token cannot
      fail the send for a whole family.
- [ ] `virtualBand.js` never implements the band's nag timeout, so the
      phone-as-band cannot produce `checkin_missed`.
- [ ] Calibrate `VBAT_DIVIDER_COMP` in the firmware against a known voltage.

### Bigger, later

- **`connectedDevice` foreground-service type.** The service currently keeps the
  process alive by asking for location updates, which is why it needs
  `ACCESS_BACKGROUND_LOCATION`. `FOREGROUND_SERVICE_CONNECTED_DEVICE` is the
  type Android actually intends for a companion wearable and needs no location
  permission. `expo-location` cannot emit it — it would need a small Kotlin
  service alongside the existing `nigehban-alarm` module.
- **`CompanionDeviceManager`.** The real Android answer for a wristband.
  Associating the band grants background-run rights, and on Android 12+ a
  `CompanionDeviceService` gets `onDeviceAppeared` / `onDeviceDisappeared` — the
  OS watches for the band and wakes the app, which is structurally what Play
  Services does for push. Would largely subsume N2.3.
- **Anti-snatch (v2).** Firmware has `gArmed` and an unbound hold-5s gesture
  reserved for it. The routing rule to settle now: a band disconnecting **while
  anti-snatch is armed** is a family-facing severity 5; disconnecting otherwise
  is the local maintenance notice above. Same detection, two audiences.

---

## 8. Traps this repo has already fallen into

Read this before assuming a green build means anything.

1. **A build can be green and ship nothing.** An unanchored `android/` in the
   root `.gitignore` kept a whole hand-written Kotlin module out of git, so
   every EAS build compiled without it. Autolinking skips absent modules,
   Gradle compiled nothing, and `requireOptionalNativeModule` returned null —
   all three by design, none of them complaining.
   `plugins/withNativeModuleGuard.js` now fails the build instead.
2. **`??` stops at the first non-null value.** A payload-shape chain always
   matched `payload.data`, which is always present and had no alert id — so
   every push to a closed app found nothing and went back to sleep, while every
   diagnostic read green.
3. **A JS fallback looks exactly like a working feature** until the process is
   dead, which is the only case that matters.
4. **The heartbeat is not telemetry — its absence is the alert.** Anything that
   stops the process while armed pages the family.
5. **Two databases both answer.** Always check which one you are on.

The pattern is the same every time: **the failure was invisible from the UI, and
something downstream had a good reason not to complain.** When you add
something here, make its silence loud in the place it happens.
