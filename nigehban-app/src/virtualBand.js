/**
 * VIRTUAL BAND — the phone pretending to be the wristband.
 *
 * This is not a set of debug buttons. It is a JavaScript port of
 * `nigehban_band_esp32/nigehban_band_esp32.ino`: the same button engine, the
 * same gesture map, the same event JSON, the same command handler. The rest of
 * the app cannot tell the difference between this and a real band over BLE,
 * because it receives byte-identical lines either way.
 *
 * Why bother, when `useBand().simulate()` already exists? Because `simulate()`
 * fires a *conclusion* ("sos"). It skips the part that is actually hard and
 * actually untested: turning presses and accelerometer samples into gestures.
 * That logic has to be right on the band; writing it here means it is debugged
 * somewhere with a screen and a console, and the constants it is tuned with
 * port straight across when the nRF52840 arrives.
 *
 * What is genuinely simulated: the radio. Everything above it is real.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Vibration } from 'react-native';

// ---- constants, copied verbatim from the firmware ------------------------
// Change one here, measure it on a phone, then copy the number back into the
// .ino. That direction of travel is the whole point of this file.
export const CLICK_GAP_MS = 420;    // max gap inside a multi-click burst
export const HOLD_1_MS    = 3000;   // hold 3s
export const HOLD_2_MS    = 5000;   // hold 5s
export const HEARTBEAT_MS = 10000;

// ---- fall detection, exec plan section 8 --------------------------------
// A four-stage state machine, because every single threshold has a fatal
// counter-example: "high acceleration" is a dropped bag, "sudden stop" is
// sitting down hard. Only the *sequence* is specific to a fall.
export const FALL = {
  FREEFALL_G:       0.45,  // magnitude below this = something is falling
  FREEFALL_MIN_MS:    70,  // ...for at least this long (rejects a jolt)
  IMPACT_G:          2.4,  // then a spike above this
  IMPACT_WINDOW_MS: 1400,  // ...within this long of the free-fall ending
  STILL_BAND_G:     0.28,  // then |g - 1| under this
  STILL_MS:         1600,  // ...sustained: the person did not get straight up
};

/**
 * THE GESTURE MAP — data, not control flow.
 *
 * Follows EXECUTION_PLAN.md §5, which is the contract the server and the app
 * were specified against: double-tap is SOS, hold 3 s toggles High Alert.
 *
 * Written as a table rather than an if-chain because the map is going to
 * become user-configurable in settings. When that lands it edits this array
 * and nothing else needs to know — which is also why the firmware's copy of
 * this decision lives in one clearly marked block rather than scattered.
 *
 * `n` is an inclusive [min, max] tap count. `toggle` means the event depends
 * on current state, so the name is chosen at fire time.
 */
export const DEFAULT_GESTURES = [
  { btn: 1, g: 'click', n: [1, 1],  e: 'checkin_ack', buzz: [1, 90, 90] },

  // Two taps is SOS. Three, four, five are ALSO SOS, deliberately: a
  // frightened person does not tap a precise number of times, and the failure
  // mode of being strict here is a silent no-op at the exact moment the
  // product is supposed to work. That is also why `armed` cannot come back as
  // a 4-tap gesture — it would let an over-tapped SOS arm anti-snatch instead
  // of calling for help.
  { btn: 1, g: 'click', n: [2, 99], e: 'sos', src: 'double_tap', buzz: [4, 120, 80] },

  { btn: 1, g: 'hold3', toggle: 'high_alert' },

  // Nothing binds `hold5`. Anti-snatch is deferred, so the wearer today has
  // exactly two things to remember: tap twice for help, hold to be watched.
  // The `armed` toggle below still works; re-enabling it is one row here plus
  // the matching block in the .ino — which is the point of a table.
  // { btn: 1, g: 'hold5', toggle: 'armed' },

  // Button B is a prototyping convenience; the shipped band has one key.
  { btn: 2, g: 'click', n: [1, 99], e: 'sos', src: 'button_b', buzz: [4, 120, 80] },
];

/** Is anything at all bound to this hold? Nothing buzzes if nothing is. */
function hasGesture(table, btn, gesture) {
  return table.some((r) => r.btn === btn && r.g === gesture);
}

function matchGesture(table, btn, gesture, n) {
  return table.find((r) => {
    if (r.btn !== btn || r.g !== gesture) return false;
    if (!r.n) return true;                       // holds carry no tap count
    return n >= r.n[0] && n <= r.n[1];
  }) || null;
}

const now = () => Date.now();

// expo-sensors and expo-battery are loaded defensively for the same reason
// expo-network is in api.js: an older build must degrade to "that feature is
// unavailable here", never take the screen down with it.
let Accelerometer = null;
try { Accelerometer = require('expo-sensors').Accelerometer; } catch { /* no IMU access */ }

let Battery = null;
try { Battery = require('expo-battery'); } catch { /* fall back to a sim drain */ }

/**
 * @param onLine  called with each newline-JSON string the "band" emits — the
 *                same string `useBand` reads off the BLE TX characteristic.
 * @param active  false when a real band is connected. The console stays
 *                mounted so its log survives a mode switch, but it stops
 *                heartbeating and releases the accelerometer, because two
 *                bands reporting at once is worse than none.
 */
export function useVirtualBand(onLine, active = true) {
  const [armed, setArmed]         = useState(false);
  const [highAlert, setHighAlert] = useState(false);
  const [battery, setBattery]     = useState(100);
  const [awaitingAck, setAwait]   = useState(false);
  const [holding, setHolding]     = useState(false);  // finger currently down
  const [holdMs, setHoldMs]       = useState(0);      // drives the hold ring
  const [buzzing, setBuzzing]     = useState(false);
  const [imu, setImu]             = useState(Accelerometer ? 'starting' : 'unavailable');
  const [fallStage, setFallStage] = useState('idle');
  const [log, setLog]             = useState([]);     // newest first, capped

  const seq      = useRef(0);
  const bootMs   = useRef(now());
  const armedRef = useRef(false);
  const highAlertRef = useRef(false);
  const gestures  = useRef(DEFAULT_GESTURES);   // swap this from settings later
  const batRef   = useRef(100);
  const lineRef  = useRef(onLine);
  lineRef.current = onLine;

  // ---------------------------------------------------------- transmit ---
  const emit = useCallback((type, extra = {}) => {
    const msg = {
      t: 'evt',
      e: type,
      seq: ++seq.current,
      ms: now() - bootMs.current,
      bat: Math.round(batRef.current),
      armed: armedRef.current ? 1 : 0,
      ha: highAlertRef.current ? 1 : 0,
      ...extra,
    };
    const line = JSON.stringify(msg);
    if (type !== 'hb') {
      setLog((l) => [{ at: now(), dir: 'tx', text: line }, ...l].slice(0, 60));
    }
    lineRef.current?.(line);
    return msg;
  }, []);

  // ---------------------------------------------------------- feedback ---
  // The firmware's feedback(pulses, onMs, offMs), rendered as haptics. The
  // wearer of the real band feels the motor; here the tester feels this, which
  // is the closest thing to a coin ERM we have without wiring one.
  const feedback = useCallback((pulses, onMs = 150, offMs = 120) => {
    const pattern = [0];
    for (let i = 0; i < pulses; i++) pattern.push(onMs, offMs);
    try { Vibration.vibrate(pattern); } catch { /* emulator, or no motor */ }
    setBuzzing(true);
    setTimeout(() => setBuzzing(false), pulses * (onMs + offMs));
  }, []);

  // ------------------------------------------------------ gesture map ---
  // Resolved against DEFAULT_GESTURES above rather than an if-chain, so the
  // planned "let the wearer remap this in settings" feature is a data edit and
  // nothing else has to learn about it.
  const onGesture = useCallback((btn, gesture, n) => {
    const meta = { btn, g: gesture, n };
    const rule = matchGesture(gestures.current, btn, gesture, n);
    if (!rule) return;

    if (rule.toggle === 'high_alert') {
      const next = !highAlertRef.current;
      highAlertRef.current = next;
      setHighAlert(next);
      feedback(next ? 2 : 1, 180, 120);
      emit(next ? 'high_alert_on' : 'high_alert_off', meta);
      return;
    }

    // Unbound by default — see DEFAULT_GESTURES. Kept because the state and the
    // wire field are still real; only the way in is gone.
    if (rule.toggle === 'armed') {
      const next = !armedRef.current;
      armedRef.current = next;
      setArmed(next);
      feedback(next ? 3 : 1, 180, 120);
      emit(next ? 'armed' : 'disarmed', meta);
      return;
    }

    if (rule.e === 'checkin_ack') setAwait(false);
    if (rule.buzz) feedback(...rule.buzz);
    emit(rule.e, rule.src ? { ...meta, src: rule.src } : meta);
  }, [emit, feedback]);

  // ------------------------------------------------- the button engine ---
  // buttonTick() minus the debounce, which a touch handler already does for
  // us. Everything else is preserved — the hold cues firing *while still
  // held*, the multi-click burst finalising only once the user stops — because
  // those are the parts a tester's thumb can actually falsify.
  const press      = useRef({ start: 0, clicks: 0, held1: false, held2: false });
  const holdTimers = useRef([]);
  const burstTimer = useRef(null);
  const tickTimer  = useRef(null);

  const clearHoldTimers = useCallback(() => {
    holdTimers.current.forEach(clearTimeout);
    holdTimers.current = [];
    if (tickTimer.current) { clearInterval(tickTimer.current); tickTimer.current = null; }
  }, []);

  const onPressIn = useCallback((btn = 1) => {
    clearTimeout(burstTimer.current);
    const p = press.current;
    p.start = now();
    p.held1 = false;
    p.held2 = false;
    setHolding(true);
    setHoldMs(0);

    tickTimer.current = setInterval(() => setHoldMs(now() - p.start), 60);

    // The cue is gated on the map, not hardcoded: an unbound threshold has to
    // stay silent, or the band buzzes to announce that it did nothing.
    const arm = (ms, gesture, pulses, flag) => {
      if (!hasGesture(gestures.current, btn, gesture)) return;
      holdTimers.current.push(setTimeout(() => {
        p[flag] = true;
        feedback(pulses, 250, 120);
        onGesture(btn, gesture, 0);
      }, ms));
    };

    arm(HOLD_1_MS, 'hold3', 1, 'held1');
    arm(HOLD_2_MS, 'hold5', 2, 'held2');
  }, [clearHoldTimers, feedback, onGesture]);

  const onPressOut = useCallback((btn = 1) => {
    clearHoldTimers();
    setHolding(false);
    setHoldMs(0);
    const p = press.current;
    const held = now() - p.start;

    if (!p.held1 && !p.held2 && held < HOLD_1_MS) {
      p.clicks += 1;
      burstTimer.current = setTimeout(() => {
        const n = p.clicks;
        p.clicks = 0;
        if (n > 0) onGesture(btn, 'click', n);
      }, CLICK_GAP_MS);
    }
  }, [clearHoldTimers, onGesture]);

  // ------------------------------------------------- commands from app ---
  // handleCommand() from the .ino. The app writes these to NUS RX on a real
  // band; here it hands them straight over. Same switch, same effects.
  const deliver = useCallback((cmd) => {
    setLog((l) => [{ at: now(), dir: 'rx', text: JSON.stringify(cmd) }, ...l].slice(0, 60));
    switch (cmd.c) {
      case 'checkin_req':
        setAwait(true);
        feedback(3, 400, 250);              // long, unmissable buzz
        emit('checkin_prompted');
        break;
      case 'buzz':  feedback(cmd.n ?? 2, 150, 120); break;
      case 'alarm': feedback(20, 300, 200); break;
      case 'ack':   feedback(1, 60, 60); break;
      case 'bat':
        batRef.current = cmd.v ?? 100;
        setBattery(batRef.current);
        emit('battery', { forced: 1 });
        break;
      case 'ping':  emit('pong'); break;
      default: break;
    }
    return true;
  }, [emit, feedback]);

  // -------------------------------------------------------- heartbeat ---
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => emit('hb'), HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [active, emit]);

  // ---------------------------------------------------------- battery ---
  // The real band reads a divider on an ADC pin. Here the phone's own battery
  // stands in, which beats a fake number: it is a real level that really
  // falls, so the low-battery escalation can be tested by leaving it unplugged.
  useEffect(() => {
    let sub;
    let alive = true;
    (async () => {
      if (Battery) {
        try {
          const lvl = await Battery.getBatteryLevelAsync();
          if (alive && lvl >= 0) { batRef.current = lvl * 100; setBattery(lvl * 100); }
          sub = Battery.addBatteryLevelListener(({ batteryLevel }) => {
            batRef.current = batteryLevel * 100;
            setBattery(batteryLevel * 100);
          });
          return;
        } catch { /* fall through to the sim drain */ }
      }
      const id = setInterval(() => {
        batRef.current = Math.max(0, batRef.current - 1);
        setBattery(batRef.current);
      }, 60000);
      sub = { remove: () => clearInterval(id) };
    })();
    return () => { alive = false; sub?.remove?.(); };
  }, []);

  // Emit low battery once per threshold crossing, as the band would. Latched
  // with hysteresis so a level hovering on 20% cannot page the family twice.
  const battFired = useRef({ 20: false, 5: false });
  useEffect(() => {
    for (const pct of [20, 5]) {
      if (battery <= pct && !battFired.current[pct]) {
        battFired.current[pct] = true;
        emit('low_battery', { pct: Math.round(battery) });
      } else if (battery > pct + 3) {
        battFired.current[pct] = false;
      }
    }
  }, [battery, emit]);

  // -------------------------------------------------------------- fall ---
  // The nRF52840 will run this against its on-board LSM6DS3TR-C. The phone's
  // accelerometer reports the same units (g), so the constants transfer.
  const fall        = useRef({ stage: 'idle', since: 0, freefallEnd: 0, peak: 0, stillFrom: 0 });
  const fallStageRef = useRef('idle');

  useEffect(() => {
    if (!Accelerometer || !active) return undefined;
    let sub;
    try {
      // 104 Hz is the firmware's active rate. Matching it means a threshold
      // that works here is not quietly relying on seeing more samples than
      // the band will ever have.
      Accelerometer.setUpdateInterval(1000 / 104);
      sub = Accelerometer.addListener(({ x, y, z }) => {
        const g = Math.sqrt(x * x + y * y + z * z);
        const t = now();
        const f = fall.current;

        switch (f.stage) {
          case 'idle':
            if (g < FALL.FREEFALL_G) { f.stage = 'freefall'; f.since = t; f.peak = g; }
            break;

          case 'freefall':
            if (g < FALL.FREEFALL_G) break;                    // still falling
            if (t - f.since >= FALL.FREEFALL_MIN_MS) {
              f.stage = 'impact_wait'; f.freefallEnd = t; f.peak = g;
            } else {
              f.stage = 'idle';                                // a jolt, not a fall
            }
            break;

          case 'impact_wait':
            f.peak = Math.max(f.peak, g);
            if (g >= FALL.IMPACT_G) { f.stage = 'settling'; f.since = t; f.stillFrom = 0; }
            else if (t - f.freefallEnd > FALL.IMPACT_WINDOW_MS) f.stage = 'idle';
            break;

          case 'settling': {
            const still = Math.abs(g - 1) < FALL.STILL_BAND_G;
            if (!still) {
              f.stillFrom = 0;
              if (t - f.since > 4000) f.stage = 'idle';        // got straight up
              break;
            }
            if (!f.stillFrom) f.stillFrom = t;
            if (t - f.stillFrom >= FALL.STILL_MS) {
              f.stage = 'idle';
              emit('fall', {
                peak: Math.round(f.peak * 100) / 100,
                still_ms: t - f.stillFrom,
                src: 'imu',
              });
              feedback(3, 200, 150);
            }
            break;
          }
          default: break;
        }

        if (f.stage !== fallStageRef.current) {
          fallStageRef.current = f.stage;
          setFallStage(f.stage);
        }
      });
      setImu('live');
    } catch {
      setImu('unavailable');
    }
    return () => sub?.remove?.();
  }, [active, emit, feedback]);

  // Manual triggers, for the events a thumb cannot produce on a desk: a fall
  // you would rather not actually take, and an anti-snatch tear-off.
  const trigger = useCallback((e, extra = {}) => {
    if (e === 'fall') feedback(3, 200, 150);
    if (e === 'snatch') feedback(6, 150, 100);
    emit(e, { src: 'manual', ...extra });
  }, [emit, feedback]);

  useEffect(() => () => {
    clearHoldTimers();
    clearTimeout(burstTimer.current);
  }, [clearHoldTimers]);

  return {
    // state the console renders
    armed, highAlert, battery, awaitingAck, holding, holdMs, buzzing, imu,
    fallStage, log, gestures: gestures.current,
    // the button surface
    onPressIn, onPressOut,
    // everything else
    deliver, trigger, emit,
    clearLog: () => setLog([]),
    imuAvailable: !!Accelerometer,
    batteryAvailable: !!Battery,
  };
}
