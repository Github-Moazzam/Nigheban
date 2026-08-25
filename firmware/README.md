# Bench bring-up — XIAO nRF52840 Sense

Breadboard tests that run **before** `nigehban_band_nrf52/` exists. Each one
isolates a single unknown, so a failure tells you exactly what is broken.
Run them in order and do not skip ahead on a failure.

Covers milestone **F1** and de-risks **F2 / F3 / F4** in
[DEVELOPMENT_PLAN.md](../DEVELOPMENT_PLAN.md).

---

## Setup (once)

> Full install guide, versions, troubleshooting and verified pin macros:
> **[arduino_setup.md](arduino_setup.md)**. Read that when setting up a new
> machine; the summary below is enough if the toolchain already works.

| | |
|---|---|
| Core | **Seeed nRF52 Boards** (`Seeeduino:nrf52`) — the Adafruit Bluefruit core |
| Board | Tools → Board → **Seeed XIAO nRF52840 Sense** (must say *Sense*) |
| Library | Library Manager → **Seeed Arduino LSM6DS3** (T4 only) |
| Monitor | 115200 baud |

Boards Manager URL, if not already in Preferences:

```
https://files.seeedstudio.com/arduino/package_seeeduino_boards_index.json
```

> **Not the mbed core.** `EXECUTION_PLAN.md:493` settles this: Bluefruit ships
> `BLEUart`, which *is* the Nordic UART Service the app already speaks, plus
> `addManufacturerData()` for the v2 beacon and the advertising-interval control
> the power budget depends on. The mbed core's only advantage is a drop-in PDM
> mic library, and scream detection is deferred to v2 (`EXECUTION_PLAN.md:746`).

**Solder the headers first.** The XIAO ships with them loose. A cold joint on
`3V3` or `GND` presents exactly like a firmware bug.

**No port in Tools → Port?** Double-tap the reset button quickly. The red LED
fades in and out and a `XIAO-SENSE` drive mounts — that is the bootloader. Use
this any time a bad sketch locks the board up.

### Every sketch needs `#include <Adafruit_TinyUSB.h>`

On this core USB CDC lives in a separate library, so without that include
`Serial` does not link:

```
undefined reference to `Adafruit_USBD_CDC::begin(unsigned long)'
undefined reference to `Serial'
```

It ships with the core — nothing to install, but it must be in **every** sketch
that uses `Serial`, including `nigehban_band_nrf52/` when you write it.

---

## Verified against the installed core

`Seeeduino:nrf52@1.1.13`, `Seeed Arduino LSM6DS3@2.0.7`, FQBN
`Seeeduino:nrf52:xiaonRF52840Sense`. All four sketches compile clean.

Real macro names from
`packages/Seeeduino/hardware/nrf52/1.1.13/variants/Seeed_XIAO_nRF52840_Sense/variant.h`:

| Purpose | Macro | Value |
|---|---|---|
| Onboard LED (active LOW) | `LED_BUILTIN` / `LED_RED` | 11 |
| IMU power gate | `PIN_LSM6DS3TR_C_POWER` | 15 |
| IMU interrupt (F3 wake-on-motion) | `PIN_LSM6DS3TR_C_INT1` | 18 |
| Battery divider enable | `VBAT_ENABLE` | 14 |
| Battery ADC | `PIN_VBAT` | 32 |
| PDM mic | `PIN_PDM_PWR` / `_CLK` / `_DIN` | 19 / 20 / 21 |

> **`EXECUTION_PLAN.md:512` will not compile.** It writes `PIN_VBAT_ENABLE`;
> the macro is `VBAT_ENABLE`. Fix when doing **F2.3**.

> ### `VBAT_ENABLE` must stay LOW. HIGH or high-Z destroys the board.
>
> The divider is `BAT+ — 1M — P0.31 — 510k — P0.14`, so `VBAT_ENABLE` (P0.14) is
> its **bottom** leg. LOW completes the path and is what keeps P0.31 safely
> divided. Set it HIGH, or leave it high-Z as an `INPUT`, and there is no
> division: P0.31 floats toward `BAT+` through the 1 M — ~4.2 V while charging,
> against a **3.6 V absolute maximum**. The pin is permanently destroyed. Seeed
> warn about this explicitly.
>
> The tempting power saving — *"the divider drains current, gate it between
> readings"* — is exactly the fatal move. That drain is 4.2 V / 1.51 MΩ ≈
> **2.8 µA**, under 1.5% of the F4.3 budget. Leave the pin LOW forever.

**I²C:** `Wire` is the external D4/D5 header. The IMU sits on the internal bus,
`Wire1` (pins 17/16). The Seeed library handles this itself with an internal
`#define Wire Wire1`, so `LSM6DS3 imu(I2C_MODE, 0x6A)` is correct as written —
no bus argument needed.

**On the mic:** the PDM pins *are* defined in this non-mbed variant, so the mic
is more reachable than "mbed only" suggests. It remains a v2 item for a power
reason, not a core reason — continuous listening is ~3–5 mA against a 200–400 µA
budget, which is 1–2 days of battery instead of 1–2 weeks.

---

## Wiring

Everything is USB powered. **No battery on the breadboard.**

| Motor module | XIAO | |
|---|---|---|
| `IN` | `D1` | |
| `VCC` | `3V3` | not 5V — see below |
| `GND` | `GND` | |
| — | — | 100 µF electrolytic across the module's VCC/GND, stripe leg to GND |

| Button | XIAO |
|---|---|
| one leg | `D2` |
| diagonally opposite leg | `GND` |

A 6×6 tactile has four legs in two permanently-shorted pairs. Pick **diagonal**
legs and the pair cannot be wrong. No pull-up resistor — `INPUT_PULLUP` does it.

### The motor module already has its driver

The 3-pin module carries the transistor, its base resistor and the flyback
diode on board. **Do not fit the 2N2222 / 1 kΩ / 1N4148.** Driving `IN` from a
GPIO is correct here — the pin only feeds a base resistor.

This makes the "never drive the motor from a GPIO pin" warnings in
`README.md:41`, `EXECUTION_PLAN.md:596` and `F4.1` **stale for this part**. They
remain correct for a bare coin motor, which is what you would fit if the module
is too bulky for the wrist enclosure.

The 100 µF is still required. Motor inrush is ~5× running current for a few ms;
without the bulk cap it sags the 3V3 rail and browns out the radio mid-notify.
*If the band disconnects whenever it buzzes, that cap is what's missing.*

### Why 3V3 and not the 5V pin

There is no 5 V on battery — the shipped band runs off a LiPo through the 3V3
rail. Test at the voltage you ship at, or the bench result means nothing. 5 V
would also over-drive a 3 V coin motor.

---

## The tests

| | Sketch | Wiring | Pass |
|---|---|---|---|
| **T1** | [t1_blink](t1_blink/) | none | Red LED ~1 Hz, `tick` on serial |
| **T2** | [t2_motor](t2_motor/) | motor | Three distinct patterns you can feel, matching the log |
| **T3** | [t3_button_motor](t3_button_motor/) | motor + button | Buzz at 3 s, double-buzz at 5 s, timings match a stopwatch |
| **T4** | [t4_imu](t4_imu/) | none | `IMU OK`, az ≈ 1.00 g flat, `mag` spikes when shaken |
| **T6** | [t6_ble](t6_ble/) | none | `Nigehban-01` in nRF Connect, heartbeat notifies, writes echo back |

**T1 before you wire anything.** It proves the core, board selection, port and
upload path while there is nothing else to blame.

**T2/T3:** hold the coin motor between two fingers — on a desk it just skitters.
**Tape it down**, or it will vibrate jumper wires out of the breadboard and you
will blame the code.

**T3** fires its haptic *when the threshold is crossed*, not on release. That is
the real interaction model: in a snatching the user cannot look at a screen, so
the wrist must confirm the gesture while their thumb is still down.

**T4** needs no wiring — the IMU is on the board. The catch is the power gate at
`P1.08`: the Sense can switch the IMU off entirely for low power, and until you
drive that pin HIGH, `begin()` fails on perfectly good hardware. The section 8
skeleton in `EXECUTION_PLAN.md` is missing that line.

---

## Open — haptic strength (deferred, not resolved)

The buzz is weaker than it should be. **Current setting: steady 1500 ms**, which
tested stronger than every pulse train in [t5_haptic_patterns](t5_haptic_patterns/) —
the opposite of how a healthy coin ERM behaves.

That inversion is the symptom worth remembering: pulses of 100–150 ms felt
weaker than one long buzz, which means the motor is spinning up far too slowly
and probably never reaches full speed.

**Measured on this unit: 200 ms is too weak to feel reliably; ~300 ms is the
floor.** A healthy coin ERM reaches usable amplitude in 50–80 ms, so this one is
roughly 4× slow. That is the same slow-spin-up cause as the inversion above, now
with a number on it.

### Why this cannot be fixed by raising the timings

The obvious response — make every pulse 300 ms — quietly destroys the haptic
vocabulary. Every `feedback()` call ported from
[`nigehban_band_esp32.ino`](../nigehban_band_esp32/nigehban_band_esp32.ino) sits
under the floor:

| Meaning | Current | At a 300 ms floor |
|---|---|---|
| `ack` from cloud | `feedback(1, 60, 60)` | 5× longer |
| check-in ack ("I'm fine") | `feedback(1, 90, 90)` | 3× longer |
| **SOS fired** | `feedback(4, 120, 80)` | 0.7 s → **1.8 s** |
| High Alert on | `feedback(2, 180, 120)` | 0.6 s → **1.2 s** |

Two things break. The patterns stop being *distinguishable* — at 300 ms per
pulse with adaptation blunting anything longer, a 1-pulse ack and a 4-pulse SOS
both read as "a long buzz happened." And the SOS confirmation arrives ~1.8 s
after the tap, in the one situation where the wearer cannot wait and cannot
look.

So the 300 ms floor is not a tuning value to adopt. It is the measurement that
says **fix the driver**, because the 100–150 ms design is correct and the
hardware is what is failing to deliver it.

**Leading hypothesis:** the module is built for 5 V logic. If its base resistor
is the 5.1 kΩ part, a 3.3 V GPIO delivers ~0.5 mA of base current — enough to
switch roughly 50 mA, not the 80–100 mA the motor draws. The transistor never
saturates, so the motor runs permanently at partial power.

**The 20-second test, no multimeter:** leave `VCC` on `3V3`, move `IN` off the
GPIO and jumper it straight to the `5V` pin.

| Result | Meaning | Fix |
|---|---|---|
| Noticeably stronger | Base drive is the bottleneck | Drop the module; use BOM items 5/6/7 with the **AO3400 logic-level MOSFET** (no base current, fully on at 3.3 V) |
| About the same | The motor is the ceiling | Component change — larger ERM, or the LRA at `README.md:243` |

With a multimeter: probe across the motor's solder pads while buzzing. ~3.0–3.2 V
means full drive; meaningfully lower confirms the transistor isn't saturating.

> Must be resolved before the enclosure is finalised — one branch changes the
> BOM and brings the discrete driver parts back into the build.

---

## After T4 passes

Run **T6** — it is the last unknown. T1–T4 prove the board, motor, button and
IMU; T6 proves the radio, and F1.2/F1.3 close with it.

Once T6 passes, F1 is done and every F2 unknown — protocol, haptics, gestures,
radio — is proven. The port then reuses `Button`, `Pattern`, `onGesture`
and `handleCommand` **verbatim** from
[`nigehban_band_esp32.ino`](../nigehban_band_esp32/nigehban_band_esp32.ino);
only the `BLEDevice`/`BLEServer` layer is rewritten onto `BLEUart`. The protocol
is frozen, so the app must not notice the swap.

Note these bench sketches use blocking `delay()` in `buzz()`. The shipping
firmware must not — use the non-blocking `feedback()` / `feedbackTick()` pattern
player already written in the ESP32 sketch (`F4.3`: never `delay()` in `loop()`).
