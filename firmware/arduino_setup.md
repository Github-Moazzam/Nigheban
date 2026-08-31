# Arduino setup — XIAO nRF52840 Sense

Everything needed to build and flash the Nigehban band firmware on a fresh
machine. Versions below are the ones actually verified working, not the latest.

Budget **~1 GB of disk** and a slow first download — the ARM toolchain alone is
153 MB compressed.

---

## What gets installed

| Thing | Version | Where it lands (Windows) |
|---|---|---|
| Arduino IDE | 2.x | `%LOCALAPPDATA%\Programs\Arduino IDE\` |
| **Seeed nRF52 Boards** (`Seeeduino:nrf52`) | **1.1.13** | `%LOCALAPPDATA%\Arduino15\packages\Seeeduino\` |
| **Seeed Arduino LSM6DS3** | **2.0.7** | `%USERPROFILE%\Documents\Arduino\libraries\` |

Pulled in automatically by the core — **do not install separately**:

| Bundled library | Used for |
|---|---|
| `Adafruit_TinyUSB_Arduino` | USB CDC — `Serial` |
| `Bluefruit52Lib` | BLE, incl. `BLEUart` (the Nordic UART Service) |

Toolchain dependencies the core drags in: `arm-none-eabi-gcc 9-2019q4`,
`nrfjprog 9.4.0`, `CMSIS 5.7.0`.

---

## Step 1 — Arduino IDE

Download from <https://www.arduino.cc/en/software>. Version 2.x.

## Step 2 — Add the Seeed board index

**File → Preferences → Additional Boards Manager URLs**, add:

```
https://files.seeedstudio.com/arduino/package_seeeduino_boards_index.json
```

## Step 3 — Install the board package

**Tools → Board → Boards Manager**, search `seeed nrf52`.

Two packages appear. Install **"Seeed nRF52 Boards"** — the one *without* mbed
in the name.

> ### Why non-mbed, permanently
>
> Settled in `EXECUTION_PLAN.md:493` and `F1.1`. Bluefruit ships `BLEUart`,
> which **is** the Nordic UART Service the app already speaks, plus
> `addManufacturerData()` for the v2 beacon and the advertising-interval control
> the 1–2 week power budget depends on.
>
> The mbed core's only advantage is a drop-in PDM mic library, and scream
> detection is deferred to v2 (`EXECUTION_PLAN.md:746`) for a power reason, not
> a core reason. **Do not switch cores to get the mic.**

This is the slow step. Let it finish — see *Install collision* below.

## Step 4 — Install the IMU library

**Tools → Manage Libraries**, search `Seeed Arduino LSM6DS3`, install.

Needed by `t4_imu` and by `F3`. Skip it and those fail to compile; nothing else
is affected.

## Step 5 — Select the board

**Tools → Board → Seeed nRF52 Boards → Seeed XIAO nRF52840 Sense**

Must say **Sense**. The plain `XIAO nRF52840` variant does not define the IMU or
mic pins, and `t4_imu` will not build against it.

FQBN, for scripts: `Seeeduino:nrf52:xiaonRF52840Sense`

## Step 6 — Verify

Plug the board in, pick the port, open [t1_blink](t1_blink/), Upload.

Red LED blinking plus `tick` in Serial Monitor at **115200** means the whole
chain works. Anything else, stop here — do not debug wiring against a broken
toolchain.

---

## Every sketch needs this include

```cpp
#include <Adafruit_TinyUSB.h>
```

On this core USB CDC lives in a separate library. Without it, any sketch using
`Serial` fails at **link** time, not compile time:

```
undefined reference to `Adafruit_USBD_CDC::begin(unsigned long)'
undefined reference to `Serial'
```

It ships with the core — nothing to install — but it must be in **every** sketch,
`nigehban_band_nrf52/` included.

---

## Troubleshooting

### No port in Tools → Port

Double-tap the reset button quickly. The red LED fades in and out and a
`XIAO-SENSE` drive mounts — that's the bootloader. The port appears.

Use this whenever a bad sketch locks the board up and normal upload fails.

### Install collision

Running the IDE's Boards Manager and a command-line install at the same time
produces:

```
Failed to install platform: 'Seeed nRF52 Boards:1.1.13'.
removing corrupted archive file: ... The process cannot access the file
because it is being used by another process.
```

Nothing is corrupted — two installers are fighting over `Arduino15\staging`.
Let one finish, then retry the other. It will see the work already done.

### Red squiggles in VSCode

If you edit `.ino` files in VSCode, IntelliSense reports `identifier "pinMode"
is undefined` and similar. That's VSCode lacking Arduino include paths, **not** a
real error. The compiler is the authority — if `arduino-cli compile` or the IDE
passes, the code is fine.

---

## Scripted setup (optional)

Arduino IDE 2.x bundles `arduino-cli`, which shares `Arduino15` with the IDE —
anything installed through it shows up in the IDE and vice versa.

```
%LOCALAPPDATA%\Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe
```

```bash
CLI="/c/Users/$USER/AppData/Local/Programs/Arduino IDE/resources/app/lib/backend/resources/arduino-cli.exe"
URL="https://files.seeedstudio.com/arduino/package_seeeduino_boards_index.json"

"$CLI" core update-index --additional-urls "$URL"
"$CLI" core install Seeeduino:nrf52 --additional-urls "$URL"
"$CLI" lib install "Seeed Arduino LSM6DS3"

# compile-check everything
for s in t1_blink t2_motor t3_button_motor t4_imu t5_haptic_patterns; do
  "$CLI" compile -b Seeeduino:nrf52:xiaonRF52840Sense "firmware/$s" \
    && echo "$s PASS" || echo "$s FAIL"
done
```

Close the IDE's Boards Manager before running the install lines.

---

## Verified pin macros

From `packages/Seeeduino/hardware/nrf52/1.1.13/variants/Seeed_XIAO_nRF52840_Sense/variant.h`:

| Purpose | Macro | Value |
|---|---|---|
| Onboard LED (**active LOW**) | `LED_BUILTIN` / `LED_RED` | 11 |
| IMU power gate | `PIN_LSM6DS3TR_C_POWER` | 15 |
| IMU interrupt (F3 wake-on-motion) | `PIN_LSM6DS3TR_C_INT1` | 18 |
| Battery divider enable | `VBAT_ENABLE` | 14 |
| Battery ADC | `PIN_VBAT` | 32 |
| PDM mic | `PIN_PDM_PWR` / `_CLK` / `_DIN` | 19 / 20 / 21 |

> **`EXECUTION_PLAN.md:512` will not compile.** It writes `PIN_VBAT_ENABLE`; the
> real macro is `VBAT_ENABLE`. Fix when doing **F2.3**.

> **`VBAT_ENABLE` must stay LOW — HIGH or high-Z permanently destroys P0.31.**
> P0.14 is the bottom leg of the `BAT+ — 1M — P0.31 — 510k — P0.14` divider;
> LOW is what keeps P0.31 divided. Float it and P0.31 rises toward `BAT+`
> (~4.2 V charging) against a 3.6 V pin maximum. Do **not** gate it between
> readings to save the 2.8 µA. Full note in
> [README.md](README.md#verified-against-the-installed-core).

**I²C:** `Wire` is the external D4/D5 header. The IMU is on the internal bus,
`Wire1` (pins 17/16). The Seeed library remaps this itself, so
`LSM6DS3 imu(I2C_MODE, 0x6A)` is correct with no bus argument.

**IMU power gate:** drive `PIN_LSM6DS3TR_C_POWER` HIGH and wait ~10 ms *before*
`imu.begin()`. The Sense can switch the IMU off entirely for low power; skip this
and `begin()` fails on perfectly good hardware. The skeleton in
`EXECUTION_PLAN.md` section 8 is missing this line.
