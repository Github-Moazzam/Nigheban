import AsyncStorage from '@react-native-async-storage/async-storage';
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

const INSTALL_ID_KEY = 'nigehban.installId';

/** Set by registerPushToken; read by the Setup screen's diagnostics panel. */
let lastToken = null;
let lastError = null;
let registered = false;

export function pushDiagnostics() {
  return { token: lastToken, error: lastError, registered };
}

/**
 * A stable id for this install, minted once and kept.
 *
 * It deliberately is not the push token. Two reasons, and the first one is why
 * no alert ever reached a closed phone: the server validated the install id as
 * [A-Za-z0-9_.:-]{8,64}, and "ExponentPushToken[…]" fails on the brackets, so
 * every registration came back 400 and the devices table stayed empty. The
 * server now tolerates that old shape so already-installed builds recover, but
 * tolerating it is not a reason to keep sending it.
 *
 * The second reason outlives that bug. The push token rotates — on reinstall,
 * on restore, whenever FCM decides. Keyed on the token, each rotation inserts a
 * second device row and leaves the old one holding a token that no longer
 * delivers. Keyed on the install, the same row is updated in place.
 */
async function installId() {
  try {
    const saved = await AsyncStorage.getItem(INSTALL_ID_KEY);
    if (saved) return saved;
  } catch {
    /* unreadable storage — mint a fresh one rather than fail the registration */
  }
  const id = 'ins-'
    + Date.now().toString(36)
    + Math.random().toString(36).slice(2, 10)
    + Math.random().toString(36).slice(2, 10);
  try { await AsyncStorage.setItem(INSTALL_ID_KEY, id); } catch { /* non-fatal */ }
  return id;
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
    registered = false;
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
      registered = false;
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
      // Holding "registered" false until the POST comes back is the point.
      // Recording success as soon as the token existed is what made the
      // diagnostics panel show a green "registered" chip for months while the
      // server was rejecting every one of these calls.
      registered = false;
      await call(session, '/device', {
        method: 'POST',
        body: {
          id: await installId(),
          push_token: tokenData.data,
          platform: Platform.OS,
          os_version: String(Platform.Version ?? ''),
          app_version: Constants?.default?.expoConfig?.version
            || Constants?.expoConfig?.version
            || '',
        },
      });
      registered = true;
      return tokenData.data;
    }
    lastError = 'getExpoPushTokenAsync returned no token';
  } catch (e) {
    lastError = e?.message || String(e);
    registered = false;
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
 * Route a tapped notification back to the alert it was about.
 *
 * The remote push the server sends to a killed app carries `alert_id`
 * (`nigehban_server.py`'s `send_expo_push_notifications` calls), while the
 * local notification this app schedules for itself while alive carries
 * `alertId` (`sendEmergencyAlarmNotification` below) — both are read here so
 * a tap routes the same way regardless of which path delivered it.
 *
 * `onAlertId` fires for a tap on a running app (the normal listener) and,
 * separately, for the notification that cold-launched the app — Expo does
 * not always replay the launch tap through the live listener, so that case
 * is checked once explicitly.
 */
export function subscribeNotificationTaps(onAlertId) {
  if (!Notifications || Platform.OS === 'web') return () => {};

  const extract = (response) => {
    const data = response?.notification?.request?.content?.data;
    const id = data?.alertId ?? data?.alert_id;
    if (id != null) onAlertId(id);
  };

  Notifications.getLastNotificationResponseAsync()
    .then((response) => {
      if (!response) return;
      extract(response);
      // Without this, the tap that cold-launched the app keeps being "the
      // last response" and would reopen the same alert on every future
      // launch, including ones that had nothing to do with a notification.
      Notifications.clearLastNotificationResponseAsync?.().catch(() => {});
    })
    .catch(() => { /* best effort */ });

  const sub = Notifications.addNotificationResponseReceivedListener(extract);
  return () => sub.remove();
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
