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
| **UI** | Auth · Home · Band · Family (pairing codes, accept/decline) · Alerts; tab shell; full-screen alert takeover; check-in sheet; dark theme + `ui.js` primitives | Check-in countdown, High Alert panel, watch-status tile, battery/going-dark states, fall countdown, Samaritan respond, OEM onboarding, server-URL settings |
| **Backend** | `server/nigehban_server.py` — 20 endpoints + `/ws`, SQLite, 9 tables, live push, **the sweeper**, two-party pairing consent, rate limits, hashed session tokens | `/presence` + `/samaritan` (geo), Qwen scoring, WhatsApp fan-out, token expiry |
| **Android** | `app.json` with BLE/location/notification perms; `eas.json` with 3 profiles | `plugins/` does not exist · no `@notifee/react-native` · no `expo-battery` · no foreground service · no boot receiver · no OEM deep links |
| **Firmware** | `nigehban_band_esp32/` — full gesture map, protocol, feedback patterns; `HAS_IMU 0` | `nigehban_band_nrf52/` does not exist · no IMU · no real battery ADC · motor circuit unbuilt |
| **Deployment** | `scripts/dev-tunnel.ps1` / `.sh` — server + HTTPS tunnel, self-verifying; CORS on the server | No Dockerfile, no compose, no Caddyfile, no Alibaba account |
| **Glue** | `nigehban_hub.py` — Guardian logic in Python | Superseded by the server's sweeper; kept as the firmware test rig |

~~Two things in `api.js` shape the first UI milestone...~~ **Resolved.** U1 has
landed: the app now takes an `https://` tunnel or cloud hostname, derives
`wss://` from it, and carries the ngrok header. The subnet sweep survives as
the labelled fallback it always should have been.

The band is no longer the blocker either. V1 makes the phone speak the band's
protocol, so only two rows of the acceptance matrix — BLE reconnect after the
app is killed, and the physical motor/power budget — actually need hardware.

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

- [ ] U2.1 — `src/state.js`: `idle · checkin_pending · high_alert · sos_live`, with the legal transitions written as data rather than `if`-chains scattered through [App.js](nigehban-app/App.js).
- [ ] U2.2 — Every band event (exec plan §5) and every WS message maps to exactly one transition.
- [ ] U2.3 — Drive it from the **BAND tab** (V1), which produces real gestures rather than `simulate()`'s canned conclusions.

**Design rule:** the phone is an actuator, never a timekeeper. This machine
reflects server-owned state; it must not own a deadline.

**Blocks:** U3, U4.
**Done when:** the simulated band walks all four states and the UI follows without a reload.

### U3 · Safety-feature UI · Owner M1 · Phase 2–3 · ~8 h

Built against **mocked** WS messages first, wired to B2 when it lands.

- [ ] U3.1 — **Check-in countdown** — full-screen, ack button, counting down to the server's `due_at`, never to a local timer.
- [ ] U3.2 — **High Alert panel** — arm/disarm, PIN required to disarm (matrix #16), next-buzz indicator.
- [ ] U3.3 — **Fall countdown** — 30 s at severity 4, 15 s at severity 5; "I'm fine" cancels and logs a near-miss.
- [ ] U3.4 — **Battery states** — 20 % family alert, 5 % `going_dark` (matrix #13, #14), via `expo-battery`.
- [ ] U3.5 — **SOS live view** — what the wearer sees after firing; stand-down from app or band.

**Done when:** all five run end-to-end off mocked messages with no server changes.

### U4 · Family-side UI · Owner M1 · Phase 2–3 · ~6 h

- [ ] U4.1 — **Invite flow** — replaces today's instant link in [Family.js](nigehban-app/src/screens/Family.js). Send · pending · accept · decline. Consent is the whole point (exec plan §1, the safety bug).
- [ ] U4.2 — **Watch-status tile** — band link, service alive, last beat, from `GET /watch/{member_id}`. Goes amber within 3 min of the service dying (matrix #19).
- [ ] U4.3 — **Alert takeover hardening** — the modal at [App.js:221](nigehban-app/App.js#L221) already exists; add map/directions, "I'm on it" attribution, and the stand-down echo.
- [ ] U4.4 — **Good Samaritan respond** — coarse pin only; name and exact location released *only* after "I'm going" (matrix #20).

**Done when:** matrix rows 1, 2, 7, 19, 20 pass on two phones.

### U5 · Onboarding & polish · Owner M1/M2 · Phase 3 · ~4 h

- [ ] U5.1 — **OEM onboarding screen** (M2) — per-vendor autostart deep links from exec plan §7, each wrapped in try/catch with the settings-page fallback.
- [ ] U5.2 — Permission ladder: notifications → location → background location → battery-optimisation exemption, each with one sentence of why.
- [ ] U5.3 — Empty, offline, and permission-denied states on all four screens.
- [ ] U5.4 — Demo-room contrast pass. [theme.js](nigehban-app/src/theme.js) was tuned for a bright hall; verify at full brightness on the worst screen you own.

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
- [ ] B3.3 — `POST /presence` — geohash6, lat/lon rounded to ~100 m.
- [ ] B3.4 — `POST /samaritan/{alert_id}/respond` — releases the coarse pin, logs the responder.
- [ ] B3.5 — Qwen severity scoring + Urdu dispatch text via Model Studio. *Cut line Day 3 21:00 → fall back to `RiskEngine._template`, which already works.*
- [ ] B3.6 — WhatsApp fan-out.

**Done when:** every in-scope feature answers correctly to curl before any phone is involved.

### B4 · Hardening · Owner M3 · Phase 5 · ~2 h

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

- [ ] N1.1 — Create `plugins/withNigehbanAndroid.js` from the exec plan §7.1 listing; register it in `app.json`.
- [ ] N1.2 — Add `@notifee/react-native` and `expo-battery`.
- [ ] N1.3 — Queue the first EAS dev build **in hour one** — it is the long pole on J1.
- [ ] N1.4 — Drop `usesCleartextTraffic` once the cloud has TLS (D2), not before.

**Blocks:** J1. The real band cannot talk to the app without this — Expo Go can never load `react-native-ble-plx`.
**Done when:** the dev-build APK is installed on two phones and the manifest carries all ten permissions.

### N2 · Foreground service · Owner M2 · Phase 2 · ~8 h

The hardest single task on the board.

- [ ] N2.1 — `Location.startLocationUpdatesAsync(WATCH_TASK, …)` with the `foregroundService` block from exec plan §7.
- [ ] N2.2 — BLE reconnect loop that survives the app being swiped from Recents (matrix #10, #12).
- [ ] N2.3 — Boot receiver → service restarts and reconnects in under 60 s (matrix #11).
- [ ] N2.4 — WorkManager watchdog: is the service alive, is BLE connected, is the socket up. **Watchdog only** — never a timer; the 15-minute floor makes it useless as one.
- [ ] N2.5 — `isIgnoringBatteryOptimizations()` surfaced in the UI.

**Done when:** the Phase 2 exit gate — phone locked, screen off, app swiped from Recents, 20 minutes in a pocket, press the band, the family phone rings.

### N3 · Push + alarm · Owner M2 · Phase 2 · ~4 h

- [ ] N3.1 — FCM project; high-priority push tested with curl before the app consumes it.
- [ ] N3.2 — Alarm-importance channel with DND bypass, via `expo-notifications`.
- [ ] N3.3 — Full-screen intent over the lock screen via Notifee (matrix #6 — fires with the family app **killed**).
- [ ] N3.4 — Siren + vibration until dismissed.

**Done when:** matrix rows 5 and 6 pass on three phones.

---

## 6. Firmware — `nigehban_band_nrf52/`

### F1 · Board bring-up · Owner M4 · Phase 0 · ~3 h

- [ ] F1.1 — Install **Seeed nRF52 Boards** (Adafruit Bluefruit core, *not* the mbed variant).
- [ ] F1.2 — Blink, then advertise as `Nigehban-01`; verify in **nRF Connect** — no Nigehban app needed, so this waits on nobody.
- [ ] F1.3 — `BLEUart` up. It is literally the Nordic UART Service the app already speaks.

### F2 · Port the gesture layer · Owner M4 · Phase 0–1 · ~5 h

- [ ] F2.1 — Move `Button`, `Pattern`, `onGesture`, `handleCommand` **verbatim** from [the ESP32 sketch](nigehban_band_esp32/nigehban_band_esp32.ino) onto `bleuart`. The protocol is frozen (exec plan §5); the app must not notice the swap.
- [ ] F2.2 — Delete the MPU6050 path. The XIAO Sense has an LSM6DS3TR-C on board at `0x6A`; porting the external-IMU code would be work spent on hardware you do not need.
- [ ] F2.3 — Real battery: enable the divider on `P0.14`, read `P0.31`, calibrate against a multimeter.

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

### F5 · Spare band · Owner M4 · Phase 5 · ~30 min

- [ ] F5.1 — Keep the ESP32 flashed with the final gesture map and charged. A second working band on demo day normally costs a day of building; you already have one.

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
| U2 Client state machine | M1 | 0 | 4 h | ☐ |
| U3 Safety-feature UI | M1 | 2–3 | 8 h | ☐ |
| U4 Family-side UI | M1 | 2–3 | 6 h | ☐ |
| U5 Onboarding & polish | M1/M2 | 3 | 4 h | ☐ |
| B1 Consent + schema | M3 | 0 | 4 h | ☑ done |
| B2 The sweeper | M3 | 2 | 5 h | ☑ done |
| B3 Feature endpoints | M3 | 3 | 6 h | ◐ B3.1, B3.2 done |
| B4 Hardening | M3 | 5 | 2 h | ☐ |
| N1 Config plugin + dev build | M2 | 0 | 3 h | ☐ |
| N2 Foreground service | M2 | 2 | 8 h | ☐ |
| N3 Push + alarm | M2 | 2 | 4 h | ☐ |
| F1 Board bring-up | M4 | 0 | 3 h | ☐ |
| F2 Port the gesture layer | M4 | 0–1 | 5 h | ☐ |
| F3 IMU / fall | M4 | 2 | 5 h | ☐ |
| F4 Hardware build | M4 | 0–2 | 4 h | ☐ |
| F5 Spare band | M4 | 5 | 0.5 h | ☐ |
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
[nigehban_band_esp32.ino](nigehban_band_esp32/nigehban_band_esp32.ino) ·
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
