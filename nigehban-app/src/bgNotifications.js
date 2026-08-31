import { Platform } from 'react-native';
import { presentAlarm } from './alarm';
import { sendEmergencyAlarmNotification } from './notifications';

/**
 * The killed-app half of N3.3.
 *
 * `presentAlarm` needs JavaScript to be running, and the case the whole feature
 * exists for -- the family's phone locked on a bedside table, the app killed by
 * Android hours ago -- is exactly the case where it is not. A data-only push is
 * the one thing that starts it: Android hands the message to the app, Expo
 * spins up a headless JS runtime, this task runs, and it fires the full-screen
 * intent from there.
 *
 * Two constraints came out of the SDK 57 docs and shape everything below:
 *
 *   - Only a push carrying `data` and *no* `title`/`body` reaches this task
 *     when the app is terminated. A normal push with a title is shown by the
 *     system and the task is not run. That is why the server sends **two**
 *     pushes for a severity-4-or-worse alert (`nigehban_server.py`): a visible
 *     one, which guarantees something appears even if this path fails, and a
 *     silent one, which is what actually wakes the siren.
 *
 *   - "The OS may decide not to deliver the notification to your app in some
 *     cases", Doze being the usual one. So this is an upgrade to the push path,
 *     never a replacement for it. If it does not run, the visible notification
 *     is still sitting there to be tapped, and the tap routing added on
 *     26 Aug 2026 still opens the right alert.
 *
 * `defineTask` runs at module load, not inside `registerBackgroundNotifications`
 * -- same reason as `bgService.js`: when Android relaunches the runtime
 * headlessly, the task has to already be defined or the wake is wasted.
 */

const TASK_NAME = 'NIGEHBAN_BACKGROUND_NOTIFICATION';

let TaskManager = null;
let Notifications = null;
let loadError = null;

try {
  TaskManager = require('expo-task-manager');
  Notifications = require('expo-notifications');
} catch (e) {
  loadError = e?.message || String(e);
}

let lastError = loadError;
let lastFiredAt = null;
let registered = false;

export function backgroundNotificationDiagnostics() {
  return { registered, lastFiredAt, lastError };
}

/**
 * Dig the alert out of whatever shape the payload arrives in.
 *
 * Expo wraps the FCM message differently depending on platform and on whether
 * the runtime was already alive, and the server spells the key `alert_id`
 * while the app's own local notifications spell it `alertId`. Guessing wrong
 * here means a silent push that wakes the phone and then does nothing, so all
 * the known shapes are tried rather than one being assumed.
 */
function extractAlert(payload) {
  const candidates = [];

  // The shape that matters, and the one this originally missed.
  //
  // For a *headless* background notification -- the killed-app case this whole
  // file exists for -- expo-notifications' own `NotificationTaskPayload` says
  // `notification` is null and the data payload arrives as a JSON **string** in
  // `data.dataString`. Nothing in the SDK parses it for us. Android's
  // NotificationSerializer writes it that way for anything sent through the
  // Expo push service, because the FCM message's `body` key holds the data as
  // JSON rather than as fields.
  for (const s of [
    payload?.data?.dataString,
    payload?.notification?.request?.content?.dataString,
  ]) {
    if (typeof s === 'string') {
      try { candidates.push(JSON.parse(s)); } catch { /* not JSON after all */ }
    }
  }

  // The already-running shapes, where the data survives as an object.
  candidates.push(
    payload?.notification?.request?.content?.data,
    payload?.data?.notification?.request?.content?.data,
    payload?.data?.notification?.data,
    payload?.notification?.data,
    payload?.data,
    payload,
  );

  // Every candidate is tried for an alert id rather than the first non-null one
  // being taken and trusted. That is the difference between this and the
  // version it replaces: `payload.data` is *always* truthy, so a chain of `??`
  // stopped there and reported "no alert" for every push a closed app ever got.
  for (const d of candidates) {
    if (!d || typeof d !== 'object') continue;
    const id = d.alert_id ?? d.alertId;
    if (id == null) continue;
    return {
      id,
      severity: Number(d.severity ?? 0),
      kind: d.kind || 'sos',
      maps: d.maps || null,
      user: { name: d.name || d.user_name || 'Family member' },
    };
  }
  return null;
}

/**
 * The floor under a takeover that did not happen.
 *
 * `presentAlarm` returning false means the native module was not in this
 * binary, so all it managed was `Vibration.vibrate` -- and a vibration started
 * from a headless task stops when Android tears that task down a few seconds
 * later. Without this, the killed-app path could end in nothing at all, which
 * is the one outcome the whole feature exists to prevent.
 *
 * It checks what is already on screen rather than firing blind. The server
 * sends a visible push alongside the silent one precisely so something appears
 * when this task does not run, and both land on the same emergency channel --
 * posting unconditionally would give one emergency two identical
 * notifications.
 *
 * The check can still lose a race, because the two pushes arrive independently
 * and the visible one may not be posted yet. That is the direction chosen on
 * purpose: when it is not knowable, a duplicate is preferred over a silence.
 * Two notifications is a nuisance; none is the product failing.
 */
async function notifyIfNothingShown(alert) {
  try {
    const presented = await Notifications.getPresentedNotificationsAsync();
    const already = presented.some((n) => {
      const d = n?.request?.content?.data ?? {};
      return String(d.alert_id ?? d.alertId ?? '') === String(alert.id);
    });
    if (already) return;
  } catch {
    /* cannot tell what is on screen -- fall through and post */
  }
  await sendEmergencyAlarmNotification(alert);
}

if (TaskManager && Notifications) {
  try {
    TaskManager.defineTask(TASK_NAME, async ({ data, error }) => {
      if (error) {
        lastError = error.message || String(error);
        return;
      }
      try {
        const alert = extractAlert(data);
        // Anything below severity 4 is informational. Taking the screen over
        // for a low-battery notice is how a family learns to swipe the
        // takeover away without reading it.
        if (!alert || alert.severity < 4) return;
        lastFiredAt = Date.now();
        if (await presentAlarm(alert)) return;
        await notifyIfNothingShown(alert);
      } catch (e) {
        lastError = e?.message || String(e);
      }
    });
  } catch (e) {
    lastError = e?.message || String(e);
  }
}

/** Idempotent; safe to call on every session change. */
export async function registerBackgroundNotifications() {
  if (Platform.OS !== 'android') return false;
  if (!TaskManager || !Notifications) {
    lastError = loadError || 'expo-task-manager / expo-notifications not in this build';
    return false;
  }
  try {
    if (await TaskManager.isTaskRegisteredAsync(TASK_NAME)) {
      registered = true;
      return true;
    }
    await Notifications.registerTaskAsync(TASK_NAME);
    registered = true;
    lastError = null;
    return true;
  } catch (e) {
    lastError = e?.message || String(e);
    registered = false;
    console.warn('[bgNotifications] registerTaskAsync failed —', lastError);
    return false;
  }
}
