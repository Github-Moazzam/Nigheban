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
// TEMP: pointed at the local backend for development. The web build runs on
// :8081 (Metro) and the API on :8000; ALLOWED_ORIGINS in .env already lists
// http://localhost:8081 so the browser's CORS preflight passes.
// Revert to the duckdns URL before shipping.

// export const SERVER_URL = 'https://nigheban.duckdns.org';

export const SERVER_URL = 'http://localhost:8000';

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
 * Every way a fetch can fail before it reaches the server, in every platform's
 * own words.
 *
 * This is a list rather than one string because the web build is a first-class
 * target now: React Native says "Network request failed", but Chrome says
 * "Failed to fetch", Firefox "NetworkError when attempting to fetch resource",
 * and Safari "Load failed". Matching only the React Native wording -- which is
 * what this did -- meant that on web every unreachable-server case fell through
 * untranslated and put the browser's own words on the sign-in screen.
 *
 * They are one case and not several on purpose. A refused connection, a DNS
 * failure and a blocked CORS preflight are deliberately indistinguishable from
 * JavaScript, so guessing between them would only ever be a guess.
 */
const NETWORK_FAIL = /network request failed|failed to fetch|networkerror|load failed|connection (refused|reset)|internet connection appears to be offline/i;

/**
 * What to say when the server refuses but does not say why.
 *
 * The server usually does say why, and its own wording wins over everything
 * here -- these are the fallback for a refusal that arrives with no readable
 * body, which in practice means a proxy or a gateway answered instead of the
 * app. A bare "server said 502" is a status code with a sentence around it, not
 * an explanation.
 */
const BY_STATUS = {
  400: 'Something in that form was not accepted.',
  401: 'Your username or password is incorrect.',
  403: 'You are not allowed to do that.',
  404: 'The app asked for something this server does not have.',
  409: 'That is already taken.',
  413: 'That was too large to send.',
  429: 'Too many tries. Please wait a few minutes and try again.',
  500: 'The server ran into a problem. Please try again in a moment.',
  502: 'The server is not answering right now. Please try again in a moment.',
  503: 'The server is not answering right now. Please try again in a moment.',
  504: 'The server took too long to answer. Please try again.',
};

const LABEL = { username: 'Username', password: 'Password', name: 'Name', band_pin: 'Band PIN' };

function labelFor(f) {
  return LABEL[f] || f.charAt(0).toUpperCase() + f.slice(1).replace(/_/g, ' ');
}

/** Capital in front, full stop behind. The server writes lowercase fragments. */
function sentence(s) {
  const t = String(s).trim();
  if (!t) return '';
  const c = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(c) ? c : `${c}.`;
}

/**
 * Which box a message is about, read out of the server's own wording.
 *
 * Cheap, and it holds because the server names the field it is complaining
 * about in every message it writes ("that username is taken", "password must be
 * at least 4 characters"). The both-words case is the important one: "wrong
 * username or password" is deliberately ambiguous so that a wrong username and
 * a wrong password are indistinguishable to someone guessing, and pointing at
 * either box would undo that.
 */
function fieldOf(msg) {
  const m = String(msg).toLowerCase();
  const u = m.includes('username');
  const p = m.includes('password');
  if (u && p) return null;
  if (u) return 'username';
  if (p) return 'password';
  if (m.includes('name')) return 'name';
  return null;
}

/**
 * FastAPI's 422 body is a list of {loc, msg}.
 *
 * `loc` is ["body", "<field>"] and is the only place the field name appears --
 * the bare `msg` is "Field required" for every box alike, so joining the msgs
 * (which is what this did) produced "Field required, Field required".
 */
function fromValidation(items) {
  const parts = [];
  let field = null;
  for (const it of items) {
    const loc = Array.isArray(it.loc) ? it.loc.filter((x) => x !== 'body') : [];
    const name = loc.length ? String(loc[loc.length - 1]) : null;
    if (name && !field) field = name;
    const msg = String(it.msg || 'is not valid').replace(/^value error,\s*/i, '');
    parts.push(name ? `${labelFor(name)}: ${msg.toLowerCase()}` : msg);
  }
  return { message: parts.join('. ') || 'Some of that was not accepted.', field };
}

/**
 * One Error shape for the whole app: a sentence to show, plus enough structure
 * for a screen to do more than show it.
 *
 * `field` lets a form point at the box instead of only describing it, `status`
 * lets the sign-in screen recognise a 429, and `kind` picks the icon. Callers
 * that only read `.message` keep working.
 */
function apiError(message, { status = 0, field = null, kind = 'error', cause } = {}) {
  const e = new Error(sentence(message));
  e.status = status;
  e.field = field;
  e.kind = kind;
  if (cause) e.cause = cause;
  return e;
}

function kindOf(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate';
  if (status >= 500) return 'server';
  return 'error';
}

/**
 * Thin REST wrapper. Throws an Error carrying the server's own wording where
 * there is any, because the server already writes errors a person can act on --
 * and a sentence of this module's own where there is not, because the
 * alternative reaching a user is a status code or a browser's internals.
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
    let parsed = false;
    try { data = text ? JSON.parse(text) : null; parsed = true; } catch { /* non-json */ }

    if (!res.ok) {
      const detail = data && data.detail;
      let message = null;
      let field = null;
      if (Array.isArray(detail)) {
        ({ message, field } = fromValidation(detail));
      } else if (typeof detail === 'string' && detail.trim()) {
        message = detail.trim();
        field = fieldOf(message);
      }
      // An object detail used to be JSON.stringify'd onto the screen. There is
      // nothing in a serialised object a user can act on, so it falls through
      // to the status sentence like any other unreadable body.
      throw apiError(message || BY_STATUS[res.status] || `The server refused that (error ${res.status})`,
                     { status: res.status, field, kind: kindOf(res.status) });
    }

    // A 200 whose body is not JSON is the app talking to something that is not
    // this API -- a dev server's index page, a captive portal, a proxy. It used
    // to return null here and surface a screen or two later as an unexplained
    // "something went wrong"; saying so at the point it is known is the whole
    // difference between a five-minute diagnosis and an afternoon's.
    if (text && !parsed) {
      const html = /^\s*(<!doctype|<html)/i.test(text);
      throw apiError(
        html
          ? 'The server sent a web page instead of data — the app may be pointed at the wrong address'
          : 'The server sent something this app could not read',
        { status: res.status, kind: 'protocol' });
    }
    return data;
  } catch (e) {
    if (e.kind) throw e;                       // already one of ours
    if (e.name === 'AbortError') {
      throw apiError('The server did not answer in time. Please check your connection and try again',
                     { kind: 'timeout' });
    }
    if (NETWORK_FAIL.test(e.message || '')) {
      throw apiError('Cannot reach the server. Please check your internet connection and try again',
                     { kind: 'network' });
    }
    // A bug in this module or a caller, not a server problem. The user gets a
    // sentence; the original is kept on `cause` so it is still debuggable.
    if (typeof __DEV__ !== 'undefined' && __DEV__) console.warn('[api]', method, path, e);
    throw apiError('Something went wrong. Please try again', { kind: 'unknown', cause: e });
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

