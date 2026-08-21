/* ============================================================================
   NIGEHBAN BAND — ESP32 PROTOTYPE FIRMWARE
   ----------------------------------------------------------------------------
   Purpose: stand-in for the final XIAO nRF52840 Sense wristband.
   Speaks the EXACT same BLE protocol the final band will speak, so the phone
   app / laptop hub you write today does not change when you swap hardware.

   Transport : BLE, Nordic UART Service (NUS) — newline-delimited JSON
   Board     : any ESP32 dev board (WROOM-32, ESP32-C3 SuperMini, etc.)
   Deps      : none beyond the ESP32 Arduino core (BLE lib is bundled)

   Wiring (change pins below to match your board):
     BTN_A  -> GPIO 4  -> other leg to GND   (INPUT_PULLUP, no resistor needed)
     BTN_B  -> GPIO 5  -> other leg to GND
     LED    -> GPIO 2  (onboard LED on most WROOM boards)
     MOTOR  -> GPIO 18 -> 1k -> base of 2N2222; motor between 3V3 and collector;
                          1N4148 across motor (cathode to 3V3). Optional today.

   Arduino IDE: Tools > Board > ESP32 Dev Module, then Upload.
   ========================================================================= */

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// ---------------------------------------------------------------- CONFIG ---
#define DEVICE_NAME     "Nigehban-01"

#define PIN_BTN_A       4
#define PIN_BTN_B       5
#define PIN_LED         2
#define PIN_MOTOR       18      // set to -1 if you have not wired a motor yet

#define HAS_IMU         0       // set to 1 when MPU6050 is wired (SDA=21 SCL=22)
#define SIM_BATTERY     1       // fake a slowly draining battery for demos

// Gesture timing (ms)
#define DEBOUNCE_MS     35
#define CLICK_GAP_MS    420     // max gap between clicks in a multi-click
#define HOLD_1_MS       3000    // "hold 3s"  -> arm / change check-in interval
#define HOLD_2_MS       5000    // "hold 5s"  -> unbound; v2 anti-snatch

#define HEARTBEAT_MS    10000

// Nordic UART Service UUIDs — keep these identical on the nRF52840 build
#define NUS_SERVICE     "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define NUS_RX_CHAR     "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"  // phone -> band
#define NUS_TX_CHAR     "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"  // band  -> phone

// ------------------------------------------------------------------ STATE ---
BLEServer         *gServer = nullptr;
BLECharacteristic *gTx     = nullptr;
bool  gConnected     = false;
bool  gWasConnected  = false;

uint8_t  gBattery      = 100;
bool     gArmed        = false;   // anti-snatch, v2 -- no gesture sets it yet
bool     gHighAlert    = false;   // High Alert (exec plan section 5, hold 3 s)
bool     gAwaitingAck  = false;   // a check-in request is outstanding
uint32_t gAckDeadline  = 0;
uint32_t gLastHeartbeat= 0;
uint32_t gSeq          = 0;

// Forward declaration. The Arduino IDE injects auto-generated prototypes just
// above the first function definition, which is ABOVE the real struct below --
// so the name has to exist by here or buttonTick()'s prototype will not compile.
struct Button;

// ------------------------------------------------------- FEEDBACK ENGINE ---
// Non-blocking buzz/blink pattern player. Never use delay() in loop().
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
  digitalWrite(PIN_LED, gPat.high ? HIGH : LOW);
  if (PIN_MOTOR >= 0) digitalWrite(PIN_MOTOR, gPat.high ? HIGH : LOW);

  if (gPat.high) {
    gPat.nextChange = now + gPat.onMs;
  } else {
    gPat.nextChange = now + gPat.offMs;
    gPat.pulsesLeft--;
  }
}

// --------------------------------------------------------------- BLE TX ---
void send(const String &json) {
  Serial.println(json);                       // always mirror to USB serial
  if (!gConnected || gTx == nullptr) return;
  String line = json + "\n";
  gTx->setValue((uint8_t *)line.c_str(), line.length());
  gTx->notify();
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
struct Button {
  uint8_t  pin;
  uint8_t  id;                 // 1 = A, 2 = B
  bool     stable = true;      // true = released (pull-up)
  bool     lastRead = true;
  uint32_t lastChange = 0;
  uint32_t pressStart = 0;
  uint8_t  clicks = 0;
  uint32_t lastRelease = 0;
  bool     holdFired1 = false;
  bool     holdFired2 = false;
};

Button gBtnA{PIN_BTN_A, 1};
Button gBtnB{PIN_BTN_B, 2};

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

  // finalise a multi-click burst once the user stops clicking
  if (b.clicks > 0 && b.stable == HIGH && (now - b.lastRelease) > CLICK_GAP_MS) {
    uint8_t n = b.clicks;
    b.clicks = 0;
    onGesture(b.id, "click", n);
  }
}

// -------------------------------------------------------- GESTURE MAP ---
// This is the ONLY place hardware meets meaning, and it must stay identical to
// DEFAULT_GESTURES in nigehban-app/src/virtualBand.js. Two copies of one
// decision is the cost of the phone being able to stand in for the band; a
// third copy would not be.
//
// Follows EXECUTION_PLAN.md section 5, the frozen contract:
//
//     1 tap        checkin_ack        "I'm fine" / stands down a live SOS
//     2+ taps      sos                double-tap is the specified gesture
//     hold 3 s     high_alert_on/off  toggles High Alert
//
// Nothing is bound to hold 5 s. Anti-snatch is deferred to v2, so the wearer
// has two things to remember rather than three, and holding past 3 s no longer
// crosses a second threshold on the way. HOLD_2_MS and the armed/disarmed
// events stay defined -- v2 restores this block and the matching row in
// DEFAULT_GESTURES, and nothing else has to change.
//
// On the final single-button band everything above already lives on button 1,
// so nothing here moves when button B goes away.
void onGesture(uint8_t btn, const char *gesture, uint8_t n) {
  String meta = "\"btn\":" + String(btn) + ",\"g\":\"" + gesture + "\",\"n\":" + String(n);

  // --- Button A ---
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

  // --- Button B: dedicated SOS while prototyping (one key on the real band)
  if (btn == 2 && strcmp(gesture, "click") == 0) {
    feedback(4, 120, 80);
    sendEvent("sos", meta + ",\"src\":\"button_b\"");
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
    sendEvent("battery", "\"forced\":1");
  } else if (c == "ping") {
    sendEvent("pong");
  }
}

class RxCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *ch) override {
    // getData()/getLength() work on both core 2.x and 3.x (getValue() does not)
    uint8_t *d = ch->getData();
    size_t   n = ch->getLength();
    String line;
    for (size_t i = 0; i < n; i++) line += (char)d[i];
    line.trim();
    if (line.length()) handleCommand(line);
  }
};

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *) override    { gConnected = true;  }
  void onDisconnect(BLEServer *) override { gConnected = false; }
};

// ------------------------------------------------------------- IMU ---
#if HAS_IMU
#include <Wire.h>
#define MPU_ADDR 0x68
uint8_t gFallStage = 0;          // 0 idle, 1 free-fall seen, 2 impact seen
uint32_t gFallStamp = 0;

void imuBegin() {
  Wire.begin();
  Wire.beginTransmission(MPU_ADDR); Wire.write(0x6B); Wire.write(0); Wire.endTransmission(true);
}

float imuMagnitudeG() {
  Wire.beginTransmission(MPU_ADDR); Wire.write(0x3B); Wire.endTransmission(false);
  Wire.requestFrom((uint8_t)MPU_ADDR, (uint8_t)6, (bool)true);
  int16_t ax = Wire.read() << 8 | Wire.read();
  int16_t ay = Wire.read() << 8 | Wire.read();
  int16_t az = Wire.read() << 8 | Wire.read();
  float x = ax / 16384.0f, y = ay / 16384.0f, z = az / 16384.0f;
  return sqrtf(x * x + y * y + z * z);
}

// Classic 3-phase fall: free-fall (<0.4g) -> impact (>2.5g) -> stillness.
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
  Serial.begin(115200);
  pinMode(PIN_BTN_A, INPUT_PULLUP);
  pinMode(PIN_BTN_B, INPUT_PULLUP);
  pinMode(PIN_LED, OUTPUT);
  if (PIN_MOTOR >= 0) { pinMode(PIN_MOTOR, OUTPUT); digitalWrite(PIN_MOTOR, LOW); }

  BLEDevice::init(DEVICE_NAME);
  gServer = BLEDevice::createServer();
  gServer->setCallbacks(new ServerCallbacks());

  BLEService *svc = gServer->createService(NUS_SERVICE);

  gTx = svc->createCharacteristic(NUS_TX_CHAR, BLECharacteristic::PROPERTY_NOTIFY);
  gTx->addDescriptor(new BLE2902());

  BLECharacteristic *rx = svc->createCharacteristic(
      NUS_RX_CHAR,
      BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  rx->setCallbacks(new RxCallbacks());

  svc->start();

  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(NUS_SERVICE);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();

#if HAS_IMU
  imuBegin();
#endif

  feedback(2, 120, 100);
  Serial.println("{\"t\":\"log\",\"msg\":\"Nigehban band up, advertising\"}");
}

// -------------------------------------------------------------- LOOP ---
void loop() {
  uint32_t now = millis();

  buttonTick(gBtnA);
  buttonTick(gBtnB);
  feedbackTick();
#if HAS_IMU
  imuTick();
#endif

  // connection edges
  if (gConnected != gWasConnected) {
    gWasConnected = gConnected;
    if (gConnected) {
      feedback(1, 200, 100);
      sendEvent("link_up");
    } else {
      feedback(2, 80, 80);
      BLEDevice::startAdvertising();       // re-advertise so phone can return
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
#if SIM_BATTERY
    if (gBattery > 0 && (now / HEARTBEAT_MS) % 6 == 0) gBattery--;   // ~1%/min
#endif
    sendEvent("hb", "\"up\":" + String(now / 1000));
  }
}
