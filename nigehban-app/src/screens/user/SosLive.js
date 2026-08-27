import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { S, T, fmtAgo, fmtCount } from '../../theme';
import { Icon, Txt } from '../../ui';
import { RU, U } from './kit';

const LEDE = {
  sos: 'Your family has been alerted',
  fall: 'Your family has been told you fell',
  snatch: 'Your family has been alerted',
};

/**
 * What the wearer sees while her own alert is live.
 *
 * The question she is asking is not "did it send" but "is anyone coming", so
 * the names of the people who answered are the body of the screen and the
 * delivery count is a footnote. Standing down is a real button and one tap
 * away, but it is not the loudest thing here.
 */
export default function SosLive({ alert, deliveredTo, responders = [], onStandDown }) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const elapsed = alert?.created_at
    ? Math.max(0, Math.floor(Date.now() / 1000 - alert.created_at))
    : 0;

  return (
    <ScrollView style={s.root} contentContainerStyle={s.content}>
      <View style={s.badge}>
        <View style={s.pulse} />
        <Text style={[T.label, { color: U.red }]}>SOS LIVE</Text>
        <Text style={[T.label, { color: U.red }]}>{fmtCount(elapsed)}</Text>
      </View>

      <Txt variant="h1" color={U.text} style={s.title}>{LEDE[alert?.kind] || LEDE.sos}</Txt>
      <Text style={[T.meta, s.sub]}>
        {deliveredTo == null
          ? 'Sending…'
          : `Sent to ${deliveredTo} ${deliveredTo === 1 ? 'person' : 'people'}`}
      </Text>

      <View style={s.panel}>
        <Text style={[T.label, { color: U.faint }]}>
          {responders.length ? 'ON THEIR WAY' : 'WAITING FOR AN ANSWER'}
        </Text>
        {responders.length ? (
          responders.map((r) => (
            <View key={r.id} style={s.responder}>
              <Icon name="user-check" size={16} color={U.mint} />
              <Text style={[T.bodyMed, { color: U.text, flex: 1 }]}>{r.name}</Text>
              <Text style={[T.meta, { color: U.faint }]}>{fmtAgo(r.at)}</Text>
            </View>
          ))
        ) : (
          <Text style={[T.meta, { color: U.dim }]}>
            Their phones are ringing.
          </Text>
        )}
      </View>

      <Pressable
        onPress={() => onStandDown?.(alert.id)}
        accessibilityRole="button"
        accessibilityLabel="I am safe, stand the alert down"
        style={({ pressed }) => [s.standDown, pressed && { opacity: 0.75 }]}
      >
        <Icon name="shield" size={17} color={U.bg} />
        <Text style={[T.button, { color: U.bg }]}>I am safe — stand down</Text>
      </Pressable>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: U.bg },
  content: { padding: S.lg, paddingTop: S.xxl, gap: S.md },

  badge: {
    flexDirection: 'row', alignItems: 'center', gap: S.sm,
    alignSelf: 'flex-start', backgroundColor: U.redSoft,
    paddingHorizontal: S.md, paddingVertical: S.sm, borderRadius: RU.pill,
  },
  pulse: { width: 7, height: 7, borderRadius: 4, backgroundColor: U.red },

  title: { marginTop: S.md },
  sub: { color: U.dim },

  panel: {
    gap: S.md, backgroundColor: U.card,
    borderRadius: RU.card, padding: S.lg, marginTop: S.md,
  },
  responder: { flexDirection: 'row', alignItems: 'center', gap: S.sm },

  standDown: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: S.sm,
    minHeight: 52, borderRadius: RU.inner, backgroundColor: U.mint, marginTop: S.lg,
  },
});
