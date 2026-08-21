import { useEffect, useRef } from 'react';
import { call } from './api';

// expo-location is loaded defensively, as everywhere else: an older build must
// degrade to "no position with this heartbeat", never take the app down.
let Location = null;
try { Location = require('expo-location'); } catch { /* no position available */ }

export const BEAT_MS = 60000;

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
