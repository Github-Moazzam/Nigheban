/* ============================================================================
   NIGEHBAN — TEST 4: ON-BOARD IMU BRING-UP  (task F3.1)
   ----------------------------------------------------------------------------
   Board: Seeed XIAO nRF52840 Sense, "Seeed nRF52 Boards" core (NOT mbed).
   Wiring: NONE. The LSM6DS3TR-C is on the board, on an internal I2C bus.

   Library: Library Manager -> search "Seeed Arduino LSM6DS3" -> install.

   THE GOTCHA: the Sense power-gates the IMU (P1.08) so it can be switched off
   for low power. If you do not drive that pin HIGH before imu.begin(), begin()
   fails and prints "Device error" on hardware that is perfectly fine. The
   skeleton in EXECUTION_PLAN.md section 8 is missing this line.

   Pass = "IMU OK", az ~1.00 g with the board flat on the desk, and |a| jumping
          well above 1 g when you shake it.
   ========================================================================= */

#include <Adafruit_TinyUSB.h>   // required for `Serial` to link on this core
#include "LSM6DS3.h"
#include "Wire.h"

LSM6DS3 imu(I2C_MODE, 0x6A);

void setup() {
  Serial.begin(115200);
  uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 3000) delay(10);

  // ---- power the IMU before talking to it -------------------------------
#ifdef PIN_LSM6DS3TR_C_POWER
  pinMode(PIN_LSM6DS3TR_C_POWER, OUTPUT);
  digitalWrite(PIN_LSM6DS3TR_C_POWER, HIGH);
  delay(10);                       // let it boot before the first I2C txn
#else
  #warning "PIN_LSM6DS3TR_C_POWER undefined - wrong board selected? Must be XIAO nRF52840 SENSE."
#endif

  if (imu.begin() != 0) {
    Serial.println(F("IMU: Device error."));
    Serial.println(F("  1. Board = 'Seeed XIAO nRF52840 Sense' (Sense, not plain)?"));
    Serial.println(F("  2. Power gate above actually compiled in?"));
    Serial.println(F("  3. If still failing, run an I2C scanner on BOTH Wire and"));
    Serial.println(F("     Wire1 and see which bus answers at 0x6A."));
  } else {
    Serial.println(F("IMU OK"));
    Serial.println(F("ax,ay,az,gx,gy,gz,mag"));
  }
}

void loop() {
  float ax = imu.readFloatAccelX();
  float ay = imu.readFloatAccelY();
  float az = imu.readFloatAccelZ();
  float gx = imu.readFloatGyroX();
  float gy = imu.readFloatGyroY();
  float gz = imu.readFloatGyroZ();

  // Magnitude is the signal the fall state machine actually keys off:
  // ~1.0 g at rest, dips toward 0 in free-fall, spikes hard on impact.
  float mag = sqrtf(ax*ax + ay*ay + az*az);

  // CSV so you can paste straight into a spreadsheet and plot a real fall.
  Serial.print(ax, 3); Serial.print(',');
  Serial.print(ay, 3); Serial.print(',');
  Serial.print(az, 3); Serial.print(',');
  Serial.print(gx, 1); Serial.print(',');
  Serial.print(gy, 1); Serial.print(',');
  Serial.print(gz, 1); Serial.print(',');
  Serial.println(mag, 3);

  delay(38);            // ~26 Hz, the resting rate from EXECUTION_PLAN.md:605
}
