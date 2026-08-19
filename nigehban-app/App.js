import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Linking, Modal, Platform, Pressable,
  StyleSheet, Text, Vibration, View,
} from 'react-native';
import { call, clearSession, loadSession, useLive } from './src/api';
import { useBand } from './src/band';
import Alerts from './src/screens/Alerts';
import Auth from './src/screens/Auth';
import Family from './src/screens/Family';
import Home from './src/screens/Home';
import { SafeAreaRoot, useEdgeInsets } from './src/safeArea';
import { C, MONO, sevColor } from './src/theme';
import { Button, Pill } from './src/ui';

const mono = Platform.select(MONO);

const TABS = [
  ['home', 'HOME'],
  ['family', 'FAMILY'],
  ['alerts', 'ALERTS'],
];

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

  const [incoming, setIncoming] = useState(null);   // full-screen takeover
  const [checkinFrom, setCheckinFrom] = useState(null);
  const [activeSos, setActiveSos] = useState(null); // my own live SOS
  const [toast, setToast] = useState(null);

  const insets = useEdgeInsets();
  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    (async () => { setSession(await loadSession()); setBooting(false); })();
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // ---- raising and standing down -----------------------------------------
  const raise = useCallback(async (payload) => {
    if (!session) return;
    try {
      const r = await call(session, '/alert', { method: 'POST', body: payload });
      if (payload.kind === 'sos') {
        setActiveSos(r.alert);
        Vibration.vibrate([0, 300, 120, 300]);
      }
      setToast(r.delivered_to
        ? `sent to ${r.delivered_to} family member${r.delivered_to === 1 ? '' : 's'}`
        : 'nobody in your family list yet — add someone first');
      bump();
      return r.alert;
    } catch (e) {
      setToast(e.message);
    }
  }, [session, bump]);

  const resolve = useCallback(async (id) => {
    try {
      await call(session, `/alert/${id}/resolve`, { method: 'POST' });
      setActiveSos(null);
      setToast('stood down — your family has been told');
      bump();
    } catch (e) {
      setToast(e.message);
    }
  }, [session, bump]);

  // ---- the band drives the same two actions ------------------------------
  const activeRef = useRef(activeSos);
  activeRef.current = activeSos;

  const onBandEvent = useCallback((ev) => {
    if (ev.e === 'sos') {
      if (!activeRef.current) raise({ kind: 'sos', source: 'band', note: ev.src || '' });
    } else if (ev.e === 'checkin_ack') {
      // Key 1 is "I'm fine": it stands down a live SOS, otherwise it is a
      // plain check-in. That gives start AND stop from the band with no
      // firmware change at all.
      if (activeRef.current) resolve(activeRef.current.id);
      else raise({ kind: 'checkin_ack', source: 'band' });
    } else if (ev.e === 'fall') {
      raise({ kind: 'fall', source: 'band' });
    }
  }, [raise, resolve]);

  const band = useBand(onBandEvent);

  // ---- live socket --------------------------------------------------------
  const serverOnline = useLive(session, {
    alert: (m) => {
      const a = m.alert;
      if (a.severity >= 4) {
        setIncoming(a);
        Vibration.vibrate([0, 500, 200, 500, 200, 500], true);
      }
      notify(`${a.user.name} — ${a.kind.toUpperCase()}`,
             a.maps ? 'Tap to open the app and see their location.' : 'Open the app for details.');
      bump();
    },
    resolved: (m) => {
      setIncoming((cur) => (cur && cur.id === m.alert_id ? (Vibration.cancel(), null) : cur));
      setToast(`${m.user.name} is safe — they stood the alert down`);
      bump();
    },
    ack: (m) => setToast(`${m.by.name} has seen your alert and is responding`),
    checkin_req: (m) => {
      setCheckinFrom(m.from);
      Vibration.vibrate([0, 200, 100, 200]);
      band.send({ c: 'checkin_req', window: 45 });   // buzz the band too
      notify(`${m.from.name} is checking on you`, 'Tap "I am fine" to answer.');
    },
    family_added: (m) => { setToast(`${m.user.name} added you to their family`); bump(); },
  });

  const signOut = async () => {
    await clearSession();
    setSession(null);
    setActiveSos(null);
    setIncoming(null);
  };

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
        <View style={{ alignItems: 'flex-end', gap: 6 }}>
          <Pill text={serverOnline ? 'connected' : 'offline'}
                tone={serverOnline ? C.green : C.alarm}
                bg={serverOnline ? C.greenBg : C.alarmBg} />
          <Pressable onPress={signOut}><Text style={st.signout}>sign out</Text></Pressable>
        </View>
      </View>

      <View style={st.flex}>
        {tab === 'home' && (
          <Home session={session} band={band} activeSos={activeSos}
                onRaise={raise} onResolve={resolve} serverOnline={serverOnline} />
        )}
        {tab === 'family' && <Family session={session} refreshKey={refreshKey} />}
        {tab === 'alerts' && <Alerts session={session} refreshKey={refreshKey} />}
      </View>

      {toast ? (
        <Pressable onPress={() => setToast(null)}
                   style={[st.toast, { bottom: 86 + insets.bottom }]}>
          <Text style={st.toastText}>{toast}</Text>
        </Pressable>
      ) : null}

      <View style={[st.tabbar, { paddingBottom: 10 + insets.bottom }]}>
        {TABS.map(([k, label]) => (
          <Pressable key={k} onPress={() => setTab(k)} style={st.tabBtn}>
            <Text style={[st.tabText, tab === k && { color: C.green }]}>{label}</Text>
            <View style={[st.tabMark, tab === k && { backgroundColor: C.green }]} />
          </Pressable>
        ))}
      </View>

      {/* ---- somebody in the family is in trouble ---- */}
      <Modal visible={!!incoming} animationType="fade" transparent={false}>
        {incoming ? (
          <View style={[st.takeover, { backgroundColor: C.alarmBg }]}>
            <Text style={[st.takeKind, { color: sevColor(incoming.severity) }]}>
              {incoming.kind === 'fall' ? 'FALL DETECTED' : 'SOS'}
            </Text>
            <Text style={st.takeName}>{incoming.user.name}</Text>
            <Text style={st.takeMeta}>
              {incoming.source === 'band' ? 'raised from the wristband' : 'raised from the phone'}
            </Text>
            <View style={st.takeBtns}>
              {incoming.maps ? (
                <Button title="SEE WHERE THEY ARE" filled tone={C.alarm} big
                        onPress={() => { Vibration.cancel(); Linking.openURL(incoming.maps); }} />
              ) : null}
              <Button title="I'M ON IT" tone={C.green} filled
                      onPress={async () => {
                        Vibration.cancel();
                        try { await call(session, `/alert/${incoming.id}/ack`, { method: 'POST' }); } catch {}
                        setIncoming(null); bump();
                      }} />
              <Button title="dismiss" tone={C.dim}
                      onPress={() => { Vibration.cancel(); setIncoming(null); }} />
            </View>
          </View>
        ) : null}
      </Modal>

      {/* ---- a parent is checking on you ---- */}
      <Modal visible={!!checkinFrom} animationType="slide" transparent>
        <View style={st.sheetWrap}>
          <View style={st.sheet}>
            <Text style={st.sheetTitle}>
              {checkinFrom?.name} is checking on you
            </Text>
            <Text style={st.sheetBody}>
              Answer and they will see straight away that you are fine.
            </Text>
            <Button title="I AM FINE" filled big tone={C.green}
                    onPress={async () => {
                      Vibration.cancel();
                      setCheckinFrom(null);
                      await raise({ kind: 'checkin_ack', source: 'app' });
                    }} />
            <Button title="not now" tone={C.dim}
                    onPress={() => { Vibration.cancel(); setCheckinFrom(null); }} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const st = StyleSheet.create({
  flex: { flex: 1, backgroundColor: C.bg },
  center: { alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
    paddingHorizontal: 16, paddingTop: 14, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: C.line,
  },
  brand: { fontFamily: mono, color: C.text, fontSize: 15, letterSpacing: 4 },
  who: { fontFamily: mono, color: C.faint, fontSize: 10, marginTop: 3 },
  signout: { fontFamily: mono, color: C.faint, fontSize: 10, textDecorationLine: 'underline' },
  tabbar: {
    flexDirection: 'row', borderTopWidth: 1, borderTopColor: C.line,
    backgroundColor: C.surface,
  },
  tabBtn: { flex: 1, alignItems: 'center', paddingTop: 12, paddingBottom: 10, gap: 6 },
  tabText: { fontFamily: mono, fontSize: 11, letterSpacing: 1.6, color: C.faint },
  tabMark: { height: 2, width: 22, backgroundColor: 'transparent', borderRadius: 2 },
  toast: {
    position: 'absolute', left: 14, right: 14, bottom: 74,
    backgroundColor: C.raised, borderWidth: 1, borderColor: C.line,
    borderRadius: 4, padding: 12,
  },
  toastText: { fontFamily: mono, color: C.text, fontSize: 12, lineHeight: 18 },
  takeover: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 26, gap: 10 },
  takeKind: { fontFamily: mono, fontSize: 46, letterSpacing: 6, fontWeight: '800' },
  takeName: { fontFamily: mono, color: C.text, fontSize: 26, marginTop: 4 },
  takeMeta: { fontFamily: mono, color: C.dim, fontSize: 12, marginBottom: 22 },
  takeBtns: { alignSelf: 'stretch', gap: 12 },
  sheetWrap: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#000A' },
  sheet: {
    backgroundColor: C.surface, borderTopWidth: 2, borderTopColor: C.green,
    padding: 22, paddingBottom: 34, gap: 14,
  },
  sheetTitle: { fontFamily: mono, color: C.text, fontSize: 19, lineHeight: 26 },
  sheetBody: { fontFamily: mono, color: C.dim, fontSize: 12, lineHeight: 19 },
});

export default function App() {
  return (
    <SafeAreaRoot>
      <Main />
    </SafeAreaRoot>
  );
}
