import React, { useState } from 'react';
import { Linking, Modal, StyleSheet, Text, View } from 'react-native';
import { C, S, T, fmtAgo } from '../theme';
import { Banner, Button, Chip, Divider, Icon, Label, Txt } from '../ui';

const KIND = { sos: 'An emergency', snatch: 'A wristband was torn off', fall: 'A fall' };

/**
 * U4.4 — a stranger nearby needs help.
 *
 * Two screens in one, and the order is the whole feature. Before "I'm going"
 * the wearer is anonymous and the pin is snapped to a three-hundred-metre
 * grid: enough to decide whether you are close enough to be useful, not
 * enough to find anybody. Saying yes is what releases the name and the exact
 * location, and it puts the responder's own name on the alert at the same
 * moment (matrix #20).
 *
 * Declining is a full-width button, not a dismissable corner. Nobody should
 * feel trapped by this screen.
 */
export default function SamaritanCall({ call: incoming, onRespond, onDismiss }) {
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState(null);
  const [error, setError] = useState(null);

  if (!incoming) return null;
  const a = incoming;

  const go = async () => {
    setBusy(true); setError(null);
    try {
      setRevealed(await onRespond?.(a.id));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible transparent={false} animationType="slide" onRequestClose={onDismiss}>
      <View style={s.wrap}>
        <View style={s.head}>
          <Chip text="near you" tone={C.blue} icon="map-pin" />
          <Text style={[T.meta, { color: C.faint }]}>{fmtAgo(a.created_at)}</Text>
        </View>

        <Txt variant="h1">
          {KIND[a.kind] || 'An emergency'} was raised about{' '}
          {a.distance_m < 100 ? 'a hundred' : a.distance_m} metres away
        </Txt>

        {revealed ? (
          <>
            <Banner tone={C.green} icon="user-check" title="You said you are going">
              Their name and exact location are below. They have been told you are
              on the way, and so has their family.
            </Banner>

            <View style={s.detail}>
              <Label>Who</Label>
              <Txt variant="h2">{revealed.user?.name || 'Unknown'}</Txt>
              <Divider />
              <Label>Exact location</Label>
              <Text style={[T.number, { color: C.text }]}>
                {revealed.lat != null ? `${revealed.lat.toFixed(5)}, ${revealed.lon.toFixed(5)}` : 'not attached'}
              </Text>
              {revealed.accuracy ? (
                <Text style={[T.meta, { color: C.faint }]}>
                  accurate to about {Math.round(revealed.accuracy)} m
                </Text>
              ) : null}
            </View>

            {revealed.maps ? (
              <Button title="OPEN DIRECTIONS" filled tone={C.blue} icon="navigation"
                      onPress={() => Linking.openURL(revealed.maps)} />
            ) : null}
            <Button title="CLOSE" tone={C.dim} onPress={onDismiss} />
          </>
        ) : (
          <>
            <Text style={[T.body, { color: C.dim }]}>
              You are being asked because you are close, not because you know them.
              Nothing identifies the person until you say you are going — and if you
              say yes, they will see your name.
            </Text>

            <View style={s.detail}>
              <Label>Roughly where</Label>
              <Text style={[T.number, { color: C.text }]}>
                {a.lat.toFixed(3)}, {a.lon.toFixed(3)}
              </Text>
              <Text style={[T.meta, { color: C.faint }]}>
                Snapped to a 300 m grid until you respond.
              </Text>
            </View>

            {a.maps ? (
              <Button title="SEE THE AREA" tone={C.blue} icon="map"
                      onPress={() => Linking.openURL(a.maps)} />
            ) : null}

            {error ? (
              <View style={s.errRow}>
                <Icon name="alert-circle" size={15} color={C.red} />
                <Text style={[T.meta, { color: C.red, flex: 1 }]}>{error}</Text>
              </View>
            ) : null}

            <View style={s.actions}>
              <Button title="I'M GOING" filled big tone={C.green} icon="navigation"
                      loading={busy} onPress={go} />
              <Button title="I CAN'T HELP" tone={C.dim} onPress={onDismiss} />
            </View>
          </>
        )}
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: C.bg, padding: S.xl, gap: S.lg, justifyContent: 'center' },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  detail: { backgroundColor: C.surface, borderRadius: 8, padding: S.lg, gap: S.sm },
  errRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  actions: { gap: S.md, marginTop: S.sm },
});
