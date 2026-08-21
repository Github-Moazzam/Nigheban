# Testing Nigehban without the band

The wristband has not arrived. That blocks exactly one thing — proving that a
real BLE radio delivers a real button press — and nothing else. Everything the
band *means* to the system is a JSON line on a wire, and this repo can now
produce those lines from a phone.

This document is how to run the whole product today, on any number of phones,
anywhere in the world.

---

## 1. What the missing hardware actually blocks

Worth being precise, because the honest answer is "less than it feels like".

| | Testable now | Needs the band |
|---|---|---|
| Gesture map — taps, holds, what each one means | ✅ real engine, in the app | — |
| Event protocol on the wire | ✅ byte-identical JSON | — |
| Fall state machine and its thresholds | ✅ phone accelerometer | re-tune on the LSM6DS3TR-C |
| Server routing, consent, escalation, the sweeper | ✅ built and tested | — |
| Family alerting, takeover screen, stand-down | ✅ entirely | — |
| Battery escalation | ✅ real phone battery | ADC divider calibration |
| Push, lock-screen alarm, foreground service | ✅ entirely | — |
| BLE reconnect after the app is killed | ❌ | yes |
| Motor feedback, power budget, enclosure | ❌ | yes |

Two rows. Everything else on the acceptance matrix is reachable this week.

---

## 2. The phone as the band

`nigehban-app/src/virtualBand.js` is a JavaScript port of
`nigehban_band_esp32/nigehban_band_esp32.ino` — the same button engine, the
same gesture map, the same event JSON, the same command handler. Only the radio
is simulated.

This matters more than a row of debug buttons would. The old
`useBand().simulate()` fired a *conclusion* (`sos`); it skipped the part that is
genuinely hard and genuinely untested — turning presses and accelerometer
samples into gestures. That logic has to be correct on the band. Writing it
here means it gets debugged somewhere with a screen and a console, and the
constants it is tuned with copy straight into the `.ino`.

### Using it

Open the **BAND** tab. Source is **THIS PHONE** by default.

| Gesture on the big key | Event | What the app does |
|---|---|---|
| 1 tap | `checkin_ack` | answers a check-in, or stands down a live SOS |
| 2+ taps | `sos` | full SOS to every linked family member |
| hold 3 s | `high_alert_on` / `high_alert_off` | toggles High Alert |

Two gestures, and that is the whole map: **tap twice for help, hold to be
watched.** It follows `EXECUTION_PLAN.md` §5, and the `.ino` matches it exactly.

**Three taps also fires SOS. So do four and five** — on purpose. A frightened
person does not tap a precise number of times, and being strict here fails
silently at the moment the product has to work.

**Nothing is bound to a longer hold.** Anti-snatch is deferred to v2, so
holding past 3 s crosses nothing further and the band stays silent rather than
buzzing to announce that it did nothing. The `armed` / `disarmed` events and
the snatch alert path still exist and are still testable from `SNATCH` on the
console — only the gesture is gone.

You have to actually double-tap and actually hold. That is the point: it tells
you today whether a frightened person could do it, while changing the map still
costs nothing.

### Changing the map

`DEFAULT_GESTURES` in `virtualBand.js` is a table, not an if-chain, because the
map is going to become user-configurable in settings. That feature edits this
array. Its counterpart in the `.ino` is one clearly marked block — keep the two
in step, since the phone standing in for the band only works while they agree.

Taps are grouped into a burst and only fire once you stop tapping
(`CLICK_GAP_MS`, 420 ms) — exactly as the firmware does it, so tap deliberately
rather than fast.

**Wire log** at the bottom of the screen shows every line that would have
crossed the BLE characteristic. `▸` is band → phone, `◂` is phone → band.

### Fall detection is real

The accelerometer is live at 104 Hz — the firmware's active rate, matched so a
threshold that works here is not quietly relying on more samples than the band
will ever have. The state machine wants **free-fall → impact → stillness**, in
that order, so waving the phone will not trip it. Drop it onto a cushion from
waist height to see it fire.

Thresholds live in one place, `FALL` in `virtualBand.js`. Tune them on a phone,
then copy the numbers into the `.ino` when F3 starts.

`FORCE FALL` and `SNATCH` are the two events a thumb cannot produce at a desk.
Everything else goes through the real engine.

### Battery is real too

The phone's own battery feeds the `bat` field, so the 20 % and 5 % escalations
can be tested by leaving a phone unplugged rather than by trusting a fake
number. `BATTERY → 15%` forces it when you are in a hurry.

### When the band arrives

Switch the source to **REAL BAND**. Nothing else changes — `bandLink.js` is the
seam that makes both look identical to the rest of the app.

---

## 3. The tunnel: testing across the internet

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev-tunnel.ps1
```

```bash
./scripts/dev-tunnel.sh          # macOS / Linux / WSL / Git Bash
```

It starts the server, opens an HTTPS tunnel, verifies `/health` **through** the
tunnel, and prints one address. Paste that into the **Server address** box on
the Auth screen of each phone.

### Why a tunnel and not just the same Wi-Fi

- **Testers can be anywhere.** Mobile data works. They do not need to be in the
  room, on your network, or awake at the same time as you.
- **It is HTTPS.** The app talks to it the way it will talk to the cloud, so
  `wss://`, certificates, and Android's no-cleartext rule are all exercised now
  rather than discovered on deployment day. Phase 4 becomes a lift-and-shift of
  a proven system instead of debugging features and infrastructure at once.
- **Campus and cafe Wi-Fi almost always has client isolation on**, which
  silently breaks phone-to-laptop on the same SSID. A tunnel does not care.

### First-time setup

```
winget install ngrok.ngrok                    # or https://ngrok.com/download
ngrok config add-authtoken <token from dashboard.ngrok.com>
pip install -r requirements.txt
```

### The URL changes every restart

On the free tier, yes. That is survivable because the app *stores* the address
rather than baking it in — paste the new one and carry on. That property is
milestone U1, and it is also what makes the Phase 4 cutover a one-line change.

`http://127.0.0.1:4040` is ngrok's inspector: every request, with bodies, and a
replay button. It is the fastest way to find out whether a failure is the phone
or the server.

---

## 4. A two-phone test with no hardware at all

One laptop, two phones, and they do not have to be near each other.

1. Run `scripts\dev-tunnel.ps1`. Copy the address.
2. Both phones: `npx expo start --tunnel` in `nigehban-app/`, open in Expo Go.
3. Both phones: paste the address, **create an account** — say `ali` and `ammi`.
4. On `ammi`: FAMILY tab → **MAKE A PAIRING CODE**. Read it out.
5. On `ali`: FAMILY tab → type it in. They are linked at once, because both of
   them did something. (Try the other path too: enter `ammi`'s permanent
   `NGB-` code instead and watch `ali` get *nothing* until `ammi` accepts.)
6. On `ali`: BAND tab → double-tap the key.
7. `ammi`'s phone takes over the screen with the alert and a map link.
8. On `ali`: single-tap the key → `ammi` sees the stand-down.

That is the core loop of the product, proven across the internet, with no band
in the building.

Then keep going — every one of these works today:

- `ammi` → FAMILY → check on `ali`. That phone buzzes with the real
  `checkin_req` command, and the virtual band buzzes with it. **Then ignore
  it.** Ninety seconds later `ammi` is told nobody answered — that deadline is
  on the server, so it works with `ali`'s app force-quit.
- Hold the key 3 s on `ali` for High Alert, then close the app entirely. The
  server keeps asking on its own schedule, and tells `ammi` when three minutes
  pass with no heartbeat.
- Hold the key 3 s on `ali` for High Alert.
- Hit `SNATCH` on `ali` — no gesture arms it (anti-snatch is v2), but the
  severity-5 alert path is real.
- Drop `ali`'s phone onto a cushion.
- Unplug `ali`'s phone and let it drain past 20 %.

---

## 5. What to build next, in order

None of it is hardware-blocked.

**B1 (consent) and B2 (the sweeper) are done** — 22 Aug 2026. Run
`.venv\Scripts\python.exe tests/test_consent_and_sweeper.py` against a running server to see both,
including a check-in escalating on its own deadline with no phone attached.

1. **N1 — the EAS dev build.** Now the longest pole on the board, and the one
   thing the band's arrival is blocked on: Expo Go cannot load BLE, so a real
   band cannot be tested at all until this exists.
2. **U2 — the client state machine.** `idle · checkin_pending · high_alert ·
   sos_live` as data. The server already emits every transition; the app is
   still inferring them from loose booleans.
3. **N2/N3 — foreground service and push.** What makes an alert arrive when the
   app is not open. Until then the heartbeat stops the moment Android
   backgrounds the app, which the server dutifully reports as `watch_lost`.
4. **D1 — the pipeline spike.** Half an hour, while there is still slack.

---

## 6. The gesture map is settled

The exec plan and the `.ino` used to disagree on which gesture was SOS and on
what hold-3s did. **Resolved 21 Aug 2026 in favour of the exec plan**, and the
firmware, the JS port, the app and the console were all changed together.

**Anti-snatch left the map on 22 Aug 2026.** The feature is deferred, and a
gesture for a feature that does not work yet costs the wearer a threshold to
learn and to avoid crossing by accident. It also removed the map's one rough
edge — holding past 3 s used to fire both thresholds.

One consequence to carry forward: exec plan §5 reserves **4 taps for `armed` in
v2**, and that cannot be added as written. Since 2+ taps is SOS, a 4-tap
`armed` gesture would mean an over-tapped SOS silently arms anti-snatch instead
of calling for help. It needs a different affordance.

High Alert is local state until **B3.2** ships `POST /watch/high_alert`. The
mode has to be server-owned — the server holds `next_buzz_at` and re-buzzes on
its own — or the feature dies the moment the app is killed, which is precisely
the scenario it exists for.

See §12 of [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) for the full decision.
