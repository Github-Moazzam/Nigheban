/**
 * ONE BAND, TWO RADIOS.
 *
 * The app should not care whether the wristband is a real nRF52840 across a
 * BLE link or the phone itself running `virtualBand.js`. This hook is the seam
 * that makes that true: it owns both, exposes exactly the shape `useBand`
 * already returned, and normalises their event lines through the same path.
 *
 * So App.js and Home.js keep working unchanged, and the day the hardware turns
 * up the only thing that happens is a toggle moving from VIRTUAL to BAND.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useBand } from './band';
import { useVirtualBand } from './virtualBand';

const MODE_KEY = 'nigehban.bandMode';

export const MODES = {
  VIRTUAL: 'virtual',   // this phone is the band
  BLE: 'ble',           // a real band over Bluetooth
};

// Replies to {"c":"auth"}, {"c":"setname"}, {"c":"setpin"} and {"c":"cfg"}.
// They travel on the same wire as an SOS and must not be routed like one.
const IDENTITY_EVENTS = new Set([
  'need_auth', 'auth_ok', 'auth_bad',
  'name_set', 'name_rejected',
  'pin_set', 'pin_rejected',
  'cfg', 'unpaired',
]);

export function useBandLink(onEvent) {
  // Virtual is the default because it is the mode that works today. The
  // preference is persisted, so a tester who switches to BLE stays there.
  const [mode, setMode] = useState(MODES.VIRTUAL);
  const [modeLoaded, setModeLoaded] = useState(false);
  const [lastSeen, setLastSeen] = useState(null);
  const [vBattery, setVBattery] = useState(null);
  const [vArmed, setVArmed] = useState(false);
  const [vHighAlert, setVHighAlert] = useState(false);

  const cb = useRef(onEvent);
  cb.current = onEvent;

  useEffect(() => {
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(MODE_KEY);
        if (saved === MODES.BLE || saved === MODES.VIRTUAL) setMode(saved);
      } catch { /* first run */ }
      setModeLoaded(true);
    })();
  }, []);

  const chooseMode = useCallback(async (m) => {
    setMode(m);
    try { await AsyncStorage.setItem(MODE_KEY, m); } catch { /* non-fatal */ }
  }, []);

  const virtualActive = mode === MODES.VIRTUAL;

  // `autoLink` is what lets a band that was linked before come back on its own
  // after the app is closed and reopened. It has to wait for the stored mode:
  // BLE is not the default, so before the read lands every launch would look
  // like virtual mode and the auto-relink would never fire.
  const ble = useBand(onEvent, { autoLink: modeLoaded && !virtualActive });

  // The virtual band hands us the same newline JSON the BLE characteristic
  // carries, so it goes through the same parse and the same state updates.
  // Anything that only worked because the event was constructed in-process
  // would be a lie; this keeps it honest.
  const onLine = useCallback((line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.t !== 'evt') return;
    setLastSeen(Date.now());
    if (typeof msg.bat === 'number') setVBattery(msg.bat);
    if (msg.e === 'armed') setVArmed(true);
    if (msg.e === 'disarmed') setVArmed(false);
    if (msg.e === 'high_alert_on') setVHighAlert(true);
    if (msg.e === 'high_alert_off') setVHighAlert(false);
    if (msg.e === 'hb') return;             // heartbeat is status, not an event
    // The identity handshake is a conversation with the band, not something
    // that happened to the wearer. `band.js` swallows these on the BLE side for
    // the same reason: passing them on would put an auth_ok through the alert
    // router, which has no idea what one is.
    if (IDENTITY_EVENTS.has(msg.e)) return;
    cb.current?.(msg);
  }, []);

  const virtual = useVirtualBand(onLine, virtualActive);

  if (!virtualActive) {
    return { ...ble, mode, chooseMode, modeLoaded, virtual,
             bleAvailable: !ble.simulated, canSetPin: true };
  }

  return {
    mode,
    chooseMode,
    modeLoaded,
    virtual,
    bleAvailable: !ble.simulated,

    // --- the useBand surface, so callers need no branching ---
    status: 'virtual',
    simulated: true,
    battery: vBattery,
    armed: vArmed,
    highAlert: vHighAlert,
    lastSeen,
    bleError: ble.bleError,
    connect: () => chooseMode(MODES.BLE),
    disconnect: async () => {},
    /** App.js sends {c:'checkin_req',...}; the virtual band handles it verbatim. */
    send: async (obj) => virtual.deliver({ t: 'cmd', ...obj }),
    /** Kept for callers that fire a conclusion rather than a gesture. */
    simulate: (e, extra = {}) => virtual.trigger(e, extra),

    // --- identity, so the Band screen needs no branching either -------------
    // Renaming works here because it is a real thing to test. A PIN does not:
    // this radio IS the phone, so there is nobody to keep out, and offering a
    // control that appears to lock something and locks nothing would be worse
    // than not offering it. The screen reads `canSetPin` and hides it.
    bandName: virtual.name,
    defaultPin: false,
    canSetPin: false,
    renameBand: async (name) => virtual.deliver({ t: 'cmd', c: 'setname', name }),
    submitPin: async () => false,
    changePin: async () => false,
    unpairAll: async () => false,
  };
}
