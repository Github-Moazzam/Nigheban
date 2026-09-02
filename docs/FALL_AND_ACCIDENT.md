# Fall and accident detection — design, thresholds, and the bench protocol

**Status:** implemented. Firmware `HAS_IMU` is now `1`; the app, the server and
the database all carry the escalation path.
**Date:** 2 Sep 2026
**Covers:** `nigehban_band_nrf52.ino` (IMU block), `src/motion.js`,
`src/virtualBand.js`, `openIncidentCheckin` in `App.js`, `/checkin/self` and the
sweeper in `nigehban_server.py`, migration `005_incident_checkins.sql`.

The rule this whole feature is arranged around:

> **A detector never pages anybody. It asks the wearer, and the SERVER pages the
> family if — and only if — nobody answers.**

## Before any of this works

```bash
python server/migrate_pg.py       # applies 005_incident_checkins.sql
```

`POST /checkin/self` inserts `lat`, `lon`, `note` and `client_id` into
`checkins`, and without migration 005 those columns do not exist — the endpoint
500s and the app silently falls back to its offline local countdown, which is
the weaker path. The sweeper reads the same columns with `.get()` precisely so
that an unmigrated database degrades to a placeless alert instead of taking
every deadline in the product down with it.

Flash the band as well: `HAS_IMU 1` needs the **Seeed Arduino LSM6DS3** library
from Library Manager.

---

## "How do I actually test this?" — start here

**A drop gives you a fall alert. It does not give you an accident alert.** They
are two different events with two different triggers, and no amount of dropping
produces the second one:

| I want to see... | What I have to do |
|---|---|
| `fall` | Drop it — **and leave it completely still for 2 s afterwards** |
| `accident` | Be genuinely moving at **25 km/h or more**, then take an impact |
| `accident`, at a desk | **ARM CRASH TEST** on the Band console, then hit the band within 20 s |

The reason you cannot get an accident from a drop is the whole design: an
impact on a wrist is meaningless on its own, and only the speed in the twenty
seconds before it says whether it was a crash or a slammed door. Sitting at a
desk you were not travelling, so an impact is *correctly* discarded.

### The single most common reason a drop test "does not work"

**You picked it up.** The fall machine needs `FALL_STILL_MS` — **1.6 seconds of
stillness after the landing** — before it will call anything a fall. That stage
is deliberate and it is what stops a bag falling off a chair paging a mother at
2 a.m. If you drop the band and catch it, grab it, or turn it over to look at
the LED, you have told the detector the wearer got straight back up.

Drop it, then **count to three before touching it.**

### How the wearer answers

Three ways, and the first is the one that matters:

1. **One press on the band.** This is the affordance the whole product is built
   on, and it is the only one that reaches somebody on the ground with their
   phone across the room. It goes through the same `checkin_ack` the "I'm fine"
   key has always sent — no new gesture to learn.
2. **Hold the "I'M FINE" button** on the phone for 1.5 seconds.
3. Do nothing, and the family is told.

**There is no PIN on this screen any more** (removed 2 Sep 2026). It used to be
a four-digit pad, on the reasoning that a single button is what a phone cancels
by itself in a pocket. The reasoning was right about pockets and wrong about
falls: the person being asked to type four digits has just hit the ground, may
be elderly, face down, one-handed and without their glasses — and the penalty
for not managing it in forty-five seconds is a false emergency sent to their
whole family, which is precisely what the countdown exists to prevent.

It had also stopped being a gate: the band's single tap answers the question
directly, so anybody holding the band could cancel with one press while the
screen still demanded a code from the wearer.

A **1.5-second hold** replaces it. It defeats the actual threat — a pocket, a
sleeve, a body lying on the screen — because sustained deliberate contact is
the one thing incidental pressure does not produce, and it needs no memory, no
reading and no accuracy. What is given up, plainly: somebody who has taken the
phone off an injured person can now cancel by holding a button. That is a real
loss, accepted because the band tap already made it true and because duress
belongs to anti-snatch (v2) rather than bolted onto a fall.

**The PIN is untouched everywhere it guards a deliberate action with an
adversary behind it** — High Alert disarm, removing a family member, and the
SOS drop.

### And to see the family actually get told

You need a **second account with you in its family list**, and you must **not
answer the countdown.** Answering is the success path — it means nobody is told,
which is the feature working. Let the window run out and watch the other
account.

The full ladder, cheapest first, is [§ THE BENCH PROTOCOL](#the-bench-protocol--what-it-takes-to-fire-and-from-what-height)
below.

---

## The escalation ladder

```
   IMU sees something
          |
          v
   the phone decides what it was          <- speed context lives here
          |
          +---- nothing --------------------> dropped, silently. No buzz.
          |
          v
   POST /checkin/self          reason = fall | accident
          |                    lat/lon captured AT THE IMPACT
          |                    a row in `checkins` with a due_at
          v
   the wearer is asked         wrist buzzes + nags, screen counts down,
          |                    push on the DND-bypassing alarm channel
          |
          +---- one tap ("I'm fine") ------> near_miss. Private. Nobody told.
          |
          +---- steady riding resumes -----> stood down. Accidents only.
          |
          v
   the window runs out
          |
          v
   THE SWEEPER raises `fall` (sev 4) or `accident` (sev 5), with the pin
          |
          v
   the family is told. Severity 5 also asks Good Samaritans nearby.
```

**Nothing at any step before the last one reaches another human being.**

### Why the deadline is the server's

The phone could hold this itself, and for a while it did — a 30-second local
countdown in `FallCountdown`. The reason it cannot is that the situations this
feature exists for are precisely the ones where the phone is about to stop
working: it lands screen-down in a gutter, the battery goes flat, an OEM battery
manager kills the app the moment the screen goes off, the rider goes one way and
the phone the other.

In every one of those a local timer means the question is asked, nobody answers,
and *nothing ever happens*. Once `/checkin/self` returns, the deadline is a row
in the database and the sweeper owns it — the phone can be destroyed in the next
second and the family is still told.

The local countdown survives as the **offline** path only. With no network there
is no server to hold the deadline, so the phone holds it and raises the alert
into the offline queue itself. That is worse (it dies with the app) and much
better than nothing, and the app says so on screen when it happens.

---

## Two detectors, and only one of them decides anything

### `fall` — the band is allowed to call this, by either of two routes

#### People do not free-fall

This is the most important thing in this document.

The textbook fall detector is *light, then hit, then still* — and taken alone it
**misses the falls this product is for.** A person does not drop. They
**topple**: rotating about the feet or hips over 0.7–1.2 s, with the wrist
attached to a body the whole way, so it frequently never reads below 0.45 g for
70 ms at all.

The falls that *do* produce clean free-fall are faints. Trips, slips, a leg
giving way, and the slow slump an elderly person actually has produce little or
none — **and those are the majority.** Making free-fall a mandatory gate fails
silently on the common case, which is the wrong direction to be wrong in.

So free-fall is **evidence, not a requirement**, and there are two routes in.

#### Route A — "it dropped"

| Stage | Threshold | Constant |
|---|---|---|
| free-fall | \|a\| < 0.45 g | `FALL_FREEFALL_G` |
| ...sustained | ≥ 70 ms | `FALL_FREEFALL_MIN_MS` |
| impact | \|a\| > **2.40 g** | `FALL_IMPACT_G` |
| ...within | 1400 ms of the free-fall ending | `FALL_IMPACT_WINDOW_MS` |
| stillness | \|a − 1\| < 0.28 g, held ≥ 1600 ms | `FALL_STILL_MS` |

The impact bar is low **because the free-fall already corroborated it**. Catches
faints and falls from a height.

#### Route B — "it was hit" (the topple)

| Stage | Threshold | Constant |
|---|---|---|
| impact | \|a\| > **4.00 g**, no free-fall needed | `FALL_HARD_G` |
| posture changed | resting angle moved ≥ **35°** | `FALL_TILT_DEG` |
| stillness | held ≥ **2500 ms** | `FALL_STILL_SLOW_MS` |

Harder impact and longer stillness, because there is no free-fall carrying any
of the argument.

**The angle is what makes this route safe.** "A spike then stillness" on its own
is also a hand put down hard on a desk — but a clap, a slammed door and a palm
on a table all leave the wearer in the posture they started in, and going to the
floor does not.

Posture comes from **gravity extracted by low-pass filter**: over half a second,
deliberate movement is zero-mean and averages away while gravity is a constant
1 g in one direction, so what survives the filter *is* which way the wrist
points. Two filters run, not one:

- **fast (~0.5 s)** — where the wrist is *now*, read after everything settles.
- **slow (~3.3 s)** — where it was *before any of this began*, snapshotted at the
  impact.

The slow one has to be slow. A topple lasts 0.7–1.2 s, so a half-second filter
sampled at the moment of impact has spent its entire memory watching the fall
and holds a posture already halfway to the ground — the measured tilt comes out
about half what it should be, and route B quietly stops firing on exactly the
falls it exists for.

A stillness-gated posture sample was tried first and is worse: an arm swinging
through a walk is rarely quiet for 400 ms together, so the last "resting"
posture could be minutes old by the time somebody trips.

The `fall` event carries `route` (`drop` / `topple`) and `tilt`, so a false
positive in the field can be told apart from one on the bench without a
re-flash.

### `impact` — the band explicitly refuses to call this

A crash has no free-fall. A rider hits a car at 40 km/h with 1 g of gravity on
them the whole way, so it never enters the machine above. What is left is a
spike, and **on a wrist an 8 g spike is also a clap, a slammed door, a hand put
down hard on a table, a cricket bat.** The accelerometer genuinely cannot tell
them apart, and pretending otherwise is how you build a false-alarm machine.

So the band reports the measurement and stops: `peak_g`, `rot` (peak rotation,
°/s) and `still` (what percentage of the following 1.2 s the arm was steady).
It does not buzz. Most impacts are furniture, and a band that vibrates every
time its wearer puts a hand down hard is a band that gets taken off.

**`src/motion.js` decides**, using the one fact neither the band nor the
accelerometer has: how fast this person was travelling in the last 20 seconds.

---

## The speed rules, and the two failure modes they are built against

### Why the stop is not the trigger

The obvious design is *travelling → bang → stopped dead = crash*. It is obvious
and it is wrong in the direction that costs a life.

**A vehicle that is hit does not reliably stop.** It spins, it is pushed down
the road, it rolls, it carries on with a concussed driver still holding the
wheel, it is shunted into moving traffic. A motorbike goes down and slides forty
metres. Wait for zero and every one of those is a crash the detector decides did
not happen — silently, with nobody ever told the question was asked.

So **the trigger is the impact at speed, on its own.** Stopping is used only to
shorten the window and to word the message. *Coming to a halt is corroboration;
not coming to a halt is not evidence of anything.*

### Why resumed movement *does* cancel, and what it has to look like

The mirror worry is the pothole: a rider hits one at 50 km/h, the wrist takes a
real 12 g, and they are completely fine. Asking them to answer a check-in is
asking somebody to tap a wristband one-handed at speed, which is more dangerous
than the false alarm it prevents.

So resumed travel does stand the question down — but **"moving" is not the
test, because a wreck moves.** `travellingSteadily()` requires all of:

- **20 unbroken seconds** (`RESUME_STABLE_MS`) measured **forward from the
  impact**, not a trailing window. A trailing window would start inside the
  crash itself and could never pass.
- **Every sample above 25 km/h** (`VEHICLE_KMH`) — not the average, not the
  peak. A vehicle that was hit is losing speed, and one dip breaks the run. An
  average would let a car coasting to a halt look like a car being driven.
- **At least 5 real samples.** A GPS dropout proves nothing, and silence must
  never be read as "fine".
- **No second impact.** A crash that is still happening is not somebody driving.

The reasoning in one line: **nothing but a conscious person keeps a vehicle at a
steady road speed for twenty seconds.**

Falls do not get this. There is no vehicle to be coherently driving, and
"started moving again" after a fall is a person crawling as easily as a person
walking it off.

### A fall detected while travelling is reported as an accident

`onBandEvent` upgrades it. The free-fall the band saw is a rider leaving a bike,
and the family needs to be sent to a carriageway rather than told somebody
tripped — it changes who they call and how fast they leave.

### The driver hit at the wheel — and the tunnel problem

**A driver, hands on the steering wheel, hit at speed.** No fall, no free-fall,
no tumble — just a very hard shock through the wrist. This is the case the
`impact` detector exists for, and it works like this:

1. The band's fall machine never sees it. There is no free-fall stage, so it
   stays at `FS_IDLE` throughout. Correct, and by design.
2. The impact reporter fires: the wrist is rigidly coupled to the chassis
   through the wheel, so it takes close to the vehicle's own deceleration.
3. The phone sees vehicle speed in the last 20 s → **`accident`**, 30 s to
   answer, family told if nobody does.

**The gap that had to be closed for this to be true.** The naive version of
step 3 — "was there a GPS fix above 25 km/h in the last twenty seconds" — fails
exactly where it must not. A phone loses GNSS for tens of seconds under a
flyover, in a tunnel, in a multi-storey, between tall buildings. Those are not
incidental places; they are where people crash. A driver entering an underpass
at 60 km/h and hit twenty-five seconds later has no recent fix, so the impact
would be filed as furniture and **nothing would happen** — silently.

So `wasTravelling` is now `sawSpeed || inJourney()`. The **journey latch** turns
on when road speed is seen and turns off only for a positively observed stop of
`JOURNEY_STOP_MS` (3 min — generous, so a red light or a toll queue does not end
a journey and being rear-ended while stationary stays covered) or
`JOURNEY_BLIND_MS` (5 min with no fix at all, so a phone that lost signal and
was then switched off does not claim to be driving all week).

It is the same principle as the resume rule: **absence of fixes is not evidence
of stopping.**

When the latch is what carried it, the note to the family says *"while in a
vehicle (no position fix at the moment of impact)"* rather than quoting a speed
no instrument measured at that moment.

### Will a wrist actually see 8 g in a car crash?

Honest answer: **almost certainly yes for anything serious, and possibly not
for a low-speed bump.**

A hand gripping the wheel is coupled to the chassis through the column, so it
tracks vehicle deceleration fairly closely. A survivable crash puts the occupant
in the 20–40 g range and the chassis higher, so 8 g is cleared with a wide
margin — the sensor will saturate at 16 g and report a floor, not a value.

Where it gets thin is the slow shunt: a 15–20 km/h rear-ending might only put
5–8 g through the wrist, and if the hands are in the wearer's lap rather than on
the wheel, the arm is decoupled and the reading is far less predictable. **This
is the number to check against a real capture** — see the bench protocol — and
it is the reason `IMPACT_G` is written down as a starting value rather than a
finding.

### Where the speed actually comes from

**GPS, and only GPS.** Two sources, in order of preference, both from position
fixes:

1. **`coords.speed`** — the GNSS chip's own Doppler measurement. Direct,
   instantaneous, accurate to a fraction of a km/h. This is the good one.
2. **Distance between consecutive fixes ÷ time**, when the chip declines to
   report speed at all.

The second is not a nicety. Android satisfies a `Balanced`-accuracy request
from fused/network location, and those fixes routinely carry **no speed field**.
That is a deadlock rather than a degradation: the watch idles on Balanced to
save battery and only opens up to real GNSS once it sees road speed — so with
`speed` null it never sees road speed, never opens up, and **accident detection
is silently off for the whole journey.** It needs speed in order to start
measuring speed. `noteFix()` breaks that loop.

The derived figure is guarded: the movement must exceed the fixes' own accuracy
(a 100 m-accurate fix wanders ~100 m on a table, which over 15 s reads as
24 km/h out of nothing), the interval must be 1–60 s, and anything over
300 km/h is a provider jump rather than a car.

**It is never integrated from the accelerometer, and never will be.** Velocity
from a wrist IMU means double-integrating a noisy signal; the error compounds so
fast it is confidently wrong within seconds. A detector that believes a
made-up speed is worse than one that admits it does not know.

### The silent failure to watch for

With no position fixes, `wasTravelling` is false, **every impact is classified
as furniture, and accident detection is completely off while looking exactly
like a feature that is on and has nothing to report.** Revoked location
permission, the system Location toggle, a phone with no GNSS — none of them
produce an error anywhere the wearer would see one.

`speedWatchStatus()` is why the Band console's **Speed** tile reads
*"GPS unavailable — crash detection OFF"* in red rather than showing a dash.
Check it before concluding a real impact was missed by the thresholds.

---

## Thresholds, in one place

| Constant | Value | Lives in |
|---|---|---|
| `FALL_FREEFALL_G` | 0.45 g | `.ino` + `virtualBand.js` |
| `FALL_FREEFALL_MIN_MS` | 70 ms | both |
| `FALL_IMPACT_G` | 2.40 g | both |
| `FALL_IMPACT_WINDOW_MS` | 1400 ms | both |
| `FALL_STILL_BAND_G` | 0.28 g | both |
| `FALL_STILL_MS` | 1600 ms | both |
| `IMPACT_G` | **8.0 g** | both |
| `IMPACT_SETTLE_MS` | 1200 ms | both |
| `IMPACT_REFRACTORY_MS` | 10 s | both |
| `FALL_REFRACTORY_MS` | 15 s | `.ino` |
| `VEHICLE_KMH` | 25 km/h | `motion.js` |
| `STOP_KMH` | 5 km/h | `motion.js` |
| `SPEED_MEMORY_MS` | 20 s | `motion.js` |
| `RESUME_STABLE_MS` | 20 s | `motion.js` |
| `INCIDENT_WINDOW_S` | fall 45 s, accident 30 s | `motion.js` **and** `nigehban_server.py` |

**The fall and impact numbers exist twice on purpose** — once in the firmware,
once in `virtualBand.js` — for the same reason the gesture map does: the app
must not be able to tell which band answered. They drift the same way the
gesture map drifts, which is silently, until a demo behaves differently on the
phone and on the wrist. **Change one, change both.**

`INCIDENT_WINDOW_S` also exists twice, and there the server's copy is the one
that matters: it is what actually escalates. The client's only sizes the
progress bar until `/checkin/self` answers with the real `due_at`.

### Why the accelerometer range is set explicitly

`imuBegin()` sets `accelRange = 16` before `begin()`. **A default here is a
silently broken detector.** The part clips at its full-scale range and reports
the clipped value as though it were real — at ±2 g every fall, every clap and
every car crash reads as "2.0 g", the impact threshold is never crossed, nothing
is ever detected, and there is no error anywhere to find. The numbers look
perfectly plausible; they are just all the same.

16 g is this part's maximum and is **still not enough for a vehicle impact,
which saturates it.** That is accepted: `IMPACT_G` is 8 g, so a saturated
reading is unambiguously over the line. `peak_g` on a real crash means *"at
least 16"*, never *"exactly 16"*.

---

## THE BENCH PROTOCOL — what it takes to fire, and from what height

This is the part that has to be done on real hardware. Everything above is a
starting point taken from the literature and from the phone; **none of it is
calibrated until this has been run on the band, on a wrist.**

### 1. Capture

**Use [`firmware/t7_fall_tuning`](../firmware/t7_fall_tuning/) for the tuning
itself.** It runs these exact state machines with these exact constants, but it
*narrates* — it tells you the peak in g for every knock, and when something does
not fire it names the stage that rejected it and by how much:

```
  SHOCK  [##########      ]  peak 11.40 g   spin 512 deg/s   lasted 180 ms
         impact threshold 8.00 g -> the band WOULD send `impact` to the phone.

  REJECTED at stage 3: hit hard enough (6.80 g) but never stayed still.
             Longest quiet run was 420 ms, needs 1600 ms.
```

That is the difference between tuning and guessing. The shipping firmware is
silent about a near miss by design, so on it "I dropped it and nothing happened"
reads identically to "the IMU is dead".

Type `h` for the live thresholds, `c` for raw CSV, `s` for a session summary.
**Whatever you change there, change in all three places** — T7, the shipping
`.ino`, and `FALL` / `IMPACT` in `virtualBand.js`.

To capture from the **shipping** firmware instead — which is what you want when
checking the band as it will actually ship, rather than tuning — flash it, open
the serial monitor at **115200**, and send:

```json
{"c":"imucal","on":1}
```

It prints a header and then **100 lines a second** of

```
ms,g,fall_stage,impact_stage
```

to **USB serial only** — never over BLE, which has an emergency to carry. Event
lines (`{"t":"evt","e":"fall",...}`) are mirrored into the same stream by
`send()`, so a capture shows both what was measured and what the band concluded.

Paste a capture into a spreadsheet and plot column 2. A drop is a visible dip
toward 0 followed by a spike. Turn it off with `{"c":"imucal","on":0}`.

> Run every test **with the band on a wrist**, strapped as it will be worn. A
> band held in a fist reads completely differently: the arm absorbs the impact
> the strap would have transmitted, and a hand-held drop under-reads peak `g` by
> a large factor.

### 2. What should fire — the true-positive set

Drop onto a **hard floor** (tile or concrete). A carpet or a cushion roughly
halves peak `g` and a duvet kills it entirely, which is the physics and not a
fault: stopping distance is what sets the peak.

| # | Test | Expect |
|---|---|---|
| 1 | Band on wrist, arm dropped from **waist height (~0.9 m)** onto tile, arm left still | `fall` |
| 2 | Same from **shoulder height (~1.4 m)** | `fall`, larger `peak_g` |
| 3 | Drop from **0.5 m**, arm left still | `fall` — this is roughly the floor |
| 4 | Full-body: sit on the floor and let yourself go sideways | `fall` |
| 5 | Strike the band hard against a padded table edge, arm on a moving vehicle | `impact` with `peak_g` ≥ 8 |

**On the free-fall stage and height.** Free-fall time is `t = √(2h/g)`: 0.45 s
from 1.0 m, 0.32 s from 0.5 m, 0.20 s from 0.2 m. `FALL_FREEFALL_MIN_MS` is
70 ms, which is only 2.4 cm of free travel — so **height is not what the
free-fall stage is testing.** It is testing that the arm went unsupported at
all. What height actually buys is impact `g`, which is stage two.

**Record for each drop:** the height, the surface, and the `peak_g` from the
event line. Three runs each. If test 3 does not fire reliably, `FALL_IMPACT_G`
is too high for this strap and this motor mounting — lower it and re-run the
false-positive set below before accepting the change.

### 3. What must NOT fire — the false-positive set

**This half matters more.** A detector that misses one fall in ten is usable; a
detector that cries wolf twice a day gets taken off, and then it misses all of
them.

| # | Test | Expect |
|---|---|---|
| 6 | Shake the band hard for 10 s | **no `fall`** |
| 7 | Clap hands, band on wrist | **no `fall`**; an `impact` is fine and expected |
| 8 | Sit down hard on a chair | **no `fall`** |
| 9 | Drop the band on a desk from 10 cm | **no `fall`** |
| 10 | Slam a door, band in hand | **no `fall`** |
| 11 | Walk downstairs briskly, 2 flights | **no `fall`**, **no `impact`** |
| 12 | Take the band off and put it on a table | **no `fall`** |
| 13 | Test 1, but stand straight back up within 1 s | **no `fall`** — stillness stage |
| 14 | Sleep wearing it, 1 night | **no** events at all |

**Shaking cannot produce a `fall`, structurally.** Free-fall needs \|a\| below
0.45 g held for 70 ms, and a shake oscillates *through* 1 g — it never sits
below the threshold long enough. A hard shake **can** clear 8 g and produce an
`impact`, and that is correct and harmless: the speed gate in `motion.js` throws
it away unless the wearer was in traffic. **This is the single most important
thing to understand about the design** — the `impact` event is deliberately
noisy, and the speed context is what makes it usable.

If tests 6–14 produce a `fall`, do not raise `FALL_IMPACT_G` first. Check
`FALL_STILL_MS` — nearly every false positive is something that hit hard and
then *moved again*, and lengthening the stillness requirement removes it without
making a real fall harder to detect.

### 4. The accident path, without a vehicle

`FORCE CRASH` on the Band console is deliberately **two** buttons in order:

1. **FAKE 45 KM/H** writes a run of real samples into the same history a GPS fix
   would feed.
2. **FORCE CRASH** sends the `impact` the band would have sent.

Press them the other way round and **nothing happens**. That is the classifier
working correctly, not a broken console.

### 5. The accident path, in a vehicle

Do this as a passenger, with somebody else driving.

| # | Test | Expect |
|---|---|---|
| 15 | Ride at 40+ km/h for a minute | Band console **Speed** tile shows the speed, sub-label *"crash detection armed"* |
| 16 | Slap the dashboard hard while moving at 40+ | `accident` check-in opens; countdown 30 s |
| 17 | Answer it with one tap on the band | Cancelled, `near_miss` recorded, nobody told |
| 18 | Repeat 16 and let it run out | Family gets an `accident` alert with the pin at the point of impact |
| 19 | Repeat 16 and keep driving steadily above 25 km/h | Stood down automatically after 20 s |
| 20 | Repeat 16 and pull over immediately | **Not** stood down — the question stands |

**Test 20 is the one that proves the design.** Stopping must never cancel.

### 6. Power

`imuTick()` samples at 100 Hz with the LSM6DS3 in normal mode, which costs
roughly **0.4–0.5 mA continuous.** The F4.3 idle budget is 200–400 µA, so **fall
detection roughly doubles to triples idle current** and the 1–2 week battery
claim does not survive it unchanged.

That is a real regression and it is stated here rather than discovered later.
The fix is the part's own wake-on-motion interrupt — leave the IMU in low-power
mode and let it raise `INT` on `P0.11` when something happens, rather than
polling it — which is deferred, not forgotten. **Measure the actual figure
during the bench run before quoting any battery life.**

---

## Where each piece lives

| Concern | File |
|---|---|
| Sampling, both state machines, CSV mode | `nigehban_band_nrf52.ino`, IMU (F3) block |
| The same machines on the phone | `src/virtualBand.js` |
| Speed history, classification, resume rule | `src/motion.js` |
| Opening the question, the three ways out | `openIncidentCheckin` / `cancelFall` / `escalateFall` / `expireFall` in `App.js` |
| The countdown UI | `src/components/FallCountdown.js` (admin), `src/screens/user/DisarmPad.js` (wearer) |
| The question and its deadline | `POST /checkin/self`, `checkins` table |
| The escalation | `INCIDENT_ESCALATION` + `sweep_once` in `nigehban_server.py` |
| Location and note on the question | migration `005_incident_checkins.sql` |
