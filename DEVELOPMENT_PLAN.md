# Nigehban — Development Milestone Plan

Companion to [EXECUTION_PLAN.md](EXECUTION_PLAN.md). That file slices the work by
**day and by person**. This file slices the *same* work by **workstream** — UI,
Backend, Android platform, Firmware, Deployment, QA — so whoever sits down to
build can see one vertical through to completion without reconstructing it from
a day-by-day board.

Nothing here adds scope. Every milestone traces to a phase in the execution
plan; the `Phase` column is the cross-reference.

> **Calendar note.** The execution plan is dated Thu 20 → Mon 24 Aug 2026. Today
> is **Fri 21 Aug 2026 — Day 2 of 5**. The audit in §1 puts the repo at the
> pre-Phase-0 state: nothing from the Phase 0 checklist has landed in the tree.
> If those dates are live, read §9 (Compression) before §3. If the deadline has
> moved, ignore §9 and work the milestones in order.

---

## 1. Where the repo actually is

Audited against the working tree, not against intentions.

| Workstream | Built | Missing |
|---|---|---|
| **UI** | Auth · Home · Band · Family · Alerts · Setup; client state machine; check-in countdown, High Alert with PIN disarm, fall countdown, battery/going-dark, SOS live view, watch-status tile, Samaritan respond; one design system (Outfit + Space Grotesk, semantic tokens, `ui.js` kit, no emoji) | Changing the server address after sign-in — it is still only on the Auth screen |
| **Backend** | `server/nigehban_server.py` — 24 endpoints + `/ws`, SQLite, 11 tables, live push, **the sweeper**, two-party pairing consent, rate limits, hashed session tokens, `/presence` + `/samaritan`, push TTL | Qwen scoring, WhatsApp fan-out, token expiry |
| **Android** | `app.json` with BLE/location/notification perms **and 9 more added by `plugins/withNigehbanAndroid.js`**; `eas.json` with 3 profiles; `expo-battery`, `expo-task-manager`, `expo-dev-client`; **FCM wired** (`google-services.json`, project `nigheban-d126d`); foreground service; OEM deep links in Setup.js; **`modules/nigehban-alarm/` — full-screen intent + looping siren, built in-house** | boot receiver · WorkManager watchdog |
| **Firmware** | `nigehban_band_nrf52/` (591 lines) — full gesture map, protocol, feedback patterns, battery ADC code; bench sketches `t1`–`t6` all passed | `HAS_IMU 0` · battery divider uncalibrated · motor circuit unbuilt · haptic drive strength unresolved (firmware/README.md) |
| **Deployment** | `scripts/dev-tunnel.ps1` / `.sh` — server + HTTPS tunnel, self-verifying; CORS on the server | No Dockerfile, no compose, no Caddyfile, no Alibaba account |
| **Glue** | `nigehban_hub.py` — Guardian logic in Python | Superseded by the server's sweeper; kept as the firmware test rig |

~~Two things in `api.js` shape the first UI milestone...~~ **Resolved.** U1 has
landed: the app now takes an `https://` tunnel or cloud hostname, derives
`wss://` from it, and carries the ngrok header. The subnet sweep survives as
the labelled fallback it always should have been.

The band is no longer the blocker either. V1 makes the phone speak the band's
protocol, so only two rows of the acceptance matrix — BLE reconnect after the
app is killed, and the physical motor/power budget — actually need hardware.

**Audited against the tree again on 26 Aug 2026, and the table above was wrong
in the app's favour on almost every Android and firmware row.** `plugins/`,
`expo-battery`, the nRF52 sketch and the whole FCM setup all existed while the
plan said they did not; N1 and N3.1 were marked open and are done. The lesson is
in §10 already — a milestone is done when it is *observed* — and the same rule
has to apply to marking one open. Corrections are in the N1, N3.1, F2 and §11
entries.

A review pass the same day found eight defects that all present as working
software — see §14.

---

## 2. Milestone map

```
                    ┌─────────────────────── the two contracts (exec plan §2.1)
                    │                         frozen before any code
        ┌───────────┴───────────┬──────────────┬──────────────┐
        ▼                       ▼              ▼              ▼
   U1 transport           B1 consent+     N1 config       F1 nRF52
   U2 state machine          schema          plugin        bring-up
        │                       │              │              │
        ├── U3 safety UI ◀──────┤              │         F2 gestures
        │                       │              │              │
        │                  B2 sweeper     N2 fg service   F3 IMU/fall
        │                       │              │              │
        └───────────┬───────────┴──────┬───────┴──────────────┘
                    ▼                  ▼
              U4 family/watch     N3 push + alarm
                    │                  │
                    └────────┬─────────┘
                             ▼
                    B3 features · U5 polish
                             ▼
                    D1 → D2 → D3  deployment
                             ▼
                        Q1 → Q2 → Q3
```

Legend for every milestone below:

- **Owner** — the track from exec plan §2 (M1 app · M2 native · M3 cloud · M4 firmware)
- **Phase** — the execution-plan phase it belongs to
- **Blocks** — what cannot start until this is done
- **Done when** — the observable check. Not "the code is written."

---

## 3. UI — `nigehban-app/src/`

### U1 · Configurable transport · Owner M1 · Phase 0 · ~2 h

The one-line base-URL swap in Phase 4 only exists if this lands on Day 1.

- [x] U1.1 — In [api.js](nigehban-app/src/api.js): `normaliseUrl()` no longer forces `http` + `:8000`. A bare IPv4 is the laptop and gets the dev port; anything with a hostname is a public host and gets `https`. `wsUrl()` derives the socket scheme from it.
- [x] U1.2 — The subnet sweep is now labelled "FIND MY LAPTOP ON THIS WI-FI" and reads as the fallback it is.
- [x] U1.3 — The Auth address box takes a tunnel URL and `probe()`s it before saving. This is where the ngrok URL goes each morning and the cloud hostname goes on Day 4.
- [x] U1.4 — `TUNNEL_HEADERS` on every request and on `probe()`. Verified load-bearing: without it a browser-UA client gets ngrok's HTML interstitial instead of JSON.
- [x] U1.5 — **Socket keep-alive.** 26 Aug 2026 — `useLive()` never pinged, though the server has always answered `{"t":"ping"}` with `{"t":"pong"}`. A carrier NAT drops an idle mobile connection without telling either end: `onclose` never fires, `readyState` stays OPEN, and the header goes on showing **connected** while every check-in buzz and every family alert lands in a pipe that ends nowhere. That is the worst failure mode this product has, because it is silent and looks exactly like nothing happening. Now a 30 s ping with a 10 s pong deadline; a missed pong closes the socket so the existing `onclose` does the reconnect it already knew how to do. Any inbound frame clears the deadline, not just the pong.

**Blocks:** every screen that talks to a real server, and D3.
**Done when:** both phones on **mobile data** reach the laptop server through ngrok, and swapping to a different URL needs no rebuild.
**Status: done.** Proved end to end — register, link, band SOS, live `wss://` delivery to the family phone and the stand-down back, all through `https://<id>.ngrok-free.app`.

### V1 · Virtual band · Owner M1 · Phase 0 · **done**

Unblocks every other milestone while the hardware is missing. See
[TESTING_WITHOUT_HARDWARE.md](TESTING_WITHOUT_HARDWARE.md).

- [x] V1.1 — [virtualBand.js](nigehban-app/src/virtualBand.js): the `.ino`'s button engine, gesture map, event JSON and command handler, ported to JS. Only the radio is simulated.
- [x] V1.2 — [bandLink.js](nigehban-app/src/bandLink.js): one seam, two radios. Real BLE and the virtual band expose the identical `useBand` surface, so App.js and Home.js are unchanged by the swap.
- [x] V1.3 — [Band.js](nigehban-app/src/screens/Band.js): a BAND tab with the real gesture surface — you must actually double-tap and actually hold — plus a wire log of every line that would have crossed the characteristic.
- [x] V1.4 — Fall state machine on the phone accelerometer at 104 Hz, the firmware's active rate. Thresholds live in `FALL` and copy straight into the `.ino` at F3.
- [x] V1.5 — Real phone battery feeds `bat`, so the 20 % and 5 % escalations are testable by unplugging rather than by faking.

**Done when:** a double-tap on one phone raises an SOS on another phone through
the tunnel, with no band in the building. **Observed.**

> **Two protocol divergences found while porting**, both left alone rather than
> silently picked — see §12. The `.ino` and exec plan §5 disagree on which
> gesture is SOS and on what hold-3s does. `virtualBand.js` follows the
> firmware, because that is the code that exists and that App.js consumes.

### U2 · Client state machine · Owner M1 · Phase 0 · ~4 h

- [x] U2.1 — [state.js](nigehban-app/src/state.js): `idle · high_alert · checkin_pending · fall_pending · sos_live`, with the legal transitions written as a table. A fifth state was needed: `fall_pending` is the countdown, and it is the one place a deadline is legitimately client-owned, because no server row exists to own it until the alert does.
- [x] U2.2 — `bandEventToAction()` maps every band event, and each socket handler in [App.js](nigehban-app/App.js) dispatches exactly one action. An event that is illegal in the current state is dropped rather than applied — a `buzz_now` arriving behind a live SOS can no longer demote it to a check-in.
- [x] U2.4 — `checkin_missed` is no longer silently dropped. 26 Aug 2026 — the band's local nag expiring now dispatches `CHECKIN_EXPIRED`, a context-only event that tells the wearer time is up **without** escalating (the sweeper already owns that deadline; a second alert would page the family twice for one silence, on two disagreeing clocks) and **without** closing the question (answering late still tells the family she is fine). See §14.
- [x] U2.3 — Driven from the BAND tab, which produces real gestures.

**Design rule:** the phone is an actuator, never a timekeeper. This machine
reflects server-owned state; it must not own a deadline.

**Blocks:** U3, U4.
**Done when:** the simulated band walks all four states and the UI follows without a reload.

### U3 · Safety-feature UI · Owner M1 · Phase 2–3 · ~8 h

Built against **mocked** WS messages first, wired to B2 when it lands.

- [x] U3.1 — **Check-in countdown** — a sheet on arrival, a persistent banner once that is dismissed, both counting to the server's `due_at`. The deadline had to be put on the wire first: `checkin_req` and `buzz_now` carried only `window`, so a message that arrived late started a fresh ninety seconds.
  - **Crash fixed 26 Aug 2026.** [CheckinBanner.js](nigehban-app/src/components/CheckinBanner.js) referenced `s.head` but never defined `s` — no `StyleSheet.create`, no import. Every render threw `ReferenceError`, and with no error boundary in the tree React unmounted the whole screen: pressing **ask for a check-in** blanked the family member's app. It had been unreachable-by-luck until the ask-sheet path started rendering it.
- [x] U3.2 — **High Alert panel** — armed in one tap, disarmed behind four digits ([PinSheet.js](nigehban-app/src/components/PinSheet.js), keystore-backed). Arming never asks; that asymmetry is the feature. The next buzz is shown to the minute, because the interval is randomised precisely so that it cannot be timed.
- [x] U3.3 — **Fall countdown** — [FallCountdown.js](nigehban-app/src/components/FallCountdown.js): 30 s at severity 4, 15 s at severity 5, vibrating through each of the last five seconds. "I'm fine" writes a `near_miss`, which the server records and tells nobody.
- [x] U3.4 — **Battery states** — one alert per threshold crossing, latched and re-armed on charge (matrix #13, #14). The wearer sees a banner saying what her family was told. **Reworked 29 Aug 2026 — there are two batteries, and they were one number.** The app read `band.battery`, which in BLE mode is the *wristband's* ADC reading, sent it to the server as `phone_batt`, and told the family "phone about to die" — so a wearer at 4 % band and 90 % phone paged his family about the wrong device, and a wearer whose phone was genuinely dying said nothing, because the phone's own battery was never read outside `virtualBand.js`. Now: `low_battery` at phone 20 %, `going_dark` at phone 5 %, and a new **`band_battery`** (severity 1) at band 20 %. The split is not cosmetic — a flat band means the safety device is off the air while the phone is still reachable by push; a flat phone closes every path to the family, including that push. `usePhoneBattery()` in `watch.js` reads `expo-battery`; the heartbeat carries `phone_batt` and `band_batt` separately and never substitutes one for the other.
- [x] U3.5 — **SOS live view** — [SosLiveView.js](nigehban-app/src/components/SosLiveView.js). Leads with how long it has been running and who has said "I'm on it", not with a delivery receipt; stand down from the app, or key 1 on the band.

**Done when:** all five run end-to-end off mocked messages with no server changes.

### U4 · Family-side UI · Owner M1 · Phase 2–3 · ~6 h

- [x] U4.1 — **Invite flow** — send · pending · accept · decline, in [Family.js](nigehban-app/src/screens/Family.js).
- [x] U4.2 — **Watch-status tile** — [WatchStatusTile.js](nigehban-app/src/components/WatchStatusTile.js) reads `GET /watch/{member_id}` and turns amber at the same 180 s the server uses, so the screen and the sweeper never disagree in front of a user (matrix #19).
- [x] U4.3 — **Alert takeover hardening** — map link, "I'm on it" posting to `/alert/{id}/ack`, and the stand-down echo clearing the takeover on every family phone.
  - **Alerts were going out with no position. Fixed 26 Aug 2026.** `raise()` read only the `fix` the Home screen feeds it, and Home only feeds it while that tab is mounted — so an SOS raised from the BAND tab, or from the band while the app was backgrounded (the normal case), carried no coordinates at all. The family got *EMERGENCY* and no map link, which is most of the value gone. It now falls back to `lastKnownFix()` in [watch.js](nigehban-app/src/watch.js) — the same cache the heartbeat has been reading every minute all along. Deliberately not a live GPS read: `getCurrentPositionAsync` can block for tens of seconds and an SOS has to leave the phone now.
- [x] U4.4 — **Good Samaritan respond** — [SamaritanCall.js](nigehban-app/src/components/SamaritanCall.js), on top of B3.3 and B3.4 below. Before "I'm going" there is no name and the pin is snapped to a 300 m grid; saying yes releases the name and the exact position, and puts the responder's own name on the alert.

**Done when:** matrix rows 1, 2, 7, 19, 20 pass on two phones.

### U5 · Onboarding & polish · Owner M1/M2 · Phase 3 · ~4 h

- [x] U5.1 — **OEM onboarding** — [Setup.js](nigehban-app/src/screens/Setup.js), now the fifth tab. The vendor is read from `Platform.constants.Manufacturer` and only that vendor's instructions are shown; every deep link is wrapped, falls back to the app-settings page, and leaves the manual steps on screen for when a class name has moved.
- [x] U5.2 — Permission ladder: notifications → location → background location → battery exemption, one rung at a time, each with one sentence of why and a granted/denied state. Home nudges to it while anything is outstanding.
- [x] U5.3 — Empty, offline, loading and permission-denied states on every screen — including a server-offline banner that says plainly that an alert raised now would reach nobody.
- [x] U5.4 — Contrast pass, folded into U6: every foreground/background pair in [theme.js](nigehban-app/src/theme.js) carries its measured ratio against `surface`, and body text never uses the `faint` tone.

### U6 · Design system · Owner M1 · **done**

Four screens that had each been styled once are now one system.

- [x] U6.1 — [theme.js](nigehban-app/src/theme.js): semantic colour tokens, a type scale, a 4/8 spacing scale, three corner radii. No screen sets a raw hex or a raw font size.
- [x] U6.2 — Type: **Outfit** for everything a person reads, **Space Grotesk** for headings, figures and countdowns. Loaded defensively in [fonts.js](nigehban-app/src/fonts.js) — a build without the font module falls back to the system face rather than showing nothing.
- [x] U6.3 — [ui.js](nigehban-app/src/ui.js): one kit — card, button, chip, field, banner, empty state, progress bar, stat — with a 48 pt minimum target, press feedback that never moves layout, and an accessibility label on every icon-only control.
- [x] U6.4 — Every emoji gone, including from push titles and the foreground-service notification, replaced by one icon family (Feather, imported by path so the bundle carries 56 KB of icons rather than 3.4 MB).

**Done when:** a fresh install on an untouched Xiaomi reaches a working armed state without anyone opening Settings manually.

---

## 4. Backend — `server/nigehban_server.py`

### B1 · Consent + schema · Owner M3 · Phase 0 · ~4 h — ☑ **done 22 Aug 2026**

The safety bug, closed. It went further than "add an accept button", for the
reason set out in §13 below: consent is not only about the moment of linking,
it is about what the server will tell a stranger who is guessing.

- [x] B1.1 — Tables added: `invites`, `devices`, `checkins`, `watch_state`, `pairings`. *`presence` deferred with B3.3, which is the only thing that writes it.*
- [x] B1.2 — The auto-link is gone. `POST /family` now returns **410** rather than failing open for an old app. Two consent paths replace it: `POST /pair` → `POST /invite` (a ten-minute, single-use code — both people act, so the link is immediate), and `POST /invite` with a permanent `NGB-` code → `POST /invite/{id}/accept`.
- [x] B1.3 — Rate limits on registration, login, pairing and code lookups. Per-account **and** per-network buckets, sized so a room behind one NAT never meets them.
- [x] B1.4 — `POST /device` — install id + push token, keyed on the install so a resold handset moves rather than duplicates. `push_tokens_for()` is there for N3.
- [x] B1.5 — Contract implemented and documented in exec plan §6.2 and §13 here.

Beyond the milestone, because they are the same bug:

- [x] Session tokens are stored **hashed**. The database was a list of live sessions; a copied `nigehban.db` handed over every account.
- [x] The code space is no longer a directory: an invite to a code that exists and one to a code that does not return **byte-identical** responses.
- [x] A decline is permanent and silent, including in the sender's own list.

**Blocked:** nothing any more. **Unblocked:** U4.1, B2, N3.
**Done when:** ~~curl proves an unaccepted invite moves no alerts in either direction.~~
[tests/test_consent_and_sweeper.py](tests/test_consent_and_sweeper.py) — 49 checks, all passing.

### B2 · The sweeper · Owner M3 · Phase 2 · ~5 h — ☑ **done 22 Aug 2026**

The single most important piece of server work — what makes the product true
when the app has been killed.

- [x] B2.1 — `Guardian` ported into `sweeper()`, one asyncio task on a 5 s tick, started from the app's lifespan. Each branch latches (`escalated`, `lost_notified`) so a condition that stays true pages the family **once**, not every tick.
- [x] B2.2 — Missed check-in → `checkin_missed`, severity 3, `source: server`.
- [x] B2.3 — High Alert re-buzz at a randomised 300–600 s, `next_buzz_at` held server-side. Each buzz opens a real `checkins` row, so ignoring the buzz escalates by the same path as ignoring a parent.
- [x] B2.4 — Heartbeat watchdog: 3 min of silence while armed → `watch_lost`, severity 3, carrying the last position the phone reported.
- [x] B2.5 — `POST /heartbeat` and `GET /watch/{member_id}`.

Pulled forward from B3 because B2 cannot be demonstrated without them:

- [x] B3.1 — `POST /checkin/{member_id}` now writes a `checkins` row with `due_at`; `POST /checkin/{id}/ack` added. An `checkin_ack` alert from the band or app closes **every** open question, so one press of "I'm fine" cannot leave a second deadline running.
- [x] B3.2 — `POST /watch/high_alert`. The band's hold-3s now arms a mode that outlives the app.

App side: [src/watch.js](nigehban-app/src/watch.js) beats every 60 s while armed
(foreground only until N2), and `buzz_now` drives the same check-in sheet a
family member's request does.

**Unblocked:** U3.1, U3.2, U4.2, and matrix rows 9, 15, 19.
**Done when:** ~~with no phone connected at all, a check-in created by curl escalates on its own deadline.~~ It does — see the B2 section of
[tests/test_consent_and_sweeper.py](tests/test_consent_and_sweeper.py), plus
[tests/test_sockets.py](tests/test_sockets.py) for delivery on the live socket.

### B3 · Feature endpoints · Owner M3 · Phase 3 · ~6 h

- [x] B3.1 — ~~`POST /checkin/{member_id}` reworked to write a `checkins` row with `due_at`; add `POST /checkin/{id}/ack` for band or app.~~ Shipped with B2, which needs it.
- [x] B3.2 — ~~`POST /watch/high_alert` — arm/disarm.~~ Shipped with B2, same reason.
- [x] B3.3 — `POST /presence` — geohash6 plus lat/lon rounded to ~100 m, one row per person, overwritten. A presence, not a trail, and only read while it is fresh.
- [x] B3.4 — `POST /samaritan/{alert_id}/respond` — releases the name and the exact pin, logs the responder against the alert, and tells the wearer and their family who is coming. A severity-5 alert carrying a position now fans an anonymous, coarse copy out to fresh presences within 800 m. Both are covered by [tests/test_samaritan_and_checkin.py](tests/test_samaritan_and_checkin.py).
- [ ] B3.5 — Qwen severity scoring + Urdu dispatch text via Model Studio. *Cut line Day 3 21:00 → fall back to `RiskEngine._template`, which already works.*
- [ ] B3.6 — WhatsApp fan-out.

**Done when:** every in-scope feature answers correctly to curl before any phone is involved.

### B4 · Hardening · Owner M3 · Phase 5 · ~2 h

- [x] B4.0 — **Push TTL.** 26 Aug 2026 — `send_expo_push_notifications()` sent no `ttl`, so every push inherited Expo's four-week default. A severity-5 push queued while a phone was in a tunnel could ring at 3 a.m. the next day, long after the wearer stood the alert down — and a family member woken by a siren for an emergency that ended yesterday learns to distrust the siren, which is the whole product. Now **300 s for severity ≥ 4**, 3600 s for the rest. Deliberately not `0`: "deliver this instant or discard" throws away real alerts over a two-second blip.
- [ ] B4.1 — Rate limits on every write endpoint.
- [ ] B4.2 — Structured logging keyed by alert id, so a failed demo is diagnosable in 30 seconds.
- [ ] B4.3 — Redis/Tair for WS fan-out across workers — *only if more than one worker ships*.
- [ ] B4.4 — Token refresh is **explicitly cut** (exec plan §12). Say so on the roadmap slide rather than half-building it.

---

## 5. Android platform — `nigehban-app/plugins/`, `modules/`

Everything here is JavaScript (exec plan §7.0). Nobody writes Kotlin.

> **The trap that costs a day.** `android/` is gitignored generated output.
> Anything hand-edited there is silently deleted by the next
> `expo prebuild --clean` or any EAS build from a clean checkout. Native changes
> live in the config plugin or a local Expo module — nowhere else.

### N1 · Config plugin + dev build · Owner M2 · Phase 0 · ~3 h

> **Audited 26 Aug 2026 — this milestone was marked open and is substantially
> done.** The checkboxes below had not been updated since the plan was written.

- [x] N1.1 — `plugins/withNigehbanAndroid.js` exists and is registered at [app.json:76](nigehban-app/app.json#L76). It adds nine manifest permissions: the four `FOREGROUND_SERVICE*` variants, `RECEIVE_BOOT_COMPLETED`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, `USE_FULL_SCREEN_INTENT`, `WAKE_LOCK`, `ACCESS_BACKGROUND_LOCATION` — on top of the nine in `app.json`.
- [x] N1.2 — `expo-battery` **is** installed (`~57.0.2`), along with `expo-task-manager` and `expo-dev-client`. ~~`@notifee/react-native` is genuinely still missing.~~ **Closed 26 Aug 2026 by removing the requirement, not by meeting it:** Notifee was archived on 7 Apr 2026 and never supported the New Architecture, so it could not have been installed here at all. What it was needed for is now [`modules/nigehban-alarm/`](nigehban-app/modules/nigehban-alarm/) — see N3.3. **No new dependency was added.**
- [x] N1.3 — Done. `extra.eas.projectId` is set, the `development` profile builds an APK, and the proof it is installed is behavioural: **push reaches a force-stopped app**, which Expo Go on Android cannot do at all since SDK 53.
- [ ] N1.4 — Drop `usesCleartextTraffic` once the cloud has TLS (D2), not before. Still correctly open — [app.json:54](nigehban-app/app.json#L54).

**Blocks:** ~~J1~~ — unblocked. **Done when:** ~~the dev-build APK is installed on two phones and the manifest carries all ten permissions.~~ Observed; the manifest carries eighteen.

### N2 · Foreground service · Owner M2 · Phase 2 · ~8 h

The hardest single task on the board.

- [x] N2.1 — `Location.startLocationUpdatesAsync(WATCH_TASK, …)` with the `foregroundService` block from exec plan §7. Shipped once already, but silently dead: `expo-task-manager` was never in `package.json`, so `bgService.js`'s `require()` failed and `startBackgroundWatch()` always returned `false` with no error surfaced anywhere. Fixed 2026-08-25 — dependency installed, failures now logged and visible in Setup's diagnostics panel (step 5).
- [x] N2.2 — BLE reconnect loop that survives the app being swiped from Recents (matrix #10, #12). Fixed 2026-08-25 — `band.js`'s `onDisconnected` previously just set status to `disconnected` and stopped; an unexpected drop now retries `connect()` after 3 s, distinguished from a deliberate `disconnect()` via a `wantsConnection` ref so the retry doesn't fight the user's own button. Depends on N2.1 actually keeping the JS runtime alive to retry from.
  - **Scan had no timeout. Fixed 26 Aug 2026.** A BLE scan has no natural end: if the band is off, out of range, or already bonded elsewhere, `startDeviceScan` simply never calls back, so the UI sat on *Searching* forever with nothing to press and no retry. Now capped at 10 s → a `not-found` status that Home renders as **"Band not found"**, then the same retry path. The scan-**error** branch (Bluetooth switched off mid-scan, permission revoked, adapter reset) had no retry either and left the hook dead; all three exits now route through one `retrySoon()`, and `disconnect()`/unmount stop the scan.
- [x] N2.6 — **When the service runs, not just that it runs. 29 Aug 2026.** It used to start for anybody signed in, so a family member watching from across town held a permanent service, a permanent notification and the `ACCESS_BACKGROUND_LOCATION` prompt for a process with nothing to keep alive — their alerts arrive by push, which works with the app dead. It now starts on either of two independent conditions: a band is linked (`nigehban.band.id` present *and* BLE mode), or the phone is armed at all (`watchMode !== 'idle'`). The second one is not optional: `useHeartbeat` only beats while armed, and that is exactly the state where three minutes of silence makes the sweeper page the whole family with `watch_lost` — so killing an armed phone's process makes it report its own wearer missing. Deliberately **not** keyed off the live connection: a band out of range is precisely when `band.js`'s retry loop needs the process alive. `wantsBand()` returns `true`/`false`/`null` so a failed storage read cannot be mistaken for "no band" and tear down a live link.
- [ ] N2.3 — Boot receiver → service restarts and reconnects in under 60 s (matrix #11).
- [ ] N2.4 — WorkManager watchdog: is the service alive, is BLE connected, is the socket up. **Watchdog only** — never a timer; the 15-minute floor makes it useless as one.
- [x] N2.5 — `isIgnoringBatteryOptimizations()` surfaced in the UI — Setup.js step 4, "BATTERY: SET TO UNRESTRICTED".

**Done when:** the Phase 2 exit gate — phone locked, screen off, app swiped from Recents, 20 minutes in a pocket, press the band, the family phone rings.

### N3 · Push + alarm · Owner M2 · Phase 2 · ~4 h

- [x] N3.1 — **Done, audited 26 Aug 2026.** This entry said the FCM project "has never been created". It has: `nigehban-app/google-services.json` is a real Firebase config for project **`nigheban-d126d`**, package `com.nigehban.app`, referenced from [app.json:22](nigehban-app/app.json#L22); the service-account key is gitignored by pattern (`*firebase-adminsdk*.json`) with the reasoning written into `.gitignore`. Landed across `a537bd9` → `57b8350`. **Confirmed working end to end: a push arrives at a force-stopped app.** The one-time steps below are kept as the runbook for a second Firebase project or a credential rotation, not as outstanding work:
  1. console.firebase.google.com → create a project → add an Android app with package `com.nigehban.app` → download `google-services.json` into `nigehban-app/`.
  2. Add `"android": { "googleServicesFile": "./google-services.json" }` to `nigehban-app/app.json`.
  3. `eas credentials` → Android → push notifications → upload the Firebase service account key (Project settings → Service accounts → Generate new private key, in the Firebase console).
  4. Rebuild (`eas build -p android --profile development`), sign in, let it register a push token, then `curl -H "Content-Type: application/json" -d '{"to":"<token from server/nigehban.db devices table>","title":"test","body":"hi"}' https://exp.host/--/api/v2/push/send` and check the terminal running `nigehban_server.py` — the server logs the same ticket status now, so a failed send shows the reason without touching the phone again.
- [ ] N3.2 — Alarm-importance channel with DND bypass, via `expo-notifications`. Channel itself exists (`notifications.js`), untestable end-to-end until N3.1 lands.
  - **The channel was created and then never used. Fixed 26 Aug 2026.** `sendEmergencyAlarmNotification()` built the MAX-importance, DND-bypassing channel and then dispatched with `trigger: null`, which files the notification on Android's *default* channel — so a severity-5 SOS would have arrived silently under Do Not Disturb, the one condition the channel exists for. In expo-notifications the channel is chosen by the **trigger**, not the content (`ChannelAwareTriggerInput`; `NotificationContentInput` has no `channelId` field), so this is `trigger: { channelId: EMERGENCY_CHANNEL_ID }`. On iOS the parser resolves it to `null`, i.e. the same instant dispatch as before. App.js's `notify()` had the identical bug against `nigehban_default` and got the same fix.
- [◐] N3.3 — Full-screen intent over the lock screen (matrix #6 — fires with the family app **killed**). ~~via Notifee~~ — **built in-house, 26 Aug 2026.**
  - **Notifee is dead, and the plan could not have known.** Invertase archived [invertase/notifee](https://github.com/invertase/notifee) on **7 Apr 2026**; the last publish was `9.1.8` in December 2024, and it never supported the New Architecture — which Expo 57 / RN 0.86 is, exclusively. So the one dependency N1.2 was still waiting on was never going to arrive. `expo-notifications@57.0.12` has no full-screen-intent API either; the shipped `.d.ts` files were grepped before concluding that.
  - `react-native-notify-kit` — a community fork, same public API, New Arch, ~34.8k downloads/week — was the obvious substitute and was **deliberately not taken**. It is five months old and has one unpaid maintainer, and Nigehban needs two of Notifee's fifty-odd APIs. Putting the emergency siren behind a dependency that has already died once under this project is a worse risk than owning ninety lines.
  - **What was built:** [`modules/nigehban-alarm/`](nigehban-app/modules/nigehban-alarm/), a local Expo module, autolinked from `modules/` with no config entry (verified with `expo-modules-autolinking search -p android`). `presentAlarm()` posts a `CATEGORY_CALL` notification with `setFullScreenIntent(pi, true)` on its own silent `IMPORTANCE_HIGH` channel; `stopAlarm()` tears it down; `consumeLaunchAlertId()` reads the alert out of the launching intent so a cold start knows why it woke.
  - **The permission was already there and was not enough.** `USE_FULL_SCREEN_INTENT` buys the right to *fire* the intent; what happens next is the launched activity's business. Without `android:showWhenLocked` and `android:turnScreenOn` on MainActivity, Android brings the app up *behind* the lock screen with the display off — an SOS that fired perfectly and is waiting under a black screen. Both are now set by `withNigehbanAndroid.js`, verified via `expo config --type introspect`.
  - **The killed-app half needs a second push.** `presentAlarm` needs JS running, and the case the feature exists for is the one where it is not. Only a **data-only** push starts a headless runtime on a terminated Android app — a push with a title is drawn by the system and the app is never woken. So `emit_alert` now sends severity ≥ 4 **twice**: the visible push, unchanged, plus a silent one carrying `kind`/`name`/`maps`, which `src/bgNotifications.js` turns into the alarm. Sent in addition, never instead: Doze can still drop the silent one, and then the visible notification and its tap routing are what is left. Payload shapes verified against the real send path.
  - **Not yet observed on hardware.** There is no JDK or Android SDK on this machine, so the Kotlin has been written and read but not compiled — that happens on the next EAS build. Setup → **TEST THE LOCK-SCREEN ALARM** runs the exact production path on one phone in ten seconds, which is how this gets closed.
  - **Tap routing landed 26 Aug 2026, ahead of the full-screen intent.** There was no `addNotificationResponseReceivedListener` anywhere in the tree, so tapping an SOS push cold-launched the app to the Home tab with no idea an alert was involved — the push arrived correctly and then dead-ended. `subscribeNotificationTaps()` in [notifications.js](nigehban-app/src/notifications.js) now reads `alertId`/`alert_id` (the local and remote paths spell it differently), also checks `getLastNotificationResponseAsync()` for the tap that *launched* the app, and clears it so a later unrelated launch does not replay the same alert. App.js holds the id until a session exists, then fetches `/alerts?scope=incoming` and drives the existing takeover modal. Still needs N3.1 before the push it routes can actually be delivered.
- [◐] N3.4 — Siren + vibration until dismissed. **Built 26 Aug 2026, same module.**
  - A notification sound plays once, from the channel, at whatever volume Android picks. This owns a `MediaPlayer` on `STREAM_ALARM` with `isLooping = true` instead, plus `VibrationEffect.createWaveform(pattern, 0)` — repeat index 0, i.e. forever. The alarm stream is also the answer to Do Not Disturb: `setBypassDnd(true)` on a channel is silently ignored without Notification Policy Access, which almost no app has, whereas `USAGE_ALARM` audio is exempt by default.
  - The stream volume is raised to maximum and restored on stop. If the process dies mid-alarm it stays up — the right direction to fail in here, and cheaper than the machinery to guarantee otherwise.
  - **"Until dismissed" is enforced in one place.** `App.js` stops the alarm from an effect keyed on `incoming` going null, not from each button, so a fourth exit cannot be added later that leaves a siren running. The map button is the single explicit call, because it deliberately does *not* close the takeover.

**Done when:** matrix rows 5 and 6 pass on three phones.

---

## 6. Firmware — `nigehban_band_nrf52/`

### F1 · Board bring-up · Owner M4 · Phase 0 · ~3 h

- [x] F1.1 — Install **Seeed nRF52 Boards** (Adafruit Bluefruit core, *not* the mbed variant). `Seeeduino:nrf52@1.1.13` + `Seeed Arduino LSM6DS3`; all bench sketches compile.
- [x] F1.2 — Blink, then advertise as `Nigehban-01`; verify in **nRF Connect** — no Nigehban app needed, so this waits on nobody. Passed via [t6_ble](firmware/t6_ble/).
- [x] F1.3 — `BLEUart` up. It is literally the Nordic UART Service the app already speaks. Notify and write both verified round-trip in nRF Connect. **This verification was not sufficient — see F1.4.** nRF Connect shows bytes arriving on TX, which looks like a pass; it does not show that the line was cut off at 23 of 86 bytes, because there is no line framing in a hex dump. The truncation survived until the app tried to parse a newline that never came.
- [x] F1.4 — **First end-to-end link to the Nigehban app. 27 Aug 2026.** Five independent faults, each of which alone was enough to produce "connected, no data". Detailed in §"Bring-up: five silent faults" below.

### F2 · Port the gesture layer · Owner M4 · Phase 0–1 · ~5 h

- [x] F2.1 — Move `Button`, `Pattern`, `onGesture`, `handleCommand` **verbatim** from the ESP32 prototype onto `bleuart`. The protocol is frozen (exec plan §5); the app must not notice the swap. All gestures and commands verified against nRF Connect. **The prototype sketch was deleted from the tree on 27 Aug 2026** — the nRF52 sketch is now the only firmware, and `git show 70c5176:nigehban_band_esp32/nigehban_band_esp32.ino` is the record.
- [x] F2.2 — Delete the MPU6050 path. The XIAO Sense has an LSM6DS3TR-C on board at `0x6A`; porting the external-IMU code would be work spent on hardware you do not need. LSM6DS3 block present but `#if HAS_IMU 0` until F3; both paths compile.
- [ ] F2.3 — Real battery: enable the divider on `P0.14`, read `P0.31`, calibrate against a multimeter. **Code written, NOT calibrated** — `VBAT_DIVIDER_COMP` is still a guess and no LiPo has been connected. See the `VBAT_ENABLE` hardware warning in [firmware/README.md](firmware/README.md).
  - **It is also unstable, not merely uncalibrated. Found 27 Aug 2026, not fixed.** Consecutive heartbeats alternate between two settled values — `mv:4085`/93% and `mv:3699`/39% — on one board, on one continuous `seq`. The divider's source impedance (1M ∥ 510k ≈ 338k) is far too high for the SAADC's default acquisition window, so the sample capacitor never fully charges and each conversion is dragged toward the previous one. Averaging 8 back-to-back reads in `batteryMilliVolts()` does not help: every sample is equally under-settled. Fix is a longer acquisition time, or a median-of-N with a gap between samples — a median rejects the alternating outlier, a mean does not. **This was a safety path, and is now a smaller one.** It used to raise `low_battery` **and** `going_dark` — severity 3, "phone about to die" — straight from this number, so the band paged the family about a flat battery that was not flat. Since 29 Aug 2026 those two come from the *phone's* own battery (U3.4), and only the new severity-1 `band_battery` rides this reading. The blast radius dropped from a false emergency to a false maintenance notice.

    Latching on a single reading still turned the alternation into an alert every other heartbeat, so [App.js](nigehban-app/App.js) now requires `BAND_LOW_STREAK` (3) consecutive readings below the threshold — an alternating signal never produces two in a row — plus a `+3` re-arm margin. **That is a workaround, not the fix.** The fix is still this item: a longer acquisition time, or a median-of-N with a gap between samples. Delete the streak guard when it lands.

> **Tap timing changed during F2.1.** The band originally waited for a tap burst
> to close before classifying it, so two *slow* taps became two `checkin_ack`s —
> the family told "I'm fine" by someone calling for help. The fix fires `sos` on
> the second tap itself and makes `checkin_ack` wait `TAP_WINDOW_MS` (1200 ms).
>
> **Corrected 26 Aug 2026 — this note said `virtualBand.js` had not caught up.
> It has**, and had already: `TAP_WINDOW_MS = 1200` with SOS on the second tap
> at [virtualBand.js:271](nigehban-app/src/virtualBand.js#L271). The stale note
> was claiming a live safety bug in the file the whole no-hardware test plan
> runs on.
>
> **Closed 27 Aug 2026.** The one file that never caught up was the ESP32
> prototype, which still finalised on `CLICK_GAP_MS` (420 ms) and never fired
> SOS on the second tap. It was also the sketch F5.1 designated as the spare
> band — a spare carrying a known false-"I'm fine" failure is worse than no
> spare, because it will be trusted. The choice was port the six lines or
> strike F5.1; **the board was retired instead, which strikes F5.1.** Both
> surviving implementations — the nRF52 sketch and `virtualBand.js` — use
> `TAP_WINDOW_MS`, so the tree no longer contains the bug anywhere.

**Done when:** the Phase 1 gate — a button press on the nRF52840 raises an SOS visible on a second phone over the internet, both phones on mobile data.

### F3 · IMU / fall · Owner M4 · Phase 2 · ~5 h

- [ ] F3.1 — IMU at `0x6A`; 26 Hz at rest, 104 Hz for 3 s after motion.
- [ ] F3.2 — Fall state machine on the exec plan §8 starting thresholds (free-fall → impact → stillness → orientation change).
- [ ] F3.3 — **CSV logging to serial from Phase 2 onward.** This data cannot be collected retroactively, and untuned thresholds are the fastest way to lose a judge's trust: a bag falling off a chair must not page a mother at 2 a.m.

### F4 · Hardware build · Owner M4 · Phase 0–2 · ~4 h

- [ ] F4.1 — Motor driver per exec plan §9: transistor (or MOSFET), flyback diode, **100 µF bulk cap**. Never drive the motor from a GPIO pin — a coin ERM pulls 60–100 mA at start.
- [ ] F4.2 — LiPo via JST-PH. Meter polarity before connecting; use a connector, not solder.
- [ ] F4.3 — Power budget: advertise at 100 ms, longer connection interval when idle, LED off in normal operation, never `delay()` in `loop()`.

> *If the band disconnects whenever it buzzes, the 100 µF cap is what's missing.*

### F5 · Spare band · Owner M4 · Phase 5 · ~30 min — ✗ **struck 27 Aug 2026**

- [x] ~~F5.1 — Keep the ESP32 flashed with the final gesture map and charged.~~ **Struck.** The ESP32 was retired from the project and its sketch deleted from the tree, so the free spare is gone. It was already blocked (see the tap-timing note under F2), and shipping a spare with a known false-"I'm fine" failure was never an option.

> **Consequence, stated plainly: there is no spare band for demo day.** A dead
> or bricked XIAO now costs the live hardware demo, and the fallback is the
> virtual band plus the Q2.3 video. If a second XIAO is within budget, buying
> one is the cheapest insurance on the board — the firmware flashes onto it
> unchanged. Otherwise Q3.2's "dead band" contingency drill stops being a
> formality and becomes the actual plan.

---

## 7. Deployment — Alibaba Cloud

**Build local, prove it works, then deploy.** Phases 0–3 run on the laptop with
ngrok as the transport. That is not a shortcut — it is what makes Phase 4 a
lift-and-shift of a proven system instead of debugging features and
infrastructure at the same time.

### D0 · Account paperwork · Owner M3 · Phase 0 · 5 min, then it waits

- [ ] D0.1 — File Alibaba account verification **today**. Identity checks and credit approval take hours to a day and no engineering compresses that. Filing it now costs five minutes and removes the only external-latency risk from Phase 4.

### D1 · Pipeline spike · Owner M3 · Phase 2 evening · 30 min

- [ ] D1.1 — Throwaway ECS + Docker + Caddy + a stub FastAPI returning `{"ok":true}` over HTTPS.

The point is to prove the *pipeline*, not to deploy the app — while there is
still a day of slack in which to discover that the security group is wrong.

### D2 · Lift and shift · Owner M3 · Phase 4 · ~4 h

One change at a time, verify between each.

| # | Step | Verify before continuing |
|---|---|---|
| 1 | ECS 2 vCPU / 4 GB Ubuntu 22.04, `ap-southeast-1` or `me-central-1`; inbound 22 (your IP only), 80, 443 — **never 8000** | `curl https://host/health` from outside |
| 2 | The FastAPI app, **unchanged**, same SQLite file; `docker compose` = caddy + api | Phase 1 gate passes against the cloud |
| 3 | App base URL repointed — one line, thanks to U1; ngrok still running in parallel | Phases 2 and 3 gates pass against the cloud |
| 4 | Database migrated to RDS Postgres | Full acceptance matrix |
| 5 | Redis/Tair, Model Studio, CloudMonitor | Each as its feature needs it |
| 6 | Kill ngrok | Nothing in the tree or the demo references the tunnel |

- [ ] D2.1 — `Dockerfile`, `docker-compose.yml`, `Caddyfile` committed under `deploy/`.
- [ ] D2.2 — Caddy issues and renews Let's Encrypt itself. That is what lets `usesCleartextTraffic` be deleted (N1.4), and it answers the security question judges ask.

### D3 · Cutover · Owner M3 · Phase 4 · ~2 h

- [ ] D3.1 — Re-run the Phase 1, 2 and 3 exit gates against the cloud.
- [ ] D3.2 — Kill ngrok.
- [ ] D3.3 — Snapshot the ECS disk; write credentials in one place the whole team can reach.

**Done when:** every feature works with the laptop **physically shut**, and the word "ngrok" appears nowhere in the demo.

**Hard cut lines.** RDS not clean by Day 4 midday → stay on SQLite with an OSS
snapshot; a working demo on SQLite beats a broken one on Postgres, and no judge
deducts for it. Cloud collapses entirely by Day 4 14:00 → demo on ngrok and say
so plainly. D0 and D1 exist so this fallback is never used.

---

## 8. QA & release

### Q1 · Feature freeze · Phase 5 · **Day 4, 14:00, no exceptions**

- [ ] Q1.1 — Release APK built against the cloud.
- [ ] Q1.2 — Fall thresholds calibrated against the CSV from F3.3.

### Q2 · Acceptance matrix · Owner M4 · Phase 5 · ~4 h

- [ ] Q2.1 — All 20 rows of exec plan §11, on **three phones including the worst OEM you own**, on the release APK, against the cloud.
- [ ] Q2.2 — Record pass/fail with a timestamp. Anything failing on the demo path outranks every unbuilt feature.
- [ ] Q2.3 — Fallback video recorded. **Non-negotiable**, stored on two laptops.

### Q3 · Rehearsal · Phase 6 · Day 5

- [ ] Q3.1 — Three timed dress rehearsals with real hardware, standing up.
- [ ] Q3.2 — Contingency drills: no venue Wi-Fi · dead band · unreachable server · phone reboot.
- [ ] Q3.3 — Ten slides, including exec plan §13 — the v2 roadmap specified to the wire-protocol level.
- [ ] Q3.4 — No code except a crash fix, and two people must agree.

---

## 9. Compression — if the sprint dates are live

Day 1 of the plan has not landed in the tree and today is Day 2. Two honest
options; either beats pretending the original board is intact.

**Option A — run Phase 0 today, compress Phases 2 and 3 into Day 3.**
Keeps all seven features. Requires four people in genuine parallel, and it puts
the two longest poles (N2 foreground service, F2 firmware port) in the same day
as the features that depend on them. Highest risk of reaching Day 4 with nothing
integrated.

**Option B — take two of the planned cuts now, keep the phase boundaries.**
Drop **Good Samaritan** (B3.3, B3.4, U4.4) and **Qwen dispatch** (B3.5). Both
are already the designated Day 3 cut lines in exec plan §12. That returns about
10 person-hours and moves them onto the roadmap slide beside mesh SOS and
anti-theft, which is already the strongest part of the pitch.

**Recommended: B.** Those cut lines were chosen in advance precisely so the
decision would not have to be made at 21:00 on Day 3 under pressure. Taking them
early is using the plan, not abandoning it — and the Phase 2 exit gate (locked
phone, app swiped away, band press rings the family) *is* the demo. Protect the
day it needs.

Either way, the ordering that must not change: **U1 and B1 before anything, N1
queued in hour one, D0 filed today.**

---

## 10. Definition of done

A milestone is done when **all** of these hold. Anything less is in progress,
and the board should say so.

1. The **Done when** check has been observed, not reasoned about.
2. It works against the transport it will ship on — ngrok in Phases 0–3, the cloud from Phase 4.
3. It survives the app being killed, wherever that is meaningful.
4. Its acceptance-matrix rows pass.
5. Nothing native was hand-edited inside `android/`.

---

## 11. Tracking

| Milestone | Owner | Phase | Est | Status |
|---|---|---|---|---|
| V1 Virtual band | M1 | 0 | 6 h | ☑ done |
| G1 Gesture map aligned to §5 | M1/M4 | 0 | 1 h | ☑ done |
| U1 Configurable transport | M1 | 0 | 2 h | ☑ done |
| U2 Client state machine | M1 | 0 | 4 h | ☑ done |
| U3 Safety-feature UI | M1 | 2–3 | 8 h | ☑ done |
| U4 Family-side UI | M1 | 2–3 | 6 h | ☑ done |
| U5 Onboarding & polish | M1/M2 | 3 | 4 h | ☑ done |
| U6 Design system | M1 | 3 | 6 h | ☑ done |
| B1 Consent + schema | M3 | 0 | 4 h | ☑ done |
| B2 The sweeper | M3 | 2 | 5 h | ☑ done |
| B3 Feature endpoints | M3 | 3 | 6 h | ◐ B3.1–B3.4 done; Qwen and WhatsApp open |
| B4 Hardening | M3 | 5 | 2 h | ◐ B4.0 push TTL done; rest open |
| R1 Silent-failure pass (§14) | M1/M2/M3 | — | 4 h | ◐ 8 fixed, 3 verified |
| N1 Config plugin + dev build | M2 | 0 | 3 h | ◐ N1.1/N1.2/N1.3 done; N1.4 waits on D2 |
| N2 Foreground service | M2 | 2 | 8 h | ◐ N2.1/N2.2/N2.5/N2.6 done, **N2.6 untested on hardware**; boot receiver + watchdog open |
| N3 Push + alarm | M2 | 2 | 4 h | ◐ N3.1 observed; N3.2 fixed §14; N3.3/N3.4 **built, await one EAS build** |
| F1 Board bring-up | M4 | 0 | 3 h | ☑ done |
| F2 Port the gesture layer | M4 | 0–1 | 5 h | ◐ F2.1/F2.2 done; battery uncalibrated |
| F3 IMU / fall | M4 | 2 | 5 h | ☐ `HAS_IMU 0` on both sketches |
| F4 Hardware build | M4 | 0–2 | 4 h | ☐ |
| F5 Spare band | M4 | 5 | — | ✗ struck 27 Aug — ESP32 retired, no spare exists |
| D0 Account paperwork | M3 | 0 | 5 m | ☐ |
| D1 Pipeline spike | M3 | 2 | 0.5 h | ☐ |
| D2 Lift and shift | M3 | 4 | 4 h | ☐ |
| D3 Cutover | M3 | 4 | 2 h | ☐ |
| Q1 Feature freeze | all | 5 | — | ☐ |
| Q2 Acceptance matrix | M4 | 5 | 4 h | ☐ |
| Q3 Rehearsal | all | 6 | — | ☐ |

Totals by track: **M1 24 h · M2 19 h · M3 21.5 h · M4 17.5 h.** That arithmetic
is the reason exec plan §0 cut two features before the sprint started — and the
reason §9 above exists now.

---

## 12. Resolved — the gesture map

The protocol disagreed with itself: `EXECUTION_PLAN.md` §5 and the `.ino` named
different gestures for SOS and for hold-3s. **Decided 21 Aug 2026: follow the
exec plan.** All three files now agree.

| Gesture | Event | Meaning |
|---|---|---|
| 1 tap | `checkin_ack` | "I'm fine" — answers a check-in, or stands down a live SOS |
| 2+ taps | `sos` (`src: double_tap`) | SOS |
| hold 3 s | `high_alert_on` / `high_alert_off` | toggles High Alert |
| IMU | `fall` | fall state machine |
| every 10 s | `hb` | heartbeat, never an alert |

Changed in lockstep:
the ESP32 prototype (since retired) ·
[nigehban_band_nrf52.ino](nigehban_band_nrf52/nigehban_band_nrf52.ino) ·
[virtualBand.js](nigehban-app/src/virtualBand.js) ·
[bandLink.js](nigehban-app/src/bandLink.js) ·
[band.js](nigehban-app/src/band.js) ·
[App.js](nigehban-app/App.js) ·
[Band.js](nigehban-app/src/screens/Band.js)

Three deliberate choices inside that, each worth knowing about:

1. **Two taps is SOS — and so are three, four, five.** A frightened person does
   not tap a precise number of times, and the failure mode of being strict is a
   silent no-op at the exact moment the product has to work. This is why exec
   plan §5's *v2* reservation of 4 taps for `armed` cannot simply be added
   later as written: it would let an over-tapped SOS arm anti-snatch instead of
   calling for help. That gesture needs its own affordance when v2 comes.

2. **Nothing is bound to a 5 s hold.** Anti-snatch was dropped from the map on
   22 Aug 2026 — the feature is deferred, so a gesture for it is a threshold
   the wearer has to learn, avoid crossing by accident, and tell apart by buzz
   count, in exchange for nothing that works yet. Removing it also removes the
   one rough edge in the map: holding past 3 s used to fire both. The wearer
   now has two things to remember — *tap twice for help, hold to be watched*.

   The hooks stayed: `armed` / `disarmed`, the `armed` wire field, the hub's
   snatch detection and the console's SNATCH button all still work, so the
   alert path is testable. Restoring the gesture is one row in
   `DEFAULT_GESTURES` plus the commented block in the `.ino` — which is what
   the table was for.

3. **High Alert is local state for now.** It is a server-owned mode: the server
   has to hold `next_buzz_at` and re-buzz on its own, or the feature dies with
   the app. Until **B3.2** ships `POST /watch/high_alert`, the app acknowledges
   the toggle and says only what it actually did, rather than implying the
   family was told.

### Next: make it configurable

The map is now **data**, not an if-chain —
`DEFAULT_GESTURES` in [virtualBand.js](nigehban-app/src/virtualBand.js), and one
clearly marked block in the `.ino`. A settings screen that lets a wearer remap
gestures edits that array; nothing else has to change. That is the planned
follow-up, and the structure is already in place for it.

Two constraints for whoever builds it: a remapped band and a remapped phone
must stay in sync (the map has to travel over the wire or via the server, not
live in two places), and **SOS must not be remappable into something harder to
reach than it is today**.

---

## 13. Resolved — pairing, consent, and what the server will tell a stranger

**Decided 22 Aug 2026 with B1.** The old `POST /family` linked two accounts, in
both directions, the instant anyone typed a code. No acceptance, no
notification, nothing to refuse.

The obvious fix is an accept button. That is necessary and it is not
sufficient, because the code itself was the deeper problem.

### What was actually wrong

1. **No consent.** One party's action created a two-way link.
2. **A permanent bearer secret.** `NGB-4F2A` is you, forever, and it is printed
   on your own screen. One screenshot, one glance over a shoulder, one old
   WhatsApp message, and somebody holds a key that cannot be taken back.
3. **The endpoint was a directory.** A wrong code returned *"no one is using the
   code NGB-XXXX"* and a right one returned a name. Four characters from a
   32-symbol alphabet is about a million possibilities — hours of scripted
   guessing, and every hit came back with a real person's real name attached.
4. **Nothing was rate-limited**, so (3) was free, and so was password guessing.
5. **The database was a list of live sessions.** `users.token` was stored in the
   clear; a copied `nigehban.db` was every account, signed in.

### What replaced it

**Two paths, one rule: a link requires two people to have each done something.**

| | How consent is proven | Result |
|---|---|---|
| **Pairing code** (`POST /pair` → `POST /invite`) | One issues, the other redeems, inside ten minutes | Linked immediately |
| **User code** (`POST /invite` → `POST /invite/{id}/accept`) | One asks, the other accepts | Linked on acceptance |

The pairing code is the primitive the app now leads with. It lives ten minutes,
works exactly once, carries no identity, and dies when a new one is issued. A
screenshot of it is worthless tomorrow. That is the difference between a key and
a coupon, and a safety product should be handing out coupons.

The permanent code stays, because "add me when you get a chance" is a real need
and a ten-minute window cannot serve it. It is the second option on the screen,
and it now only ever produces a **request**.

### Three decisions worth defending

1. **An invite to a code that exists and an invite to a code that does not
   return byte-identical responses.** So the app cannot say "sent" — it says
   *"if that code belongs to someone, they have been asked."* That is worse
   copy and a much better product: without it, the endpoint answers the
   question "does this person have a Nigehban account?" for anybody who asks a
   million times, which is precisely the question a person hiding from someone
   needs it not to answer. The typo case is the price, and it is the right way
   round.

2. **A decline is permanent, and silent — including in the sender's own list.**
   The sender keeps seeing "asked, not answered yet" forever, and re-inviting
   returns the same cheerful response while doing nothing at all. If declining
   sent a notification, declining would become a thing you might not dare do,
   and a product for people who are afraid of somebody must never make refusing
   them the risky option. This one was caught by a test: the first
   implementation dropped declined rows from the outgoing list, which meant
   *disappearing* was the notification.

3. **Rate limits are sized per-account first, per-network second.** Everyone in
   a house, a classroom or a demo room shares one public IP, so a tight
   per-IP limit does not stop a script — it stops a family signing up together.
   The per-account bucket is the real control; the per-IP one is the backstop
   against making accounts to escape it, set at 120 lookups an hour, which
   against a million codes is four and a half years to a coin flip.

Session tokens are now stored as SHA-256, like passwords, and a fresh sign-in
invalidates the previous session — the cheapest "I lost my phone" there is.

### What is still open

- **Links are mutual.** Accepting means you each see the other's alerts. That is
  stated plainly on the accept screen now rather than assumed, but a directional
  model (*A may watch B, without B watching A*) is the more honest fit for some
  of these relationships. It is a schema change and it is cheapest before there
  is real data — worth doing in B4 if the time exists.
- **Tokens do not expire.** Hashing them limits the blast radius of a stolen
  database; it does nothing about a stolen phone. B4.
- **CORS is still `*`**, which is defensible for a tunnelled dev box holding
  test accounts and indefensible the moment D2 puts this on a real host.

---

## 14. Resolved — the silent-failure pass, 26 Aug 2026

Eight defects, found by review rather than by a test failing. They are grouped
here because they share a shape worth naming: **every one of them looks like
working software.** Nothing throws, nothing logs, the UI says the right thing —
and the alert does not arrive. In a product whose entire promise is *someone
will know*, that class of bug outranks any unbuilt feature.

| # | Where | What it looked like | What was happening |
|---|---|---|---|
| 1 | [CheckinBanner.js](nigehban-app/src/components/CheckinBanner.js) | The family member's screen closed itself | `s.head` with no `s` — a `ReferenceError` every render, and no error boundary, so React unmounted the tree |
| 2 | [notifications.js](nigehban-app/src/notifications.js) | Push arrives, tap does nothing useful | No response listener anywhere; every tap cold-launched to Home |
| 3 | [api.js](nigehban-app/src/api.js) | Header says **connected** | NAT-dropped socket, half-open for minutes, no ping to notice |
| 4 | [band.js](nigehban-app/src/band.js) | Stuck on **Searching** | BLE scan with no timeout, and a scan-error branch with no retry |
| 5 | [App.js](nigehban-app/App.js) | *EMERGENCY* with no map link | `raise()` read a fix only the Home tab feeds |
| 6 | [state.js](nigehban-app/src/state.js) | Band stops buzzing, screen says nothing | `checkin_missed` fell through to `default: return null` |
| 7 | [nigehban_server.py](server/nigehban_server.py) | Siren at 3 a.m. for yesterday | No `ttl`, so Expo's four-week default applied |
| 8 | [notifications.js](nigehban-app/src/notifications.js) | Silent SOS under Do Not Disturb | The DND-bypass channel was created and then never used |
| 9 | [band.js](nigehban-app/src/band.js) | **Connected**, battery blank forever | Notify subscribe errors and write errors were both caught and dropped, so a dead data path reported as a live link |
| 10 | [nigehban_band_nrf52.ino](nigehban_band_nrf52/nigehban_band_nrf52.ino) | nRF Connect shows bytes on TX | `notify()` sent 23 of every 86 bytes and abandoned the rest; a hex dump has no line framing, so it looked like a pass |

Rows 9 and 10 are the same lesson as the other eight, learned again on hardware:
**verifying a transport is not verifying a message.** nRF Connect proved bytes
moved. It could not prove a line arrived, and a line is the unit the protocol
is actually made of.

---

### Bring-up: five silent faults · 27 Aug 2026

First real link between the nRF52 band and the app. Five independent faults,
each sufficient on its own to produce *connected, no data* — which is why
fixing any one of them changed nothing visible, and why this took as long as it
did. Listed in the order they had to be peeled off:

1. **Name mismatch.** Firmware renamed to `Nigehban-02`; the app matched the
   string `Nigehban-01` exactly and discarded every advertisement. Now matched
   by NUS service UUID — which rides in the advertising packet, unlike the name,
   which rides in the scan response and is often `null` on the first report —
   with the name demoted to a `Nigehban-` prefix hint.
2. **Android 12 scan permission.** `BLUETOOTH_SCAN` is declared without
   `neverForLocation` (the ble-plx plugin defaults that flag off), so the OS
   requires `ACCESS_FINE_LOCATION` *and* Location Services before it will
   deliver a single scan result. The app requested neither on API 31+. The scan
   started, reported no error, and returned nothing. nRF Connect worked because
   it asks for location.
3. **MTU request at connect.** `connect({ requestMTU: 185 })` killed the notify
   subscription outright — zero callbacks, no error. Deferred until after the
   subscription is live, where a failure is cosmetic.
4. **Truncated lines.** The one that mattered.
   `BLECharacteristic::notify()` chunks at `MTU-3` and, when the SoftDevice's
   notification pool runs dry mid-line, abandons the remainder and returns
   `false` **keeping no record of how far it got**. At the default MTU of 23 an
   86-byte heartbeat needs five packets and the pool is one deep, so the phone
   received `{"t":"evt","e":"hb",` and never the newline that ends the line.
   `send()` now chunks explicitly and retries **only the failed piece** —
   retrying the whole line re-sends bytes that already went out and corrupts
   the stream, which is a worse bug wearing the same clothes.
5. **A connect race.** The band advertises every 20 ms, so several scan
   callbacks for it were delivered before the first `await d.connect()` reached
   native, and each started its own connection. Concurrent connects on Android
   rebuild the GATT under the subscription the previous one registered.
   `stopDeviceScan()` does not help — it stops future callbacks, not those
   already in flight — so the guard is set synchronously before any `await`.

Two things made this diagnosable at all, and both are worth keeping:

- **A data watchdog.** *Connected* is a claim about the radio, not the data. If
  no bytes arrive within 25 s — two and a half heartbeats — the link is
  recycled and the reason is recorded. It is fed on **raw bytes, not parsed
  lines**: a band whose lines arrive truncated is a real fault, but it is not a
  dead subscription, and tearing the link down every 25 s only hid the problem.
- **`lastError` on the Band screen.** Every failure above was silent by
  construction. Nothing here was fixable until the radio's own error text
  reached a human.

Also fixed in passing: `bluetooth-off` is not a Feather icon, so every render of
a non-connected band logged a warning — which, while the link was failing, was
most of them.

**Not a product bug but worth knowing:** a Metro reload restarts the JS without
closing the native BLE connection, leaving the band linked to a context that no
longer exists — so it stops advertising and the next scan cannot find it. The
teardown now cancels the connection before destroying the manager. The same
thing happens to a real user whose app is killed and relaunched.

#### Verified working after this

Band → phone (double-press → `sos` → the app raises it) and the link surviving
on its own. Battery percentage and *Last heard* populate from the 10 s
heartbeat.

#### Open, in the order I would take them

1. **SOS must not need the server.** *Found the hard way: the in-app SOS button
   was also dead, and the cause was ngrok being off.* [App.js:173-199](nigehban-app/App.js#L173-L199)
   dispatches `SOS_RAISED` **only after** `POST /alert` succeeds, and there is
   no queue — `useLive` retries its socket, alerts retry nothing. So the exact
   scenario the product exists for (bad signal, dead zone, server hiccup) gives
   no takeover, no siren, no record, and a toast that vanishes. Fix: dispatch
   locally *first*, persist unsent alerts, flush on reconnect, and render
   delivery state honestly — "sent to 3" versus "not delivered yet, retrying",
   which today look identical because neither renders.
2. **Battery ADC** — F2.3 above. Safety path: false lows page the family.
3. **`registerPushToken` fails** (`404`, then `fetch canceled`). This phone
   registers no push token, so it receives nobody else's alerts. Own alerts
   still fan out; incoming ones do not arrive.
4. **`Custom sound 'default' not found`** — thrown on every launch. On the alarm
   path, so it bears on whether an SOS actually makes a noise.
5. **[nigehban_hub.py:460](nigehban_hub.py#L460) has bug #1, unfixed.** Exact
   `d.name == "Nigehban-01"` against a band now named `Nigehban-02`. The laptop
   bridge cannot find the band for precisely the reason the app could not.
6. **MTU stays 23** — the central drives negotiation and Android had already
   closed its one exchange window by the time the app asks.
   `configPrphBandwidth(BANDWIDTH_MAX)` raises what the band will *accept*, to
   247. Correct chunking makes 23 merely inefficient (5 packets per line, not
   1), so this is an optimisation, not a fault. Moving `requestMTU` back into
   `connect()` is the obvious lever and is exactly what broke the subscription
   in fault 3 — do not pull it without a way to see the error.

Two of these were re-diagnosed rather than fixed as first written, and both
corrections matter more than the fixes:

**#8 — the channel is set by the trigger, not the content.** The obvious patch
is `channelId` in the notification content. `NotificationContentInput` has no
such field in expo-notifications 57; `ChannelAwareTriggerInput` is a *trigger*,
and it still means immediate delivery. Patching the content would have compiled,
shipped, and left the SOS exactly as silent as before.

**#6 — the band's `checkin_missed` must not escalate.** It reads like a dropped
alert. It is not: the band only nags because the phone sent `checkin_req`, and
the phone only sends that because the server opened a `checkins` row with a
`due_at` — so B2.2's sweeper is already raising `checkin_missed` on that row.
Escalating from the band as well would page the family **twice for one silence**,
with the band's clock and the server's clock disagreeing about when. The real
defect was the opposite one: `emit_alert()` fans out to `family_of(uid)` only, so
the *wearer* was told nothing at all — her band simply stopped buzzing. It now
dispatches `CHECKIN_EXPIRED`, which says time is up and deliberately leaves the
question open, because answering late still tells the family she is fine.

This is §10.1 in practice — *observed, not reasoned about*. Every fix here was
reasoned about, so:

**Verified on web:** #1, #3, #5.
**Verified on device:** #2 — tapping a push on a force-stopped app now opens the alert.
**Testable today, not yet run:** #4, #7, #8. The dev build and FCM both already
exist (see the N1/N3.1 audit notes), so nothing blocks these — they need one
sitting with one Android phone, roughly half an hour for all three.
**Not verifiable at all yet:** #6 — see the note under §12, `virtualBand.js`
never implements the band's nag timeout, so the phone-as-band cannot produce the
event. Porting those ~10 lines from
[nigehban_band_nrf52.ino:577](nigehban_band_nrf52/nigehban_band_nrf52.ino#L577)
closes both the test gap and a real firmware/JS divergence.
