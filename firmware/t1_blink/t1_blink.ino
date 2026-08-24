/* ============================================================================
   NIGEHBAN — TEST 1: TOOLCHAIN
   ----------------------------------------------------------------------------
   Board: Seeed XIAO nRF52840 Sense.  NO WIRING AT ALL — USB only.

   Purpose: prove the board package, the port and the upload path work BEFORE
   any hardware is attached. If this does not blink, nothing downstream is
   worth debugging.

   Pass = onboard LED blinks red ~1 Hz, and Serial Monitor @115200 prints
          a line every second.
   ========================================================================= */

// REQUIRED on the Seeed/Adafruit nRF52 core. USB CDC lives in a separate
// library here, so without this include `Serial` does not link:
//   undefined reference to `Adafruit_USBD_CDC::begin(unsigned long)'
// It ships with the core — nothing to install.
#include <Adafruit_TinyUSB.h>

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, HIGH);   // XIAO's RGB LED is ACTIVE LOW: HIGH = off

  Serial.begin(115200);
  // Do NOT use bare `while (!Serial)` — it hangs forever on battery power.
  uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 3000) delay(10);

  Serial.println(F("T1: XIAO nRF52840 alive."));
}

void loop() {
  digitalWrite(LED_BUILTIN, LOW);    // on
  delay(500);
  digitalWrite(LED_BUILTIN, HIGH);   // off
  delay(500);
  Serial.println(F("tick"));
}
