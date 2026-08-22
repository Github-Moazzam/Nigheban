import * as Location from 'expo-location';
import React, { useCallback, useEffect, useState } from 'react';
import {
  Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import CheckinBanner from '../components/CheckinBanner';
import HighAlertPanel from '../components/HighAlertPanel';
import { C, MONO, fmtAgo } from '../theme';
import { Button, Card, Label, Pill, Stat } from '../ui';

const mono = Platform.select(MONO);

const BAND_LABEL = {
  idle: 'not connected', scanning: 'looking for the band…', connecting: 'connecting…',
  connected: 'connected', disconnected: 'lost the band', simulated: 'simulated',
  virtual: 'this phone is the band',
  'no-permission': 'bluetooth permission denied',
};

export default function Home({ session, band, activeSos, onRaise, onResolve,
                              serverOnline, onOpenBand, pendingCheckin,
                              onAckCheckin, highAlertArmed, nextBuzzAt, onToggleHighAlert }) {
  const [fix, setFix] = useState(null);
  const [locNote, setLocNote] = useState('asking for location…');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Location is requested once and then watched, so an SOS never waits on GPS.
  useEffect(() => {
    let sub;
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') { setLocNote('location permission denied'); return; }
        sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, timeInterval: 5000, distanceInterval: 5 },
          (p) => {
            setFix({ lat: p.coords.latitude, lon: p.coords.longitude,
                     acc: p.coords.accuracy, at: Date.now() });
            setLocNote(null);
          });
      } catch (e) {
        setLocNote('location unavailable');
      }
    })();
    return () => sub?.remove();
  }, []);

  const fire = useCallback(async (kind, source) => {
    setBusy(true);
    try {
      await onRaise({ kind, source, lat: fix?.lat, lon: fix?.lon, accuracy: fix?.acc });
    } finally {
      setBusy(false);
    }
  }, [fix, onRaise]);

  const bandTone =
    band.status === 'connected' ? C.green
    : band.status === 'virtual' ? C.amber
    : band.simulated ? C.amber
    : band.status.startsWith('error') || band.status === 'disconnected' ? C.alarm
    : C.dim;

  return (
    <ScrollView
      contentContainerStyle={s.wrap}
      refreshControl={<RefreshControl refreshing={refreshing} tintColor={C.green}
        onRefresh={async () => { setRefreshing(true); setTimeout(() => setRefreshing(false), 600); }} />}
    >
      {/* ---- active check-in countdown banner ---- */}
      {pendingCheckin ? (
        <CheckinBanner checkin={pendingCheckin} onAck={onAckCheckin} />
      ) : null}

      {/* ---- the one thing that matters ---- */}
      {activeSos ? (
        <Card tone={C.alarm} style={{ backgroundColor: C.alarmBg }}>
          <Label color={C.alarm}>SOS is live</Label>
          <Text style={s.sosLive}>Your family has been alerted</Text>
          <Text style={s.sosMeta}>
            raised {fmtAgo(activeSos.created_at)} · from {activeSos.source === 'band' ? 'the band' : 'this phone'}
          </Text>
          <Button title="I'M SAFE — STAND DOWN" tone={C.green} filled
                  disabled={busy} onPress={() => onResolve(activeSos.id)} />
        </Card>
      ) : (
        <Pressable
          onLongPress={() => fire('sos', 'app')}
          delayLongPress={600}
          style={({ pressed }) => [s.sosBtn, pressed && { backgroundColor: C.alarmBg }]}
        >
          <Text style={s.sosGlyph}>SOS</Text>
          <Text style={s.sosHint}>press and hold</Text>
        </Pressable>
      )}

      {/* ---- high alert mode panel ---- */}
      <HighAlertPanel
        isArmed={highAlertArmed}
        nextBuzzAt={nextBuzzAt}
        onToggle={onToggleHighAlert}
      />

      {/* ---- band ---- */}
      <Card>
        <View style={s.row}>
          <Label>Wristband</Label>
          <Pill text={serverOnline ? 'server ok' : 'server offline'}
                tone={serverOnline ? C.green : C.alarm} />
        </View>
        <View style={s.statRow}>
          <Stat label="link" value={BAND_LABEL[band.status] || band.status} tone={bandTone} />
          <Stat label="battery" value={band.battery != null ? `${band.battery}%` : '—'}
                tone={band.battery != null && band.battery <= 20 ? C.amber : C.text} />
          <Stat label="anti-snatch" value={band.armed ? 'ARMED' : 'off'}
                tone={band.armed ? C.green : C.dim} />
        </View>
        {band.lastSeen ? (
          <Text style={s.meta}>last heard from {fmtAgo(band.lastSeen / 1000)}</Text>
        ) : null}

        {band.status === 'virtual' ? (
          <>
            <Text style={s.simNote}>
              No wristband here, so this phone is running the band firmware itself —
              the same gestures, the same events on the wire. The band console is
              where you press the key.
            </Text>
            <Button title="OPEN BAND CONSOLE" filled onPress={onOpenBand} />
          </>
        ) : band.status === 'connected' ? (
          <View style={s.simRow}>
            <View style={s.simCell}>
              <Button title="BUZZ THE BAND" tone={C.dim}
                      onPress={() => band.send({ c: 'buzz', n: 2 })} />
            </View>
            <View style={s.simCell}>
              <Button title="DISCONNECT" tone={C.dim} onPress={band.disconnect} />
            </View>
          </View>
        ) : (
          <Button title="CONNECT TO BAND" filled onPress={band.connect} />
        )}
      </Card>

      {/* ---- location ---- */}
      <Card>
        <Label>Your location</Label>
        {fix ? (
          <>
            <Text style={s.coords}>
              {fix.lat.toFixed(5)}, {fix.lon.toFixed(5)}
            </Text>
            <Text style={s.meta}>
              accurate to about {Math.round(fix.acc)} m · updated {fmtAgo(fix.at / 1000)}
            </Text>
            <Text style={s.meta}>
              This is attached to every alert you raise, so your family gets a map
              pin rather than a guess.
            </Text>
          </>
        ) : (
          <Text style={s.meta}>{locNote}</Text>
        )}
      </Card>

      <Text style={s.you}>signed in as {session.name} · {session.user_id}</Text>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  wrap: { padding: 16, gap: 14, paddingBottom: 40 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  statRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  sosBtn: {
    borderWidth: 2, borderColor: C.alarm, borderRadius: 8, paddingVertical: 40,
    alignItems: 'center', gap: 6, backgroundColor: C.surface,
  },
  sosGlyph: { fontFamily: mono, color: C.alarm, fontSize: 44, letterSpacing: 10, fontWeight: '700' },
  sosHint: { fontFamily: mono, color: C.faint, fontSize: 11, letterSpacing: 1.5 },
  sosLive: { fontFamily: mono, color: C.text, fontSize: 18 },
  sosMeta: { fontFamily: mono, color: C.dim, fontSize: 11 },
  meta: { fontFamily: mono, color: C.faint, fontSize: 11, lineHeight: 17 },
  coords: { fontFamily: mono, color: C.text, fontSize: 16, fontVariant: ['tabular-nums'] },
  simNote: {
    fontFamily: mono, color: C.amber, fontSize: 10, lineHeight: 16,
    backgroundColor: C.amberBg, padding: 10, borderRadius: 4,
  },
  simRow: { flexDirection: 'row', gap: 10 },
  simCell: { flex: 1 },
  you: { fontFamily: mono, color: C.faint, fontSize: 10, textAlign: 'center', marginTop: 4 },
});
