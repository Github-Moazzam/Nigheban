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
    // Stay put, but take the new detail. This is how the server's real deadline
    // replaces the provisional one the phone drew a countdown from a moment
    // earlier: `/checkin/self` answers with the `due_at` the SWEEPER will
    // actually act on, and a countdown showing a different number is lying to
    // the person deciding whether they still have time to press.
    //
    // It is not a way in for a second incident -- openIncidentCheckin refuses
    // to start one while a question is already open, so nothing else reaches
    // this row and a second impact cannot reset the clock on the first.
    FALL_DETECTED:  null,
    // The window ran out. Distinct from FALL_CANCELLED and doing exactly the
    // same thing to the context, because the two are opposite events and a log
    // that spells them the same way is a log that cannot answer the only
    // question worth asking afterwards: did she press it, or did nobody?
    FALL_ESCALATED: 'rest',
    // The wearer answering. A fall check-in is answered by the same single tap
    // as any other, and dropping it here is what would make the band's own
    // "I'm fine" key do nothing during the one event it matters most for.
    CHECKIN_CLOSED: 'rest',
    CHECKIN_ASKED:  null,                // answer the fall first
    HIGH_ALERT_SET: null,
  },
  sos_live: {
    SOS_RAISED:     'sos_live',          // update activeSos with real server alert
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

/**
 * Fold the server's list of who has answered into the one we already hold.
 *
 * The socket's `ack` frame and the alert row's `acks` describe the same event
 * and arrive by different routes, so this is a union keyed on id rather than a
 * replacement: whichever got here first, nobody is listed twice and nobody is
 * dropped. The server's timestamp wins where there is one, because the socket
 * path stamps `Date.now()` on arrival and a restore hours later would otherwise
 * render "5 seconds ago" for an answer given at the start of the emergency.
 */
function mergeResponders(existing, acks) {
  const out = [...(existing || [])];
  for (const a of acks || []) {
    if (!a || a.id == null) continue;
    const i = out.findIndex((r) => r.id === a.id);
    if (i === -1) out.push({ id: a.id, name: a.name, at: a.at });
    else out[i] = { ...out[i], name: a.name ?? out[i].name, at: a.at ?? out[i].at };
  }
  return out.sort((x, y) => (x.at || 0) - (y.at || 0));
}

/** What each transition does to the context. Kept next to the table on purpose. */
const APPLY = {
  // Responders are seeded from the alert itself, not blanked.
  //
  // This is the whole of BUG-008 on the app side. `restoreLiveSos` dispatches
  // this with a row fetched from the server, and that row now carries everyone
  // who answered while the app was closed -- so the list comes back with the
  // emergency instead of the screen claiming nobody has replied.
  //
  // A locally-raised alert has no `acks` key and seeds to empty, which is
  // correct: the server has not even seen the press yet.
  SOS_RAISED:     (c, a) => {
    const alert = a.alert || c.activeSos;
    // Same emergency, better information -- the local placeholder being
    // replaced by the confirmed server row, or a restore of one already on
    // screen. A genuinely different alert starts from nobody.
    const same = alert && c.activeSos
      && (String(alert.id) === String(c.activeSos.id) || c.activeSos._local);
    return { ...c, activeSos: alert, fall: null,
             responders: mergeResponders(same ? c.responders : [], alert?.acks) };
  },
  SOS_CLEARED:    (c)    => ({ ...c, activeSos: null, responders: [] }),
  // `checkinId` is the difference between a question the server is holding and
  // one only this process is. Null means the phone was offline when the
  // detector fired, and the countdown running out has to raise the alert here
  // rather than leaving it to a sweeper that was never told. Everything that
  // acts on the end of the window checks it.
  FALL_DETECTED:  (c, a) => ({ ...c, fall: {
    severity:  a.severity ?? 4,
    reason:    a.reason || 'fall',
    endsAt:    a.endsAt,
    window:    a.window ?? null,
    checkinId: a.checkinId ?? c.fall?.checkinId ?? null,
    note:      a.note || '',
  } }),
  FALL_CANCELLED: (c)    => ({ ...c, fall: null }),
  FALL_ESCALATED: (c)    => ({ ...c, fall: null }),
  CHECKIN_ASKED:  (c, a) => ({ ...c, checkin: a.checkin }),
  // Also clears `fall`: in fall_pending this transition IS the fall being
  // answered, and leaving the countdown in context would keep the modal on
  // screen over a question that is closed.
  CHECKIN_CLOSED: (c)    => ({ ...c, checkin: null, fall: null }),
  HIGH_ALERT_SET: (c, a) => ({ ...c, highAlert: !!a.on, nextBuzzAt: a.on ? (a.nextBuzzAt ?? c.nextBuzzAt) : null }),
};

/** Events that describe the world rather than move through it. */
const CONTEXT_ONLY = {
  // The band's local nag ran out. It records that fact and nothing else --
  // see `checkin_missed` in bandEventToAction for why it must not escalate,
  // and must not close the question either.
  CHECKIN_EXPIRED: (c) => (c.checkin ? { ...c, checkin: { ...c.checkin, expired: true } } : c),
  NEXT_BUZZ:  (c, a) => ({ ...c, nextBuzzAt: a.at ?? null }),
  BATTERY:    (c, a) => ({ ...c, battery: { level: a.level, low: a.low, goingDark: a.goingDark } }),
  // `at` is the server's ack time. Both routes carry it now -- the socket frame
  // and the restored row -- and arrival time is only the fallback for a phone
  // talking to a server older than this. Stamping `Date.now()` unconditionally
  // is what made a responder from ten minutes ago redraw as "just now".
  RESPONDER:  (c, a) => (c.responders.some((r) => r.id === a.by.id)
                          ? c
                          : { ...c,
                              responders: [...c.responders,
                                           { ...a.by, at: a.at ?? a.by.at ?? Date.now() / 1000 }] }),
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
    // App.js does not use this note any more -- it builds a richer one from the
    // speed context, which this file has no business knowing about -- but the
    // action type is still what routes a fall, and the field name has to match
    // what both bands actually send. See `peak_g` in the .ino and virtualBand.
    case 'fall':         return { type: 'FALL_DETECTED', severity: 4, note: ev.peak_g ? `peak ${ev.peak_g}g` : '' };
    case 'checkin_ack':  return { type: 'CHECKIN_CLOSED' };

    // The band's local nag timer expired. Two things this deliberately is not:
    //
    // It is not an escalation. The band only ever nags because the phone sent
    // it a `checkin_req`, and the phone only sends that because the server
    // opened a `checkins` row with a `due_at` -- so the sweeper is already
    // going to raise `checkin_missed` on that row. Raising a second one from
    // here would page the family twice for one silence, with the band's clock
    // and the server's clock disagreeing about when. Deadlines belong to the
    // server; this file's opening comment is the reason why.
    //
    // It is also not `CHECKIN_CLOSED`. The band's window can lapse a moment
    // before the server's, and answering late still matters: it tells the
    // family she is fine even after they have been told she went quiet. So the
    // question stays open and answerable, and this only marks that time is up.
    case 'checkin_missed': return { type: 'CHECKIN_EXPIRED' };

    case 'high_alert_on':  return { type: 'HIGH_ALERT_SET', on: true };
    case 'high_alert_off': return { type: 'HIGH_ALERT_SET', on: false };
    default:             return null;
  }
}
