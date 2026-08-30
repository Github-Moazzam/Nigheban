/**
 * Offline SOS queue — persistent, retry-capable alert storage.
 *
 * When an SOS is pressed and the server cannot be reached, the alert payload
 * (including the GPS fix at the moment the button was pressed) is saved here.
 * When the WebSocket reconnects, `flushQueue` sends every pending alert and
 * removes each one that succeeds.
 *
 * Storage: AsyncStorage, keyed under 'nigehban.alertQueue'. The queue is a
 * JSON array of items, each with a client-generated id so individual entries
 * can be removed without disturbing the rest.
 *
 * This module is intentionally small: it is a queue, not a state machine.
 * The state machine lives in state.js and does not need to know about this.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ALERT_TIMEOUT, call, loadSession } from './api';
import { lastKnownFix } from './watch';

const QUEUE_KEY = 'nigehban.alertQueue';

let _counter = 0;

/**
 * The id of ONE press.
 *
 * Minted when the button goes down and carried on the first attempt and every
 * retry of it, as `client_id`. The server has a unique index on it (migration
 * 004), so a press that lands but whose reply never gets home can be sent
 * again as many times as the network demands and still be one alert and one
 * page to the family.
 *
 * It doubles as the queue entry's own id, so the row in storage, the id the
 * SOS screen holds, and the key the server dedupes on are all the same string.
 */
export function pressId() {
  return `local-${Date.now()}-${++_counter}`;
}

// ----------------------------------------------------------------- read ---

/** Returns the current queue (may be empty). Never throws. */
export async function getPending() {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

// -------------------------------------------------------------- write ---

/**
 * Saves an unsent alert to persistent storage.
 *
 * `payload` is the exact body that would have gone to `POST /alert`:
 *   { kind, source, lat, lon, accuracy, note }
 *
 * The GPS fix is already baked in by the caller — it is Point A, where the
 * button was pressed, not wherever the phone drifts to while offline. That
 * distinction matters: the family needs to know where the danger was.
 */
export async function enqueue(payload) {
  // The press already has an id if it came from `raise` -- reuse it rather
  // than minting a second one, or the queue entry and the server's dedupe key
  // stop being the same thing.
  const id = payload?.client_id || pressId();
  const item = {
    localId: id,
    payload,
    queuedAt: Date.now() / 1000,
    status: 'queued',
  };
  try {
    const queue = await getPending();
    queue.push(item);
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch { /* best effort — the in-app SOS state is still live */ }
  return id;
}

/**
 * Removes a single delivered item by its localId.
 */
export async function dequeue(id) {
  try {
    const queue = await getPending();
    const next = queue.filter((item) => item.localId !== id);
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(next));
  } catch { /* non-fatal */ }
}

/** Drops every item. Called on sign-out so a new user does not inherit them. */
export async function clearQueue() {
  try { await AsyncStorage.removeItem(QUEUE_KEY); } catch { /* non-fatal */ }
}

/** How many alerts are still waiting. Cheap enough to call on every wake. */
export async function pendingCount() {
  return (await getPending()).length;
}

// -------------------------------------------------------------- flush ---

// One flush at a time, for the whole app.
//
// App.js had an interlock, but it was a React ref -- so it covered the three
// triggers inside the tree (socket rising edge, AppState, timer) and could not
// see the fourth. The foreground service calls flushPending() from outside
// that tree, on its own 60 s tick, and the two overlapping meant both read the
// same queue and both sent it: `dequeue` re-reads and rewrites the whole array
// per item, so the second flush was working from a list the first had not
// finished emptying.
//
// The interlock belongs to the queue, not to a screen that may not be mounted.
let _flushing = false;

export async function flushQueue(session) {
  if (_flushing) return { delivered: [], failed: [], skipped: true };
  _flushing = true;
  try {
    return await _flush(session);
  } finally {
    _flushing = false;
  }
}

/**
 * Tries to deliver every queued alert. Returns an object describing what
 * happened so the caller can update the UI.
 *
 * For each item that succeeds, the server's response (including `delivered_to`
 * and the real `alert` row) is captured. Failed items stay in the queue for
 * the next reconnect.
 *
 * When flushing, the *current* GPS fix is appended to the note so the family
 * can see both where the SOS was pressed (Point A, in lat/lon) and where the
 * phone is now (Point B, in the note). This costs nothing — the note field
 * already exists and the server stores it as free text.
 */
async function _flush(session) {
  const queue = await getPending();
  if (!queue.length) return { delivered: [], failed: [] };

  // Grab Point B once, not per item.
  let currentFix = null;
  try { currentFix = await lastKnownFix(); } catch { /* best effort */ }

  const delivered = [];
  const failed = [];

  for (const item of queue) {
    try {
      // Append current location to the note so the family sees both points.
      const body = { ...item.payload };
      if (currentFix?.lat && currentFix?.lon) {
        const pointB = `Current location: ${currentFix.lat.toFixed(5)}, ${currentFix.lon.toFixed(5)}`;
        body.note = body.note ? `${body.note} | ${pointB}` : pointB;
      }

      const r = await call(session, '/alert', { method: 'POST', body, timeout: ALERT_TIMEOUT });
      delivered.push({ localId: item.localId, response: r });
      await dequeue(item.localId);
    } catch {
      failed.push(item.localId);
    }
  }

  return { delivered, failed };
}

/**
 * The same flush, for a caller with no React tree behind it.
 *
 * The app's flush hangs off the WebSocket's rising edge, which only exists
 * while the UI is mounted. That left the worst case of all unhandled: SOS
 * pressed in a dead zone, app swiped away, signal returns — and the alert sat
 * on the phone until somebody thought to open the app, which is not something
 * a person in trouble is going to do.
 *
 * So the Android foreground service's own 60 s tick calls this. It runs
 * headless, reads the session off disk because there is no `session` prop out
 * here, and delivers whatever is waiting. Doing nothing when the queue is
 * empty is the normal case and must stay cheap — it is one AsyncStorage read.
 */
export async function flushPending() {
  const queue = await getPending();
  if (!queue.length) return { delivered: [], failed: [] };

  const session = await loadSession();
  if (!session?.token) return { delivered: [], failed: [] };

  return flushQueue(session);
}
