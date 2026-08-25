import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Linking, Modal, Pressable, StyleSheet, Text, Vibration, View,
} from 'react-native';
import { call, clearSession, loadSession, useLive } from './src/api';
import { useBandLink } from './src/bandLink';
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
import { SafeAreaRoot, useEdgeInsets } from './src/safeArea';
import { bandEventToAction, useSafetyMachine } from './src/state';
import { C, S, T, sevColor } from './src/theme';
import { Button, Chip, Icon, IconButton, Txt } from './src/ui';
import { useHeartbeat, usePresence } from './src/watch';
import { startBackgroundWatch, stopBackgroundWatch } from './src/bgService';
import {
  registerPushToken, sendEmergencyAlarmNotification, setupNotificationChannels,
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
      content: { title, body, sound: true }, trigger: null,
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
  const [toast, setToast] = useState(null);
  const [fix, setFix] = useState(null);               // last position, from Home

  const { state, ctx, dispatch, is, watchMode } = useSafetyMachine();
  const insets = useEdgeInsets();
  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    (async () => {
      await setupNotificationChannels();
      const s = await loadSession();
      setSession(s);
      if (s) startBackgroundWatch();
      setBooting(false);
    })();
  }, []);

  // Keyed on the session rather than done once at boot. Registering only on
  // mount meant somebody who had just signed in had no push token on the
  // server until they next launched the app -- so the first alert after
  // pairing, the one most likely to be a real test, reached nothing. It also
  // re-runs on a token change, which is when a rotated push token gets filed.
  useEffect(() => {
    if (session?.token) registerPushToken(session);
  }, [session?.token, session?.url]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  // ---- raising and standing down -----------------------------------------
  const raise = useCallback(async (payload) => {
    if (!session) return null;
    try {
      const body = { lat: fix?.lat, lon: fix?.lon, accuracy: fix?.acc, ...payload };
      const r = await call(session, '/alert', { method: 'POST', body });
      if (['sos', 'snatch', 'fall'].includes(payload.kind)) {
        dispatch('SOS_RAISED', { alert: r.alert });
        setDeliveredTo(r.delivered_to);
        Vibration.vibrate([0, 300, 120, 300]);
      }
      if (payload.kind !== 'near_miss') {
        setToast(r.delivered_to
          ? `Sent to ${r.delivered_to} family member${r.delivered_to === 1 ? '' : 's'}`
          : 'Nobody is in your family list yet — add someone first');
      }
      bump();
      return r.alert;
    } catch (e) {
      setToast(e.message);
      return null;
    }
  }, [session, fix, dispatch, bump]);

  const resolve = useCallback(async (id) => {
    try {
      await call(session, `/alert/${id}/resolve`, { method: 'POST' });
      dispatch('SOS_CLEARED');
      setDeliveredTo(null);
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

    if (action.type === 'HIGH_ALERT_SET') {
      // The band's hold-3s is only the switch; the mode itself is server-owned
      // so that it outlives this app being killed.
      toggleHighAlert(action.on);
    }
  }, [dispatch, raise, resolve, ackCheckin, toggleHighAlert]);

  const band = useBandLink(onBandEvent);

  // ---- U3.4 battery: one alert per threshold crossing --------------------
  const battLatch = useRef({ low: false, dark: false });
  useEffect(() => {
    const level = band.battery;
    if (level == null) return;
    const low = level <= BATT_LOW;
    const dark = level <= BATT_DARK;

    if (dark && !battLatch.current.dark) {
      battLatch.current = { low: true, dark: true };
      raise({ kind: 'going_dark', source: 'app', note: `${Math.round(level)}%` });
      setToast('Battery critical — your family has been told where you were');
    } else if (low && !battLatch.current.low) {
      battLatch.current.low = true;
      raise({ kind: 'low_battery', source: 'app', note: `${Math.round(level)}%` });
    } else if (!low) {
      battLatch.current = { low: false, dark: false };   // charged: arm it again
    }
    dispatch('BATTERY', { level, low, goingDark: dark });
  }, [band.battery, raise, dispatch]);

  // The server's watchdog listens for silence, so the phone speaks while
  // anything is armed. N2's foreground service is what keeps this going once
  // Android backgrounds the app.
  useHeartbeat(session, {
    mode: watchMode,
    bandLink: band.status === 'connected' || band.status === 'virtual',
    batt: band.battery,
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
        Vibration.vibrate([0, 500, 200, 500, 200, 500], true);
        sendEmergencyAlarmNotification(a);
      } else {
        notify(`${a.user.name} — ${a.kind.replace('_', ' ')}`,
               a.maps ? 'Tap to open the app and see their location.' : 'Open the app for details.');
      }
      bump();
    },
    resolved: (m) => {
      setIncoming((cur) => (cur && cur.id === m.alert_id ? (Vibration.cancel(), null) : cur));
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

  const signOut = async () => {
    await stopBackgroundWatch();
    await clearSession();
    dispatch('RESET');
    setSession(null);
    setIncoming(null);
  };

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

  return (
    <View style={[st.flex, { paddingTop: insets.top }]}>
      <StatusBar style="light" />

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
                deliveredTo={deliveredTo} onRaise={raise} onResolve={resolve}
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

      {toast ? (
        <Pressable onPress={() => setToast(null)} accessibilityRole="alert"
                   style={[st.toast, { bottom: 88 + insets.bottom }]}>
          <Icon name="info" size={15} color={C.dim} />
          <Text style={st.toastText}>{toast}</Text>
        </Pressable>
      ) : null}

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

      {/* ---- a fall, and the seconds to say it was nothing ---- */}
      <FallCountdown
        fall={is('fall_pending') ? ctx.fall : null}
        onCancel={() => {
          dispatch('FALL_CANCELLED');
          raise({ kind: 'near_miss', source: 'band', note: ctx.fall?.note || '' });
          setToast('Cancelled — noted for you only, nobody was told');
        }}
        onEscalate={() => raise({ kind: 'fall', source: 'band', note: ctx.fall?.note || '' })}
      />

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
              {incoming.maps ? (
                <Button title="SEE WHERE THEY ARE" filled big tone={C.red} icon="navigation"
                        onPress={() => { Vibration.cancel(); Linking.openURL(incoming.maps); }} />
              ) : null}
              <Button title="I'M ON IT" tone={C.green} filled icon="user-check"
                      onPress={async () => {
                        Vibration.cancel();
                        try { await call(session, `/alert/${incoming.id}/ack`, { method: 'POST' }); } catch { /* they are still told by the socket */ }
                        setIncoming(null); bump();
                      }} />
              <Button title="Dismiss" tone={C.dim}
                      onPress={() => { Vibration.cancel(); setIncoming(null); }} />
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
