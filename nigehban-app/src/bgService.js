import { Platform } from 'react-native';
import { flushPending } from './alertQueue';
import { IDLE_INTERVAL_MS, currentPlan, reportFixes, syncTracking } from './liveLocation';

/**
 * Exported because liveLocation.js reconfigures this same task when an
 * emergency needs a faster rhythm than the idle one below. One task, one name,
 * two callers -- a second registration under a different name would be a
 * second foreground service and a second sticky notification.
 */
export const TASK_NAME = 'NIGEHBAN_BACKGROUND_WATCH';

let TaskManager = null;
let Location = null;
let loadError = null;

try {
  TaskManager = require('expo-task-manager');
  Location = require('expo-location');
} catch (e) {
  // web, or a build that shipped without expo-task-manager / expo-location
  // baked into the native binary. This used to fail silently here, which is
  // exactly why the foreground service never started in earlier builds even
  // though the JS code looked correct.
  loadError = e?.message || String(e);
}

// Define the background task if TaskManager is available. This MUST run at
// module load time (not inside startBackgroundWatch), because Android can
// relaunch the JS engine headlessly to deliver a location tick, and the task
// has to already be registered when that happens.
if (TaskManager && Location) {
  try {
    TaskManager.defineTask(TASK_NAME, async ({ data, error }) => {
      if (error) {
        console.warn('[bgService] task error', error.message);
      }
      // The location payload is still not the point -- the foreground service
      // and the wake it creates are. But this tick is the only heartbeat the
      // app has while it is off screen or swiped out of Recents, so it is also
      // the only chance a queued SOS gets to leave the phone before somebody
      // opens the app again. An emergency raised in a dead zone must not wait
      // on the user's attention returning.
      //
      // Guarded and silent: an exception thrown out of a headless task takes
      // the service with it, and the service is what keeps the process alive.
      try {
        const { delivered } = await flushPending();
        if (delivered.length) {
          console.log(`[bgService] flushed ${delivered.length} queued alert(s) from the background`);
        }
      } catch (e) {
        console.warn('[bgService] background flush failed', e?.message || e);
      }

      // And the payload itself, which this task threw away for its whole life
      // until live location needed it.
      //
      // This is the only path that survives what the feature is actually for:
      // the app off screen, swiped out of Recents, or killed by an OEM battery
      // manager while somebody is being followed home. A JS timer in the React
      // tree is gone in every one of those; this is not, because Android has
      // been told to keep the process for the service that produced the tick.
      //
      // Guarded separately from the flush above so that neither failure takes
      // the other with it -- a queued SOS must still leave the phone if the
      // position report cannot, and the reverse.
      try {
        const locs = data?.locations || [];
        if (locs.length) {
          const { tracking } = await reportFixes(locs);
          // The server decides when this stops, and it says so in the answer to
          // every fix. `tracking: null` is a window that has closed -- the
          // stand-down window ran out, or this emergency was resolved while
          // the phone was out of signal -- and the service goes back to its
          // idle rhythm rather than tracking somebody indefinitely because a
          // socket frame went missing.
          await syncTracking();
          if (!tracking) {
            console.log('[bgService] live location window closed, back to idle');
          }
        }
      } catch (e) {
        console.warn('[bgService] live location report failed', e?.message || e);
      }
    });
  } catch (e) {
    console.warn('[bgService] defineTask failed', e?.message || e);
  }
}

/** Why the last start/stop failed, for the Setup screen's diagnostics panel. */
let lastError = loadError;

export function backgroundWatchDiagnostics() {
  return {
    platform: Platform.OS,
    modulesLoaded: !!(TaskManager && Location),
    lastError,
  };
}

/**
 * Start the Android Foreground Service for Nigehban.
 * Displays a sticky persistent notification ("Nigehban is watching") that
 * prevents Android from sleeping the JS runtime, BLE link, or socket
 * heartbeats when the app is swiped away from Recents.
 */
export async function startBackgroundWatch() {
  if (Platform.OS !== 'android') return false; // iOS has no equivalent; web has no native service
  if (!Location || !TaskManager) {
    lastError = loadError || 'expo-location / expo-task-manager not available in this build';
    console.warn('[bgService] startBackgroundWatch: modules missing —', lastError);
    return false;
  }

  try {
    const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
    if (fgStatus !== 'granted') {
      lastError = 'foreground location permission not granted';
      return false;
    }

    // Best-effort: "Allow all the time" makes the service far more durable,
    // but foreground service options alone still raise the sticky
    // notification even if the user only granted "while using the app".
    await Location.requestBackgroundPermissionsAsync();

    const isRunning = await Location.hasStartedLocationUpdatesAsync(TASK_NAME);
    if (!isRunning) {
      await Location.startLocationUpdatesAsync(TASK_NAME, {
        accuracy: Location.Accuracy.Balanced,
        timeInterval: IDLE_INTERVAL_MS,
        // Zero, not 50 m. Android treats distanceInterval as a *floor* on
        // movement: with 50 m set, a phone sitting on a table never produces a
        // single tick, however long the interval. That was harmless while the
        // task did nothing, and is not now that the queued-SOS flush rides on
        // it -- somebody hiding still in a dead zone is precisely the person
        // whose alert must go out the moment signal returns.
        distanceInterval: 0,
        deferredUpdatesInterval: IDLE_INTERVAL_MS,
        foregroundService: {
          notificationTitle: 'Nigehban is watching',
          notificationBody: 'Band link and safety monitoring are active',
          notificationColor: '#3CC183',
        },
      });
    }

    // A cold start in the middle of an emergency.
    //
    // The service has just come up on its ordinary sixty-second rhythm, which
    // is right for an ordinary Tuesday and wrong for the case where the
    // process was killed while an alert was live and Android has only now
    // brought it back. The plan is on disk -- that is why it is written there
    // -- so this asks it what rhythm is actually owed and reconfigures if the
    // answer is not the one already running. A no-op when nothing is being
    // tracked, which is nearly always.
    try {
      if (await currentPlan()) await syncTracking();
    } catch { /* the next fix, or the next foreground, tries again */ }

    lastError = null;
    return true;
  } catch (e) {
    lastError = e?.message || String(e);
    console.warn('[bgService] startBackgroundWatch failed —', lastError);
    return false;
  }
}

/**
 * Bring the service in line with whether this phone is acting as a safety
 * device right now.
 *
 * It used to be tied to "is someone signed in", which is the wrong question --
 * a family member watching from across town got a permanent service, a sticky
 * notification and the ACCESS_BACKGROUND_LOCATION prompt for nothing, since
 * their emergencies arrive by push and push works with the app dead.
 *
 * "Does this phone want a band" is also the wrong question, and more
 * dangerously so: an armed phone in virtual mode has no band at all, and its
 * heartbeat is the only thing standing between it and the server telling the
 * whole family its wearer has gone silent. App.js owns that decision; see the
 * effect there for both conditions.
 *
 * `shouldRun` is deliberately a strict tri-state rather than anything truthy:
 *
 *   true  -- this phone is holding a link or is armed; service up
 *   false -- neither; service down
 *   null  -- could not tell (see band.js wantsBand); change nothing
 *
 * The null case is the one that matters. Treating "don't know" as false would
 * stop the service, kill the process and drop a live BLE link on nothing worse
 * than a transient AsyncStorage error. Leaving a service up one cycle too long
 * costs a notification; taking it down wrongly costs the emergency path, so
 * this fails in the first direction on purpose.
 *
 * Idempotent: both start and stop already check the current state, so calling
 * this on every render pass or status change is free.
 */
export async function syncBackgroundWatch(shouldRun) {
  if (Platform.OS !== 'android') return false;
  if (shouldRun === null || shouldRun === undefined) return false;
  return shouldRun ? startBackgroundWatch() : stopBackgroundWatch();
}

/**
 * Is the foreground service actually running right now? Used by the Setup
 * screen so "is this working" can be answered without a new build.
 */
export async function isBackgroundWatchRunning() {
  if (Platform.OS !== 'android' || !Location) return false;
  try {
    return await Location.hasStartedLocationUpdatesAsync(TASK_NAME);
  } catch {
    return false;
  }
}

/**
 * Stop the Android Foreground Service.
 */
export async function stopBackgroundWatch() {
  if (Platform.OS !== 'android' || !Location) return false;

  try {
    const isRunning = await Location.hasStartedLocationUpdatesAsync(TASK_NAME);
    if (isRunning) {
      await Location.stopLocationUpdatesAsync(TASK_NAME);
    }
    return true;
  } catch (e) {
    lastError = e?.message || String(e);
    return false;
  }
}
