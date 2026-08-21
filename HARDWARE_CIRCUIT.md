# Nigehban — Hardware & Circuit Plan

Everything that gets soldered, and exactly which pin goes where.

This is the wiring companion to [EXECUTION_PLAN.md](EXECUTION_PLAN.md) §8–9. The
plan says *what* the band does; this file says *how it is built*, in two stages:

| | Board | When | Purpose |
|---|---|---|---|
| **Part A** | ESP32 WROOM-32 on a breadboard | **today**, with the parts already on your desk | Prove the gesture engine, the protocol and the app against real buttons. No motor, no battery, no IMU needed. |
| **Part B** | XIAO nRF52840 Sense | the real band | The product: BLE 5.0, on-board IMU, LiPo charger, haptics, 21 × 17.5 mm. |

Both run the **same frozen protocol** ([EXECUTION_PLAN.md §5](EXECUTION_PLAN.md)),
so nothing on the phone or the server changes when you swap boards. What changes
is one header of pin numbers and the radio API — that is the whole point of
building it in this order.

> **Read before the soldering iron is hot:** §B.9 (solder order) and §B.10
> (measure before you power on). Two of those steps are the difference between a
> working band and a dead 21 × 17.5 mm board.

---

## Contents

- [Part A — ESP32 bench rig (today)](#part-a--esp32-wroom-32-bench-rig)
  - [A.1 What you need](#a1-what-you-need--all-of-it-is-already-on-your-desk)
  - [A.2 Pin map](#a2-pin-map--esp32-wroom-32)
  - [A.3 Wiring, connection by connection](#a3-wiring-connection-by-connection)
  - [A.4 Breadboard layout](#a4-breadboard-layout)
  - [A.5 Pins you must not use](#a5-pins-you-must-not-use-on-a-wroom-32)
  - [A.6 Code — bench bring-up sketch](#a6-code--bench-bring-up-sketch)
  - [A.7 Code — shared pin header](#a7-code--shared-pin-header)
  - [A.8 Adding the motor to the ESP32 later](#a8-adding-the-motor-to-the-esp32-later)
- [Part B — XIAO nRF52840 Sense (the real band)](#part-b--xiao-nrf52840-sense-the-real-band)
  - [B.1 Bill of materials](#b1-bill-of-materials)
  - [B.2 Complete pin map](#b2-complete-pin-map)
  - [B.3 Net list — what connects to what](#b3-net-list--what-connects-to-what)
  - [B.4 Button circuit](#b4-button-circuit)
  - [B.5 Motor driver circuit](#b5-motor-driver-circuit)
  - [B.6 Power, battery and the slide switch](#b6-power-battery-and-the-slide-switch)
  - [B.7 The full schematic](#b7-the-full-schematic)
  - [B.8 Physical layout](#b8-physical-layout)
  - [B.9 Solder order](#b9-solder-order--do-it-in-this-sequence)
  - [B.10 Measure before you power on](#b10-measure-before-you-power-on)
  - [B.11 Code — pins header](#b11-code--pins-header)
  - [B.12 Code — bring-up tests, one subsystem at a time](#b12-code--bring-up-tests-one-subsystem-at-a-time)
  - [B.13 Code — the band firmware](#b13-code--the-band-firmware)
  - [B.14 Power budget](#b14-power-budget)
- [Troubleshooting](#troubleshooting)
- [What you still have to buy](#what-you-still-have-to-buy)

---
---

# Part A — ESP32 WROOM-32 bench rig

**Goal today:** a board on a breadboard that fires every Nigehban gesture into
the app over BLE. An ESP32, buttons, resistors and capacitors are enough for
100 % of the firmware logic and 100 % of the app integration. The motor and the
battery are cosmetic at this stage — an LED stands in for the buzz.

## A.1 What you need — all of it is already on your desk

| # | Part | Qty | Note |
|---|---|---|---|
| 1 | ESP32 WROOM-32 dev board | 1 | Any variant with USB. |
| 2 | Tactile push button | 1–2 | One is enough. Two makes demoing faster. |
| 3 | 100 nF ceramic capacitor | 1–2 | Across each button. Optional — firmware already debounces 35 ms. |
| 4 | 220 Ω – 330 Ω resistor + any LED | 1 | **Motor stand-in.** Blinks exactly where the real motor buzzes. |
| 5 | Breadboard + jumper wires | — | |
| 6 | USB cable | 1 | Power *and* serial monitor. No battery needed. |

Not needed today: LiPo, coin motor, transistor, flyback diode, 100 µF, slide
switch, IMU. `SIM_BATTERY 1` fakes a draining battery for the demo and
`HAS_IMU 0` compiles the fall detector out.

## A.2 Pin map — ESP32 WROOM-32

| Signal | GPIO | Mode | Connects to | Why this pin |
|---|---|---|---|---|
| `PIN_BTN_A` | **GPIO 4** | `INPUT_PULLUP` | button A → GND | Safe pin: no strapping role, not flash, has an internal pull-up. |
| `PIN_BTN_B` | **GPIO 27** | `INPUT_PULLUP` | button B → GND | Safe pin. *(The committed sketch says GPIO 5 — see §A.5, change it.)* |
| `PIN_LED` | **GPIO 2** | `OUTPUT` | on-board blue LED | Already wired on the board. Nothing to connect. |
| `PIN_MOTOR` | **GPIO 18** | `OUTPUT` | 220 Ω → LED → GND *(today)* | The same pin the transistor uses later, so no code change when the motor arrives. |
| I²C SDA | GPIO 21 | — | *(free)* | Only if you add an MPU-6050 later. |
| I²C SCL | GPIO 22 | — | *(free)* | Same. |
| 3V3 | — | — | breadboard + rail | Unused today. |
| GND | — | — | breadboard − rail | **Every ground goes to this one rail.** |

## A.3 Wiring, connection by connection

Seven wires. That is the entire rig.

```
 1.  ESP32 GND        ─────────────────►  breadboard  − (blue) rail
 2.  ESP32 3V3        ─────────────────►  breadboard  + (red) rail    [spare]

 3.  ESP32 GPIO 4     ─────────────────►  button A, leg 1
 4.  button A, leg 3 (DIAGONAL)  ──────►  − rail                      [GND]

 5.  ESP32 GPIO 27    ─────────────────►  button B, leg 1
 6.  button B, leg 3 (DIAGONAL)  ──────►  − rail                      [GND]

 7.  ESP32 GPIO 18    ── 220 Ω ── LED anode (long leg)
     LED cathode (short leg / flat side)  ►  − rail                   [GND]
```

**Use diagonally opposite legs on a 6 × 6 tactile switch.** The four legs are two
permanently-connected pairs; the switch closes one pair onto the other. Pick two
legs on the same side and you have wired a plain piece of wire — the button then
reads as permanently pressed. Diagonal is always correct.

**No external pull-up resistor is needed.** `INPUT_PULLUP` turns on the ESP32's
internal ~45 kΩ pull-up: the pin idles at 3.3 V (reads `HIGH`) and the button
shorts it to 0 V (reads `LOW`). The firmware is written for exactly this — `LOW`
means pressed.

Optional hardware debounce, if you want the cleanest edges:

```
      GPIO 4 ──┬─────────────────┐
               │                 │
          [TACTILE SW]        100 nF      (ceramic, no polarity)
               │                 │
              GND ───────────────┘
```

45 kΩ × 100 nF ≈ 4.5 ms rise — well inside the firmware's 35 ms debounce window,
so the two do not fight each other. Do **not** put this cap on GPIO 0, 2, 12 or
15: those are sampled at reset and a slowed edge changes the boot mode.

## A.4 Breadboard layout

```
                       ┌──────────────────────────┐
                       │       ESP32 WROOM-32     │
                       │        [ USB ]           │
                  3V3 ─┤                          ├─ GND ───────┐
                       │                          │             │
       ┌───────── D4 ──┤                          ├── D18 ──┐   │
       │               │                          │         │   │
       │   ┌───── D27 ─┤                          │      [ 220Ω ]
       │   │           └──────────────────────────┘         │   │
       │   │                                                ▼   │
    ┌──┴┐ ┌┴──┐                                            LED  │   ("buzz")
    │SW │ │SW │   SW-A = gestures (tap / double tap / hold)  │   │
    │ A │ │ B │   SW-B = instant SOS while testing           │   │
    └─┬─┘ └─┬─┘                                              │   │
      │     │                                                │   │
 ─────┴─────┴────────────────────────────────────────────────┴───┴──── GND rail
```

## A.5 Pins you must not use on a WROOM-32

| GPIO | Why |
|---|---|
| 6, 7, 8, 9, 10, 11 | Wired to the SPI flash **inside** the module. Using them breaks the boot. |
| 0 | Strapping: LOW at reset = flash-download mode. A button here means the sketch never runs. |
| 2 | Strapping, and the on-board LED. Fine as an **output**; never add an external pull-up — it blocks flashing. |
| 5, 12, 15 | Strapping. **GPIO 12 is the worst**: HIGH at reset sets the flash to 1.8 V and the board will not boot. 5 and 15 emit a PWM burst at boot. |
| 34–39 | Input-only, **and no internal pull-up**. A button on these floats and gives phantom presses. |

Safe for anything: **4, 13, 14, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33**.
(16 and 17 are taken by PSRAM on WROVER modules — not on a plain WROOM-32.)

> [nigehban_band_esp32.ino](nigehban_band_esp32/nigehban_band_esp32.ino) ships
> with `PIN_BTN_B 5`. It works most of the time, but hold button B while plugging
> in USB and boot behaviour is undefined. Change that one line to `27`.

## A.6 Code — bench bring-up sketch

Flash this **before** the BLE firmware. It proves the wiring alone — no radio,
no protocol, nothing else to blame when something misbehaves.

`nigehban_bench_esp32/nigehban_bench_esp32.ino`

```cpp
/* Nigehban — ESP32 bench wiring test.
   Proves: both buttons, the on-board LED, the motor stand-in.
   No BLE. If this does not pass, nothing built on top of it will.      */

#define PIN_BTN_A   4
#define PIN_BTN_B  27
#define PIN_LED     2
#define PIN_MOTOR  18          // 220R + LED today, transistor + motor later

void buzz(uint8_t pulses, uint16_t onMs, uint16_t offMs) {
  for (uint8_t i = 0; i < pulses; i++) {
    digitalWrite(PIN_LED, HIGH); digitalWrite(PIN_MOTOR, HIGH);
    delay(onMs);
    digitalWrite(PIN_LED, LOW);  digitalWrite(PIN_MOTOR, LOW);
    delay(offMs);
  }
}                              // delay() is fine HERE — never in the real loop()

void setup() {
  Serial.begin(115200);
  pinMode(PIN_BTN_A, INPUT_PULLUP);
  pinMode(PIN_BTN_B, INPUT_PULLUP);
  pinMode(PIN_LED,   OUTPUT);
  pinMode(PIN_MOTOR, OUTPUT);

  Serial.println("\nNigehban bench test");
  Serial.println("Buttons must read 1 untouched, 0 pressed.");
  buzz(2, 120, 100);           // startup cue: two blinks on BOTH LEDs
}

void loop() {
  static bool lastA = HIGH, lastB = HIGH;
  static uint32_t pressedAt = 0;

  bool a = digitalRead(PIN_BTN_A);
  bool b = digitalRead(PIN_BTN_B);

  if (a != lastA) {
    lastA = a;
    if (a == LOW) { pressedAt = millis(); Serial.println("A pressed"); }
    else { Serial.printf("A released after %lu ms\n", millis() - pressedAt);
           buzz(1, 80, 80); }
    delay(30);                 // crude debounce, test sketch only
  }

  if (b != lastB) {
    lastB = b;
    if (b == LOW) Serial.println("B pressed -> SOS pattern");
    else          buzz(4, 120, 80);
    delay(30);
  }

  static uint32_t t = 0;       // once a second: raw levels, so a dead joint shows
  if (millis() - t > 1000) { t = millis(); Serial.printf("A=%d B=%d\n", a, b); }
}
```

**What you should see** (Serial Monitor, 115200 baud):

| Test | Expected |
|---|---|
| Power-on | Both LEDs blink twice. |
| Idle | `A=1 B=1` once a second. |
| Hold A | `A pressed`, then `A=0 B=1` while held. |
| Release A | `A released after NNN ms`, one blink. |
| Press B | `B pressed -> SOS pattern`, four fast blinks. |

A pin reading `0` with nothing pressed → the button legs are on the same side
(§A.3), or the wire is in the wrong breadboard row. A pin that never changes →
wrong GPIO, or the ground wire is missing.

Once this passes, flash
[nigehban_band_esp32.ino](nigehban_band_esp32/nigehban_band_esp32.ino) and the
band appears over BLE as `Nigehban-01`.

## A.7 Code — shared pin header

Put this at the top of the BLE sketch, replacing its `#define` block, so both
boards share the rest of the source unchanged.

```cpp
// ---- nigehban_pins.h -------------------------------------------------------
#if defined(ARDUINO_ARCH_ESP32)                 // Part A: bench rig
  #define PIN_BTN_A       4
  #define PIN_BTN_B      27
  #define PIN_LED         2                     // on-board, active HIGH
  #define PIN_MOTOR      18
  #define LED_ACTIVE_HIGH 1
  #define HAS_IMU         0
  #define SIM_BATTERY     1

#elif defined(ARDUINO_ARCH_NRF52)               // Part B: the real band
  #define PIN_BTN_A      D2                     // P0.28
  #define PIN_BTN_B      (-1)                   // single-button product
  #define PIN_LED        LED_RED                // on-board RGB, active LOW
  #define PIN_MOTOR      D1                     // P0.03 -> transistor base/gate
  #define LED_ACTIVE_HIGH 0
  #define HAS_IMU         1
  #define SIM_BATTERY     0
#endif
```

The XIAO's on-board RGB LED is **active LOW** (writing `LOW` lights it). Route
every LED write through one helper so there is never a second code path:

```cpp
inline void ledWrite(bool on) {
  digitalWrite(PIN_LED, LED_ACTIVE_HIGH ? on : !on);
}
```

## A.8 Adding the motor to the ESP32 later

When the transistor and coin motor arrive, the ESP32 rig takes the **exact**
circuit from §B.5 with two substitutions:

- `D1` → `GPIO 18`
- `3V3` → the dev board's `3V3` pin (its AMS1117 sources ~800 mA, so the rail sag
  that plagues the XIAO is far milder here — fit the 100 µF anyway, because you
  are rehearsing the *band's* behaviour, not the dev board's)

No firmware change. Remove the stand-in LED and its resistor first, or the
transistor drives both.

---
---

# Part B — XIAO nRF52840 Sense (the real band)

Four parts collapse into one 21 × 17.5 mm board: the BLE 5.0 radio, the
Cortex-M4 running the gesture logic, the LSM6DS3TR-C IMU for falls and taps, and
the BQ25101 LiPo charger. Everything you solder is the *other* five components.

## B.1 Bill of materials

| # | Part | Qty | Spec that matters |
|---|---|---|---|
| 1 | Seeed **XIAO nRF52840 Sense** | 1 | Must be the **Sense** — the plain XIAO has no IMU. |
| 2 | LiPo cell, 100–150 mAh, **with protection PCB** | 1 | 302025 or 401220. Sized for a wrist, not for runtime. |
| 3 | Tactile switch, 6 × 6 mm | 1 | Through-hole; 4.3 mm or 5 mm stem so it clears the case. |
| 4 | Coin vibration motor, 8–10 mm, 3 V | 1 | ERM. ~80–100 mA running, higher at start. |
| 5 | **AO3400** (logic-level N-MOSFET) *or* S8050 / 2N2222 (NPN) | 1 | See §B.5 — the choice changes the resistor values. |
| 6 | 1 kΩ resistor *(NPN)* or 100 Ω + 100 kΩ *(MOSFET)* | 1–2 | Base current limit / gate drive + pulldown. |
| 7 | 1N4148 diode | 1 | Flyback. Non-optional. |
| 8 | 100 µF electrolytic **+** 100 nF ceramic | 1 each | Bulk + high-frequency decoupling at the motor. |
| 9 | SPDT slide switch | 1 | In the battery positive line. |
| 10 | JST-PH 2-pin connector (optional) | 1 | Lets you unplug the cell without desoldering. |

Wire: 30 AWG silicone-insulated stranded. Solid-core wire snaps at the solder
joint the first time the band is worn.

## B.2 Complete pin map

### Exposed pads — what you solder to

The XIAO has 7 pads per side plus **B+ / B−** on the underside.

```
                  ┌───────────────────────────┐
    D0 / A0  P0.02│●                         ●│ 5V     ← USB only, unused
    D1 / A1  P0.03│●    XIAO nRF52840        ●│ GND    ← ground for everything
    D2 / A2  P0.28│●         Sense           ●│ 3V3    ← regulated rail out
    D3 / A3  P0.29│●                         ●│ D10  P1.15
    D4 SDA   P0.04│●   [antenna at this end] ●│ D9   P1.14
    D5 SCL   P0.05│●                         ●│ D8   P1.13
    D6 TX    P1.11│●                         ●│ D7   P1.12
                  └───────────────────────────┘
                     underside:  B+   B−
```

| Pad | Port | Nigehban use | Direction | Wired to |
|---|---|---|---|---|
| **D1** | P0.03 | `PIN_MOTOR` | OUTPUT | 1 kΩ → NPN base, or 100 Ω → MOSFET gate |
| **D2** | P0.28 | `PIN_BTN_A` | INPUT_PULLUP | tactile switch → GND |
| **D0** | P0.02 | spare / ADC | — | — |
| **D3** | P0.29 | spare (v2: second button) | — | — |
| **D4 / D5** | P0.04 / P0.05 | exposed I²C — **leave free** | — | keep for an external sensor |
| **D6 / D7** | P1.11 / P1.12 | UART — leave free for debug | — | — |
| **D8 / D9 / D10** | P1.13–15 | SPI — unused | — | — |
| **3V3** | — | motor supply + cap positive | power out | motor (+), 100 µF (+), 100 nF |
| **GND** | — | the single ground node | power | switch body, transistor emitter/source, caps (−), button |
| **5V** | — | **do not use** | — | USB rail; nothing here is 5 V-rated |
| **B+ / B−** | — | LiPo, through the slide switch | power | see §B.6 |

### On-board nets — already wired, you only address them in code

| Net | Port | What it does |
|---|---|---|
| `LED_RED` | P0.26 | RGB red. **Active LOW.** |
| `LED_GREEN` | P0.30 | RGB green. Active LOW. |
| `LED_BLUE` | P0.06 | RGB blue. Active LOW. |
| IMU power gate | P1.08 | Drive **HIGH** to power the LSM6DS3TR-C. `imu.begin()` fails without it. |
| IMU INT1 | P0.11 | Interrupt line — lets the IMU wake the MCU instead of being polled. |
| `PIN_VBAT` | P0.31 | Battery voltage, through a divider. |
| `PIN_VBAT_ENABLE` | P0.14 | Drive **LOW** to connect that divider. Leave HIGH otherwise — it wastes current. |
| Charge current | P0.13 | LOW = 100 mA fast charge. Leave alone = ~50 mA. **See §B.6.** |
| Charge status | P0.17 | Reads LOW while the charger is charging. |

The IMU sits on the board's own I²C bus at address **0x6A**; you route nothing
for it.

## B.3 Net list — what connects to what

Every wire in the band. Ten joints.

| # | From | To | Wire |
|---|---|---|---|
| 1 | LiPo **red (+)** | slide switch, **centre** pin | 30 AWG red |
| 2 | slide switch, **one end** pin | XIAO **B+** pad | 30 AWG red |
| 3 | LiPo **black (−)** | XIAO **B−** pad | 30 AWG black |
| 4 | XIAO **D2** | tactile switch, leg 1 | 30 AWG |
| 5 | tactile switch, leg 3 *(diagonal)* | XIAO **GND** | 30 AWG black |
| 6 | XIAO **3V3** | motor **red (+)** | 30 AWG red |
| 7 | motor **blue/black (−)** | transistor **collector** (or MOSFET **drain**) | 30 AWG |
| 8 | XIAO **D1** | 1 kΩ → transistor **base** (or 100 Ω → **gate**) | 30 AWG |
| 9 | transistor **emitter** (or **source**) | XIAO **GND** | 30 AWG black |
| 10 | 1N4148: **anode** → motor (−) node · **cathode (stripe)** → 3V3 | — | across the motor |
| 11 | 100 µF: **+** → 3V3 · **−** → GND | — | as close to the motor as it fits |
| 12 | 100 nF: 3V3 → GND | — | right beside the 100 µF |
| 13 | *(MOSFET only)* 100 kΩ: gate → GND | — | keeps the motor off during reset |

The switch's third pin stays unconnected. GND is one node — all the black wires
meet at the XIAO's GND pad; do not daisy-chain them through the transistor.

## B.4 Button circuit

```
   XIAO D2 (P0.28, INPUT_PULLUP, internal ~13 kΩ)
        │
        ├──────────────────┐
        │                  │
   ┌────┴────┐          100 nF        (optional — firmware debounces 35 ms)
   │ TACTILE │             │
   │  6×6 mm │             │
   └────┬────┘             │
        │                  │
       GND ────────────────┘
```

- Diagonal legs, for the reason in §A.3.
- Idle = 3.3 V = `HIGH`. Pressed = 0 V = `LOW`.
- 13 kΩ × 100 nF ≈ 1.3 ms — invisible next to the 35 ms software debounce.
- This one button carries the whole product: single press, double press,
  hold 3 s and hold 5 s. Nothing about it may be ambiguous, which is why it is a
  deliberate mechanical click and not a capacitive pad or an IMU gesture.

The gesture map, matching the frozen protocol
([EXECUTION_PLAN.md §5](EXECUTION_PLAN.md)):

| Gesture | Event on the wire | Meaning |
|---|---|---|
| Single press | `checkin_ack` | "I'm fine" — answers a check-in, or stands down a live SOS |
| Double press | `sos` | Full SOS, severity 5 |
| Hold 3 s | `high_alert_on` / `high_alert_off` | Arms High Alert — the interval nag |
| Hold 5 s | `armed` / `disarmed` | Arms the disconnection alarm *(v2 — emitted, ignored server-side)* |

## B.5 Motor driver circuit

**The motor never touches a GPIO pin.** An nRF52840 pad sources about 2 mA in
standard drive and 5 mA in high drive. The coin motor pulls **80–100 mA running
and more at start-up** — 20 to 50 times the limit. Wired directly, best case the
motor barely twitches; worst case the pad is destroyed.

### Option 1 — logic-level MOSFET (recommended)

```
    3V3 ────┬──────────────┬──────────────┬─────────────┐
            │              │              │             │
            │          ┌───┴───┐        ──┴──         ──┴──
            │          │ COIN  │        ▬▬▬▬▬ 100 µF   ──┬── 100 nF
   1N4148   │          │ MOTOR │        ──┬──            │
   cathode ─┤ ▲(stripe)└───┬───┘          │              │
            │ │            │             GND            GND
   anode ───┴─┴────────────┤
                           │  ← motor (−) node
                        ┌──┴──┐ D  (drain)
   D1 ──[100 Ω]─────────┤ G   │     AO3400 / SI2302 / DMG3414
              │         └──┬──┘ S  (source)
           [100 kΩ]        │
              │           GND
             GND
```

- **AO3400, SI2302, DMG3414** — logic-level parts, fully on at 3.3 V gate
  (R<sub>DS(on)</sub> in the tens of milliohms; the motor sees the full 3 V).
- The **100 Ω** limits the current spike into the gate capacitance at the
  switching edge. The **100 kΩ** pulls the gate down while the MCU is in reset,
  so the band does not buzz on every power-up.
- Gate current in steady state is zero, so the pin drive limit is irrelevant.

> **2N7002 is a trap.** It is specified at V<sub>GS</sub> = 10 V; at 3.3 V its
> R<sub>DS(on)</sub> is several ohms, dropping 0.5–0.8 V across the switch. The
> motor gets ~2.5 V and buzzes weakly. If a logic-level MOSFET is not available,
> take the NPN below instead.

### Option 2 — NPN transistor (S8050 / 2N2222)

```
    3V3 ────┬──────────────┬──────────────┬─────────────┐
            │              │              │             │
            │          ┌───┴───┐        ──┴──         ──┴──
   1N4148   │          │ COIN  │        ▬▬▬▬▬ 100 µF   ──┬── 100 nF
   cathode ─┤ ▲(stripe)│ MOTOR │        ──┬──            │
            │ │        └───┬───┘          │              │
   anode ───┴─┴────────────┤             GND            GND
                           │  ← motor (−) node
                        ┌──┴──┐ C  (collector)
   D1 ──[1 kΩ]──────────┤ B   │     S8050 / 2N2222
                        └──┬──┘ E  (emitter)
                           │
                          GND
```

I<sub>B</sub> = (3.3 − 0.7) / 1000 ≈ **2.6 mA**, which is just over the pad's
2 mA standard drive. Two clean fixes, either is fine:

```cpp
// (a) put the pin in high-drive mode — 5 mA, plenty of headroom
nrf_gpio_cfg(digitalPinToPinName(PIN_MOTOR),
             NRF_GPIO_PIN_DIR_OUTPUT, NRF_GPIO_PIN_INPUT_DISCONNECT,
             NRF_GPIO_PIN_NOPULL, NRF_GPIO_PIN_H0H1, NRF_GPIO_PIN_NOSENSE);
```

**(b)** or use **2.2 kΩ** instead of 1 kΩ: I<sub>B</sub> ≈ 1.2 mA, and with
h<sub>FE</sub> ≈ 100 that still saturates 120 mA of collector current — more than
the motor draws.

Check the pinout of your specific transistor against its datasheet. Flat face
towards you, legs down: **S8050 is E-B-C**, **2N2222 (TO-92) is E-B-C**,
**AO3400 (SOT-23) is G-S-D** with the drain being the single wide tab. Getting
this backwards is the single most common bench mistake, and the part usually
survives it — it just does nothing.

### Why each of the three passives exists

| Part | Symptom if you omit it |
|---|---|
| **1N4148 flyback** | The motor coil dumps a reverse spike each time the transistor switches off. It resets the MCU, corrupts the BLE link, or degrades the transistor over days. Cathode (stripe) to 3V3 — reverse-biased in normal operation, doing nothing until the switch opens. |
| **100 µF bulk** | Motor inrush sags the 3.3 V rail and browns out the MCU mid-alert, or drops the BLE link. **If the band disconnects whenever it buzzes, this cap is what is missing.** Watch the polarity: the stripe on an electrolytic marks the **negative** leg. |
| **100 nF ceramic** | The electrolytic is too slow for the fast edges of brush commutation noise. Different frequency band, same job. |

## B.6 Power, battery and the slide switch

```
   LiPo (+) red  ──────►  SPDT slide switch, CENTRE pin
                             │
                          [ end pin ]  ──────►  XIAO  B+  (underside pad)
                          [ end pin ]  ──────►  not connected

   LiPo (−) black ─────────────────────────►  XIAO  B−  (underside pad)
```

- The switch goes in the **positive** line only. Never break the ground.
- **Charging works only when the switch is ON** — B+ is where charge current
  enters. Switch off, plug in USB, and the cell simply does not charge.
- The 3V3 pad is the output of the on-board regulator: USB when it is plugged in,
  battery otherwise. The motor hangs off this rail, at its rated 3 V, rather than
  off raw battery — 4.2 V from a fresh cell would overdrive a 3 V motor.

**Charge current — leave it alone.** P0.13 LOW selects 100 mA. Into a 100 mAh
cell that is 1C: legal, but hot and hard on a small pouch. Default (~50 mA) is
0.5C and fills the cell in about two hours. Do not write P0.13 unless you fit a
larger cell.

```cpp
// Charge status, useful on the Home screen. LOW = charging.
#define PIN_CHG_STATUS  17            // P0.17
pinMode(PIN_CHG_STATUS, INPUT);
bool charging = (digitalRead(PIN_CHG_STATUS) == LOW);
```

**Battery cell checks, before it ever touches the board:**

1. Measure the cell with a multimeter. 3.5–4.2 V is healthy. Below 3.0 V, bin it.
2. Confirm red = positive. **Some cheap cells ship with swapped wires.** Reversed
   polarity on B+/B− destroys the XIAO instantly and can vent the cell.
3. Confirm it has a protection PCB — the small board under the yellow tape at the
   wire exit. Without it, over-discharge ruins the cell and a short is a fire.
4. Never solder to the cell's own tabs. Solder to the wires, away from the pouch,
   and heatshrink each joint separately so they cannot touch.

## B.7 The full schematic

```
                                   ┌──────── USB-C (charge + flash) ───────┐
                                   │                                       │
  ┌────────┐        ┌────────┐     │      XIAO nRF52840 Sense              │
  │  LiPo  │  (+)   │  SPDT  │     │  ┌─────────────────────────────────┐  │
  │ 100 mAh├────────┤ SLIDE  ├─────┼─►│ B+                              │◄─┘
  │  3.7 V │        │ SWITCH │     │  │                                 │
  │        │  (−)   └────────┘     │  │  BQ25101 charger  ── P0.17 ──┐  │
  │        ├───────────────────────┼─►│ B−                  status   │  │
  └────────┘                       │  │                              │  │
                                   │  │  LSM6DS3TR-C IMU  (0x6A)     │  │
   ┌───────────────────────────────┼──┤  power P1.08 · INT1 P0.11    │  │
   │                               │  │                              │  │
   │  ┌────────────────────────────┼──┤  RGB LED  P0.26/30/06  (LOW=on) │
   │  │                            │  │                                 │
   │  │   D2 ◄── [TACTILE SW] ── GND  │                                 │
   │  │                            │  │  VBAT: P0.14 enable, P0.31 read │
   │  │   D1 ──►[R]── transistor      │                                 │
   │  │                            │  └───┬─────────────────────┬───────┘
   │  │                           3V3 ────┘                    GND
   │  │                            │                             │
   │  │        ┌───────────────────┼──────────────┬──────────────┤
   │  │        │                   │              │              │
   │  │    [1N4148]            ┌───┴───┐      [100 µF]       [100 nF]
   │  │   cathode▲to 3V3       │ COIN  │          │              │
   │  │        │               │ MOTOR │          │              │
   │  │        └───────┬───────┴───┬───┘          │              │
   │  │                └───────────┤              │              │
   │  │           motor(−) node    │              │              │
   │  │                         ┌──┴──┐           │              │
   │  └── D1 ──[1k / 100R]──────┤ Q1  │           │              │
   │                            └──┬──┘           │              │
   └───────────────────────────────┴──────────────┴──────────────┘  GND
```

## B.8 Physical layout

Four rules, learned the hard way:

1. **Nothing goes over the antenna.** The ceramic antenna is at the USB end of
   the board. Do not route the battery, the motor, or any wire across it or
   directly under it — metal there halves the BLE range.
2. **Motor on the far side from the antenna**, and glued to the case wall, not
   floating. A coin ERM that is not mechanically coupled to the case buzzes
   audibly instead of tactilely, and the wearer cannot feel it under a sleeve.
3. **Button on the case edge**, angled so it cannot be pressed by the wrist
   flexing. A false SOS costs more trust than a missed one.
4. **Slide switch reachable from outside** the glued case — you will want to hard
   power-cycle the band many times before the demo, and unglueing it is not fun.

```
   ┌────────────────────────────────────────────┐
   │  [ USB ]                                   │  ← charge port, case edge
   │   ▓▓▓  antenna — keep clear                │
   │                                            │
   │   ┌──────────────┐        ┌─────────┐      │
   │   │ XIAO nRF52840│        │  LiPo   │      │
   │   │    Sense     │        │ 100 mAh │      │
   │   └──────────────┘        └─────────┘      │
   │                                            │
   │   (Q1)(R)(D)   [100µF]      ◉ MOTOR        │  ← motor against the wall
   │                                            │
   └──[BTN]──────────────────────────[SLIDE]────┘
       ↑ side of the case              ↑ reachable
```

## B.9 Solder order — do it in this sequence

Order matters: it keeps every step testable, and it keeps the battery out of the
build until nothing can short.

1. **Flash the board over USB first, unmodified.** Run the blink test in §B.12.
   If the board is dead on arrival you want to know that before it has wires on
   it.
2. **Button** → D2 and GND. Flash `02_button`. Verify.
3. **Motor driver, without the motor.** Solder the transistor, resistor(s), the
   diode and the caps. Put a multimeter or an LED + 220 Ω where the motor will
   go, run `03_motor`, and confirm the drive line switches.
4. **Motor.** Solder it in, re-run `03_motor`. It should buzz cleanly and the USB
   link must not drop.
5. **IMU test** — no wiring, just `04_imu`, to prove the power gate line.
6. **Slide switch to the battery wires**, insulated, cell still not connected to
   the board.
7. **Measure everything in §B.10.**
8. **Battery to B+/B− last.** Switch OFF while soldering. Then switch on and run
   `05_battery`.
9. Full firmware, then glue.

## B.10 Measure before you power on

With the battery **disconnected** and USB **unplugged**, multimeter in continuity
mode:

| Check | Probe | Must read |
|---|---|---|
| No short on the rail | 3V3 ↔ GND | **Open** (or a brief beep that stops as the 100 µF charges). A steady beep = a solder bridge. Find it now. |
| Motor line is switched | 3V3 ↔ motor (−) node | The motor's own winding, a few ohms. Not zero. |
| Transistor is not on | motor (−) node ↔ GND | **Open**. A short means the transistor is in backwards or a bridge is under it. |
| Button idle | D2 ↔ GND | Open when released, short when pressed. If it is shorted while released, the legs are on the same side. |
| Diode orientation | across the motor, diode mode | Conducts one way only, ~0.6 V. Its **stripe must face 3V3**. |
| Cap polarity | look, do not measure | The electrolytic's stripe is the **negative** leg and goes to GND. Backwards, it fails — sometimes loudly. |

Then, with the slide switch **off**, connect the battery and measure at the
switch: the LiPo voltage on the centre pin, **0 V** on the pin going to B+. Only
then switch on.

## B.11 Code — pins header

`nigehban_band_nrf52/nigehban_pins.h`

```cpp
#pragma once

// ---- what you soldered -----------------------------------------------------
#define PIN_BTN          D2      // P0.28  tactile switch -> GND, INPUT_PULLUP
#define PIN_MOTOR        D1      // P0.03  -> 1k -> NPN base (never direct)

// ---- already on the board --------------------------------------------------
#define PIN_LED_R        LED_RED    // P0.26  active LOW
#define PIN_LED_G        LED_GREEN  // P0.30  active LOW
#define PIN_LED_B        LED_BLUE   // P0.06  active LOW
#define PIN_CHG_STATUS   17         // P0.17  LOW while charging
#define PIN_HICHG        13         // P0.13  LOW = 100 mA charge. Leave alone.
// PIN_VBAT (P0.31) and PIN_VBAT_ENABLE (P0.14) come from the Seeed variant.
#ifndef PIN_VBAT
  #define PIN_VBAT         32     // P0.31
  #define PIN_VBAT_ENABLE  14     // P0.14, drive LOW to connect the divider
#endif
#ifndef PIN_LSM6DS3TR_C_POWER
  #define PIN_LSM6DS3TR_C_POWER  40   // P1.08, drive HIGH to power the IMU
  #define PIN_LSM6DS3TR_C_INT1   11   // P0.11
#endif

#define IMU_I2C_ADDR     0x6A

// The on-board LED is active LOW. Everything else in the firmware is active
// HIGH, so invert here, once.
inline void ledWrite(bool on) { digitalWrite(PIN_LED_R, on ? LOW : HIGH); }
inline void motorWrite(bool on) { digitalWrite(PIN_MOTOR, on ? HIGH : LOW); }
```

**Board setup in the Arduino IDE.** Boards Manager URL:
`https://files.seeedstudio.com/arduino/package_seeeduino_boards_index.json`,
then install **Seeed nRF52 Boards** and select *Seeed XIAO nRF52840 Sense*.
Take the **Bluefruit** variant, not the mbed one —
[EXECUTION_PLAN.md §8](EXECUTION_PLAN.md) explains why: Bluefruit ships `BLEUart`
(the Nordic UART Service the app already speaks) and
`addManufacturerData()`, which v2's beacon needs. Also install the
**Seeed Arduino LSM6DS3** library.

If uploads fail: double-tap RESET to force the bootloader — the RGB LED breathes
and a `XIAO-SENSE` drive appears.

## B.12 Code — bring-up tests, one subsystem at a time

Each of these is deliberately tiny. Run them in order; every one of them proves
exactly one thing, so a failure has exactly one cause.

### `01_blink` — board and toolchain

```cpp
void setup() {
  pinMode(LED_RED, OUTPUT); pinMode(LED_GREEN, OUTPUT); pinMode(LED_BLUE, OUTPUT);
  digitalWrite(LED_RED, HIGH);            // HIGH = OFF on this board
  digitalWrite(LED_GREEN, HIGH);
  digitalWrite(LED_BLUE, HIGH);
  Serial.begin(115200);
}
void loop() {                              // cycles R -> G -> B once a second
  const int leds[3] = { LED_RED, LED_GREEN, LED_BLUE };
  for (int i = 0; i < 3; i++) {
    digitalWrite(leds[i], LOW);  delay(300);
    digitalWrite(leds[i], HIGH); delay(300);
  }
  Serial.println("alive");
}
```

Red-green-blue in a loop = board good, core good, upload path good.

### `02_button` — the joint you just soldered

```cpp
#include "nigehban_pins.h"

void setup() {
  Serial.begin(115200);
  pinMode(PIN_BTN, INPUT_PULLUP);
  pinMode(PIN_LED_R, OUTPUT); ledWrite(false);
}
void loop() {
  bool pressed = (digitalRead(PIN_BTN) == LOW);
  ledWrite(pressed);                       // LED mirrors the button
  static bool last = false;
  static uint32_t t0 = 0;
  if (pressed != last) {
    last = pressed;
    if (pressed) { t0 = millis(); Serial.println("press"); }
    else Serial.printf("release after %lu ms\n", millis() - t0);
    delay(30);
  }
}
```

The LED must follow the button exactly, with no flicker. Flicker on a *release*
means a cold joint — reflow it before going further.

### `03_motor` — driver, flyback and cap

```cpp
#include "nigehban_pins.h"

void setup() {
  Serial.begin(115200);
  pinMode(PIN_MOTOR, OUTPUT); motorWrite(false);
  delay(2000);                              // time to see the serial monitor
}
void loop() {
  Serial.println("buzz 200 ms");
  motorWrite(true);  delay(200);
  motorWrite(false); delay(1500);

  Serial.println("SOS pattern");            // the one the wearer must recognise
  for (int i = 0; i < 4; i++) { motorWrite(true); delay(120);
                                motorWrite(false); delay(80); }
  delay(3000);
}
```

Three things to confirm, in order:

1. It buzzes, and it stops. A motor that never stops = transistor shorted or in
   backwards.
2. The USB serial link **does not** drop when it buzzes. If it does, the 100 µF
   is missing, too small, or too far from the motor.
3. Nothing gets warm. A warm transistor at 100 mA means it is not saturating —
   the base resistor is too large, or you are using a 2N7002 at 3.3 V (§B.5).

### `04_imu` — the power gate that catches everyone

```cpp
#include "LSM6DS3.h"
#include "Wire.h"
#include "nigehban_pins.h"

LSM6DS3 imu(I2C_MODE, IMU_I2C_ADDR);

void setup() {
  Serial.begin(115200);
  while (!Serial && millis() < 3000) {}

  pinMode(PIN_LSM6DS3TR_C_POWER, OUTPUT);   // ← without this, begin() fails
  digitalWrite(PIN_LSM6DS3TR_C_POWER, HIGH);
  delay(20);

  if (imu.begin() != 0) Serial.println("IMU FAILED — check the power gate line");
  else                  Serial.println("IMU ok");
}

void loop() {
  float x = imu.readFloatAccelX(), y = imu.readFloatAccelY(), z = imu.readFloatAccelZ();
  Serial.printf("%.2f,%.2f,%.2f  |a|=%.2f g\n", x, y, z, sqrtf(x*x + y*y + z*z));
  delay(100);
}
```

Flat on the desk: |a| ≈ 1.00 g, with one axis near ±1 and the others near 0.
Drop it 20 cm onto a cushion and you will see |a| dip below 0.4 g then spike past
2.5 g — those are the two thresholds the fall detector uses.

**Log this as CSV from now on.** You cannot collect fall data retroactively, and
untuned thresholds are the fastest way to lose a judge's trust — a bag sliding
off a chair must not page a mother at 2 a.m.

### `05_battery` — the divider, and calibrating it

```cpp
#include "nigehban_pins.h"

// Divider ratio on the XIAO nRF52840 is nominally 1 MΩ / 510 kΩ ≈ 2.96.
// Calibrate: measure B+ with a multimeter, then adjust until they agree.
#define VBAT_SCALE   2.96f
#define ADC_FULL_MV  3000.0f          // AR_INTERNAL_3_0 reference
#define ADC_COUNTS   4096.0f          // 12-bit

uint16_t batteryMillivolts() {
  digitalWrite(PIN_VBAT_ENABLE, LOW);         // connect the divider
  delay(10);
  uint32_t raw = 0;
  for (int i = 0; i < 16; i++) raw += analogRead(PIN_VBAT);   // average the noise
  digitalWrite(PIN_VBAT_ENABLE, HIGH);        // disconnect — it leaks otherwise
  return (uint16_t)((raw / 16.0f) * (ADC_FULL_MV / ADC_COUNTS) * VBAT_SCALE);
}

// A LiPo's voltage curve is not linear, but this is honest enough for a UI.
uint8_t batteryPercent(uint16_t mv) {
  if (mv >= 4150) return 100;
  if (mv <= 3300) return 0;
  return (uint8_t)((mv - 3300) * 100 / (4150 - 3300));
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_VBAT_ENABLE, OUTPUT); digitalWrite(PIN_VBAT_ENABLE, HIGH);
  pinMode(PIN_CHG_STATUS, INPUT);
  analogReference(AR_INTERNAL_3_0);
  analogReadResolution(12);
}

void loop() {
  uint16_t mv = batteryMillivolts();
  Serial.printf("%u mV  %u%%  %s\n", mv, batteryPercent(mv),
                digitalRead(PIN_CHG_STATUS) == LOW ? "charging" : "on battery");
  delay(2000);
}
```

**Calibrate once:** unplug USB, run on battery, measure B+ with a multimeter and
compare. If the print says 3800 and the meter says 3900, multiply `VBAT_SCALE` by
3900/3800. A battery reading that lies is worse than no battery reading — the
family's screen shows this number, and they will act on it.

## B.13 Code — the band firmware

`nigehban_band_nrf52/nigehban_band_nrf52.ino`

The gesture engine and the feedback player are **copied verbatim** from
[nigehban_band_esp32.ino](nigehban_band_esp32/nigehban_band_esp32.ino) — that is
what a frozen protocol buys you. Only the radio, the IMU and the battery are new.

```cpp
/* NIGEHBAN BAND — XIAO nRF52840 Sense
   Board: Seeed nRF52 Boards (Bluefruit core), *not* the mbed variant.
   Same NUS protocol, same JSON, same gestures as the ESP32 stand-in.       */

#include <bluefruit.h>
#include "LSM6DS3.h"
#include "Wire.h"
#include "nigehban_pins.h"

#define DEVICE_NAME   "Nigehban-01"
#define HEARTBEAT_MS  10000
#define DEBOUNCE_MS   35
#define CLICK_GAP_MS  420
#define HOLD_1_MS     3000
#define HOLD_2_MS     5000

BLEUart bleuart;                       // this IS the Nordic UART Service
LSM6DS3 imu(I2C_MODE, IMU_I2C_ADDR);

uint8_t  gBattery = 100;
bool     gHighAlert = false, gArmed = false;
uint32_t gSeq = 0, gLastHeartbeat = 0;

// ---------------------------------------------------------------- OUTPUT ---
void send(const String &json) {
  Serial.println(json);
  if (Bluefruit.connected()) {
    String l = json + "\n";
    bleuart.write(l.c_str(), l.length());
  }
}

void sendEvent(const char *type, const String &extra = "") {
  String j = "{\"t\":\"evt\",\"e\":\"";
  j += type;
  j += "\",\"seq\":" + String(++gSeq);
  j += ",\"ms\":" + String(millis());
  j += ",\"bat\":" + String(gBattery);
  j += ",\"armed\":" + String(gArmed ? 1 : 0);
  if (extra.length()) j += "," + extra;
  j += "}";
  send(j);
}

// ------------------------------------------------------- FEEDBACK ENGINE ---
// Non-blocking. delay() in loop() would stall the radio and drop button edges.
struct Pattern {
  uint8_t pulsesLeft = 0; uint16_t onMs = 0, offMs = 0;
  bool high = false; uint32_t nextChange = 0;
} gPat;

void feedback(uint8_t pulses, uint16_t onMs, uint16_t offMs) {
  gPat = { pulses, onMs, offMs, false, 0 };
}

void feedbackTick() {
  if (!gPat.pulsesLeft) return;
  uint32_t now = millis();
  if (now < gPat.nextChange) return;
  gPat.high = !gPat.high;
  ledWrite(gPat.high);
  motorWrite(gPat.high);
  if (gPat.high) gPat.nextChange = now + gPat.onMs;
  else { gPat.nextChange = now + gPat.offMs; gPat.pulsesLeft--; }
}

// -------------------------------------------------------- BUTTON ENGINE ---
// Identical to the ESP32 sketch. One button now carries every gesture.
struct Button {
  uint8_t pin; bool stable = true, lastRead = true;
  uint32_t lastChange = 0, pressStart = 0, lastRelease = 0;
  uint8_t clicks = 0; bool holdFired1 = false, holdFired2 = false;
} gBtn{ PIN_BTN };

void onGesture(const char *gesture, uint8_t n);

void buttonTick(Button &b) {
  uint32_t now = millis();
  bool raw = digitalRead(b.pin);                    // LOW = pressed
  if (raw != b.lastRead) { b.lastRead = raw; b.lastChange = now; }

  if ((now - b.lastChange) > DEBOUNCE_MS && raw != b.stable) {
    b.stable = raw;
    if (b.stable == LOW) { b.pressStart = now; b.holdFired1 = b.holdFired2 = false; }
    else if (!b.holdFired1 && !b.holdFired2 &&
             (now - b.pressStart) < HOLD_1_MS) { b.clicks++; b.lastRelease = now; }
  }

  if (b.stable == LOW) {                            // holds fire while held
    uint32_t held = now - b.pressStart;
    if (!b.holdFired1 && held >= HOLD_1_MS) {
      b.holdFired1 = true; feedback(1, 250, 120); onGesture("hold3", 0);
    }
    if (!b.holdFired2 && held >= HOLD_2_MS) {
      b.holdFired2 = true; feedback(2, 250, 120); onGesture("hold5", 0);
    }
  }

  if (b.clicks && b.stable == HIGH && (now - b.lastRelease) > CLICK_GAP_MS) {
    uint8_t n = b.clicks; b.clicks = 0; onGesture("click", n);
  }
}

// ---------------------------------------------------------- GESTURE MAP ---
// The only place hardware meets meaning. Matches EXECUTION_PLAN.md §5 exactly.
void onGesture(const char *gesture, uint8_t n) {
  String meta = "\"g\":\"" + String(gesture) + "\",\"n\":" + String(n);

  if (strcmp(gesture, "click") == 0) {
    if (n == 1) {                                   // "I'm fine" / stand down
      feedback(1, 90, 90);
      sendEvent("checkin_ack", meta);
    } else if (n >= 2) {                            // double tap = SOS
      feedback(4, 120, 80);
      sendEvent("sos", meta + ",\"src\":\"double_tap\"");
    }
    return;
  }
  if (strcmp(gesture, "hold3") == 0) {              // High Alert on/off
    gHighAlert = !gHighAlert;
    feedback(gHighAlert ? 2 : 1, 200, 150);
    sendEvent(gHighAlert ? "high_alert_on" : "high_alert_off", meta);
    return;
  }
  if (strcmp(gesture, "hold5") == 0) {              // v2: disconnection alarm
    gArmed = !gArmed;
    feedback(gArmed ? 3 : 1, 180, 120);
    sendEvent(gArmed ? "armed" : "disarmed", meta);
  }
}

// ------------------------------------------------------------ COMMANDS ---
// jsonStr() / jsonInt() / handleCommand() — copy verbatim from the ESP32 sketch.

void rxTick() {
  static String line;
  while (bleuart.available()) {
    char c = (char)bleuart.read();
    if (c == '\n') { line.trim(); if (line.length()) handleCommand(line); line = ""; }
    else if (line.length() < 200) line += c;
  }
}

// ----------------------------------------------------------------- IMU ---
// Classic 3-phase fall: free-fall -> impact -> stillness. Calibrate in Phase 5.
uint8_t  gFallStage = 0;
uint32_t gFallStamp = 0;

void imuTick() {
  static uint32_t last = 0;
  uint32_t now = millis();
  if (now - last < 20) return;                      // 50 Hz is plenty
  last = now;

  float x = imu.readFloatAccelX(), y = imu.readFloatAccelY(), z = imu.readFloatAccelZ();
  float g = sqrtf(x*x + y*y + z*z);

  switch (gFallStage) {
    case 0: if (g < 0.40f) { gFallStage = 1; gFallStamp = now; } break;
    case 1: if (g > 2.50f) { gFallStage = 2; gFallStamp = now; }
            else if (now - gFallStamp > 800) gFallStage = 0;      break;
    case 2: if (now - gFallStamp > 1500) {          // still upset? call it a fall
              gFallStage = 0;
              feedback(5, 200, 150);
              sendEvent("fall", "\"peak_g\":" + String(g, 2));
            }                                                     break;
  }
}

// --------------------------------------------------------------- SETUP ---
void setup() {
  Serial.begin(115200);

  pinMode(PIN_BTN, INPUT_PULLUP);
  pinMode(PIN_MOTOR, OUTPUT);  motorWrite(false);
  pinMode(PIN_LED_R, OUTPUT);  ledWrite(false);
  pinMode(PIN_CHG_STATUS, INPUT);
  pinMode(PIN_VBAT_ENABLE, OUTPUT); digitalWrite(PIN_VBAT_ENABLE, HIGH);
  analogReference(AR_INTERNAL_3_0);
  analogReadResolution(12);

  pinMode(PIN_LSM6DS3TR_C_POWER, OUTPUT);           // power the IMU before begin()
  digitalWrite(PIN_LSM6DS3TR_C_POWER, HIGH);
  delay(20);
  if (imu.begin() != 0) Serial.println("{\"t\":\"log\",\"msg\":\"IMU init failed\"}");

  Bluefruit.begin();
  Bluefruit.setName(DEVICE_NAME);
  Bluefruit.setTxPower(4);
  bleuart.begin();

  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addService(bleuart);
  Bluefruit.Advertising.addName();
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(32, 244);       // 20 ms fast, 152 ms slow
  Bluefruit.Advertising.setFastTimeout(30);
  Bluefruit.Advertising.start(0);

  feedback(2, 120, 100);
  Serial.println("{\"t\":\"log\",\"msg\":\"Nigehban band up, advertising\"}");
}

// ---------------------------------------------------------------- LOOP ---
void loop() {
  uint32_t now = millis();

  buttonTick(gBtn);
  feedbackTick();
  imuTick();
  rxTick();

  static bool wasConnected = false;
  bool connected = Bluefruit.connected();
  if (connected != wasConnected) {
    wasConnected = connected;
    if (connected) { feedback(1, 200, 100); sendEvent("link_up"); }
    else             feedback(2, 80, 80);   // Bluefruit re-advertises on its own
  }

  if (now - gLastHeartbeat > HEARTBEAT_MS) {
    gLastHeartbeat = now;
    gBattery = batteryPercent(batteryMillivolts());   // from 05_battery
    sendEvent("hb", "\"up\":" + String(now / 1000) +
                    ",\"chg\":" + String(digitalRead(PIN_CHG_STATUS) == LOW ? 1 : 0));
  }
}
```

> **One divergence to fix while you are here.** The committed ESP32 sketch maps
> **triple**-tap to `sos` and `hold3` to `interval_cycle`. The frozen protocol
> ([EXECUTION_PLAN.md §5](EXECUTION_PLAN.md)) says **double**-tap → `sos` and
> hold 3 s → `high_alert_on` / `high_alert_off`, which is what the firmware above
> implements. Make the ESP32 sketch match, or the two bands behave differently in
> front of the judges — it is a three-line edit in its `onGesture()`.

## B.14 Power budget

| State | Current | Notes |
|---|---|---|
| Advertising, not connected | ~200 µA avg | 100 ms interval. |
| Connected, idle | ~300–400 µA avg | Long connection interval when nothing is happening. |
| IMU at 26 Hz | ~150 µA | Bump to 104 Hz for 3 s after motion, then drop back. |
| Motor buzzing | ~100 mA | Duty cycle is tiny — a 4-pulse SOS is under a second. |
| LED on | ~5 mA | **Off in normal operation.** It is a debug tool, not a feature. |

At ~300 µA average, a 120 mAh cell gives roughly **two weeks**. What actually
kills it is a `delay()` in `loop()` blocking sleep, or an LED left on.

Rules that keep it there:

- Never `delay()` in `loop()` — everything is a non-blocking state machine.
- Advertise at 100 ms; widen the connection interval once idle.
- IMU at 26 Hz when still, 104 Hz for 3 s after motion.
- LED off unless you are debugging.
- `PIN_VBAT_ENABLE` back HIGH immediately after each reading — the divider leaks
  continuously while it is connected.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Band disconnects whenever it buzzes | Motor inrush sags the rail | 100 µF bulk cap, **as close to the motor as it fits** (§B.5) |
| Motor never stops | Transistor in backwards, or a solder bridge | Check the pinout; check §B.10's "transistor is not on" test |
| Motor buzzes weakly | 2N7002 at 3.3 V, or the base resistor is too big | Logic-level MOSFET, or drop to 1 kΩ / enable high drive (§B.5) |
| MCU resets when the motor stops | Missing or backwards flyback diode | Stripe **towards 3V3** |
| Band buzzes on every power-up | MOSFET gate floating during reset | 100 kΩ gate-to-GND pulldown |
| `imu.begin()` returns non-zero | IMU power gate not driven | `digitalWrite(PIN_LSM6DS3TR_C_POWER, HIGH); delay(20);` before `begin()` |
| Button reads pressed constantly | Switch legs on the same side | Use diagonally opposite legs (§A.3) |
| Random button presses | Pin not `INPUT_PULLUP`, or GND missing | Check `pinMode`; check the ground wire |
| Falls fire from a bag on a chair | Untuned thresholds | Log CSV, raise the impact threshold, require the stillness phase |
| Board will not accept an upload | Bootloader not entered | Double-tap RESET; a `XIAO-SENSE` drive appears |
| Battery percentage is wrong | Divider not calibrated | Calibrate `VBAT_SCALE` against a multimeter (§B.12) |
| ESP32 will not boot | Something pulling a strapping pin | Move it off GPIO 0 / 2 / 5 / 12 / 15 (§A.5) |
| Phone cannot find the band | Something else is connected | The band takes **one** BLE connection. Close `nigehban_hub.py`. |

---

## What you still have to buy

Everything in Part A is already on your desk. To build Part B:

| Part | Why it cannot be substituted |
|---|---|
| XIAO nRF52840 **Sense** | The non-Sense version has no IMU — no falls, no tap gestures. |
| LiPo 100–150 mAh with protection | Sized to a wrist. Protection PCB is a safety requirement, not an option. |
| Coin vibration motor 8–10 mm, 3 V | In a snatching, the wearer cannot look at a screen. The buzz is the only confirmation the SOS fired. |
| AO3400 (or S8050) | An nRF pad sources ~2 mA; the motor wants 100 mA. |
| 1N4148 | The only thing absorbing the motor's reverse spike. |
| 100 µF + 100 nF | The difference between a band that buzzes and a band that disconnects when it buzzes. |
| SPDT slide switch | You will power-cycle the band dozens of times before the demo, through a glued case. |
| 1 kΩ (NPN) or 100 Ω + 100 kΩ (MOSFET) | Base current limit / gate drive and pulldown. |

Also worth having: 30 AWG silicone wire, heatshrink, a JST-PH connector so the
cell can be unplugged, and double-sided foam tape for the motor.
