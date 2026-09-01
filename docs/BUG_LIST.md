# Nigehban — Bug List

Known defects in this project. Newest last, so a bug's number and its place in
the file agree. A bug stays here after it is fixed, with the fix recorded, so
the same symptom is not re-diagnosed from scratch six months later.

**Status key:** `OPEN` · `FIXED` (branch/commit noted) · `DEFERRED` (recorded,
not being worked on, with the decision written down) · `WONTFIX` (with reason)

**Verified on device — 1 Sep 2026.** BUG-001, 002, 005, 006, 007 and 009 were
confirmed working on a Samsung running Android 14, against the real band, from
a release APK built on `fix/ble-scan-throttle`. Recorded because "the code is
written" and "the wristband actually reconnects" are different claims, and only
the second one is worth anything on a safety device.

Still open after that pass: BUG-003, BUG-004 (partial), BUG-008, and the
`presentAlarm` failure noted at the end of BUG-009.

**Since then:** BUG-008 was fixed on `fix/responder-notifications`. It has not
had a device pass, and the paragraph above is exactly why that is worth saying
out loud: the new notification cannot be called done until a real phone, with
the app force-stopped and the screen off, has been seen to show it.

BUG-010 was reported after that pass and is open. It is the reason the pass
above could read green on BUG-002 while the band still fails to come back on
its own: the device testing was done with the screen on.

BUG-017 was fixed on `fix/stop-push-after-signout`. Its server half is verified
against the real database — the handset provably stops being a delivery target,
and provably becomes one again on the next sign-in. Its app half has not been
run on a phone at all, which leaves it in the same position as BUG-008.

**The band's beacon wake was switched off on 1 Sep 2026.** Not reverted —
switched off behind two booleans, with the code left in place. That makes four
entries here **STALE**: BUG-012, BUG-013, BUG-014 and the beacon half of
BUG-018 describe defects that are still in the code but sit behind a path
nothing can now reach. They are not fixed, they are unreachable, and they come
back the moment the feature does. The decision, the cost and the order things
have to be done in to turn it back on are in
[BAND_WAKE_DISABLED.md](BAND_WAKE_DISABLED.md).

Two things not to misread from that. **BUG-011 is not stale** — its cause is
server-side, the switch only removed the reported reproduction, and it should
still be fixed. And **BUG-010 gets worse, not better**: its severity note used
to soften itself by pointing at the beacon as the emergency path's floor, and
that floor is gone.

---

## Summary

**18 filed — 8 fixed, 1 partial, 9 open.** Three of the open ones (012, 013,
014) and half of a fourth (018) are **stale**: still in the code, no longer
reachable, because the feature that reached them was switched off. Titles only;
the entry below each row carries the symptom, the cause and the reasoning.

| # | Bug | Severity | Status |
|---|---|---|---|
| 001 | Sign-out leaves the previous account's band paired | High | ✅ Fixed · device-verified |
| 002 | Flat 3s retry drives the app into Android's BLE scan throttle | High | ✅ Fixed · device-verified |
| 003 | `lastError` is collected but never displayed | Low | ⬜ Open |
| 004 | Not every band status has a human label | Low | 🟨 Partial — labels added, `error:` path still raw |
| 005 | A live SOS is forgotten when the app is reopened | Critical | ✅ Fixed · device-verified |
| 006 | No notification when your own SOS is sent | High | ✅ Fixed · device-verified |
| 007 | The band gets no confirmation buzz for an SOS | Medium | ✅ Fixed · device-verified |
| 008 | Responders are lost if the app was closed when they answered | Medium | ✅ Fixed — **not device-verified** |
| 009 | One SOS produces 2–3 notifications while the app is open | Medium | ✅ Fixed · device-verified — `presentAlarm` finding still open |
| 010 | The band only reconnects while the screen is on | High — **raised**, see entry | ⬜ Open |
| 011 | Every SOS from a killed app also raises a false `watch_lost` | High | ⬜ Open — repro removed, cause not |
| 012 | Any band's SOS beacon fires on every Nigehban phone in range | Critical | 💤 Stale — beacon wake switched off |
| 013 | A stranger's press silently discards your own band's SOS | Critical | 💤 Stale — beacon wake switched off |
| 014 | A band reboot can discard the next real press | High | 💤 Stale — beacon wake switched off |
| 015 | Nothing restores the band link after the app is killed | High | ⬜ Open |
| 016 | Advertising fields fail silently when they no longer fit | Low now, High on the next field | ⬜ Open · latent |
| 017 | Sign-out leaves the handset receiving the old account's alerts | High | ✅ Fixed — **untested in the app** |
| 018 | Beacon wake opens the app for an SOS — and other apps on one phone | Low · one handset | 💤 Stale in the beacon · ⬜ open in `nigehban-alarm` |

**Key:** ✅ fixed · 🟨 partially fixed · ⬜ open · 🟦 deferred by decision ·
💤 **stale** — the defect is still in the code, but the feature that reached it
is switched off, so nothing can currently trigger it.

"Device-verified" means the 1 Sep 2026 pass saw it working on a real phone
against the real band; a fix without it is written but unproven, and on a
safety device those are not the same claim. "Deferred" means the decision not
to work on it is itself recorded, in the entry, with the reasoning.

**Stale is not fixed, and the distinction matters here more than usual.** Every
line of BUG-012, BUG-013 and BUG-014 is still in the tree, correct as written,
and will describe live behaviour again on the day the two booleans in
[BAND_WAKE_DISABLED.md](BAND_WAKE_DISABLED.md) go back to `true`. They stay in
this file at full detail for exactly that reason — the work to close them is the
precondition for turning the feature back on, not something that stopped being
needed.

Three rows are worth reading twice. **008** and **017** are both fixed with the
same gap: in each case the unverified half is the behaviour of a phone that is
not running the app, which is the case each of them exists for. **017**'s server
side is now proven against the real database; its app side has not been run.
**009** is fixed, but its secondary finding is not: the native full-screen
alarm module appears to be missing or throwing on the test device, which is
why the fallback notification was posting at all.

The open list splits into three groups. The beacon cluster — **012**, **013**,
**014**, **016** — is one branch, `fix/beacon-identity-and-dedup`, and two of
those are Critical; three of the four are now stale, and that branch has become
the *precondition for turning the feature back on* rather than a fix to
schedule. The background-timer cluster — **010** then **015** — is strictly
ordered, because 015 cannot work until 010 has replaced the JS timer, and it is
now the only thing standing between a wearer and a dead band on an OEM that
kills the app. The rest — **003**, **004**, **011** — stand alone. **018** is
half stale and half live, and the live half is in a different module.

**What to do next, given the switch-off.** BUG-010 is first, and by some
distance: it was already the highest-value item, and removing the beacon took
away the one thing that made its severity note read tolerably. BUG-011 is next
and is cheap — one line in one `UPDATE`, on the server, entirely independent of
any of this. The beacon cluster comes back when, and only when, somebody is
ready to reflash every band in the field.

*(File order note: BUG-010 was written up after BUG-016 and physically sits at
the end of the file, ahead of BUG-017 and BUG-018. The numbering above is
the index.)*

---

## BUG-001 — Sign-out leaves the previous account's band paired

**Status:** FIXED on `fix/ble-scan-throttle`
**Severity:** High — cross-account data leak on a safety device
**Area:** [nigehban-app/App.js](../nigehban-app/App.js) · [nigehban-app/src/band.js](../nigehban-app/src/band.js)

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
**Area:** [nigehban-app/src/band.js](../nigehban-app/src/band.js)

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
**Area:** [nigehban-app/src/band.js](../nigehban-app/src/band.js) · [nigehban-app/src/screens/](../nigehban-app/src/screens/)

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
**Area:** [nigehban-app/src/screens/Home.js](../nigehban-app/src/screens/Home.js) · [nigehban-app/src/screens/user/UserSettings.js](../nigehban-app/src/screens/user/UserSettings.js)

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
**Area:** [nigehban-app/src/state.js](../nigehban-app/src/state.js) · [nigehban-app/App.js](../nigehban-app/App.js)

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
**Area:** [nigehban-app/src/notifications.js](../nigehban-app/src/notifications.js) · [nigehban-app/App.js](../nigehban-app/App.js)

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

**Status:** FIXED on `fix/responder-notifications` — not yet device-verified
**Severity:** Medium
**Area:** [server/nigehban_server.py](../server/nigehban_server.py) · [nigehban-app/App.js](../nigehban-app/App.js) · [nigehban-app/src/state.js](../nigehban-app/src/state.js) · [nigehban-app/src/notifications.js](../nigehban-app/src/notifications.js)

### Symptom

Split out of BUG-005. `ctx.responders` is only ever filled by the live socket's
`ack` handler (App.js:745-750). A family member who responds while the app is
closed is never recorded, so reopening shows "Waiting for someone to answer"
when somebody is already on their way.

The UI is built and working — [SosLive.js:113-124](../nigehban-app/src/screens/user/SosLive.js#L113-L124)
renders each responder with a "5 min ago" stamp. Only the data is missing.

The data exists server-side: `POST /alert/{id}/ack` does
`INSERT INTO acks VALUES (alert_id, user_id, time)`. But `alert_row()`
does not return acks, so `GET /alerts` cannot carry them.

### Cause

One delivery path, and it is the one that is down in every case worth caring
about. The socket only exists while the app is running, and on Android the app
is routinely killed the moment it leaves the foreground. So the answer to an
emergency was recorded in the database and reached the wearer nowhere: not as a
notification while it happened, and not on screen afterwards, because nothing
ever read the row back.

### Fix

Two holes, because the original entry only described the second one. Telling the
wearer *afterwards* is not the same as telling them *when it happens*, and on a
safety device the second is the one that matters.

**1. Told when it happens.** `notify_owner_of_ack()` pushes a visible
notification to the wearer when someone answers — from both `/alert/{id}/ack`
and `/samaritan/{id}/respond`. A visible Expo push is the only delivery path
that survives a terminated app, which is the case this exists for. Detached via
`_spawn`, so the responder's "I'm on it" tap does not wait on a 5 s Expo call.
Deduplicated with `INSERT … ON CONFLICT DO NOTHING RETURNING`, so a double tap
does not claim a second person is coming.

**2. Told again on reopening.** `acks_for()` fetches every alert's responders in
one query, `alert_row()` carries them, and `SOS_RAISED` seeds `ctx.responders`
from them instead of blanking the list. `restoreLiveSos()` needed no new loop —
the row it already fetches now carries the answer with it.

Three details that are not obvious:

- **`restoreLiveSos` no longer returns early when an SOS is already known.** It
  now tops up the responder list for the same alert id. That covers the case
  the socket cannot: the app backgrounded rather than killed, its websocket
  quietly dead, someone answering in the meantime. It still refuses to touch a
  queued offline alert, which the flush owns.
- **The ack time comes from the server**, both in the socket frame and in the
  row. The app used to stamp `Date.now()` on arrival, so a responder from ten
  minutes ago redrew as "just now".
- **`RESPONDER` merges by id**, so the socket frame and the restored row
  describe the same person once.

### Deliberately not done

- **No band buzz.** On the wrist a vibration already means "someone is checking
  on you — press the button to answer". A person in the middle of an emergency
  must not be handed a button to press, and a buzz that means two things makes
  both unreliable.
- **No sound.** The new `nigehban_sos_responder` channel is DEFAULT importance
  with `sound: null` and a vibration pattern: felt by one person, not heard by
  the room. Same reasoning as BUG-006 — the wearer may be hiding from whoever
  they pressed the button about. This needed `channel`, `ttl` and `sound`
  overrides on `send_expo_push_notifications`, whose defaults are derived from
  severity and would otherwise have filed this on the DND-bypassing siren
  channel. `severity` in the payload is deliberately 1: the app fires the
  full-screen takeover at 4 and up.
- Android channels are immutable after creation (only name and description can
  change), so revisiting the sound decision means a new channel id.

### Verification

`tests/test_responder_restore.py` covers the read-back path with no socket
connected for the ward at all — which is the bug. The push itself is not
asserted there; it leaves the process through Expo and needs a real device
token. **That is the part still needing a device pass:** force-stop the app,
screen off, have a family member answer, confirm the notification arrives,
vibrates, and makes no sound.

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

---

## BUG-011 — Every SOS from a killed app also raises a false `watch_lost`

**Status:** OPEN — **still open, and deliberately not marked stale.** The beacon
wake being switched off on 1 Sep 2026
([BAND_WAKE_DISABLED.md](BAND_WAKE_DISABLED.md)) removed the *reproduction*
below, because an SOS can no longer be raised from a killed app at all. It
removed nothing of the cause. See "Why this is not stale" at the end.
**Severity:** High — a contradictory alert lands on the family beside a real emergency
**Area:** [server/nigehban_server.py](../server/nigehban_server.py)

### Symptom

Server log from a Vivo with the app swiped out of Recents and the band pressed
twice:

```
Moax-vivo (NGB-MHEF) went offline
  [sos] from Moax-vivo (NGB-MHEF) -> 3 family member(s), 0 online
  [expo push/visible] 5/5 accepted by Expo
  [watch_lost] from Moax-vivo (NGB-MHEF) -> 3 family member(s), 0 online
  [expo push/silent] 5/5 accepted by Expo
  [expo push/visible] 5/5 accepted by Expo
  Moax-vivo (NGB-MHEF) came online
```

The SOS is correct — the beacon path worked. The `watch_lost` immediately after
it is not. It tells the family "the phone lost signal, was switched off, or the
app was stopped", with a pin from before the press, at the exact moment the
wearer is calling for help. It contradicts the alert sitting next to it, and it
arrives while the phone is provably reachable.

### Cause

The heartbeat watchdog fires on three conditions
([nigehban_server.py:1757-1759](../server/nigehban_server.py#L1757-L1759)):

```
mode != 'idle'  AND  lost_notified = FALSE  AND  last_beat < now - BEAT_LOST_S
```

`last_beat` is written by `/heartbeat` and by nothing else. While the app was
killed it froze, but `mode` was `idle`, so the watchdog stayed quiet — correct
behaviour, and the reason no alert fired during the minutes the phone sat dead.

Then the press arrives and `/alert` arms the mode without touching anything else
([nigehban_server.py:1103-1107](../server/nigehban_server.py#L1103-L1107)):

```python
if b.kind == "sos":
    with closing(db()) as c:
        watch_row(c, u["id"])
        c.execute("UPDATE watch_state SET mode='sos' WHERE user_id=%s", (u["id"],))
        c.commit()
```

That one write arms the watchdog **retroactively**, against a heartbeat minutes
older than the wake that produced the SOS. The next sweep — at most
`SWEEP_TICK_S` later — sees armed, silent, not yet notified, and escalates.

`emit_alert()` ([nigehban_server.py:934](../server/nigehban_server.py#L934))
never touches `watch_state`, so no alert path anywhere refreshes liveness. The
one request that proves the phone is alive *right now* is the only one the
server declines to count as proof.

### Why it will look intermittent

`useHeartbeat` beats immediately on arming
([watch.js:136](../nigehban-app/src/watch.js#L136)), so the woken app's first
`/heartbeat` races the 5s sweep. Some runs the beat lands first and no
`watch_lost` appears. A clean run is not evidence the bug is gone, and this is
why it must be closed at the server rather than by reordering the client.

### Planned fix

Branch `fix/false-watch-lost-on-sos-wake`. Stamp liveness in the same statement
that arms the mode:

```python
c.execute("UPDATE watch_state SET mode='sos', last_beat=%s, lost_notified=FALSE "
          "WHERE user_id=%s", (now, u["id"]))
```

Worth settling at the same time whether *any* authenticated `/alert` should
refresh `last_beat`. It is as strong a liveness signal as a heartbeat — the
phone demonstrably reached the server — and that holds even for a queued alert
flushed late, where the event is old but the connection is current.

### Rejected

Making the app send a heartbeat before it raises. It would win the race most of
the time, and it buys that by delaying a real SOS in order to suppress a
cosmetic alert. Wrong trade on a safety device, and it leaves the race intact.

### Why this is not stale

The reporter's account attributes this bug to the beacon wake, and the logcat
above is indeed a beacon SOS. But the beacon is only how the request *arrived*.
The defect is one `UPDATE` in `/alert` that arms the watchdog against a
heartbeat it does not refresh, and every ingredient of it is server-side:

```
mode was 'idle'  +  last_beat is older than BEAT_LOST_S  +  an /alert arrives
```

Nothing in that requires a killed app or a beacon. Any gap in heartbeating long
enough to age `last_beat` past `BEAT_LOST_S`, followed by an SOS, reproduces it
— and BUG-010's collateral section documents exactly such a gap in the ordinary
case: `useHeartbeat` posts on a `setInterval`, and RN stops those whenever the
Activity is paused, which is every time the screen goes off. A phone in a
pocket for ten minutes and then a press on a *connected* band is the same three
ingredients with no beacon anywhere near it.

So: the switch-off makes this much harder to see, which is worse rather than
better — a High-severity contradictory alert that now only shows up
occasionally is one that gets shrugged off. Fix it on the server as planned.
The change is one line, it has no dependency on any of the band work, and it is
the cheapest item left on this list.

---

## BUG-012 — Any band's SOS beacon fires on every Nigehban phone in range

**Status:** STALE — the defect is unchanged and still in the code; the beacon
wake that reaches it was switched off on 1 Sep 2026
([BAND_WAKE_DISABLED.md](BAND_WAKE_DISABLED.md)), so no phone currently
registers a filter and no phone can be woken by any band. **This is the reason
the feature was switched off**, and closing it is the precondition for turning
the feature back on — not optional work that went away.
**Severity:** Critical — an emergency is raised on the wrong account, to the wrong family
**Area:** [BandWake.kt](../nigehban-app/modules/nigehban-bandwake/android/src/main/java/com/nigehban/bandwake/BandWake.kt) · [BandWakeReceiver.kt](../nigehban-app/modules/nigehban-bandwake/android/src/main/java/com/nigehban/bandwake/BandWakeReceiver.kt) · [nigehban_band_nrf52.ino](../nigehban_band_nrf52/nigehban_band_nrf52.ino)

### Symptom

Two wearers in one room, both apps killed, so both are on the beacon path. One
presses. **Both** phones wake. The second raises an SOS on its own owner's
account, with its own owner's GPS, to its own owner's family — who are paged
about an emergency that is not happening to the person they were told about,
and who are given a location that is merely wherever that second phone is.

Cannot be reproduced with one phone and one band. That is why the feature
looked finished.

### Cause

The registered scan filter carries no band identity at all
([BandWake.kt:141-149](../nigehban-app/modules/nigehban-bandwake/android/src/main/java/com/nigehban/bandwake/BandWake.kt#L141-L149)):

```kotlin
val data = byteArrayOf(MAGIC_0, MAGIC_1, FLAG_SOS)          // 'N','G',0x01
val mask = byteArrayOf(0xFF.toByte(), 0xFF.toByte(), 0xFF.toByte())
```

`'N' 'G'` separates a Nigehban band from the rest of company id `FFFF` — the
SIG's "testing" value, which any unbadged beacon in the world may use. It does
not separate one Nigehban band from another. Every band advertises a byte-identical
pattern, so every phone's filter matches every band.

The receiver already holds the information that would settle it and does not use
it: `result.device?.address` is read and stored
([BandWakeReceiver.kt:97](../nigehban-app/modules/nigehban-bandwake/android/src/main/java/com/nigehban/bandwake/BandWakeReceiver.kt#L97))
only to populate the diagnostics screen. It is never compared against the band
this phone is actually paired to, even though that MAC is already on disk as
`nigehban.band.id` ([band.js:33](../nigehban-app/src/band.js#L33),
[band.js:394](../nigehban-app/src/band.js#L394)).

### Planned fix

Branch `fix/beacon-identity-and-dedup`. Two layers, because they solve different
halves:

1. **In the controller** — a 2-byte band id in the advertisement, included in the
   scan filter with a full mask. This is what stops the phone being *woken* at
   all, which matters because the filter is the only thing standing between an
   armed phone and a constant stream of broadcasts.
2. **In the receiver** — compare `device.address` with the stored MAC and drop
   anything else **before** `remember()` is called, so a foreign band can never
   write to this phone's dedup state (see BUG-013).

The band id is the low 2 bytes of the band's own BLE address. The firmware reads
it from its own stack; the app derives the identical bytes from the MAC already
in `LINK_KEY`. No new pairing step, no new UART message, and the address check in
layer 2 becomes a confirmation of the same fact rather than a second source of
truth.

`startBandWake()` ([bandWake.js:37](../nigehban-app/src/bandWake.js#L37)) has to
start taking the address, and the arm effect
([App.js:570-581](../nigehban-app/App.js#L570-L581)) has to re-arm whenever the
remembered band changes.

### Rejected

`ScanFilter.setDeviceAddress(mac)`, which would need no firmware change. The
typed overload that can express a random address is API 31+; below it the
single-argument version assumes a **public** address in the offloaded filter
path, and the nRF52 advertises a static random one. On the Android 8 Vivo that
is a filter which silently matches nothing with the screen off — the same class
of failure as the `FLAG_IMMUTABLE` trap already documented in BandWake.kt, and
the same reason it would be missed.

### Rollout

The fix creates a compatibility window: a phone that updates before its band is
reflashed has a filter expecting an id from a band that does not send one, and
goes silently deaf on the emergency path with no error anywhere. Register **both**
filters during the transition — the 8-byte layout and the legacy 6-byte one —
and drop the legacy filter only once every band in the field is known reflashed.
This has to be decided before the firmware is written, not after.

---

## BUG-013 — A stranger's press silently discards your own band's SOS

**Status:** STALE — unchanged in the code, unreachable while the beacon wake is
switched off ([BAND_WAKE_DISABLED.md](BAND_WAKE_DISABLED.md)). Nothing writes
`KEY_LAST_SEQ` any more, so nothing can poison it. The other half of the reason
the feature was switched off; closing it is a precondition for turning it back
on.
**Severity:** Critical — a real emergency is dropped with no trace on either side
**Area:** [BandWakeReceiver.kt](../nigehban-app/modules/nigehban-bandwake/android/src/main/java/com/nigehban/bandwake/BandWakeReceiver.kt) · [BandWake.kt](../nigehban-app/modules/nigehban-bandwake/android/src/main/java/com/nigehban/bandwake/BandWake.kt)

### Symptom

The dangerous half of BUG-012, and worth its own entry because the direction is
reversed: there, a phone raises an alert it should not have; here, a phone
**refuses** one it should have raised.

Two wearers in one room, both apps killed. A presses first. B then presses their
own band, and nothing happens. No notification, no pending record, nothing
written down for the next launch to find. B's emergency is gone, and neither
phone shows an error.

### Cause

Dedup is a single global integer per phone, checked before anything else
([BandWakeReceiver.kt:91-99](../nigehban-app/modules/nigehban-bandwake/android/src/main/java/com/nigehban/bandwake/BandWakeReceiver.kt#L91-L99)):

```kotlin
val seq = BandWake.sosSeq(result) ?: continue
if (BandWake.isDuplicate(app, seq)) continue
BandWake.remember(app, seq, result.device?.address, result.rssi)
```

`isDuplicate` compares against `KEY_LAST_SEQ`, one value for the whole phone with
no notion of which band it came from
([BandWake.kt:282-283](../nigehban-app/modules/nigehban-bandwake/android/src/main/java/com/nigehban/bandwake/BandWake.kt#L282-L283)).

Sequence numbers are per-band and start at zero
([nigehban_band_nrf52.ino:132](../nigehban_band_nrf52/nigehban_band_nrf52.ino#L132)),
incremented on each press
([nigehban_band_nrf52.ino:566](../nigehban_band_nrf52/nigehban_band_nrf52.ino#L566)).
So **every band's first press is seq 1**. A's press makes B's phone store
`lastSeq = 1`; B's own press is also seq 1 and is discarded as a repeat of an
emergency B never had.

The counters are independent, so the collision is not a rare coincidence — with
freshly powered bands it is the expected case.

### Planned fix

Branch `fix/beacon-identity-and-dedup`, alongside BUG-012.

Dropping foreign addresses before `remember()` is what actually closes this: a
band that is not ours can then never write to `lastSeq`. On top of that, replace
the equality latch with a key of `(address, seq)` bounded by the beacon window
— the band holds the flag up for `SOS_BEACON_MS` (10 minutes), so a repeat
within that window is the same emergency still going and a repeat after it is a
new press. That framing also fixes BUG-014.

The ordering matters and should be called out in the code: the duplicate check
must come **after** the identity check, not before it. Leaving it first is what
lets a stranger poison the state.

---

## BUG-014 — A band reboot can discard the next real press

**Status:** STALE — same latch as BUG-013, same reason: the beacon wake is
switched off ([BAND_WAKE_DISABLED.md](BAND_WAKE_DISABLED.md)) and the dedup
state is never written. Worth keeping in mind that this one **reproduced on the
bench with a single band**, so it is the entry most likely to reappear the
moment anybody re-enables the feature to try it out.
**Severity:** High — reproduces with one phone and one band, on the bench
**Area:** [BandWake.kt](../nigehban-app/modules/nigehban-bandwake/android/src/main/java/com/nigehban/bandwake/BandWake.kt) · [nigehban_band_nrf52.ino](../nigehban_band_nrf52/nigehban_band_nrf52.ino)

### Symptom

No strangers involved. Flash the band, press once — it works, and the phone
stores `lastSeq = 1`. Reflash or pull the battery, press once again — nothing
happens.

Expected to be misread as "the PendingIntent scan is flaky", because that is
exactly what it looks like from the outside.

### Cause

The same latch as BUG-013, seen from the other side. `gSosSeq` is a plain
`uint8_t` in RAM and resets to 0 on every band power-cycle, while `KEY_LAST_SEQ`
lives in SharedPreferences and survives indefinitely. After a reboot the band's
first press is seq 1 again; if the phone's stored value is still 1, the press is
read as a duplicate.

An equality latch can only ever answer "is this the same number", which is not
the question. The question is "is this the same emergency", and the two stop
agreeing the moment the counter restarts.

### Planned fix

Covered by the `(address, seq)` key bounded by the beacon window described in
BUG-013. Time-bounding is the part that fixes this one: past
`SOS_BEACON_MS` the flag is down, so a repeated sequence number is a new press
by definition and there is nothing left to dedup against.

---

## BUG-015 — Nothing restores the band link after the app is killed

**Status:** OPEN — **and now the only thing covering this case.** The beacon
wake was switched off on 1 Sep 2026
([BAND_WAKE_DISABLED.md](BAND_WAKE_DISABLED.md)), so the fake-linked state
described here is no longer merely a state the wearer is *unaware* of: it is
now a state in which a press reaches nobody at all. Everything below still
applies; the closing note about the beacon remaining as a floor no longer does.
**Severity:** High — the wearer walks around in the fake-linked state the beacon was built to escape
**Area:** [BandWake.kt](../nigehban-app/modules/nigehban-bandwake/android/src/main/java/com/nigehban/bandwake/BandWake.kt) · [App.js](../nigehban-app/App.js) · [bgService.js](../nigehban-app/src/bgService.js)

### Symptom

A Vivo, Oppo, Xiaomi, Huawei or Transsion phone runs `kill -9` on a Recents
swipe, and the GATT link dies with the process. The band goes back to
advertising and keeps it up forever
([nigehban_band_nrf52.ino:699-703](../nigehban_band_nrf52/nigehban_band_nrf52.ino#L699-L703)
— `restartOnDisconnect(true)`, `start(0)`, 152.5 ms once the fast window
expires). The phone never hears it.

The wearer is carrying a band that looks linked, is not, and will only be heard
from again through the beacon path.

### Cause

The flag byte is inside the filter mask
([BandWake.kt:142](../nigehban-app/modules/nigehban-bandwake/android/src/main/java/com/nigehban/bandwake/BandWake.kt#L142)),
which is deliberate and correct for the SOS scan: it is what makes being armed
free, because an idle band never matches and the CPU is never woken. The
consequence is that an **idle** band cannot wake the phone either.

`BandWakeBootReceiver` re-arms the registered scan after a reboot or a Bluetooth
toggle, but re-arming a scan is not reconnecting a link — it restores the
listener, not the GATT connection. Nothing else is alive to try: the foreground
service died with the process.

So after a kill the phone stays deaf until the wearer manually opens the app,
reboots, or has an emergency. **The system's only self-heal trigger is the one
event it must not be relied upon during**, and the fake-linked window lasts as
long as nobody happens to open the app.

### Not the same as BUG-010

They present identically — "the band does not come back" — and they are
different failures at different layers:

| | BUG-010 | BUG-015 |
|---|---|---|
| Process | alive | killed |
| Retry loop | exists, frozen by `onHostPause` | does not exist |
| Recovers on | screen on / app to foreground | nothing |

BUG-010 is a timer that never fires. This is a phone with nothing left to fire
it. A Samsung shows BUG-010; a Vivo shows both, because it kills the process
outright.

### Planned fix

Branch `feat/band-relink-ping`. Two hard dependencies, in this order:

1. **BUG-010 must land first.** This fix wakes the process and starts a
   foreground service — which leaves the Activity paused, which is precisely the
   state in which `retrySoon()`'s `setTimeout` does not fire
   ([band.js:160](../nigehban-app/src/band.js#L160)). Waking a process whose
   reconnect timer is frozen buys nothing. Whatever replaces `setTimeout` for
   BUG-010 is the mechanism this bug then depends on, so the two fixes share a
   foundation and BUG-010 owns it.
2. **BUG-012 must land second.** An idle-beacon filter with no band id in it
   would wake this phone several times a second for every band in range.

- A **second** registered scan — own request code, own receiver action — with the
  filter matching magic + band id + flag `0x00`.
- `CALLBACK_TYPE_FIRST_MATCH` with `MATCH_MODE_STICKY`, so it fires when the band
  arrives rather than on all ~6.5 advertisements per second. Gate on
  `isOffloadedFilteringSupported()` and fall back to `ALL_MATCHES` plus a
  software rate limit — that fallback is likely to be the live path on the
  Android 8 Vivo.
- On wake, start the **existing** foreground service and let the normal reconnect
  run — on BUG-010's timer, not on `setTimeout`. `LINK_KEY` already makes a cold
  start re-link with nothing pressed, so there is nothing new to write; a second
  GATT implementation in Kotlin would be the emergency-only code path this module
  was explicitly built to avoid.
- Rate limit hard: one attempt per N minutes, never while already connected, and
  disarm on the same `wantsBand()` gate as the SOS scan
  ([App.js:570-581](../nigehban-app/App.js#L570-L581)) so an explicit DISCONNECT
  still lets the app die for good and stay dead.

The open implementation question, and the thing to prototype before committing to
the rest: the reconnect logic is JavaScript and the receiver has no JS context,
so something has to bring the RN runtime up headlessly from that service.

### Note — **partly overtaken by the switch-off**

This was written while the beacon existed, and said: this does **not** replace
the SOS beacon, and the two must not be merged. At the moment of an emergency
there is no time to wait on a reconnect that may not succeed — a snatch is
precisely the case where phone and band are moving apart, so it is when a relink
is least likely and an alert most needed. This shortens the window during which
the wearer is unknowingly unprotected; the beacon remains the thing that works
when the window is still open.

**The argument is still correct and the beacon is no longer there.** With the
wake switched off, this relink is not a complement to a working emergency path —
it is the whole of it. That does not make it a sufficient answer; it makes it an
insufficient answer that is currently the only one on offer, which is worth
being clear-eyed about before treating BUG-015 as closing the gap. If the
beacon comes back (BUG-012 and BUG-013 first, then the band-id firmware), this
paragraph reverts to its original meaning and the two paths should compose
exactly as described above.

On Android 12+ starting a foreground service from the background is blocked, and
a BLE scan broadcast is not on the exemption list. `CompanionDeviceManager`
association is the sanctioned way through, and on API 31+ its
`CompanionDeviceService.onDeviceAppeared()` would replace this scan entirely.
Tracked separately as future work on `feat/companion-device-association`; it is
an upgrade to the trigger, not a substitute for the scan, since CDM does not
survive a Funtouch `kill -9` either.

---

## BUG-016 — Advertising fields fail silently when they no longer fit

**Status:** OPEN — latent, and **not** stale. This one is firmware-side and the
firmware was not touched by the beacon switch-off
([BAND_WAKE_DISABLED.md](BAND_WAKE_DISABLED.md)): the band still builds the same
29-byte advertisement and still discards the return values. What the switch-off
defers is the *pressure* — the 2-byte band id from BUG-012 that would have taken
it to exactly 31 of 31 is not being added right now. So the margin is unchanged
and the trap is unchanged; only the next thing that would have sprung it has
moved.
**Severity:** Low today, High the moment anyone adds a field
**Area:** [nigehban_band_nrf52.ino](../nigehban_band_nrf52/nigehban_band_nrf52.ino)

### Symptom

None yet. Recorded because the failure it sets up is invisible: the band would
advertise without a field the phone's filter requires, the scan would match
nothing, and every layer would report itself healthy.

### Cause

`buildAdvertising()`
([nigehban_band_nrf52.ino:537-549](../nigehban_band_nrf52/nigehban_band_nrf52.ino#L537-L549))
discards the bool returned by `addFlags`, `addService` and
`addManufacturerData`. A field that does not fit in the 31-byte budget is not an
error — it is simply absent.

There is no margin left to absorb that. The budget is currently 29 of 31
([nigehban_band_nrf52.ino:522-531](../nigehban_band_nrf52/nigehban_band_nrf52.ino#L522-L531)):
3 for flags, 18 for the 128-bit NUS UUID, 8 for the manufacturer field. Every AD
structure pays 2 bytes of header — one length, one type — before any of its data,
which is why 6 bytes of manufacturer payload cost 8 on the wire. The 2-byte band
id from BUG-012 takes it to exactly 31 of 31.

### Planned fix

Check the return values and fail loudly on the serial log at boot, as part of
`fix/beacon-identity-and-dedup`. A wristband that cannot advertise correctly
should say so on the one channel available while it is on a bench.

Optionally shrink the magic to a single byte `'N'` and land at 30 of 31 with a
byte spare. Once a band id is in the filter it is the id doing the
discrimination, and the second magic byte is close to redundant — the receiver
re-checks the payload anyway.

If real headroom is ever needed, the 128-bit NUS UUID is 18 of the 31 bytes on
its own. Dropping it and filtering discovery on the manufacturer magic instead
would free the space at a stroke, at the cost of changing pairing in
[band.js](../nigehban-app/src/band.js) and making the band no longer
self-identifying in generic BLE tools — which is genuinely useful while
debugging hardware. Not worth it for 2 bytes.

---

## BUG-010 — The band only reconnects while the screen is on

**Status:** OPEN
**Severity:** High — the wristband stays dark after every walk out of range
**Area:** [nigehban-app/src/band.js](../nigehban-app/src/band.js) · [nigehban-app/src/bgService.js](../nigehban-app/src/bgService.js)

### Symptom

Reported in three parts, which turn out to be one bug:

1. App swiped out of Recents, foreground service running, band connected (not
   blinking). Walk out of range — the band drops, correctly. Walk back — **it
   does not reconnect.** Open the app and it links immediately.
2. App open, screen on. Walk out and back — **it reconnects normally.**
3. App open, screen off because the display timed out. Walk out and back — **it
   does not reconnect.** Press the power button and it links immediately.

Case 3 is the one that localises this, and it is worth saying why. Nothing
about the React tree changed between cases 2 and 3: same process, same mounted
component, same module state, same live `BleManager`. The screen went off. So
none of the tree-lifetime explanations can apply, and neither can the fixes
built on them — `59fc02d` moved the link and the retry loop to module scope
(see [BRANCH_NOTES_ble-close-app-bug.md](BRANCH_NOTES_ble-close-app-bug.md) §2)
and that work is correct and still necessary. It fixed **where the retry timer
lives**. It did not, and could not, fix **whether the timer ever fires**.

### Cause

Every path back to the band goes through `retrySoon()`
([band.js:153-161](../nigehban-app/src/band.js#L153-L161)), and `retrySoon` is a
`setTimeout`. On Android, React Native's `setTimeout` stops when the Activity
is paused — which is exactly what "screen off" and "swiped away" both mean.

This is not inference. It is in the RN sources in this repo's
`node_modules/react-native`, in
`ReactAndroid/src/main/java/com/facebook/react/modules/core/JavaTimerManager.kt`:

```kotlin
override fun onHostPause() {
  isPaused.set(true)
  clearFrameCallback()        // removes the TIMERS_EVENTS frame callback
  maybeIdleCallback()
}
```

Timers are evaluated only inside a Choreographer frame callback, and
`clearFrameCallback()` (line 140) unposts it. The callback itself refuses to run
anyway while paused — line 291, at the top of `doFrame`:

```kotlin
if (isPaused.get() && !isRunningTasks.get()) { return }
```

So with the app paused, the timer queue is not merely slow. **It is not read at
all.** Pending timers sit in the priority queue accumulating overdue targets,
and nothing looks at them.

`onHostResume()` (line 83) sets `isPaused = false` and re-posts the callback,
and the very next frame drains every expired timer in one pass (line 296:
`while (timers.peek().targetTime < frameTimeMillis)`). RN's own source carries a
`TODO` about this at line 85 — *"Investigate possible problems related to
restarting all tasks at the same moment."*

That drain is the reconnect the user sees on opening the app. It is worth being
precise about how strong this evidence is: **nothing in this codebase reconnects
the band on foreground.** All four `AppState` listeners in App.js were checked —
[App.js:183](../nigehban-app/App.js#L183), [215](../nigehban-app/App.js#L215),
[658](../nigehban-app/App.js#L658), [927](../nigehban-app/App.js#L927) — and
none of them touch `band.connect`. In case 3 there is no remount either, so the
mount-time adopt and cold-start effects
([band.js:834](../nigehban-app/src/band.js#L834),
[band.js:875](../nigehban-app/src/band.js#L875)) never run. The overdue timer
firing on resume is the only mechanism left that can explain the reconnect, and
it explains it exactly.

The chain, then:

- the band goes out of range;
- `onDisconnected` fires ([band.js:415-421](../nigehban-app/src/band.js#L415-L421))
  — this part works, because it is a **native** callback and native callbacks
  are posted straight to the JS thread rather than scheduled on a frame;
- it calls `retrySoon()`, which schedules a `setTimeout` 3–15 s out;
- that timeout is never read while the screen is off;
- the band comes back into range and advertises to nobody.

The same split explains the reporter's earlier observation in BUG-006, that a
double-tap on the band *does* raise an SOS with the app swiped away. Native
callback: works. Timer: does not. Every part of this app that survives being
backgrounded is on the first side of that line, and every part that does not is
on the second.

### Why the foreground service does not save it

[bgService.js:66-70](../nigehban-app/src/bgService.js#L66-L70) says the service
"prevents Android from sleeping the JS runtime". **That comment is wrong and
should be corrected.** A foreground service keeps the *process* alive. It does
not hold a wake lock, it does not resume the Activity, and it has no effect on
`isPaused`.

There is one genuine exception, and it is why this may look intermittent rather
than absolute. `HeadlessJsTaskContext.hasActiveTasks()` is checked in
`clearFrameCallback()`, and expo-task-manager deliberately exploits that —
`node_modules/expo-task-manager/android/.../TaskService.java:406`:

> Register with HeadlessJsTaskContext to keep JS timers alive while the app is
> backgrounded. Without this, JavaTimerManager pauses all timers when the
> Activity is paused (isPaused=true && isRunningTasks=false), causing all async
> JS operations (promises, setTimeout) to hang.

So each background location tick from `startBackgroundWatch` opens a window in
which timers do run, and an overdue reconnect can slip through it. That window
cannot be relied on: it opens at best once every 60 s
([bgService.js:93-109](../nigehban-app/src/bgService.js#L93-L109)), it closes as
soon as the task's `flushPending()` promise settles (`maybeFinishHeadlessTask`,
TaskService.java:688), and Doze defers location once the screen has been off a
while. A minute-plus of dead wristband is not an acceptable floor on a safety
device even when it does work.

### Severity, honestly — **revised upward, 1 Sep 2026**

**This section used to soften itself, and the thing it leaned on is gone.** It
read: lower than it first looks, because of `bandWake` — the band's SOS
advertisement is matched by a `ScanFilter` registered with the **system** via a
PendingIntent
([BandWake.kt:141-149](../nigehban-app/modules/nigehban-bandwake/android/src/main/java/com/nigehban/bandwake/BandWake.kt#L141-L149)),
so a press still got out with the GATT link down and the app dead. The emergency
path had a floor.

**It no longer does.** The beacon wake was switched off
([BAND_WAKE_DISABLED.md](BAND_WAKE_DISABLED.md)), so with the link down there is
no path at all: the press reaches nothing. High is now the floor of this
entry's severity rather than a generous reading of it, and **BUG-010 is the
single highest-value item on this list** — everything about the band's
availability now rests on the GATT link coming back, and this is the bug that
stops it doing so.

The rest of the original reasoning stands unchanged: everything on the wrist
rides the GATT link and stops with it — check-in requests and their buzz,
battery, armed / anti-snatch state, and the confirmation buzz from BUG-007. The
wearer also sees "disconnected" on a band they are wearing, which on this
product is its own harm.

### Fix — the shape of it

The rule to design to: **a reconnect must never be scheduled on a JS timer.**
It has to be started from a native-driven callback and then handed to the OS to
wait, so that nothing between the band reappearing and the link coming up
depends on JavaScript being scheduled.

Preferred, and small: use Android's GATT auto-connect for the background
attempt. `react-native-ble-plx` 3.5.1 exposes it — `autoConnect?: boolean` in
`ConnectionOptions`, Android only (`src/index.d.ts:187`). Called from
`onDisconnected` (a native callback, so it runs) with **no** timeout, it hands
the standing "keep this link up" instruction to the Bluetooth stack, which
reconnects the moment the band is seen again — screen off, in Doze, with no JS
running. The process staying alive is all it needs, and that is precisely what
the foreground service does provide.

Keep the current fast path as it is: `connectToDevice(id, { timeout: 6000 })`
for the interactive case, where a user is watching and six seconds is the right
answer. The two compose — fast attempt in the foreground, patient OS-owned
attempt behind it.

Notes for whoever implements it:

- a pending auto-connect must be cancelled in `disconnect()`, or a deliberate
  DISCONNECT leaves the stack still trying;
- with no timeout there is no failure to back off from, so the `retrySoon()`
  paths around the direct-connect branch need rethinking rather than keeping in
  parallel;
- the scan path and its budget (BUG-002) are untouched by this and must stay —
  auto-connect only helps for a band whose id is already known.

Belt and braces, if auto-connect proves unreliable across the phones this
ships to: `bandWake` already owns the pattern that cannot fail. A **second**
registration matching the same manufacturer prefix with `FLAG_SOS` masked *out*
would have the OS broadcast "your band is in range" with no JS timer, no wake
lock and no polling, and would cover the case auto-connect cannot — the process
actually being killed. It needs its own `startScan` with its own PendingIntent
and `CALLBACK_TYPE_FIRST_MATCH`, because callback type is a property of
`ScanSettings`, not of a filter, and the existing registration's
`ALL_MATCHES` + `MATCH_NUM_ONE_ADVERTISEMENT`
([BandWake.kt:160-169](../nigehban-app/modules/nigehban-bandwake/android/src/main/java/com/nigehban/bandwake/BandWake.kt#L160-L169))
would fire a broadcast on essentially every advertisement an idle band sends.

### Collateral — same root cause, different victim

Worth its own entry once this one is understood, and listed here so it is not
found twice:

- **The server-side silence watchdog stops with the screen off.**
  [watch.js:137](../nigehban-app/src/watch.js#L137) posts `/heartbeat` on a
  plain `setInterval`, so an armed phone stops heartbeating whenever the display
  is off. Either the server raises "this wearer has gone silent" on a phone
  sitting safely in a pocket, or it does not and the watchdog is decorative.
  Both are worth knowing which.
- **The band data watchdog stops too**
  ([band.js:524-533](../nigehban-app/src/band.js#L524-L533)), so a subscription
  that dies silently while the screen is off is not noticed until the screen
  comes back.
- **The queued-alert retry** ([App.js:965](../nigehban-app/App.js#L965)) is on a
  30 s `setInterval` and freezes as well. This one is already covered: the
  location task calls `flushPending()` for exactly this reason
  ([bgService.js:40-47](../nigehban-app/src/bgService.js#L40-L47)) — which, read
  in this light, is the same defect already worked around once, in one place,
  without the general cause being named.

### How to confirm before fixing

Case 3 is the cheap repro and needs no second phone: app open, band connected,
let the display time out, walk out of range and back, watch whether the status
line ever leaves `disconnected` before the screen is woken. `adb logcat` will
show the RN timer callbacks stopping and the whole overdue queue firing at once
on resume.

---

## BUG-017 — Sign-out leaves the handset receiving the old account's alerts

**Status:** FIXED on `fix/stop-push-after-signout` — server side verified
(11/11 against the real database), but **not yet tested in the app on a phone**
**Severity:** High — a signed-out phone keeps receiving another family's
emergencies, including live location links
**Area:** [nigehban-app/App.js](../nigehban-app/App.js) ·
[nigehban-app/src/notifications.js](../nigehban-app/src/notifications.js) ·
[nigehban-app/src/bgNotifications.js](../nigehban-app/src/bgNotifications.js) ·
[server/nigehban_server.py](../server/nigehban_server.py)

### Symptom

Sign out. Do not sign in again. A family member on that account presses SOS, or
any other alert fires for them — check-in, low battery, `watch_lost`. The
notification still arrives on the signed-out phone: name, alert kind, and the
maps link to where that person is.

Tapping it opens the app to the sign-in screen. There is nothing to answer with
and nothing to see.

### Cause

`signOut` ([App.js:972-985](../nigehban-app/App.js#L972-L985)) tears down
everything that lives *on the phone* and nothing that lives on the server:

```js
try { await band.disconnect?.(); } catch { /* nothing paired */ }
await stopBackgroundWatch();
await clearSession();
await clearQueue();
dispatch('RESET');
```

`clearSession()` removes one AsyncStorage key
([api.js:161-163](../nigehban-app/src/api.js#L161-L163)). It does not tell the
server anything, and there is nothing to tell it with: the only device endpoint
is `POST /device`
([nigehban_server.py:1249](../server/nigehban_server.py#L1249)). There is no
`DELETE /device`, and no other route touches the row.

So the `devices` row survives sign-out with `user_id` still pointing at the
account that just left and `push_token` still live. Fan-out selects on exactly
that column
([nigehban_server.py:1279-1288](../server/nigehban_server.py#L1279-L1288)):

```python
"SELECT DISTINCT push_token FROM devices WHERE push_token IS NOT NULL"
" AND push_token != '' AND user_id = ANY(%s)"
```

The handset is still a valid delivery target for an account nobody is signed
in to. Nothing on the phone can decline the push either — a visible Expo push
is drawn by the system before any app code runs, which is precisely the
property BUG-006 and BUG-008 rely on.

The row is keyed on the install id, so signing in as somebody else *does*
repoint it ([notifications.js:114-125](../nigehban-app/src/notifications.js#L114-L125),
`ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id`). That is what makes
this easy to miss: the account-switch case, which BUG-001 made everyone look
at, is the one case that already works. The broken state is **signed out and
left signed out**, and it lasts indefinitely.

### The second half: the takeover still fires

Worse than the notification, and a separate mechanism. The background
notification task is registered on sign-in
([App.js:271-279](../nigehban-app/App.js#L271-L279)) and unregistered nowhere —
`unregisterTaskAsync` does not appear in the app at all. The task itself has no
notion of a session ([bgNotifications.js:132-149](../nigehban-app/src/bgNotifications.js#L132-L149)):

```js
if (!alert || alert.severity < 4) return;
lastFiredAt = Date.now();
if (await presentAlarm(alert)) return;
await sendEmergencyAlarmIfNothingShown(alert);
```

Severity is the only gate. A severity-5 silent push therefore still wakes a
headless runtime on a signed-out phone and fires the full-screen, DND-bypassing
lock-screen siren for an account that is not signed in — landing the person, on
dismiss, at a login screen.

### Why this is High and not Medium

Three harms, and they are different from each other:

1. **A live-location leak.** The push carries the wearer's name and a maps
   link. On a handset that was signed out because it changed hands — sold,
   returned, handed to a family member — that goes to a stranger. Same class as
   BUG-001, and this one leaks the thing the product exists to protect.
2. **A siren with no off switch that means anything.** See above.
3. **A phantom responder.** The wearer's family list still counts this handset
   as covered. `send_expo_push_notifications` logs the push as accepted by Expo,
   so the server-side view is green. Nobody — not the wearer, not the family,
   not the log — can tell that one of the phones being paged cannot answer.
   That is the inverse of the failure BUG-008 was written to close: there, the
   answer never reached the wearer; here, the request never reaches a person.

### Fix

Branch `fix/stop-push-after-signout`. Four changes, and the smallest one matters
most.

**1. `DELETE /device/{install_id}`** ([nigehban_server.py](../server/nigehban_server.py)),
authenticated, scoped with `AND user_id=%s` so a guessed install id cannot
silence somebody else's phone. It clears **only** `push_token`.

The plan here said to clear `user_id` too. That turned out to be both impossible
and unnecessary: the column is `NOT NULL`
([supabase_migration.sql:102](../server/supabase_migration.sql#L102)), and
`push_tokens_for()` already filters on the token, so clearing the token *is* the
fix. Leaving `user_id` alone also keeps the row saying what it means — this
install, belonging to this account — which is exactly what the next sign-in
updates. No migration was needed.

Deliberately idempotent: signing out twice, or from a phone that never
registered, returns `ok` rather than 404. A sign-out must never fail.

**2. `stopPushToThisPhone(session)`** in
[notifications.js](../nigehban-app/src/notifications.js) — the other half of
`registerPushToken`, doing the install-id lookup and the DELETE. Best effort: a
failure is recorded in `pushDiagnostics()` and swallowed. The id is
percent-encoded, because older builds registered the Expo push token itself as
the install id and `ExponentPushToken[...]` carries brackets.

**3. Called from `signOut` before `clearSession()`**
([App.js](../nigehban-app/App.js)). This ordering is the one trap in the change:
`clearSession` destroys the token the call authenticates with, so doing it first
makes the call silently do nothing while looking correct.

**4. `unregisterBackgroundNotifications()`, and a session check inside the task**
([bgNotifications.js](../nigehban-app/src/bgNotifications.js)). The task now
calls `loadSession()` first and returns early when there is none, so a silent
push can no longer wake a headless runtime and fire a full-screen, DND-bypassing
siren on a phone showing a login screen.

### The offline case — why 4 matters more than 1

Sign-out must not require a network. Somebody handing a phone over, or standing
somewhere with no signal, will still tap it and the app must still sign them out.
So the DELETE cannot be a precondition — which means the server call is the part
of this fix most likely to be missing exactly when it is needed, and the two
local guards in 4 are what actually hold the line. They were written second and
they are the ones to keep working.

**Still open, deliberately not built here:** the durable version, where sign-out
itself is queued the way an alert is — a marker persisted outside the session
key, the DELETE retried on next launch, and the takeover refused while the marker
is set. That covers the phone signed out on a dead connection and never opened
again, whose row stays deliverable until somebody signs in on it. Worth settling
at the same time whether the app should drop any push it cannot attribute to the
current session, which would close the whole class rather than this instance.

### Verification — what has actually been run

[tests/test_signout_stops_push.py](../tests/test_signout_stops_push.py), against
a live server and the real database on 1 Sep 2026: **11 passed, 0 failed.**

That settles the server side completely:

- an unauthenticated sign-out is refused, and another account's DELETE does
  **not** clear your row — the scoping is real, not merely intended;
- a signed-in phone is a delivery target, and after sign-out it is not;
- the install row survives, still belonging to the account. Nothing is deleted;
- signing back in makes the phone deliverable again, with no manual step;
- signing out twice is not an error;
- a bracketed legacy install id clears too.

"The phone stops being a delivery target" is therefore now an observed fact about
the database, rather than a claim about a line of SQL.

Getting there took two attempts, which is the part worth recording. The first
version of the test's database helper caught every exception and returned
`"no db"`, so a failure to reach the database was reported as a *skipped* check
and read as "you have not configured this". The run sat at 5 passed, 6 skipped,
looking approximately green while the central assertion had never executed once.
That is the same failure-wearing-the-costume-of-absence this file keeps
documenting — `registerPushToken`'s green chip in this bug's own cause section,
the `[expo push] no registered device` line that printed like a success. The
helper now separates "nothing configured to ask" (skip) from "asked and it
failed" (fail, with the real exception), and prints what it saw either way.

**Still nothing has been run on a phone.** The three app-side changes — the call
placed before `clearSession()`, `unregisterBackgroundNotifications()`, and the
session check inside the background notification task — have not executed once.
The server now provably stops *sending*; whether the app stops *asking*, and
stops firing the takeover, is untested.

### Still to verify

1. **On a phone.** Sign out, leave it signed out, and have a family member raise
   an SOS. Confirm nothing arrives — nothing in the shade, and no full-screen
   takeover. Then sign back in and confirm it arrives again with no manual step.
2. **On a phone with no network.** Sign out in airplane mode, restore the
   network, and confirm the phone still receives nothing. This is the case the
   server call cannot cover and the two local guards are supposed to, which makes
   it both the more important of the two and the more likely to be quietly
   broken.

### A note on the name

"Deregister the device" was the original wording and it misleads: it reads as
though something belonging to the user is deleted. Nothing is. One column in one
row is set to NULL, and the next sign-in fills it back in. The branch, the
endpoint and the function are named for what actually happens, and this
paragraph is here because the wording confused a reader once already.

### Rejected

**Having the server skip pushes to users with no live websocket.** It reads like
a fix — a signed-out phone has no socket — but it is the same trade rejected in
BUG-009 and it fails the same way: socket-connected is not the same as
reachable, and a family member with a locked phone in their pocket is the
case the push path exists for. Removing the guaranteed floor to catch a stale
registration is the wrong direction on a safety device.

**Expiring device rows on `last_seen`.** It would eventually clear this, but
"eventually" is doing all the work: `last_seen` is only written by `POST
/device`, so the window is measured in however long until the next sign-in, and
a phone that is never signed into again never expires at all. Also punishes the
legitimate case — a family member who has not opened the app in a month is
exactly who most needs the push to still work.

---

## BUG-018 — The beacon wake opens the app for an SOS, and on one phone opens other apps too

**Status:** SPLIT, and the two halves have different statuses.

- **The beacon half: STALE.** Outcome 3 below was taken on 1 Sep 2026 — the
  beacon wake was switched off, not removed
  ([BAND_WAKE_DISABLED.md](BAND_WAKE_DISABLED.md)).
  `BandWakeReceiver.onReceive` now returns before it can post a notification or
  launch anything, so neither the intended app launch nor the Vivo's extra ones
  can happen through this path.
- **The implicit-intent half: OPEN, and it is not in this module.** Candidate
  cause 1 below is duplicated code, and the copy in `nigehban-alarm` was not
  touched:
  [NigehbanAlarmModule.kt:433](../nigehban-app/modules/nigehban-alarm/android/src/main/java/com/nigehban/alarm/NigehbanAlarmModule.kt#L433).
  That one fires on an **incoming family emergency**, which is a live feature on
  every phone in the field. If the Vivo's other-apps behaviour was cause 1
  rather than cause 2, switching off the beacon has not fixed it — it has only
  moved which event triggers it, from your own band's press to a family
  member's. Untested either way.

**Severity:** Low as it stands — the SOS was delivered correctly on every phone
including this one; the cost was unexpected app launches on one handset
**Area:** [BandWakeReceiver.kt](../nigehban-app/modules/nigehban-bandwake/android/src/main/java/com/nigehban/bandwake/BandWakeReceiver.kt) ·
[NigehbanAlarmModule.kt](../nigehban-app/modules/nigehban-alarm/android/src/main/java/com/nigehban/alarm/NigehbanAlarmModule.kt)

### Symptom

App swiped out of Recents and the band disconnected — no app, so nothing is
holding the GATT link. Press the band twice. The SOS **is** sent, correctly. But
the phone also brings the Nigehban app up into the foreground, and on the
reporter's Vivo running Android 8, **other unrelated apps come up as well**.

Only that handset. No other phone tested behaves this way, and most never reach
this path at all: on them the app or its foreground service survives a Recents
swipe, the band stays linked, and the press arrives over GATT to JavaScript that
is still running.

### Cause — the app launch is the design; the rest is not

The app launching is the feature, not the bug. When no JS listener is alive,
[BandWakeReceiver.kt:146-187](../nigehban-app/modules/nigehban-bandwake/android/src/main/java/com/nigehban/bandwake/BandWakeReceiver.kt#L146-L187)
posts a full-screen-intent notification, and on a locked or idle phone Android
launches the activity itself so the app's ordinary `raise()` sends the alert
with nobody touching anything. That is the entire point of the beacon path and
it is why an emergency still gets out of a phone that ran `kill -9` (BUG-015).

**Other apps launching is not explained by that, and is not diagnosed.** Two
candidates, cheapest first:

1. **The implicit-intent fallback.** Both wake modules build the PendingIntent
   the same way —
   [BandWakeReceiver.kt:149-150](../nigehban-app/modules/nigehban-bandwake/android/src/main/java/com/nigehban/bandwake/BandWakeReceiver.kt#L149-L150)
   and [NigehbanAlarmModule.kt:433-434](../nigehban-app/modules/nigehban-alarm/android/src/main/java/com/nigehban/alarm/NigehbanAlarmModule.kt#L433-L434):

   ```kotlin
   val launch = (context.packageManager.getLaunchIntentForPackage(context.packageName)
     ?: Intent(Intent.ACTION_MAIN)).apply { ... }
   ```

   If `getLaunchIntentForPackage` ever returns null, the fallback is a bare
   `ACTION_MAIN` with no component, no package and no category — an **implicit**
   intent that matches essentially every launchable activity on the device, and
   what it resolves to is the system's choice. Worth checking first because it is
   cheap, because it is a landmine whether or not it is this bug, and because it
   is duplicated in two modules.

2. **Funtouch's wake-up chain.** Vivo's power manager freezes background apps and
   thaws them in groups, and an app being pulled to the foreground from a
   broadcast is the kind of event that triggers it. If that is the cause there is
   nothing in this repo to fix, and the answer is to stop launching an activity
   at all — which is what the direction below does anyway.

Nothing has been captured from the device yet. `adb logcat -b events` filtered on
`am_` at the moment of a press would separate the two in a single run, and that
is the first thing to do whenever this is picked up.

### Decision — taken 1 Sep 2026: outcome 3, by switching off rather than removing

Superseded by the switch-off. The original deferral reasoning is kept below,
because it is what the decision was made against; what changed is that the
reporter asked for the feature to stop rather than be fixed, and the two
Critical entries in the beacon cluster made that the cheap answer rather than a
sacrifice. The feature is **off, not deleted** — every line of it is still in
the tree behind two booleans, and
[BAND_WAKE_DISABLED.md](BAND_WAKE_DISABLED.md) records the cost, the parts it
does not cover, and the order things must be done in to bring it back.

The cost, stated once more here because this entry is where somebody will look
for it: on an OEM that runs `kill -9` on a Recents swipe, a band press with the
app killed now reaches nobody.

**The original deferral reasoning, for the record:**

Deferred deliberately, not forgotten. The reasoning, so it does not have to be
rebuilt later:

- It reproduces on one Android 8 Vivo and on no other phone.
- The emergency itself is delivered correctly everywhere, including there. This
  costs noise and confusion, not a missed SOS.
- On every other handset the beacon path is barely exercised, because the app or
  its foreground service survives the swipe and the band stays connected.
- Two Critical bugs are open in the beacon cluster — BUG-012 and BUG-013 — and
  those affect every phone. They come first.

### The direction if it is picked up

Not "fix the launch" but **stop launching for the SOS at all**.

Today the wake and the delivery are one event: the press wakes the phone, and the
wake exists in order to send the press. The alternative separates them — the wake
starts the background service, the service reconnects the band, and the SOS
arrives over the ordinary GATT link like every other band event, through code
that runs on every phone and is exercised constantly. No activity is launched, so
whatever is pulling other apps up has nothing to pull.

That is the same machinery as BUG-015's idle-beacon relink, and it inherits the
same two dependencies:

- **Band identity in the advertisement** (BUG-012) — the MAC-derived band id.
  Without it, a relink filter wakes this phone for every band in range.
- **BUG-010 first**, because the reconnect the woken service has to run is
  currently on a JS timer that does not fire while the Activity is paused.

The open question, and the reason this is a direction and not a plan: a relink is
slower than a beacon and can fail outright. A snatch is precisely the case where
band and phone are moving apart, so it is when a relink is least likely to
succeed and an alert most needed — the argument already made in BUG-015's closing
note against merging the two paths. Dropping the direct beacon-to-SOS path buys a
cleaner wake and pays for it in the worst case the product exists for.

Three outcomes were live when this was written. **Outcome 3 was taken**, in its
cheapest form — the beacon-to-SOS path is switched off, and the relink that was
meant to replace it (BUG-015) has not been built, so there is currently nothing
in its place. That gap is the deliberate cost, and BUG-010 → BUG-015 is the
work that closes it.

1. Keep the path as it is and accept the Vivo's behaviour.
2. Keep it, but stop launching an activity — post the notification and let the
   wearer tap SEND IT NOW, at the cost of the hands-free case. **Still the most
   likely shape of a return**, and worth reconsidering alongside the band-id
   work rather than reflexively restoring the launch.
3. ✅ **Taken.** Remove the beacon-to-SOS path in favour of the relink — done as
   a switch-off, with the relink still outstanding.

### Not to be confused with

- **BUG-015** is the *absence* of a relink after a kill. This is the *presence*
  of a wake that works and does more than it should. Same machinery from opposite
  sides, and outcome 3 above fixes both with one piece of work.
- **BUG-012** is a foreign band waking this phone. Here it is this phone's own
  band, doing exactly what it was told to do.
