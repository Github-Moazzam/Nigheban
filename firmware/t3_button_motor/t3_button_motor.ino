/* ============================================================================
   NIGEHBAN — TEST 3: BUTTON GESTURES + HAPTIC CONFIRMATION
   ----------------------------------------------------------------------------
   Board: Seeed XIAO nRF52840 Sense.  USB powered, no battery.

   This is the real interaction model from the execution plan, minus BLE:
     hold 3 s  -> High Alert / interval alerts     -> one buzz at the 3 s mark
     hold 5 s  -> arm disconnection alarm          -> double buzz at the 5 s mark

   The buzz fires WHEN THE THRESHOLD IS CROSSED, not on release. That is the
   whole point: in a snatching the user cannot look at a screen, so the wrist
   has to tell them the gesture registered while their thumb is still down.

   WIRING (adds to T2)
     module IN   -> XIAO D1
     module VCC  -> XIAO 3V3
     module GND  -> XIAO GND
     100 uF across module VCC/GND
     tactile switch: one leg -> XIAO D2, the diagonally opposite leg -> GND
        A 6x6 tactile has 4 legs in 2 permanently-connected pairs. Use legs
        that are DIAGONAL from each other and you cannot get the pair wrong.
        No pull-up resistor needed — INPUT_PULLUP handles it.

   Pass = serial log and the buzzes agree with your stopwatch.

   NOTE: buzz() blocks with delay(). Fine for a bench test; the shipping
   firmware uses the non-blocking pattern player in
   nigehban_band_nrf52.ino (see feedback() / feedbackTick()).
   ========================================================================= */

#include <Adafruit_TinyUSB.h>   // required for `Serial` to link on this core

#define PIN_MOTOR    1     // D1
#define PIN_BUTTON   2     // D2

#define DEBOUNCE_MS    35
#define HOLD_1_MS    3000
#define HOLD_2_MS    5000

static bool     btnStable  = false;   // debounced state, true = pressed
static bool     btnLastRaw = false;
static uint32_t btnChanged = 0;
static uint32_t pressStart = 0;
static bool     hit1 = false;
static bool     hit2 = false;

void buzz(uint16_t ms) {
  digitalWrite(PIN_MOTOR, HIGH);
  delay(ms);
  digitalWrite(PIN_MOTOR, LOW);
}

void setup() {
  pinMode(PIN_MOTOR, OUTPUT);
  digitalWrite(PIN_MOTOR, LOW);

  pinMode(PIN_BUTTON, INPUT_PULLUP);  // idle reads HIGH, pressed reads LOW

  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, HIGH);    // active low: HIGH = off

  Serial.begin(115200);
  uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 3000) delay(10);

  Serial.println(F("T3: ready. Press and hold the button."));
}

void loop() {
  uint32_t now = millis();
  bool raw = (digitalRead(PIN_BUTTON) == LOW);

  if (raw != btnLastRaw) {
    btnLastRaw = raw;
    btnChanged = now;
  }

  if (raw != btnStable && (now - btnChanged) >= DEBOUNCE_MS) {
    btnStable = raw;

    if (btnStable) {                      // ---- press edge
      pressStart = now;
      hit1 = false;
      hit2 = false;
      digitalWrite(LED_BUILTIN, LOW);     // LED on while held
      Serial.println(F("press"));
    } else {                              // ---- release edge
      digitalWrite(LED_BUILTIN, HIGH);
      Serial.print(F("release after "));
      Serial.print(now - pressStart);
      Serial.println(F(" ms"));
      if      (hit2) Serial.println(F("  -> ACTION: hold-5s (arm disconnect alarm)"));
      else if (hit1) Serial.println(F("  -> ACTION: hold-3s (high alert)"));
      else           Serial.println(F("  -> short press, no action bound yet"));
    }
  }

  if (btnStable) {
    uint32_t held = now - pressStart;
    if (!hit1 && held >= HOLD_1_MS) {
      hit1 = true;
      Serial.println(F("  3 s crossed"));
      buzz(120);
    }
    if (!hit2 && held >= HOLD_2_MS) {
      hit2 = true;
      Serial.println(F("  5 s crossed"));
      buzz(120); delay(120); buzz(120);
    }
  }
}
