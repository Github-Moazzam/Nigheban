# Testing the press feedback, outcome buzzes and check-in nag

**Branch:** `feat/press-feedback-and-link-led`
**Spec:** [BAND_FEEDBACK_SPEC.md](BAND_FEEDBACK_SPEC.md)

A checklist to work through with a phone in one hand and a band on the wrist.
Nothing here has been run yet — every box is unticked on purpose.

---

## What you have to rebuild

| | Rebuild needed? |
|---|---|
| **The app** | **Probably not.** Every change is plain JavaScript — `App.js` and `src/virtualBand.js`. No native module, no manifest, no new permission. A Metro reload picks it all up. |
| **The band** | **Yes.** All firmware changes need flashing. |
| **The server** | **No.** Not one line changed. |

The app needs a *native* rebuild only if the APK on the phone predates the
band-wake switch-off (`b2afe6d`, PR #27) — that one did touch Kotlin. If you
have been running a build from after that merge, Metro is enough:

```bash
cd nigehban-app
npx expo start
```

Then reload the app on the phone (shake → Reload, or `r` in the Metro terminal).

### Flashing the band

Arduino IDE, per [firmware/arduino_setup.md](../firmware/arduino_setup.md):

- **Tools → Board → Seeed nRF52 Boards → Seeed XIAO nRF52840 Sense** (must say
  *Sense*). FQBN `Seeeduino:nrf52:xiaonRF52840Sense`.
- Open `nigehban_band_nrf52/nigehban_band_nrf52.ino`, pick the port, Upload.
- **No port?** Double-tap reset quickly — the red LED fades in and out, a
  `XIAO-SENSE` drive mounts, the port appears.
- **Keep the Serial Monitor open at 115200.** It is the cheapest window into
  what the band thinks is happening, and two of the checks below are read there
  rather than felt.

> ⚠ **`PIN_LINK_LED` is `D3`.** If anything else in your build is wired to D3,
> change the define before flashing. With nothing fitted the LED code just
> toggles an unconnected pin, which is harmless — but it also means **section 6
> cannot be tested until an LED and a series resistor are actually on the pin.**

---

## Start here: most of this needs no band at all

`virtualBand.js` mirrors the firmware, so the tick, the three outcome patterns
and the whole check-in nag can be exercised on the phone alone, before you spend
any time flashing. The buzz comes out of the phone's motor instead of the wrist,
which proves the logic even though it cannot prove the haptics.

Open the app → **BAND** tab → use the on-screen button.

Do this first. A logic bug found here costs a Metro reload; the same bug found
after flashing costs a flash cycle.

---

## 1. The tick — "I counted that press"

The foundation. Everything else assumes the wearer can tell how many presses
landed.

- [ ] **The tick lands as the button goes down**, under your finger — not after
      you let go. It moved to the press edge after the first bench run, where it
      fired on release and read as lag.
- [ ] **One tap** → exactly **one** short tick.
- [ ] **Two taps** → **two** ticks, felt as two separate events, not one smear.
- [ ] **Three taps** → **three** ticks.
- [ ] The tick is clearly *lighter* than any outcome buzz that follows it.

If two taps read as one blurred buzz, that is the 90 ms tick being too short or
the taps being too fast — raise `FB_TICK_MS`, note the new value, and say so.
This is the one number in the design that was chosen rather than measured.

---

## 2. SOS — delivered

Band linked, phone online.

- [ ] Double-tap. Feel **2 ticks**, one under each press.
- [ ] About 1–3 s later: **one firm buzz** on the wrist *and* the matching buzz
      from the phone, together. Single, and clearly longer than the ticks.
- [ ] It is plainly different from the **two light pulses** a check-in answer
      gives (section 5) — that is the whole point of the split.
- [ ] The SOS screen shows the alert, and the family actually receives it.
- [ ] Serial Monitor shows the `sos` event going out.

**The point of this test:** the wrist must say nothing at all between the ticks
and the delivered buzz. If a four-pulse confirmation still fires the instant you
tap, the old behaviour survived.

---

## 3. SOS — queued (phone has it, no network)

The case that was completely invisible before: the alert is safe on the phone
and **nobody has been paged**.

Turn **WiFi and mobile data off**, leave **Bluetooth on** so the band stays
linked. (Airplane mode usually kills Bluetooth too; if you use it, switch
Bluetooth back on afterwards.)

- [ ] Double-tap. Feel **2 ticks**.
- [ ] Then **three medium pulses** — plainly not the single firm buzz that means
      the family knows.
- [ ] Toast: *"No signal — your alert is saved and will send automatically…"*
- [ ] Restore the network and confirm the alert flushes and reaches the family.

---

## 4. SOS — not sent (no link at all)

- [ ] Turn the phone's **Bluetooth off**, or walk out of range, or force-stop
      the app.
- [ ] Double-tap the band. Feel **2 ticks**, then **two long heavy buzzes** —
      unmistakably not the single firm buzz that means "sent".
- [ ] Nothing reaches the server. **This is correct, not a failure** — it is the
      cost of the beacon being switched off
      ([BAND_WAKE_DISABLED.md](BAND_WAKE_DISABLED.md)).
- [ ] Serial Monitor shows the `sos` event with `"via":"beacon"`.

---

## 5. The check-in nag ← the new behaviour

Get a check-in either way:

- **From family:** the other phone asks for a check-in. Window **45 s** as the
  app sends it.
- **From Nigehban itself:** arm **High Alert** and wait. The server asks on its
  own every **5–10 minutes**, window **90 s**. These are the only two things
  that ever open a check-in.

Then, without pressing anything:

- [ ] Initial buzz: **three long pulses** — the unmissable one.
- [ ] A **two-pulse** reminder about **12 s** later. Same feel, one pulse
      shorter: the same question again.
- [ ] It keeps repeating every ~12 s.
- [ ] In the **last 20 s** the gap tightens to about **5 s** — noticeably more
      urgent without anything on screen.
- [ ] Let it run out: **five pulses** at the deadline, `checkin_missed` on the
      Serial Monitor, and the family is told.
- [ ] **No nag fires after the deadline.** Nothing should buzz "answer me" once
      the family has already been called.

Then again, answering it:

- [ ] Ask for another check-in. Wait for at least one nag.
- [ ] **Press once.** Nagging stops *immediately* — not at the next interval.
- [ ] The delivered buzz follows once the server confirms.
- [ ] The asking side sees the answer.

---

## 6. The link LED — needs hardware first

Nothing to see until an LED and a series resistor are fitted to **D3**. Until
then this section is untestable, and that is expected.

Once fitted:

- [ ] **Linked:** one brief flash every ~5 s.
- [ ] **Not linked** (Bluetooth off, or out of range): a **double** flash every
      ~2 s.
- [ ] Flashing, never steady — a steady LED would eat the battery budget.
- [ ] It does **not** flash along with the motor. If it mirrors every buzz, it
      has been wired to `LED_BUILTIN` rather than `PIN_LINK_LED`.
- [ ] If it is on when it should be off, set `LINK_LED_ACTIVE_HIGH` to `0`.

---

## 7. Regressions — things that must still work

Cheap to check, and each one is a path this branch touched.

- [ ] **One tap during a live SOS** stands it down (it does not answer a
      check-in).
- [ ] **Press SOS again while one is already live:** no second alert, and the
      wrist gets the single firm *delivered* buzz — **not** the two heavy
      failure buzzes four seconds later. This was a real bug before the guard
      was added.
- [ ] **Hold 3 s** still toggles High Alert, still buzzes its cue while held.
- [ ] **SOS from the app's own button:** the phone vibrates and the **band stays
      silent**. It asked nothing, so it should be told nothing.
- [ ] **Check-in answered from the app's button** rather than the band: the band
      stops nagging.
- [ ] Battery, heartbeat and link-up/link-down buzzes all behave as before.

---

## 8. Harder to trigger, worth trying once

- [ ] **Outcome timeout.** Double-tap, then force-stop the app within a second.
      About 4 s later the wrist should give the two heavy failure buzzes — the
      band giving up on an answer that is never coming.
- [ ] **Link dies mid-wait.** Double-tap, then immediately switch the phone's
      Bluetooth off. The failure buzz should come *straight away* rather than
      after the 4 s timeout, and the Serial Monitor should print
      `link down while awaiting outcome`.

---

## If something is wrong

Note **which** buzz you felt and **when**, not just "it did not work" — the
whole design is about telling patterns apart, so "two pulses instead of three"
is the useful report and "the vibration was wrong" is not.

The pattern table in [BAND_FEEDBACK_SPEC.md](BAND_FEEDBACK_SPEC.md) lists every
buzz in the firmware with its meaning, which is the fastest way to work out what
you actually felt.
