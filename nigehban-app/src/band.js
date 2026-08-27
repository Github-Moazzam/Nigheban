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
const RETRY_MS = 3000;
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
let bleError = null;
try {
  BleManager = require('react-native-ble-plx').BleManager;
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

function bleManager() {
  if (!manager && BleManager) manager = new BleManager();
  return manager;
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
  const res = await PermissionsAndroid.requestMultiple(need);
  return need.every((p) => res[p] === PermissionsAndroid.RESULTS.GRANTED);
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

  const buf = useRef('');
  const cb = useRef(onEvent);
  cb.current = onEvent;

  // Set right before a deliberate disconnect() so onDisconnected can tell
  // "the user asked for this" from "the radio just dropped" -- only the
  // second case should retry on its own.
  const wantsConnection = useRef(false);
  const retryTimer = useRef(null);
  const scanTimer = useRef(null);

  // The band advertises every 20 ms (setInterval(32, 244) in the firmware), so
  // by the time the first connect() has even crossed to the native side, more
  // scan callbacks for the same device have already been queued and delivered.
  // Every one of them used to start its own connect() against that device, and
  // concurrent connects on Android tear the GATT down and rebuild it under the
  // subscription the previous one just registered. The result is precisely the
  // failure seen here: a link that reports "connected" and never delivers a
  // single notification, while the band happily notifies anyone else.
  // stopDeviceScan() is not enough on its own -- it stops future callbacks, not
  // the ones already in flight -- so the guard has to be set synchronously.
  const connecting = useRef(false);

  // Belt and braces for the same class of failure: if the link is up but no
  // line arrives in two and a half heartbeat periods, the subscription is dead
  // no matter what the status says. Recycle it rather than sit there silent.
  const dataTimer = useRef(null);
  const lastDataAt = useRef(0);
  const sawLine = useRef(false);   // dev logging: confirm reassembly once

  // connect() and the retry that reschedules it are mutually recursive, and a
  // useCallback cannot close over itself. The ref breaks the cycle without
  // making either of them depend on the other's identity.
  const connectRef = useRef(null);

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

  const retrySoon = useCallback(() => {
    if (!wantsConnection.current) return;
    clearTimeout(retryTimer.current);
    retryTimer.current = setTimeout(() => connectRef.current?.(), RETRY_MS);
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
      connecting.current = false;
      clearInterval(dataTimer.current);
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
      connecting.current = false;
      try { dropSub?.remove(); } catch { /* already gone */ }
      dropSub = null;
      linked = null;
      try { await c.cancelConnection(); } catch { /* already gone */ }
      return;
    }

    // A fragment left over from the previous link would corrupt the first
    // line of this one.
    buf.current = '';

    if (__DEV__) console.log('BAND subscribing to', NUS_TX);
    notifySub = c.monitorCharacteristicForService(NUS_SERVICE, NUS_TX, (e, ch) => {
      if (e) {
        if (__DEV__) console.log('BAND notify ERR:', e.reason || e.message);
        // Swallowing this is how a dead link passes for a live one: the
        // subscribe can fail on its own (cached table, notify not granted)
        // long after connect() resolved, and nothing else reports it.
        if (wantsConnection.current) {
          setLastError('Notify subscribe failed: ' + (e.reason || e.message));
          setStatus('no-notify');
        }
        return;
      }
      if (!ch?.value) return;
      // Fed on raw bytes, not on parsed lines. A band whose lines arrive
      // truncated is a real fault, but it is not a dead subscription, and
      // tearing the link down every 25 s only hid the actual problem.
      lastDataAt.current = Date.now();
      buf.current += b64decode(ch.value);
      const parts = buf.current.split('\n');
      buf.current = parts.pop();           // keep the incomplete tail
      // A band that never sends a newline would otherwise grow this
      // string forever. One line is ~90 bytes; 4 KB of tail is garbage.
      if (buf.current.length > 4096) buf.current = '';
      // One line on the first complete parse, to confirm reassembly works
      // without printing five packets per heartbeat forever after.
      if (__DEV__ && parts.length && !sawLine.current) {
        sawLine.current = true;
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

    // "Connected" is a claim about the radio, not about the data. The band
    // heartbeats every 10 s, so silence past 25 s means the subscription is
    // not live however healthy the link looks -- drop it and start over,
    // and leave a note saying why rather than sitting there blank.
    lastDataAt.current = Date.now();
    clearInterval(dataTimer.current);
    dataTimer.current = setInterval(() => {
      if (Date.now() - lastDataAt.current < DATA_TIMEOUT_MS) return;
      clearInterval(dataTimer.current);
      setLastError(
        'Link was up but the band sent nothing for '
        + Math.round(DATA_TIMEOUT_MS / 1000) + 's -- the notify subscription '
        + 'never went live. Relinking.');
      // onDisconnected does the retry and clears the guard.
      try { linked?.cancelConnection(); } catch { /* already gone */ }
    }, 5000);
  }, [handleLine, retrySoon]);

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
    if (!(await askPermissions())) { setStatus('no-permission'); return; }
    if (await locationServicesOff()) { setStatus('location-off'); return; }

    wantsConnection.current = true;
    // The guard below is per attempt -- one attempt, one connection. Starting
    // a fresh one has to clear it or a stuck guard would make the band
    // permanently unfindable.
    connecting.current = false;
    clearTimeout(retryTimer.current);
    clearTimeout(scanTimer.current);
    clearInterval(dataTimer.current);

    const mgr = bleManager();
    if (!mgr) { setStatus('simulated'); return; }

    // A BleManager reports `Unknown` for a moment after construction while it
    // talks to the adapter. Scanning inside that window is a coin flip, so wait
    // for a settled state and name the one thing the user can act on.
    try {
      const state = await mgr.state();
      if (state === 'PoweredOff') { setStatus('bluetooth-off'); return; }
    } catch { /* older adapters: just try the scan */ }

    // --- the band we already know ------------------------------------------
    // A scan exists to learn a band's id. Once it is known, going straight at
    // it is faster, cheaper on the radio, and works when the band is not in the
    // OS scan cache -- which is the normal state of affairs a few seconds after
    // the app was killed and the band went back to advertising. Falling back to
    // the scan below costs nothing when this misses.
    const knownId = await recallBand();
    if (knownId) {
      connecting.current = true;
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
        connecting.current = false;
        if (__DEV__) console.log('BAND direct connect failed:', e.reason || e.message);
        if (!wantsConnection.current) return;
      }
    }

    setStatus('scanning');

    // Every exit from the scan goes through here, so the timer can never
    // outlive the scan it was guarding and fire over a live connection.
    const endScan = () => {
      clearTimeout(scanTimer.current);
      scanTimer.current = null;
      try { mgr.stopDeviceScan(); } catch { /* already stopped */ }
    };

    scanTimer.current = setTimeout(() => {
      endScan();
      setStatus('not-found');
      retrySoon();
    }, SCAN_TIMEOUT_MS);

    // The band advertises the NUS UUID in the advertising packet and its name
    // in the scan response, so the service is the one field guaranteed to be
    // in the very first report. Filtering on it pushes the match down into the
    // OS scanner: cheaper on the radio than waking JS for every beacon in the
    // room, and it cannot miss a band whose name has not arrived yet.
    mgr.startDeviceScan([NUS_SERVICE], { allowDuplicates: false }, async (err, d) => {
      if (err) {
        // Bluetooth off, permission revoked mid-scan, adapter reset: all of
        // them land here, and all of them used to leave the hook with no scan
        // running, no timer, and no way back except the user pressing connect.
        endScan();
        setStatus('error:' + (err.reason || err.message));
        retrySoon();
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
      if (connecting.current) return;
      connecting.current = true;

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
        connecting.current = false;
        setStatus('error:' + (e.reason || e.message));
        retrySoon();
      }
    });
  }, [simulated, finishLink, retrySoon]);

  connectRef.current = connect;

  const disconnect = useCallback(async () => {
    wantsConnection.current = false;
    connecting.current = false;
    clearTimeout(retryTimer.current);
    clearTimeout(scanTimer.current);
    clearInterval(dataTimer.current);
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
        wantsConnection.current = true;
        await finishLink(c);
      } catch {
        if (cancelled) return;
        try { await c.cancelConnection(); } catch { /* already gone */ }
        if (linked === c) linked = null;
        setStatus('disconnected');
        if (autoLink) connectRef.current?.();
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
  useEffect(() => {
    if (simulated || !autoLink || linked || wantsConnection.current) return undefined;
    let cancelled = false;
    (async () => {
      const id = await recallBand();
      if (!cancelled && id) connectRef.current?.();
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
    // Timers belong to this tree and must not fire into it once it is gone.
    clearTimeout(retryTimer.current);
    clearTimeout(scanTimer.current);
    clearInterval(dataTimer.current);

    // The link deliberately does NOT come down here. Unmount means "Android
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
      wantsConnection.current = false;
      connecting.current = false;
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
