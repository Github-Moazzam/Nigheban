import React, { useEffect, useRef, useState } from 'react';
import { Modal, StyleSheet, Text, Vibration, View } from 'react-native';
import { C, S, T } from '../theme';
import { Button, Icon, ProgressBar, Txt } from '../ui';

/** Severity 4 gets thirty seconds; a severity-5 fall gets fifteen. */
export const FALL_WINDOW_S = { 4: 30, 5: 15 };

/**
 * U3.3 — what happens between a fall being detected and the family being told.
 *
 * A fall detector with no countdown is a false-alarm machine: the wearer sits
 * down hard, the phone tells four people she has collapsed, and by the third
 * time nobody believes it. The countdown is what buys the alert its
 * credibility -- an alert that survives this screen is one nobody cancelled.
 *
 * So the screen is loud, it is unmissable, and the way out is a single 76pt
 * button. It vibrates on every second of the last five, because it may be
 * face-down on a pavement.
 */
export default function FallCountdown({ fall, onCancel, onEscalate }) {
  const total = FALL_WINDOW_S[fall?.severity] ?? 30;
  const [left, setLeft] = useState(total);
  const fired = useRef(false);

  useEffect(() => {
    if (!fall) return undefined;
    fired.current = false;
    const endsAt = fall.endsAt || Date.now() + total * 1000;

    const tick = () => {
      const rem = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
      setLeft(rem);
      if (rem <= 5 && rem > 0) Vibration.vibrate(120);
      if (rem === 0 && !fired.current) { fired.current = true; onEscalate?.(); }
    };

    tick();
    const id = setInterval(tick, 1000);
    Vibration.vibrate([0, 400, 200, 400]);
    return () => { clearInterval(id); Vibration.cancel(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fall]);

  if (!fall) return null;

  return (
    <Modal visible animationType="fade" onRequestClose={onCancel}>
      <View style={s.wrap}>
        <View style={s.badge}>
          <Icon name="alert-triangle" size={18} color={C.amber} />
          <Text style={[T.label, { color: C.amber }]}>FALL DETECTED</Text>
        </View>

        <Txt variant="display" color={C.text} style={s.count}>{left}</Txt>
        <Text style={[T.body, s.lede]}>
          Telling your family in {left} second{left === 1 ? '' : 's'}
          {fall.note ? ` · ${fall.note}` : ''}
        </Text>

        <View style={s.bar}>
          <ProgressBar value={left / total} tone={left <= 10 ? C.red : C.amber} height={6} />
        </View>

        <View style={s.actions}>
          <Button title="I'M FINE — CANCEL" big filled tone={C.green}
                  icon="check" onPress={onCancel}
                  accessibilityLabel="I am fine, cancel this alert" />
          <Button title="I NEED HELP NOW" tone={C.red} icon="phone-call"
                  onPress={() => { Vibration.cancel(); onEscalate?.(); }} />
        </View>

        <Text style={[T.meta, s.foot]}>
          Cancelling keeps a private note that you nearly fell. Nobody is told.
        </Text>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  wrap: {
    flex: 1, backgroundColor: C.bg, padding: S.xl,
    alignItems: 'center', justifyContent: 'center', gap: S.md,
  },
  badge: {
    flexDirection: 'row', alignItems: 'center', gap: S.sm,
    backgroundColor: C.amberSoft, paddingHorizontal: S.md, paddingVertical: S.sm,
    borderRadius: 4,
  },
  count: { fontSize: 96, lineHeight: 104, color: C.text, fontVariant: ['tabular-nums'] },
  lede: { color: C.dim, textAlign: 'center' },
  bar: { alignSelf: 'stretch', marginVertical: S.lg },
  actions: { alignSelf: 'stretch', gap: S.md },
  foot: { color: C.faint, textAlign: 'center', marginTop: S.md },
});
