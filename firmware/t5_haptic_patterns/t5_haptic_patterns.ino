/* ============================================================================
   NIGEHBAN — TEST 5: WHICH HAPTIC PATTERN CAN YOU ACTUALLY FEEL?
   ----------------------------------------------------------------------------
   Same wiring as T2/T3. Nothing to change.

   Run this with the motor TAPED AGAINST YOUR WRIST, not held in your fingers.
   A coin ERM loose in the air shakes nothing; coupled to flesh it is several
   times stronger. If you only test it pinched between two fingers you will
   reject a motor that would have been fine.

   Two ERM facts that drive every pattern below:

     1. SPIN-UP. The motor needs ~50-80 ms to reach speed. Pulses shorter than
        that never develop real amplitude, so they feel weak no matter how many
        you chain. 100-150 ms is the shortest pulse worth using.

     2. ADAPTATION. Skin stops registering steady vibration within a few hundred
        ms. A 1500 ms continuous buzz does not feel stronger than a 500 ms one --
        it feels the same, for longer. Onsets are what you feel, so more edges
        beats more time.

   Each pattern announces itself on serial, then fires after a 1 s gap so you
   can attend to it. Note which numbers you can feel reliably WITHOUT looking.
   That number is your SOS confirmation pattern.
   ========================================================================= */

#include <Adafruit_TinyUSB.h>

#define PIN_MOTOR   1     // D1

void on(uint16_t ms)  { digitalWrite(PIN_MOTOR, HIGH); delay(ms); }
void off(uint16_t ms) { digitalWrite(PIN_MOTOR, LOW);  delay(ms); }

void pulses(uint8_t n, uint16_t onMs, uint16_t offMs) {
  for (uint8_t i = 0; i < n; i++) { on(onMs); off(i == n - 1 ? 0 : offMs); }
  digitalWrite(PIN_MOTOR, LOW);
}

void announce(const char *s) {
  Serial.println(s);
  delay(1000);              // gap so the label lands before the buzz
}

void setup() {
  pinMode(PIN_MOTOR, OUTPUT);
  digitalWrite(PIN_MOTOR, LOW);
  Serial.begin(115200);
  uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 3000) delay(10);
  Serial.println(F("T5: tape the motor to your wrist. Which can you feel?"));
  delay(2000);
}

void loop() {
  announce("[1] steady 1500 ms  (what you have now - the weakest option)");
  pulses(1, 1500, 0);
  delay(2500);

  announce("[2] 3 pulses, 120 on / 100 off");
  pulses(3, 120, 100);
  delay(2500);

  announce("[3] 5 pulses, 150 on / 90 off  <- usually the winner");
  pulses(5, 150, 90);
  delay(2500);

  announce("[4] rapid burst: 8 x 100 / 60");
  pulses(8, 100, 60);
  delay(2500);

  announce("[5] escalating: short, medium, long");
  on(120); off(100); on(250); off(100); on(500); off(0);
  delay(2500);

  announce("[6] double-burst, 400 ms apart  (distinct 'two things happened')");
  pulses(3, 130, 80);
  off(400);
  pulses(3, 130, 80);
  delay(3000);

  Serial.println(F("--- repeating ---\n"));
  delay(1500);
}
