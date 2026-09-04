/* ============================================================================
   NIGEHBAN — TEST 8: BATTERY LEVEL & CHARGE STATUS  (task F2.3)
   ----------------------------------------------------------------------------
   Board: Seeed XIAO nRF52840 Sense, "Seeed nRF52 Boards" core (NOT mbed).
   Monitor: 115200 baud.

   Wiring: a LiPo on the BAT+/BAT- pads on the underside of the XIAO. This is
   the ONE sketch in this folder that needs the cell -- every other test here
   runs on USB alone and the README says "no battery on the breadboard". You
   cannot test a battery gauge without a battery. Check polarity before it
   touches the pads; they are not keyed.

   Answers the two questions the band has to answer:
       1. Is the charger actually running?   -> ~CHG from the BQ25100
       2. How full is the cell?              -> divider on P0.31 + LiPo curve

   Pass = on battery alone, mv sits somewhere in 3300-4200 and pct is plausible;
          plug USB in and "chg" flips to yes within a second; unplug and it
          flips back. Meter the cell and the mv column should agree -- if it
          does not, that is the calibration below, not a failure.

   ----------------------------------------------------------------------------
   WHERE THE CHARGE BIT COMES FROM

   The BQ25100 charger's open-drain ~CHG output -- the same signal that drives
   the orange charge LED. variant.h names HICHG but not this pin, so the place
   it is written down is the pin map in variant.cpp:

       13, // D22 is P0.13 (HICHG)
       17, // D23 is P0.17 (~CHG)     <- this one

   Active LOW: pulled LOW while the charger is pushing current, released when it
   is not. Open drain, so it needs a pull-up to read as anything at all --
   hence INPUT_PULLUP below. Read it without one and you get noise that looks
   like a flickering charger.

   ----------------------------------------------------------------------------
   THREE THINGS THAT LOOK LIKE BUGS AND ARE NOT

   1. A FULL BATTERY READS EXACTLY LIKE AN UNPLUGGED ONE. ~CHG only says
      "current is flowing". When the cell tops off, the charger terminates and
      the line goes HIGH with USB still connected. Use mv to tell them apart:
      ~4.15 V and not charging = full; 3.7 V and not charging = on battery.

   2. WHILE CHARGING, pct READS HIGH. Charge current lifts terminal voltage
      above the cell's resting voltage. The number is inflated for as long as
      the charger is on and settles a few minutes after it stops. Never
      calibrate while charging.

   3. NO CELL FITTED + USB = "chg" FLICKERING. With nothing to charge, the
      charger starts, sees full, terminates, sags, restarts. That oscillation
      means "no battery", not a broken pin.

   Charge current is 50 mA: initVariant() leaves HICHG (D22) as INPUT, which is
   the low setting. Driving D22 LOW selects 100 mA. This sketch does not touch
   it -- 50 mA is the right rate for the small cell the band ships with.

   ----------------------------------------------------------------------------
   IF mv READS BIMODAL, THE ADC IS THE FAULT, NOT THE BATTERY

   Two tight clusters roughly 10% apart, flipping every second or two, with no
   values in between -- 3693 mv one line, 4071 the next, back again. That is the
   SAADC acquisition time, not the cell: see the block above batteryBegin(). It
   is fixed here with analogSampleTime(40). The same defect is in the shipping
   firmware's batteryBegin(), which is why the app's percentage jumps around.

   Send 't' for a 20 Hz raw trace to tell an electrical effect from an ADC one:
   a real cycling voltage draws a slow square wave, dozens of samples per level;
   an ADC artefact jumps between adjacent samples with no time structure.

   ----------------------------------------------------------------------------
   CALIBRATION -- WHAT THIS SKETCH IS ACTUALLY FOR

   VBAT_DIVIDER_COMP below is the nominal 1M/510k ratio, not a measured one, and
   the shipping firmware carries the same unverified number with a "VERIFY" on
   it. Everything downstream rides on that constant: the app's low-battery
   warning and the demo-day "is it charged?" glance.

   With USB unplugged and the band idle, meter the cell directly and scale:

       new COMP = 2.961 * (metered mV / printed mv)

   The raw ADC average is printed alongside so the arithmetic can be redone from
   a scrollback without re-flashing. Put the result in BOTH places: here and
   nigehban_band_nrf52/nigehban_band_nrf52.ino.
   ========================================================================= */

#include <Adafruit_TinyUSB.h>   // required for `Serial` to link on this core

// D23 = P0.17 = ~CHG. No macro for it in variant.h; see the pin map above.
#ifndef PIN_CHG_STATUS
#define PIN_CHG_STATUS      (23)
#endif

// ---- copied from nigehban_band_nrf52.ino, deliberately verbatim ------------
// A gauge that is "roughly the same" as the shipping one tells you nothing
// about the shipping one. IF YOU CHANGE EITHER OF THESE, CHANGE THEM THERE TOO.
#define VBAT_MV_PER_LSB     (3000.0F / 4096.0F)  // AR_INTERNAL_3_0, 12-bit
#define VBAT_DIVIDER_COMP   (2.961F)             // 1M / 510k tap -- VERIFY

#define SAMPLES             8                    // cheap average, as shipped
#define PRINT_MS            1000
#define TRACE_MS            50                   // 't' mode: 20 Hz raw counts

// ===========================================================================
// DO NOT "OPTIMISE" VBAT_ENABLE. IT WILL DESTROY THE BOARD.
//
// The divider is  BAT+ -- 1M -- P0.31 -- 510k -- P0.14, so P0.14 is its BOTTOM
// leg. Driving it LOW completes the path and is what puts a safely divided
// voltage on P0.31. Set it HIGH, or leave it high-Z as an INPUT, and there is
// no division at all: P0.31 floats up toward BAT+ through the 1M. While
// charging that is ~4.2 V against a 3.6 V absolute maximum on the pin, and the
// pin is permanently destroyed.
//
// initVariant() in the core hands this sketch the pin already HIGH. Driving it
// LOW in setup() is not an optimisation, it is the fix -- and it stays LOW.
// The drain that tempts you to gate it is 4.2 V / 1.51 M = 2.8 uA, under 1.5%
// of the 200-400 uA budget in F4.3.
// ===========================================================================
// ---------------------------------------------------------------------------
// THE ACQUISITION TIME IS NOT OPTIONAL. Without analogSampleTime(40) below,
// this divider CANNOT be read reliably -- you get two stable clusters ~10%
// apart and no values in between.
//
// The tap's source impedance is 1M || 510k = 338 kOhm. The core defaults the
// SAADC acquisition time to 3 us:
//
//     wiring_analog_nRF52.c:33
//     static uint32_t saadcSampleTime = SAADC_CH_CONFIG_TACQ_3us;
//
// and Nordic rate 3 us for a source of at most 10 kOhm. We are 34x over that.
// Worse, analogRead() disables the SAADC again on the way out
// (wiring_analog_nRF52.c:226), so every conversion restarts from an unsettled
// sample-and-hold and the result depends on what the previous one left behind.
// That history dependence is what makes the error bimodal rather than noisy --
// and an 8-sample software average cannot fix it, because all 8 samples sit on
// the same side of it.
//
//     TACQ    max source resistance (nRF52840 spec)
//      3 us     10 k     <- the core's default
//     10 us    100 k
//     20 us    400 k
//     40 us    800 k     <- what 338 k needs
//
// analogOversampling(16) then hardware-averages 16 conversions per read, and
// analogCalibrateOffset() trims the SAADC's own offset. Both are free here.
// ---------------------------------------------------------------------------
void batteryBegin() {
  pinMode(VBAT_ENABLE, OUTPUT);
  digitalWrite(VBAT_ENABLE, LOW);        // LOW enables the divider -- see above
  analogReference(AR_INTERNAL_3_0);
  analogReadResolution(12);
  analogSampleTime(40);                  // 338k source -- see the table above
  analogOversampling(16);                // hardware burst average
  delay(1);

  // Order matters. analogCalibrateOffset() calibrates against whatever gain and
  // reference are currently in CH[0].CONFIG, and the core only writes that
  // register inside analogRead(). So take a throwaway read first to install our
  // settings, calibrate, then throw one more away.
  (void)analogRead(PIN_VBAT);
  analogCalibrateOffset();
  (void)analogRead(PIN_VBAT);
}

// Averaged raw counts. Returned as a float so the calibration arithmetic in the
// header can be redone from the log without re-flashing.
float batteryRawAdc() {
  uint32_t sum = 0;
  for (uint8_t i = 0; i < SAMPLES; i++) sum += analogRead(PIN_VBAT);
  return sum / (float)SAMPLES;
}

uint16_t batteryMilliVolts(float raw) {
  return (uint16_t)(raw * VBAT_MV_PER_LSB * VBAT_DIVIDER_COMP);
}

// Piecewise LiPo curve, copied from the shipping firmware. A linear 3.3-4.2 V
// map reads ~50% for most of the discharge and then falls off a cliff, which
// trains the wearer to ignore it.
uint8_t batteryPercent(uint16_t mv) {
  if (mv >= 4150) return 100;
  if (mv >= 4000) return 85 + (mv - 4000) * 15 / 150;
  if (mv >= 3850) return 65 + (mv - 3850) * 20 / 150;
  if (mv >= 3700) return 40 + (mv - 3700) * 25 / 150;
  if (mv >= 3550) return 15 + (mv - 3550) * 25 / 150;
  if (mv >= 3300) return      (mv - 3300) * 15 / 250;
  return 0;
}

bool isCharging() {
  return digitalRead(PIN_CHG_STATUS) == LOW;    // ~CHG is active LOW
}

void printBar(uint8_t pct) {
  uint8_t filled = pct / 5;                     // 20 cells
  Serial.print('[');
  for (uint8_t i = 0; i < 20; i++) Serial.print(i < filled ? '#' : ' ');
  Serial.print(']');
}

bool     gWasCharging = false;
uint32_t gNextPrint   = 0;
bool     gTrace       = false;      // 't' -- 20 Hz raw counts, no formatting

// Send 't' to dump raw counts at 20 Hz. This is the "is the voltage really
// moving, or is the ADC lying to me" test: a physical effect (a charger cycling
// its battery-detect, an intermittent cell) draws a slow square wave with
// dozens of samples per level, while an ADC settling artefact jumps between
// adjacent samples with no time structure at all.
void serviceCommands() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == 't') {
      gTrace = !gTrace;
      gNextPrint = millis();
      Serial.println(gTrace ? F("-- trace on: raw,mv @20Hz. 't' to stop.")
                            : F("-- trace off."));
    } else if (c == 'h') {
      Serial.println(F("t = toggle 20 Hz raw trace, h = this help"));
    }
  }
}

void setup() {
  Serial.begin(115200);
  uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 3000) delay(10);   // don't hang on battery

  batteryBegin();
  pinMode(PIN_CHG_STATUS, INPUT_PULLUP);   // open drain -- needs the pull-up

  pinMode(LED_GREEN, OUTPUT);
  digitalWrite(LED_GREEN, HIGH);           // XIAO LEDs are ACTIVE LOW: HIGH = off

  gWasCharging = isCharging();

  Serial.println(F("T8: battery level + charge status."));
  Serial.println(F("Charge current 50 mA (variant default; D22 LOW for 100 mA)."));
  Serial.println(F("Green LED = charging. Columns: mv, pct, bar, chg, raw adc."));
  Serial.println(F("Send 't' for a 20 Hz raw trace, 'h' for help."));
  Serial.println();
}

void loop() {
  serviceCommands();
  bool charging = isCharging();

  // Edge first, so plugging the cable in is timestamped rather than waiting out
  // the next print tick. This is the line to watch when you plug USB in.
  if (charging != gWasCharging) {
    Serial.print(F("  >>> charger "));
    Serial.print(charging ? F("STARTED") : F("STOPPED"));
    Serial.print(F("   at "));
    Serial.print(millis() / 1000.0F, 1);
    Serial.println(F(" s"));
    gWasCharging = charging;
    gNextPrint = millis();                 // and reprint the numbers now
  }

  digitalWrite(LED_GREEN, charging ? LOW : HIGH);

  uint32_t now = millis();
  if ((int32_t)(now - gNextPrint) < 0) return;

  // Trace: one conversion per sample, no software averaging. The hardware is
  // already oversampling 16x, and averaging further in software here would
  // blur the very transitions this mode exists to show.
  if (gTrace) {
    gNextPrint = now + TRACE_MS;
    uint16_t r = analogRead(PIN_VBAT);
    Serial.print(r);
    Serial.print(',');
    Serial.println(batteryMilliVolts(r));
    return;
  }

  gNextPrint = now + PRINT_MS;

  float    raw = batteryRawAdc();
  uint16_t mv  = batteryMilliVolts(raw);
  uint8_t  pct = batteryPercent(mv);

  Serial.print(F("mv "));   Serial.print(mv);
  Serial.print(F("  "));
  if (pct < 100) Serial.print(' ');
  if (pct < 10)  Serial.print(' ');
  Serial.print(pct);          Serial.print(F("%  "));
  printBar(pct);
  Serial.print(F("  chg "));  Serial.print(charging ? F("yes") : F("no "));
  Serial.print(F("  adc "));  Serial.print(raw, 1);

  // The readings that are easy to misread -- see the header.
  if      (charging)   Serial.print(F("   (pct reads high while charging)"));
  else if (mv >= 4150) Serial.print(F("   (full, or charge terminated)"));
  else if (mv <  3300) Serial.print(F("   (flat -- or no cell fitted)"));
  Serial.println();
}
