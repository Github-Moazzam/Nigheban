/* ============================================================================
   NIGEHBAN BAND — XIAO nRF52840 SENSE FIRMWARE
   ----------------------------------------------------------------------------
   The real band. Speaks the EXACT protocol the ESP32 prototype speaks, so the
   phone app does not change when you swap hardware. That is the whole point of
   this file: EXECUTION_PLAN.md section 5 is frozen, and the app must not be
   able to tell which board answered.

   Transport : BLE, Nordic UART Service — newline-delimited JSON, via BLEUart
   Board     : Seeed XIAO nRF52840 **Sense**  (Seeeduino:nrf52:xiaonRF52840Sense)
   Core      : Seeed nRF52 Boards 1.1.13 (Adafruit Bluefruit) — NOT the mbed one
   Library   : Seeed Arduino LSM6DS3 (only needed once HAS_IMU flips to 1)

   Wiring — proven on the bench by T2/T3, see firmware/README.md:
     BTN    -> D2  -> other leg to GND    (INPUT_PULLUP, no resistor)
     MOTOR  -> D1  -> driver module IN    (100 uF bulk cap across motor supply)
     LED    -> onboard, pin 11, ACTIVE LOW

   ------------------------------------------------------------------------
   WHAT CAME OVER VERBATIM (F2.1)

   `Pattern` / `feedback()` / `feedbackTick()`, `Button` / `buttonTick()`,
   `onGesture()`, `jsonStr()` / `jsonInt()` / `handleCommand()` are unchanged
   from nigehban_band_esp32.ino. They were already correct and already agreed
   with the app; re-deriving them would only introduce drift.

   WHAT CHANGED, AND WHY

     BLE layer      BLEDevice/BLEServer/BLE2902 -> BLEUart. Bluefruit ships NUS
                    as one object, so the three-characteristic dance is gone.
     Button B       Deleted. The shipped band has one button, and the ESP32
                    gesture map already put everything on button 1 -- so this
                    removes a line, not a feature.
     IMU            MPU6050 path deleted (F2.2). The Sense has an LSM6DS3TR-C
                    on board at 0x6A; external-IMU code is work spent on
                    hardware we do not have.
     Battery        SIM_BATTERY replaced with the real divider (F2.3).
     LED polarity   Active LOW on this board. See ledWrite().

   ------------------------------------------------------------------------
   OPEN — THE HAPTIC TIMINGS BELOW ARE CORRECT AND CURRENTLY IMPERCEPTIBLE

   Every feedback() pulse width here (60-250 ms) is the RIGHT value for a
   healthy coin ERM, which reaches speed in 50-80 ms. On the current motor
   module ~300 ms is the floor, so as of today most of these cannot be felt.

   DO NOT "fix" this by raising the numbers. At a 300 ms floor a 1-pulse ack and
   a 4-pulse SOS both degrade into "a long buzz happened", and SOS confirmation
   slips from 0.7 s to 1.8 s -- in the one moment the wearer cannot wait and
   cannot look. The driver is what is broken. firmware/README.md carries the
   diagnosis and the 20-second test that settles it.

   These numbers become correct the moment the driver is fixed. Leave them.
   ========================================================================= */

#include <Adafruit_TinyUSB.h>   // USB CDC. Without it `Serial` fails to LINK.
#include <bluefruit.h>

// ---------------------------------------------------------------- CONFIG ---
#define DEVICE_NAME     "Nigehban-01"

#define PIN_BTN         D2
#define PIN_MOTOR       D1
// LED_BUILTIN is 11 and ACTIVE LOW on this board -- always go through
// ledWrite(), never digitalWrite(), or every indicator reads inverted.

#define HAS_IMU         0       // flip to 1 in F3, with the LSM6DS3 library

// Gesture timing (ms) — identical to the ESP32 build and to the app's
// DEFAULT_GESTURES. Changing one without the others silently breaks the demo.
#define DEBOUNCE_MS     35
// How long a lone tap waits to see whether a second one is coming. This is NOT
// a cosmetic timeout -- see "THE SLOW-TAP FAILURE" below. It only ever delays
// checkin_ack; SOS fires on the second tap itself and is unaffected.
#define TAP_WINDOW_MS   1200
#define HOLD_1_MS       3000    // "hold 3s"  -> High Alert toggle
#define HOLD_2_MS       5000    // "hold 5s"  -> unbound; v2 anti-snatch

#define HEARTBEAT_MS    10000

// ------------------------------------------------------------------ STATE ---
BLEUart bleuart;                // this IS the Nordic UART Service

bool     gConnected    = false;
bool     gWasConnected = false;

uint8_t  gBattery      = 100;
bool     gBatteryForced= false;   // `bat` command pins it for demos
bool     gArmed        = false;   // anti-snatch, v2 -- no gesture sets it yet
bool     gHighAlert    = false;   // High Alert (exec plan section 5, hold 3 s)
bool     gAwaitingAck  = false;   // a check-in request is outstanding
uint32_t gAckDeadline  = 0;
uint32_t gLastHeartbeat= 0;
uint32_t gSeq          = 0;
String   gRxLine;                 // accumulates until '\n'

// Forward declaration. The Arduino IDE injects auto-generated prototypes just
// above the first function definition, which is ABOVE the real struct below --
// so the name has to exist by here or buttonTick()'s prototype will not compile.
struct Button;

void ledWrite(bool on) { digitalWrite(LED_BUILTIN, on ? LOW : HIGH); }

// ------------------------------------------------------- FEEDBACK ENGINE ---
// Non-blocking buzz/blink pattern player. Never use delay() in loop() (F4.3).
// Verbatim from the ESP32 build except for the LED polarity.
struct Pattern {
  uint8_t  pulsesLeft = 0;
  uint16_t onMs = 0, offMs = 0;
  bool     high = false;
  uint32_t nextChange = 0;
} gPat;

void feedback(uint8_t pulses, uint16_t onMs, uint16_t offMs) {
  gPat.pulsesLeft = pulses;
  gPat.onMs = onMs;
  gPat.offMs = offMs;
  gPat.high = false;
  gPat.nextChange = 0;   // fire immediately
}

void feedbackTick() {
  if (gPat.pulsesLeft == 0) return;
  uint32_t now = millis();
  if (now < gPat.nextChange) return;

  gPat.high = !gPat.high;
  ledWrite(gPat.high);
  digitalWrite(PIN_MOTOR, gPat.high ? HIGH : LOW);

  if (gPat.high) {
    gPat.nextChange = now + gPat.onMs;
  } else {
    gPat.nextChange = now + gPat.offMs;
    gPat.pulsesLeft--;
  }
}

// ----------------------------------------------------------- BATTERY (F2.3) ---
// The divider on VBAT_ENABLE (P0.14) is enabled by driving it LOW, then the
// tapped voltage is read on PIN_VBAT (P0.31). Note the macro is VBAT_ENABLE --
// EXECUTION_PLAN.md:512 writes PIN_VBAT_ENABLE, which does not exist and does
// not compile.
//
// CALIBRATE THESE TWO AGAINST A MULTIMETER before trusting any percentage.
// Meter the cell directly, compare to the mv= field on the serial heartbeat,
// and scale VBAT_DIVIDER_COMP by the ratio. Everything downstream -- the app's
// low-battery warning, the demo-day "is it charged?" glance -- rides on it.
#define VBAT_MV_PER_LSB     (3000.0F / 4096.0F)  // AR_INTERNAL_3_0, 12-bit
#define VBAT_DIVIDER_COMP   (2.961F)             // 1M / 510k tap -- VERIFY

// ===========================================================================
// DO NOT "OPTIMISE" VBAT_ENABLE. IT WILL DESTROY THE BOARD.
//
// The divider is  BAT+ -- 1M -- P0.31 -- 510k -- P0.14, so P0.14 is its BOTTOM
// leg. Driving it LOW completes the path and is what puts a safely divided
// voltage on P0.31. Set it HIGH, or leave it high-Z as an INPUT, and there is
// no division at all: P0.31 floats up toward BAT+ through the 1M. While
// charging that is ~4.2 V against a 3.6 V absolute maximum on the pin, and the
// pin is permanently destroyed. Seeed warn about this explicitly.
//
// The tempting power saving -- "the divider drains current, so gate it between
// readings" -- is exactly the fatal move. That drain is 4.2 V / 1.51 M = 2.8 uA,
// under 1.5% of the 200-400 uA budget in F4.3. Leave the pin LOW forever.
// ===========================================================================
void batteryBegin() {
  pinMode(VBAT_ENABLE, OUTPUT);
  digitalWrite(VBAT_ENABLE, LOW);        // LOW enables the divider -- see above
  analogReference(AR_INTERNAL_3_0);
  analogReadResolution(12);
  delay(1);
}

uint16_t batteryMilliVolts() {
  uint32_t sum = 0;
  for (uint8_t i = 0; i < 8; i++) sum += analogRead(PIN_VBAT);   // cheap average
  return (uint16_t)((sum / 8.0F) * VBAT_MV_PER_LSB * VBAT_DIVIDER_COMP);
}

// Piecewise LiPo curve. A linear 3.3-4.2 V map reads ~50% for most of the
// discharge and then falls off a cliff, which trains the wearer to ignore it.
uint8_t batteryPercent(uint16_t mv) {
  if (mv >= 4150) return 100;
  if (mv >= 4000) return 85 + (mv - 4000) * 15 / 150;
  if (mv >= 3850) return 65 + (mv - 3850) * 20 / 150;
  if (mv >= 3700) return 40 + (mv - 3700) * 25 / 150;
  if (mv >= 3550) return 15 + (mv - 3550) * 25 / 150;
  if (mv >= 3300) return      (mv - 3300) * 15 / 250;
  return 0;
}

// --------------------------------------------------------------- BLE TX ---
void send(const String &json) {
  Serial.println(json);                       // always mirror to USB serial
  if (!gConnected) return;
  String line = json + "\n";
  bleuart.write(line.c_str(), line.length());
}

void sendEvent(const char *type, const String &extra = "") {
  String j = "{\"t\":\"evt\",\"e\":\"";
  j += type;
  j += "\",\"seq\":" + String(++gSeq);
  j += ",\"ms\":" + String(millis());
  j += ",\"bat\":" + String(gBattery);
  j += ",\"armed\":" + String(gArmed ? 1 : 0);
  j += ",\"ha\":" + String(gHighAlert ? 1 : 0);
  if (extra.length()) j += "," + extra;
  j += "}";
  send(j);
}

// ------------------------------------------------------- BUTTON ENGINE ---
// Verbatim from the ESP32 build. Button B is gone; the shipped band has one
// button and the gesture map already lived on button 1.
struct Button {
  uint8_t  pin;
  uint8_t  id;                 // 1 = the only button on the shipped band
  bool     stable = true;      // true = released (pull-up)
  bool     lastRead = true;
  uint32_t lastChange = 0;
  uint32_t pressStart = 0;
  uint8_t  clicks = 0;
  uint32_t lastRelease = 0;
  bool     sosFired = false;   // this burst already sent SOS; stay quiet after
  bool     holdFired1 = false;
  bool     holdFired2 = false;

  // The ESP32 build brace-initialised this struct. That core compiles to a
  // newer C++ standard; this one is gnu++11, where the default member
  // initialisers above stop Button being an aggregate and `Button b{pin, id}`
  // will not compile. Same two fields, set the only way this core allows.
  Button(uint8_t p, uint8_t i) : pin(p), id(i) {}
};

Button gBtn(PIN_BTN, 1);

void onGesture(uint8_t btn, const char *gesture, uint8_t n);

void buttonTick(Button &b) {
  uint32_t now = millis();
  bool raw = digitalRead(b.pin);              // LOW = pressed

  if (raw != b.lastRead) { b.lastRead = raw; b.lastChange = now; }

  if ((now - b.lastChange) > DEBOUNCE_MS && raw != b.stable) {
    b.stable = raw;
    if (b.stable == LOW) {                    // ---- press edge
      b.pressStart = now;
      b.holdFired1 = b.holdFired2 = false;
    } else {                                  // ---- release edge
      uint32_t held = now - b.pressStart;
      if (!b.holdFired1 && !b.holdFired2 && held < HOLD_1_MS) {
        b.clicks++;
        b.lastRelease = now;
        // SOS the instant the second tap lands -- do not wait for the burst to
        // close. Taps 3, 4, 5 are still SOS but must not re-send it, so the
        // flag latches for the rest of the burst.
        if (b.clicks == 2 && !b.sosFired) {
          b.sosFired = true;
          onGesture(b.id, "click", 2);
        }
      }
    }
  }

  // The hold threshold fires while still held down (with a cue), like real
  // devices. Only hold3 is bound today; the hold5 hook is commented out rather
  // than deleted so v2 anti-snatch is a two-line restore -- an unbound
  // threshold must stay silent, or the band buzzes to announce it did nothing.
  if (b.stable == LOW) {
    uint32_t held = now - b.pressStart;
    if (!b.holdFired1 && held >= HOLD_1_MS) {
      b.holdFired1 = true;
      feedback(1, 250, 120);
      onGesture(b.id, "hold3", 0);
    }
    // if (!b.holdFired2 && held >= HOLD_2_MS) {
    //   b.holdFired2 = true;
    //   feedback(2, 250, 120);
    //   onGesture(b.id, "hold5", 0);
    // }
  }

  // Close the burst. By the time we get here SOS has already been sent if it
  // was ever going to be, so the only thing this can still emit is the 1-tap
  // checkin_ack -- which is exactly the event that must never be guessed.
  if (b.clicks > 0 && b.stable == HIGH && (now - b.lastRelease) > TAP_WINDOW_MS) {
    uint8_t n = b.clicks;
    bool    alreadySos = b.sosFired;
    b.clicks = 0;
    b.sosFired = false;
    if (!alreadySos) onGesture(b.id, "click", n);
  }
}

// -------------------------------------------------------- GESTURE MAP ---
// This is the ONLY place hardware meets meaning, and it must stay identical to
// DEFAULT_GESTURES in nigehban-app/src/virtualBand.js AND to the ESP32 build.
//
// Follows EXECUTION_PLAN.md section 5, the frozen contract:
//
//     1 tap        checkin_ack        "I'm fine" / stands down a live SOS
//     2+ taps      sos                double-tap is the specified gesture
//     hold 3 s     high_alert_on/off  toggles High Alert
//
// Nothing is bound to hold 5 s. Anti-snatch is deferred to v2, so the wearer
// has two things to remember rather than three.
//
// ---------------------------------------------------------------------------
// THE SLOW-TAP FAILURE — why SOS fires early and checkin_ack fires late
//
// The original design counted taps, waited CLICK_GAP_MS (420 ms) for the burst
// to end, and only then decided what had happened. That has a failure mode
// worse than not working at all:
//
//   Someone frightened taps twice, but slowly -- 500 ms apart. Each tap closes
//   its own burst. The band sends checkin_ack. Twice. The family is told
//   "I'm fine" by a person calling for help.
//
// The two errors are not equally bad. A false SOS is embarrassing and someone
// stands it down in seconds. A false "I'm fine" is silent, final, and arrives
// exactly when it must not. So the tie is broken toward SOS, always:
//
//   * SOS fires on the SECOND TAP ITSELF, not when the burst closes. Nothing is
//     waited for, and the ack can no longer win the race by going first. This
//     also makes a real SOS ~400 ms faster, which is the case that needs it.
//
//   * checkin_ack waits TAP_WINDOW_MS (1200 ms) before committing, because it
//     is the claim we must never make by accident. Two taps up to 1.2 s apart
//     are now SOS. The cost is that "I'm fine" confirms a beat later, and
//     nobody is in danger while that beat passes.
//
// A consequence worth accepting rather than fixing: a wearer who taps, feels
// no buzz, and taps again out of doubt now raises an SOS. That is the correct
// direction to fail, and it is the same reasoning that already makes 3, 4 and
// 5 taps SOS. It will also get rarer once the haptics are strong enough to
// confirm the first tap -- see the driver note at the top of this file.
//
// virtualBand.js must match this. It still has the old 420 ms burst logic and
// therefore still has the bug.
// ---------------------------------------------------------------------------
void onGesture(uint8_t btn, const char *gesture, uint8_t n) {
  String meta = "\"btn\":" + String(btn) + ",\"g\":\"" + gesture + "\",\"n\":" + String(n);

  if (btn == 1 && strcmp(gesture, "click") == 0) {
    if (n == 1) {                       // "I'm fine" / silence a check-in
      gAwaitingAck = false;
      feedback(1, 90, 90);
      sendEvent("checkin_ack", meta);
      return;
    }
    // Two taps is SOS -- and so are three, four, five. A frightened person
    // does not tap a precise number of times, and being strict here fails
    // silently at the exact moment the product has to work. Section 5 reserves
    // 4 taps for `armed` in v2; that needs its own affordance, because folding
    // it in would let an over-tapped SOS arm anti-snatch instead of calling
    // for help.
    feedback(4, 120, 80);
    sendEvent("sos", meta + ",\"src\":\"double_tap\"");
    return;
  }

  // --- Hold ---
  // Fires on the way past, with its own buzz count, so the wearer can feel
  // that it landed without looking at anything.
  if (strcmp(gesture, "hold3") == 0) {
    gHighAlert = !gHighAlert;
    feedback(gHighAlert ? 2 : 1, 180, 120);
    sendEvent(gHighAlert ? "high_alert_on" : "high_alert_off", meta);
    return;
  }
}

// ------------------------------------------------------ COMMANDS IN ---
// Tiny dependency-free JSON field reader. Good enough for our fixed schema.
String jsonStr(const String &s, const char *key) {
  String pat = String("\"") + key + "\":\"";
  int i = s.indexOf(pat);
  if (i < 0) return "";
  i += pat.length();
  int j = s.indexOf('"', i);
  return (j < 0) ? "" : s.substring(i, j);
}
int jsonInt(const String &s, const char *key, int dflt) {
  String pat = String("\"") + key + "\":";
  int i = s.indexOf(pat);
  if (i < 0) return dflt;
  i += pat.length();
  return s.substring(i).toInt();
}

void handleCommand(const String &line) {
  String c = jsonStr(line, "c");
  if (c == "checkin_req") {                  // phone asks "are you OK?"
    gAwaitingAck = true;
    gAckDeadline = millis() + (uint32_t)jsonInt(line, "window", 60) * 1000UL;
    feedback(3, 400, 250);                   // long, unmissable buzz
    sendEvent("checkin_prompted");
  } else if (c == "buzz") {
    feedback(jsonInt(line, "n", 2), 150, 120);
  } else if (c == "alarm") {
    feedback(20, 300, 200);
  } else if (c == "ack") {                   // cloud received our event
    feedback(1, 60, 60);
  } else if (c == "bat") {                   // demo helper: force battery level
    gBattery = (uint8_t)jsonInt(line, "v", 100);
    gBatteryForced = true;
    sendEvent("battery", "\"forced\":1");
  } else if (c == "ping") {
    sendEvent("pong");
  }
}

// ------------------------------------------------------- BLE CALLBACKS ---
void connect_callback(uint16_t conn_handle) {
  gConnected = true;
  // Longer connection interval once linked: this is most of the idle current
  // the 1-2 week budget depends on (F4.3). Units of 1.25 ms -> 30-60 ms.
  BLEConnection *c = Bluefruit.Connection(conn_handle);
  if (c) c->requestConnectionParameter(24, 48);
}

void disconnect_callback(uint16_t conn_handle, uint8_t reason) {
  (void) conn_handle; (void) reason;
  gConnected = false;
  // restartOnDisconnect(true) re-advertises for us.
}

// ------------------------------------------------------------- IMU (F3) ---
// Deliberately compiled out until F3. The MPU6050 path from the ESP32 build is
// gone for good (F2.2) -- this is the on-board LSM6DS3TR-C at 0x6A.
#if HAS_IMU
#include "LSM6DS3.h"
LSM6DS3 imu(I2C_MODE, 0x6A);     // the Seeed lib remaps to Wire1 internally
uint8_t  gFallStage = 0;         // 0 idle, 1 free-fall seen, 2 impact seen
uint32_t gFallStamp = 0;

void imuBegin() {
  // THE POWER GATE. The Sense can switch the IMU off entirely for low power,
  // and until this pin is HIGH, begin() fails on perfectly good hardware. The
  // EXECUTION_PLAN.md section 8 skeleton is missing this line.
  pinMode(PIN_LSM6DS3TR_C_POWER, OUTPUT);
  digitalWrite(PIN_LSM6DS3TR_C_POWER, HIGH);
  delay(10);
  imu.begin();
}

float imuMagnitudeG() {
  float x = imu.readFloatAccelX();
  float y = imu.readFloatAccelY();
  float z = imu.readFloatAccelZ();
  return sqrtf(x * x + y * y + z * z);
}

// Classic 3-phase fall: free-fall (<0.4g) -> impact (>2.5g) -> stillness.
// F3.2 tunes these against real CSV; F3.3 says log from Phase 2 onward,
// because a bag falling off a chair must not page a mother at 2 a.m.
void imuTick() {
  static uint32_t last = 0;
  uint32_t now = millis();
  if (now - last < 20) return;             // 50 Hz is plenty
  last = now;

  float g = imuMagnitudeG();
  switch (gFallStage) {
    case 0:
      if (g < 0.40f) { gFallStage = 1; gFallStamp = now; }
      break;
    case 1:
      if (g > 2.50f) { gFallStage = 2; gFallStamp = now; }
      else if (now - gFallStamp > 800) gFallStage = 0;
      break;
    case 2:
      if (now - gFallStamp > 1500) {       // still upset? call it a fall
        gFallStage = 0;
        feedback(5, 200, 150);
        sendEvent("fall", "\"peak_g\":" + String(g, 2));
      }
      break;
  }
}
#endif

// ------------------------------------------------------------- SETUP ---
void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  ledWrite(false);
  pinMode(PIN_BTN, INPUT_PULLUP);
  pinMode(PIN_MOTOR, OUTPUT);
  digitalWrite(PIN_MOTOR, LOW);

  Serial.begin(115200);
  uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 3000) delay(10);   // don't hang on battery

  batteryBegin();
  gBattery = batteryPercent(batteryMilliVolts());

  Bluefruit.begin();
  Bluefruit.setName(DEVICE_NAME);
  Bluefruit.setTxPower(4);
  Bluefruit.Periph.setConnectCallback(connect_callback);
  Bluefruit.Periph.setDisconnectCallback(disconnect_callback);

  bleuart.begin();

  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addTxPower();
  Bluefruit.Advertising.addService(bleuart);
  // The name goes in the scan response: the 128-bit NUS UUID costs 18 of the
  // advertising packet's 31 bytes and "Nigehban-01" will not fit alongside it.
  Bluefruit.ScanResponse.addName();
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(32, 244);   // 20 ms fast / 152.5 ms slow
  Bluefruit.Advertising.setFastTimeout(30);
  Bluefruit.Advertising.start(0);               // 0 = advertise forever

#if HAS_IMU
  imuBegin();
#endif

  feedback(2, 120, 100);
  Serial.println("{\"t\":\"log\",\"msg\":\"Nigehban band up, advertising\"}");
}

// -------------------------------------------------------------- LOOP ---
void loop() {
  uint32_t now = millis();

  buttonTick(gBtn);
  feedbackTick();
#if HAS_IMU
  imuTick();
#endif

  // ---- phone -> band, newline-delimited
  //
  // The app terminates every command with '\n', so the accumulate-to-newline
  // path is the real one. The idle flush below exists because generic BLE
  // clients -- nRF Connect above all -- send exactly what you typed and no
  // newline, and without it a hand-written {"c":"ping"} sits in the buffer
  // forever and the band looks dead. Bench tooling has to work too.
  //
  // 200 ms is far longer than the gap between fragments of one MTU-split write
  // and far shorter than a human retyping, so it cannot cut a real line in half.
  static uint32_t lastRxByte = 0;
  while (bleuart.available()) {
    char c = (char) bleuart.read();
    lastRxByte = now;
    if (c == '\n' || c == '\r') {
      gRxLine.trim();
      if (gRxLine.length()) handleCommand(gRxLine);
      gRxLine = "";
    } else if (gRxLine.length() < 200) {
      gRxLine += c;
    }
  }
  if (gRxLine.length() && (now - lastRxByte) > 200) {
    gRxLine.trim();
    if (gRxLine.length()) handleCommand(gRxLine);
    gRxLine = "";
  }

  // connection edges
  if (gConnected != gWasConnected) {
    gWasConnected = gConnected;
    if (gConnected) {
      feedback(1, 200, 100);
      sendEvent("link_up");
    } else {
      feedback(2, 80, 80);
      Serial.println("{\"t\":\"log\",\"msg\":\"link down, advertising again\"}");
    }
  }

  // missed check-in: band nags once more, phone owns the real escalation
  if (gAwaitingAck && now > gAckDeadline) {
    gAwaitingAck = false;
    feedback(5, 350, 200);
    sendEvent("checkin_missed");
  }

  // heartbeat
  if (now - gLastHeartbeat > HEARTBEAT_MS) {
    gLastHeartbeat = now;
    uint16_t mv = batteryMilliVolts();
    if (!gBatteryForced) gBattery = batteryPercent(mv);
    sendEvent("hb", "\"up\":" + String(now / 1000) + ",\"mv\":" + String(mv));
  }
}
