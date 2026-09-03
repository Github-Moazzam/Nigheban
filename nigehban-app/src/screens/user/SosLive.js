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
  alert, deliveredTo, deliveryStatus, responders = [], onStandDown, onMinimise, onOptinSamaritan,
}) {
  const isQueued = deliveryStatus === 'queued';
  // Standing down goes to the server and does not come back for a moment. On
  // the one screen where nobody is going to wait patiently, that moment has to
  // be visible or the button gets pressed again -- and again.
  const [standingDown, setStandingDown] = useState(false);
  const [samaritanBusy, setSamaritanBusy] = useState(false);
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

  const samaritanStatus = alert?.samaritan_status || 'pending';

  const handleSamaritan = async (action) => {
    if (samaritanBusy || !alert?.id) return;
    setSamaritanBusy(true);
    try {
      await onOptinSamaritan?.(alert.id, action);
    } finally {
      setSamaritanBusy(false);
    }
  };


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
              It sends the moment signal returns.
            </Text>
          </View>
        </View>
      )}

      {/* ---- Good Samaritan controls / status ---- */}
      {!isQueued && samaritanStatus === 'pending' && (
        <View style={s.samaritanCard}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm }}>
            <Icon name="users" size={16} color={U.mint} />
            <Text style={[T.bodyMed, { color: U.text, flex: 1 }]}>
              Alert nearby people (Good Samaritan)?
            </Text>
          </View>
          <Text style={[T.meta, { color: U.dim }]}>
            Nigehban users within 800 m can be asked to help.
          </Text>
          <View style={{ flexDirection: 'row', gap: S.sm, marginTop: S.xs }}>
            <Pressable
              onPress={() => handleSamaritan('allow')}
              disabled={samaritanBusy}
              style={({ pressed }) => [s.samaritanBtn, { backgroundColor: U.mint }, pressed && { opacity: 0.8 }]}
            >
              {samaritanBusy ? (
                <ActivityIndicator size="small" color={U.bg} />
              ) : (
                <Text style={[T.label, { color: U.bg }]}>📢 ALERT NEARBY</Text>
              )}
            </Pressable>
            <Pressable
              onPress={() => handleSamaritan('deny')}
              disabled={samaritanBusy}
              style={({ pressed }) => [s.samaritanBtn, { backgroundColor: U.card, borderWidth: 1, borderColor: U.raised }, pressed && { opacity: 0.8 }]}
            >
              <Text style={[T.label, { color: U.dim }]}>FAMILY ONLY</Text>
            </Pressable>
          </View>
        </View>
      )}

      {!isQueued && samaritanStatus === 'allowed' && (
        <View style={s.samaritanBanner}>
          <Icon name="check-circle" size={16} color={U.mint} />
          <Text style={[T.meta, { color: U.mint, flex: 1 }]}>
            Nearby Good Samaritans have been notified
          </Text>
        </View>
      )}

      <Text style={[T.meta, s.sub]}>
        {isQueued
          ? 'Not yet — waiting for signal'
          : deliveredTo == null
            ? 'Sending alert to network…'
            : `Sent to ${deliveredTo} ${deliveredTo === 1 ? 'person' : 'people'}`}
      </Text>

      <View style={s.panel}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={[T.label, { color: responders.length ? U.mint : (elapsed >= 20 ? U.amber : U.faint) }]}>
            {responders.length
              ? `ON THEIR WAY (${responders.length})`
              : isQueued
                ? 'SAVED LOCALLY'
                : elapsed >= 20
                  ? 'NO RESPONSES YET'
                  : 'WAITING FOR AN ANSWER'}
          </Text>
          {!responders.length && !isQueued && (
            <Text style={[T.meta, { color: elapsed >= 20 ? U.amber : U.faint }]}>
              {fmtCount(elapsed)}
            </Text>
          )}
        </View>

        {responders.length ? (
          <View style={{ gap: S.sm }}>
            {responders.map((r) => (
              <View key={r.id || `${r.name}-${r.at}`} style={s.responder}>
                <View style={s.responderIcon}>
                  <Icon name="user-check" size={16} color={U.mint} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[T.bodyMed, { color: U.text }]}>{r.name}</Text>
                  <Text style={[T.meta, { color: U.mint }]}>Confirmed coming to your aid</Text>
                </View>
                <Text style={[T.meta, { color: U.faint }]}>{fmtAgo(r.at)}</Text>
              </View>
            ))}
          </View>
        ) : isQueued ? (
          <View style={s.noResponseCard}>
            <Icon name="wifi-off" size={18} color={U.amber} />
            <Text style={[T.meta, { color: U.dim, flex: 1 }]}>
              Saved on this device. Your family is alerted as soon as you have signal.
            </Text>
          </View>
        ) : elapsed >= 20 ? (
          <View style={[s.noResponseCard, { borderColor: 'rgba(245, 158, 11, 0.3)', backgroundColor: 'rgba(245, 158, 11, 0.08)' }]}>
            <Icon name="alert-triangle" size={18} color={U.amber} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[T.bodyMed, { color: U.amber }]}>
                No one has confirmed yet
              </Text>
              <Text style={[T.meta, { color: U.dim }]}>
                Sirens are ringing on your family's phones. In immediate danger,
                call 15 or 1122.
              </Text>
            </View>
          </View>
        ) : (
          <View style={s.noResponseCard}>
            <ActivityIndicator size="small" color={U.mint} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[T.bodyMed, { color: U.text }]}>
                Alerting emergency network…
              </Text>
              <Text style={[T.meta, { color: U.dim }]}>
                Sirens are ringing on your family's phones.
              </Text>
            </View>
          </View>
        )}
      </View>

      {/* Stand Down button: disabled while sending, enabled when live */}
      {(() => {
        const isSending = !alert?.id || deliveryStatus === 'sending';
        const canStandDown = !isSending && !standingDown;
        return (
          <Pressable
            onPress={async () => {
              if (!canStandDown) return;
              setStandingDown(true);
              try { await onStandDown?.(alert.id); } finally { setStandingDown(false); }
            }}
            disabled={!canStandDown}
            accessibilityRole="button"
            accessibilityState={{ busy: standingDown || isSending, disabled: !canStandDown }}
            accessibilityLabel={isSending ? 'Sending alert' : 'I am safe, stand the alert down'}
            style={({ pressed }) => [
              s.standDown,
              isSending && { backgroundColor: U.card, borderWidth: 1, borderColor: U.raised },
              pressed && canStandDown && { opacity: 0.75 },
            ]}
          >
            {isSending ? (
              <>
                <ActivityIndicator size="small" color={U.dim} />
                <Text style={[T.button, { color: U.dim }]}>Sending alert to network…</Text>
              </>
            ) : standingDown ? (
              <>
                <ActivityIndicator size="small" color={U.bg} />
                <Text style={[T.button, { color: U.bg }]}>Standing down…</Text>
              </>
            ) : (
              <>
                <Icon name="shield" size={17} color={U.bg} />
                <Text style={[T.button, { color: U.bg }]}>I am safe — stand down</Text>
              </>
            )}
          </Pressable>
        );
      })()}

      {onMinimise ? (
        <Text style={[T.meta, s.foot]}>
          Only standing down ends this. Going back to the app keeps it running —
          the red bar brings you straight back.
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
  responder: {
    flexDirection: 'row', alignItems: 'center', gap: S.sm,
    backgroundColor: 'rgba(52, 211, 153, 0.08)',
    padding: S.md, borderRadius: RU.inner,
    borderWidth: 1, borderColor: 'rgba(52, 211, 153, 0.25)',
  },
  responderIcon: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: 'rgba(52, 211, 153, 0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  noResponseCard: {
    flexDirection: 'row', alignItems: 'flex-start', gap: S.sm,
    padding: S.md, borderRadius: RU.inner,
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderWidth: 1, borderColor: U.raised,
  },

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
  samaritanCard: {
    backgroundColor: U.card,
    borderRadius: RU.card,
    padding: S.lg,
    gap: S.sm,
    borderWidth: 1,
    borderColor: U.raised,
  },
  samaritanBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: S.sm,
    backgroundColor: U.mintSoft || 'rgba(52, 211, 153, 0.1)',
    borderRadius: RU.inner,
    padding: S.md,
  },
  samaritanBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    borderRadius: RU.inner,
    paddingHorizontal: S.md,
  },
});


