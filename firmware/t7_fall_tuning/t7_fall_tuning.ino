/* ============================================================================
   NIGEHBAN — TEST 7: FALL & IMPACT TUNING RIG  (task F3.2 / F3.3)
   ----------------------------------------------------------------------------
   Board: Seeed XIAO nRF52840 Sense, "Seeed nRF52 Boards" core (NOT mbed).
   Wiring: NONE. The LSM6DS3TR-C is on the board.
   Library: Library Manager -> "Seeed Arduino LSM6DS3".
   Monitor: 115200 baud.

   ----------------------------------------------------------------------------
   WHAT THIS IS FOR

   Answering two questions the shipping firmware cannot answer, because the
   shipping firmware only ever tells you the one thing it decided:

       1. HOW HARD was that, in g?
       2. If it did NOT raise a fall -- WHICH STAGE rejected it, and by how much?

   Question 2 is the whole point. `nigehban_band_nrf52.ino` stays silent for a
   near miss, so "I dropped it and nothing happened" is indistinguishable from
   "I dropped it and the IMU is dead". This sketch narrates every stage, so a
   drop that does not fire tells you exactly which threshold to move and in
   which direction.

   Throw it at a wall, wear it and jump, roll off the bed with it on -- every one
   of those prints a verdict.

   ----------------------------------------------------------------------------
   IT RUNS THE REAL DETECTOR

   The constants and both state machines below are copied from
   `nigehban_band_nrf52/nigehban_band_nrf52.ino`, deliberately verbatim. A
   tuning rig that is "roughly the same" is worse than no rig at all: you would
   tune numbers that the band does not use, believe you were done, and ship the
   old behaviour.

   >>> IF YOU CHANGE A THRESHOLD HERE, CHANGE IT IN THREE PLACES: <<<
   >>>   1. nigehban_band_nrf52/nigehban_band_nrf52.ino                <<<
   >>>   2. nigehban-app/src/virtualBand.js  (FALL / IMPACT)           <<<
   >>>   3. here                                                       <<<
   The first two are what actually ship. This one only tells you the truth.

   The full protocol -- drop heights, surfaces, and the false-positive set that
   must stay silent -- is in docs/FALL_AND_ACCIDENT.md. Read that first; this
   sketch is the instrument, not the method.

   ----------------------------------------------------------------------------
   WHAT IT CANNOT TELL YOU

   Whether an `impact` becomes an ACCIDENT. That decision is not on the band and
   never will be: it needs the phone's GPS speed over the last 20 seconds, and
   an 11 g spike is furniture at walking pace and a crash at 45 km/h. This
   sketch reports "the band would send `impact`" and stops there, honestly.

   ----------------------------------------------------------------------------
   SERIAL COMMANDS  (type the letter, press Enter)

       h   this help
       r   reset the session peak
       c   raw CSV on/off  -- ms,g  at 100 Hz, for plotting a drop
       s   session summary

   PASS for this sketch = the numbers move sensibly and the verdicts match what
   you physically did. There is no "it works" line; it is a measuring tool.
   ========================================================================= */

#include <Adafruit_TinyUSB.h>   // required for `Serial` to link on this core
#include "LSM6DS3.h"
#include "Wire.h"

LSM6DS3 imu(I2C_MODE, 0x6A);

// ---------------------------------------------------------------------------
// THE SHIPPING THRESHOLDS. Copied verbatim -- see the header.
// ---------------------------------------------------------------------------
#define IMU_PERIOD_MS         10      // 100 Hz

// PEOPLE DO NOT FREE-FALL, so there are two routes in. See the .ino.
//   ROUTE A "it dropped"  free-fall -> impact (2.40 g) -> still 1.6 s
//   ROUTE B "it was hit"  impact (4 g) -> ended up at a different angle
//                         -> still 2.5 s.  No free-fall required.
#define FALL_FREEFALL_G       0.45f
#define FALL_FREEFALL_MIN_MS  70
#define FALL_IMPACT_G         2.40f
#define FALL_IMPACT_WINDOW_MS 1400
#define FALL_STILL_BAND_G     0.28f
#define FALL_STILL_MS         1600

#define FALL_HARD_G           4.00f
#define FALL_TILT_DEG         35.0f
#define FALL_STILL_SLOW_MS    2500
#define REST_ALPHA            0.02f
#define REST_SLOW_ALPHA       0.003f

#define IMPACT_G              8.00f
#define IMPACT_SETTLE_MS      1200

// The band suppresses repeats so one crash is not six buzzes. This rig does
// NOT: on a bench you want to see every attempt, including the three you did
// in a row. Told to you here so a difference in behaviour is never a mystery.
//   FALL_REFRACTORY_MS   15000
//   IMPACT_REFRACTORY_MS 10000

// ---------------------------------------------------------------------------
// TUNING-RIG ONLY. Nothing below ships.
// ---------------------------------------------------------------------------

// Anything above this starts a "shock" record. Far below IMPACT_G on purpose:
// the question is "how hard was that", and a throw that measures 5 g has to
// print 5 g rather than nothing at all. Walking is ~1.3 g, so this sits just
// above ordinary movement.
#define WATCH_G               1.60f

// A shock is over once it has been quiet this long. Long enough to keep a
// bounce, a tumble and the landing as ONE event -- reporting them separately
// would make a single throw look like three.
#define SHOCK_QUIET_MS        350

#define HEARTBEAT_MS          2000    // "still alive" line while nothing happens

// ------------------------------------------------------------------ state ---
bool  gImuOk  = false;
bool  gCsv    = false;

float gSessionPeak = 0;               // biggest |a| since boot or since 'r'
uint32_t gSessionPeakAt = 0;
uint16_t gShockCount = 0;
uint16_t gFallCount  = 0;
uint16_t gImpactCount = 0;

// ---- the shock recorder: "how hard was that" ------------------------------
bool     gInShock   = false;
float    gShockPeak = 0;
float    gShockRot  = 0;
uint32_t gShockFrom = 0;
uint32_t gShockQuietFrom = 0;
uint32_t gShockStillMs = 0;

// ---- the fall machine, mirroring the shipping one -------------------------
#define FS_IDLE      0
#define FS_FREEFALL  1
#define FS_IMPACT    2
uint8_t  gFallStage = FS_IDLE;
uint32_t gFallSince = 0;
uint32_t gFreefallMs = 0;
float    gFallPeak  = 0;
uint32_t gFallStillFrom = 0;
uint32_t gFallStillBest = 0;          // longest stillness seen this attempt
#define ROUTE_A 0
#define ROUTE_B 1
uint8_t  gFallRoute = ROUTE_A;
float    gPreX = 0, gPreY = 0, gPreZ = 0;
bool     gPreValid = false;

// ---------------------------------------------------------------- helpers ---
float gAx = 0, gAy = 0, gAz = 0;

float magnitudeG() {
  gAx = imu.readFloatAccelX();
  gAy = imu.readFloatAccelY();
  gAz = imu.readFloatAccelZ();
  return sqrtf(gAx * gAx + gAy * gAy + gAz * gAz);
}

// Gravity by low-pass, two speeds -- "where am I now" and "where was I before
// any of this started". Verbatim from the shipping firmware; the reason the
// second one has to be slow is that a topple lasts longer than the first one's
// memory, so sampled at the impact it already holds a posture halfway down.
float gRestX = 0, gRestY = 0, gRestZ = 0;
float gSlowX = 0, gSlowY = 0, gSlowZ = 0;
bool  gRestValid = false;

void restTick() {
  if (!gRestValid) {
    gRestX = gSlowX = gAx; gRestY = gSlowY = gAy; gRestZ = gSlowZ = gAz;
    gRestValid = true;
    return;
  }
  gRestX += (gAx - gRestX) * REST_ALPHA;
  gRestY += (gAy - gRestY) * REST_ALPHA;
  gRestZ += (gAz - gRestZ) * REST_ALPHA;
  gSlowX += (gAx - gSlowX) * REST_SLOW_ALPHA;
  gSlowY += (gAy - gSlowY) * REST_SLOW_ALPHA;
  gSlowZ += (gAz - gSlowZ) * REST_SLOW_ALPHA;
}

float tiltBetween(float ax, float ay, float az, float bx, float by, float bz) {
  float na = sqrtf(ax * ax + ay * ay + az * az);
  float nb = sqrtf(bx * bx + by * by + bz * bz);
  if (na < 0.1f || nb < 0.1f) return 0;
  float c = (ax * bx + ay * by + az * bz) / (na * nb);
  if (c > 1.0f) c = 1.0f;
  if (c < -1.0f) c = -1.0f;
  return acosf(c) * 57.2957795f;
}

float rotationDps() {
  float x = imu.readFloatGyroX();
  float y = imu.readFloatGyroY();
  float z = imu.readFloatGyroZ();
  return sqrtf(x * x + y * y + z * z);
}

/** A crude bar, because a column of numbers hides the shape of a drop. */
void bar(float g, float full) {
  int n = (int)(g / full * 24.0f);
  if (n > 24) n = 24;
  if (n < 0) n = 0;
  Serial.print('[');
  for (int i = 0; i < 24; i++) Serial.print(i < n ? '#' : ' ');
  Serial.print(']');
}

void help() {
  Serial.println(F("\n  ------------------------------------------------------------"));
  Serial.println(F("  NIGEHBAN T7 - fall & impact tuning rig"));
  Serial.println(F("  ------------------------------------------------------------"));
  Serial.println(F("  Wear it, or hold it, and try things. Every attempt is judged."));
  Serial.println(F(""));
  Serial.println(F("    h  help        r  reset peak"));
  Serial.println(F("    c  raw CSV     s  session summary"));
  Serial.println(F(""));
  Serial.println(F("  TWO ROUTES TO A FALL. People do not free-fall -- they topple --"));
  Serial.println(F("  so free-fall is evidence, not a requirement."));
  Serial.print(F("    A  it dropped: light <"));
  Serial.print(FALL_FREEFALL_G, 2);
  Serial.print(F("g for >="));
  Serial.print(FALL_FREEFALL_MIN_MS);
  Serial.print(F("ms -> impact >"));
  Serial.print(FALL_IMPACT_G, 2);
  Serial.print(F("g -> still "));
  Serial.print(FALL_STILL_MS);
  Serial.println(F("ms"));
  Serial.print(F("    B  it was hit: impact >"));
  Serial.print(FALL_HARD_G, 2);
  Serial.print(F("g -> angle moved >"));
  Serial.print((int) FALL_TILT_DEG);
  Serial.print(F("deg -> still "));
  Serial.print(FALL_STILL_SLOW_MS);
  Serial.println(F("ms"));
  Serial.print(F("  An IMPACT needs one thing: a spike over "));
  Serial.print(IMPACT_G, 2);
  Serial.println(F("g."));
  Serial.println(F(""));
  Serial.println(F("  THE USUAL SURPRISE: you picked it up. Let go and DO NOT TOUCH"));
  Serial.println(F("  IT for a full 2 seconds, or the stillness stage rejects it."));
  Serial.println(F("  ------------------------------------------------------------\n"));
}

void summary() {
  Serial.println(F("\n  ---- session ----"));
  Serial.print(F("  peak seen        : "));
  Serial.print(gSessionPeak, 2);
  Serial.print(F(" g  (at "));
  Serial.print(gSessionPeakAt / 1000.0F, 1);
  Serial.println(F(" s)"));
  Serial.print(F("  shocks recorded  : ")); Serial.println(gShockCount);
  Serial.print(F("  would-be falls   : ")); Serial.println(gFallCount);
  Serial.print(F("  would-be impacts : ")); Serial.println(gImpactCount);
  Serial.println(F("  -----------------\n"));
}

// ------------------------------------------------------------------ setup ---
void setup() {
  Serial.begin(115200);
  uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 3000) delay(10);

  // THE POWER GATE. The Sense can switch the IMU off entirely for low power,
  // and until this pin is HIGH, begin() fails on hardware that is perfectly
  // fine. Same trap as T4.
#ifdef PIN_LSM6DS3TR_C_POWER
  pinMode(PIN_LSM6DS3TR_C_POWER, OUTPUT);
  digitalWrite(PIN_LSM6DS3TR_C_POWER, HIGH);
  delay(10);
#else
  #warning "PIN_LSM6DS3TR_C_POWER undefined - wrong board? Must be XIAO nRF52840 SENSE."
#endif

  // ===========================================================================
  // SET THE RANGE, OR EVERY MEASUREMENT THIS SKETCH PRINTS IS A LIE.
  //
  // The accelerometer clips at its full-scale range and reports the clipped
  // value as though it were real. On a +/-2 g default, a drop, a clap and a car
  // crash all read "2.0 g" -- the numbers look plausible and are all the same,
  // and you would tune thresholds against a flat line.
  //
  // 16 g is this part's maximum. A real vehicle impact SATURATES it, so a
  // reading of 16.0 means "at least 16", never "exactly 16".
  // ===========================================================================
  imu.settings.accelRange      = 16;
  imu.settings.accelSampleRate = 104;
  imu.settings.gyroRange       = 2000;
  imu.settings.gyroSampleRate  = 104;

  gImuOk = (imu.begin() == 0);
  if (!gImuOk) {
    Serial.println(F("IMU: Device error."));
    Serial.println(F("  1. Board = 'Seeed XIAO nRF52840 Sense' (Sense, not plain)?"));
    Serial.println(F("  2. Power gate above actually compiled in?"));
    Serial.println(F("  3. 'Seeed Arduino LSM6DS3' installed?"));
    return;
  }

  Serial.println(F("IMU OK  (range 16 g, 104 Hz)"));
  help();
}

// ------------------------------------------------------------------- loop ---
void loop() {
  if (!gImuOk) { delay(1000); return; }

  // ---- serial commands ----------------------------------------------------
  while (Serial.available()) {
    char c = (char) Serial.read();
    if (c == 'h') help();
    else if (c == 's') summary();
    else if (c == 'r') {
      gSessionPeak = 0; gSessionPeakAt = 0;
      gShockCount = gFallCount = gImpactCount = 0;
      Serial.println(F("  peak and counters reset"));
    } else if (c == 'c') {
      gCsv = !gCsv;
      if (gCsv) Serial.println(F("ms,g"));
      else      Serial.println(F("  csv off"));
    }
  }

  static uint32_t last = 0;
  uint32_t now = millis();
  if (now - last < IMU_PERIOD_MS) return;
  last = now;

  float g = magnitudeG();
  bool  still = fabsf(g - 1.0f) < FALL_STILL_BAND_G;
  restTick();

  if (g > gSessionPeak) { gSessionPeak = g; gSessionPeakAt = now; }
  if (gCsv) { Serial.print(now); Serial.print(','); Serial.println(g, 3); }

  // =========================================================================
  // 1. THE SHOCK RECORDER -- "how hard was that?"
  //
  // Independent of the fall machine on purpose. Throwing the band at a wall
  // produces no free-fall stage worth the name and would otherwise print
  // nothing at all, which is the exact silence this sketch exists to remove.
  // =========================================================================
  if (!gInShock && g >= WATCH_G) {
    gInShock = true;
    gShockPeak = g;
    gShockRot = rotationDps();
    gShockFrom = now;
    gShockQuietFrom = 0;
    gShockStillMs = 0;
  } else if (gInShock) {
    if (g > gShockPeak) gShockPeak = g;
    float rot = rotationDps();
    if (rot > gShockRot) gShockRot = rot;
    if (still) gShockStillMs += IMU_PERIOD_MS;

    if (g < WATCH_G) {
      if (!gShockQuietFrom) gShockQuietFrom = now;
    } else {
      gShockQuietFrom = 0;
    }

    if (gShockQuietFrom && now - gShockQuietFrom >= SHOCK_QUIET_MS) {
      gInShock = false;
      gShockCount++;

      uint32_t dur = gShockQuietFrom - gShockFrom;
      Serial.println();
      Serial.print(F("  SHOCK  "));
      bar(gShockPeak, 16.0f);
      Serial.print(F("  peak "));
      Serial.print(gShockPeak, 2);
      Serial.print(F(" g   spin "));
      Serial.print((int) gShockRot);
      Serial.print(F(" deg/s   lasted "));
      Serial.print(dur);
      Serial.println(F(" ms"));

      if (gShockPeak >= 15.9f) {
        Serial.println(F("         NOTE: at or above 16 g the sensor is SATURATED."));
        Serial.println(F("         The real peak was higher; this is a floor, not a value."));
      }

      Serial.print(F("         impact threshold "));
      Serial.print(IMPACT_G, 2);
      Serial.print(F(" g -> "));
      if (gShockPeak >= IMPACT_G) {
        gImpactCount++;
        Serial.println(F("the band WOULD send `impact` to the phone."));
        Serial.println(F("         (the phone only calls it an ACCIDENT if you were"));
        Serial.println(F("          doing 25 km/h or more in the last 20 s)"));
      } else {
        Serial.print(F("below by "));
        Serial.print(IMPACT_G - gShockPeak, 2);
        Serial.println(F(" g. No `impact` sent."));
      }
    }
  }

  // =========================================================================
  // 2. THE FALL MACHINE -- and, when it says no, WHY it said no.
  // =========================================================================
  switch (gFallStage) {
    case FS_IDLE:
      if (g < FALL_FREEFALL_G) {
        gFallStage = FS_FREEFALL;
        gFallRoute = ROUTE_A;
        gFallSince = now;
        gFallPeak = g;
        Serial.print(F("  ..going light ("));
        Serial.print(g, 2);
        Serial.println(F(" g)  [route A: it dropped]"));
      } else if (g >= FALL_HARD_G) {
        // ROUTE B -- the topple. No free-fall, and there was never going to be
        // one: a person rotating to the floor keeps gravity on the wrist all
        // the way down. This is the route that catches a trip or a slump.
        gFallStage = FS_IMPACT;
        gFallRoute = ROUTE_B;
        gFallSince = now;
        gFallPeak  = g;
        gFreefallMs = 0;
        gFallStillFrom = 0;
        gFallStillBest = 0;
        gPreX = gSlowX; gPreY = gSlowY; gPreZ = gSlowZ;
        gPreValid = gRestValid;
        Serial.print(F("  ..hit hard with no free-fall ("));
        Serial.print(g, 2);
        Serial.println(F(" g)  [route B: a topple?]"));
      }
      break;

    case FS_FREEFALL:
      if (g < FALL_FREEFALL_G) break;                  // still falling
      gFreefallMs = now - gFallSince;
      if (gFreefallMs >= FALL_FREEFALL_MIN_MS) {
        gFallStage = FS_IMPACT;
        gFallSince = now;
        gFallPeak = g;
        gFallStillFrom = 0;
        gFallStillBest = 0;
        gPreX = gSlowX; gPreY = gSlowY; gPreZ = gSlowZ;
        gPreValid = gRestValid;
        Serial.print(F("  ..free-fall "));
        Serial.print(gFreefallMs);
        Serial.println(F(" ms  OK -- now waiting for an impact"));
      } else {
        gFallStage = FS_IDLE;
        Serial.print(F("  REJECTED at stage 1: went light for only "));
        Serial.print(gFreefallMs);
        Serial.print(F(" ms, needs >= "));
        Serial.print(FALL_FREEFALL_MIN_MS);
        Serial.println(F(" ms. (a flick of the wrist, not a fall)"));
      }
      break;

    case FS_IMPACT: {
      if (g > gFallPeak) gFallPeak = g;
      const float needG = (gFallRoute == ROUTE_B) ? FALL_HARD_G : FALL_IMPACT_G;
      const uint32_t needStill =
        (gFallRoute == ROUTE_B) ? FALL_STILL_SLOW_MS : FALL_STILL_MS;

      // Stillness is tracked from the moment we land, and the LONGEST run is
      // kept -- so a rejection can say how close it got rather than just "no".
      if (!still) {
        gFallStillFrom = 0;
      } else {
        if (gFallStillFrom == 0) gFallStillFrom = now;
        uint32_t run = now - gFallStillFrom;
        if (run > gFallStillBest) gFallStillBest = run;
      }

      if (gFallPeak < needG) {
        if (now - gFallSince > FALL_IMPACT_WINDOW_MS) {
          gFallStage = FS_IDLE;
          Serial.print(F("  REJECTED at stage 2: nothing hit hard enough. Best was "));
          Serial.print(gFallPeak, 2);
          Serial.print(F(" g, needs > "));
          Serial.print(needG, 2);
          Serial.println(F(" g."));
          Serial.println(F("             (you lowered your arm, or landed on something soft --"));
          Serial.println(F("              carpet roughly halves peak g, a duvet kills it)"));
        }
        break;
      }

      if (gFallStillFrom && now - gFallStillFrom >= needStill) {
        // Route B's second piece of evidence: did the wearer end up at a
        // different angle? A clap, a slammed door and a palm on a desk all
        // leave the arm where it started. Going to the floor does not.
        float tilt = 0;
        if (gFallRoute == ROUTE_B) {
          tilt = (gPreValid && gRestValid)
            ? tiltBetween(gPreX, gPreY, gPreZ, gRestX, gRestY, gRestZ) : 0;
          if (!gPreValid || tilt < FALL_TILT_DEG) {
            gFallStage = FS_IDLE;
            Serial.print(F("  REJECTED at stage 3b: hit hard ("));
            Serial.print(gFallPeak, 2);
            Serial.print(F(" g) and went still, but the wrist ended up at the same"));
            Serial.println(F(" angle it started at."));
            Serial.print(F("             Moved "));
            Serial.print((int) tilt);
            Serial.print(F(" deg, needs "));
            Serial.print((int) FALL_TILT_DEG);
            Serial.println(F(" deg."));
            Serial.println(F("             (a clap, a slammed door, a palm on a desk --"));
            Serial.println(F("              you did not change posture, so you did not fall)"));
            break;
          }
        }
        gFallStage = FS_IDLE;
        gFallCount++;
        Serial.println();
        Serial.println(F("  *** THIS WOULD RAISE A FALL ***"));
        Serial.print(F("      route "));
        Serial.print(gFallRoute == ROUTE_B ? F("B (topple, no free-fall)")
                                           : F("A (dropped)"));
        Serial.print(F(", free-fall "));
        Serial.print(gFreefallMs);
        Serial.print(F(" ms, impact "));
        Serial.print(gFallPeak, 2);
        Serial.print(F(" g"));
        if (gFallRoute == ROUTE_B) {
          Serial.print(F(", tilt "));
          Serial.print((int) tilt);
          Serial.print(F(" deg"));
        }
        Serial.print(F(", still for "));
        Serial.print(needStill);
        Serial.println(F(" ms."));
        Serial.println(F("      On the band: 5 buzzes, `fall` to the phone, and the"));
        Serial.println(F("      wearer has 45 s to answer before the family is told."));
        Serial.println();
      } else if (now - gFallSince > FALL_IMPACT_WINDOW_MS + needStill + 1000) {
        gFallStage = FS_IDLE;
        Serial.print(F("  REJECTED at stage 3: hit hard enough ("));
        Serial.print(gFallPeak, 2);
        Serial.print(F(" g) but never stayed still. Longest quiet run was "));
        Serial.print(gFallStillBest);
        Serial.print(F(" ms, needs "));
        Serial.print(needStill);
        Serial.println(F(" ms."));
        Serial.println(F("             (this is the one that catches you out: you picked"));
        Serial.println(F("              it up. Somebody who trips and walks on looks"));
        Serial.println(F("              exactly like this, which is why the stage exists)"));
      }
      break;
    }
  }

  // ---- proof of life ------------------------------------------------------
  // Only while nothing is happening, so it never interleaves with a verdict.
  static uint32_t beat = 0;
  if (!gInShock && gFallStage == FS_IDLE && !gCsv && now - beat > HEARTBEAT_MS) {
    beat = now;
    Serial.print(F("  idle  "));
    bar(g, 4.0f);
    Serial.print(F("  now "));
    Serial.print(g, 2);
    Serial.print(F(" g   session peak "));
    Serial.print(gSessionPeak, 2);
    Serial.println(F(" g"));
  }
}
