/**
 * HOW FAST WAS THIS PERSON MOVING WHEN THEY WERE HIT.
 *
 * The band measures an impact and cannot say what it was. On a wrist, 11 g is a
 * crash, a clap, a door, or a hand put down hard on a table, and no amount of
 * cleverness in the firmware separates those -- the accelerometer genuinely
 * cannot tell. What separates them is one fact the band has no way to know and
 * this file does: an 11 g spike at walking pace is furniture, and the same
 * spike ten seconds into a 45 km/h ride is a road accident.
 *
 * So this is the other half of the detector. It keeps a short history of how
 * fast the phone has been travelling, and `classifyImpact` is where that
 * history turns a measurement into a decision.
 *
 * ---------------------------------------------------------------------------
 * WHY THE STOP IS NOT THE TRIGGER
 *
 * The obvious design is "travelling, then a bang, then stopped dead -- that is
 * a crash". It is obvious and it is wrong, in the direction that costs a life.
 *
 * A car that is hit does not reliably stop. It spins, it is pushed down the
 * road, it rolls, it carries on with a concussed driver still holding the
 * wheel, it is shunted into traffic by whatever hit it. A motorbike goes down
 * and slides forty metres. If the detector waits for the speed to reach zero,
 * every one of those is a crash it decides did not happen -- silently, with
 * nobody ever told the question was even asked.
 *
 * So the trigger is the IMPACT AT SPEED, on its own. The stop is used only to
 * decide how long to wait for an answer and what to call the thing in the
 * message. Coming to a halt is corroboration; not coming to a halt is not
 * evidence of anything.
 *
 * ---------------------------------------------------------------------------
 * WHY MOVING AGAIN *DOES* CANCEL, AND WHAT IT HAS TO LOOK LIKE
 *
 * The mirror of that worry is the pothole: a rider hits one at 50 km/h, the
 * wrist sees 12 g, and they ride on perfectly fine. Asking them to answer a
 * check-in is asking somebody to tap a wristband one-handed at speed, which is
 * worse than the false alarm it prevents. So resumed travel does stand the
 * question down.
 *
 * But "moving" is not the test, because a wreck moves. The test is
 * RESUME_STABLE_MS of CONTINUOUS travel above VEHICLE_KMH with no further
 * impact -- because a vehicle held at a steady road speed for twenty unbroken
 * seconds is a vehicle somebody conscious is driving. A car spinning, coasting,
 * rolling or being pushed is losing speed the whole time and breaks the run;
 * so does a bike sliding down the road; so does a second impact. The rule is
 * deliberately about *sustained and coherent* motion rather than about the
 * speedometer being off zero, and that is the entire difference between it and
 * the naive version.
 *
 * If the run breaks, the question stays open and the deadline the server is
 * holding does the rest.
 */

import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';

let Location = null;
try { Location = require('expo-location'); } catch { /* no position available */ }

// ---------------------------------------------------------------- thresholds ---

/**
 * Above this, treat the wearer as being in or on a vehicle.
 *
 * 25 km/h is under a moped and over a sprint. A very fast cyclist and a
 * sprinting athlete can both touch it, which is a deliberate choice: somebody
 * who takes a hard impact at 25 km/h under their own power has come off a
 * bicycle, and that is a question worth asking too. Being wrong here costs one
 * check-in nobody needed; being wrong the other way costs the whole feature.
 */
export const VEHICLE_KMH = 25;

/** Below this, treat the vehicle as stopped. Not zero: a parked GPS fix drifts. */
export const STOP_KMH = 5;

/**
 * How far back a MEASURED speed still counts as "just now".
 *
 * Twenty seconds at 45 km/h is a quarter of a kilometre, which is close enough
 * to be the same journey and short enough that the number still describes what
 * the wearer was actually doing.
 *
 * This window is deliberately NOT the whole answer to "were they travelling",
 * and an earlier version of this comment claimed it was -- it argued that
 * twenty seconds had to cover a GNSS dropout, when a tunnel or a flyover
 * routinely swallows longer than that. Stretching this constant to cover them
 * would have been the wrong repair: it would make a stale reading masquerade as
 * a fresh one everywhere else. The journey latch below carries the dropout
 * case instead, and this stays honest about what was measured and when.
 */
export const SPEED_MEMORY_MS = 20000;

/** Continuous travel that stands an accident question down. See the header. */
export const RESUME_STABLE_MS = 20000;

/**
 * How long the wearer has to answer, by what fired. MUST match
 * INCIDENT_WINDOW_S in nigehban_server.py -- the server's number is the one
 * that actually escalates, and this one only sizes the progress bar until the
 * server's answer arrives. A mismatch is a countdown that visibly jumps.
 *
 * Both are shorter than the 90 s a parent's check-in gets, because these are
 * answered by somebody who has just been hit. Accident is the shorter of the
 * two: it is the one with traffic still coming.
 */
export const INCIDENT_WINDOW_S = { fall: 45, accident: 30 };

/** Samples older than this are dropped outright. */
const HISTORY_MS = 60000;

// ---- how hard the sampling works -------------------------------------------
//
// ONE WATCH, FLAT OUT, FROM THE MOMENT IT IS ARMED.
//
// >>> THIS IS THE TEST SETTING. It is deliberately the most expensive thing
// >>> this app does, and it is meant to be walked back once the readings are
// >>> trusted. See the note at the bottom of this block.
//
// What was here was adaptive: a cheap 15 s Balanced fix that only opened up to
// real GNSS after it had already seen 25 km/h. That saved 30-50 mA and it made
// the feature both untestable and partly self-defeating:
//
//   - The cheap fixes are exactly the ones that carry no usable speed, so the
//     watch needed a speed reading in order to start asking for speed
//     readings. On a phone where the coarse provider answered every request,
//     the fast watch never opened for the whole journey.
//   - Nothing below vehicle speed was ever measured at all, so there was no way
//     to check the speedometer short of driving. You cannot verify a
//     speedometer by walking across a room if it only wakes up in a car.
//   - A 15 s cadence behind a readout that ticks at 1 Hz looks like a frozen
//     display, which is indistinguishable from GPS that is not working.
//
// BestForNavigation (set in the hook, where `Location` is in scope) asks
// Android for PRIORITY_HIGH_ACCURACY with no update-distance floor, which is
// what gets GNSS Doppler -- the only source that reports a real speed at
// walking pace.
//
// TO PUT THE BATTERY BACK: restore the two-tier watch from this file's git
// history (`git log -p -- nigehban-app/src/motion.js`), but keep the noteFix
// repair below -- the adaptive version cannot work without it.
const WATCH_OPTS = {
  timeInterval: 1000,
  distanceInterval: 0,
};

const MPS_TO_KMH = 3.6;

// ------------------------------------------------------------- the history ---

/**
 * Module scope, not a ref, and for the same reason band.js keeps its link
 * there: the samples have to survive Android destroying the React tree. An
 * impact arriving three seconds after the activity was recycled must still find
 * the speed history that gives it meaning, and a history that resets on mount
 * would be blank at exactly the wrong moment.
 */
let samples = [];        // { at, kmh } newest last
let lastImpactAt = 0;    // breaks the resume run -- see noteImpact()

// ---- am I in a vehicle right now? ------------------------------------------
//
// THE CASE THIS EXISTS FOR: a driver, hands on the wheel, hit at speed.
//
// There is no free-fall in that, so the band's fall machine never sees it and
// the whole thing rests on `impact` plus "were they travelling". And the naive
// version of that question -- "was there a GPS fix above 25 km/h in the last
// twenty seconds" -- fails exactly where it must not.
//
// A phone loses GNSS for tens of seconds at a time under a flyover, in a
// tunnel, in a multi-storey, between tall buildings, in heavy rain. Those are
// not incidental places. They are where people crash. And with the trailing
// window alone, a driver who enters an underpass at 60 km/h and is hit
// twenty-five seconds later has no recent fix, so `wasTravelling` is false, the
// impact is filed as furniture, and NOTHING HAPPENS -- silently, with no error
// anywhere, in the exact scenario the feature was built for.
//
// The fix is the same principle the resume rule already uses: **absence of
// fixes is not evidence of stopping.** Seeing road speed latches "in a
// journey", and only two things unlatch it -- positively observing a real stop
// for JOURNEY_STOP_MS, or going so long with no fixes at all that claiming to
// be in a car is no longer honest.
let journeyFrom = 0;     // when road speed was last actually seen; 0 = not driving
let stoppedSince = 0;    // when we first positively observed a stop

// Long enough that ordinary driving does not end a journey -- a red light, a
// level crossing, a queue at a toll plaza, a petrol stop. Being rear-ended
// while stationary at a light is a real accident and has to stay covered, so
// this is deliberately generous. What it is meant to catch is parking.
const JOURNEY_STOP_MS = 180000;    // 3 minutes stationary = the journey is over

// And a ceiling for the blind case, because "no fixes" cannot mean "still
// driving" forever: a phone that lost signal and was then switched off and put
// in a drawer would otherwise claim to be in a car all week, and every knock it
// took would open an accident check-in.
const JOURNEY_BLIND_MS = 300000;   // 5 minutes with no fix at all = give up

/**
 * Why the watch is not running, if it is not.
 *
 * Accident detection has a silent failure mode that nothing else in this app
 * has: with no position fixes, `wasTravelling` is false, every impact is
 * classified as furniture, and the feature is completely off while looking
 * exactly like a feature that is on and simply has nothing to report. Location
 * permission revoked from Settings, the system Location toggle switched off, a
 * phone with no GNSS -- all of them land here and none of them produce an
 * error anywhere the wearer would see one.
 *
 * So the reason is kept, and `speedWatchStatus()` is what the Band console
 * renders. It is the same principle as band.js surfacing a failed notify
 * subscribe rather than showing "connected" over a dead link.
 */
let watchError = null;

export function speedWatchStatus(now = Date.now()) {
  const ctx = speedContext(now);
  return {
    error: watchError,
    /** Can an impact be classified as an accident at all right now? */
    armed: !watchError && ctx.known,
    /**
     * What the last fix actually was, before any interpretation -- the chip's
     * raw number, the accuracy, and which of the three paths in `noteFix` it
     * took. The console renders this verbatim.
     *
     * A speed readout alone cannot be debugged on a phone in a car: "0 km/h"
     * is the same pixel whether the chip measured a standstill, declined to
     * answer, or was never asked. This is the difference, in words.
     */
    fix: lastNote ? { ...lastNote, ageMs: now - lastNote.at } : null,
    /** How many speed samples are in the history behind the reading. */
    samples: samples.length,
    ...ctx,
  };
}

function trim(now) {
  if (samples.length && now - samples[0].at > HISTORY_MS) {
    samples = samples.filter((s) => now - s.at <= HISTORY_MS);
  }
}

/**
 * Record a fix. Exported so the same history can be fed from anywhere a
 * position turns up -- the foreground watch below today, the background task
 * tomorrow -- without two of these existing.
 *
 * A null or negative `speed` is Android saying it does not know, which is not
 * the same as zero and must never be stored as zero: a phone with no speed
 * reading would otherwise look permanently stopped, and every impact would be
 * classified as one that happened at a standstill.
 */
export function noteSpeed(speedMps, at = Date.now()) {
  if (speedMps == null || !(speedMps >= 0)) return;
  const kmh = speedMps * MPS_TO_KMH;

  // An ordered insert, not a push. Four callers feed this history now -- the
  // speed watch, the Home screen's own watch, the background service and the
  // heartbeat's last-known read -- and the last two read the OS cache, which
  // can hand back a fix stamped earlier than one already stored. `speedContext`
  // treats the final element as "now", so one out-of-order push would present a
  // stale reading as the live one.
  const newest = !samples.length || at >= samples[samples.length - 1].at;
  if (newest) {
    samples.push({ at, kmh });
  } else {
    let i = samples.length;
    while (i > 0 && samples[i - 1].at > at) i--;
    samples.splice(i, 0, { at, kmh });
  }
  trim(samples[samples.length - 1].at);

  // ---- the journey latch ---------------------------------------------------
  //
  // See `inJourney` below. Updated here, on real fixes only, because the whole
  // point of it is that NOT getting a fix must never look like stopping.
  //
  // Only a sample that is genuinely the newest may move it: a late cached fix
  // must not re-open a journey that a newer fix has already closed.
  if (!newest) return;
  if (kmh >= VEHICLE_KMH) {
    journeyFrom = at;
    stoppedSince = 0;
  } else if (kmh <= STOP_KMH) {
    if (!stoppedSince) stoppedSince = at;
    else if (at - stoppedSince >= JOURNEY_STOP_MS) journeyFrom = 0;
  } else {
    // Between 5 and 25 km/h. Crawling in traffic, or being pushed along.
    // Neither confirms nor ends a journey, so it clears the stop timer without
    // extending the latch -- a car inching forward is not parked.
    stoppedSince = 0;
  }
}

/** An impact happened. Breaks any resume run in progress. */
export function noteImpact(at = Date.now()) {
  lastImpactAt = at;
}

// ---- the second source of speed, and why there has to be one ---------------
//
// `coords.speed` is the GNSS chip's own Doppler measurement and it is the good
// one: direct, instantaneous, accurate to a fraction of a km/h, and it works at
// walking pace. It is also, on most fixes, NOT THERE -- and the way it is not
// there is a trap that this code fell into for three releases.
//
// ANDROID DOES NOT REPORT AN ABSENT SPEED AS ABSENT. IT REPORTS IT AS ZERO.
//
// `android.location.Location` carries speed alongside a `hasSpeed()` flag, and
// `getSpeed()` returns 0.0f when that flag is false. expo-location passes the
// number straight through without consulting the flag
// (LocationResults.kt: `speed = location.speed.toDouble()`), so on Android
// `coords.speed` is NEVER null. iOS is the opposite convention -- CLLocation
// reports -1 for "no reading" -- and the old `speed == null` guard here was
// written against that one.
//
// The cost of the confusion was total, and silent, in both directions:
//
//   - Every fix without a real speed was stored as a genuine 0 km/h sample.
//     The live readout flickered between the true speed and zero, and an
//     impact landing on one of those zeros was described to the wearer's family
//     as "the vehicle stopped dead".
//   - The whole distance-between-fixes fallback below became unreachable on
//     Android, because it sits behind "did the chip decline to answer" and the
//     chip appeared to answer every single time.
//
// So the test is now `speed > 0`, and a zero is treated as the non-answer it
// usually is -- corroborated against the positions before it is believed.
//
// When the chip says nothing, the distance between fixes over the time between
// them answers instead. Still GPS -- two positions, not dead reckoning.
//
// It is NOT integrated from the accelerometer, and never will be. Velocity from
// a wrist IMU means double-integrating a noisy signal, and the error compounds
// so quickly that it is confidently wrong within seconds. A detector that
// believes a made-up speed is worse than one that admits it does not know.

/** Recent positions, oldest first. The baseline for the derived speed. */
let fixes = [];

/**
 * What the most recent fix produced, in full, for the Band console.
 *
 * { at, kmh, source, raw, acc, movedM?, dtS?, why? } where `source` is one of
 * 'chip' | 'derived' | 'still' | 'none'.
 */
let lastNote = null;

/** How far back a position is still usable as a baseline. */
const FIX_MEMORY_MS = 60000;

// The baseline widens rather than being fixed at "the previous fix", and that
// is the difference between a speedometer that works when walking and one that
// does not. At a 1 s cadence a person on foot covers about 1.4 m, which is far
// inside the uncertainty of any fix -- so measured against the previous fix
// alone, walking is indistinguishable from standing still and reads as zero.
// Measured against the newest fix that is FURTHER AWAY THAN THE UNCERTAINTY,
// it reads as walking. Under 1 s there is nothing to measure; beyond 30 s the
// straight line between two points stops describing the route taken.
const DERIVE_MIN_S = 1;
const DERIVE_MAX_S = 30;

// And movement has to BEAT the uncertainty, not merely tie with it.
//
// `accuracy` is a confidence radius, so a phone lying still on a table scatters
// its fixes across roughly that radius -- which means two of them can sit a
// full diameter apart while nothing has moved at all. Requiring only "further
// apart than the accuracy" therefore reads stationary GPS wander as motion, and
// with a widening baseline it will always eventually find two samples that
// qualify. Measured against a real still phone this produced a confident
// 11 km/h out of nothing, which is how a parked car arms crash detection.
//
// Doubling it is what separates the two: wander oscillates inside the radius,
// while somebody actually travelling keeps getting further away.
const DERIVE_SLOP_K = 2;
/** A floor, for a fix that claims an accuracy it has not earned. */
const DERIVE_MIN_M = 8;

// A standstill has to stay recordable -- `stopped` and the journey latch both
// depend on positively observing one -- but "not moving" is a claim, and a fix
// that is uncertain by half a street cannot support it. So a zero is believed
// only from a fix precise enough to mean it, after long enough to be sure.
const STILL_MIN_S = 5;
const STILL_MAX_ACC_M = 25;

/** Above this it is a bad fix or a jump between providers, not a speed. */
const MAX_PLAUSIBLE_KMH = 300;

const EARTH_M = 6371000;
/** Metres between two fixes. Equirectangular -- exact enough at these ranges. */
function metresBetween(a, b) {
  const toRad = Math.PI / 180;
  const x = (b.lon - a.lon) * toRad * Math.cos(((a.lat + b.lat) / 2) * toRad);
  const y = (b.lat - a.lat) * toRad;
  return Math.sqrt(x * x + y * y) * EARTH_M;
}

/**
 * The newest fix far enough away from `here` to have measured real movement.
 *
 * Walks back from the most recent, widening the baseline until the distance
 * beats the uncertainty of both ends. Returns null when nothing inside
 * DERIVE_MAX_S resolves any movement at all, which is the honest answer for a
 * phone on a table -- and the reason a parked phone cannot arm crash detection
 * out of GPS wander alone.
 */
function baseline(here) {
  for (let i = fixes.length - 1; i >= 0; i--) {
    const p = fixes[i];
    const dt = (here.at - p.at) / 1000;
    if (dt < DERIVE_MIN_S) continue;          // too close in time to resolve
    if (dt > DERIVE_MAX_S) break;             // ordered, so everything older is worse
    const slop = Math.max(p.acc || 0, here.acc || 0);
    if (metresBetween(p, here) > Math.max(slop * DERIVE_SLOP_K, DERIVE_MIN_M)) return p;
  }
  return null;
}

/**
 * Take a position fix, however it arrived, and get a speed out of it.
 *
 * Everything that sees a position comes through here -- the speed watch, the
 * Home screen's watch, the background service, the heartbeat -- so that the
 * chip-versus-derived decision exists on every path and cannot drift between
 * them.
 */
export function noteFix(coords, at = Date.now()) {
  if (!coords || coords.latitude == null || coords.longitude == null) return;

  // Two of the four callers read the OS location cache, which hands back the
  // same fix over and over. Storing it twice would invent a second measurement
  // out of one, and a run of them would look like a steady stream of data
  // arriving when in fact nothing has been measured since.
  //
  // Keyed on the timestamp alone, and checked against the whole ring rather
  // than just the newest. Two genuinely different fixes do not share a GPS
  // clock reading, and comparing coordinates instead would let a re-read of the
  // same cached fix through on nothing worse than a rounding difference.
  if (fixes.some((f) => f.at === at)) return;

  const seen = fixes.length ? fixes[fixes.length - 1] : null;

  const here = {
    lat: coords.latitude,
    lon: coords.longitude,
    at,
    acc: coords.accuracy ?? null,
  };
  const raw = coords.speed;

  const newest = !seen || at >= seen.at;
  fixes.push(here);
  if (!newest) fixes.sort((a, b) => a.at - b.at);
  if (at - fixes[0].at > FIX_MEMORY_MS) {
    fixes = fixes.filter((f) => at - f.at <= FIX_MEMORY_MS);
  }

  // A cached fix stamped before one already held is worth keeping as a
  // baseline, but must never be measured FROM: the distance between it and
  // something newer, divided by a negative interval, is not a speed.
  if (!newest) return;

  // ---- 1. the chip measured it ---------------------------------------------
  // Strictly greater than zero. See the block above: on Android a zero is
  // usually the absence of a reading wearing the costume of one.
  if (raw != null && raw > 0) {
    noteSpeed(raw, at);
    lastNote = { at, kmh: raw * MPS_TO_KMH, source: 'chip', raw, acc: here.acc };
    return;
  }

  // ---- 2. it did not, so measure it from the positions ----------------------
  const base = baseline(here);
  if (base) {
    const dtS = (at - base.at) / 1000;
    const movedM = metresBetween(base, here);
    const mps = movedM / dtS;
    if (mps * MPS_TO_KMH > MAX_PLAUSIBLE_KMH) {
      lastNote = { at, kmh: null, source: 'none', raw, acc: here.acc,
                   why: `${Math.round(mps * MPS_TO_KMH)} km/h — bad fix, discarded` };
      return;
    }
    noteSpeed(mps, at);
    lastNote = { at, kmh: mps * MPS_TO_KMH, source: 'derived', raw, acc: here.acc,
                 movedM, dtS };
    return;
  }

  // ---- 3. nothing moved far enough to measure ------------------------------
  // Only now is a zero from the chip worth recording, and only when the fix is
  // precise enough for "not moving" to mean anything. Everything else records
  // NOTHING -- which leaves the reading stale and then unknown, rather than
  // asserting a standstill nobody observed.
  const watchedFor = (at - fixes[0].at) / 1000;
  if (raw === 0 && watchedFor >= STILL_MIN_S
      && here.acc != null && here.acc <= STILL_MAX_ACC_M) {
    noteSpeed(0, at);
    lastNote = { at, kmh: 0, source: 'still', raw, acc: here.acc };
    return;
  }
  lastNote = {
    at, kmh: null, source: 'none', raw, acc: here.acc,
    why: raw === 0 ? 'no movement resolvable yet' : 'chip reported no speed',
  };
}

/**
 * What the phone knows about this person's movement right now.
 *
 * `peakKmh` is the fastest they have been inside SPEED_MEMORY_MS, and it is the
 * field the classifier keys off rather than the current speed -- because by the
 * time an impact is processed the current speed is already the crash's speed,
 * which is the thing being explained, not the evidence for it.
 */
export function speedContext(now = Date.now()) {
  trim(now);
  const recent = samples.filter((s) => now - s.at <= SPEED_MEMORY_MS);
  const latest = samples.length ? samples[samples.length - 1] : null;

  // A fix older than the memory window is not "0 km/h", it is no answer. Saying
  // so lets the classifier decline to guess rather than quietly assume the
  // wearer was standing still.
  const stale = !latest || now - latest.at > SPEED_MEMORY_MS;

  return {
    known:    !stale,
    nowKmh:   stale ? null : latest.kmh,
    peakKmh:  recent.length ? Math.max(...recent.map((s) => s.kmh)) : null,
    /** A fix above road speed inside SPEED_MEMORY_MS. Strong, and brittle. */
    sawSpeed: recent.some((s) => s.kmh >= VEHICLE_KMH),
    /**
     * The question the classifier actually asks: is this person in a vehicle?
     *
     * Deliberately survives a GNSS dropout -- see the journey latch above. A
     * tunnel is not a car park, and reading silence as "stopped" is what would
     * throw away the driver-hit-at-speed case entirely.
     */
    wasTravelling: recent.some((s) => s.kmh >= VEHICLE_KMH) || inJourney(now),
    /** Are they stopped *now*? Only meaningful when `known`. */
    stopped:  !stale && latest.kmh <= STOP_KMH,
    ageMs:    latest ? now - latest.at : null,
  };
}

/**
 * Is the wearer still on a journey, GPS or no GPS?
 *
 * True from the moment road speed is seen until either a real observed stop of
 * JOURNEY_STOP_MS (which `noteSpeed` clears the latch for) or JOURNEY_BLIND_MS
 * with no fixes at all. The blind ceiling is the honest bound: after five
 * minutes of knowing nothing, this stops claiming to know.
 */
export function inJourney(now = Date.now()) {
  if (!journeyFrom) return false;
  const latest = samples.length ? samples[samples.length - 1] : null;
  const blindFor = latest ? now - latest.at : now - journeyFrom;
  return blindFor <= JOURNEY_BLIND_MS;
}

/**
 * Has the wearer been travelling coherently for long enough to stand an
 * accident question down on their behalf?
 *
 * Every part of this is load-bearing:
 *
 *   - EVERY sample in the run is above VEHICLE_KMH, not the average and not the
 *     peak. A car losing speed after being hit dips below and breaks the run;
 *     an average would let it through.
 *   - The run has to be unbroken since the impact, so a vehicle that rolled to
 *     a stop and was then pushed cannot accumulate credit from two halves.
 *   - No second impact inside it. A crash that is still happening is not
 *     somebody driving.
 *   - It needs real samples throughout: a GPS dropout in the middle proves
 *     nothing, and silence must never be read as "fine".
 */
export function travellingSteadily(now = Date.now()) {
  // Everything measured SINCE the impact, not "the last twenty seconds".
  //
  // Those are different windows and the difference is the whole test. A fixed
  // trailing window starts inside the crash itself, so the low samples the
  // impact produced sit in it and `every` below can never pass -- the rule
  // would look strict and in fact be dead code. Measuring forward from the
  // impact asks the question that was meant: what has this vehicle done since
  // it was hit?
  const run = samples.filter((s) => s.at > lastImpactAt);
  if (!run.length) return false;

  // It has to have been going on long enough. A car that is still rolling two
  // seconds after a shunt is not somebody driving.
  if (now - run[0].at < RESUME_STABLE_MS) return false;

  // And it has to be real data throughout. At the ride watch's 2 s cadence a
  // full run is ~10 samples; a handful means the GPS dropped out, and silence
  // must never be read as "fine".
  if (run.length < 5) return false;

  // EVERY sample above road speed, not the average and not the peak. A vehicle
  // that was hit is losing speed, and a single dip below breaks the run --
  // which is exactly the behaviour wanted, because an average would let a car
  // coasting to a halt look like a car being driven.
  return run.every((s) => s.kmh >= VEHICLE_KMH);
}

// --------------------------------------------------------- the classifier ---

/**
 * What was that impact?
 *
 * Returns one of:
 *   'accident'  -- hit while travelling. Ask, with a short window and a pin.
 *   'ignore'    -- a spike with no vehicle behind it. Furniture, a clap, sport.
 *
 * Note what is NOT here: a stillness requirement, and a stopped requirement.
 * Both were tried and both are traps. A crash victim's arm is often the least
 * still thing in the wreck, and a car that is hit frequently keeps moving --
 * see the header. `still` and `stopped` are carried into the note so a family
 * member reads what actually happened, and they change the window, but they
 * are not permitted to veto the question.
 */
export function classifyImpact(ev, ctx = speedContext()) {
  if (!ctx.wasTravelling) return 'ignore';
  return 'accident';
}

/**
 * The sentence a family member reads at 2 a.m., built from the two devices
 * that measured it. Plain words and real numbers: "a hard impact" tells them
 * nothing they can act on, and "peak_g 19.4" tells them less.
 */
export function describeImpact(ev, ctx) {
  const bits = [];
  if (ev?.peak_g != null) bits.push(`impact of about ${Math.round(ev.peak_g)}g`);
  // Only quote a speed that was actually measured recently. When the journey
  // latch is what carried this -- a tunnel, an underpass -- there is no honest
  // number to give, and inventing one puts a figure in front of a family that
  // no instrument produced.
  if (ctx?.peakKmh != null && ctx?.sawSpeed) {
    bits.push(`while travelling at ${Math.round(ctx.peakKmh)} km/h`);
  } else if (ctx?.wasTravelling) {
    bits.push('while in a vehicle (no position fix at the moment of impact)');
  }
  if (ctx?.stopped) bits.push('and the vehicle stopped dead');
  else if (ctx?.nowKmh != null && ctx.nowKmh > STOP_KMH) {
    bits.push(`and it was still moving at ${Math.round(ctx.nowKmh)} km/h afterwards`);
  }
  if (ev?.rot != null && ev.rot >= 300) bits.push(`with heavy rotation (${ev.rot}°/s)`);
  return bits.length ? `Detected ${bits.join(' ')}.` : '';
}

// ------------------------------------------------------------- the watcher ---

/**
 * Keep the speed history fed while this phone is acting as a safety device.
 *
 * `enabled` is the caller saying accident detection is wanted at all. It is a
 * real setting and not an internal detail: a GPS watch is the most expensive
 * thing this app does, and somebody who never travels by road should be able
 * to turn it off and get their battery back.
 */
export function useSpeedWatch(enabled) {
  const [state, setState] = useState({ kmh: null, error: null });

  useEffect(() => {
    if (!enabled || !Location || Platform.OS === 'web') return undefined;
    let alive = true;
    let sub = null;
    let gen = 0;
    let shown = null;

    const onFix = (pos) => {
      if (!alive) return;
      noteFix(pos?.coords, pos?.timestamp || Date.now());
      watchError = null;            // fixes are arriving: whatever it was, it lifted

      // Only when the visible number changes. Nothing reads this hook's return
      // value today -- App.js calls it for the side effect -- so an
      // unconditional setState at the watch's cadence would re-render the whole
      // app tree once a second on behalf of nobody. The Band console reads the
      // module state directly and ticks itself.
      const ctx = speedContext();
      const kmh = ctx.known ? ctx.nowKmh : null;
      const key = kmh == null ? 'none' : String(Math.round(kmh));
      if (key === shown) return;
      shown = key;
      setState({ kmh, error: null });
    };

    const open = async () => {
      const mine = ++gen;
      try { sub?.remove(); } catch { /* never opened */ }
      sub = null;
      try {
        // Asked for here rather than assumed. This watch now starts with the
        // app rather than with a band connection, so it can easily be the first
        // thing to want a position -- and a watch that was never granted
        // permission is precisely the silent failure this file exists to avoid.
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (!alive || mine !== gen) return;
        if (status !== 'granted') {
          watchError = 'location permission not granted';
          setState((s) => ({ ...s, error: watchError }));
          return;
        }

        const opened = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.BestForNavigation, ...WATCH_OPTS },
          onFix,
        );

        // The race this closes: `sub` used to be assigned only after the await,
        // so a fix arriving before the promise resolved could start a second
        // watch which the first then overwrote -- leaving a live subscription
        // that nothing held a handle to, feeding the same history at a
        // different rate and never cleaned up. The newest caller wins; every
        // superseded one closes what it opened.
        if (!alive || mine !== gen) {
          try { opened.remove(); } catch { /* already gone */ }
          return;
        }
        sub = opened;
        watchError = null;
      } catch (e) {
        // Permission revoked, location switched off, no provider. The detector
        // degrades to fall-only rather than the screen breaking -- but it says
        // so, because "accident detection is silently not running" is the kind
        // of failure this product cannot afford to hide. Recorded at module
        // scope as well as in state, so a diagnostic screen can read it without
        // this hook having to be threaded through the whole tree.
        if (mine !== gen) return;
        watchError = e?.message || String(e);
        if (alive) setState((s) => ({ ...s, error: watchError }));
      }
    };

    open();

    // Android stops delivering foreground location the moment the app leaves
    // the screen, and hands back a stale subscription when it returns. Nothing
    // reports that; the callbacks simply stop. Reopening on resume is what
    // keeps the history from having a hole exactly the size of the last time
    // the phone was in a pocket.
    const appSub = AppState.addEventListener('change', (s) => {
      if (s === 'active') open();
    });

    return () => {
      alive = false;
      gen++;                        // anything still in flight closes itself
      try { appSub.remove(); } catch { /* older RN */ }
      try { sub?.remove(); } catch { /* never opened */ }
      sub = null;
    };
  }, [enabled]);

  return state;
}

/** Test seam. Never called by the app; `__tests__` and the Band screen use it. */
export function __resetMotion() {
  samples = [];
  lastImpactAt = 0;
  watchError = null;
  journeyFrom = 0;
  stoppedSince = 0;
  fixes = [];
  lastNote = null;
}
