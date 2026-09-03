import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useRef, useState } from 'react';

const KEY = 'nigehban.session';

/**
 * The one and only server address.
 *
 * The backend is permanently deployed behind this domain, so the app no longer
 * needs to ask for, discover, or remember a server URL. Every API call and
 * every WebSocket connection goes here.
 */
export const SERVER_URL = 'https://nigheban.duckdns.org';

/** ws:// for a plain server, wss:// for a tunnel or the cloud. */
export function wsUrl(httpUrl) {
  return httpUrl.replace(/^http/i, 'ws');
}

export async function saveSession(s) {
  await AsyncStorage.setItem(KEY, JSON.stringify(s));
}
export async function loadSession() {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
export async function clearSession() {
  await AsyncStorage.removeItem(KEY);
}

/**
 * Thin REST wrapper. Throws Error(message) with the server's own wording,
 * because the server already writes errors a person can act on.
 *
 * `timeout` is per call, and 8 s is the wrong number for exactly one endpoint.
 *
 * Giving up on a request the server has already acted on is not a neutral act:
 * for /alert it meant the press was queued as undelivered and sent again, so a
 * slow network turned one SOS into four rows and four pages. The alert now
 * carries a `client_id` so a retry is free -- but the first attempt should
 * still be given room to finish rather than raced. See ALERT_TIMEOUT.
 */
export async function call(session, path, { method = 'GET', body, timeout = 8000 } = {}) {
  const url = (session.url || SERVER_URL) + path;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-json */ }
    if (!res.ok) {
      let msg = data && data.detail;
      if (Array.isArray(msg)) msg = msg.map((m) => m.msg || JSON.stringify(m)).join(', ');
      else if (typeof msg === 'object' && msg !== null) msg = JSON.stringify(msg);
      throw new Error(msg || `server said ${res.status}`);
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error('the server did not answer — please check your internet connection.');
    }
    if (e.message === 'Network request failed') {
      throw new Error('cannot reach the server — please check your internet connection.');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The deadline for raising an alert, as opposed to any other call.
 *
 * Longer than the rest because the cost of being wrong is asymmetric: a call
 * that waits too long shows a spinner, and a call that gives up too early
 * duplicates an emergency. Twenty seconds is comfortably past the server's own
 * worst case now that the Expo pushes have been moved off the request path.
 */
export const ALERT_TIMEOUT = 20000;

/**
 * How often the phone proves the socket is still a socket, and how long the
 * server has to prove it back.
 *
 * A carrier NAT drops an idle mobile connection without telling either end, so
 * `onclose` never fires and `readyState` stays OPEN. The app goes on showing
 * "connected" while every check-in buzz and every family alert lands in a pipe
 * that ends nowhere -- the worst failure this product has, because it is silent
 * and it looks exactly like nothing happening.
 *
 * TCP keep-alive is too slow to help (hours, and not configurable here), so the
 * liveness check has to live at the application layer. The server already
 * answers {"t":"ping"} with {"t":"pong"}; this is the other half.
 */
const PING_EVERY_MS = 30000;
const PONG_GRACE_MS = 10000;

/** Live socket to the server, with reconnect. Delivers alerts, stand-downs,
 *  acks and check-in requests as they happen. */
export function useLive(session, handlers) {
  const [online, setOnline] = useState(false);
  const ws = useRef(null);
  const retry = useRef(null);
  const alive = useRef(true);
  const hRef = useRef(handlers);
  hRef.current = handlers;

  useEffect(() => {
    if (!session?.token) return;
    alive.current = true;

    let pingTimer = null;
    let pongTimer = null;

    const stopBeat = () => {
      clearInterval(pingTimer); pingTimer = null;
      clearTimeout(pongTimer); pongTimer = null;
    };

    const connect = () => {
      if (!alive.current) return;
      const target = wsUrl(session.url) + `/ws?token=${session.token}`;
      let s;
      try { s = new WebSocket(target); } catch { retry.current = setTimeout(connect, 2500); return; }
      ws.current = s;

      const startBeat = () => {
        stopBeat();
        pingTimer = setInterval(() => {
          if (s.readyState !== 1) return;                 // 1 === OPEN
          try { s.send(JSON.stringify({ t: 'ping' })); } catch { return; }
          // A half-open socket accepts the write and never answers, so the
          // missing pong -- not a send error -- is what exposes it. Closing
          // here hands the existing onclose the reconnect it already knows
          // how to do, rather than growing a second retry path.
          clearTimeout(pongTimer);
          pongTimer = setTimeout(() => {
            try { s.close(); } catch { /* already gone */ }
          }, PONG_GRACE_MS);
        }, PING_EVERY_MS);
      };

      s.onopen = () => { setOnline(true); startBeat(); };
      s.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        // Any frame at all proves the pipe is alive, so the deadline clears on
        // traffic rather than only on the pong we asked for.
        clearTimeout(pongTimer); pongTimer = null;
        if (m.t === 'pong') return;
        const fn = hRef.current?.[m.t];
        if (fn) fn(m);
      };
      s.onclose = () => {
        stopBeat();
        ws.current = null;
        setOnline(false);
        if (alive.current) retry.current = setTimeout(connect, 2500);
      };
      s.onerror = () => {};
    };

    connect();
    return () => {
      alive.current = false;
      stopBeat();
      clearTimeout(retry.current);
      const s = ws.current;
      ws.current = null;
      if (s) { s.onclose = null; s.close(); }
    };
  }, [session?.token, session?.url]);

  return online;
}

/** Update user account settings (e.g. samaritan_enabled). */
export async function updateUserSettings(session, patch) {
  return call(session, '/me/settings', {
    method: 'PATCH',
    body: patch,
  });
}

/**
 * Remember this account's band PIN, so a forgotten one is recoverable.
 *
 * Called whenever the band has ACCEPTED a PIN -- never on a guess. Best effort
 * on purpose: the band is already using it and the phone has already stored it,
 * so a failure here costs the recovery path and nothing else, and must not turn
 * a successful PIN change into an error on screen.
 */
export async function saveBandPin(session, pin) {
  return call(session, '/me/band-pin', {
    method: 'PUT',
    body: { band_pin: pin },
  });
}

/**
 * Get it back. The caller must put the four-digit app PIN in front of this.
 *
 * Needs a network, which is the trade: the phone forgets the band PIN when
 * somebody presses Disconnect -- deliberately -- so the account is the only
 * copy left at exactly the moment it is wanted.
 */
export async function fetchBandPin(session) {
  const r = await call(session, '/me/band-pin');
  return r?.band_pin || null;
}

/** Explicitly allow or deny Good Samaritan emergency broadcast. */
export async function optinSamaritan(session, alertId, action) {
  return call(session, `/alert/${alertId}/samaritan-optin`, {
    method: 'POST',
    body: { action },
  });
}

