import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { call } from '../../api';
import { C, S, T, fmtAgo } from '../../theme';
import { Card, Chip, Icon, Txt, Button, Banner } from '../../ui';
import * as Clipboard from 'expo-clipboard';

export default function Dashboard({ session, ctx, refreshKey, onRaise, serverOnline, onAckCheckin }) {
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const m = await call(session, '/family');
      const withWatch = await Promise.all(m.map(async (member) => {
        try {
          return { ...member, watchState: await call(session, `/watch/${member.id}`) };
        } catch {
          return { ...member, watchState: null };
        }
      }));
      setMembers(withWatch);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [session]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const onRefresh = () => {
    setRefreshing(true);
    load();
  };

  const copyCode = () => {
    Clipboard.setStringAsync(session.user_id);
  };

  const checkin = async (m) => {
    try {
      await call(session, `/checkin/${m.id}`, { method: 'POST' });
      alert('Check-in requested.');
    } catch (e) {
      alert(e.message);
    }
  };

  const renderHeader = () => (
    <View style={s.headerWrap}>
      <View style={s.topBar}>
        <View>
          <Txt variant="h2">Family Safety</Txt>
          <Text style={[T.meta, { color: C.dim }]}>Peace of Mind Board</Text>
        </View>
        <Button tone={C.dim} icon="copy" title={`CODE #${session.user_id}`} onPress={copyCode} />
      </View>

      {!serverOnline && (
        <Banner tone={C.red} icon="wifi-off" title="Offline">
          Cannot connect to server.
        </Banner>
      )}

      {ctx.checkin && (
        <Card tone={C.amber}>
          <Txt variant="h2">Check-in Requested</Txt>
          <Text style={[T.meta, { color: C.dim, marginBottom: S.md }]}>
            Someone is checking in on you.
          </Text>
          <Button filled tone={C.green} title="I AM FINE" onPress={() => onAckCheckin(ctx.checkin)} />
        </Card>
      )}

      <View style={s.bannerStats}>
        <View style={s.statBox}>
          <Txt variant="h1" style={{ color: C.green }}>{members.length}</Txt>
          <Text style={[T.meta, { color: C.dim }]}>Family Members</Text>
        </View>
        <View style={s.statBox}>
          <Txt variant="h1" style={{ color: C.green }}>100%</Txt>
          <Text style={[T.meta, { color: C.dim }]}>Secured</Text>
        </View>
      </View>

      <Text style={[T.label, { color: C.dim, marginTop: S.xl, marginBottom: S.sm }]}>
        PRIMARY MONITORED MEMBER
      </Text>
      
      <Button 
        title="Tap to simulate SOS" 
        tone={C.red}
        icon="alert-triangle" 
        onPress={() => onRaise({ kind: 'sos', source: 'app' })} 
        style={{ marginBottom: S.xl }}
      />
    </View>
  );

  return (
    <FlatList
      data={members}
      style={s.list}
      contentContainerStyle={s.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.green} />}
      ListHeaderComponent={renderHeader}
      keyExtractor={m => m.id}
      ItemSeparatorComponent={() => <View style={{ height: S.md }} />}
      ListEmptyComponent={
        !loading && (
          <View style={{ alignItems: 'center', padding: S.xl }}>
            <Icon name="users" size={48} color={C.dim} />
            <Txt variant="h2" style={{ marginTop: S.md }}>No family members</Txt>
            <Text style={[T.meta, { color: C.dim, textAlign: 'center', marginTop: S.sm }]}>
              Give your code {session.user_id} to a family member so they can add you.
            </Text>
          </View>
        )
      }
      renderItem={({ item }) => {
        const w = item.watchState || {};
        const batt = w.phone_batt != null ? `${w.phone_batt}%` : '—';
        const sync = w.band_link ? 'Synced' : 'No Band';
        const age = w.last_beat ? fmtAgo(w.last_beat) : 'Offline';

        return (
          <Card>
            <View style={s.row}>
              <View>
                <Txt variant="h2">{item.name}</Txt>
                <Text style={[T.meta, { color: C.faint }]}>{item.relation || 'Family'}</Text>
              </View>
              <Chip text={item.online ? 'Online' : 'Offline'} tone={item.online ? C.green : C.faint} />
            </View>
            
            <View style={s.statsRow}>
              <View style={s.statCol}>
                <Icon name="battery" size={16} color={C.dim} />
                <Text style={[T.meta, { color: C.text }]}>{batt}</Text>
              </View>
              <View style={s.statCol}>
                <Icon name="watch" size={16} color={C.dim} />
                <Text style={[T.meta, { color: C.text }]}>{sync}</Text>
              </View>
              <View style={s.statCol}>
                <Icon name="activity" size={16} color={C.dim} />
                <Text style={[T.meta, { color: C.text }]}>{age}</Text>
              </View>
            </View>

            <Button title="Request Check-in" icon="check-circle" onPress={() => checkin(item)} />
          </Card>
        );
      }}
    />
  );
}

const s = StyleSheet.create({
  list: { flex: 1, backgroundColor: C.bg },
  content: { padding: S.lg, paddingBottom: 40 },
  headerWrap: { marginBottom: S.md },
  topBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: S.xl },
  bannerStats: { flexDirection: 'row', gap: S.md, marginTop: S.md },
  statBox: { flex: 1, backgroundColor: C.surface, borderRadius: 8, padding: S.md, alignItems: 'center' },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: S.md },
  statsRow: { flexDirection: 'row', gap: S.lg, marginBottom: S.md },
  statCol: { flexDirection: 'row', alignItems: 'center', gap: 4 },
});
