import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, AppState, Linking, Modal, Pressable, StyleSheet, Text,
  Vibration, View,
} from 'react-native';
import {
  ALERT_TIMEOUT, call, clearSession, loadSession, optinSamaritan, saveSession, useLive,
} from './src/api';

import { clearQueue, dequeue, enqueue, flushQueue, pendingCount, pressId } from './src/alertQueue';
import { MODES, useBandLink } from './src/bandLink';
import CheckinBanner from './src/components/CheckinBanner';
import FallCountdown, { FALL_WINDOW_S } from './src/components/FallCountdown';
import SamaritanCall from './src/components/SamaritanCall';
import { useAppFonts } from './src/fonts';
import Alerts from './src/screens/Alerts';
import Auth from './src/screens/Auth';
import Band from './src/screens/Band';
import Family from './src/screens/Family';
import Home from './src/screens/Home';
import Setup from './src/screens/Setup';
import UserShell from './src/screens/UserShell';
import DisarmPad from './src/screens/user/DisarmPad';
import { U } from './src/screens/user/kit';
import { SafeAreaRoot, useEdgeInsets } from './src/safeArea';
import { bandEventToAction, useSafetyMachine } from './src/state';
import { C, S, T, sevColor } from './src/theme';
import { Button, Chip, Icon, IconButton, Txt } from './src/ui';
import { lastKnownFix, useHeartbeat, usePhoneBattery, usePresence } from './src/watch';
import {
  INCIDENT_WINDOW_S, classifyImpact, describeImpact, noteImpact, speedContext,
  travellingSteadily, useSpeedWatch,
} from './src/motion';
import { stopBackgroundWatch, syncBackgroundWatch } from './src/bgService';
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

function Main() {
  const [booting, setBooting] = useState(true);
  const [session, setSession] = useState(null);
  const [tab, setTab] = useState('home');
  const [refreshKey, setRefreshKey] = useState(0);

  const [incoming, setIncoming] = useState(null);     // family emergency takeover
  const [acking, setAcking] = useState(false);        // "I'm on it", mid-flight
  const [askSheet, setAskSheet] = useState(null);     // the check-in question
  const [samaritan, setSamaritan] = useState(null);   // a stranger nearby
  const [deliveredTo, setDeliveredTo] = useState(null);
  const [deliveryStatus, setDeliveryStatus] = useState(null); // null | 'queued' | 'sending' | 'delivered'
  const [toast, setToast] = useState(null);
  const [fix, setFix] = useState(null);               // last position, from Home
  const [pendingAlertId, setPendingAlertId] = useState(null); // { id, answered } from a notification

  const { state, ctx, dispatch, is, watchMode } = useSafetyMachine();
  const insets = useEdgeInsets();
  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);

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
      await call(session, `/alert/${id}/resolve`, { method: 'POST' });
      dispatch('SOS_CLEARED');
      setDeliveredTo(null);
      setDeliveryStatus(null);
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

  const band = useBandLink(onBandEvent);
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
      if (a.severity >= 4) {
        setIncoming(a);
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
        notify(`${a.user.name} — ${a.kind.replace('_', ' ')}`,
               a.maps ? 'Tap to open the app and see their location.' : 'Open the app for details.');
      }
      bump();
    },
    resolved: (m) => {
      setIncoming((cur) => (cur && cur.id === m.alert_id ? null : cur));
      setSamaritan((cur) => (cur && cur.id === m.alert_id ? null : cur));
      setToast(`${m.user.name} is safe — they stood the alert down`);
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
      setToast(m.samaritan
        ? `${m.by.name} is nearby and on the way`
        : `${m.by.name} has seen your alert and is responding`);
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
    buzz_now: (m) => {
      const checkin = {
        name: null, system: true, reason: m.reason, checkin_id: m.checkin_id,
        window: m.window || 90, due_at: m.due_at, _startAt: Date.now() / 1000,
      };
      dispatch('CHECKIN_ASKED', { checkin });
      if (m.next_buzz_at) dispatch('NEXT_BUZZ', { at: m.next_buzz_at });
      setAskSheet(checkin);
      Vibration.vibrate([0, 400, 200, 400]);
      band.send({ c: 'checkin_req', window: m.window ?? 90 });
      notify('Nigehban is checking on you', 'Tap "I am fine" to answer.');
    },
    checkin_ack: (m) => setToast(`${m.by.name} answered — they are fine`),
    watch_updated: () => bump(),
    samaritan: (m) => {
      setSamaritan(m.alert);
      Vibration.vibrate([0, 300, 150, 300]);
      notify('Someone near you needs help',
             'A Nigehban emergency was raised close by. Open the app if you can go.');
    },
    samaritan_on_way: (m) => setToast(`${m.by.name} is nearby and heading there`),
    invite: (m) => {
      setToast(`${m.invite.from.name} is asking to be your family — open FAMILY to answer`);
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
        setDeliveredTo(count ?? null);
        setDeliveryStatus('delivered');
        setToast(count
          ? `Your alert has been delivered to ${count} family member${count === 1 ? '' : 's'}`
          : 'Your alert has been sent to the server');
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
  }, [session, dispatch, bump]);

  const prevOnline = useRef(false);
  useEffect(() => {
    if (serverOnline && !prevOnline.current) flushNow();
    prevOnline.current = serverOnline;
  }, [serverOnline, flushNow]);

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
      if (!live) return;

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

    await stopBackgroundWatch();
    await clearSession();
    await clearQueue();
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
      setToast('Could not reach the server — your family may still be told. '
               + 'Try again, or call them.');
    }
  }, [dispatch, raise, session, reportOutcome]);
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
      setToast('No answer — your family is being told. '
               + 'Answering now still tells them you are fine.');
      return;
    }
    raise({ kind: f?.reason === 'accident' ? 'accident' : 'fall',
            source: 'band', note: f?.note || '' });
  }, [dispatch, raise]);

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
        {tab === 'family' && <Family session={session} refreshKey={refreshKey} />}
        {tab === 'alerts' && <Alerts session={session} refreshKey={refreshKey} />}
        {tab === 'setup' && <Setup session={session} />}
      </View>

      <View style={[st.tabbar, { paddingBottom: 8 + insets.bottom }]}>
        {TABS.map(([k, label, icon]) => {
          const on = tab === k;
          return (
            <Pressable key={k} onPress={() => setTab(k)} style={st.tabBtn}
                       accessibilityRole="tab" accessibilityState={{ selected: on }}
                       accessibilityLabel={label}>
              <Icon name={icon} size={19} color={on ? C.green : C.faint} />
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

      {/* ---- somebody in the family is in trouble ---- */}
      <Modal visible={!!incoming} animationType="fade" onRequestClose={() => setIncoming(null)}>
        {incoming ? (
          <View style={st.takeover}>
            <View style={[st.takeBadge, { backgroundColor: sevColor(incoming.severity) }]}>
              <Icon name="alert-octagon" size={16} color={C.bg} />
              <Text style={st.takeBadgeText}>
                {TAKEOVER_TITLE[incoming.kind] || incoming.kind.replace('_', ' ').toUpperCase()}
              </Text>
            </View>

            <Txt variant="display" style={st.takeName}>{incoming.user.name}</Txt>
            <Text style={st.takeMeta}>
              {incoming.source === 'band' ? 'Raised from the wristband'
                : incoming.source === 'server' ? 'Raised by the server watchdog'
                : 'Raised from their phone'}
            </Text>

            <View style={st.takeBtns}>
              {/* Opening the map does not close the takeover, so this is the one
                  exit that has to stop the siren itself -- they have plainly
                  seen it, and it must not follow them into Maps. */}
              {incoming.maps ? (
                <Button title="SEE WHERE THEY ARE" filled big tone={C.red} icon="navigation"
                        onPress={() => { stopAlarm(); Linking.openURL(incoming.maps); }} />
              ) : null}
              {/* The one button on this screen that speaks to the server, and
                  it is pressed by somebody who has just been woken by a siren.
                  Without a spinner it sits there looking untouched for the
                  whole round trip and gets pressed again -- on the takeover
                  that is the worst place in the app to look dead. The whole
                  dialog goes quiet while it runs: dismissing it mid-flight
                  would leave the family with no screen that ever said whether
                  they had answered. */}
              <Button title={acking ? 'TELLING THEM…' : "I'M ON IT"}
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
              {askSheet?.system
                ? 'Nigehban is checking on you'
                : `${askSheet?.name} is checking on you`}
            </Txt>
            <Text style={st.sheetBody}>
              {askSheet?.system
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
  takeMeta: { ...T.body, color: C.dim, marginBottom: S.xl },
  takeBtns: { alignSelf: 'stretch', gap: S.md },

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
}
