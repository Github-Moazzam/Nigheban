import { Platform } from 'react-native';
import NativeBandWake from '../modules/nigehban-bandwake';

/**
 * THE BAND'S OWN WAY IN.
 *
 * Every other path an SOS can take needs this app to be alive. The GATT link
 * dies with the process; so does the socket, and so does the retry loop that
 * would rebuild them. On a Vivo, an Oppo, a Xiaomi or a Transsion phone, one
 * swipe on the Recents screen ends the process with `kill -9`, and from that
 * moment the wearer is carrying a band that cannot reach anybody.
 *
 * This is the path that does not need us. The band puts an SOS flag in its
 * advertisement, Android's Bluetooth controller matches it against a filter we
 * registered with the *system*, and the OS starts the app to deliver it. See
 * `modules/nigehban-bandwake/.../BandWake.kt` for why each piece is shaped the
 * way it is, and `nigehban_band_nrf52.ino` for the six bytes on the wire.
 *
 * Everything here degrades to a no-op rather than throwing. The module is
 * Android-only and lives in the app binary, so it is absent in Expo Go and on
 * web, and a safety feature that takes the app down when it is missing is worse
 * than one that is missing.
 */

/** Whether this build and this phone can be woken by the band at all. */
export function bandWakeAvailable() {
  return Platform.OS === 'android' && !!NativeBandWake;
}

/**
 * Arm the scan.
 *
 * Idempotent -- the native side replaces its registration rather than stacking
 * a second one -- so callers may fire this on every band-state change without
 * keeping count. Returns null on success, or a reason worth showing.
 */
export async function startBandWake() {
  if (!NativeBandWake) return 'the band wake is not in this build';
  try {
    return await NativeBandWake.start();
  } catch (e) {
    return e?.message || String(e);
  }
}

export async function stopBandWake() {
  if (!NativeBandWake) return false;
  try {
    await NativeBandWake.stop();
    return true;
  } catch {
    return false;
  }
}

/**
 * A press that arrived while this app was not running, exactly once.
 *
 * Returns `{ seq, at, address, rssi, ageMs, stale }` or null. Read-and-clear on
 * the native side, so a press is never raised twice -- and so a stale one does
 * not sit there re-raising itself on every launch for the rest of the week.
 *
 * `stale` is the native side's judgement that the press is too old to act on
 * unasked (half an hour). It is returned rather than filtered because the
 * wearer still needs telling that it happened; only the automatic escalation is
 * withheld.
 */
export async function consumePendingBandSos() {
  if (!NativeBandWake) return null;
  try {
    return await NativeBandWake.consumePendingSos();
  } catch {
    return null;
  }
}

/**
 * A press arriving while JavaScript happens to be running.
 *
 * This is the band going out of range rather than the app being killed, and it
 * is the better case: there is no notification and nothing to tap, the alert
 * simply goes. Returns an unsubscribe function.
 */
export function subscribeBandSos(onSos) {
  if (!NativeBandWake?.addListener) return () => {};
  try {
    const sub = NativeBandWake.addListener('onBandSos', onSos);
    return () => { try { sub.remove(); } catch { /* already gone */ } };
  } catch {
    return () => {};
  }
}

/** For the Setup screen, so "is this actually working" can be answered. */
export async function bandWakeDiagnostics() {
  if (!NativeBandWake) {
    return { supported: false, armed: false, lastError: 'not in this build' };
  }
  try {
    return await NativeBandWake.diagnostics();
  } catch (e) {
    return { supported: false, armed: false, lastError: e?.message || String(e) };
  }
}
