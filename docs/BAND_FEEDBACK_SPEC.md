# Band feedback & link indication — spec

**Status:** specification only. **No code, firmware or hardware has been changed.**
**Date:** 1 Sep 2026
**Branch:** `feat/press-feedback-and-link-led`
**Context:** follows the beacon switch-off in
[BAND_WAKE_DISABLED.md](BAND_WAKE_DISABLED.md), which removed the last path an
SOS had when the app was killed and left the disconnected-press buzz confirming
something that no longer happens.

The goal: **every signal the wearer feels must mean something its sender
actually knows.**

---

## The haptics work, and the base unit is 90 ms

**Nothing in this spec is blocked on hardware.** The existing patterns are felt
on the real band: the SOS confirmation (`4 × 120/80`) and the check-in
acknowledgement (`1 × 90/90`) are both clearly perceptible on the wrist,
confirmed by the wearer, 1 Sep 2026.

**The "motor too weak" problem is not live.** Reported by the wearer, 1 Sep
2026: 200 ms gives a good, solid buzz, and the weak-haptics issue described in
[firmware/README.md:174-230](../firmware/README.md) is not what the band does
now. Nothing in this spec is gated on a driver fix, a BOM change or the 20-second
jumper test.

**Decided: 90 ms is the shortest pulse this spec uses.** An earlier draft
proposed a 60 ms tick. 90 ms is the shortest width with confirmed perception on
this hardware — it is what the existing check-in acknowledgement uses — and it is
still short enough to read as an *acknowledgement* rather than a *confirmation*,
which is all the tick has to do. **Nothing below 90 ms appears anywhere in this
design.**

The haptic notes in `firmware/README.md` and the `.ino` header block are left
exactly as written, by instruction. Be aware when reading them that they
describe a weaker motor than the one on the bench today; this spec is built on
the band's current behaviour.

---

## What the wearer is actually told today

Every `feedback()` call in the firmware, verified against the source. This table
is here because the vocabulary turns out to be crowded, and any new pattern has
to be checked against it.

| Pattern | Meaning | Where |
|---|---|---|
| `1 × 60/60` | `{c:'ack'}` — "cloud received our event" — **never sent by the app** | [:510](../nigehban_band_nrf52/nigehban_band_nrf52.ino#L510) |
| `2 × 80/80` | link down | [:758](../nigehban_band_nrf52/nigehban_band_nrf52.ino#L758) |
| `1 × 90/90` | check-in ack, 1 tap | [:439](../nigehban_band_nrf52/nigehban_band_nrf52.ino#L439) |
| `2 × 120/100` | boot | [:709](../nigehban_band_nrf52/nigehban_band_nrf52.ino#L709) |
| `4 × 120/80` | **SOS sent** (connected) | [:450](../nigehban_band_nrf52/nigehban_band_nrf52.ino#L450) |
| `n × 150/120` | `{c:'buzz', n}`, default 2 | [:506](../nigehban_band_nrf52/nigehban_band_nrf52.ino#L506) |
| `1` or `2 × 180/120` | High Alert off / on | [:474](../nigehban_band_nrf52/nigehban_band_nrf52.ino#L474) |
| `1 × 200/100` | link up | [:755](../nigehban_band_nrf52/nigehban_band_nrf52.ino#L755) |
| `5 × 200/150` | fall detected | [:650](../nigehban_band_nrf52/nigehban_band_nrf52.ino#L650) |
| `1 × 250/120` | hold-3s cue | [:364](../nigehban_band_nrf52/nigehban_band_nrf52.ino#L364) |
| `6 × 250/150` | **SOS via beacon** — now a lie, the beacon is off | [:464](../nigehban_band_nrf52/nigehban_band_nrf52.ino#L464) |
| `20 × 300/200` | `{c:'alarm'}` | [:508](../nigehban_band_nrf52/nigehban_band_nrf52.ino#L508) |
| `5 × 350/200` | missed check-in nag | [:776](../nigehban_band_nrf52/nigehban_band_nrf52.ino#L776) |
| `3 × 400/250` | `{c:'checkin_req'}` — "long, unmissable" | [:503](../nigehban_band_nrf52/nigehban_band_nrf52.ino#L503) |

**Two findings from building this table.**

**The vocabulary is saturated and uses only one dimension.** Fourteen meanings,
all expressed as *N pulses of 60–400 ms*. A frightened person cannot count
pulses and cannot tell 120 ms from 150 ms. The one perceptual category not in
use is **a single long continuous buzz** — nothing exceeds 400 ms per pulse.
That gap is reserved below for failure, deliberately.

**The band already signals link state — it just does it only at the edges.**
`1 × 200/100` on connect, `2 × 80/80` on disconnect. There is no standing
indication, so a wearer who missed the edge — asleep, band in a sleeve, or
simply not attending to their wrist at that second — has no way to ask
afterwards. The LED is the ambient version of a signal that already exists.

---

## The problem, in three parts

1. **Press detection is not confirmed per press.** The wearer cannot tell "my
   press was not registered" from "it was registered and failed." Those need
   opposite responses — press again, versus stop pressing and find your phone.
   The firmware already documents the resulting reflex at
   [:425-428](../nigehban_band_nrf52/nigehban_band_nrf52.ino#L425-L428): people
   "tap again out of doubt."

2. **Both "sent" confirmations fire before the network call.** In
   [App.js:357-372](../nigehban-app/App.js#L357-L372):

   ```js
   setDeliveryStatus('queued');
   Vibration.vibrate([0, 300, 120, 300]);          // phone says "SOS!"
   bandRef.current?.send?.({ c: 'buzz', n: 3 });   // band says "SOS!"
   ```
   ```js
   // Now try the network call.
   ```

   The wearer is told twice, on two devices, at a moment when nothing has left
   the phone. **Two channels agreeing is worse than one**, because it reads as
   corroboration.

3. **Nothing says the band is offline until the emergency.** The link-down buzz
   is momentary — felt if the wearer happens to be attending to their wrist at
   that second, and gone for good if not. The moment of the emergency is the
   worst possible time to learn the device is not working, because nothing can
   be done about it then.

---

## The principle

Split the two facts by who can honestly know them:

| | Owns | Because |
|---|---|---|
| **Band** | *"I heard you"* | It is the thing being touched. Instant, local, always true. |
| **Phone** | *"It went / it didn't"* | It is the only thing that knows whether the server has it. |
| **LED** | *"I am linked / I am not"* | Standing state, askable at any moment, no motor required. |

No overlap. The band must never claim delivery, because it cannot know it — a
successful UART write means the phone received the press, not that the family
was paged. With `alertQueue.js` in place an SOS can sit unsent for minutes.

### The three-outcome contract

| Outcome | Who knows | When | Signal |
|---|---|---|---|
| **No link** — nothing has it | the band, certainly | instantly | band buzzes failure itself |
| **Queued** — phone has it, no network | only the phone | ~1 s | `{c:'queued'}` → band; phone buzzes |
| **Delivered** — server has it, family paged | only the phone | ~1–3 s | `{c:'ack'}` → band; phone buzzes |
| **Unknown** — sent, no reply in 4 s | neither | 4 s | band buzzes failure |

The unknown case **fails toward "not sent"**. On this product it is safer to
tell someone help may not be coming than to let them believe it is.

---

## Phase 1 — the phone (ships now, no hardware, no reflash)

**1.1 Move the SOS vibration from dispatch to outcome.** Today
[App.js:361](../nigehban-app/App.js#L361) fires
`Vibration.vibrate([0, 300, 120, 300])` before the network call. It should fire
when the server confirms, with a distinct pattern for the queued case.

Keep a *short* acknowledgement at press time — the wearer must know the app
heard them — but it must feel like an acknowledgement, not a confirmation. The
distinction is the entire point of this document.

**1.2 Add the missing check-in vibration.** A single tap answering a check-in
currently vibrates the phone not at all. The vibrations at
[:829](../nigehban-app/App.js#L829), [:843](../nigehban-app/App.js#L843) and
[:851](../nigehban-app/App.js#L851) are for *receiving* a check-in request, not
answering one.

**1.3 Do not mirror the tap count.** One tap → one phone buzz was considered and
rejected: the band already confirms the input, the phone cannot see individual
taps in a useful way, and echoing them spends the phone's channel on information
the wearer already has while adding a second thing that can disagree.

**1.4 Stealth.** `Vibration.vibrate()` is a direct hardware call and bypasses the
channel reasoning the codebase already applied to notifications —
[notifications.js:210-216](../nigehban-app/src/notifications.js#L210-L216) keeps
the wearer's own SOS notification silent because a siren "could give away the
position of somebody hiding from whoever they pressed it about." Two 300 ms
buzzes against a hard surface carry across a quiet room.

Two 300 ms buzzes should become something felt in a pocket and not heard across a
room, and probably nothing at all while High Alert is armed. Note that the
comment at [:212-213](../nigehban-app/src/notifications.js#L212-L213) currently
*justifies* the silent notification by assuming the wearer "felt it vibrate when
they pressed the button" — so the loud channel is propping up the quiet one, and
changing one means revisiting the other.

---

## Phase 2 — the link LED (hardware)

Its job is the one thing no buzz can do: answer *"is my band linked right now?"*
at any moment, without an event having to happen. The band already signals link
state, but only on the edge — a wearer who was asleep, or had the band in a
sleeve, has no way to ask afterwards.

**2.1 Its own pin, and NOT through `feedbackTick()`.** The onboard LED is
currently slaved to the motor —
[:176-177](../nigehban_band_nrf52/nigehban_band_nrf52.ino#L176-L177) drives both
from the same `gPat`. Wired into that path the new LED would flash with every
buzz and be useless as a state indicator. It needs a free GPIO (D3 appears
unused; D1 is the motor, D2 the button — confirm against the enclosure wiring), a
series resistor, and its own tick function independent of the pattern engine.

**2.2 It cannot stay on.** A 2 mA indicator against the 250–400 mAh cell is
125–200 hours — 5 to 8 days for the LED alone, against the 1–2 week budget in
F4.3. A 20 ms flash every 3 s is a 0.7 % duty cycle, about 0.013 mA. Effectively
free.

**2.3 Blink patterns, not on/off**, because plain on/off cannot separate "fine"
from "flat battery":

| State | Signal |
|---|---|
| Linked | one brief dim flash every ~5 s |
| Not linked | double flash every ~2 s |
| Dead | nothing |

**2.4 Should it carry outcomes too?** A distinct flash on delivered / not-sent
costs nothing extra in hardware and would cover the case where the band is under
a sleeve or the wearer is not sure what they felt. The argument against is that
the buzz already owns outcomes and a second channel saying the same thing is
another thing that can disagree. Worth deciding rather than defaulting.

**2.5 A product question to decide deliberately.** A visible indicator on an
anti-snatch band also tells an attacker the device exists and whether it is
working. Dim and inward-facing, or user-defeatable, are both reasonable answers;
discovering it after the enclosure is cut is not.

---

## Phase 3 — the band haptics

**3.1 The tick.** One short pulse on every debounced button release, so 2 taps =
2 ticks. This is what tells the wearer *how many presses were registered*, which
is the fix for "tap again out of doubt."

**3.2 Do not hang the SOS outcome on the tap window.** SOS deliberately fires the
instant the second tap lands
([:348-351](../nigehban_band_nrf52/nigehban_band_nrf52.ino#L348-L351)) rather
than waiting `TAP_WINDOW_MS` (1200 ms), because waiting meant a slow double-tap
was read as two separate check-in acks — telling the family "I'm fine," twice,
while someone was calling for help. The 1-tap check-in *does* wait the full
window; SOS must not. So the SOS outcome follows the send result, not a timer.

**3.3 The patterns, as built.** Revised on the bench, 1 Sep 2026 — the first
draft is kept below each row where it changed, because *why* it changed is the
useful part.

| Meaning | Pattern | Notes |
|---|---|---|
| Press registered (tick) | `1 × 90`, **on the press edge** | Takes the slot the check-in ack vacates — see 3.5 |
| **SOS delivered** | `1 × 400` | One firm buzz. Longer than anything on the check-in path |
| Check-in answered | `2 × 90/70` | Routine good news, stays light |
| Queued, not delivered | `3 × 250/150` | Plainly not the single "family knows" buzz |
| **Not sent** | `2 × 700/300` | Two long heavy buzzes |

**The tick fires on the way down, not on release.** The first build put it on
the release edge, and on the wrist that reads as lag: press, hold, let go, *then*
feel it. A click confirmation arriving after the click is over is not a click
confirmation. Only the 35 ms debounce is in front of it now, which nobody can
perceive, and counting is unaffected — one press, one tick.

**Delivered has two shapes, chosen by what was being confirmed.** An SOS
reaching the family is the confirmation a frightened person is actually waiting
for; a check-in answered is routine. They must not feel the same. The band picks
the shape itself from `gOutcomeKind`, set when it sent the event — the protocol
does not carry the kind, because a second source of truth is one that can
disagree with the first.

**Failure is two heavy buzzes, not one long one.** The first draft used a single
`1 × 900`, on the argument that long-and-flat reads as *wrong* without training.
That argument is fine in isolation and wrong here: once a single firm buzz means
**sent**, failure cannot also be a single buzz. Telling 400 ms from 900 ms apart
on a wrist, under stress, is the most dangerous distinction in this whole
vocabulary. Repetition carries it instead — one buzz is a full stop, two heavy
ones are insistent, and insistent is what "this did not go" should feel like.

**A known near-collision: `2 × 90/70` (check-in answered) against `2 × 80/80`
(link down).** Ten milliseconds apart on each half is not a distinction anybody
can feel. They can only be confused in one window — pressed, waiting, link drops
— and there the failure buzz replaces the link-down buzz outright, so the
dangerous case is closed. Outside it, "answered" has no press to refer to.

Still worth doing eventually: **retire the link-up and link-down edge buzzes**
and let the LED own link state. It does that job better — continuously and
askable, rather than once and gone — and it frees both `1 × 200/100` and
`2 × 80/80` from a vocabulary this document has already shown is saturated.
Decide it alongside the LED.

**3.4 The pattern engine only supports uniform pulses.** `Pattern` holds one
`onMs` and one `offMs`
([:155-160](../nigehban_band_nrf52/nigehban_band_nrf52.ino#L155-L160)), so
success and failure can differ only in count and width. Allowing a short
sequence — long-then-short, or short-then-long — would open the design space
considerably and is a small, contained change. **Recommended**, because the
current single dimension is what saturated the vocabulary.

**3.5 Two patterns become free, and are reused rather than added to.** The 1-tap
check-in's `1 × 90/90` is the old "I am about to send this" guess, which the tick
plus the outcome now replace — **the tick inherits that slot**, so the wrist
keeps a sensation it already knows and the vocabulary does not grow. `{c:'ack'}`'s
`1 × 60/60` is dead code nothing has ever sent; the command name is kept and
repointed at the delivered pattern, and the 60 ms width disappears with it,
which is what keeps this design clear of anything under 90 ms.

**3.6 `feedback()` clobbers the current pattern.** It overwrites `gPat`
outright, so the tick for tap 2 and the SOS outcome buzz — which fire within
milliseconds of each other — will destroy one another. Needs a small queue, or a
"do not interrupt an outcome" guard. Without it the feedback becomes unreliable
at exactly the moment it matters.

---

## Protocol changes

Small and additive, but the file calls the band↔phone protocol **frozen**, so
they are deliberate changes and must be mirrored in
[virtualBand.js](../nigehban-app/src/virtualBand.js) — the .ino names the gesture
map as "the ONLY place hardware meets meaning" and requires the two to stay
identical.

| Command | State | Action |
|---|---|---|
| `{c:'ack'}` | **exists in firmware, never sent by the app** | wire it up: send on server confirmation |
| `{c:'queued'}` | does not exist | add: phone has it, no network yet |
| `{c:'buzz', n}` | exists, varies count only | leave alone; named commands are better than letting the app invent patterns |

Using the existing `ack` rather than inventing `{c:'buzz', p:'sent'}` is
deliberate — it already carries exactly this meaning ("cloud received our
event"), and keeping pattern definitions on the band stops the app and the
firmware drifting into different ideas of what "sent" feels like.

---

## Decisions needed before any of this is built

1. ✅ **Tick width — settled at 90 ms**, 1 Sep 2026. Nothing in the design goes
   below it.
2. **Retire the link-up / link-down edge buzzes** in favour of the LED (3.3)?
   Recommended, and it resolves the only pattern collision left.
3. **LED: pin, brightness, placement, and whether it is defeatable** (2.5). Due
   before the enclosure is finalised.
4. **Should the LED also carry outcomes** (2.4), or only link state?
5. **Phone vibration strength** (1.4) — and the knock-on to the notification
   channel's justification.
6. **Extend the pattern engine** (3.4), or accept uniform pulses?

---

## Deliberately out of scope

- **Re-enabling the beacon wake.** Unrelated, and gated on BUG-012/013 —
  [BAND_WAKE_DISABLED.md](BAND_WAKE_DISABLED.md).
- **A periodic "still disconnected" nag buzz.** It burns battery and teaches
  people to ignore the band. The LED answers the same question without nagging.
- **Removing the dead beacon code from the .ino.** Inert, and it is the
  foundation the band id will build on.
- **BUG-003 / BUG-004** (surfacing `lastError` in the app) — closely related and
  worth doing alongside Phase 1, but they are their own entries.
