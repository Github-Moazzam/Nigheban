# Nigehban — Prototype to Product Build Guide

> ## Historical — superseded
>
> This is the original Day-0 guide, written when the band was an ESP32 on a
> breadboard and the brain was a Python script on a laptop. **That migration is
> finished.** The band is a XIAO nRF52840 Sense, the brain is
> `server/nigehban_server.py`, and the ESP32 was retired on 27 Aug 2026 — its
> sketch is gone from the tree and `firmware/nigehban_band_esp32.ino` referenced
> below no longer exists.
>
> **Current plans:** [EXECUTION_PLAN.md](EXECUTION_PLAN.md) ·
> [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) ·
> [firmware/README.md](../firmware/README.md) for the bench work.
>
> **Still current in here, and not ESP32-specific:** §8 Alibaba Cloud wiring ·
> §9 BOM and enclosure build order · §10's judge Q&A prep. Kept for those.
>
> Everything else is a record of how the project started, not instructions to
> follow. Do not flash anything on the strength of this file.

**From an ESP32 and two buttons on your desk today, to a wristband + Android app + Alibaba Cloud backend.**

---

## 0. The decision you asked about

> *"Should I make a mobile app or just code on the laptop?"*

**Laptop today. Android on Day 3.** Not because the app is hard, but because of the debug loop:

| | Laptop hub (Python) | Android app |
|---|---|---|
| Change a rule and see the result | ~2 seconds | 40–90 seconds per build/install |
| See why BLE dropped | full log in terminal | logcat filtering, on a device you're holding |
| Test "band is snatched" | type `h5` then `drop` | `h5`, then actually walk away from your desk |
| Test 5 failure paths in a row | 30 seconds | 10 minutes |

You have **5 days**. Burning day 1 fighting Gradle and Android BLE permissions is how hackathon teams end up with hardware that blinks and no logic. The laptop hub lets you get **all the decision logic correct and demo-able by tonight**, and then the Android app becomes a porting job against a spec that already works, not a design job.

**The one rule that makes this safe: freeze the BLE protocol now (Section 3).** The band speaks newline-delimited JSON over Nordic UART Service. The laptop speaks it today; the phone speaks it on Day 3; the XIAO nRF52840 speaks it on Day 4. Three hardware swaps, zero protocol changes. That is the whole migration strategy.

---

## 1. What you're building today (2–3 hours)

```
  ESP32 + 2 buttons                 Laptop (Python hub)
  ┌──────────────────┐   BLE/NUS    ┌──────────────────────────────┐
  │ gesture engine   │ ───JSON────▶ │ check-in dead-man's switch   │
  │  click / x2 / x3 │              │ SOS handler                  │
  │  hold 3s         │ ◀──JSON───── │ snatch detect (+10s debounce)│
  │  buzz + LED      │   commands   │ fall confirm-then-escalate   │
  └──────────────────┘              │ location + Qwen risk brief   │
                                    │ dispatch → Telegram/WhatsApp │
                                    └──────────────────────────────┘
```

The mapping follows `EXECUTION_PLAN.md` §5, and the firmware, the hub and the
app all implement exactly this:

| You press | Event sent | Hub does |
|---|---|---|
| Button A ×1 | `checkin_ack` | Cancels the pending check-in — "I'm fine", nothing goes to family |
| Button A ×2 | `sos` | Immediate SOS with location, `src: double_tap` — the real band's gesture |
| Button A ×3, ×4, ×5 | `sos` | The same. Over-tapping in a panic must never be a no-op |
| Button A hold 3s | `high_alert_on` / `high_alert_off` | Toggles High Alert — tightest check-in interval while on |
| Button B ×1 | `sos` | Prototyping convenience, `src: button_b`; the shipped band has one key |

**Nothing is bound to a 5 s hold.** Anti-snatch is a v2 feature, so the wearer
has two gestures to remember rather than three, and holding past 3 s crosses
nothing further. The hub still accepts `armed` / `disarmed` and the `h5` key
still sends them, so the snatch path stays testable without a gesture behind
it.

---

## 2. Bring-up steps

### 2.1 Parts (what you already have)

| # | Part | Notes |
|---|---|---|
| 1 | ESP32 dev board (WROOM-32 / C3 SuperMini) | Any board with BLE |
| 2 | 2 × tactile push buttons | No resistors needed — internal pull-ups |
| 3 | Breadboard + jumpers | |
| 4 | ~~MPU6050~~ | **Not needed and not supported.** The XIAO Sense carries an LSM6DS3TR-C on board at `0x6A`, which is what `HAS_IMU 1` reads. The external-IMU path was deleted in F2.2 |
| 5 | *(optional)* coin vibration motor + 2N2222 + 1N4148 + 1kΩ | For haptic feedback |

### 2.2 Wiring

```
BUTTON A ── GPIO 4 ──┐            (other leg of each button → GND)
BUTTON B ── GPIO 5 ──┤
LED      ── GPIO 2   │  onboard on most WROOM boards
MOTOR    ── GPIO 18 ─┴─ 1kΩ ─ base(2N2222); emitter→GND;
                        collector→motor→3V3; 1N4148 across motor,
                        stripe (cathode) to 3V3

MPU6050 (optional): VCC→3V3  GND→GND  SDA→GPIO21  SCL→GPIO22
```

**Two things that will waste your afternoon if you skip them:** never drive the vibration motor straight off a GPIO (it pulls ~80–100 mA, the pin sources ~5–12 mA — you will kill the pin), and on the ESP32-C3 SuperMini the pin numbers differ, so check your board's pinout before assuming GPIO 4/5 are exposed.

### 2.3 Flash the band

> **Obsolete — the ESP32 and its sketch are gone.** To flash the real band, use
> [firmware/arduino_setup.md](../firmware/arduino_setup.md) (Seeed nRF52 core) and
> `nigehban_band_nrf52/`. The steps below are the historical ESP32 procedure.

1. Arduino IDE → **File ▸ Preferences ▸ Additional Board URLs**:
   `https://espressif.github.io/arduino-esp32/package_esp32_index.json`
2. **Tools ▸ Board ▸ ESP32 Dev Module** (or ESP32C3 Dev Module)
3. Open the ESP32 sketch, adjust the pin `#define`s, Upload.
4. Open **Serial Monitor at 115200**. Press buttons. You should see JSON lines:
   ```json
   {"t":"evt","e":"checkin_ack","seq":3,"ms":18422,"bat":100,"armed":0,"btn":1,"g":"click","n":1}
   ```
   Serial mirrors everything, so **the firmware is fully testable before BLE is involved.** Get gestures right here first.

If upload fails: hold BOOT while it says "Connecting…", and use a **data** USB cable, not a charge-only one.

### 2.4 Run the hub

```bash
cd hub
pip install -r requirements.txt

python nigehban_hub.py --sim     # no hardware needed — test the logic first
python nigehban_hub.py --list    # confirm the laptop sees "Nigehban-01"
python nigehban_hub.py           # connect for real
```

First run writes `config.json`. Edit it: your name, home lat/lon, contacts, and (optionally) Telegram/WhatsApp/Qwen keys. `checkin_interval_s` is 120 for demos — the real product default is 30–60 minutes.

**Bluetooth notes by OS:** Linux needs BlueZ ≥ 5.55 (`bluetoothctl` should see the device). Windows 10/11 works out of the box, but **unpair the ESP32 in Windows Bluetooth settings** — bleak connects directly and a stale pairing causes silent failures. macOS will prompt for Bluetooth permission for your terminal app; grant it in System Settings ▸ Privacy.

### 2.5 The 6-test acceptance checklist

Run these tonight. If all six pass, your logic layer is done and everything after is packaging.

1. **Check-in answered** — wait for the buzz, press A once → hub logs "acknowledged", *nothing sent*.
2. **Check-in ignored** — wait for the buzz, do nothing for 45 s → dispatch fires, severity 3.
3. **SOS** — press B → immediate severity-5 dispatch with a maps link, band alarms.
4. **Interval change** — hold A 3 s → buzz, hub logs the new interval.
5. **Snatch** — type `h5` to arm (there is no band gesture for it yet), then power off the ESP32 → hub waits the 10 s grace, *then* declares a snatch. Now repeat but power it back on at 5 s → **no alert**. That second half is the important test.
6. **Low battery** — type `bat 15` → severity-1 "he's fine, phone is dying" message.

---

## 3. The protocol (freeze this)

**Transport:** BLE GATT, Nordic UART Service, newline-delimited JSON, UTF-8.

| Role | UUID |
|---|---|
| Service | `6E400001-B5A3-F393-E0A9-E50E24DCCA9E` |
| RX (phone → band, Write) | `6E400002-…` |
| TX (band → phone, Notify) | `6E400003-…` |

### Band → phone events

```json
{"t":"evt","e":"<name>","seq":12,"ms":48210,"bat":87,"armed":1, ...extras}
```

| `e` | Meaning | Phone's job |
|---|---|---|
| `link_up` | Connected | Clear any pending snatch timer |
| `hb` | Heartbeat, every 10 s | Watchdog + battery tracking |
| `checkin_ack` | User pressed "I'm OK" | Cancel escalation, reset timer |
| `checkin_prompted` | Band buzzed the user | Log only |
| `checkin_missed` | Band's local nag expired | Log only — **phone owns escalation** |
| `sos` | Double-tap (or more), or the SOS key | Escalate immediately, severity 5 |
| `fall` | IMU fall pattern | Ask first, escalate on silence |
| `armed` / `disarmed` | Anti-snatch mode toggled | Enable/disable snatch detection — v2; no gesture emits these today |
| `high_alert_on` / `high_alert_off` | Hold-3s | Toggle High Alert; tightens the check-in interval while on |
| `interval_cycle` | *(legacy)* | No longer emitted; handled so an older flashed band still works |

### Phone → band commands

```json
{"t":"cmd","c":"checkin_req","window":45}
```

| `c` | Effect |
|---|---|
| `checkin_req` | Long buzz pattern; band expects an ack within `window` seconds |
| `buzz` | `n` short pulses — generic confirmation |
| `alarm` | Long alarm pattern |
| `ack` | Single pulse: "cloud got your event" |
| `ping` / `bat` | Diagnostics |

**Why `seq` matters:** BLE notifications can be lost. The phone should ignore duplicate `seq` values and can detect gaps. **Why the band never decides anything:** the band nags locally but the *phone* owns escalation, because only the phone knows the location, the contacts and the network state. Keep that split — it is what lets you swap the band hardware without touching the app.

---

## 4. The logic layer, explained

This is the part judges score. Each rule exists because of a specific failure mode.

### 4.1 Check-in dead-man's switch

```
timer expires → send checkin_req → band buzzes → user presses once
                                              ↓ no press within window
                                    escalate("checkin_missed")
```
The user's **normal** action is a single press meaning "I'm fine, don't bother anyone." Silence is the alarm. That inversion is the whole idea: an unconscious or restrained person cannot press a panic button, but they also cannot press an "I'm fine" button.

### 4.2 Snatch detection — the debounce is the feature

The audit's central warning: wiring BLE-loss straight to an alarm will false-fire constantly. Android aggressively manages background BLE, Doze can drop a link on a stationary phone, and a lift or a crowded market kills 2.4 GHz. Raw BLE-loss → alarm will go off **on stage**.

The rule implemented here:

```
IF armed AND link_lost AND still_lost_after(10s)   → snatch
   [on the phone, additionally: AND phone accelerometer spike in that window]
```

The 10-second grace plus a phone-side motion spike is what separates a real grab (phone accelerates away, link never returns) from an OS hiccup (link returns in 3 s, phone was on a table). Say this out loud in the pitch — it demonstrates you understand Android's actual background model rather than having wired a naive alarm.

### 4.3 Fall → ask, then escalate

A fall is *not* automatically an emergency. Free-fall (<0.4 g) → impact (>2.5 g) → stillness triggers a **check-in prompt**, not an alert. Press once and nothing is sent. Silence for 45 s escalates at severity 4. This kills the biggest reason people abandon fall detectors: false alarms that embarrass them in front of family.

### 4.4 Severity ladder

| Sev | Event | Dispatch |
|---|---|---|
| 5 | SOS, confirmed snatch | All contacts, immediately, with photo + location |
| 4 | Unanswered fall | All contacts with location |
| 3 | Missed check-in | Primary contact first, all after a second miss |
| 1 | Low battery | Reassuring "he's fine" note |

### 4.5 Pattern-of-Life (the AI differentiator)

Every event goes to `events.jsonl`. That file *is* the feature. After a day of wear you have hourly movement/check-in patterns; feed a week's summary to Qwen and ask for deviations. For a 5-day build, do the honest version: pre-seed a baseline JSON, then show Qwen flagging today's deviation. It's a real inference over real logged data — just don't claim a trained model.

---

## 5. Getting the alert to the family — read this before you build it

This is where most teams lose an hour on demo day.

**You cannot send a WhatsApp message to a WhatsApp *group* via the WhatsApp Business/Cloud API.** The API messages individual numbers that have opted in. So "send to the family group" must be one of:

| Option | Works today? | Cost | Good for |
|---|---|---|---|
| **Telegram bot → group** | Yes, 10 minutes to set up | Free | **The demo.** Real group delivery, instant, no approval |
| **CallMeBot → WhatsApp** | Yes, per-recipient opt-in | Free | Showing an actual WhatsApp message on screen |
| **Android `SmsManager`** | Yes, on the phone | Carrier SMS rate | **The product.** Works with no internet at all |
| **Twilio WhatsApp sandbox** | Yes, recipients must join sandbox | Trial credit | Backup demo |
| **WhatsApp Cloud API** | Needs Meta business verification | Free tier | Post-hackathon |

**Recommended for the pitch:** fan out to individual numbers over WhatsApp (Cloud API or CallMeBot) **and** fire an SMS via `SmsManager` as the offline fallback. Then say the line judges will remember: *"If there's no data, the SMS still goes. A snatching in Karachi doesn't wait for 4G."*

Both Telegram and CallMeBot are already wired into `Notifier` — just fill in the keys in `config.json`.

**Telegram setup (5 min):** message `@BotFather` → `/newbot` → copy the token → add the bot to your family group → visit `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy the negative `chat.id`.

---

## 6. Location: how it works and what to send

| Layer | Source | Accuracy |
|---|---|---|
| Laptop hub (today) | IP geolocation | 1–5 km — placeholder, clearly labelled |
| Android app | `FusedLocationProviderClient` | 5–20 m outdoors |
| Wearable | **none — by design** | Phone-tethered |

Dropping GPS/GSM from the band is the strongest engineering decision in your spec: 5 parts instead of 8, and 1–2 weeks of battery instead of 1–2 days. Lead the pitch with it.

**Android implementation:**

```kotlin
val fused = LocationServices.getFusedLocationProviderClient(context)

// Keep a warm last-known fix so an SOS never waits for a GPS lock
fun lastKnown(): Location? = fused.lastLocation.result

// On SOS: fire the alert with the last known fix immediately,
// then send a follow-up when a fresh high-accuracy fix arrives.
fused.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, cts.token)
    .addOnSuccessListener { loc -> sendFollowUp(loc) }
```

That two-stage send matters: a cold GPS lock takes 10–30 seconds, and in a snatching you may not have 30 seconds. **Send stale-but-instant first, accurate second.**

What each alert carries: lat/lon, accuracy in metres, a `maps.google.com/?q=lat,lon` link, timestamp, battery %, distance from home, event type, and the front-camera photo URL if one was captured.

---

## 7. The Android app (Day 3–4)

### 7.1 Module layout

```
app/
 ├─ ble/        BandClient.kt        — scan, connect, NUS notify/write, auto-reconnect
 ├─ core/       Guardian.kt          — port of the Python Guardian, 1:1
 │              EventLog.kt          — Room DB, same schema as events.jsonl
 ├─ service/    GuardianService.kt   — foreground service, holds BLE + camera
 ├─ security/   LockAdmin.kt         — DeviceAdminReceiver, lockNow()
 │              SnatchCamera.kt      — CameraX front capture, no preview
 ├─ dispatch/   Dispatcher.kt        — SMS + WhatsApp + cloud
 ├─ cloud/      MqttClient.kt        — Alibaba IoT Platform
 │              QwenClient.kt        — Model Studio risk brief
 └─ ui/         Setup, contacts, arm/disarm, event history
```

`Guardian.kt` is a direct translation of `Guardian` in the Python hub — same states, same timers, same thresholds. Port it, don't redesign it.

### 7.2 Manifest — the permissions that actually matter

```xml
<uses-permission android:name="android.permission.BLUETOOTH_SCAN"
                 android:usesPermissionFlags="neverForLocation"/>
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT"/>
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"/>
<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION"/>
<uses-permission android:name="android.permission.SEND_SMS"/>
<uses-permission android:name="android.permission.CAMERA"/>
<uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE"/>
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_CAMERA"/>
<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED"/>
<uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS"/>

<service
    android:name=".service.GuardianService"
    android:foregroundServiceType="connectedDevice|camera|location"
    android:exported="false"/>
```

Five traps, in the order they'll bite you:

1. **`foregroundServiceType="connectedDevice"` is mandatory** or the OS kills your BLE link within minutes of backgrounding.
2. **Start the service while the app is in the foreground.** Android 11+ blocks camera and mic access for a foreground service *started from the background*. Start it when the user taps "Arm" — with the app visible — and never stop it. A service started in the foreground keeps camera access when the screen goes off.
3. **`SEND_SMS` is a restricted permission on Play Store**, requiring a declaration form. It works fine on a sideloaded APK — which is all you need for the hackathon. Mention the compliance path in the pitch; don't discover it on submission day.
4. **Battery optimisation exemption**: prompt with `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` during onboarding, or Doze will suspend you.
5. **OEM killers.** Xiaomi, Infinix, Tecno, Oppo, vivo — huge in Pakistan — have their own aggressive app-killers beyond stock Android. Add an onboarding step that opens the autostart/battery settings. Test on the actual phone you'll demo with, not just an emulator.

### 7.3 Screen lock (Device Admin)

```kotlin
class LockAdmin : DeviceAdminReceiver()

// activation (one-time, in onboarding)
val intent = Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN).apply {
    putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN,
             ComponentName(ctx, LockAdmin::class.java))
    putExtra(DevicePolicyManager.EXTRA_ADD_EXPLANATION,
             "Lets Nigehban lock your screen instantly if your phone is snatched.")
}

// on snatch
dpm.lockNow()
```

`FORCE_LOCK` / `lockNow()` still works. The camera-disable and password-reset policies are **deprecated** since Android 9 and throw `SecurityException` on API 29+ targets — do not build on them, and do not promise "camera lockout".

**How to phrase it to judges:** *"We lock the screen — we don't claim the phone becomes unwipeable. A determined thief can factory-reset it. Our value is that the photo and location reach the family in the 30 seconds before they can."* Saying this yourself pre-empts the obvious challenge and reads as security literacy rather than overclaiming.

### 7.4 Snatch photo (CameraX, no preview)

```kotlin
val provider = ProcessCameraProvider.getInstance(ctx).get()
val capture = ImageCapture.Builder()
    .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
    .build()
provider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_FRONT_CAMERA, capture)
capture.takePicture(outputOptions, executor, callback)
```

Run it from a `LifecycleService`. Capture **2–3 frames a second apart** — the first is usually a blur or a ceiling. Upload to OSS immediately; assume the phone is gone in 10 seconds. The photo that matters is the one already in the cloud.

### 7.5 Order of work on Day 3

BLE connect → parse events → port `Guardian` → SMS dispatch → lock → camera. **Ship each step.** If you run out of time at step 4, you still have a complete demo; if you start with the camera you'll have a half-wired app.

---

## 8. Alibaba Cloud wiring

### 8.1 Model Studio (Qwen) — risk engine + Urdu dispatch

Already implemented in `RiskEngine._qwen()`. Drop your key into `config.json` and the same code path works from Android via Retrofit.

- Use **`qwen-turbo`** or **`qwen-plus`** — cheapest tier, and this is a short structured-JSON-in, sentence-out task. `qwen-max` costs roughly 30× more for no benefit here.
- The free quota (documented at 1M tokens, 90 days from activation) covers a hackathon many times over.
- **Always keep the template fallback.** If the venue Wi-Fi dies mid-demo, the alert still sends. Judges notice graceful degradation.

Prompt design that works: system prompt fixes the format (2 lines Roman Urdu, 2 lines English, maps link verbatim, no invented facts); user message is the raw event JSON. Low temperature. This is *grounded generation*, not free writing — say that when asked how you prevent hallucinated emergencies.

### 8.2 IoT Platform (MQTT) — telemetry

Route phone → cloud telemetry over MQTT instead of a bespoke backend. Suggested topics:

```
/nigehban/{deviceId}/user/event       band + phone events
/nigehban/{deviceId}/user/heartbeat   battery, link state, every 60s
/nigehban/{deviceId}/user/alert       escalations (triggers the rules engine)
/nigehban/{deviceId}/user/cmd         cloud → phone (remote check-in request)
```

First 1M messages/month are free, then ~USD 0.8/M — functionally free at your scale. This gives you a defensible *"we built on Alibaba Cloud's IoT stack"* claim rather than "we called an LLM API."

### 8.3 Function Compute — cloud-side dead-man's switch

The phone's check-in timer dies with the phone. Mirror it in the cloud: each heartbeat writes a TTL key; a Function Compute function triggered by the IoT rules engine escalates when the TTL expires. Now **"the phone was destroyed"** is itself an alert condition, not a blind spot. This is a strong, cheap slide.

---

## 9. Migrating to the real wristband (Day 4)

### 9.1 BOM

| # | Part | Approx. |
|---|---|---|
| 1 | Seeed XIAO nRF52840 **Sense** (BLE + LSM6DS3TR-C IMU + LiPo charging onboard) | ₨4,000–5,000 |
| 2 | LiPo 100–150 mAh (302025 / 401220) | ₨400 |
| 3 | 6×6 mm tactile switch + silicone dome | ₨50 |
| 4 | 8 mm coin vibration motor + 2N2222 + 1N4148 + 1kΩ | ₨250 |
| 5 | Silicone watch strap (buy, don't print) | ₨200 |

Target ~30 × 25 × 12 mm, ₨4,000–5,500 total.

### 9.2 What changes in the firmware

**Unchanged:** the entire gesture engine, the event schema, the command handler, the feedback player. Copy them across as-is.

**Changed:**
1. **BLE stack** — swap `BLEDevice.h` for the Adafruit Bluefruit `BLEUart` service in the Seeed nRF52 board package. Same NUS UUIDs, so the phone doesn't notice.
2. **IMU** — the LSM6DS3 is already onboard on I²C; use its **hardware tap/double-tap interrupt** instead of polling. The MCU sleeps until the chip interrupts it, which is where the 1–2 week battery life comes from, and it makes "triple tap" a literal tap on the band rather than a button press you renamed.
3. **Power** — advertise at a 1 s interval, sleep between events.

### 9.3 Physical build order

Flash and test on USB **before** anything is glued → solder the LiPo to B+/B− **last** (never solder a live cell near a board you're probing) → hot-glue the motor to the inside of the bottom shell so vibration transmits into the wrist → decide the charging access (USB slot or exposed pads) **before** closing the case. That last one is the classic hackathon mistake.

Keep the LiPo *under* the board and away from the antenna end — a foil pouch over the nRF antenna detunes 2.4 GHz badly, and a wrist is a bag of saltwater that does the same. If range is poor in testing, this is why.

---

## 10. Five-day plan

| Day | Goal | Done when |
|---|---|---|
| **1 (today)** | ESP32 + hub, all 6 acceptance tests pass | You can demo the full logic on a laptop |
| **2** | Telegram/WhatsApp live, Qwen brief, MPU6050 fall detection | A real message lands on a real phone |
| **3** | Android app: BLE + `Guardian` port + SMS | Phone replaces the laptop |
| **4** | Lock + camera + XIAO build + strap | It's a wearable, not a breadboard |
| **5** | Cloud wiring, pitch deck, **rehearse the demo 5×** | Zero surprises on stage |

Hard rule: **Day 5 is not a build day.** Anything unfinished by end of Day 4 becomes a roadmap slide.

---

## 11. Demo script (4 minutes)

1. **Wear the band.** "This is Nigehban. No SIM, no GPS in it — that's the point. 5 parts, two weeks of battery."
2. **Check-in.** Band buzzes → press once → "That's the normal case. One press means I'm fine, and nothing reaches my family."
3. **Miss one.** Let it expire → the WhatsApp message lands on the judge's screen with the map link. "Silence is the alarm. An unconscious person can't press a panic button — but they also can't press *this* one."
4. **Snatch.** Arm, hand the phone to someone, have them walk off → 10-second pause → lock + photo + alert. "That pause is deliberate — here's what happens when the link just hiccups." Reconnect within the grace window: **no alarm**. This is the moment that shows engineering maturity.
5. **Fall.** Drop the band on a cushion → it asks first, you press, nothing sends. "False alarms are why people stop wearing these."
6. **The AI.** Show the Qwen-generated Urdu/English brief next to the raw JSON. "Qwen turns sensor data into something my mother can act on, in her language, in one message."

### Judge Q&A — prepare these four

- *"Can't the thief just factory-reset it?"* → Yes. We lock the screen; we don't claim invincibility. The photo and location are already sent — that's the 30-second window we're selling.
- *"Won't BLE drop all the time and spam alerts?"* → That's why there's a grace window plus a motion-spike confirmation. Here, watch. *(demo the no-alarm reconnect)*
- *"What if there's no internet?"* → SMS fallback via the phone's radio. No data required.
- *"Where's the AI, really?"* → Two places: grounded risk scoring and Urdu dispatch generation from raw sensor JSON, and Pattern-of-Life deviation detection over our own event log. Both run on Qwen via Model Studio; here's the API call.

---

## 12. Cut list — say these are roadmap, not demo

- **AirTag-style mesh relay.** It needs a fleet of Nigehban devices already in the wild to relay through. You have one. Roadmap slide only, and be explicit that it's a network-effect feature.
- **Preventing factory reset.** Not achievable without enterprise device ownership.
- **Camera lockout via Device Admin.** Deprecated; the API path is closed.
- **Continuous GPS tracking of elderly users.** Deliberately cut — Pattern-of-Life exists precisely so you *don't* need it. That's a privacy stance, not a limitation, and it's worth saying so.

---

## Appendix — files in this bundle

| File | What it is |
|---|---|
| ~~`firmware/nigehban_band_esp32.ino`~~ | ESP32 band firmware — **deleted 27 Aug 2026**; superseded by `nigehban_band_nrf52/` |
| `hub/nigehban_hub.py` | Laptop hub: BLE client + full guardian logic + dispatch + Qwen |
| `hub/config.json` | Your settings — contacts, timings, API keys |
| `hub/requirements.txt` | `bleak`, `requests` |
| `hub/events.jsonl` | Auto-created event log — your Pattern-of-Life dataset |
