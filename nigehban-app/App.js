import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, AppState, Linking, Modal, Pressable, StyleSheet, Text,
  Vibration, View,
} from 'react-native';
import { call, clearSession, loadSession, saveSession, useLive } from './src/api';
import { enqueue, flushQueue, clearQueue } from './src/alertQueue';
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
import { consumeLaunchAlertId, presentAlarm, stopAlarm } from './src/alarm';
import {
  DEFAULT_CHANNEL_ID, registerPushToken, sendEmergencyAlarmNotification,
  setupNotificationChannels, subscribeNotificationTaps,
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
  checkin_missed: 'MISSED CHECK-IN', watch_lost: 'WATCH STOPPED REPORTING',
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
  const [pendingAlertId, setPendingAlertId] = useState(null); // tapped from a notification

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
      if (launched != null) setPendingAlertId(launched);
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
  useEffect(() => subscribeNotificationTaps(setPendingAlertId), []);

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
    (async () => {
      try {
        const list = await call(session, '/alerts?scope=incoming');
        const alert = list.find((a) => String(a.id) === String(pendingAlertId));
        if (alert && !alert.resolved_at) {
          setIncoming(alert);
          setTab('home');
        }
      } catch { /* the in-app takeover still works once the socket catches up */ }
      setPendingAlertId(null);
    })();
  }, [pendingAlertId, session]);

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
  const raise = useCallback(async (payload) => {
    if (!session) return null;

    // Capture the GPS fix at the moment the button is pressed — Point A.
    // This is where the emergency happened, not wherever the phone drifts
    // to while waiting for signal.
    const at = fix || await lastKnownFix();
    const body = { lat: at?.lat, lon: at?.lon, accuracy: at?.acc, ...payload };
    const isEmergency = ['sos', 'snatch', 'fall'].includes(payload.kind);

    // LOCAL-FIRST: fire the state machine and vibrate immediately, before
    // the network call. The user must know their button press registered,
    // and the SOS screen must appear even with no connectivity at all.
    if (isEmergency) {
      const localAlert = {
        id: `pending-${Date.now()}`,
        kind: payload.kind,
        source: payload.source || 'app',
        created_at: Date.now() / 1000,
        lat: at?.lat, lon: at?.lon,
        _local: true,  // marker: not yet confirmed by the server
      };
      dispatch('SOS_RAISED', { alert: localAlert });
      setDeliveredTo(null);
      setDeliveryStatus('queued');
      Vibration.vibrate([0, 300, 120, 300]);
    }

    // Now try the network call.
    try {
      const r = await call(session, '/alert', { method: 'POST', body });
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
        await enqueue(body);
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
        await clearQueue();
        dispatch('SOS_CLEARED');
        setDeliveredTo(null);
        setDeliveryStatus(null);
        setToast('Cancelled — alert was not sent yet');
        bump();
        return;
      }
      await call(session, `/alert/${id}/resolve`, { method: 'POST' });
      dispatch('SOS_CLEARED');
      setDeliveredTo(null);
      setDeliveryStatus(null);
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
          if (!took) sendEmergencyAlarmNotification(a);
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
      dispatch('RESPONDER', { by: m.by });
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

  // ---- offline queue: flush on reconnect ----------------------------------
  // When the WebSocket comes back online after being down, try to deliver any
  // alerts that were queued while offline. The serverOnline flag is driven by
  // useLive's onopen/onclose, so this fires on the natural reconnect.
  const prevOnline = useRef(false);
  useEffect(() => {
    if (serverOnline && !prevOnline.current && session) {
      // Just reconnected. Flush the queue.
      (async () => {
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
        }
      })();
    }
    prevOnline.current = serverOnline;
  }, [serverOnline, session, dispatch, bump]);

  const signOut = async () => {
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
}
