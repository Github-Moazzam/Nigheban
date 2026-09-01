import { Platform } from 'react-native';
import NativeBandWake from '../modules/nigehban-bandwake';

/**
 * THE BAND'S OWN WAY IN — SWITCHED OFF. See docs/BAND_WAKE_DISABLED.md.
 *
 * ---------------------------------------------------------------------------
 * TURNED OFF ON PURPOSE, 1 Sep 2026. Nothing here is deleted; the whole feature
 * hangs off `BAND_WAKE_ENABLED` below, and flipping it back to `true` (together
 * with `BandWake.FEATURE_ENABLED` on the Kotlin side and the commented-out
 * effects in App.js) restores it exactly as it was.
 *
 * Why: it wakes a phone whose app is not running, and on the reporter's Android
 * 8 Vivo it wakes other apps with it (BUG-018). Worse, the wake carries no band
 * identity, so one band's press is accepted by *every* Nigehban phone in range
 * — an emergency raised on a stranger's account, to a stranger's family, with a
 * stranger's location (BUG-012), and that same press then silently swallows the
 * second wearer's own SOS (BUG-013). Those two are Critical and they need a
 * band id in the advertisement, which means new firmware in the field before
 * the path can be trusted again.
 *
 * The trade being accepted: on an OEM that runs `kill -9` on a Recents swipe,
 * a press with the app killed now reaches nobody. That is the pre-existing
 * behaviour this feature was written to fix, and it is the deliberate choice —
 * a press that goes nowhere is better than a press that pages the wrong family
 * and eats the right one. The band must be treated as working only while the
 * app or its foreground service is alive.
 * ---------------------------------------------------------------------------
 *
 * What it did, kept for whoever turns it back on: every other path an SOS can
 * take needs this app to be alive. The GATT link dies with the process; so does
 * the socket, and so does the retry loop that would rebuild them. On a Vivo, an
 * Oppo, a Xiaomi or a Transsion phone, one swipe on the Recents screen ends the
 * process with `kill -9`, and from that moment the wearer is carrying a band
 * that cannot reach anybody.
 *
 * This was the path that did not need us. The band puts an SOS flag in its
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

/**
 * The one switch. `false` disables the band's beacon wake everywhere in JS.
 *
 * The Kotlin side has its own — `BandWake.FEATURE_ENABLED` — and it has to be
 * flipped too. Two switches rather than one because they guard different
 * things: this one stops the app *asking* to be woken, and the native one stops
 * the OS *delivering* a wake that was registered by an older build, re-armed by
 * `BandWakeBootReceiver` after a reboot, or a Bluetooth toggle. Neither is
 * sufficient alone.
 */
const BAND_WAKE_ENABLED = false;

/** The reason handed back to callers, so a diagnostics screen can say it out loud. */
const DISABLED_REASON = 'band beacon wake is switched off (see docs/BAND_WAKE_DISABLED.md)';

/** Whether this build and this phone can be woken by the band at all. */
export function bandWakeAvailable() {
  if (!BAND_WAKE_ENABLED) return false;
  return Platform.OS === 'android' && !!NativeBandWake;
}

/**
 * Arm the scan.
 *
 * Idempotent -- the native side replaces its registration rather than stacking
 * a second one -- so callers may fire this on every band-state change without
 * keeping count. Returns null on success, or a reason worth showing.
 *
 * While disabled this *disarms* instead. A phone upgrading from a build that
 * had the feature on carries a live registration in the Bluetooth stack and an
 * `armed` flag in SharedPreferences that `BandWakeBootReceiver` would act on;
 * leaving the call to do nothing would leave both in place. So the one call
 * site that used to arm is what now cleans up after the old build.
 */
export async function startBandWake() {
  if (!NativeBandWake) return 'the band wake is not in this build';
  if (!BAND_WAKE_ENABLED) {
    await stopBandWake();
    return DISABLED_REASON;
  }
  try {
    return await NativeBandWake.start();
  } catch (e) {
    return e?.message || String(e);
  }
}

/** Deliberately still live while disabled -- see `startBandWake` above. */
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
 *
 * While disabled this returns null without reading storage. A pending press
 * written down by an older build is left where it is rather than being raised
 * on the first launch after the update -- an alert fired hours late, out of a
 * feature the wearer no longer has, would page a family about nothing.
 */
export async function consumePendingBandSos() {
  if (!NativeBandWake || !BAND_WAKE_ENABLED) return null;
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
  if (!BAND_WAKE_ENABLED) return () => {};
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
  if (!BAND_WAKE_ENABLED) {
    return { supported: false, armed: false, lastError: DISABLED_REASON };
  }
  try {
    return await NativeBandWake.diagnostics();
  } catch (e) {
    return { supported: false, armed: false, lastError: e?.message || String(e) };
  }
}
