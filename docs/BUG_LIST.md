# Nigehban — Bug List

Known defects in this project. Newest first. A bug stays here after it is fixed,
with the fix recorded, so the same symptom is not re-diagnosed from scratch six
months later.

**Status key:** `OPEN` · `FIXED` (branch/commit noted) · `WONTFIX` (with reason)

**Verified on device — 1 Sep 2026.** BUG-001, 002, 005, 006, 007 and 009 were
confirmed working on a Samsung running Android 14, against the real band, from
a release APK built on `fix/ble-scan-throttle`. Recorded because "the code is
written" and "the wristband actually reconnects" are different claims, and only
the second one is worth anything on a safety device.

Still open after that pass: BUG-003, BUG-004 (partial), BUG-008, and the
`presentAlarm` failure noted at the end of BUG-009.

---

## BUG-001 — Sign-out leaves the previous account's band paired

**Status:** FIXED on `fix/ble-scan-throttle`
**Severity:** High — cross-account data leak on a safety device
**Area:** [nigehban-app/App.js](nigehban-app/App.js) · [nigehban-app/src/band.js](nigehban-app/src/band.js)

### Symptom

Sign out of one account, sign in as a different user, and the app silently
reconnects to the first user's wristband. Band battery, anti-snatch state and
band events all appear under the new account. Reproduced while migrating
between Supabase regions: an account created in the new database inherited a
band paired by an account in the old one.

### Cause

`signOut` tore down the session, the alert queue and the background watch, but
never touched the BLE link:

```js
const signOut = async () => {
  await stopBackgroundWatch();
  await clearSession();
  await clearQueue();
  dispatch('RESET');
  ...
};
```

`band.disconnect()` is the only thing that calls `forgetBand()`, so the
`nigehban.band.id` key survived sign-out. On the next launch the auto-relink
effect in `useBand` read that id back and connected — the stored id is treated
as a standing "this phone wants that band" instruction, and nothing scoped it
to an account.

The live GATT connection also survived, because it is deliberately
process-scoped rather than tree-scoped.

### Fix

`signOut` now calls `band.disconnect()` first, which drops the link, clears the
retry loop and removes the stored id. In virtual mode `disconnect` is a no-op,
so the call is safe in both modes.

### Note

The band *mode* (`nigehban.bandMode`) is deliberately left alone. It describes
the phone's hardware setup, not the account, and resetting it would drop a
tester back into virtual mode on every sign-out.

---

## BUG-002 — Flat 3s retry drives the app into Android's BLE scan throttle

**Status:** FIXED on `fix/ble-scan-throttle`
**Severity:** High — band becomes unreachable until Bluetooth is toggled by hand
**Area:** [nigehban-app/src/band.js](nigehban-app/src/band.js)

### Symptom

The wristband status on the Setup screen shows, in sequence:

```
error:Undocumented scan throttle (code 2147483646), suggested retry date is Tue Sep 01 00:29:02 GMT+05:00 2026
error:Scan failed because application registration failed (code 6)
```

The band is never found again. Only turning Bluetooth off and on — confirmed
in testing — restores it. Both strings come from RxAndroidBle 1.17.2 (the
Android engine under `react-native-ble-plx`) and are printed raw by the status
line, because neither key exists in the screens' `BAND_LABEL` maps.

Neither error involves Supabase; both are raised by the Android Bluetooth stack
before any network call.

### Cause

Android's `AppScanStats` throttles an app that starts **more than 5 BLE scans
in any 30-second window**, and then silently returns no results.

`retrySoon()` waited a flat `RETRY_MS = 3000` with no backoff and no ceiling,
and every failure path funnelled into it — scan error, 10s scan timeout,
direct-connect failure, and disconnect.

While scans were succeeding this was survivable: a 10s scan plus a 3s wait is
one scan per ~13s. The trap is that **a throttled scan fails immediately
instead of running for 10s**, so the cycle collapsed to ~3s — roughly ten scan
starts per 30 seconds, double the limit that caused the throttle. The app
re-armed the throttle continuously and it could never expire.

`SCAN_FAILED_APPLICATION_REGISTRATION_FAILED` is the second stage: each scan
start registers a scanner client with the Bluetooth stack, Android caps
registrations per app, and the start/stop churn leaked them until registration
failed outright. That state survives app restarts and clears only on an adapter
reset — which is why a Bluetooth toggle fixed it.

### Fix

Five changes, in order of how much they matter:

1. **A hard scan-start gate.** The last 4 scan-start timestamps are kept; a scan
   cannot start unless there is room in the 30s window, and otherwise the
   attempt is rescheduled for when there will be. This makes the throttle
   unreachable from inside the app regardless of what any other path does.
2. **Exponential backoff** in `retrySoon()` — 3s, doubling, reset by a link that
   comes up. Two ceilings: 60s when only a scan can find the band, 15s when a
   remembered id can be connected to directly (that path spends no scan budget,
   and a safety device should not make the wearer wait a minute).
3. **The stack's own timing is honoured.** The throttle error carries a
   suggested retry date; it is parsed and used, falling back to a full 30s
   window when Hermes cannot parse Java's `Date.toString()` format.
4. **Registration failure is its own state** (`bt-stuck`) with a 60s cooldown
   and on-screen instructions to toggle Bluetooth, instead of retrying into a
   stack that will keep refusing.
5. **`ScanMode.LowLatency`** instead of RxAndroidBle's `LowPower` default, whose
   duty cycle gave a 10s scan only about two chances to see an advertisement.
   Finding the band on the first attempt is itself the best throttle defence.

---

## BUG-003 — `lastError` is collected but never displayed

**Status:** OPEN
**Severity:** Low — diagnostics only
**Area:** [nigehban-app/src/band.js](nigehban-app/src/band.js) · [nigehban-app/src/screens/](nigehban-app/src/screens/)

`useBand` maintains a `lastError` state and returns it, with the stated intent
that "whatever went wrong now has somewhere to surface". Nothing renders it —
no screen references `lastError` at all.

So the detail written there is invisible: a failed notify subscribe, a dropped
write, a stale GATT cache, and the Bluetooth guidance added in BUG-002 are all
recorded and then dropped. The user sees only the short status label.

BUG-002 worked around this for its two states by adding inline help text keyed
off `band.status` in `UserSettings`. The general fix is to surface `lastError`
properly — probably one dismissible line under the wristband row on the Setup
screen.

---

## BUG-004 — Not every band status has a human label

**Status:** PARTIALLY FIXED on `fix/ble-scan-throttle`
**Severity:** Low — user-facing polish
**Area:** [nigehban-app/src/screens/Home.js](nigehban-app/src/screens/Home.js) · [nigehban-app/src/screens/user/UserSettings.js](nigehban-app/src/screens/user/UserSettings.js)

Both screens map `band.status` through a `BAND_LABEL` object and fall back to
printing the raw key:

```js
BAND_LABEL[band?.status] || band?.status
```

`band.js` can set `bluetooth-off`, `location-off`, `no-service`, `no-notify`
and `error:<raw library message>`, none of which had entries. That fallback is
how a full RxAndroidBle exception string ended up on screen as a wristband's
status in BUG-002.

Labels were added for every status `band.js` currently sets. Still open: the
`error:` prefix path is unbounded by construction — any new library message
reaches the user verbatim. It should render a fixed "Bluetooth error" label
with the detail routed through `lastError` (BUG-003) instead.

---

## BUG-005 — A live SOS is forgotten when the app is reopened

**Status:** FIXED on `fix/ble-scan-throttle` — responders split out as BUG-008
**Severity:** Critical — the wearer cannot tell whether their emergency is live
**Area:** [nigehban-app/src/state.js](nigehban-app/src/state.js) · [nigehban-app/App.js](nigehban-app/App.js)

### Symptom

Swipe the app out of Recents (the foreground service keeps it running). Double-tap
the band. The SOS **is** sent — the server records it and the family is paged.
Then open the app: it shows the ordinary home screen. No live SOS, no indication
that anything happened, no responders.

Reported on Android 14 / Samsung, and confirmed by the reporter that the alert
itself does go out.

### Cause

The emergency state machine is a plain `useReducer` with no persistence:

```js
const [machine, rawDispatch] = useReducer(reduce, { state: 'idle', context: EMPTY });
```

`context.activeSos` is the only record that an SOS is live, and it exists solely
in the React tree's memory. Swiping the app away destroys the Android activity,
which destroys the tree. Reopening mounts a fresh one at `state: 'idle'`,
`activeSos: null`.

Nothing ever reconstructs it. `raise()` fires `dispatch('SOS_RAISED')` into the
dead tree (a no-op) and the network call still succeeds, so the alert reaches
the server and nothing on the phone remembers it.

There is one partial recovery path — `flushNow()` restores an alert from the
offline queue — but it only fires for alerts that **failed** to send. The
perverse result: a *successfully delivered* SOS is the case that vanishes
without trace, and a failed one is partly recovered. The better the network,
the worse the symptom.

Responders have the same shape of problem. `dispatch('RESPONDER', …)` is only
ever fired by the live socket's `ack` handler, so a family member who responds
while the app is closed is never recorded. The UI to display them is already
built and working — the data simply never arrives.

### Fix

`restoreLiveSos()` in App.js now runs on mount and on every return to the
foreground: it fetches `GET /alerts?scope=mine`, finds the newest unresolved
emergency, and dispatches `SOS_RAISED`. No server change was needed.

The SOS screen required no changes at all — it already renders a live-ticking
timer computed from `alert.created_at` ([SosLive.js:55-69](../nigehban-app/src/screens/user/SosLive.js#L55-L69)),
so reopening ten minutes later correctly shows `10:00` rather than restarting
from zero. The screen was never broken; it was simply never told the alert
existed.

Guarded against clobbering: it returns early if `ctxRef.current.activeSos` is
already set, so it cannot wipe a responder list the socket has been filling in.
A failed lookup is swallowed rather than treated as "no emergency".

### Still open

Restoring **responders** after a reopen — see BUG-008.

Consider also persisting `activeSos` to AsyncStorage as a fallback for a phone
that reopens with no connectivity at all.

---

## BUG-006 — No notification when your own SOS is sent

**Status:** FIXED on `fix/ble-scan-throttle`
**Severity:** High
**Area:** [nigehban-app/src/notifications.js](nigehban-app/src/notifications.js) · [nigehban-app/App.js](nigehban-app/App.js)

Raising an SOS posts no notification to the wearer's own phone. The only
emergency notification the app can produce is `sendEmergencyAlarmNotification`,
which is written for the **family member receiving** someone else's alert
("EMERGENCY SOS — {name}", "Open Nigehban immediately for emergency details").

So with the app closed there is nothing in the shade, nothing on the lock
screen, and — because of BUG-005 — nothing in the app either. The wearer has no
way to confirm the press registered.

### Fix

`showOwnSosNotification()` in notifications.js, called from `raise()` and from
`restoreLiveSos()`. Reads `SOS is active — Sent at 12:29. Your family can see
your location. Tap to open.`

- `sticky: true` (Android's *isOngoing*) so it cannot be swiped away while help
  is still coming, and `autoDismiss: false` so tapping opens the app without
  making the emergency look finished. `clearOwnSosNotification()` from
  `resolve()` is the only thing that takes it down.
- Its own channel, `nigehban_sos_status`, at **LOW** importance — deliberately
  silent. The existing emergency channel is a DND-bypassing siren built to wake
  a family member across town; firing that at the person already holding the
  phone adds nothing and could give away the position of somebody hiding. A
  separate channel also means muting check-ins cannot remove the one indicator
  saying help is coming.

**Confirmed by the reporter:** the phone *does* vibrate on an SOS raised with the
app swiped away. `raise()` reaches `Vibration.vibrate([0, 300, 120, 300])` at
App.js:346 and fires it.

That is the useful diagnostic for this whole group of bugs: the JS runtime,
the band callback and `raise()` all run normally with the activity destroyed.
Only `dispatch()` is inert, because the reducer it targets died with the tree.
So the notification here, the band buzz in BUG-007, and the state restore in
BUG-005 can all be driven from that same code path — no headless task or
native work needed.

---

## BUG-007 — The band gets no confirmation buzz for an SOS

**Status:** FIXED on `fix/ble-scan-throttle`
**Severity:** Medium
**Area:** [nigehban-app/App.js](../nigehban-app/App.js)

The app sends `{c:'checkin_req'}` to the band for check-ins (App.js:759, 773),
but nothing sent a buzz when an SOS was raised. Pressing the button twice
produced no haptic acknowledgement on the wrist — the one confirmation
available without taking the phone out.

### Fix

`raise()` now sends `{c:'buzz', n:3}` to the band for any emergency, through a
`bandRef` (the link is created further down the component than `raise` is
defined, and a buzz is fire-and-forget, so a ref beats a dependency that would
rebuild `raise` on every battery tick).

---

## BUG-008 — Responders are lost if the app was closed when they answered

**Status:** OPEN — needs a server change
**Severity:** Medium
**Area:** [server/nigehban_server.py](../server/nigehban_server.py) · [nigehban-app/App.js](../nigehban-app/App.js)

Split out of BUG-005. `ctx.responders` is only ever filled by the live socket's
`ack` handler (App.js:745-750). A family member who responds while the app is
closed is never recorded, so reopening shows "Waiting for someone to answer"
when somebody is already on their way.

The UI is built and working — [SosLive.js:113-124](../nigehban-app/src/screens/user/SosLive.js#L113-L124)
renders each responder with a "5 min ago" stamp. Only the data is missing.

The data exists server-side: `POST /alert/{id}/ack` does
`INSERT INTO acks VALUES (alert_id, user_id, time)`. But `alert_row()`
([nigehban_server.py:894](../server/nigehban_server.py#L894)) does not return
acks, so `GET /alerts` cannot carry them.

**Fix:** add the ack rows (id, name, at) to `alert_row()`, then have
`restoreLiveSos()` dispatch `RESPONDER` for each one it finds. Deferred here
because it is the only part of this group that touches the server.

---

## BUG-009 — One SOS produces 2–3 notifications, but only while the app is open

**Status:** FIXED on `fix/ble-scan-throttle`
**Severity:** Medium — alarm fatigue on the one notification that must be read
**Area:** [nigehban-app/App.js](../nigehban-app/App.js) · [nigehban-app/src/bgNotifications.js](../nigehban-app/src/bgNotifications.js)

### Symptom

A family member raises one SOS; the receiving phone shows the notification two
or three times. Reported as happening **with the app open**, and *not* when the
app is closed with the screen off — which is the detail that localises it.

### Cause

One severity-5 alert legitimately travels three ways: a visible Expo push, a
silent data push (`sev >= 4`) that wakes the background task, and a websocket
`alert` frame. The redundancy is deliberate — Android may drop the silent push
in Doze, so the visible one is the guaranteed floor.

Two of those three paths already behave. `notifyIfNothingShown()`
(bgNotifications.js:135-147) calls `getPresentedNotificationsAsync()` and skips
posting when a notification carrying the same `alert_id` is already on screen.

The websocket path does not:

```js
presentAlarm(a).then((took) => {
  if (!took) sendEmergencyAlarmNotification(a);   // no check of what is already shown
});
```

The socket only delivers while the app is running, which is precisely why the
duplicates appear when the app is open and not when it is killed.

A secondary finding: this path only posts at all when `presentAlarm()` returns
false. That it is posting means the native full-screen alarm module is absent
from the build or throwing on that device — worth investigating separately,
since the lock-screen takeover is supposed to be the primary signal.

### Fix

`notifyIfNothingShown` was lifted out of bgNotifications.js into
notifications.js as the exported `sendEmergencyAlarmIfNothingShown()`, and both
paths now go through it — the background task and the websocket handler in
App.js. One helper, one rule, used everywhere an emergency notification is
posted.

This will not guarantee exactly one notification, and should not try to: the
two pushes arrive independently, so the presented-notifications check can lose
a race. That bias is intentional and already documented at
bgNotifications.js:130-133 — when it cannot be known, a duplicate is preferred
over a silence. The fix turns the common case into one and the worst case into
two, rather than two into three.

### Rejected

Having the server skip the visible push for family members currently connected
on the websocket (`HUB.online(t)`). It would cut a push, but socket-connected
does not mean the person will see anything, and trading a guaranteed floor for
tidiness is the wrong direction on a safety device.
