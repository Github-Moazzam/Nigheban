import { Platform, Vibration } from 'react-native';
import NativeAlarm from '../modules/nigehban-alarm';

/**
 * One way to raise an alarm, three things it might actually do.
 *
 * On a development or production build this is the native module: a real
 * full-screen intent over the lock screen, and a looping siren on the alarm
 * stream (N3.3 + N3.4). In Expo Go and on web the native module is absent, and
 * this degrades to the repeating vibration the app already used -- which is not
 * a lock-screen takeover and is not pretended to be. `alarmCapability()` says
 * which one is in force, so the Setup screen can show it rather than leave
 * somebody to discover the difference during an emergency.
 *
 * Everything here is deliberately failure-tolerant. An alarm that throws is an
 * alarm that did not sound, so each path is wrapped and the vibration fallback
 * runs regardless of what the native side did.
 */

/** Matches the native SIREN_PATTERN, so the two feel like one product. */
const SIREN_PATTERN = [0, 500, 200, 500, 200, 500, 900];

let lastError = null;

export function alarmCapability() {
  if (Platform.OS === 'web') return { level: 'none', native: false, reason: 'web has no alarm stream or lock screen' };
  if (!NativeAlarm) {
    return {
      level: 'vibration',
      native: false,
      reason: Platform.OS === 'android'
        ? 'running in Expo Go — the native alarm is only in a development build'
        : 'the lock-screen takeover is Android-only',
    };
  }
  return { level: 'takeover', native: true, reason: null, lastError };
}

/**
 * Take over the screen for an incoming severity-4-or-worse alert.
 *
 * `alert` is the row the server sent, straight off the socket or rebuilt from a
 * push payload. Calling it twice for the same alert is safe and expected: the
 * socket and the push race each other by design, and whichever arrives first
 * wins without the second one producing a second siren.
 */
export async function presentAlarm(alert) {
  const title = alarmTitle(alert);
  const body = alert?.maps
    ? 'Tap to see where they are.'
    : 'Open Nigehban now.';

  // The vibration goes first and unconditionally. It is the one part that works
  // in every environment, and if the native call below throws it is all there
  // is -- so it must not be downstream of it.
  try {
    Vibration.vibrate(SIREN_PATTERN, true);
  } catch { /* some web browsers have no vibration API at all */ }

  if (!NativeAlarm) return false;
  try {
    await NativeAlarm.presentAlarm(title, body, String(alert?.id ?? ''));
    lastError = null;
    return true;
  } catch (e) {
    lastError = e?.message || String(e);
    console.warn('[alarm] presentAlarm failed —', lastError);
    return false;
  }
}

/**
 * Stop the alarm, because a person answered it.
 *
 * Called from every exit out of the takeover -- "I'M ON IT", "Dismiss", and the
 * `resolved` socket frame when the wearer stands the alert down themselves.
 * Missing one of those is how a siren outlives the emergency, so the rule is
 * that anything which closes the takeover calls this.
 */
export async function stopAlarm() {
  try {
    Vibration.cancel();
  } catch { /* nothing to cancel */ }

  if (!NativeAlarm) return false;
  try {
    await NativeAlarm.stopAlarm();
    return true;
  } catch (e) {
    lastError = e?.message || String(e);
    return false;
  }
}

/**
 * The alert id that launched this process from the lock screen, once.
 *
 * Separate from `subscribeNotificationTaps` in notifications.js because it is a
 * separate mechanism: that one reads a tap on an `expo-notifications` push,
 * this one reads the intent extra a full-screen intent launched us with. Both
 * feed the same `pendingAlertId` in App.js, and either may be the one that
 * fires depending on whether the screen was locked.
 */
export async function consumeLaunchAlertId() {
  if (!NativeAlarm) return null;
  try {
    return await NativeAlarm.consumeLaunchAlertId();
  } catch {
    return null;
  }
}

function alarmTitle(alert) {
  const who = alert?.user?.name || 'Family member';
  switch (alert?.kind) {
    case 'sos':    return `EMERGENCY SOS — ${who}`;
    case 'snatch': return `BAND TORN OFF — ${who}`;
    case 'fall':   return `FALL DETECTED — ${who}`;
    default:       return `EMERGENCY — ${who}`;
  }
}
