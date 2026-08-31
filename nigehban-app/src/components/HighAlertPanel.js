import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { hasPin } from '../security';
import { C, S, T } from '../theme';
import { Button, Card, Chip, Icon, Txt } from '../ui';
import PinSheet from './PinSheet';

/**
 * U3.2 — High Alert: arm freely, disarm deliberately.
 *
 * Arming is one tap and never asks for anything. Disarming asks for the PIN
 * (matrix #16), because the whole mode is built for the case where somebody
 * else may end up holding the phone. That asymmetry is the feature.
 *
 * The next-buzz time is the server's `next_buzz_at`, rendered as an
 * approximation on purpose. The interval is randomised between five and ten
 * minutes precisely so that it cannot be timed and planned around; printing a
 * second-accurate countdown would hand that back.
 */
export default function HighAlertPanel({ isArmed = false, nextBuzzAt = null, onToggle, style }) {
  const [busy, setBusy] = useState(false);
  const [pinMode, setPinMode] = useState(null);      // null | 'verify' | 'set'
  const [pinSet, setPinSet] = useState(true);
  const [, force] = useState(0);

  useEffect(() => { hasPin().then(setPinSet).catch(() => setPinSet(false)); }, [pinMode]);

  // One tick a minute is enough for a value printed to the minute.
  useEffect(() => {
    if (!isArmed || !nextBuzzAt) return undefined;
    const id = setInterval(() => force((n) => n + 1), 20000);
    return () => clearInterval(id);
  }, [isArmed, nextBuzzAt]);

  const apply = useCallback(async (on) => {
    if (!onToggle || busy) return;
    setBusy(true);
    try { await onToggle(on); } finally { setBusy(false); }
  }, [onToggle, busy]);

  const press = async () => {
    if (!isArmed) { apply(true); return; }
    if (await hasPin()) { setPinMode('verify'); return; }
    apply(false);                                   // nothing set: do not lock her out
  };

  const mins = nextBuzzAt
    ? Math.max(0, Math.ceil((nextBuzzAt - Date.now() / 1000) / 60))
    : null;

  return (
    <>
      <Card tone={isArmed ? C.green : undefined} style={[{ gap: S.md }, style]}>
        <View style={s.head}>
          <View style={[s.mark, { backgroundColor: isArmed ? C.green : C.raised }]}>
            <Icon name="shield" size={18} color={isArmed ? C.bg : C.dim} />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Txt variant="h2">High Alert</Txt>
            <Text style={[T.meta, { color: C.dim }]}>
              {isArmed
                ? 'The server checks on you every five to ten minutes'
                : 'For the walk home, or any route you want watched'}
            </Text>
          </View>
          <Chip text={isArmed ? 'armed' : 'off'} tone={isArmed ? C.green : C.faint} />
        </View>

        {isArmed ? (
          <View style={s.nextRow}>
            <Icon name="clock" size={14} color={C.dim} />
            <Text style={[T.meta, { color: C.dim, flex: 1 }]}>
              {mins == null ? 'First check-in is being scheduled'
                : mins <= 1 ? 'Next check-in due about now'
                : `Next check-in in about ${mins} minutes`}
            </Text>
          </View>
        ) : null}

        <Button
          title={isArmed ? 'DISARM' : 'ARM HIGH ALERT'}
          icon={isArmed ? 'unlock' : 'shield'}
          filled={!isArmed}
          tone={isArmed ? C.dim : C.green}
          loading={busy}
          onPress={press}
        />

        {isArmed && !pinSet ? (
          <Pressable onPress={() => setPinMode('set')} style={s.pinCta}
                     accessibilityRole="button">
            <Icon name="lock" size={14} color={C.amber} />
            <Text style={[T.meta, { color: C.amber, flex: 1 }]}>
              Set a disarm PIN, so this cannot be switched off by whoever is holding your phone.
            </Text>
          </Pressable>
        ) : null}

        {isArmed ? (
          <Text style={[T.meta, { color: C.faint }]}>
            Miss one of these and your family is told — even if this app has been
            closed since you armed it.
          </Text>
        ) : null}
      </Card>

      <PinSheet
        visible={pinMode !== null}
        mode={pinMode === 'set' ? 'set' : 'verify'}
        onCancel={() => setPinMode(null)}
        onDone={() => {
          const wasVerify = pinMode === 'verify';
          setPinMode(null);
          if (wasVerify) apply(false);
        }}
      />
    </>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: S.md },
  mark: {
    width: 40, height: 40, borderRadius: 6,
    alignItems: 'center', justifyContent: 'center',
  },
  nextRow: { flexDirection: 'row', alignItems: 'center', gap: S.sm },
  pinCta: {
    flexDirection: 'row', alignItems: 'flex-start', gap: S.sm,
    backgroundColor: C.amberSoft, padding: S.md, borderRadius: 6,
  },
});
