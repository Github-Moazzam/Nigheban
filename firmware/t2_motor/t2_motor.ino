/* ============================================================================
   NIGEHBAN — TEST 2: HAPTICS
   ----------------------------------------------------------------------------
   Board: Seeed XIAO nRF52840 Sense.  USB powered, no battery.

   WIRING — vibration motor MODULE (the 3-pin board, silkscreen IN / VCC / GND).
   The module already carries the driver transistor, its base resistor and the
   flyback diode. Do NOT add the 2N2222 / 1k / 1N4148 from the BOM.

     module IN   -> XIAO D1
     module VCC  -> XIAO 3V3      (3V3, not 5V — see note below)
     module GND  -> XIAO GND
     100 uF electrolytic across the module's VCC and GND
        (long leg / unmarked side -> VCC, stripe side -> GND)

   Why 3V3 and not 5V: the final band runs off a LiPo through the XIAO's 3V3
   rail. There is no 5 V on battery. Test at the voltage you will ship at, or
   the bench result tells you nothing about the product.

   Pass = three distinct patterns you can feel, repeating, and the Serial
          Monitor line matches what your fingers feel.
   ========================================================================= */

#include <Adafruit_TinyUSB.h>   // required for `Serial` to link on this core

#define PIN_MOTOR   1     // D1 on the XIAO silkscreen (P0.03)

void buzz(uint16_t ms) {
  digitalWrite(PIN_MOTOR, HIGH);
  delay(ms);
  digitalWrite(PIN_MOTOR, LOW);
}

void setup() {
  pinMode(PIN_MOTOR, OUTPUT);
  digitalWrite(PIN_MOTOR, LOW);      // motor OFF before anything else

  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, HIGH);

  Serial.begin(115200);
  uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 3000) delay(10);

  Serial.println(F("T2: motor test. Hold the motor between two fingers."));
}

void loop() {
  Serial.println(F("[1] single short tick (150 ms)"));
  buzz(150);
  delay(1500);

  Serial.println(F("[2] double tap — the 'SOS sent' confirmation"));
  buzz(120); delay(120); buzz(120);
  delay(1500);

  Serial.println(F("[3] long alarm buzz (800 ms)"));
  buzz(1500);
  delay(2500);
}
