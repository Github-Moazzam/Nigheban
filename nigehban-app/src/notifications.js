import { Platform } from 'react-native';
import { call } from './api';

let Notifications = null;
let Constants = null;
try {
  Notifications = require('expo-notifications');
} catch {
  /* Notifications module fallback */
}
try {
  Constants = require('expo-constants');
} catch {
  /* projectId lookup falls back to the implicit resolution below */
}

export const EMERGENCY_CHANNEL_ID = 'nigehban_emergency_alarm';

/** Set by registerPushToken; read by the Setup screen's diagnostics panel. */
let lastToken = null;
let lastError = null;

export function pushDiagnostics() {
  return { token: lastToken, error: lastError };
}

/**
 * Register Expo Push Token with backend server (POST /device).
 * Allows server to send Remote Push Notifications when app is completely
 * closed — this is the ONLY delivery path that survives a force-stop, and it
 * only works once the project has real FCM (V1) credentials uploaded via
 * `eas credentials`; without that, getExpoPushTokenAsync() throws or the
 * token exists but Expo's push API rejects every send.
 *
 * Returns the token string on success, or null (with the reason recorded in
 * pushDiagnostics()) on failure.
 */
export async function registerPushToken(session) {
  if (!Notifications || !session || Platform.OS === 'web') {
    lastError = !Notifications ? 'expo-notifications not available in this build' : 'no session';
    return null;
  }

  try {
    const { status } = await Notifications.getPermissionsAsync();
    let finalStatus = status;
    if (status !== 'granted') {
      const { status: reqStatus } = await Notifications.requestPermissionsAsync();
      finalStatus = reqStatus;
    }
    if (finalStatus !== 'granted') {
      lastError = 'notification permission not granted';
      return null;
    }

    const projectId = Constants?.default?.expoConfig?.extra?.eas?.projectId
      || Constants?.expoConfig?.extra?.eas?.projectId;
    const tokenData = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined
    );
    if (tokenData && tokenData.data) {
      lastToken = tokenData.data;
      lastError = null;
      await call(session, '/device', {
        method: 'POST',
        body: {
          id: tokenData.data,
          push_token: tokenData.data,
          platform: Platform.OS,
        },
      });
      return tokenData.data;
    }
    lastError = 'getExpoPushTokenAsync returned no token';
  } catch (e) {
    lastError = e?.message || String(e);
    console.warn('[notifications] registerPushToken failed —', lastError);
  }
  return null;
}

/**
 * Initialize high-priority system notification channels on Android/iOS.
 * Configures the MAX importance emergency channel with siren sound, DND bypass, and strong vibration.
 */
export async function setupNotificationChannels() {
  if (!Notifications || Platform.OS === 'web') return false;

  try {
    // Request system notification permissions
    const permissions = await Notifications.getPermissionsAsync();
    if (!permissions.granted) {
      await Notifications.requestPermissionsAsync();
    }

    if (Platform.OS === 'android') {
      // Configure high-priority Emergency SOS channel
      await Notifications.setNotificationChannelAsync(EMERGENCY_CHANNEL_ID, {
        name: 'Emergency SOS Alarms',
        description: 'Critical high-priority siren alarms for family emergency SOS alerts.',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 500, 200, 500, 200, 500],
        enableVibrate: true,
        enableLights: true,
        lightColor: '#F2645A',   // C.red, so the LED matches the app's own danger tone
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
        bypassDnd: true, // Override Do Not Disturb mode for critical SOS
        sound: 'default', // Plays max volume system alarm sound
      });

      // Configure default notification channel for check-ins
      await Notifications.setNotificationChannelAsync('nigehban_default', {
        name: 'General Safety Check-ins',
        importance: Notifications.AndroidImportance.DEFAULT,
        vibrationPattern: [0, 200, 100, 200],
        enableVibrate: true,
      });
    }

    // Configure notification handler for foreground/background behavior
    Notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        const data = notification.request.content.data;
        const isEmergency = data && data.severity >= 5;

        return {
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: true,
          shouldSetBadge: false,
          priority: isEmergency
            ? Notifications.AndroidNotificationPriority.MAX
            : Notifications.AndroidNotificationPriority.HIGH,
        };
      },
    });

    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Dispatch a high-priority Emergency Siren Notification for incoming Severity 5 SOS alerts.
 */
export async function sendEmergencyAlarmNotification(alert) {
  if (!Notifications || Platform.OS === 'web') return false;

  try {
    const isSos = alert.kind === 'sos';
    const isSnatch = alert.kind === 'snatch';

    const title = isSos
      ? `EMERGENCY SOS — ${alert.user?.name || 'Family Member'}`
      : isSnatch
      ? `BAND TORN OFF — ${alert.user?.name || 'Family Member'}`
      : `FALL DETECTED — ${alert.user?.name || 'Family Member'}`;

    const body = alert.maps
      ? 'CRITICAL ALERT! Tap immediately to view live location on map.'
      : 'CRITICAL ALERT! Open Nigehban immediately for emergency details.';

    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        sound: true,
        priority: Notifications.AndroidNotificationPriority.MAX,
        categoryIdentifier: 'emergency',
        data: {
          alertId: alert.id,
          severity: alert.severity || 5,
          maps: alert.maps,
        },
      },
      trigger: null, // Instant dispatch
    });

    return true;
  } catch (e) {
    return false;
  }
}
