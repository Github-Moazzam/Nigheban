import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { C, S, T, fmtCount } from '../theme';
import { Button, Card, Chip, Label, ProgressBar } from '../ui';

/**
 * U3.1 — the open question, and how long is left to answer it.
 *
 * The countdown runs to `due_at`, which is the server's deadline in the
 * server's clock, sent with the request. It is not a local ninety-second timer
 * that happens to agree: the sweeper escalates on its own row in the database,
 * so a phone that woke up late has to show what is actually left, not what
 * would be left if the message had arrived on time.
 *
 * Shown after the ask-sheet is dismissed, so "later" never means "forgotten".
 */
export default function CheckinBanner({ checkin, onAck, style }) {
  const window = checkin?.window || 90;
  const dueAt = checkin?.due_at
    || (checkin?._startAt ? checkin._startAt + window : null);

  const [left, setLeft] = useState(() => remaining(dueAt, window));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!checkin) return undefined;
    const tick = () => setLeft(remaining(dueAt, window));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [checkin, dueAt, window]);

  if (!checkin) return null;

  const urgent = left <= 30;
  const tone = left === 0 ? C.red : urgent ? C.amber : C.green;

  const ack = async () => {
    if (busy) return;
    setBusy(true);
    try { await onAck?.(checkin); } finally { setBusy(false); }
  };

  return (
    <Card tone={tone} style={[{ gap: S.md }, style]}>
      <View style={s.head}>
        <View style={{ flex: 1, gap: 4 }}>
          <Label color={tone}>
            {checkin.system ? 'Nigehban is checking on you' : 'Check-in requested'}
          </Label>
          <Text style={[T.h2, { color: C.text }]}>
            {checkin.system
              ? 'High Alert — answer to stay clear'
              : `${checkin.name || 'Someone'} is asking if you are okay`}
          </Text>
        </View>
        <Chip text={left === 0 ? 'overdue' : fmtCount(left)} tone={tone} icon="clock" />
      </View>

      <ProgressBar value={window ? left / window : 0} tone={tone} />

      <Text style={[T.meta, { color: C.dim }]}>
        {left === 0
          ? 'Time is up — your family is being told.'
          : 'Answer here and it closes, even if you shut the app.'}
      </Text>

      <Button title="I AM FINE" filled tone={C.green} icon="check"
              loading={busy} onPress={ack} />
    </Card>
  );
}

function remaining(dueAt, window) {
  if (!dueAt) return window;
  return Math.max(0, Math.ceil(dueAt - Date.now() / 1000));
}

const s = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
