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
