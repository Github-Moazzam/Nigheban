import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';

export const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';  // phone -> band
export const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';  // band -> phone
// Every band answers to `Nigehban-<serial>`, so pinning the match to one exact
// string only ever finds one board. The firmware bumped to Nigehban-02 and the
// app went blind on a name compare -- nRF Connect kept seeing the band the
// whole time, because nRF Connect filters on nothing.
export const BAND_PREFIX = 'Nigehban-';

// How long to look before admitting the band is not there. A BLE scan has no
// natural end: if the band is off, out of range, or already bonded to another
// phone, startDeviceScan simply never calls back, and the UI sat on "scanning"
// forever with nothing to press. Ten seconds is long enough for a band that is
// advertising on a 1 s interval and short enough to be worth waiting through.
const SCAN_TIMEOUT_MS = 10000;
// The wait before the first retry. Every subsequent failure doubles it up to
// RETRY_MAX_MS, and a link that comes up resets it -- see retrySoon().
//
// It used to be a flat 3 s, which is what turned Android's scan throttle from a
// thirty-second pause into a permanent state. A throttled scan fails
// *immediately* rather than running for SCAN_TIMEOUT_MS, so the cycle collapsed
// from ~13 s to ~3 s -- about ten scan starts per thirty seconds, twice the
// limit that caused the throttle in the first place. The app re-armed it
// forever, and the two errors that reached the screen ("Undocumented scan
// throttle", then "application registration failed") were the Bluetooth stack
// refusing us harder each time round.
const RETRY_MS = 3000;
// Two ceilings, because the two ways back to a band cost wildly different
// things. A scan is rationed by the OS and is what this whole mechanism exists
// to protect, so it backs all the way off. Going straight at a band we have
// linked to before is one connection attempt against a known address: it
// spends no scan budget, and on a device somebody is wearing for their safety,
// "reconnects within fifteen seconds of the band coming back" is the property
// that matters more than the handful of milliwatts it costs to keep asking.
const RETRY_MAX_MS = 60000;
const RETRY_MAX_KNOWN_MS = 15000;

// Android's own rule, from AppScanStats: an app that starts more than five
// scans inside any thirty-second window is "scanning too frequently", and the
// OS quietly stops delivering results. The budget here is four rather than
// five so a retry landing on the boundary cannot trip it.
const SCAN_WINDOW_MS = 30000;
const SCAN_BUDGET = 4;

// What to wait when the stack says it has throttled us but we cannot read a
// suggested time out of the message: one full window, plus a margin.
const THROTTLE_COOLDOWN_MS = 35000;

// SCAN_FAILED_APPLICATION_REGISTRATION_FAILED -- the scanner client could not
// be registered with the Bluetooth stack at all, usually because registrations
// were leaked by exactly the start/stop churn described above. Another scan
// cannot fix it, so back off hard and tell the user the thing that can.
const BT_STUCK_COOLDOWN_MS = 60000;
// Two and a half of the firmware's 10 s heartbeats: long enough to ride out a
// missed one, short enough that a dead subscription is caught rather than worn.
const DATA_TIMEOUT_MS = 25000;
// Going straight at a band we have linked to before either works quickly or is
// not going to work at all -- the band is off, or out of range. Cap it well
// under the scan timeout so the fallback scan still gets its full ten seconds.
const DIRECT_TIMEOUT_MS = 6000;

// Written the first time a band is linked and cleared only when the user
// presses DISCONNECT. Its presence is the standing instruction "this phone
// wants that band", and its value is the id to go back to -- together they are
// what lets a cold start re-link with nothing pressed.
const LINK_KEY = 'nigehban.band.id';

// react-native-ble-plx is a native module. Expo Go cannot load it, so the app
// falls back to a simulated band there -- that way login, family and alerts are
// all testable today while the real dev build is still cooking.
let BleManager = null;
let ScanMode = null;
let bleError = null;
try {
  const plx = require('react-native-ble-plx');
  BleManager = plx.BleManager;
  ScanMode = plx.ScanMode;
} catch (e) {
  bleError = 'module not bundled';
}

// ------------------------------------------------------- PROCESS-WIDE LINK ---
// A BLE link belongs to the Android *process*, not to a React tree. Android
// tears this component down and rebuilds it for things that have nothing to do
// with the user being finished with the band -- rotating the screen, a config
// change, the activity being recycled while the foreground service keeps the
// process alive, coming back to an app that was off screen. Anything kept in a
// useRef dies with the tree; a manager rebuilt on the next mount is a *second*
// native client that cannot see the first one's connection, so the link is both
// lost and leaked.
//
// Module scope is the same lifetime as the link itself, so that is where these
// live. They are released by disconnect(), or by Android when the process
// finally dies -- and by nothing else.
let manager = null;
let linked = null;        // the connected Device, or null
let notifySub = null;     // notify subscription on NUS_TX
let dropSub = null;       // onDisconnected listener

// The reconnect machinery belongs here for the same reason the manager does.
//
// It used to live in the component as refs, and the unmount cleanup cleared
// every timer -- so the moment Android destroyed the activity (the app closed,
// or swiped out of Recents while the foreground service kept the process
// alive) the retry loop stopped. Walk out of range with the app closed and
// nothing was left scanning; walk back in and nothing reconnected, however
// long you stood there. Reopening the app mounted a fresh tree and connected
// on the spot, which is exactly the shape of the bug as reported.
//
// A link that outlives the React tree needs a retry loop that outlives it too.
let wantsLink = false;    // the standing "keep this link up" instruction
let retryTimer = null;
let scanTimer = null;
let dataTimer = null;
let lastDataAt = 0;
let connectFn = null;     // the newest mounted tree's connect(), for the retry
// The band advertises every 20 ms, so several scan callbacks for the same
// device are already queued before the first connect() reaches native. One
// attempt at a time, process-wide.
let connecting = false;
let buf = '';             // partial line across BLE notifications
let sawLine = false;      // dev logging: confirm reassembly once
// The current retry wait, grown by each failure and reset by a link that comes
// up. Module scope for the same reason everything else here is: the loop
// outlives the React tree, and a backoff that resets on every mount is not a
// backoff.
let retryDelay = RETRY_MS;
// Which ceiling the backoff is growing towards. Set by connect() once it knows
// whether there is a remembered band to go straight at.
let retryCap = RETRY_MAX_MS;
// When startDeviceScan() was last called, newest last. This is the app's half
// of Android's scan budget -- see scanGateDelay().
let scanStarts = [];

function bleManager() {
  if (!manager && BleManager) manager = new BleManager();
  return manager;
}

/**
 * Schedule another attempt, unless the user has withdrawn the instruction.
 *
 * `ms` overrides the backoff for a failure that carries its own timing -- a
 * scan throttle naming the moment it lifts, or the scan budget saying how long
 * until there is room. Everything else doubles the wait, so a band that is
 * simply switched off costs one attempt a minute rather than twenty, and the
 * budget below is never the only thing holding the line.
 */
function retrySoon(ms) {
  if (!wantsLink) return;
  clearTimeout(retryTimer);
  const wait = ms == null ? retryDelay : ms;
  // A caller-supplied wait is a fact about the radio, not a failure count, so
  // it must not push the backoff up on top of itself.
  if (ms == null) retryDelay = Math.min(retryDelay * 2, retryCap);
  retryTimer = setTimeout(() => { retryTimer = null; connectFn?.(); }, wait);
}

/** A link came up, or the user let go: the next failure starts short again. */
function resetBackoff() {
  retryDelay = RETRY_MS;
}

/**
 * How long until we are allowed to start another scan, in ms. 0 means now.
 *
 * The backoff above is the polite half of staying inside Android's limit; this
 * is the half that guarantees it. However the app gets here -- a retry firing
 * early, a second caller, a failure mode nobody anticipated -- a scan cannot
 * start unless there is genuinely room in the window for it, so the throttle
 * that produced this whole bug can no longer be reached from inside the app.
 */
function scanGateDelay() {
  const now = Date.now();
  scanStarts = scanStarts.filter((t) => now - t < SCAN_WINDOW_MS);
  if (scanStarts.length < SCAN_BUDGET) return 0;
  // Wait for the oldest start to age out of the window, plus a moment so we
  // are not racing the stack's own clock for the boundary.
  return SCAN_WINDOW_MS - (now - scanStarts[0]) + 500;
}

/**
 * The stack's own answer to "stay off the air for how long", in ms -- or null
 * when this failure says nothing about timing and the normal backoff applies.
 *
 * RxAndroidBle reports the undocumented throttle with the moment it expects it
 * to lift: `... suggested retry date is Tue Sep 01 00:29:02 GMT+05:00 2026`.
 * That is Java's Date.toString(), which Hermes does not reliably parse, so an
 * unreadable or already-past date falls back to a full window rather than to
 * nothing -- waiting for no time at all is what caused this.
 */
function scanCooldown(err) {
  const msg = err?.reason || err?.message || '';
  if (isBtStuck(err)) return BT_STUCK_COOLDOWN_MS;
  if (!/scan throttle|too frequently/i.test(msg)) return null;
  const at = /suggested retry date is (.+)$/i.exec(msg);
  const when = at ? Date.parse(at[1].trim()) : NaN;
  if (!Number.isNaN(when)) {
    const wait = when - Date.now() + 1000;
    if (wait > 0) return wait;
  }
  return THROTTLE_COOLDOWN_MS;
}

/** The stack refusing to register this app's scanner at all, rather than a
 *  scan that failed. Nothing the app does next will clear it. */
function isBtStuck(err) {
  return /application registration failed/i.test(err?.reason || err?.message || '');
}

/**
 * A GATT connection this process is already holding.
 *
 * `linked` can be null while the radio link is very much alive: a connect that
 * was in flight when the activity went away, a tree that unmounted between the
 * connect and the bookkeeping. Ask again and the native side answers "Already
 * connected to device with MAC address ..." -- an error the UI showed verbatim
 * and then retried forever, because every retry hit the same wall.
 *
 * It is not an error. It is the link, and it can simply be adopted.
 */
async function heldConnection(mgr, id) {
  try {
    const open = await mgr.connectedDevices([NUS_SERVICE]);
    const hit = (id && open.find((d) => d.id === id)) || open[0];
    if (hit) return hit;
  } catch { /* older adapter, or none open: fall through */ }
  if (!id) return null;
  try {
    const [d] = await mgr.devices([id]);
    if (d && (await d.isConnected())) return d;
  } catch { /* not known to this manager */ }
  return null;
}

/** Is this the "you already have this device" refusal, rather than a failure? */
function isAlreadyConnected(e) {
  return /already connected/i.test(e?.reason || e?.message || '');
}

async function rememberBand(id) {
  try { await AsyncStorage.setItem(LINK_KEY, id); } catch { /* non-fatal */ }
}
async function recallBand() {
  try { return await AsyncStorage.getItem(LINK_KEY); } catch { return null; }
}
async function forgetBand() {
  try { await AsyncStorage.removeItem(LINK_KEY); } catch { /* non-fatal */ }
}

/**
 * Does this phone want a band? `true` / `false` / `null`, where null means
 * "could not tell" -- the same three-way convention alarm.js uses.
 *
 * The Android foreground service exists to hold the BLE link alive, so its
 * start/stop decision is this same standing instruction. But it cannot reuse
 * recallBand(): that swallows a read error into null, which is right for the
 * connect path (nothing to go straight at, fall back to the scan) and actively
 * dangerous here -- a transient AsyncStorage failure would read as "no band",
 * stop the service, kill the process, and drop a live link. A caller that
 * would tear something down has to be able to tell "no" from "don't know", so
 * this reports the difference instead of guessing on the caller's behalf.
 */
export async function wantsBand() {
  try {
    return !!(await AsyncStorage.getItem(LINK_KEY));
  } catch {
    return null;
  }
}

function b64decode(s) {
  if (typeof global.atob === 'function') return global.atob(s);
  const tbl = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '', buf = 0, bits = 0;
  for (const ch of s.replace(/=+$/, '')) {
    const v = tbl.indexOf(ch);
    if (v < 0) continue;
    buf = (buf << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out += String.fromCharCode((buf >> bits) & 0xff); }
  }
  return out;
}

function b64encode(s) {
  if (typeof global.btoa === 'function') return global.btoa(s);
  const tbl = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < s.length; i += 3) {
    const a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2);
    out += tbl[a >> 2] + tbl[((a & 3) << 4) | (isNaN(b) ? 0 : b >> 4)]
        + (isNaN(b) ? '=' : tbl[((b & 15) << 2) | (isNaN(c) ? 0 : c >> 6)])
        + (isNaN(c) ? '=' : tbl[c & 63]);
  }
  return out;
}

async function askPermissions() {
  if (Platform.OS !== 'android') return true;
  // BLUETOOTH_SCAN is declared WITHOUT `neverForLocation` (the ble-plx config
  // plugin defaults that flag off and app.json does not turn it on), so on
  // Android 12+ the OS still treats a scan as something that could derive the
  // user's position -- and it will not hand us a single result until
  // ACCESS_FINE_LOCATION is granted too. Ask for scan/connect alone and the
  // scan starts, reports no error, and silently returns nothing forever.
  const need =
    Platform.Version >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];

  // Check before asking, and survive not being able to ask at all.
  //
  // The retry loop now runs with the app closed, and a permission *request*
  // needs an Activity to hang its dialog on -- with none, React Native rejects
  // the promise. That rejection used to escape connect() and take the whole
  // reconnect attempt with it, on a phone whose permissions were granted
  // months ago. A plain check needs no Activity and answers the normal case.
  try {
    const have = await Promise.all(need.map((p) => PermissionsAndroid.check(p)));
    if (have.every(Boolean)) return true;
    const res = await PermissionsAndroid.requestMultiple(need);
    return need.every((p) => res[p] === PermissionsAndroid.RESULTS.GRANTED);
  } catch {
    return false;                // nothing to ask with right now
  }
}

/**
 * The other half of the same Android rule: the permission is not enough, the
 * system Location toggle has to be ON as well. It fails exactly like a missing
 * permission -- no error, no results -- so check it up front and say so,
 * rather than let the UI blame the band ten seconds later.
 */
async function locationServicesOff() {
  if (Platform.OS !== 'android' || Platform.Version < 31) return false;
  try {
    const Location = require('expo-location');
    return !(await Location.hasServicesEnabledAsync());
  } catch {
    return false;            // cannot tell -- assume fine and let the scan try
  }
}

/**
 * Owns the link to the wristband and turns its newline-JSON into events.
 *
 * The band chunks its output into ~20-byte BLE notifications, so a single
 * event can arrive in pieces. Everything is buffered and split on newlines --
 * skip that and you parse fragments and chase phantom errors.
 *
 * `autoLink` is the caller saying a real band is the chosen radio right now.
 * Only then will the hook re-link on its own; in virtual mode a remembered
 * band must not pull the phone back onto a scan nobody asked for.
 */
export function useBand(onEvent, { autoLink = false } = {}) {
  const [status, setStatus] = useState(
    BleManager ? (linked ? 'connecting' : 'idle') : 'simulated');
  const [battery, setBattery] = useState(null);
  const [armed, setArmed] = useState(false);
  const [highAlert, setHighAlert] = useState(false);
  const [lastSeen, setLastSeen] = useState(null);
  // The data path used to fail without a word: a failed notify subscribe and a
  // failed write were both caught and dropped, so "connected" was the last
  // thing the UI ever said. Whatever went wrong now has somewhere to surface.
  const [lastError, setLastError] = useState(null);

  const cb = useRef(onEvent);
  cb.current = onEvent;

  // Everything the link needs to keep itself up -- the standing instruction,
  // the retry, the scan guard, the data watchdog, the partial line -- now
  // lives at module scope with the connection itself. See the block at the top
  // of this file for why: a React tree is not the lifetime of a BLE link, and
  // treating it as one is what stopped the band ever reconnecting once the app
  // had been closed.
  const simulated = !BleManager;

  const handleLine = useCallback((line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.t !== 'evt') return;
    setLastSeen(Date.now());
    if (typeof msg.bat === 'number') setBattery(msg.bat);
    if (msg.e === 'armed') setArmed(true);
    if (msg.e === 'disarmed') setArmed(false);
    if (msg.e === 'high_alert_on') setHighAlert(true);
    if (msg.e === 'high_alert_off') setHighAlert(false);
    if (msg.e === 'hb') return;              // heartbeat is status, not an event
    cb.current?.(msg);
  }, []);

  const setUpLink = useCallback(async (c) => {
    linked = c;

    // Adopting an existing link re-runs this over listeners that are already
    // registered. Leave them and every notification is delivered twice, the
    // second copy into a component that no longer exists.
    try { notifySub?.remove(); } catch { /* never registered */ }
    try { dropSub?.remove(); } catch { /* never registered */ }
    notifySub = null;
    dropSub = null;

    // N2.2 -- a dropped link (out of range for a moment, the radio throttled
    // while backgrounded, anything) is not the same as the user choosing to
    // disconnect. Only the former should retry, or a deliberate disconnect
    // would fight its own button.
    dropSub = c.onDisconnected(() => {
      linked = null;
      connecting = false;
      clearInterval(dataTimer);
      setStatus('disconnected');
      retrySoon();
    });

    // A link can come up perfectly and still be useless: Android caches a
    // bonded device's GATT table, so after a firmware change it will hand
    // back the OLD service list without ever going to the band. Then the
    // monitor below fails on a service that is not in the cache, the write
    // path fails the same way, and the UI cheerfully says "connected".
    // Prove the characteristics are really there before claiming that.
    const services = await c.services();
    const hasNus = services.some((s) => s.uuid.toLowerCase() === NUS_SERVICE);

    // What the phone believes the band offers, against what the band
    // actually offers. A mismatch here is the whole diagnosis, and it is
    // invisible from the UI.
    if (__DEV__) {
      console.log('BAND services:', services.map((s) => s.uuid).join(', '));
      if (hasNus) {
        const chars = await c.characteristicsForService(NUS_SERVICE);
        chars.forEach((ch) => console.log(
          `BAND char ${ch.uuid} notify=${ch.isNotifiable} indicate=${ch.isIndicatable} `
          + `write=${ch.isWritableWithResponse} writeNR=${ch.isWritableWithoutResponse}`));
      }
    }

    if (!hasNus) {
      setLastError(
        'Connected, but this phone is not seeing the band\'s UART service. '
        + 'That is almost always a stale GATT cache: forget the band in '
        + 'Android Bluetooth settings and connect again. Discovered: '
        + services.map((s) => s.uuid).join(', '));
      setStatus('no-service');
      // Nothing here is retryable without the user clearing the cache, but
      // the guard still has to come off or connect() is dead for good.
      connecting = false;
      try { dropSub?.remove(); } catch { /* already gone */ }
      dropSub = null;
      linked = null;
      try { await c.cancelConnection(); } catch { /* already gone */ }
      return;
    }

    // A fragment left over from the previous link would corrupt the first
    // line of this one.
    buf = '';

    if (__DEV__) console.log('BAND subscribing to', NUS_TX);
    notifySub = c.monitorCharacteristicForService(NUS_SERVICE, NUS_TX, (e, ch) => {
      if (e) {
        if (__DEV__) console.log('BAND notify ERR:', e.reason || e.message);
        // Swallowing this is how a dead link passes for a live one: the
        // subscribe can fail on its own (cached table, notify not granted)
        // long after connect() resolved, and nothing else reports it.
        if (wantsLink) {
          setLastError('Notify subscribe failed: ' + (e.reason || e.message));
          setStatus('no-notify');
        }
        return;
      }
      if (!ch?.value) return;
      // Fed on raw bytes, not on parsed lines. A band whose lines arrive
      // truncated is a real fault, but it is not a dead subscription, and
      // tearing the link down every 25 s only hid the actual problem.
      lastDataAt = Date.now();
      buf += b64decode(ch.value);
      const parts = buf.split('\n');
      buf = parts.pop();           // keep the incomplete tail
      // A band that never sends a newline would otherwise grow this
      // string forever. One line is ~90 bytes; 4 KB of tail is garbage.
      if (buf.length > 4096) buf = '';
      // One line on the first complete parse, to confirm reassembly works
      // without printing five packets per heartbeat forever after.
      if (__DEV__ && parts.length && !sawLine) {
        sawLine = true;
        console.log('BAND first line:', parts[0].trim());
      }
      parts.forEach((p) => p.trim() && handleLine(p.trim()));
    });

    // Now that the subscription exists, a bigger MTU only means fewer
    // packets per line. Failing is cosmetic, so it must never take the
    // link with it.
    c.requestMTU(185)
      .then((m) => { if (__DEV__) console.log('BAND mtu now', m?.mtu); })
      .catch((e) => { if (__DEV__) console.log('BAND mtu failed', e.reason || e.message); });

    // Remember which band this was, so the next launch -- or the next
    // reconnect after Android finally does kill the process -- goes straight
    // back to it instead of scanning the room for a device it already knows.
    rememberBand(c.id);

    setLastError(null);
    setStatus('connected');
    // Whatever the last run of failures cost, this link proves the situation
    // has changed. The next drop starts from a short wait rather than from a
    // minute the band did nothing to deserve.
    resetBackoff();

    // "Connected" is a claim about the radio, not about the data. The band
    // heartbeats every 10 s, so silence past 25 s means the subscription is
    // not live however healthy the link looks -- drop it and start over,
    // and leave a note saying why rather than sitting there blank.
    lastDataAt = Date.now();
    clearInterval(dataTimer);
    dataTimer = setInterval(() => {
      if (Date.now() - lastDataAt < DATA_TIMEOUT_MS) return;
      clearInterval(dataTimer);
      setLastError(
        'Link was up but the band sent nothing for '
        + Math.round(DATA_TIMEOUT_MS / 1000) + 's -- the notify subscription '
        + 'never went live. Relinking.');
      // onDisconnected does the retry and clears the guard.
      try { linked?.cancelConnection(); } catch { /* already gone */ }
    }, 5000);
  }, [handleLine]);

  /**
   * setUpLink, plus the cleanup its callers would otherwise each have to write.
   *
   * Every path that opens a link comes through here, including the one that
   * adopts a link this component did not open -- which is the whole point of
   * keeping the device at module scope.
   */
  const finishLink = useCallback(async (c) => {
    try {
      await setUpLink(c);
    } catch (e) {
      // The radio link is real but the app cannot use it. Leaving it open leaks
      // it AND keeps the band from advertising, so the retry that follows could
      // never find the band again and a transient fault would look permanent.
      if (linked === c) linked = null;
      try { notifySub?.remove(); } catch { /* never registered */ }
      try { dropSub?.remove(); } catch { /* never registered */ }
      notifySub = null;
      dropSub = null;
      try { await c.cancelConnection(); } catch { /* already gone */ }
      throw e;
    }
  }, [setUpLink]);

  const connect = useCallback(async () => {
    if (simulated) { setStatus('simulated'); return; }

    // --- the band we already know ------------------------------------------
    // A scan exists to learn a band's id. Once it is known, going straight at
    // it is faster, cheaper on the radio, and works when the band is not in the
    // OS scan cache -- which is the normal state of affairs a few seconds after
    // the app was killed and the band went back to advertising. Falling back to
    // the scan below costs nothing when this misses.
    //
    // Read first, before any of the checks that can bail out, because it also
    // decides how patient those bail-outs are allowed to be.
    const knownId = await recallBand();

    // Which ceiling this attempt's failures grow towards. A remembered band
    // gets the short one: the retry that finds it again spends no scan budget,
    // so making the wearer wait a minute for it would be a cost with no
    // corresponding saving. Clamp the current wait too, or a backoff already
    // grown past the cap during a scan-only stretch would outlive its reason.
    retryCap = knownId ? RETRY_MAX_KNOWN_MS : RETRY_MAX_MS;
    retryDelay = Math.min(retryDelay, retryCap);

    // Each of these is recoverable without the user touching the app again --
    // a permission granted from Settings, Bluetooth switched back on, Location
    // re-enabled -- so each schedules another attempt rather than ending the
    // loop. Ending it meant the band stayed dark until somebody found the
    // CONNECT button. None of them can be observed happening, so the wait to
    // notice is the retry wait, which is the other half of why the cap above
    // is chosen before we get here.
    if (!(await askPermissions())) { setStatus('no-permission'); retrySoon(); return; }
    if (await locationServicesOff()) { setStatus('location-off'); retrySoon(); return; }

    wantsLink = true;
    // The guard below is per attempt -- one attempt, one connection. Starting
    // a fresh one has to clear it or a stuck guard would make the band
    // permanently unfindable.
    connecting = false;
    clearTimeout(retryTimer); retryTimer = null;
    clearTimeout(scanTimer); scanTimer = null;
    clearInterval(dataTimer); dataTimer = null;

    const mgr = bleManager();
    if (!mgr) { setStatus('simulated'); return; }

    // A BleManager reports `Unknown` for a moment after construction while it
    // talks to the adapter. Scanning inside that window is a coin flip, so wait
    // for a settled state and name the one thing the user can act on.
    try {
      const state = await mgr.state();
      if (state === 'PoweredOff') { setStatus('bluetooth-off'); retrySoon(); return; }
    } catch { /* older adapters: just try the scan */ }

    // --- a link this process is already holding -----------------------------
    // Before asking for a connection, check whether we have one. The activity
    // can be destroyed and rebuilt with the GATT connection untouched, and a
    // connect() against a device the native side already holds does not
    // succeed and does not fail usefully -- it throws "Already connected to
    // device with MAC address ...", which the UI printed as the band's status
    // and then retried into forever. Adopting it is both correct and instant.
    const held = await heldConnection(mgr, knownId);
    if (held) {
      connecting = true;
      setStatus('connecting');
      try {
        const c = await held.discoverAllServicesAndCharacteristics();
        await finishLink(c);
        return;
      } catch (e) {
        // The connection exists but cannot be used. Drop it so the scan below
        // has a band that is advertising again to find.
        connecting = false;
        if (__DEV__) console.log('BAND adopt failed:', e.reason || e.message);
        try { await held.cancelConnection(); } catch { /* already gone */ }
        if (!wantsLink) return;
      }
    }

    if (knownId) {
      connecting = true;
      setStatus('connecting');
      try {
        // No requestMTU here on purpose -- see the scan path below.
        let c = await mgr.connectToDevice(knownId, { timeout: DIRECT_TIMEOUT_MS });
        c = await c.discoverAllServicesAndCharacteristics();
        await finishLink(c);
        return;
      } catch (e) {
        // Band off, out of range, or a stale id after a re-flash. The id is
        // kept either way: "not powered on yet" is by far the likeliest cause
        // and it is not a reason to forget which band is ours.
        connecting = false;
        if (__DEV__) console.log('BAND direct connect failed:', e.reason || e.message);
        if (!wantsLink) return;
        // A connection that appeared between the check above and this call.
        // Rare, and it costs nothing to pick it up rather than start scanning
        // for a band that cannot advertise while it is connected to us.
        if (isAlreadyConnected(e)) {
          const late = await heldConnection(mgr, knownId);
          if (late) {
            try {
              const c = await late.discoverAllServicesAndCharacteristics();
              await finishLink(c);
              return;
            } catch { connecting = false; }
          }
        }
      }
    }

    // --- Android's scan budget ---------------------------------------------
    // Nothing below is worth doing if the OS has already decided to answer the
    // scan with silence. Waiting here costs one delayed attempt; starting
    // anyway costs the next thirty seconds of every scan the app makes, and
    // eventually the scanner registration itself.
    const gate = scanGateDelay();
    if (gate > 0) {
      setStatus('throttled');
      // The gate's own timing, not the backoff: this is a queue, not a
      // failure, and doubling the wait for it would punish the band for the
      // app's scan history.
      retrySoon(gate);
      return;
    }

    setStatus('scanning');

    // Every exit from the scan goes through here, so the timer can never
    // outlive the scan it was guarding and fire over a live connection.
    const endScan = () => {
      clearTimeout(scanTimer);
      scanTimer = null;
      try { mgr.stopDeviceScan(); } catch { /* already stopped */ }
    };

    scanTimer = setTimeout(() => {
      endScan();
      setStatus('not-found');
      retrySoon();
    }, SCAN_TIMEOUT_MS);

    // The band advertises the NUS UUID in the advertising packet and its name
    // in the scan response, so the service is the one field guaranteed to be
    // in the very first report. Filtering on it pushes the match down into the
    // OS scanner: cheaper on the radio than waking JS for every beacon in the
    // room, and it cannot miss a band whose name has not arrived yet.
    scanStarts.push(Date.now());
    mgr.startDeviceScan([NUS_SERVICE], {
      allowDuplicates: false,
      // RxAndroidBle defaults to SCAN_MODE_LOW_POWER, whose duty cycle gives a
      // ten-second scan roughly two chances to catch an advertisement. This is
      // a short scan for one known device with the app in front of the user --
      // what the high duty cycle is for -- and finding the band on the first
      // attempt is itself the best defence against the budget above.
      scanMode: ScanMode ? ScanMode.LowLatency : 2,
    }, async (err, d) => {
      if (err) {
        // Bluetooth off, permission revoked mid-scan, adapter reset: all of
        // them land here, and all of them used to leave the hook with no scan
        // running, no timer, and no way back except the user pressing connect.
        endScan();
        const msg = err.reason || err.message;
        // How long the radio wants us gone, if this failure knows. Null means
        // it does not, and the ordinary backoff decides.
        const cool = scanCooldown(err);
        if (isBtStuck(err)) {
          // Not a band problem, and not one another scan can solve: the stack
          // would not register this app's scanner at all. Naming the one thing
          // that clears it beats printing the code and retrying into the wall.
          setLastError(
            'Android would not register this app with the Bluetooth stack. '
            + 'Turn Bluetooth off and on again, and force-stop the app if that '
            + 'does not do it. (' + msg + ')');
          setStatus('bt-stuck');
        } else if (cool != null) {
          setLastError(
            'Android is rate-limiting this app\'s Bluetooth scans. Waiting '
            + Math.round(cool / 1000) + 's for it to lift. (' + msg + ')');
          setStatus('throttled');
        } else {
          setStatus('error:' + msg);
        }
        retrySoon(cool);
        return;
      }
      if (!d) return;
      // The name is a nicety here, not the identity: it rides in the scan
      // response, and Android hands us plenty of reports before that lands.
      // The service filter above already proves this is a band, so a hit with
      // no name yet counts -- only a name that is clearly somebody else's is
      // grounds to skip.
      const name = d.name || d.localName || '';
      if (name && !name.startsWith(BAND_PREFIX)) return;

      // First match wins. Set before any await, or the callbacks already
      // queued behind this one race straight past it.
      if (connecting) return;
      connecting = true;

      endScan();
      setStatus('connecting');
      try {
        // No requestMTU here on purpose. nRF Connect -- the one client that
        // does receive this band's notifications on this phone -- does not ask
        // for one, and an MTU exchange racing service discovery on Android is a
        // known way to end up subscribed to nothing. The band's lines are ~120
        // bytes and BLEUart chunks them anyway, so a 23-byte MTU costs a few
        // extra packets and nothing else. It is renegotiated after the
        // subscription is live, where it cannot break anything.
        let c = await d.connect();
        c = await c.discoverAllServicesAndCharacteristics();
        await finishLink(c);
      } catch (e) {
        connecting = false;
        // "Already connected" is not a failure, it is the answer: this process
        // is holding the very band the scan just found. Showing it as the
        // band's status -- `error:Already connected to device with MAC address
        // E2:59:...` -- was the app reporting a working link as a fault, and
        // every retry hit the same wall because a connected band stops
        // advertising and the scan could never find it again either.
        if (isAlreadyConnected(e)) {
          try {
            const held = await heldConnection(mgr, d.id);
            if (held) {
              connecting = true;
              const c = await held.discoverAllServicesAndCharacteristics();
              await finishLink(c);
              return;
            }
          } catch { /* fall through to the retry below */ }
          connecting = false;
        }
        setStatus('error:' + (e.reason || e.message));
        retrySoon();
      }
    });
  }, [simulated, finishLink]);

  connectFn = connect;

  const disconnect = useCallback(async () => {
    wantsLink = false;
    connecting = false;
    // A deliberate disconnect ends the episode, so the next link starts fresh.
    // `scanStarts` is deliberately NOT cleared: that window belongs to Android,
    // not to us, and forgetting it here would let connect/disconnect/connect
    // walk straight back into the throttle this all exists to avoid.
    resetBackoff();
    // Nulled, not merely cleared: `retryTimer` is now the "is a loop running"
    // answer for the cold-start effect, and a stale handle would read as yes.
    clearTimeout(retryTimer); retryTimer = null;
    clearTimeout(scanTimer); scanTimer = null;
    clearInterval(dataTimer); dataTimer = null;
    // The only place the standing "this phone wants that band" instruction is
    // withdrawn. Leave it set and the effects below would helpfully undo the
    // button the user just pressed.
    await forgetBand();
    try { bleManager()?.stopDeviceScan(); } catch { /* not scanning */ }
    try { notifySub?.remove(); } catch { /* never registered */ }
    try { dropSub?.remove(); } catch { /* never registered */ }
    notifySub = null;
    dropSub = null;
    try { await linked?.cancelConnection(); } catch { /* already gone */ }
    linked = null;
    setStatus(simulated ? 'simulated' : 'idle');
  }, [simulated]);

  /**
   * Adopt a link the previous React tree left running.
   *
   * Android recreates the activity -- and with it this whole component -- for a
   * rotation, a config change, or simply returning to an app the foreground
   * service kept alive in the background. The GATT connection survives all of
   * that; only the JS listeners pointing at it do not.
   */
  useEffect(() => {
    if (simulated || !linked) return undefined;
    let cancelled = false;
    (async () => {
      const c = linked;
      try {
        // The device object can outlive the connection it describes -- the band
        // may have gone out of range while nothing was watching.
        if (!(await c.isConnected())) throw new Error('stale');
        if (cancelled) return;
        wantsLink = true;
        await finishLink(c);
      } catch {
        if (cancelled) return;
        try { await c.cancelConnection(); } catch { /* already gone */ }
        if (linked === c) linked = null;
        setStatus('disconnected');
        if (autoLink) connectFn?.();
      }
    })();
    return () => { cancelled = true; };
    // Runs once per mount: adopting is about this tree being new, not about
    // finishLink's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simulated]);

  /**
   * Re-link on a cold start.
   *
   * Without this the app comes up idle after every restart and somebody has to
   * find the Band screen and press CONNECT before the wristband is anything but
   * a blinking light -- on a safety device, hours after they stopped thinking
   * about it. A remembered id is the user having already asked for this link;
   * `autoLink` is the caller confirming a real band is the chosen radio.
   */
  //
  // The guard is "is anything already trying", not "has anyone ever asked".
  // `wantsLink` outlives this tree now, so testing it here would let a loop
  // that has stopped -- permission refused, Bluetooth off, an adopt that
  // returned early -- stay stopped for the life of the process, with the user
  // left pressing CONNECT by hand.
  useEffect(() => {
    if (simulated || !autoLink || linked || connecting || retryTimer) return undefined;
    let cancelled = false;
    (async () => {
      const id = await recallBand();
      if (!cancelled && id) connectFn?.();
    })();
    return () => { cancelled = true; };
  }, [simulated, autoLink]);

  /** Send a command to the band: {"c":"alarm"}, {"c":"buzz","n":2}, ... */
  const send = useCallback(async (obj) => {
    if (!linked) {
      setLastError('Command dropped -- no band connected: ' + JSON.stringify(obj));
      return false;
    }
    try {
      await linked.writeCharacteristicWithoutResponseForService(
        NUS_SERVICE, NUS_RX, b64encode(JSON.stringify({ t: 'cmd', ...obj }) + '\n'));
      return true;
    } catch (e) {
      // This is the check-in buzz that never reached the wrist. Silence here
      // reads as "the motor is broken" when the write never left the phone.
      setLastError('Write failed (' + (obj.c || '?') + '): ' + (e.reason || e.message));
      return false;
    }
  }, []);

  /** Stands in for a real key press when there is no radio (Expo Go). */
  const simulate = useCallback((e, extra = {}) => {
    handleLine(JSON.stringify({ t: 'evt', e, bat: battery ?? 96, ...extra }));
  }, [handleLine, battery]);

  useEffect(() => () => {
    // The timers deliberately keep running.
    //
    // They used to be cleared here, on the reasoning that they belonged to
    // this tree -- but they belong to the link, and the link outlives the
    // tree by design (see below, and the module block at the top). Clearing
    // them meant that the moment the app was closed, the retry loop, the scan
    // and the data watchdog all stopped: the band could drop out of range and
    // nothing was left in the process to notice, or to reconnect when it came
    // back. Reopening the app was the only thing that ever relinked it.
    //
    // A dead tree's setStatus is a no-op, so nothing here fires "into" it; the
    // next mount adopts the link and re-registers its own listeners.

    // The link deliberately does NOT come down here either. Unmount means "Android
    // took the activity away", which happens on a rotation, on a config change,
    // and every time the app leaves the screen while the foreground service
    // holds the process open. Hanging up the GATT connection at that moment is
    // what made the band drop back to advertising -- the blinking light -- the
    // instant the app was closed: the radio was fine, the app hung up on it.
    //
    // The connection is process-scoped (see the module state at the top). It is
    // released by disconnect(), or by Android when the process itself dies.
    //
    // Dev reloads are the one exception. Fast refresh restarts this JS with the
    // native connection still open, and a connected band does not advertise, so
    // the next scan would never find it and the UI would sit on "connect to
    // band" with the band already in use.
    if (__DEV__) {
      wantsLink = false;
      connecting = false;
      resetBackoff();
      clearTimeout(retryTimer); retryTimer = null;
      clearTimeout(scanTimer); scanTimer = null;
      clearInterval(dataTimer); dataTimer = null;
      try { notifySub?.remove(); } catch { /* never registered */ }
      try { dropSub?.remove(); } catch { /* never registered */ }
      notifySub = null;
      dropSub = null;
      try { linked?.cancelConnection(); } catch { /* already gone */ }
      linked = null;
      try { manager?.destroy(); } catch { /* never built */ }
      manager = null;
    }
  }, []);

  return { status, connect, disconnect, send, simulate, simulated,
           battery, armed, highAlert, lastSeen, bleError, lastError };
}
