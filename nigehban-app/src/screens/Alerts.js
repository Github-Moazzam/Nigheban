import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, FlatList, Linking, Pressable, RefreshControl,
  StyleSheet, Text, View,
} from 'react-native';
import { call } from '../api';
import { C, S, T, fmtAgo, sevColor } from '../theme';
import { Banner, Button, Card, Chip, EmptyState, Icon, Txt } from '../ui';

const KIND = {
  sos:            { title: 'SOS',                 icon: 'alert-octagon' },
  snatch:         { title: 'Band torn off',       icon: 'alert-octagon' },
  fall:           { title: 'Fall detected',       icon: 'trending-down' },
  checkin_missed: { title: 'Missed check-in',     icon: 'clock' },
  watch_lost:     { title: 'Watch stopped',       icon: 'wifi-off' },
  going_dark:     { title: 'Phone about to die',  icon: 'battery' },
  checkin_req:    { title: 'Check-in asked',      icon: 'help-circle' },
  checkin_ack:    { title: 'Checked in — fine',   icon: 'check-circle' },
  low_battery:    { title: 'Battery low',         icon: 'battery' },
  near_miss:      { title: 'Near miss — private', icon: 'eye-off' },
};

const SCOPES = [['incoming', 'From family'], ['mine', 'Mine']];

/**
 * ALERTS — the record, and the one action a record can still carry.
 *
 * Sorted newest first and never grouped: an emergency from four minutes ago is
 * not a "yesterday" section. Anything still live keeps its tint and its
 * acknowledgement button until somebody stands it down.
 */
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
      ItemSeparatorComponent={() => <View style={{ height: S.md }} />}
      ListHeaderComponent={
        <View style={{ gap: S.md, marginBottom: S.md }}>
          <View style={s.segment}>
            {SCOPES.map(([k, label]) => {
              const on = scope === k;
              return (
                <Pressable key={k} onPress={() => setScope(k)}
                           accessibilityRole="tab" accessibilityState={{ selected: on }}
                           style={[s.segBtn, on && s.segBtnOn]}>
                  <Text style={[T.button, { fontSize: 14, color: on ? C.text : C.dim }]}>
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {err ? (
            <Banner tone={C.red} icon="alert-circle" title="Could not load your alerts">
              {err}
            </Banner>
          ) : null}
        </View>
      }
      ListEmptyComponent={
        loading ? (
          <ActivityIndicator color={C.green} style={{ marginTop: S.xxl }} />
        ) : scope === 'incoming' ? (
          <EmptyState icon="shield" title="Nothing from your family"
                      body="That is the good outcome. Anything they raise appears here the moment it happens." />
        ) : (
          <EmptyState icon="activity" title="You have not raised anything"
                      body="Your own alerts, check-ins and near misses are kept here so you can see what the band actually did." />
        )
      }
      renderItem={({ item }) => {
        const meta = KIND[item.kind] || { title: item.kind.replace('_', ' '), icon: 'circle' };
        const tone = sevColor(item.severity);
        const live = item.severity >= 4 && !item.resolved_at;

        return (
          <Card tone={live ? tone : undefined} accent={live ? tone : undefined}>
            <View style={s.head}>
              <View style={[s.mark, { backgroundColor: live ? tone : C.raised }]}>
                <Icon name={meta.icon} size={16} color={live ? C.bg : tone} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Txt variant="h2">{meta.title}</Txt>
                <Text style={[T.meta, { color: C.dim }]}>
                  {scope === 'incoming' ? item.user.name : 'You'}
                  {item.source === 'band' ? ' · from the band'
                    : item.source === 'server' ? ' · from the server watchdog'
                    : ' · from the phone'}
                </Text>
              </View>
              <Text style={[T.meta, { color: C.faint }]}>{fmtAgo(item.created_at)}</Text>
            </View>

            {item.note ? (
              <Text style={[T.meta, { color: C.dim }]}>{item.note}</Text>
            ) : null}

            <View style={s.chips}>
              {item.resolved_at ? (
                <Chip text={`stood down ${fmtAgo(item.resolved_at)}`} tone={C.green} icon="check" />
              ) : live ? (
                <Chip text="still live" tone={tone} icon="radio" />
              ) : null}
              {item.maps ? null : <Chip text="no location" tone={C.faint} icon="map-pin" />}
            </View>

            {item.maps ? (
              <Button title="OPEN IN MAPS" icon="navigation" tone={live ? tone : C.dim}
                      sub={item.accuracy ? `accurate to about ${Math.round(item.accuracy)} m` : null}
                      onPress={() => Linking.openURL(item.maps)} />
            ) : null}

            {scope === 'incoming' && item.severity >= 3 && !item.resolved_at ? (
              <Button title="I'VE SEEN THIS — I'M ON IT" filled tone={tone}
                      icon="user-check" loading={busy === item.id}
                      onPress={() => ack(item)} />
            ) : null}
          </Card>
        );
      }}
    />
  );
}

const s = StyleSheet.create({
  wrap: { padding: S.lg, paddingBottom: 40 },
  segment: { flexDirection: 'row', backgroundColor: C.surface, borderRadius: 6, padding: 3 },
  segBtn: { flex: 1, minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 4 },
  segBtnOn: { backgroundColor: C.raised },
  head: { flexDirection: 'row', alignItems: 'center', gap: S.md },
  mark: { width: 34, height: 34, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  chips: { flexDirection: 'row', gap: S.sm, flexWrap: 'wrap' },
});
