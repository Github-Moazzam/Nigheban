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
 */
export function useBand(onEvent) {
  const [status, setStatus] = useState(BleManager ? 'idle' : 'simulated');
  const [battery, setBattery] = useState(null);
  const [armed, setArmed] = useState(false);
  const [highAlert, setHighAlert] = useState(false);
  const [lastSeen, setLastSeen] = useState(null);
  // The data path used to fail without a word: a failed notify subscribe and a
  // failed write were both caught and dropped, so "connected" was the last
  // thing the UI ever said. Whatever went wrong now has somewhere to surface.
  const [lastError, setLastError] = useState(null);

  const mgr = useRef(null);
  const dev = useRef(null);
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

  const connect = useCallback(async () => {
    if (simulated) { setStatus('simulated'); return; }
    if (!(await askPermissions())) { setStatus('no-permission'); return; }
    if (await locationServicesOff()) { setStatus('location-off'); return; }

    wantsConnection.current = true;
    // The guard below is per scan session -- one session, one connection
    // attempt. Starting a fresh session has to clear it or a stuck guard would
    // make the band permanently unfindable.
    connecting.current = false;
    clearTimeout(retryTimer.current);
    clearTimeout(scanTimer.current);
    clearInterval(dataTimer.current);

    if (!mgr.current) mgr.current = new BleManager();

    // A BleManager reports `Unknown` for a moment after construction while it
    // talks to the adapter. Scanning inside that window is a coin flip, so wait
    // for a settled state and name the one thing the user can act on.
    try {
      const state = await mgr.current.state();
      if (state === 'PoweredOff') { setStatus('bluetooth-off'); return; }
    } catch { /* older adapters: just try the scan */ }

    setStatus('scanning');

    // Every exit from the scan goes through here, so the timer can never
    // outlive the scan it was guarding and fire over a live connection.
    const endScan = () => {
      clearTimeout(scanTimer.current);
      scanTimer.current = null;
      try { mgr.current?.stopDeviceScan(); } catch { /* already stopped */ }
    };

    const retrySoon = () => {
      if (!wantsConnection.current) return;
      clearTimeout(retryTimer.current);
      retryTimer.current = setTimeout(() => connect(), RETRY_MS);
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
    mgr.current.startDeviceScan([NUS_SERVICE], { allowDuplicates: false }, async (err, d) => {
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
        dev.current = c;

        // N2.2 -- a dropped link (out of range for a moment, the radio
        // throttled while backgrounded, anything) is not the same as the
        // user choosing to disconnect. Only the former should retry, or a
        // deliberate disconnect would fight its own button.
        c.onDisconnected(() => {
          dev.current = null;
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
          try { await c.cancelConnection(); } catch { /* already gone */ }
          return;
        }

        // A fragment left over from the previous link would corrupt the first
        // line of this one.
        buf.current = '';

        if (__DEV__) console.log('BAND subscribing to', NUS_TX);
        c.monitorCharacteristicForService(NUS_SERVICE, NUS_TX, (e, ch) => {
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
          try { dev.current?.cancelConnection(); } catch { /* already gone */ }
        }, 5000);
      } catch (e) {
        connecting.current = false;
        setStatus('error:' + (e.reason || e.message));
        retrySoon();
      }
    });
  }, [simulated, handleLine]);

  const disconnect = useCallback(async () => {
    wantsConnection.current = false;
    connecting.current = false;
    clearTimeout(retryTimer.current);
    clearTimeout(scanTimer.current);
    clearInterval(dataTimer.current);
    try { mgr.current?.stopDeviceScan(); } catch {}
    try { await dev.current?.cancelConnection(); } catch {}
    dev.current = null;
    setStatus(simulated ? 'simulated' : 'idle');
  }, [simulated]);

  /** Send a command to the band: {"c":"alarm"}, {"c":"buzz","n":2}, ... */
  const send = useCallback(async (obj) => {
    if (!dev.current) {
      setLastError('Command dropped -- no band connected: ' + JSON.stringify(obj));
      return false;
    }
    try {
      await dev.current.writeCharacteristicWithoutResponseForService(
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
    wantsConnection.current = false;
    connecting.current = false;
    clearTimeout(retryTimer.current);
    clearTimeout(scanTimer.current);
    clearInterval(dataTimer.current);
    // Drop the link before tearing the manager down. A fast-refresh or reload
    // restarts this JS with the native connection still open -- and a band
    // that is connected is not advertising, so the next scan cannot find it
    // and the app sits on "connect to band" with the band already in use.
    try { dev.current?.cancelConnection(); } catch { /* already gone */ }
    dev.current = null;
    try { mgr.current?.destroy(); } catch {}
  }, []);

  return { status, connect, disconnect, send, simulate, simulated,
           battery, armed, highAlert, lastSeen, bleError, lastError };
}
