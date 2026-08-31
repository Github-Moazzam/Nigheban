import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { HIT, S, T, fmtAgo, fmtCount } from '../../theme';
import { Icon, Txt } from '../../ui';
import { RU, U } from './kit';

const LEDE = {
  sos: 'Your family has been alerted',
  fall: 'Your family has been told you fell',
  snatch: 'Your family has been alerted',
};

const LEDE_QUEUED = {
  sos: 'Waiting for connection',
  fall: 'Waiting for connection',
  snatch: 'Waiting for connection',
};

/**
 * What the wearer sees while her own alert is live.
 *
 * The question she is asking is not "did it send" but "is anyone coming", so
 * the names of the people who answered are the body of the screen and the
 * delivery count is a footnote. Standing down is a real button and one tap
 * away, but it is not the loudest thing here.
 *
 * OFFLINE QUEUE: when deliveryStatus is 'queued', the screen shows an amber
 * banner explaining that the alert is saved locally. The user is never told
 * their family was alerted when they have not been — that lie could cost a life.
 *
 * A WAY OUT THAT IS NOT A CANCELLATION: `onMinimise` hands the rest of the app
 * back without touching the alert. It exists because the two controls this
 * screen used to offer were "stand down" and nothing, and somebody who needs
 * to look up an address, send a message in her own words, or check what her
 * family has already been told should not have to end her own emergency to do
 * it. The word on the button is never "close" or "dismiss" for the same
 * reason: what is being put away is the screen, not the SOS.
 */
export default function SosLive({
  alert, deliveredTo, deliveryStatus, responders = [], onStandDown, onMinimise,
}) {
  const isQueued = deliveryStatus === 'queued';
  // Standing down goes to the server and does not come back for a moment. On
  // the one screen where nobody is going to wait patiently, that moment has to
  // be visible or the button gets pressed again -- and again.
  const [standingDown, setStandingDown] = useState(false);
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const elapsed = alert?.created_at
    ? Math.max(0, Math.floor(Date.now() / 1000 - alert.created_at))
    : 0;

  const lede = isQueued
    ? (LEDE_QUEUED[alert?.kind] || LEDE_QUEUED.sos)
    : (LEDE[alert?.kind] || LEDE.sos);

  return (
    <ScrollView style={s.root} contentContainerStyle={s.content}>
      <View style={s.topRow}>
        <View style={s.badge}>
          <View style={s.pulse} />
          <Text style={[T.label, { color: U.red }]}>SOS LIVE</Text>
          <Text style={[T.label, { color: U.red }]}>{fmtCount(elapsed)}</Text>
        </View>

        {onMinimise ? (
          <Pressable
            onPress={onMinimise}
            hitSlop={HIT}
            accessibilityRole="button"
            accessibilityLabel="Go back to the app. Your SOS stays live."
            style={({ pressed }) => [s.back, pressed && { opacity: 0.7 }]}
          >
            <Icon name="chevron-left" size={15} color={U.dim} />
            <Text style={[T.label, { color: U.dim }]}>BACK TO APP</Text>
          </Pressable>
        ) : null}
      </View>

      <Txt variant="h1" color={U.text} style={s.title}>{lede}</Txt>

      {/* ---- offline banner ---- */}
      {isQueued && (
        <View style={s.offlineBanner}>
          <Icon name="wifi-off" size={18} color={U.amber} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[T.bodyMed, { color: U.amber }]}>
              Alert saved on this device
            </Text>
            <Text style={[T.meta, { color: U.dim }]}>
              It will be sent to your family the moment signal returns. Stay where help can reach you.
            </Text>
          </View>
        </View>
      )}

      <Text style={[T.meta, s.sub]}>
        {isQueued
          ? 'Not yet — waiting for signal'
          : deliveredTo == null
            ? 'Sending…'
            : `Sent to ${deliveredTo} ${deliveredTo === 1 ? 'person' : 'people'}`}
      </Text>

      <View style={s.panel}>
        <Text style={[T.label, { color: U.faint }]}>
          {responders.length
            ? 'ON THEIR WAY'
            : isQueued
              ? 'NOBODY HAS BEEN REACHED YET'
              : 'WAITING FOR AN ANSWER'}
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
            {isQueued
              ? 'Your family will be alerted as soon as your phone finds signal. The alert is safe — it cannot be lost.'
              : 'Their phones are ringing.'}
          </Text>
        )}
      </View>

      <Pressable
        onPress={async () => {
          if (standingDown) return;
          setStandingDown(true);
          try { await onStandDown?.(alert.id); } finally { setStandingDown(false); }
        }}
        disabled={standingDown}
        accessibilityRole="button"
        accessibilityState={{ busy: standingDown, disabled: standingDown }}
        accessibilityLabel="I am safe, stand the alert down"
        style={({ pressed }) => [s.standDown, pressed && { opacity: 0.75 }]}
      >
        {standingDown ? (
          <ActivityIndicator size="small" color={U.bg} />
        ) : (
          <Icon name="shield" size={17} color={U.bg} />
        )}
        <Text style={[T.button, { color: U.bg }]}>
          {standingDown ? 'Standing down…' : 'I am safe — stand down'}
        </Text>
      </Pressable>

      {onMinimise ? (
        <Text style={[T.meta, s.foot]}>
          Standing down is the only thing that ends this. Going back to the app
          does not: the alert keeps running, your family keeps being told, and a
          red bar at the top of every screen brings you straight back here.
        </Text>
      ) : null}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: U.bg },
  content: { padding: S.lg, paddingTop: S.xxl, gap: S.md },

  topRow: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', gap: S.md,
  },
  badge: {
    flexDirection: 'row', alignItems: 'center', gap: S.sm,
    alignSelf: 'flex-start', backgroundColor: U.redSoft,
    paddingHorizontal: S.md, paddingVertical: S.sm, borderRadius: RU.pill,
  },
  /* Quiet, and at the opposite end of the screen from the stand-down button.
     The two must never be confusable, and a thumb reaching for one must not
     be able to find the other. */
  back: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: S.md, paddingVertical: S.sm,
    borderRadius: RU.pill, backgroundColor: U.card,
  },
  foot: { color: U.faint, textAlign: 'center', marginTop: S.sm },
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
  offlineBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: S.sm,
    backgroundColor: U.amberSoft,
    borderRadius: RU.inner,
    padding: S.md,
  },
});
