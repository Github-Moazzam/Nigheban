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

import { useEffect, useRef, useState } from 'react';
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

// ---- how hard the sampling works, and when -------------------------------
//
// A high-accuracy GPS watch costs 30-50 mA. Held on all day it is a bigger
// drain than everything else in this app combined, and a safety device whose
// battery does not last the day is not a safety device.
//
// So the watch is adaptive. It idles on a cheap, coarse fix that is easily good
// enough to answer "is this person in a vehicle", and only opens up to a real
// GNSS rate once the answer is yes. Standing still, in a house, asleep -- the
// state the phone is in for most of its life -- it costs almost nothing.
const IDLE_WATCH  = { timeInterval: 15000, distanceInterval: 25 };
const RIDE_WATCH  = { timeInterval: 2000,  distanceInterval: 0 };
/** How long below VEHICLE_KMH before dropping back to the cheap watch. */
const RIDE_EXIT_MS = 90000;

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

export function speedWatchStatus() {
  const ctx = speedContext();
  return {
    error: watchError,
    /** Can an impact be classified as an accident at all right now? */
    armed: !watchError && ctx.known,
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
  samples.push({ at, kmh });
  trim(at);

  // ---- the journey latch ---------------------------------------------------
  //
  // See `inJourney` below. Updated here, on real fixes only, because the whole
  // point of it is that NOT getting a fix must never look like stopping.
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
// one: direct, instantaneous, and accurate to a fraction of a km/h. It is also
// frequently ABSENT.
//
// Android satisfies a Balanced-accuracy request from fused/network location,
// and those fixes routinely carry no speed at all. That is a deadlock, not a
// degradation: the watch idles on Balanced to save battery and only opens up to
// real GNSS once it sees road speed -- so with `speed` null it never sees road
// speed, never opens up, and accident detection is silently off for the entire
// journey. It needs speed in order to start measuring speed.
//
// So when the chip declines to say, the distance between two consecutive fixes
// over the time between them answers instead. Still GPS -- two positions, not
// dead reckoning -- and good enough for a 25 km/h threshold even though it is
// far too coarse to quote at somebody.
//
// It is NOT integrated from the accelerometer, and never will be. Velocity from
// a wrist IMU means double-integrating a noisy signal, and the error compounds
// so quickly that it is confidently wrong within seconds. A detector that
// believes a made-up speed is worse than one that admits it does not know.
let lastFix = null;      // { lat, lon, at, acc }

const EARTH_M = 6371000;
/** Metres between two fixes. Equirectangular -- exact enough at these ranges. */
function metresBetween(a, b) {
  const toRad = Math.PI / 180;
  const x = (b.lon - a.lon) * toRad * Math.cos(((a.lat + b.lat) / 2) * toRad);
  const y = (b.lat - a.lat) * toRad;
  return Math.sqrt(x * x + y * y) * EARTH_M;
}

/**
 * Take a position fix, however it arrived, and get a speed out of it.
 *
 * Prefers the chip's own reading and falls back to the distance between fixes.
 * Everything that watches position should come through here rather than calling
 * `noteSpeed` directly, so the fallback exists on every path.
 */
export function noteFix(coords, at = Date.now()) {
  if (!coords) return;

  if (coords.speed != null && coords.speed >= 0) {
    noteSpeed(coords.speed, at);
    lastFix = { lat: coords.latitude, lon: coords.longitude, at, acc: coords.accuracy ?? null };
    return;
  }

  const prev = lastFix;
  lastFix = { lat: coords.latitude, lon: coords.longitude, at, acc: coords.accuracy ?? null };
  if (!prev || coords.latitude == null) return;

  const dt = (at - prev.at) / 1000;
  // Under a second is noise; over a minute is two different journeys.
  if (!(dt >= 1 && dt <= 60)) return;

  const d = metresBetween(prev, lastFix);

  // A 100 m-accurate fix wanders by ~100 m while sitting on a table, which over
  // 15 s reads as 24 km/h out of nothing at all. Requiring the movement to
  // exceed the uncertainty is what stops a parked phone arming crash detection.
  const slop = Math.max(prev.acc || 0, lastFix.acc || 0);
  if (d <= slop) return;

  const mps = d / dt;
  // 300 km/h is not a car, it is a bad fix or a jump between providers.
  if (mps * MPS_TO_KMH > 300) return;

  noteSpeed(mps, at);
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
  const [state, setState] = useState({ kmh: null, riding: false, error: null });
  const sub = useRef(null);
  const riding = useRef(false);
  const slowSince = useRef(0);
  const restart = useRef(null);

  useEffect(() => {
    if (!enabled || !Location || Platform.OS === 'web') return undefined;
    let alive = true;

    const open = async (fast) => {
      try { sub.current?.remove(); } catch { /* never opened */ }
      sub.current = null;
      if (!alive) return;
      try {
        sub.current = await Location.watchPositionAsync(
          {
            accuracy: fast ? Location.Accuracy.High : Location.Accuracy.Balanced,
            ...(fast ? RIDE_WATCH : IDLE_WATCH),
          },
          (pos) => {
            if (!alive) return;
            // Through noteFix, not noteSpeed: a Balanced-accuracy fix often
            // carries no `speed` field at all, and without the distance
            // fallback this watch could never see the road speed it needs in
            // order to open up to real GNSS. See noteFix.
            noteFix(pos?.coords, pos?.timestamp || Date.now());
            // Read back what actually landed, so the throttle below reacts to
            // the derived speed as well as the chip's own.
            const ctx = speedContext();
            const kmh = ctx.known ? ctx.nowKmh : null;

            // Open the throttle when they start moving, close it when they
            // have been slow for a while. The exit is deliberately lazy: a bus
            // at a red light must not drop the app back to a coarse fix it
            // then takes thirty seconds to recover from when the light changes.
            const now = Date.now();
            if (kmh != null && kmh >= VEHICLE_KMH) {
              slowSince.current = 0;
              if (!riding.current) { riding.current = true; restart.current?.(true); }
            } else if (riding.current) {
              if (!slowSince.current) slowSince.current = now;
              else if (now - slowSince.current > RIDE_EXIT_MS) {
                riding.current = false; slowSince.current = 0; restart.current?.(false);
              }
            }
            watchError = null;          // fixes are arriving: whatever it was, it lifted
            setState({ kmh, riding: riding.current, error: null });
          },
        );
      } catch (e) {
        // Permission revoked, location switched off, no provider. The detector
        // degrades to fall-only rather than the screen breaking -- but it says
        // so, because "accident detection is silently not running" is the kind
        // of failure this product cannot afford to hide. Recorded at module
        // scope as well as in state, so a diagnostic screen can read it without
        // this hook having to be threaded through the whole tree.
        watchError = e?.message || String(e);
        if (alive) setState((s) => ({ ...s, error: watchError }));
      }
    };

    restart.current = open;
    open(false);

    // Android stops delivering foreground location the moment the app leaves
    // the screen, and hands back a stale subscription when it returns. Nothing
    // reports that; the callbacks simply stop. Reopening on resume is what
    // keeps the history from having a hole exactly the size of the last time
    // the phone was in a pocket.
    const appSub = AppState.addEventListener('change', (s) => {
      if (s === 'active') open(riding.current);
    });

    return () => {
      alive = false;
      restart.current = null;
      try { appSub.remove(); } catch { /* older RN */ }
      try { sub.current?.remove(); } catch { /* never opened */ }
      sub.current = null;
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
  lastFix = null;
}
