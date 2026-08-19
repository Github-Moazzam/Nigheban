import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, FlatList, Linking, Platform, Pressable, RefreshControl,
  StyleSheet, Text, View,
} from 'react-native';
import { call } from '../api';
import { C, MONO, fmtAgo, sevColor } from '../theme';
import { Button, Card, Label, Pill } from '../ui';

const mono = Platform.select(MONO);

const TITLE = {
  sos: 'SOS', snatch: 'POSSIBLE SNATCH', fall: 'FALL DETECTED',
  checkin_missed: 'MISSED CHECK-IN', checkin_ack: 'checked in — all fine',
  checkin_req: 'check-in requested', low_battery: 'band battery low',
};

export default function Alerts({ session, refreshKey }) {
  const [scope, setScope] = useState('incoming');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    try {
      setRows(await call(session, `/alerts?scope=${scope}`));
      setErr(null);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [session, scope]);

  useEffect(() => { setLoading(true); load(); }, [load, refreshKey]);

  const ack = async (a) => {
    setBusy(a.id);
    try { await call(session, `/alert/${a.id}/ack`, { method: 'POST' }); await load(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(null); }
  };

  return (
    <FlatList
      contentContainerStyle={s.wrap}
      data={rows}
      keyExtractor={(a) => String(a.id)}
      refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={C.green} />}
      ListHeaderComponent={
        <View style={{ gap: 12 }}>
          <View style={s.tabs}>
            {[['incoming', 'FROM FAMILY'], ['mine', 'MINE']].map(([k, label]) => (
              <Pressable key={k} onPress={() => setScope(k)}
                style={[s.tab, scope === k && s.tabOn]}>
                <Text style={[s.tabText, scope === k && { color: C.text }]}>{label}</Text>
              </Pressable>
            ))}
          </View>
          {err ? <Text style={s.err}>{err}</Text> : null}
        </View>
      }
      ListEmptyComponent={
        loading ? <ActivityIndicator color={C.green} style={{ marginTop: 24 }} />
        : <Text style={s.empty}>
            {scope === 'incoming'
              ? 'Nothing from your family. That is the good outcome.'
              : 'You have not raised anything yet.'}
          </Text>
      }
      renderItem={({ item }) => {
        const tone = sevColor(item.severity);
        const live = item.severity >= 4 && !item.resolved_at;
        return (
          <Card tone={tone} style={[s.card, live && { backgroundColor: C.alarmBg }]}>
            <View style={s.row}>
              <Text style={[s.kind, { color: tone }]}>
                {TITLE[item.kind] || item.kind}
              </Text>
              <Pill text={`sev ${item.severity}`} tone={tone} />
            </View>

            <Text style={s.who}>
              {scope === 'incoming' ? item.user.name : 'you'}
              {item.source === 'band' ? ' · from the band' : ' · from the phone'}
            </Text>
            <Text style={s.meta}>{fmtAgo(item.created_at)}</Text>

            {item.resolved_at ? (
              <Pill text={`stood down ${fmtAgo(item.resolved_at)}`} tone={C.green} bg={C.greenBg} />
            ) : null}

            {item.maps ? (
              <Button title="OPEN LOCATION IN MAPS" tone={tone}
                      sub={item.accuracy ? `accurate to ~${Math.round(item.accuracy)} m` : null}
                      onPress={() => Linking.openURL(item.maps)} />
            ) : (
              <Text style={s.meta}>no location was attached</Text>
            )}

            {scope === 'incoming' && item.severity >= 3 && !item.resolved_at ? (
              busy === item.id
                ? <ActivityIndicator color={tone} />
                : <Button title="I'VE SEEN THIS — I'M ON IT" filled tone={tone}
                          onPress={() => ack(item)} />
            ) : null}
          </Card>
        );
      }}
    />
  );
}

const s = StyleSheet.create({
  wrap: { padding: 16, paddingBottom: 40 },
  card: { marginTop: 10 },
  tabs: { flexDirection: 'row', gap: 8 },
  tab: {
    flex: 1, paddingVertical: 9, borderWidth: 1, borderColor: C.line,
    borderRadius: 4, alignItems: 'center',
  },
  tabOn: { borderColor: C.green, backgroundColor: C.greenBg },
  tabText: { fontFamily: mono, fontSize: 11, letterSpacing: 1.2, color: C.dim },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  kind: { fontFamily: mono, fontSize: 15, letterSpacing: 1, fontWeight: '700', flex: 1 },
  who: { fontFamily: mono, color: C.text, fontSize: 13 },
  meta: { fontFamily: mono, color: C.faint, fontSize: 11 },
  err: {
    fontFamily: mono, color: C.alarm, fontSize: 11, backgroundColor: C.alarmBg,
    padding: 9, borderRadius: 4,
  },
  empty: {
    fontFamily: mono, color: C.faint, fontSize: 12, lineHeight: 19,
    textAlign: 'center', marginTop: 26, paddingHorizontal: 24,
  },
});
