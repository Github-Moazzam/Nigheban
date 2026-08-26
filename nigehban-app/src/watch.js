import { useEffect, useRef } from 'react';
import { call } from './api';

// expo-location is loaded defensively, as everywhere else: an older build must
// degrade to "no position with this heartbeat", never take the app down.
let Location = null;
try { Location = require('expo-location'); } catch { /* no position available */ }

export const BEAT_MS = 60000;

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
export function useHeartbeat(session, { mode, bandLink, batt }) {
  const state = useRef({ mode, bandLink, batt });
  state.current = { mode, bandLink, batt };

  useEffect(() => {
    if (!session?.token || mode === 'idle') return undefined;
    let alive = true;

    const beat = async () => {
      if (!alive) return;
      const cur = state.current;
      let pos = null;
      try {
        pos = Location ? await Location.getLastKnownPositionAsync() : null;
      } catch { /* permission denied, or no fix yet */ }
      try {
        await call(session, '/heartbeat', {
          method: 'POST',
          body: {
            mode: cur.mode,
            band_link: !!cur.bandLink,
            phone_batt: cur.batt == null ? null : Math.round(cur.batt),
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
