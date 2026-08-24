import { useCallback, useMemo, useReducer } from 'react';

/**
 * U2 — the client state machine.
 *
 * Every band event and every socket message lands here and produces exactly
 * one transition. The alternative -- an `if` chain per screen -- is how the
 * same mode ends up half-armed in two places, which is the bug class this
 * file exists to make impossible.
 *
 * The design rule, from the execution plan: **the phone is an actuator, never
 * a timekeeper.** Deadlines belong to the server. `checkin.due_at` is stored
 * here so the UI can render a countdown, but nothing in this file decides that
 * a deadline has passed; the sweeper does, and it tells us.
 *
 * The one deliberate exception is `fall_pending`. A fall countdown must be
 * cancellable *before* an alert exists, so there is nothing on the server yet
 * to own it. Thirty seconds of local clock is the price of "I'm fine" working
 * at all, and the alert it raises afterwards is server-owned like every other.
 *
 * High Alert is a mode, not a moment: it is armed in `context.highAlert` and
 * it is also the state the machine rests in, so a check-in that comes and goes
 * returns to `high_alert` rather than to `idle`.
 */

export const STATES = ['idle', 'high_alert', 'checkin_pending', 'fall_pending', 'sos_live'];

/**
 * The legal transitions, as data.
 *
 * `null` means "stay where you are" -- the event is still handled, it just does
 * not move the machine. An event missing from a state's row is illegal there
 * and is dropped: a `buzz_now` racing in behind a live SOS must not demote the
 * SOS to a check-in.
 */
const TRANSITIONS = {
  idle: {
    SOS_RAISED:     'sos_live',
    FALL_DETECTED:  'fall_pending',
    CHECKIN_ASKED:  'checkin_pending',
    HIGH_ALERT_SET: 'rest',
  },
  high_alert: {
    SOS_RAISED:     'sos_live',
    FALL_DETECTED:  'fall_pending',
    CHECKIN_ASKED:  'checkin_pending',
    HIGH_ALERT_SET: 'rest',
  },
  checkin_pending: {
    SOS_RAISED:     'sos_live',
    FALL_DETECTED:  'fall_pending',
    CHECKIN_ASKED:  'checkin_pending',   // a newer question replaces the old one
    CHECKIN_CLOSED: 'rest',
    HIGH_ALERT_SET: null,
  },
  fall_pending: {
    SOS_RAISED:     'sos_live',          // countdown ran out, or they pressed SOS
    FALL_CANCELLED: 'rest',
    CHECKIN_ASKED:  null,                // answer the fall first
    HIGH_ALERT_SET: null,
  },
  sos_live: {
    SOS_CLEARED:    'rest',
    CHECKIN_ASKED:  null,
    FALL_DETECTED:  null,                // already the worst case
    HIGH_ALERT_SET: null,
  },
};

const EMPTY = {
  activeSos:  null,   // the alert row this phone raised, while it is live
  checkin:    null,   // { checkin_id, due_at, window, from, system, reason }
  highAlert:  false,
  nextBuzzAt: null,   // server-owned, rendered but never counted down to zero here
  fall:       null,   // { severity, endsAt, note }
  battery:    { level: null, low: false, goingDark: false },
  responders: [],     // family who have said "I'm on it" to the live alert
};

function reduce(cur, action) {
  if (action.type === 'RESET') return { state: 'idle', context: EMPTY };

  const row = TRANSITIONS[cur.state] || {};
  const target = Object.prototype.hasOwnProperty.call(row, action.type)
    ? row[action.type]
    : undefined;

  // Context-only events are legal in every state; they carry no transition.
  const ctxOnly = CONTEXT_ONLY[action.type];
  if (ctxOnly) return { ...cur, context: ctxOnly(cur.context, action) };

  if (target === undefined) return cur;                    // illegal here: drop it

  const context = (APPLY[action.type] || ((c) => c))(cur.context, action);
  const state = target === null ? cur.state
              : target === 'rest' ? (context.highAlert ? 'high_alert' : 'idle')
              : target;
  return { state, context };
}

/** What each transition does to the context. Kept next to the table on purpose. */
const APPLY = {
  SOS_RAISED:     (c, a) => ({ ...c, activeSos: a.alert || c.activeSos, fall: null, responders: [] }),
  SOS_CLEARED:    (c)    => ({ ...c, activeSos: null, responders: [] }),
  FALL_DETECTED:  (c, a) => ({ ...c, fall: { severity: a.severity ?? 4, endsAt: a.endsAt, note: a.note || '' } }),
  FALL_CANCELLED: (c)    => ({ ...c, fall: null }),
  CHECKIN_ASKED:  (c, a) => ({ ...c, checkin: a.checkin }),
  CHECKIN_CLOSED: (c)    => ({ ...c, checkin: null }),
  HIGH_ALERT_SET: (c, a) => ({ ...c, highAlert: !!a.on, nextBuzzAt: a.on ? (a.nextBuzzAt ?? c.nextBuzzAt) : null }),
};

/** Events that describe the world rather than move through it. */
const CONTEXT_ONLY = {
  NEXT_BUZZ:  (c, a) => ({ ...c, nextBuzzAt: a.at ?? null }),
  BATTERY:    (c, a) => ({ ...c, battery: { level: a.level, low: a.low, goingDark: a.goingDark } }),
  RESPONDER:  (c, a) => (c.responders.some((r) => r.id === a.by.id)
                          ? c
                          : { ...c, responders: [...c.responders, { ...a.by, at: Date.now() / 1000 }] }),
  SYNC:       (c, a) => ({ ...c, ...a.patch }),
};

export function useSafetyMachine() {
  const [machine, rawDispatch] = useReducer(reduce, { state: 'idle', context: EMPTY });

  const dispatch = useCallback((type, payload) => rawDispatch({ type, ...payload }), []);

  return useMemo(() => ({
    state: machine.state,
    ctx: machine.context,
    dispatch,
    is: (...names) => names.includes(machine.state),
    /** What the heartbeat should call this: the server only knows three modes. */
    watchMode: machine.state === 'sos_live' ? 'sos'
             : machine.context.highAlert ? 'high_alert'
             : 'idle',
  }), [machine, dispatch]);
}

/**
 * The band's wire events (execution plan §5), mapped to machine events.
 * Returned as `null` when the band event is not a transition at all -- a low
 * battery reading is telemetry until a threshold turns it into an alert.
 */
export function bandEventToAction(ev) {
  switch (ev.e) {
    case 'sos':
    case 'snatch':       return { type: 'SOS_RAISED' };
    case 'fall':         return { type: 'FALL_DETECTED', severity: 4, note: ev.peak ? `peak ${ev.peak}g` : '' };
    case 'checkin_ack':  return { type: 'CHECKIN_CLOSED' };
    case 'high_alert_on':  return { type: 'HIGH_ALERT_SET', on: true };
    case 'high_alert_off': return { type: 'HIGH_ALERT_SET', on: false };
    default:             return null;
  }
}
