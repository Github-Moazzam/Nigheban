import { Platform } from 'react-native';

const TASK_NAME = 'NIGEHBAN_BACKGROUND_WATCH';

let TaskManager = null;
let Location = null;

try {
  TaskManager = require('expo-task-manager');
  Location = require('expo-location');
} catch {
  /* web or environment without native location tasks */
}

// Define the background task if TaskManager is available
if (TaskManager && Location) {
  try {
    TaskManager.defineTask(TASK_NAME, async ({ data, error }) => {
      if (error) {
        return;
      }
      if (data) {
        const { locations } = data;
        // Background location tick received — keeps JS runtime alive & active
      }
    });
  } catch {
    /* task definition guard */
  }
}

/**
 * Start the Android Foreground Service for Nigehban.
 * Displays a sticky persistent notification ("Nigehban is watching · Band connected")
 * that prevents Android from sleeping the JS runtime, BLE link, or socket heartbeats.
 */
export async function startBackgroundWatch() {
  if (Platform.OS === 'web' || !Location || !TaskManager) return false;

  try {
    const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
    if (fgStatus !== 'granted') return false;

    const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
    // Proceed even if background location permission is not granted; foreground service options handles sticky notification

    const isRunning = await Location.hasStartedLocationUpdatesAsync(TASK_NAME);
    if (!isRunning) {
      await Location.startLocationUpdatesAsync(TASK_NAME, {
        accuracy: Location.Accuracy.Balanced,
        timeInterval: 60000, // 60 seconds interval
        distanceInterval: 50, // 50 meters
        deferredUpdatesInterval: 60000,
        foregroundService: {
          notificationTitle: '🛡️ NIGEHBAN IS WATCHING',
          notificationBody: 'Wristband link & safety monitoring active',
          notificationColor: '#63BE93',
        },
      });
    }
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Stop the Android Foreground Service.
 */
export async function stopBackgroundWatch() {
  if (Platform.OS === 'web' || !Location) return false;

  try {
    const isRunning = await Location.hasStartedLocationUpdatesAsync(TASK_NAME);
    if (isRunning) {
      await Location.stopLocationUpdatesAsync(TASK_NAME);
    }
    return true;
  } catch (e) {
    return false;
  }
}
