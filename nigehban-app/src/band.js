import { useCallback, useEffect, useRef, useState } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';

export const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';  // phone -> band
export const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';  // band -> phone
export const BAND_NAME = 'Nigehban-01';

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
  const need =
    Platform.Version >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  const res = await PermissionsAndroid.requestMultiple(need);
  return need.every((p) => res[p] === PermissionsAndroid.RESULTS.GRANTED);
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

    wantsConnection.current = true;
    clearTimeout(retryTimer.current);

    if (!mgr.current) mgr.current = new BleManager();
    setStatus('scanning');

    mgr.current.startDeviceScan(null, { allowDuplicates: false }, async (err, d) => {
      if (err) { setStatus('error:' + (err.reason || err.message)); return; }
      if (!d || d.name !== BAND_NAME) return;

      mgr.current.stopDeviceScan();
      setStatus('connecting');
      try {
        let c = await d.connect({ requestMTU: 185 });
        c = await c.discoverAllServicesAndCharacteristics();
        dev.current = c;

        // N2.2 -- a dropped link (out of range for a moment, the radio
        // throttled while backgrounded, anything) is not the same as the
        // user choosing to disconnect. Only the former should retry, or a
        // deliberate disconnect would fight its own button.
        c.onDisconnected(() => {
          dev.current = null;
          setStatus('disconnected');
          if (wantsConnection.current) {
            clearTimeout(retryTimer.current);
            retryTimer.current = setTimeout(() => connect(), 3000);
          }
        });

        c.monitorCharacteristicForService(NUS_SERVICE, NUS_TX, (e, ch) => {
          if (e || !ch?.value) return;
          buf.current += b64decode(ch.value);
          const parts = buf.current.split('\n');
          buf.current = parts.pop();           // keep the incomplete tail
          parts.forEach((p) => p.trim() && handleLine(p.trim()));
        });

        setStatus('connected');
      } catch (e) {
        setStatus('error:' + (e.reason || e.message));
        if (wantsConnection.current) {
          clearTimeout(retryTimer.current);
          retryTimer.current = setTimeout(() => connect(), 3000);
        }
      }
    });
  }, [simulated, handleLine]);

  const disconnect = useCallback(async () => {
    wantsConnection.current = false;
    clearTimeout(retryTimer.current);
    try { await dev.current?.cancelConnection(); } catch {}
    dev.current = null;
    setStatus(simulated ? 'simulated' : 'idle');
  }, [simulated]);

  /** Send a command to the band: {"c":"alarm"}, {"c":"buzz","n":2}, ... */
  const send = useCallback(async (obj) => {
    if (!dev.current) return false;
    try {
      await dev.current.writeCharacteristicWithoutResponseForService(
        NUS_SERVICE, NUS_RX, b64encode(JSON.stringify({ t: 'cmd', ...obj }) + '\n'));
      return true;
    } catch {
      return false;
    }
  }, []);

  /** Stands in for a real key press when there is no radio (Expo Go). */
  const simulate = useCallback((e, extra = {}) => {
    handleLine(JSON.stringify({ t: 'evt', e, bat: battery ?? 96, ...extra }));
  }, [handleLine, battery]);

  useEffect(() => () => {
    wantsConnection.current = false;
    clearTimeout(retryTimer.current);
    try { mgr.current?.destroy(); } catch {}
  }, []);

  return { status, connect, disconnect, send, simulate, simulated,
           battery, armed, highAlert, lastSeen, bleError };
}
