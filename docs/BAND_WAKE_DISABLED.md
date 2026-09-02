# The band's beacon wake — switched off

**Decision date:** 1 Sep 2026
**Status:** off in the code, not removed from it
**Feature:** the band raises an SOS with the app already killed, by putting an
SOS flag in its BLE advertisement and having Android's Bluetooth controller
match it against a scan registered with the *system* via a PendingIntent.
**Introduced by:** `3d5efb9 feat: let the band raise an SOS with the app already
killed`, on `feature/pendingIntent-scan` (merged in `e3211d5` / PR #21).

This file exists so the decision does not have to be rebuilt from the code six
months from now. It records what was switched off, what that costs, what it does
*not* cover, and exactly how to turn it back on.

---

## The decision, in one paragraph

The beacon wake is **off**. Nothing was reverted and nothing was deleted — the
whole feature is behind two boolean switches, both currently `false`, and the
code they guard is still in the tree exactly as it was written. The reason is
that the wake carries **no band identity**: every Nigehban band advertises a
byte-identical pattern, so one band's press wakes every Nigehban phone in range
and is raised as *that* phone owner's emergency, to *that* owner's family, with
*that* phone's location (BUG-012) — and the same press poisons the second
wearer's dedup state so their own real press is silently discarded (BUG-013).
Both are Critical. Closing them needs a band id in the advertisement, which
means **new firmware in the field on every band**, and that is not work for
today. On the reporter's Android 8 Vivo the wake also drags unrelated apps to
the foreground (BUG-018).

---

## What you lose by switching it off — read this before shipping

On an OEM skin that runs `kill -9` on a Recents swipe — Vivo, Oppo, Xiaomi,
Huawei, Transsion — **a band press with the app killed now reaches nobody.**

That is not a regression this switch introduces so much as a regression it
restores: it is exactly the behaviour that existed before `3d5efb9`, and the
feature was written to fix it. Switching it off is a deliberate trade:

> A press that goes nowhere is better than a press that pages the wrong
> family and eats the right one.

The operational consequence, which should be said out loud to anyone testing or
demoing: **the band is a working safety device only while the app or its
foreground service is alive.** On a Samsung or stock Android that is nearly
always, and the SOS arrives over the ordinary GATT link the way it always did.
On the Vivo it is until the next Recents swipe.

BUG-010's severity note used to soften itself by pointing at this beacon as the
emergency path's floor. That floor is gone. The note has been corrected.

---

## The switches

Three files, two switches, one live cleanup call. All of them say the same thing
and point back here.

| Where | What | Currently |
|---|---|---|
| [nigehban-app/src/bandWake.js](../nigehban-app/src/bandWake.js) | `const BAND_WAKE_ENABLED` | `false` |
| [BandWake.kt](../nigehban-app/modules/nigehban-bandwake/android/src/main/java/com/nigehban/bandwake/BandWake.kt) | `const val FEATURE_ENABLED` | `false` |
| [nigehban-app/App.js](../nigehban-app/App.js) | the three beacon effects | commented out |

**Both switches are needed, and it is worth understanding why neither is
sufficient alone.**

The JS switch stops the app *asking* to be woken. It cannot stop the app
*being* woken, because the two paths that do that run in a process with no
JavaScript in it:

- a registration left in the Bluetooth stack by a build that had the feature
  on — it survives the app dying, which is the entire point of it;
- `BandWakeBootReceiver`, which re-arms on `BOOT_COMPLETED`,
  `MY_PACKAGE_REPLACED` and a Bluetooth toggle, reading the `armed` flag out of
  SharedPreferences. That flag is still `true` on any phone that had the feature
  on, and an update does not clear it.

So without the native switch, the first reboot after the update would put the
scan back and the feature would return with nobody having asked for it.

### What each switch does

**`BAND_WAKE_ENABLED = false`** (bandWake.js) — `bandWakeAvailable()` is false,
`subscribeBandSos()` returns a no-op unsubscriber, `consumePendingBandSos()`
returns null without reading storage, and `bandWakeDiagnostics()` reports the
reason. `startBandWake()` deliberately does **not** simply return: it calls
`stopBandWake()` first, so the one call site that used to arm is what disarms an
upgrading phone.

**`FEATURE_ENABLED = false`** (BandWake.kt) — `start()` tears down any surviving
registration and refuses to make a new one. `restartIfArmed()` inverts: a
standing instruction left by an earlier build is *withdrawn* rather than acted
on, which is what stops a reboot defeating the switch.

**`BandWakeReceiver.onReceive`** returns immediately, after calling
`BandWake.stop()`. Belt and braces: if a stale registration does deliver, the
delivery is used to kill the registration, and nothing else happens — no pending
press written, no notification posted, **no activity launched**. That last one
is the point, because the activity launch is what pulls this app and (on the
Vivo) other apps to the foreground.

**App.js** keeps one live effect — `useEffect(() => { stopBandWake(); }, [])` —
which is a cleanup, not a feature. It clears the stale registration and the
`armed` flag on a phone updating from a build that had the wake on. It is cheap,
idempotent, and a no-op on a phone that never had it.

---

## What was deliberately *not* changed

- **The native module is still in the build.** `nigehban-bandwake` is still
  linked, its two receivers are still declared in its manifest, and the app
  still requests the scan permissions. Removing any of that is a bigger change
  with its own regression surface, and it buys nothing while the receivers
  return immediately.
- **The firmware is untouched.** No reflash is needed. The band still raises the
  SOS flag in its advertisement and still counts `gSosSeq`; with no filter
  registered anywhere, nothing listens and it costs nothing. **See the two
  sections below** — one on what is now redundant in the `.ino` and why it
  should stay, one on the confirmation buzz, which is the only part worth a
  reflash.
- **Everything merged after `3d5efb9` is untouched** — the Mumbai migration
  fixes, the BLE scan-throttle work, the own-phone SOS notification, the
  responder notifications, and the sign-out push fix. None of them ride on this
  path.

### Is the nRF52 half of `3d5efb9` now redundant?

Asked directly, and worth answering in writing because the obvious move —
"the feature is off, strip the firmware too" — is the wrong one.

**Confirmed dead.** Nothing reads any of this. The app scans on the NUS service
UUID alone ([band.js:706](../nigehban-app/src/band.js#L706)) and has never
looked at the manufacturer field; the only thing that ever did was the scan
filter in `BandWake.kt`, which is no longer registered. So the
`SOS_BEACON_*` defines, `gSosBeacon` / `gSosSeq` / `gSosBeaconAt`, the flag and
seq bytes inside `buildAdvertising()`, the ten-minute expiry in `loop()` and the
clear in `connect_callback()` are all inert. `virtualBand.js` never implemented
the beacon at all, so nothing diverges there either.

**One piece is not dead, and it is not the piece anyone would guess.**
`setSosBeacon()` calls `Advertising.stop()` → `buildAdvertising()` →
`start(0)`, and setup configures `setInterval(32, 244)` with
`setFastTimeout(30)`. Restarting the advertisement therefore **resets the
30-second fast window**, so a disconnected double-press currently puts the band
on 20 ms advertising instead of 152.5 ms for half a minute. That was never the
intent and it is nowhere in the commit message, but with BUG-010 and BUG-015
open it is doing real work: it makes the band markedly easier to find again
immediately after the press. Anyone deleting `setSosBeacon` would silently
lengthen reconnect time after precisely the event where it matters most.

**Recommendation: leave all of it in.** Three reasons, in order of weight:

1. It costs a reflash of every band in the field to remove code that does
   nothing.
2. It is the foundation the fix builds on. BUG-012's band id goes into these
   same manufacturer bytes; removing them now means putting them back later.
3. It would create a third firmware generation. BUG-012's rollout section
   already has to manage a compatibility window between reflashed and
   un-reflashed bands, and "no manufacturer field / 6-byte field / 8-byte
   field" is a worse matrix to reason about than two.

The `addTxPower()` that was dropped to make room is no loss — nothing read that
before the change either, which is why it was the field chosen.

**What is *not* redundant:** the `if (gConnected)` split in `onGesture()`. That
is an independent fix and it stands on its own — before it, both cases buzzed
the four-pulse "sent" pattern and the disconnected one silently dropped the
alert. Keep the split. Its *pattern* is a separate matter, immediately below.

### ⚠ The one thing this leaves in a bad state: the band's confirmation buzz

`3d5efb9` fixed something genuinely bad in the firmware. Before it, an SOS
pressed on a **disconnected** band buzzed the four-pulse "sent" pattern and
*then* called `send()`, which returns early with no link — so a frightened
person felt exactly what they would have felt if it had worked, and nothing left
their wrist. That was the worst thing the firmware did.

The fix made the beacon the real answer and gave it its own honest pattern:

```c
// nigehban_band_nrf52.ino, onGesture()
setSosBeacon(true);
feedback(6, 250, 150);        // slower and longer: "gone the slow way"
```

**With the beacon dead on the phone side, that buzz is a lie again.** The wrist
says "gone the slow way" and nothing is listening for it. It is a *better* lie
than the pre-`3d5efb9` one — it is at least distinguishable from the connected
case — but it is still a confirmation for something that did not happen.

This was **not** fixed here, because it needs a reflash of every band in the
field and the user's decision on what the band should do instead. The two honest
options, for whoever picks this up:

1. **Buzz an error pattern** — something short and unmistakably *not* the "sent"
   confirmation, so the wrist says "this did not go". One line in `onGesture()`.
2. **Leave it**, and treat it as covered by the fact that the app should not be
   in the killed state on the phones that matter.

Nothing in this repo depends on which is chosen. It is recorded here so it is
not discovered by a wearer.

---

## Which bugs this closes, and which it only hides

**Unreachable while the switch is off** — the defect is still in the code, the
path that reaches it is not:

| Bug | Why it can no longer happen |
|---|---|
| BUG-012 | No filter is registered, so no phone is woken by any band. |
| BUG-013 | Nothing writes `KEY_LAST_SEQ`, so nothing can poison it. |
| BUG-014 | Same dedup latch, same reason. |
| BUG-018 (beacon half) | The receiver launches no activity. |

**Reduced but not closed:**

- **BUG-011** — the false `watch_lost` beside a real SOS. Its cause is
  server-side and is completely untouched by this: `/alert` still arms the
  watchdog against a stale `last_beat`. What is gone is the *reported*
  reproduction — an SOS from a killed app. Any other route to "armed, with a
  heartbeat older than `BEAT_LOST_S`, then an alert" reproduces it just as well.
  **Fix it on the server anyway**, on `fix/false-watch-lost-on-sos-wake`; it is a
  one-line change to one `UPDATE`.
- **BUG-018 (the other half)** — the implicit-intent fallback is duplicated, and
  the copy in `nigehban-alarm` is **still live**:
  [NigehbanAlarmModule.kt:433](../nigehban-app/modules/nigehban-alarm/android/src/main/java/com/nigehban/alarm/NigehbanAlarmModule.kt#L433).
  If `getLaunchIntentForPackage` returns null, the fallback is a bare
  `ACTION_MAIN` with no component, no package and no category — an implicit
  intent that matches essentially every launchable activity on the device. That
  path fires on an incoming *family* emergency, which is a live feature on every
  phone. If the Vivo's other-apps behaviour was cause 1 rather than Funtouch's
  wake-up chain, **switching off the beacon does not fix it**, and it is worth
  one `adb logcat -b events` filtered on `am_` during a family SOS to find out.

**Untouched, and now more painful:**

- **BUG-010** and **BUG-015** — the band still does not reliably come back on
  its own, and after an OEM kill nothing is left alive to try. These were always
  the real problem; the beacon was a floor under them, and that floor is now
  gone. BUG-010 is the first thing to fix, and it is a dependency of almost
  everything else in this area.
- **BUG-016** — latent, firmware-side, unchanged. The 31-byte budget pressure
  that the 2-byte band id would have created is deferred with the rest.

---

## Turning it back on

Do **not** just flip the switches. The order matters, and the middle step is the
one that cannot be skipped.

1. **Land BUG-012 and BUG-013 first** — a band id in the advertisement, in the
   scan filter with a full mask, and an address check in the receiver *before*
   `remember()` is called. Branch `fix/beacon-identity-and-dedup`. Without this
   you are turning two Critical bugs back on.
2. **Get the new firmware onto every band in the field.** During the transition,
   register **both** filters — the new layout and the legacy 6-byte one — or a
   phone that updates before its band is reflashed goes silently deaf on the
   emergency path with no error anywhere. Drop the legacy filter only once every
   band is known reflashed. See BUG-012's "Rollout" section.
3. **Then flip, in any order:**
   - `BAND_WAKE_ENABLED = true` in [src/bandWake.js](../nigehban-app/src/bandWake.js)
   - `FEATURE_ENABLED = true` in [BandWake.kt](../nigehban-app/modules/nigehban-bandwake/android/src/main/java/com/nigehban/bandwake/BandWake.kt)
   - uncomment the beacon block in [App.js](../nigehban-app/App.js) (one
     `/* … */` pair, marked `SWITCHED OFF`) and restore the three names to the
     `./src/bandWake` import at the top
   - delete the `useEffect(() => { stopBandWake(); }, [])` cleanup, which exists
     only to undo this switch on upgrading phones
4. **Decide BUG-018 before shipping it**, not after. Its three live outcomes are
   in that entry: keep the launch, keep the wake but post a notification the
   wearer taps, or drop the beacon-to-SOS path for the relink in BUG-015.

There is a fourth path worth pricing at the same time, from BUG-015's closing
note: on API 31+, `CompanionDeviceManager` association with
`CompanionDeviceService.onDeviceAppeared()` is the sanctioned replacement for
this scan. It does not survive a Funtouch `kill -9` either, so it is an upgrade
to the trigger and not a substitute — but if the beacon is being rebuilt anyway,
build it knowing that.

---

## Verifying the switch actually took

Nothing here has been run on a phone. What to check when it is:

1. **Armed state is gone.** With the app open once after the update, then
   `adb shell run-as <pkg> cat shared_prefs/nigehban.bandwake.xml` — `armed`
   should be `false`.
2. **A press with the app killed does nothing.** Swipe the app out of Recents on
   the Vivo, press the band twice. Expected: no notification, no app launch, no
   other apps launching, and **no SOS on the server**. The last one is the
   deliberate cost, not a failure.
3. **A press with the app alive still works.** Same phone, app open or its
   foreground service running, band connected. The SOS must go out over GATT
   exactly as before — this is the path everything now depends on.
4. **A reboot does not bring it back.** Reboot, wait, press the band twice with
   the app killed. Still nothing. This is the check that proves the native
   switch is doing its job, and it is the one most likely to be skipped.
