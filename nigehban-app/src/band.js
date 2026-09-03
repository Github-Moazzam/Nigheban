import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, PermissionsAndroid, Platform } from 'react-native';
import {
  clearBandPin, getBandName, getBandPin, nameLegal, pinLegal, rememberBandName,
  setBandPin,
} from './bandIdentity';

export const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';  // phone -> band
export const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';  // band -> phone
// The name a band comes out of the box with. It is a fallback label and NOTHING
// else -- not a filter, not an identity.
//
// It used to be both, and the scan skipped anything whose name did not start
// with it. Now that the wearer can call the band whatever they like, that check
// would go blind on the very first rename: the band would be advertising three
// feet away, answering to "Ayesha's band", and the app would step over every
// report it produced. The NUS service UUID is the identity, it is in the
// advertising packet rather than the scan response, and it is what the scan
// filters on.
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

// How long to keep re-offering the subscription while Android pairs.
//
// Android does not pair on connect. It pairs the first time an operation
// touches an attribute that demands it, fails that operation with
// InsufficientAuthentication, puts its passkey dialog up, and does not come
// back to what it was doing. On this band the subscribe is that operation, so
// the FIRST link to a band the phone has never met always fails once -- and
// without this the app reported "the band sent nothing" for a band that was
// waiting perfectly politely for six digits to be typed.
//
// The budget is generous because what it is really waiting for is a person
// finding the notification, reading the PIN and typing it. Forty seconds is
// slow typing plus a fumble; the retries are cheap (no scan, no connection --
// just a CCCD write on a link that is already up).
const PAIR_RETRY_MS = 2500;
const PAIR_RETRY_BUDGET_MS = 40000;

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
// The re-offer of the notify subscription while Android is pairing. Module
// scope like every other timer here: it has to outlive the React tree, and it
// has to be cancellable from disconnect() so a torn-down link cannot go on
// quietly re-subscribing to a band nobody asked for any more.
let pairTimer = null;
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

// ---- the gate --------------------------------------------------------------
// The band answers nothing until the app sends {"c":"auth","pin":...} over the
// paired link, so a GATT connection is no longer the same thing as a working
// band. `authed` is the difference, and like everything else here it is module
// scope because it belongs to the link and not to a React tree.
let authed = false;
// The link is blocked on a person, not on the radio: either no PIN has ever
// been stored for this band, or the one that has was refused.
//
// It stops the retry loop, and that is the whole reason it exists. Retrying
// changes nothing -- waiting three seconds does not make the same six digits
// right, and an empty keystore stays empty -- while the loop itself does real
// damage: the band hangs up on an unauthenticated link after a few seconds, so
// the app would reconnect, fail and reconnect, cycling the status every few
// seconds underneath somebody who is halfway through typing into the field it
// keeps unmounting. Cleared only by submitPin().
let pinBlocked = false;
// Has {"c":"auth"} been attempted on THIS link yet. It separates two states
// that otherwise look identical from here -- a band that has not been asked,
// and a band that was asked and ignored the question -- and getting them
// confused reports perfectly good hardware as needing a re-flash. See the
// unauthenticated-event branch in handleLine().
let authTried = false;
// A new PIN that has been sent to the band and not yet acknowledged. It is
// written to the keystore by the `pin_set` branch and nowhere else, so a PIN the
// band refused is never the one this phone tries to reconnect with.
let pendingPin = null;

let stateSub = null;

function bleManager() {
  if (!manager && BleManager) {
    manager = new BleManager();
    stateSub = manager.onStateChange((state) => {
      if (state === 'PoweredOn' && wantsLink && connectFn) {
        // Wakes the JS thread from the native event so we don't wait for a frozen timer
        resetBackoff();
        connectFn();
      }
    }, true);
  }
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
  // Blocked on a person. Not retryable, and retrying is actively harmful --
  // see the flag's own comment.
  if (pinBlocked) return;
  clearTimeout(retryTimer);
  
  if (ms === 'now') {
    // Explicit request to bypass the timer (e.g. from a background event where 
    // setTimeout would freeze, but we know it's safe to immediately request a connection).
    retryTimer = null;
    Promise.resolve().then(() => connectFn?.());
    return;
  }
  
  const wait = ms == null ? retryDelay : ms;
  // A caller-supplied wait is a fact about the radio, not a failure count, so
  // it must not push the backoff up on top of itself.
  if (ms == null) retryDelay = Math.min(retryDelay * 2, retryCap);
  retryTimer = setTimeout(() => { retryTimer = null; connectFn?.(); }, wait);
}

// If the app goes to the background while waiting for a retry, the JS timer will freeze.
// Cancel the wait and fire immediately so the native BLE stack can take over with autoConnect.
AppState.addEventListener('change', (state) => {
  if (state !== 'active' && retryTimer && connectFn) {
    clearTimeout(retryTimer);
    retryTimer = null;
    connectFn();
  }
});

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

/**
 * Did this fail because the link is not encrypted, or not encrypted enough?
 *
 * Read `attErrorCode`, not `errorCode`. `errorCode` says WHICH operation
 * failed -- 403 is CharacteristicNotifyChangeFailed -- and an earlier version
 * of this function tested it as though it meant "not authorized", which it
 * does not. `attErrorCode` is the reason the peripheral itself gave, and it is
 * the only field that separates "this needs pairing" from "the radio is
 * broken". `androidErrorCode` 0x8e (NotEncrypted) is the same answer arriving
 * from below the ATT layer.
 *
 * This is the ordinary first-connection path, not an exception. Android does
 * not pair on connect; it pairs the first time something touches an attribute
 * that demands it -- on this band, the subscribe -- and it fails THAT
 * operation while the passkey dialog goes up. Nothing retries it on the app's
 * behalf, so a link that is about to work perfectly reports a fault first.
 */
const ATT_NEEDS_PAIRING = new Set([
  5,    // InsufficientAuthentication
  8,    // InsufficientAuthorization
  12,   // InsufficientEncryptionKeySize
  15,   // InsufficientEncryption
]);

function isAuthFailure(e) {
  if (ATT_NEEDS_PAIRING.has(e?.attErrorCode)) return true;
  if (e?.androidErrorCode === 0x8e) return true;            // NotEncrypted
  // Belt and braces for a backend that only hands us prose.
  const msg = e?.reason || e?.message || '';
  return /insufficient (authentication|authorization|encryption)|not encrypted/i.test(msg);
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

/**
 * One command onto the wire, with no opinion about what it means.
 *
 * Module scope rather than inside the hook because the handshake runs from
 * setUpLink() and from the notification handler, both of which can fire while
 * no React tree is mounted -- the link outlives the tree, and so does the
 * authentication it needs.
 *
 * Returns the failure rather than throwing it: every caller here has a better
 * message for the screen than a native BLE reason string.
 */
async function writeCmd(obj) {
  if (!linked) return 'no band connected';
  try {
    await linked.writeCharacteristicWithoutResponseForService(
      NUS_SERVICE, NUS_RX, b64encode(JSON.stringify({ t: 'cmd', ...obj }) + '\n'));
    return null;
  } catch (e) {
    return e.reason || e.message || 'write failed';
  }
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
export function useBand(onEvent, {
  autoLink = false, escrowPin, escrowReachable,
} = {}) {
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
  // What this band calls itself. Seeded from the last link so the screen has a
  // name to show before the radio is up, then replaced by whatever the band
  // says in auth_ok -- which is authoritative, because it may have been
  // renamed from a different phone in the family since we last looked.
  const [bandName, setBandName] = useState(null);
  // True once the band has said this PIN is still the factory default. It is
  // the one thing worth nagging about: a band on 123456 is a band anybody who
  // has read this repo can pair with.
  const [defaultPin, setDefaultPin] = useState(false);

  useEffect(() => {
    let dead = false;
    (async () => {
      const n = await getBandName();
      if (!dead && n) setBandName((cur) => cur || n);
    })();
    return () => { dead = true; };
  }, []);

  const cb = useRef(onEvent);
  cb.current = onEvent;

  // Called with a PIN the BAND has accepted -- never with a guess. This file
  // deliberately knows nothing about accounts or servers; it reports the one
  // fact it is in a position to know, and App.js decides that fact is worth
  // keeping against the account. Refs because they are called from module-scope
  // listeners that outlive any particular render.
  const pinCb = useRef(escrowPin);
  pinCb.current = escrowPin;
  const reachCb = useRef(escrowReachable);
  reachCb.current = escrowReachable;

  // Everything the link needs to keep itself up -- the standing instruction,
  // the retry, the scan guard, the data watchdog, the partial line -- now
  // lives at module scope with the connection itself. See the block at the top
  // of this file for why: a React tree is not the lifetime of a BLE link, and
  // treating it as one is what stopped the band ever reconnecting once the app
  // had been closed.
  const simulated = !BleManager;

  /**
   * Answer the band's challenge with the six digits this phone has stored.
   *
   * No PIN stored is not an error and must not look like one: it is a band
   * nobody has told this phone about yet, and the only thing that fixes it is
   * a person typing. The link is deliberately left up while that happens --
   * the band gives us a few seconds before it hangs up, and if it does, the
   * ordinary retry brings it back the moment submitPin() has something to say.
   */
  const beginAuth = useCallback(async () => {
    authTried = true;
    const pin = await getBandPin();
    if (!pin) {
      pinBlocked = true;
      setLastError(null);
      setStatus('needs-pin');
      return;
    }
    setStatus('authenticating');
    const err = await writeCmd({ c: 'auth', pin });
    if (err) {
      setLastError('Could not send the band PIN: ' + err);
      setStatus('error:' + err);
    }
  }, []);

  /**
   * The band said yes.
   *
   * Everything that used to happen at the end of setUpLink and means "there is
   * a working band on the other end of this" lives here instead, because until
   * auth_ok none of it was true.
   */
  const goLive = useCallback((msg) => {
    authed = true;
    pinBlocked = false;

    // The band said yes to whatever this phone sent, so this is a PIN known to
    // work -- the only kind worth remembering anywhere. It also quietly covers
    // the factory reset: a wiped band answers to the factory PIN, the phone is
    // told that PIN, it authenticates with it, and the escrowed copy follows
    // the band back to factory without anybody doing anything.
    // Best effort, and safe to be: this writes a PIN that is known to WORK, so
    // the worst a failure leaves behind is an account with no copy -- which is
    // recoverable. Writing a copy that is WRONG is the dangerous direction, and
    // only a PIN change can do that; see changePin().
    getBandPin().then((pin) => { if (pin) pinCb.current?.(pin); }).catch(() => {});

    // The band's own name wins over anything cached. It may have been renamed
    // from another phone in the family since this one last looked.
    if (msg?.name) {
      setBandName(msg.name);
      rememberBandName(msg.name);
    }
    setDefaultPin(msg?.defpin === 1);

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
  }, []);

  const handleLine = useCallback((line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.t !== 'evt') return;
    setLastSeen(Date.now());

    // ---- the handshake, and the settings that ride on it -------------------
    //
    // Handled here and returned from, rather than passed on to cb.current.
    // These are a conversation between this file and the firmware; the rest of
    // the app deals in "somebody pressed the button", and an auth_bad arriving
    // at the alert router would be an event nothing knows what to do with.
    switch (msg.e) {
      case 'need_auth':
        // The band asks the moment the subscription goes live. Answering the
        // question it actually asked is better than assuming it was going to.
        beginAuth();
        return;

      case 'auth_ok':
        goLive(msg);
        return;

      case 'auth_locked':
        // Not a wrong PIN -- the band has stopped listening for a while after
        // too many. Distinguished from bad-pin because the answer is different:
        // waiting fixes this, and typing does not.
        authed = false;
        pinBlocked = true;
        setLastError(
          'Too many wrong PINs. The band has stopped accepting them for '
          + (msg.for_s > 90 ? Math.ceil(msg.for_s / 60) + ' minutes'
                            : (msg.for_s || 30) + ' seconds')
          + '. Waiting is the only thing that clears it — a correct PIN after '
          + 'that does, immediately.');
        setStatus('locked-out');
        return;

      case 'auth_bad':
        // Not retryable, and saying so is the point -- otherwise the band
        // reads as "out of range" and the user has no idea the six digits are
        // the problem. The band hangs up after three of these on its own.
        authed = false;
        pinBlocked = true;
        setLastError(msg.locked_s
          ? 'Wrong PIN. Too many now — the band has stopped accepting them for '
            + msg.locked_s + 's.'
          : 'The band did not accept this PIN.');
        setStatus(msg.locked_s ? 'locked-out' : 'bad-pin');
        return;

      case 'name_set':
        if (msg.name) { setBandName(msg.name); rememberBandName(msg.name); }
        setLastError(null);
        return;

      case 'name_rejected':
        setLastError('The band would not take that name'
                     + (msg.why ? ' (' + msg.why + ').' : '.'));
        return;

      case 'pin_set':
        // The band agreed, so now -- and only now -- this phone remembers it.
        if (pendingPin) {
          const accepted = pendingPin;
          pendingPin = null;
          setDefaultPin(false);
          setLastError(null);

          // The band has moved on. Both copies now have to catch up, and
          // neither failing is allowed to be quiet -- whichever one misses, the
          // person is the fallback and has to be told the number.
          setBandPin(accepted).catch(() => {
            setLastError('The band took the new PIN but this phone could not '
                         + 'save it. Write it down — you will be asked for it '
                         + 'the next time the band reconnects.');
          });

          // The reachability check in changePin() ran seconds ago, so this
          // should not fail. If it does, the account is now holding the OLD
          // PIN against a band that has stopped accepting it -- the one
          // divergence that matters -- so it is reported in full rather than
          // swallowed, with the digits, because at this point the person is
          // the only reliable copy left.
          Promise.resolve(pinCb.current?.(accepted))
            .then((saved) => {
              if (saved === false) throw new Error('escrow refused');
            })
            .catch(() => {
              setLastError('The band took the new PIN, but it could not be '
                           + 'saved to your account — so "I have forgotten it" '
                           + 'would give you the OLD one. Write ' + accepted
                           + ' down now, and set the PIN again when you have '
                           + 'signal to fix the copy on your account.');
            });
        } else {
          setDefaultPin(false);
          setLastError(null);
        }
        return;

      case 'pin_rejected':
        pendingPin = null;
        setLastError('The band would not take that PIN'
                     + (msg.why ? ' (' + msg.why + ').' : '.')
                     + (msg.locked_s
                        ? ' Too many wrong answers -- it has stopped listening for '
                          + msg.locked_s + 's.'
                        : ''));
        return;

      case 'cfg':
        if (msg.name) { setBandName(msg.name); rememberBandName(msg.name); }
        setDefaultPin(msg.defpin === 1);
        return;

      case 'unpaired':
        setLastError('The band has forgotten every paired phone. Remove it in '
                     + 'Android Bluetooth settings before linking again.');
        return;

      default:
        break;
    }

    // An ordinary event, on a link that has not authenticated. Two very
    // different things produce this, and telling them apart is what `authTried`
    // is for.
    if (!authed) {
      // FIRST: a band that is already through its handshake and simply did not
      // re-ask. That is the ADOPTED link -- Android rebuilt the activity, the
      // GATT connection survived, and the firmware still has us marked
      // authenticated, so its need_auth prompt (which only fires for an
      // unauthenticated subscriber) never comes. It is heartbeating at us
      // perfectly happily. Asking is what resolves it; the firmware answers an
      // `auth` from an already-authenticated peer with a fresh auth_ok, and
      // deliberately without the buzz, because this is not a new link.
      if (!authTried) {
        beginAuth();
        return;
      }

      // SECOND: we asked, and it carried on as though nothing had been said.
      // Only firmware from before the lock does that.
      //
      // It is reported rather than accepted. Going live anyway would mean the
      // one state this whole feature exists to prevent -- an open band, with
      // the app calling it locked -- and re-flashing is a two-minute job with
      // a clear instruction attached. The events are still dropped: a band
      // this app cannot vouch for must not raise alerts in somebody's name.
      pinBlocked = true;                       // no retry will change this
      setLastError(
        'This band is running firmware from before the PIN lock: it never asked '
        + 'for one and ignores the handshake. Re-flash it from '
        + 'nigehban_band_nrf52/ and forget the band in Android Bluetooth '
        + 'settings before linking again.');
      setStatus('old-firmware');
      return;
    }

    if (typeof msg.bat === 'number') setBattery(msg.bat);
    if (msg.e === 'armed') setArmed(true);
    if (msg.e === 'disarmed') setArmed(false);
    if (msg.e === 'high_alert_on') setHighAlert(true);
    if (msg.e === 'high_alert_off') setHighAlert(false);
    if (msg.e === 'hb') return;              // heartbeat is status, not an event
    cb.current?.(msg);
  }, [beginAuth, goLive]);

  const setUpLink = useCallback(async (c) => {
    linked = c;
    // This link has not authenticated, whatever the last one managed. The
    // adopt path lands here with a connection that outlived its React tree,
    // and inheriting a stale `true` would let commands go out to a band that
    // is going to ignore them.
    authed = false;
    authTried = false;

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
      // Authentication belongs to the connection that earned it. The band
      // clears its own on the same edge; leaving ours set would have the app
      // believing the next connection -- to anything -- was already trusted.
      authed = false;
      clearInterval(dataTimer);
      clearTimeout(pairTimer); pairTimer = null;
      // A band waiting on six digits hangs up on its own after a few seconds.
      // Overwriting the prompt with "disconnected" would replace the one screen
      // that can fix this with one that cannot, in the moment somebody is
      // reading it -- so the question stays up and the retry stays down until
      // it is answered.
      if (!pinBlocked) {
        setStatus('disconnected');
        if (AppState.currentState !== 'active') {
          retrySoon('now'); // Bypass frozen JS timer so Android autoConnect registers immediately
        } else {
          retrySoon();
        }
      }
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

    // The subscription, offered again for as long as Android is still pairing.
    //
    // `subscribe` is a named function rather than one inline call because the
    // first attempt against a band this phone has never met is EXPECTED to
    // fail -- see isAuthFailure(). Android answers it with
    // InsufficientAuthentication, raises its own passkey dialog, and then
    // never returns to the operation that caused it. Offering the subscription
    // again a few seconds later, once the bond exists, is the whole fix.
    if (__DEV__) console.log('BAND subscribing to', NUS_TX);
    const pairingSince = Date.now();

    const subscribe = () => {
      // Whatever the last attempt left registered. Without this each retry
      // stacks another listener and every line arrives once per attempt.
      try { notifySub?.remove(); } catch { /* never registered */ }
      notifySub = c.monitorCharacteristicForService(NUS_SERVICE, NUS_TX, onNotify);
    };

    const onNotify = (e, ch) => {
      if (e) {
        if (__DEV__) console.log('BAND notify ERR:', e.reason || e.message,
                                 'att=', e.attErrorCode, 'android=', e.androidErrorCode);
        if (!wantsLink) return;

        // ---- still pairing ------------------------------------------------
        // Not a fault, and reporting it as one is what put "Band not
        // responding" on screen while the wearer was still reading Android's
        // dialog. Say what is actually happening and try again.
        if (isAuthFailure(e)) {
          if (linked !== c) return;              // this link is gone; stop
          if (Date.now() - pairingSince < PAIR_RETRY_BUDGET_MS) {
            setStatus('pairing');
            setLastError(null);
            clearTimeout(pairTimer);
            pairTimer = setTimeout(() => { if (linked === c) subscribe(); },
                                   PAIR_RETRY_MS);
            return;
          }
          // Out of patience. Either nobody answered the dialog, or Android is
          // holding a bond the band has forgotten -- which no amount of
          // retrying fixes and this app cannot clear.
          setLastError(
            'Android would not encrypt the link to the band. If it asked for a '
            + 'PIN and you typed one, it was not accepted; if it never asked, '
            + 'this phone is holding a pairing the band has forgotten -- open '
            + 'Android Bluetooth settings, forget the band, and connect again.');
          setStatus('pair-failed');
          return;
        }

        // Swallowing this is how a dead link passes for a live one: the
        // subscribe can fail on its own (cached table, notify not granted)
        // long after connect() resolved, and nothing else reports it.
        setLastError('Notify subscribe failed: ' + (e.reason || e.message));
        setStatus('no-notify');
        return;
      }
      if (!ch?.value) return;

      // The subscription is live, so pairing is behind us.
      clearTimeout(pairTimer); pairTimer = null;

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
    };

    subscribe();

    // Now that the subscription exists, a bigger MTU only means fewer
    // packets per line. Failing is cosmetic, so it must never take the
    // link with it.
    c.requestMTU(185)
      .then((m) => { if (__DEV__) console.log('BAND mtu now', m?.mtu); })
      .catch((e) => { if (__DEV__) console.log('BAND mtu failed', e.reason || e.message); });

    // Remember which band this was, so the next launch -- or the next
    // reconnect after Android finally does kill the process -- goes straight
    // back to it instead of scanning the room for a device it already knows.
    //
    // Deliberately BEFORE authentication. This is "which band is ours", not
    // "which band let us in", and a wrong PIN is a reason to ask the user for
    // six digits, never a reason to forget which wristband they own.
    rememberBand(c.id);

    setLastError(null);

    // "Connected" is not claimed here, and neither is the handshake started.
    //
    // Writing {"c":"auth"} from here was a bug with the same root as the
    // subscribe failing: RXD needs an encrypted link too, so an auth sent now
    // races Android's pairing and is refused exactly as the subscription was.
    // Both operations would then be sitting on a dialog nobody has answered.
    //
    // The band's own `need_auth` is the correct trigger, and the firmware makes
    // it a guarantee: it is sent from the CCCD-write callback, which cannot
    // fire until the subscription is genuinely live -- which cannot happen
    // until pairing has succeeded. By the time it arrives, a write will go
    // through. handleLine() answers it; goLive() is reached from auth_ok and
    // nowhere else.
    //
    // `pairing`, not `authenticating`: on a first link this is precisely the
    // moment Android's passkey dialog goes up, and the wearer is looking at
    // that, not at us.
    setStatus('pairing');
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
    clearTimeout(pairTimer); pairTimer = null;

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
        // Use autoConnect without a timeout when the app is in the background. JS timers freeze,
        // so we push the wait into the native Android BLE stack which can wait indefinitely.
        // In the foreground, use the timeout so it falls back to scanning for faster UI feedback.
        const isBg = AppState.currentState !== 'active';
        const opts = isBg ? { autoConnect: true } : { timeout: DIRECT_TIMEOUT_MS };
        let c = await mgr.connectToDevice(knownId, opts);
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
      // No name check at all any more, and that is the fix rather than a
      // loosening. A band the wearer has renamed advertises whatever they
      // called it, so `startsWith('Nigehban-')` would skip the one device we
      // are looking for -- and the check never did any work anyway: the OS
      // scan filter above matched on the NUS service UUID, which nothing else
      // in the room advertises.
      //
      // The name is still read, because it is the label the UI shows until the
      // band states its own in auth_ok -- which is after pairing, and pairing
      // is the part with a dialog on it. Having something to call the band on
      // that screen is worth one assignment.
      const name = d.name || d.localName || '';
      if (name) setBandName(name);

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
    // The PIN is forgotten, and ONLY here.
    //
    // This function is the deliberate act -- somebody pressed DISCONNECT, or
    // signed out. It is not how a band that walked out of range comes down: an
    // automatic drop goes through onDisconnected() and retrySoon(), never
    // through here, so a wearer who steps into a lift or leaves her phone in
    // another room gets her band back silently, exactly as before. Nothing on
    // that path touches the keystore.
    //
    // Deliberately unlinking is different in kind. It is the one moment the
    // wearer has said "this phone and that band are finished", and the stored
    // PIN is what lets any hand holding this phone put them back together
    // without knowing anything. So the six digits go, and coming back means
    // typing them -- which is also what makes DISCONNECT a real answer to
    // "somebody else has my phone" rather than a cosmetic one.
    //
    // Sign-out gets this for free and wants it: App.js disconnects there
    // precisely so the next account cannot inherit the last one's wristband.
    authed = false;
    pinBlocked = false;
    await clearBandPin();
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
    clearTimeout(pairTimer); pairTimer = null;
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
    // A write that leaves the phone and is then ignored is the worst of both
    // worlds: the app believes the check-in buzz went to the wrist, and the
    // band drops it on the floor because this connection never authenticated.
    // Say so instead.
    if (!authed) {
      setLastError('Command dropped -- the band has not accepted this phone yet: '
                   + JSON.stringify(obj));
      return false;
    }
    const err = await writeCmd(obj);
    if (err) {
      // This is the check-in buzz that never reached the wrist. Silence here
      // reads as "the motor is broken" when the write never left the phone.
      setLastError('Write failed (' + (obj.c || '?') + '): ' + err);
      return false;
    }
    return true;
  }, []);

  // ---------------------------------------------------- NAME AND PIN ---

  /**
   * The user has typed six digits. Store them and try again.
   *
   * Stored before the band is asked, on purpose. The alternative -- prove it
   * first, save it after -- loses the PIN in exactly the case where losing it
   * hurts: the band accepts it, the link drops before the reply lands, and the
   * phone reconnects knowing nothing.
   */
  const submitPin = useCallback(async (pin) => {
    await setBandPin(pin);
    pinBlocked = false;
    setLastError(null);
    if (linked && !authed) { await beginAuth(); return; }
    // No link to authenticate on: the band hung up while the user was typing,
    // or was never found. Start the loop again -- it has the PIN now.
    connectFn?.();
  }, [beginAuth]);

  /**
   * Rename the band itself.
   *
   * This is not a label on this phone. It goes into the nRF52's flash and out
   * in the advertisement, so Android's Bluetooth list, nRF Connect and every
   * other phone in the family see the new name too. The band answers with
   * `name_set` and that answer -- not this call -- is what updates the screen.
   */
  const renameBand = useCallback(async (name) => {
    const n = (name || '').trim();
    if (!nameLegal(n)) {
      setLastError('A band name is 1-20 plain characters, with no quotes.');
      return false;
    }
    return send({ c: 'setname', name: n });
  }, [send]);

  /**
   * Change the six digits, on the band and on this phone.
   *
   * `oldPin` is the current one, and the caller must have made a person TYPE
   * it. Filling it in from the keystore would turn the band's check into
   * theatre -- the whole point is to require something the owner knows rather
   * than something the phone in somebody's hand happens to be holding.
   *
   * The new PIN is stored only once the band has confirmed it, in the `pin_set`
   * branch of handleLine(). The old order -- save first, then ask -- was safe
   * while the band accepted every setpin, and stopped being safe the moment it
   * could refuse one: mistyping the current PIN would have left this phone
   * holding a PIN the band had never agreed to, and the next reconnect failing
   * against it. If the confirmation is lost in flight instead, the band has the
   * new PIN and this phone the old one, which surfaces as an ordinary bad-pin
   * prompt the person can answer.
   *
   * Other phones in the family keep their pairing but stop authenticating, so
   * each needs the new PIN typed in once. That is the intended behaviour and
   * the reason this is worth having: it revokes a phone without anybody going
   * near Android's Bluetooth settings.
   */
  const changePin = useCallback(async (oldPin, pin) => {
    if (!pinLegal(oldPin) || !pinLegal(pin)) {
      setLastError('A band PIN is six digits.');
      return false;
    }

    // ---- the network is a PRECONDITION, not a nicety ---------------------
    //
    // The account holds a copy of this PIN so a forgotten one can be recovered,
    // and the one thing that copy must never be is WRONG. Missing is survivable
    // -- the wearer falls back to the band's own button. Wrong is not: it hands
    // somebody six digits with total confidence, they type them, the band
    // refuses, and they have spent attempts against a lockout while believing
    // they hold the answer.
    //
    // Changing the PIN offline is exactly how that happens. The band would take
    // the new one and the account would go on holding the old one, with nothing
    // anywhere aware they had diverged. So the server is checked BEFORE the
    // band is touched, and a phone with no signal is told to wait.
    //
    // Checked rather than written, and in that order deliberately. Writing the
    // new PIN first would put an unconfirmed value in the account, and a band
    // that then refused the change -- wrong current PIN, most likely -- would
    // leave the same divergence pointing the other way.
    if (reachCb.current && !(await reachCb.current())) {
      setLastError('Changing the band PIN needs an internet connection, so the '
                   + 'new one can be saved to your account. Without that, a PIN '
                   + 'you forget later could not be recovered. Try again when '
                   + 'you have signal.');
      return false;
    }

    pendingPin = pin;
    const ok = await send({ c: 'setpin', old: oldPin, pin });
    if (!ok) pendingPin = null;
    return ok;
  }, [send]);

  /**
   * Make the band forget every phone that has ever paired with it.
   *
   * The heavy option, and the link goes with it -- this phone's keys were in
   * that list too. Android will still be holding its side of the bond, which
   * is why the reply says to clear it there; a phone that reconnects with a
   * bond the band has forgotten fails encryption and nothing in this app can
   * fix that from here.
   */
  const unpairAll = useCallback(() => send({ c: 'unpair' }), [send]);

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
      clearTimeout(pairTimer); pairTimer = null;
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
           battery, armed, highAlert, lastSeen, bleError, lastError,
           // identity: what the band is called, and who may talk to it
           bandName, defaultPin, submitPin, renameBand, changePin, unpairAll };
}
