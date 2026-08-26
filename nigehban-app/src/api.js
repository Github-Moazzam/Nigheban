import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { useEffect, useRef, useState } from 'react';

const KEY = 'nigehban.session';
const URL_KEY = 'nigehban.serverUrl';
const SERVER_PORT = 8000;

/**
 * The laptop's address, for free.
 *
 * In development the phone has already downloaded this bundle from Metro, so
 * Expo knows exactly which host it came from -- and the Nigehban server is the
 * same machine on a different port. No typing, no scanning, no guessing.
 *
 * Returns '' in a standalone production build, where there is no dev server to
 * infer from; the saved address and the subnet sweep cover that case.
 */
export function serverFromDevHost() {
  const hostUri =
    Constants.expoConfig?.hostUri ||
    Constants.expoGoConfig?.debuggerHost ||
    Constants.manifest2?.extra?.expoClient?.hostUri ||
    '';
  const host = hostUri.split('/')[0].split(':')[0];
  if (!host || host === 'localhost' || host === '127.0.0.1') return '';
  return `http://${host}:${SERVER_PORT}`;
}

/** Remembered separately from the session so it survives signing out. */
export async function saveServerUrl(url) {
  try { await AsyncStorage.setItem(URL_KEY, url); } catch { /* non-fatal */ }
}
export async function loadServerUrl() {
  try { return (await AsyncStorage.getItem(URL_KEY)) || ''; } catch { return ''; }
}

/** Is something actually answering there? Used to pick between candidates. */
export async function probe(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const r = await fetch(url + '/health', { signal: ctrl.signal, headers: TUNNEL_HEADERS });
    if (!r.ok) return false;
    const j = await r.json();
    return !!(j && j.ok);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Finds the laptop by knocking on every address in the phone's own subnet.
 *
 * A LAN has no directory service, so there is nothing to ask -- the only way to
 * locate the server without typing its address is to try them all. 254 hosts
 * with a short timeout, 32 at a time so we do not exhaust sockets, is a couple
 * of seconds on a normal home or hotspot network.
 */
export async function discoverServers(onProgress) {
  // expo-network is loaded lazily and defensively: an APK built before it was
  // added still runs this JavaScript from Metro, and a missing native module
  // must degrade to "cannot scan" rather than take the screen down with it.
  let ip;
  try {
    const Network = require('expo-network');
    ip = await Network.getIpAddressAsync();
  } catch {
    throw new Error(
      'Automatic search needs a newer build of the app. Type the address from '
      + 'the laptop terminal instead — it works exactly the same.');
  }
  if (!ip || ip === '0.0.0.0' || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return [];

  const base = ip.split('.').slice(0, 3).join('.');
  const hosts = Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`);
  const found = [];
  const BATCH = 32;

  for (let i = 0; i < hosts.length; i += BATCH) {
    await Promise.all(hosts.slice(i, i + BATCH).map(async (h) => {
      const url = `http://${h}:${SERVER_PORT}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 900);
      try {
        const r = await fetch(url + '/health', { signal: ctrl.signal });
        if (r.ok) {
          const j = await r.json();
          if (j && j.ok) found.push(url);
        }
      } catch {
        /* nothing listening here -- expected for almost every address */
      } finally {
        clearTimeout(timer);
      }
    }));
    onProgress?.(Math.min(1, (i + BATCH) / hosts.length));
  }
  return found;
}

/**
 * Normalises anything a person might paste into the address box.
 *
 * Three shapes have to work, and the old rule (always http, always :8000)
 * silently broke two of them:
 *
 *   192.168.1.5            -> http://192.168.1.5:8000   the laptop on this Wi-Fi
 *   a1b2c3.ngrok-free.app  -> https://a1b2c3.ngrok-free.app   the tunnel
 *   nigehban.example.com   -> https://nigehban.example.com    the cloud
 *
 * The rule: a bare IPv4 (or localhost) is the laptop, so it gets http and the
 * dev port. Anything with a name is a public host, so it gets https and
 * whatever port that scheme implies. Appending :8000 to a tunnel address is
 * what makes it fail, and it fails as a timeout rather than an error, which
 * costs an hour of blaming the firewall.
 */
export function normaliseUrl(raw) {
  let u = (raw || '').trim().replace(/\/+$/, '');
  if (!u) return '';

  const hasScheme = /^https?:\/\//i.test(u);
  const body = u.replace(/^https?:\/\//i, '');
  const host = body.split('/')[0].split(':')[0];
  const isLocal = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host === 'localhost';

  if (!hasScheme) u = (isLocal ? 'http://' : 'https://') + u;

  // Only a local address gets the dev port filled in for it.
  const portless = !/:\d+(\/|$)/.test(body);
  if (isLocal && portless && /^http:\/\//i.test(u)) u += ':' + SERVER_PORT;

  return u;
}

/** ws:// for a plain server, wss:// for a tunnel or the cloud. */
export function wsUrl(httpUrl) {
  return httpUrl.replace(/^http/i, 'ws');
}

/**
 * ngrok serves an HTML interstitial to anything that looks like a browser,
 * which arrives as a 200 full of HTML and turns into a confusing JSON parse
 * error. This header opts out of it, and it is harmless everywhere else.
 */
export const TUNNEL_HEADERS = { 'ngrok-skip-browser-warning': 'true' };

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

/** Thin REST wrapper. Throws Error(message) with the server's own wording,
 *  because the server already writes errors a person can act on. */
export async function call(session, path, { method = 'GET', body } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(session.url + path, {
      method,
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...TUNNEL_HEADERS,
        ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-json */ }
    if (!res.ok) {
      throw new Error((data && data.detail) || `server said ${res.status}`);
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error('the server did not answer — is it running, and is the address current?');
    }
    if (e.message === 'Network request failed') {
      throw new Error('cannot reach the server — check the address; a tunnel URL changes each restart');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

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
