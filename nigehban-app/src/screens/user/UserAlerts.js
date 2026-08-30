import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, FlatList, Linking, Pressable, RefreshControl,
  StyleSheet, Text, View,
} from 'react-native';
import { call } from '../../api';
import { S, T, fmtAgo } from '../../theme';
import { Icon, Txt } from '../../ui';
import { RU, U } from './kit';

/** Every kind the server can write, said the way a person would say it. */
const KIND = {
  sos:            { title: 'SOS',                 icon: 'alert-octagon' },
  snatch:         { title: 'Band torn off',       icon: 'alert-octagon' },
  fall:           { title: 'Fall detected',       icon: 'trending-down' },
  checkin_missed: { title: 'Missed check-in',     icon: 'clock' },
  watch_lost:     { title: 'Went quiet while armed', icon: 'wifi-off' },
  going_dark:     { title: 'Phone about to die',  icon: 'battery' },
  checkin_req:    { title: 'Check-in asked',      icon: 'help-circle' },
  checkin_ack:    { title: 'Checked in — fine',   icon: 'check-circle' },
  low_battery:    { title: 'Phone battery low',   icon: 'battery' },
  band_battery:   { title: 'Band battery low',    icon: 'battery' },
  near_miss:      { title: 'Near miss — private', icon: 'eye-off' },
};

const SCOPES = [['incoming', 'From family'], ['mine', 'Mine']];

/** Severity in the user palette. Mint is the resting state everywhere else too. */
function tone(sev) {
  if (sev >= 4) return U.red;
  if (sev >= 2) return U.amber;
  return U.mint;
}

/**
 * ALERTS — the record, and the actions a record still carries.
 *
 * Newest first and never grouped into days: an emergency from four minutes ago
 * does not belong under a heading. Two scopes, because they answer two
 * different questions -- "is my family alright" and "what did my band actually
 * do" -- and each one carries only the buttons that make sense for it. From
 * family: I have seen this, and open where they are. Mine: stand it down.
 */
export default function UserAlerts({ session, refreshKey, onResolve }) {
  const [scope, setScope] = useState('incoming');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(null);
  const [acked, setAcked] = useState(() => new Set());
  const [err, setErr] = useState(null);
  const [, force] = useState(0);

  const load = useCallback(async () => {
    try {
      setRows(await call(session, `/alerts?scope=${scope}`));
      setErr(null);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [session, scope]);

  useEffect(() => { setLoading(true); load(); }, [load, refreshKey]);

  // Every row on this screen is a relative time. Without a tick they freeze at
  // whatever they said when the list was built, which on a live alert is the
  // one number somebody is actually watching.
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 30000);
    return () => clearInterval(id);
  }, []);

  const seen = useRef(acked);
  seen.current = acked;

  const ack = async (a) => {
    setBusy(a.id);
    try {
      await call(session, `/alert/${a.id}/ack`, { method: 'POST' });
      setAcked(new Set([...seen.current, a.id]));
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  const standDown = async (a) => {
    setBusy(a.id);
    try {
      await onResolve?.(a.id);
      await load();
    } finally {
      setBusy(null);
    }
  };

  return (
    <FlatList
      style={s.root}
      contentContainerStyle={s.content}
      data={rows}
      keyExtractor={(a) => String(a.id)}
      ItemSeparatorComponent={() => <View style={{ height: S.md }} />}
      refreshControl={(
        <RefreshControl
          refreshing={refreshing}
          tintColor={U.mint}
          onRefresh={() => { setRefreshing(true); load(); }}
        />
      )}
      ListHeaderComponent={(
        <View style={s.header}>
          <View style={{ gap: 2 }}>
            <Txt variant="h1" color={U.text}>Alerts</Txt>
            <Text style={[T.meta, { color: U.faint }]}>
              Everything raised, in the order it happened
            </Text>
          </View>

          <View style={s.segment}>
            {SCOPES.map(([k, label]) => {
              const on = scope === k;
              return (
                <Pressable
                  key={k}
                  onPress={() => setScope(k)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: on }}
                  style={[s.segBtn, on && { backgroundColor: U.raised }]}
                >
                  <Text style={[T.button, { fontSize: 14, color: on ? U.text : U.faint }]}>
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {err ? (
            <View style={s.errBox}>
              <Icon name="alert-circle" size={14} color={U.red} />
              <Text style={[T.meta, { color: U.dim, flex: 1 }]}>{err}</Text>
            </View>
          ) : null}
        </View>
      )}
      ListEmptyComponent={loading ? (
        <ActivityIndicator color={U.mint} style={{ marginTop: S.xxl }} />
      ) : (
        <View style={s.empty}>
          <Icon name={scope === 'incoming' ? 'shield' : 'activity'} size={22} color={U.faint} />
          <Txt variant="h2" color={U.text}>
            {scope === 'incoming' ? 'Nothing from your family' : 'You have not raised anything'}
          </Txt>
          <Text style={[T.meta, { color: U.dim, textAlign: 'center' }]}>
            {scope === 'incoming'
              ? 'That is the good outcome. Anything they raise appears here the moment it happens.'
              : 'Your own alerts, check-ins and near misses are kept here, so you can see what the band actually did.'}
          </Text>
        </View>
      )}
      renderItem={({ item }) => {
        const meta = KIND[item.kind] || { title: item.kind.replace(/_/g, ' '), icon: 'circle' };
        const t = tone(item.severity);
        const live = item.severity >= 4 && !item.resolved_at;
        const mine = scope === 'mine';

        return (
          <View style={[s.card, live && { backgroundColor: U.redSoft }]}>
            {live ? <View style={[s.accent, { backgroundColor: t }]} /> : null}

            <View style={s.head}>
              <View style={[s.mark, { backgroundColor: live ? t : U.raised }]}>
                <Icon name={meta.icon} size={16} color={live ? U.bg : t} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Txt variant="h2" color={U.text}>{meta.title}</Txt>
                <Text style={[T.meta, { color: U.dim }]}>
                  {mine ? 'You' : item.user?.name || 'Family'}
                  {item.source === 'band' ? ' · from the band'
                    : item.source === 'server' ? ' · noticed by Nigehban'
                    : ' · from the phone'}
                </Text>
              </View>
              <Text style={[T.meta, { color: U.faint }]}>{fmtAgo(item.created_at)}</Text>
            </View>

            {item.note ? (
              <Text style={[T.meta, { color: U.dim }]}>{item.note}</Text>
            ) : null}

            <View style={s.chips}>
              {item.resolved_at ? (
                <Chip icon="check" text={`stood down ${fmtAgo(item.resolved_at)}`} tint={U.mint} />
              ) : live ? (
                <Chip icon="radio" text="still live" tint={t} />
              ) : null}
              {item.maps ? null : <Chip icon="map-pin" text="no location" tint={U.faint} />}
              {acked.has(item.id) ? (
                <Chip icon="user-check" text="you are on it" tint={U.mint} />
              ) : null}
            </View>

            {item.maps ? (
              <Action
                icon="navigation" label="Open in maps"
                sub={item.accuracy ? `accurate to about ${Math.round(item.accuracy)} m` : null}
                onPress={() => Linking.openURL(item.maps)}
              />
            ) : null}

            {/* The two things a record can still be. Answering somebody else's
                emergency, or ending your own -- never both on one card. */}
            {!mine && item.severity >= 3 && !item.resolved_at && !acked.has(item.id) ? (
              <Action
                filled tint={t} icon="user-check" label="I've seen this — I'm on it"
                busy={busy === item.id} onPress={() => ack(item)}
              />
            ) : null}

            {mine && live ? (
              <Action
                filled tint={U.mint} icon="shield" label="I am safe — stand down"
                busy={busy === item.id} onPress={() => standDown(item)}
              />
            ) : null}
          </View>
        );
      }}
    />
  );
}

function Chip({ icon, text, tint }) {
  return (
    <View style={s.chip}>
      <Icon name={icon} size={11} color={tint} />
      <Text style={[T.label, { color: tint }]}>{text.toUpperCase()}</Text>
    </View>
  );
}

/** Filled is the one thing to do next; outlined is everything else. */
function Action({ icon, label, sub, onPress, filled, tint = U.mint, busy }) {
  const fg = filled ? U.bg : U.dim;
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        s.action,
        { backgroundColor: filled ? tint : U.raised },
        pressed && { opacity: 0.75 },
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={fg} />
      ) : (
        <>
          <Icon name={icon} size={16} color={fg} />
          <View>
            <Text style={[T.button, { color: fg }]}>{label}</Text>
            {sub ? <Text style={[T.meta, { color: fg, opacity: 0.8 }]}>{sub}</Text> : null}
          </View>
        </>
      )}
    </Pressable>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: U.bg },
  content: { padding: S.lg, paddingBottom: S.xxl },

  header: { gap: S.md, marginBottom: S.md },
  segment: {
    flexDirection: 'row', backgroundColor: U.card,
    borderRadius: RU.pill, padding: 4,
  },
  segBtn: {
    flex: 1, minHeight: 42, alignItems: 'center', justifyContent: 'center',
    borderRadius: RU.pill,
  },
  errBox: {
    flexDirection: 'row', alignItems: 'center', gap: S.sm,
    backgroundColor: U.redSoft, borderRadius: RU.card, padding: S.md,
  },

  card: {
    backgroundColor: U.card, borderRadius: RU.card,
    padding: S.lg, gap: S.md, overflow: 'hidden',
  },
  accent: { position: 'absolute', left: 0, top: S.lg, bottom: S.lg, width: 3 },
  head: { flexDirection: 'row', alignItems: 'center', gap: S.md },
  mark: {
    width: 34, height: 34, borderRadius: RU.inner,
    alignItems: 'center', justifyContent: 'center',
  },

  chips: { flexDirection: 'row', gap: S.sm, flexWrap: 'wrap' },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: U.raised, borderRadius: RU.pill,
    paddingHorizontal: S.md, paddingVertical: 6,
  },

  action: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: S.sm,
    minHeight: 48, borderRadius: RU.inner, paddingHorizontal: S.md,
  },

  empty: {
    alignItems: 'center', gap: S.sm,
    paddingVertical: S.xxl, paddingHorizontal: S.lg,
  },
});
