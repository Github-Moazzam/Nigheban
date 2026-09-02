import { useEffect, useRef, useState } from 'react';
import { call } from './api';
import { noteFix } from './motion';

// expo-location is loaded defensively, as everywhere else: an older build must
// degrade to "no position with this heartbeat", never take the app down.
let Location = null;
try { Location = require('expo-location'); } catch { /* no position available */ }

let Battery = null;
try { Battery = require('expo-battery'); } catch { /* no phone battery reading */ }

export const BEAT_MS = 60000;

/**
 * This phone's own battery, 0-100, or null if it cannot be read.
 *
 * It had never been read outside virtualBand.js, where expo-battery stands in
 * for the band's ADC pin so the escalation can be tested by leaving the phone
 * unplugged. Everywhere else `band.battery` was sent as `phone_batt` and shown
 * to the family as "phone about to die" -- so in BLE mode the family was told
 * about the wristband while believing they were told about the phone.
 *
 * The two fail independently and mean different things. A flat band means the
 * safety device is off the air; a flat phone means every path to the family is
 * about to close, including the push that a flat band would otherwise still
 * reach them by.
 */
export function usePhoneBattery() {
  const [level, setLevel] = useState(null);

  useEffect(() => {
    if (!Battery) return undefined;
    let alive = true;
    let sub = null;

    (async () => {
      try {
        const lvl = await Battery.getBatteryLevelAsync();
        // -1 is expo-battery's "unknown", which must not read as a flat phone.
        if (alive && lvl >= 0) setLevel(lvl * 100);
        sub = Battery.addBatteryLevelListener(({ batteryLevel }) => {
          if (alive && batteryLevel >= 0) setLevel(batteryLevel * 100);
        });
      } catch { /* stays null: unknown is not the same as empty */ }
    })();

    return () => { alive = false; try { sub?.remove(); } catch { /* never set */ } };
  }, []);

  return level;
}

/**
 * The last position this phone knows about, without waking the GPS.
 *
 * Alerts used to carry only the fix the Home screen was watching, which meant
 * an SOS raised from any other tab -- or from the band while the app was
 * backgrounded, which is the normal case -- went out with no coordinates at
 * all. The family got "EMERGENCY" and no map link, which is most of the value
 * gone. The heartbeat was already reading this exact cache every minute; the
 * alert path just was not.
 *
 * Deliberately not a live `getCurrentPositionAsync`: that can block for tens of
 * seconds waiting on a fix, and an SOS must leave the phone now. A slightly
 * stale position beats a punctual empty one, and the heartbeat keeps it fresh
 * while the watch is armed.
 */
export async function lastKnownFix() {
  try {
    const pos = Location ? await Location.getLastKnownPositionAsync() : null;
    if (!pos?.coords) return null;
    // Free, and occasionally the only thing there is. A cached fix is usually
    // one motion.js already has -- noteFix keys on the timestamp and drops the
    // repeat -- but when the watch has been shut down or has never run, this is
    // the sole position the app sees, and a stale sample that knows it is stale
    // beats no history at all.
    noteFix(pos.coords, pos.timestamp || Date.now());
    return {
      lat: pos.coords.latitude,
      lon: pos.coords.longitude,
      acc: pos.coords.accuracy ?? null,
    };
  } catch {
    return null;                 // permission denied, or no fix yet
  }
}

/**
 * "I am still here", once a minute, while the watch is armed.
 *
 * The server's watchdog works on silence: three minutes without one of these,
 * while the mode is not idle, and the family is told that her watch has stopped
 * reporting. So this is not telemetry — the absence of it is the alert. That
 * inversion is the only reason the product has an answer to "what if her phone
 * is dead", short of the mesh in v2.
 *
 * Only armed states beat. An idle phone going quiet is a phone in a pocket.
 *
 * Position comes from the last known fix rather than a live GPS read: the fix
 * is already being watched on the Home screen, and waking the GPS every minute
 * would cost more battery than the feature is worth. It is there so that
 * `watch_lost` can tell the family where the phone was when it went quiet.
 */
export function useHeartbeat(session, { mode, bandLink, bandBatt, phoneBatt, virtual }) {
  const state = useRef({ mode, bandLink, bandBatt, phoneBatt, virtual });
  state.current = { mode, bandLink, bandBatt, phoneBatt, virtual };

  useEffect(() => {
    if (!session?.token || mode === 'idle') return undefined;
    let alive = true;

    const beat = async () => {
      if (!alive) return;
      const cur = state.current;
      let pos = null;
      try {
        pos = Location ? await Location.getLastKnownPositionAsync() : null;
        // Same reasoning as lastKnownFix: this already reads a position every
        // minute for the watchdog, and dropping it on the floor afterwards was
        // free data thrown away.
        if (pos?.coords) noteFix(pos.coords, pos.timestamp || Date.now());
      } catch { /* permission denied, or no fix yet */ }
      try {
        await call(session, '/heartbeat', {
          method: 'POST',
          body: {
            mode: cur.mode,
            band_link: !!cur.bandLink,
            // Sent separately and never substituted for one another. A null
            // band_batt is virtual mode, where there is no second cell -- not
            // a band at zero.
            phone_batt: cur.phoneBatt == null ? null : Math.round(cur.phoneBatt),
            band_batt: cur.bandBatt == null ? null : Math.round(cur.bandBatt),
            // Which device band_link is about. A null band_batt is ambiguous on
            // its own -- it is also what a real band sends before its first
            // reading -- so the server is told outright, and clears any reading
            // an earlier real band left behind. See migration 003.
            virtual: !!cur.virtual,
            lat: pos?.coords?.latitude ?? null,
            lon: pos?.coords?.longitude ?? null,
          },
        });
      } catch { /* the watchdog exists precisely to notice this */ }
    };

    beat();                                  // one immediately, so arming counts
    const id = setInterval(beat, BEAT_MS);
    return () => { alive = false; clearInterval(id); };
  }, [session, mode]);
}

/**
 * B3.3 / U4.4 — presence, so a stranger's emergency can find whoever is near.
 *
 * Posted at most every five minutes, only from a fix the Home screen is
 * already watching, and only ever one row per person on the server. It is not
 * a location history: it is the answer to "is anybody close enough to help",
 * and it is deliberately too coarse to be anything else.
 */
export const PRESENCE_EVERY_MS = 300000;

export function usePresence(session, fix) {
  const last = useRef(0);

  useEffect(() => {
    if (!session?.token || !fix) return;
    const now = Date.now();
    if (now - last.current < PRESENCE_EVERY_MS) return;
    last.current = now;
    call(session, '/presence', { method: 'POST', body: { lat: fix.lat, lon: fix.lon } })
      .catch(() => { last.current = 0; });   // try again on the next fix
  }, [session, fix]);
}
