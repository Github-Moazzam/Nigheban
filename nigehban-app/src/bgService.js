import { Platform } from 'react-native';

const TASK_NAME = 'NIGEHBAN_BACKGROUND_WATCH';

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
    TaskManager.defineTask(TASK_NAME, async ({ error }) => {
      if (error) {
        console.warn('[bgService] task error', error.message);
      }
      // No-op beyond the tick itself: the point of this task is the Android
      // foreground service + wake it creates, not the location payload.
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
        timeInterval: 60000, // 60 seconds interval
        distanceInterval: 50, // 50 meters
        deferredUpdatesInterval: 60000,
        foregroundService: {
          notificationTitle: 'Nigehban is watching',
          notificationBody: 'Band link and safety monitoring are active',
          notificationColor: '#3CC183',
        },
      });
    }
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
