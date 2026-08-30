import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { C, S, T, fmtAgo, fmtCount } from '../theme';
import { Button, Card, Chip, Divider, Icon, Label, Txt } from '../ui';

const KIND = {
  sos:    { label: 'SOS is live',        lede: 'Your family has been alerted' },
  fall:   { label: 'Fall reported',      lede: 'Your family has been told you fell' },
  snatch: { label: 'Band torn off',      lede: 'Your family has been alerted' },
};

// When offline, the lede changes to reflect the honest state.
const KIND_QUEUED = {
  sos:    { label: 'SOS ACTIVATED',      lede: 'Waiting for connection' },
  fall:   { label: 'Fall reported',      lede: 'Waiting for connection' },
  snatch: { label: 'Band torn off',      lede: 'Waiting for connection' },
};

/**
 * U3.5 — what the wearer sees while her own SOS is live.
 *
 * The question this screen answers is the one she is actually asking, which is
 * not "is it sent" but "is anyone coming". So the first line is how long it
 * has been running, and the body is the names of the people who have pressed
 * "I'm on it" -- not a delivery receipt.
 *
 * Standing down is deliberately not the biggest thing here. It is a real
 * button, reachable in one tap, but the screen does not lead with it: the band
 * can also stand it down, and a person under pressure should not be able to
 * cancel her own alarm by fumbling the phone.
 *
 * OFFLINE QUEUE ADDITION: when deliveryStatus is 'queued', an amber banner
 * explains that the alert is saved locally and will be sent automatically
 * when signal returns. The user must never be told their family was alerted
 * when they have not been.
 */
export default function SosLiveView({ alert, deliveredTo, deliveryStatus, responders = [], onStandDown, busy, fix }) {
  const isQueued = deliveryStatus === 'queued';
  const kind = isQueued
    ? (KIND_QUEUED[alert?.kind] || KIND_QUEUED.sos)
    : (KIND[alert?.kind] || KIND.sos);

  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const elapsed = alert?.created_at
    ? Math.max(0, Math.floor(Date.now() / 1000 - alert.created_at))
    : 0;

  return (
    <Card tone={C.red} accent={C.red} style={{ gap: S.lg }}>
      <View style={s.head}>
        <View style={{ gap: 4 }}>
          <Label color={C.red}>{kind.label}</Label>
          <Txt variant="h1">{kind.lede}</Txt>
        </View>
        <Chip text={fmtCount(elapsed)} tone={C.red} icon="clock" />
      </View>

      {/* ---- offline banner ---- */}
      {isQueued && (
        <View style={s.offlineBanner}>
          <Icon name="wifi-off" size={18} color={C.amber} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[T.bodyMed, { color: C.amber }]}>
              Alert saved on this device
            </Text>
            <Text style={[T.meta, { color: C.dim }]}>
              It will be sent to your family the moment signal returns. Stay where help can reach you.
            </Text>
          </View>
        </View>
      )}

      <View style={s.grid}>
        <View style={s.cell}>
          <Label>Sent to</Label>
          <Text style={[T.number, { color: isQueued ? C.amber : C.text }]}>
            {isQueued
              ? 'Not yet — waiting for signal'
              : deliveredTo == null
                ? '—'
                : `${deliveredTo} ${deliveredTo === 1 ? 'person' : 'people'}`}
          </Text>
        </View>
        <View style={s.cell}>
          <Label>Raised from</Label>
          <Text style={[T.number, { color: C.text }]}>
            {alert?.source === 'band' ? 'The band' : 'This phone'}
          </Text>
        </View>
        <View style={s.cell}>
          <Label>Location</Label>
          <Text style={[T.number, { color: fix ? C.green : C.amber }]}>
            {fix ? 'Attached' : 'Not yet'}
          </Text>
        </View>
      </View>

      <Divider />

      <View style={{ gap: S.sm }}>
        <Label>{responders.length ? 'On their way' : (isQueued ? 'Nobody has been reached yet' : 'Waiting for someone to answer')}</Label>
        {responders.length ? (
          responders.map((r) => (
            <View key={r.id} style={s.responder}>
              <Icon name="user-check" size={16} color={C.green} />
              <Text style={[T.bodyMed, { color: C.text, flex: 1 }]}>{r.name}</Text>
              <Text style={[T.meta, { color: C.faint }]}>{fmtAgo(r.at)}</Text>
            </View>
          ))
        ) : (
          <Text style={[T.meta, { color: C.dim }]}>
            {isQueued
              ? 'Your family will be alerted as soon as your phone finds signal. The alert is safe — it cannot be lost.'
              : 'Their phones are ringing, and they keep ringing while this is open — a closed app does not stop the alarm getting through.'}
          </Text>
        )}
      </View>

      <View style={{ gap: S.sm }}>
        <Button title="I'M SAFE — STAND DOWN" tone={C.green} filled icon="shield"
                loading={busy} onPress={() => onStandDown?.(alert.id)} />
        <Text style={[T.meta, s.foot]}>
          The band can do this too: press key 1 to stand down without the phone.
        </Text>
      </View>
    </Card>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: S.md },
  grid: { flexDirection: 'row', gap: S.md },
  cell: { flex: 1, gap: 4 },
  responder: { flexDirection: 'row', alignItems: 'center', gap: S.sm },
  foot: { color: C.faint, textAlign: 'center' },
  offlineBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: S.sm,
    backgroundColor: C.amberSoft,
    borderRadius: 8,
    padding: S.md,
  },
});
