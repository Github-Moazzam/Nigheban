/**
 * Where she is now, for as long as that is the question.
 *
 * An alert used to carry exactly one position: the fix baked in at the moment
 * the button went down. For a fall in a kitchen that is the whole answer. For
 * a snatch, an abduction, or a walk home that turned bad it is the answer for
 * about thirty seconds, and after that it is a pin over a place nobody is any
 * more -- while four family members drive to it.
 *
 * WHAT "LIVE" ACTUALLY IS. Nothing on a phone streams position continuously.
 * Every live location in the world -- WhatsApp's, Google's -- is a ping on a
 * short interval, and the only real question is what the interval costs. So
 * this is a ping, at ten seconds while the emergency is new and thirty
 * afterwards, and none of it runs unless an alert is live. The cost is bounded
 * by the emergency rather than by the day.
 *
 * WHY IT RIDES THE FOREGROUND SERVICE. The obvious implementation is a
 * setInterval and `getCurrentPositionAsync`, and it works perfectly in every
 * situation this feature does not exist for. The situations it does exist for
 * all end with the app off screen: in a pocket, backgrounded, swiped out of
 * Recents, or killed outright by an OEM battery manager -- and a JS timer is
 * gone in every one of them. bgService.js already runs an Android foreground
 * service that Android keeps alive precisely so this cannot happen, and it has
 * been throwing its location payload away since the day it was written. This
 * is that payload finally being used: the ticks arrive whether or not anybody
 * is looking at the screen, and they arrive on a process Android has been told
 * not to kill.
 *
 * THE PHONE IS STILL NOT A TIMEKEEPER. The plan below -- how fast, and until
 * when -- is the SERVER's, handed back with the alert and restated in the
 * answer to every single fix. The phone caches it to disk so a headless
 * restart knows what it was doing, and it re-learns it six times a minute. A
 * tracker whose stop condition lives only in the app is a tracker that runs
 * for ever the one time the frame telling it to stop goes missing.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { call, loadSession } from './api';

// expo-location is loaded defensively, as everywhere else in this app: an
// older build, or web, must degrade to "no live location", never take the
// process down at import time.
let Location = null;
try { Location = require('expo-location'); } catch { /* no positions here */ }

const PLAN_KEY = 'nigehban.liveTrack';
const BUF_KEY = 'nigehban.liveTrackBuf';

/** The service's ordinary rhythm, when nothing is happening. See bgService. */
export const IDLE_INTERVAL_MS = 60000;

/**
 * How many unsent fixes are worth keeping.
 *
 * Two hundred is over half an hour at the ten-second cadence, which is a long
 * dead zone. Past that the OLDEST go, not the newest: a family looking at a
 * map wants the end of the trail, and a phone that has been out of signal for
 * an hour has one thing worth saying when it comes back, which is where she is
 * now.
 */
const BUF_MAX = 200;

// ---------------------------------------------------------------- plan ---

/**
 * The server's instructions, as last heard. Null when nothing is being tracked.
 *
 * Shape, all of it the server's:
 *   { alertId, fastS, fastUntil, slowS, afterStandDownS, until, resolved }
 */
export async function currentPlan() {
  try {
    const raw = await AsyncStorage.getItem(PLAN_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function savePlan(plan) {
  try {
    if (plan) await AsyncStorage.setItem(PLAN_KEY, JSON.stringify(plan));
    else await AsyncStorage.removeItem(PLAN_KEY);
  } catch { /* the next server answer restates it */ }
}

/** Normalise whatever the server sent into the shape stored above. */
function toPlan(tracking) {
  if (!tracking || tracking.alert_id == null) return null;
  return {
    alertId: tracking.alert_id,
    fastS: tracking.fast_s ?? 10,
    fastUntil: tracking.fast_until ?? 0,
    slowS: tracking.slow_s ?? 30,
    afterStandDownS: tracking.after_standdown_s ?? 30,
    until: tracking.until ?? null,
    resolved: !!tracking.resolved,
  };
}

/**
 * How many seconds between fixes, right now.
 *
 * Three rates and they are one decision: how much does the next pin matter
 * against how much the battery does. While the emergency is new the pin wins
 * outright -- somebody is driving to it. After twenty minutes the phone still
 * being alive starts to matter more, because a flat phone has closed every
 * path to the family in order to keep one open. After the stand-down the
 * question has changed from "where is she" to "is she getting home", and that
 * is a slower kind of question.
 */
export function intervalFor(plan, now = Date.now() / 1000) {
  if (!plan) return null;
  if (plan.resolved) return plan.afterStandDownS;
  return now < plan.fastUntil ? plan.fastS : plan.slowS;
}

/** Is this plan finished? A window that has run out stops the tracker. */
export function planExpired(plan, now = Date.now() / 1000) {
  if (!plan) return true;
  // An unresolved emergency has no end date. It stops when the server says so
  // -- by standing the alert down, or by answering a fix with `tracking: null`
  // -- and never because the phone decided enough time had passed.
  if (!plan.resolved) return false;
  return plan.until != null && now > plan.until;
}

// -------------------------------------------------------------- buffer ---

async function readBuf() {
  try {
    const raw = await AsyncStorage.getItem(BUF_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function writeBuf(points) {
  try {
    if (points.length) await AsyncStorage.setItem(BUF_KEY, JSON.stringify(points));
    else await AsyncStorage.removeItem(BUF_KEY);
  } catch { /* best effort: the fix is lost, the next one is not */ }
}

/** Drop every buffered fix. Sign-out, and the end of a tracking window. */
export async function clearBuffer() {
  await writeBuf([]);
}

// --------------------------------------------------------------- ticks ---

// One report at a time for the whole app, for the same reason alertQueue has
// its own interlock: the foreground service ticks from outside the React tree
// and the tree ticks from inside it, and two overlapping flushes both read the
// same buffer and both send it.
let _sending = false;

/**
 * A fix has arrived. Buffer it, then try to deliver everything buffered.
 *
 * Called from the foreground service's task -- headless, with no React tree
 * and no `session` prop, which is why the session is read off disk here.
 *
 * Batched rather than one-at-a-time because the case worth designing for is
 * not the ten-second ping that goes out on time. It is the eight minutes of
 * them buffered under a flyover that all arrive together when signal returns,
 * and sending those individually is fifty round trips from a phone whose
 * battery and signal are both already the thing at stake.
 */
export async function reportFixes(fixes) {
  const plan = await currentPlan();
  if (!plan) return { tracking: null, skipped: true };

  const points = (fixes || [])
    .map((f) => ({
      lat: f?.coords?.latitude ?? f?.lat,
      lon: f?.coords?.longitude ?? f?.lon,
      accuracy: f?.coords?.accuracy ?? f?.accuracy ?? null,
      // The phone's clock, in seconds, matching every other time in this
      // product. expo-location reports milliseconds.
      at: f?.timestamp ? f.timestamp / 1000 : (f?.at ?? Date.now() / 1000),
    }))
    .filter((p) => typeof p.lat === 'number' && typeof p.lon === 'number');

  const buffered = await readBuf();
  const queue = [...buffered, ...points].slice(-BUF_MAX);
  if (!queue.length) return { tracking: plan, sent: 0 };

  // Written down BEFORE the attempt. A fix that is only in memory when the
  // process is killed -- which is the normal end of a headless task -- is a
  // fix that never happened.
  await writeBuf(queue);

  if (_sending) return { tracking: plan, sent: 0, busy: true };
  _sending = true;
  try {
    const session = await loadSession();
    if (!session?.token) return { tracking: plan, sent: 0 };

    // Short. A fix is worth almost nothing by the time a slow network has
    // finished with it, and the next one is ten seconds away -- so failing
    // fast and keeping it buffered beats holding the radio open.
    const r = await call(session, '/location', {
      method: 'POST', body: { points: queue }, timeout: 10000,
    });

    await writeBuf([]);
    const next = toPlan(r?.tracking);
    await savePlan(next);
    return { tracking: next, sent: queue.length };
  } catch {
    // Kept, and tried again on the next tick. This is the dead-zone case and
    // it is the one the buffer exists for.
    return { tracking: plan, sent: 0, failed: true };
  } finally {
    _sending = false;
  }
}

// --------------------------------------------------------- the service ---

/**
 * What interval the foreground service is currently configured for.
 *
 * Held in a module variable rather than read back from expo-location, which
 * has no API for it. It is only ever an optimisation -- it stops the service
 * being torn down and rebuilt for a change that is not a change -- so a
 * headless restart losing it costs exactly one unnecessary reconfigure.
 */
let _appliedMs = null;

/** Forget the applied interval, so the next sync reconfigures unconditionally. */
export function forgetAppliedInterval() {
  _appliedMs = null;
}

/**
 * Point the foreground service at the rhythm the plan asks for.
 *
 * `startLocationUpdatesAsync` cannot be re-issued over a running task with new
 * options, so a change of pace is a stop and a start. That is a real risk and
 * worth naming: for the moment between them there is no foreground service,
 * and Android is entitled to reclaim the process. It is taken because the
 * alternative is worse in both directions -- tracking an emergency at sixty
 * seconds, or tracking an ordinary Tuesday at ten -- and it is taken as rarely
 * as possible: twice in a typical emergency, once at the start and once when
 * the fast window ends.
 */
async function applyInterval(ms, live) {
  if (!Location || _appliedMs === ms) return;
  let TaskManager = null;
  let TASK_NAME = null;
  try {
    TaskManager = require('expo-task-manager');
    ({ TASK_NAME } = require('./bgService'));
  } catch {
    return;                     // web, or a build without the native modules
  }
  if (!TaskManager || !TASK_NAME) return;

  const opts = {
    accuracy: live ? Location.Accuracy.High : Location.Accuracy.Balanced,
    timeInterval: ms,
    // Zero, not a distance floor. Android treats distanceInterval as a
    // *minimum movement*, so with one set a phone lying still produces no
    // ticks at all -- and somebody hiding, motionless, in a dead zone is
    // precisely the person whose position must keep going out.
    distanceInterval: 0,
    deferredUpdatesInterval: ms,
    foregroundService: {
      notificationTitle: live ? 'Nigehban - live location on' : 'Nigehban is watching',
      // The wearer is told, in the one place Android guarantees they can see
      // it, that their position is being sent. A safety product that reports
      // where somebody is without saying so is a tracking product.
      notificationBody: live
        ? 'Your family can see where you are while this alert is live'
        : 'Band link and safety monitoring are active',
      notificationColor: '#3CC183',
    },
  };
  try {
    if (!TaskManager.isTaskDefined(TASK_NAME)) return;
    if (await Location.hasStartedLocationUpdatesAsync(TASK_NAME)) {
      await Location.stopLocationUpdatesAsync(TASK_NAME);
    }
    await Location.startLocationUpdatesAsync(TASK_NAME, opts);
    _appliedMs = ms;
  } catch {
    // The service could not be reconfigured. Whatever rhythm it is already on
    // keeps running, which is the right failure: slower fixes beat none.
  }
}

/**
 * Bring the service into line with the plan. Safe to call on every change.
 *
 * Returns the plan in force afterwards, or null when nothing is being tracked.
 */
export async function syncTracking() {
  const plan = await currentPlan();
  if (!plan || planExpired(plan)) {
    if (plan) {
      await savePlan(null);
      await clearBuffer();
    }
    await applyInterval(IDLE_INTERVAL_MS, false);
    return null;
  }
  const secs = intervalFor(plan);
  await applyInterval(Math.max(5, Math.round(secs)) * 1000, true);
  return plan;
}

/**
 * Start tracking, from the `tracking` block the server returned with an alert.
 *
 * Idempotent, and deliberately tolerant of being called with the same plan
 * repeatedly: the socket, the alert response and the restore path can all
 * produce one, and none of them knows what the others have done.
 */
export async function startTracking(tracking) {
  const plan = toPlan(tracking);
  if (!plan) return null;
  const cur = await currentPlan();
  // A newer emergency replaces an older one, buffer and all -- those fixes
  // belong to an alert that is over. The same emergency keeps the window it
  // already has, updated with whatever the server has just said about it.
  if (cur && String(cur.alertId) === String(plan.alertId)) {
    await savePlan({ ...cur, ...plan });
  } else {
    await savePlan(plan);
    await clearBuffer();
  }
  return syncTracking();
}

/**
 * The alert was stood down. Keep going, slower, for the window the server set.
 *
 * "I am safe" is pressed at the roadside, in a stranger's car, or at the top of
 * a street she still has to walk down -- the emergency is over and the journey
 * is not. Half an hour of the family watching her get home is the difference
 * between an alert that ended and a person who arrived.
 */
export async function trackAfterStandDown(alertId, until, everyS) {
  const cur = await currentPlan();
  if (!cur || (alertId != null && String(cur.alertId) !== String(alertId))) return null;
  if (!until) return stopTracking();
  await savePlan({
    ...cur,
    resolved: true,
    until,
    afterStandDownS: everyS || cur.afterStandDownS,
  });
  return syncTracking();
}

/**
 * Ask the server what this phone should be tracking, and do that.
 *
 * The recovery path, and the reason it exists is the ordinary end of a
 * headless task: Android kills the process, and everything in memory goes with
 * it. The plan is on disk so that survives -- but an app UPDATE, a sign-in on
 * a new handset, or a `sos_started` frame that arrived while the socket was
 * down all leave a live emergency with no plan next to it, and a tracker that
 * only ever starts from a frame it might not have received is a tracker that
 * is silent in exactly the cases worth building it for.
 *
 * So the phone asks. An empty POST to /location is a question -- "is there an
 * emergency I should be reporting into?" -- and the answer carries the whole
 * cadence policy, which is the server's to decide and not something worth
 * duplicating into an app that cannot be redeployed to somebody's pocket.
 *
 * Cheap and safe to call on every foreground and every reconnect: with nothing
 * live the server answers `tracking: null` and this stops whatever it finds.
 */
export async function adoptTracking(session) {
  try {
    const s = session || await loadSession();
    if (!s?.token) return null;
    const r = await call(s, '/location', { method: 'POST', body: {}, timeout: 8000 });
    const plan = toPlan(r?.tracking);
    if (!plan) {
      // Only tear down if something was running. Calling stopTracking on an
      // idle phone would reconfigure the foreground service for nothing, and
      // that reconfigure is a stop and a start -- see applyInterval.
      const cur = await currentPlan();
      return cur ? stopTracking() : null;
    }
    await savePlan(plan);
    return syncTracking();
  } catch {
    // Offline. Whatever is on disk keeps running, which is the right failure:
    // a phone that cannot reach the server during an emergency is the phone
    // that most needs to go on buffering positions.
    return currentPlan();
  }
}

/** Stop entirely: drop the plan, drop the buffer, hand the service back. */
export async function stopTracking() {
  await savePlan(null);
  await clearBuffer();
  await applyInterval(IDLE_INTERVAL_MS, false);
  return null;
}
