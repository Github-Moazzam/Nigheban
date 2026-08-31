import React, { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, Vibration, View } from 'react-native';
import { FALL_WINDOW_S } from '../../components/FallCountdown';
import { hasPin, verifyPin } from '../../security';
import { S, T } from '../../theme';
import { Icon, Txt } from '../../ui';
import { RU, U } from './kit';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'lock', '0', 'del'];

/**
 * What a fall looks like on the end user's phone.
 *
 * The admin build shows a countdown with an "I'M FINE" button, which is right
 * for a console. It is wrong here: the whole point of the countdown is that
 * the alert survives it, and a single button is exactly what a phone cancels
 * by itself in a pocket, or what somebody else cancels after taking it off
 * you. Four digits is the smallest gate that a stranger cannot pass and the
 * wearer can pass one-handed.
 *
 * Nothing on this screen delays dispatch. The timer keeps running while the
 * PIN is being typed, and dispatch is one tap away for the whole window.
 */
export default function DisarmPad({ fall, onCancel, onEscalate }) {
  const total = FALL_WINDOW_S[fall?.severity] ?? 30;
  const [left, setLeft] = useState(total);
  const [entry, setEntry] = useState('');
  const [error, setError] = useState(null);
  const [pinSet, setPinSet] = useState(true);
  const fired = useRef(false);

  useEffect(() => { hasPin().then(setPinSet); }, [fall]);

  useEffect(() => {
    if (!fall) return undefined;
    fired.current = false;
    setEntry('');
    setError(null);
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

  const commit = async (pin) => {
    if (await verifyPin(pin)) {
      Vibration.cancel();
      onCancel?.();
      return;
    }
    Vibration.vibrate(60);
    setEntry('');
    setError('Wrong PIN.');
  };

  const press = (k) => {
    if (k === 'lock') return;
    setError(null);
    if (k === 'del') { setEntry((e) => e.slice(0, -1)); return; }
    if (entry.length >= 4) return;
    const next = entry + k;
    setEntry(next);
    if (next.length === 4) setTimeout(() => commit(next), 90);
  };

  const dispatch = () => { Vibration.cancel(); onEscalate?.(); };

  return (
    <Modal visible animationType="fade" onRequestClose={dispatch}>
      <View style={s.wrap}>
        <View style={s.badge}>
          <Icon name="alert-triangle" size={14} color={U.red} />
          <Text style={[T.label, { color: U.red }]}>
            SOS DISPATCH IN {left}S
          </Text>
        </View>

        <Txt variant="h1" color={U.text} style={s.title}>Enter PIN to disarm</Txt>
        <Text style={[T.meta, s.lede]}>
          {pinSet
            ? 'Enter your 4-digit safety code'
            : 'No PIN set — enter any 4 digits to cancel'}
        </Text>

        <View style={s.dots}>
          {[0, 1, 2, 3].map((i) => (
            <View
              key={i}
              style={[
                s.dot,
                i < entry.length && { backgroundColor: U.text, borderColor: U.text },
              ]}
            />
          ))}
        </View>

        <Text style={[T.meta, s.err]}>{error || ' '}</Text>

        <View style={s.pad}>
          {KEYS.map((k) => (
            <Pressable
              key={k}
              disabled={k === 'lock'}
              onPress={() => press(k)}
              accessibilityRole={k === 'lock' ? undefined : 'button'}
              accessibilityLabel={k === 'del' ? 'Delete' : k === 'lock' ? undefined : k}
              style={({ pressed }) => [
                s.key,
                k === 'lock' && s.keyMuted,
                pressed && k !== 'lock' && { backgroundColor: U.line },
              ]}
            >
              {k === 'del' ? (
                <Icon name="delete" size={20} color={U.dim} />
              ) : k === 'lock' ? (
                <Icon name="lock" size={18} color={U.line} />
              ) : (
                <Text style={s.keyText}>{k}</Text>
              )}
            </Pressable>
          ))}
        </View>

        <Pressable
          onPress={dispatch}
          accessibilityRole="button"
          accessibilityLabel="Send the emergency now"
          style={({ pressed }) => [s.dispatch, pressed && { opacity: 0.75 }]}
        >
          <Icon name="phone-call" size={16} color={U.red} />
          <Text style={[T.button, { color: U.red }]}>Send emergency now</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  wrap: {
    flex: 1, backgroundColor: U.bg, padding: S.xl,
    alignItems: 'center', justifyContent: 'center',
  },
  badge: {
    flexDirection: 'row', alignItems: 'center', gap: S.sm,
    backgroundColor: U.redSoft, paddingHorizontal: S.md, paddingVertical: S.sm,
    borderRadius: RU.pill, marginBottom: S.xl,
  },
  title: { textAlign: 'center' },
  lede: { color: U.dim, textAlign: 'center', marginTop: 4 },

  dots: { flexDirection: 'row', gap: S.lg, marginTop: S.xl },
  dot: {
    width: 15, height: 15, borderRadius: 8,
    borderWidth: 1.5, borderColor: U.line,
  },
  err: { color: U.red, marginTop: S.md, minHeight: 19 },

  pad: {
    flexDirection: 'row', flexWrap: 'wrap',
    width: 252, gap: S.md, justifyContent: 'center', marginTop: S.sm,
  },
  key: {
    width: 68, height: 68, borderRadius: 34, backgroundColor: U.card,
    alignItems: 'center', justifyContent: 'center',
  },
  keyMuted: { backgroundColor: 'transparent' },
  keyText: { ...T.h1, color: U.text, fontSize: 24 },

  dispatch: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: S.sm,
    alignSelf: 'stretch', minHeight: 52, borderRadius: RU.inner,
    backgroundColor: U.redSoft, marginTop: S.xxl,
  },
});
