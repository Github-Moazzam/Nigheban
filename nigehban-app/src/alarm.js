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
 * Whether Android will still honour a full-screen intent from this app.
 *
 * Since Android 14 the `USE_FULL_SCREEN_INTENT` permission is no longer granted
 * at install to anything that is not a calling or alarm-clock app. Declaring it
 * in the manifest is necessary and no longer sufficient. When it is missing,
 * `setFullScreenIntent` does not fail -- it quietly degrades to an ordinary
 * heads-up notification, which looks like the alarm simply not working.
 *
 * Returns true/false, or null where the question does not apply (Android 13 and
 * below, Expo Go, web) so a caller can tell "not allowed" from "not asked".
 */
export async function fullScreenIntentAllowed() {
  if (!NativeAlarm?.canUseFullScreenIntent) return null;
  try {
    return await NativeAlarm.canUseFullScreenIntent();
  } catch {
    return null;
  }
}

/** Open the one Settings page that can grant the above. */
export async function openFullScreenIntentSettings() {
  if (!NativeAlarm?.openFullScreenIntentSettings) return false;
  try {
    return await NativeAlarm.openFullScreenIntentSettings();
  } catch {
    return false;
  }
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
 * What this launch was about — `{ id, answered }`, or null.
 *
 * Separate from `subscribeNotificationTaps` in notifications.js because it is a
 * separate mechanism: that one reads a tap on an `expo-notifications` push,
 * this one reads the intent extra the alarm notification launched us with. Both
 * feed the same `pendingAlertId` in App.js, and either may be the one that
 * fires depending on whether the screen was locked.
 *
 * `answered` distinguishes the notification's own I'M ON IT button from merely
 * opening the app to look. It is the one thing that cannot be worked out on
 * this side, and it is what App.js sends the ack on.
 *
 * Must be called on every resume, not only at boot. Android delivers the intent
 * to `onNewIntent` when the app is already running, and an app that only asks
 * once comes to the front on Home with the siren still going.
 */
export async function consumeLaunchAlertId() {
  if (!NativeAlarm) return null;
  try {
    return normalise(await NativeAlarm.consumeLaunchAlertId());
  } catch {
    return null;
  }
}

/**
 * The alert a siren is sounding for right now, or null.
 *
 * The case neither of the two above covers: the app opened from the launcher
 * icon or the recents list while the alarm is going. No intent carries an alert
 * id there, so without this the app comes up on Home, screaming, with nothing
 * on screen that can stop it.
 */
export async function activeAlarm() {
  if (!NativeAlarm?.activeAlertId) return null;
  try {
    const id = await NativeAlarm.activeAlertId();
    return id == null ? null : { id: String(id), answered: false };
  } catch {
    return null;
  }
}

/** Both shapes the native side has ever returned, as one. */
function normalise(hit) {
  if (hit == null) return null;
  // A bare string is what builds before the answer button returned. Keeping it
  // readable means a JS bundle can update ahead of the binary without the
  // launch routing silently going dead.
  if (typeof hit === 'string' || typeof hit === 'number') {
    return { id: String(hit), answered: false };
  }
  if (hit.alertId == null) return null;
  return { id: String(hit.alertId), answered: !!hit.answered };
}

function alarmTitle(alert) {
  const who = alert?.user?.name || 'Family member';
  switch (alert?.kind) {
    case 'sos':    return `EMERGENCY SOS — ${who}`;
    case 'snatch': return `BAND TORN OFF — ${who}`;
    case 'fall':   return `FALL DETECTED — ${who}`;
    // Named as a road accident and not as a fall. A family member reading
    // "fall" pictures a room; what they need to picture is a carriageway,
    // because it changes who they call and how fast they leave.
    case 'accident': return `ROAD ACCIDENT — ${who}`;
    default:       return `EMERGENCY — ${who}`;
  }
}
