import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator, Modal, Pressable, StyleSheet, Text, Vibration, View,
} from 'react-native';
import { pinLockoutLeft, setPin, verifyPin } from '../security';
import { C, R, S, T } from '../theme';
import { Icon, Txt } from '../ui';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];

/**
 * The four-digit gate in front of disarming High Alert.
 *
 * Its own keypad rather than a secure TextInput, for one reason: the system
 * keyboard covers the bottom half of the screen, and the bottom half of this
 * screen is where "cancel" lives. A person being coerced needs the exit to
 * stay visible.
 *
 * `mode="set"` asks twice and stores it; `mode="verify"` checks it and gives
 * three attempts before it makes you wait, which is enough friction to make
 * guessing pointless and not enough to lock out the owner.
 *
 * One PIN, more than one gate: it also stands in front of removing somebody
 * from the family list, which is the other way to make this phone stop calling
 * for help. So the wording of the refusal is a prop -- "High Alert stays on"
 * is a lie on the family screen, and a gate that lies about what it just
 * refused is worse than no gate at all.
 */
export default function PinSheet({
  visible, mode = 'verify', title, body, lockedNote, wrongNote = 'Wrong PIN.',
  onCancel, onDone,
}) {
  const [entry, setEntry] = useState('');
  const [first, setFirst] = useState(null);      // 'set' mode: the first pass
  const [error, setError] = useState(null);
  // Milliseconds the gate is shut for, counted down while the sheet is open.
  //
  // This used to be a local `tries` counter that reset every time the sheet
  // closed -- three guesses, close, three more, forever, against four digits.
  // The count now lives in security.js and survives, so this is only the
  // display of somebody else's decision.
  const [lockedFor, setLockedFor] = useState(0);
  // The PIN lives in the keystore, and reading it is not instant on every
  // phone. Without this the fourth dot fills and the sheet simply sits there,
  // which on the screen that stands between somebody and disarming an alarm
  // is the worst possible moment to look broken.
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!visible) {
      setEntry(''); setFirst(null); setError(null); setChecking(false);
      return;
    }
    // Opening the sheet does not clear a lockout -- it reports one. Ask on the
    // way in, or a shut gate would look open until the first wrong guess.
    let dead = false;
    pinLockoutLeft().then((ms) => { if (!dead) setLockedFor(ms); }).catch(() => {});
    // eslint-disable-next-line consistent-return
    return () => { dead = true; };
  }, [visible]);

  // Tick it down so the wait is visibly finite. A locked keypad with no number
  // on it is indistinguishable from a broken one, and this sheet stands between
  // somebody and switching off their own alarm.
  useEffect(() => {
    if (!visible || lockedFor <= 0) return undefined;
    const id = setInterval(() => {
      setLockedFor((ms) => (ms <= 1000 ? 0 : ms - 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [visible, lockedFor]);

  const locked = lockedFor > 0;

  const commit = async (pin) => {
    if (mode === 'set') {
      if (first === null) { setFirst(pin); setEntry(''); setError(null); return; }
      if (first !== pin) {
        Vibration.vibrate(60);
        setFirst(null); setEntry(''); setError('Those did not match. Start again.');
        return;
      }
      await setPin(pin);
      onDone?.(pin);
      return;
    }

    const { ok, lockedFor: shut } = await verifyPin(pin);
    if (ok) { onDone?.(pin); return; }
    Vibration.vibrate(60);
    setEntry('');
    if (shut > 0) {
      setLockedFor(shut);
      setError(lockedNote || 'Too many attempts. High Alert stays on.');
      return;
    }
    setError(wrongNote);
  };

  const press = (k) => {
    if (locked || checking) return;
    setError(null);
    if (k === 'del') { setEntry((e) => e.slice(0, -1)); return; }
    if (!k || entry.length >= 4) return;
    const next = entry + k;
    setEntry(next);
    if (next.length === 4) {
      setChecking(true);
      setTimeout(async () => {
        try { await commit(next); } finally { setChecking(false); }
      }, 90);
    }
  };

  // A caller's title names the first question. The second pass of `set` is a
  // different question -- type it again -- and it has to win, or the sheet
  // asks "choose a PIN" twice and the second one looks like the first failing.
  const heading = (mode === 'set' && first !== null)
    ? 'Enter it once more'
    : (title || (mode === 'set' ? 'Choose a disarm PIN' : 'Enter your PIN to disarm'));

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <View style={s.wrap}>
        <Pressable style={s.backdrop} onPress={onCancel} accessibilityLabel="Close" />
        <View style={s.sheet}>
          <View style={s.grab} />
          <Txt variant="h1" style={{ textAlign: 'center' }}>{heading}</Txt>
          <Text style={[T.meta, s.body]}>
            {body || (mode === 'set'
              ? 'Arming never asks for it. Only switching High Alert off does.'
              : 'High Alert stays on until this is right.')}
          </Text>

          <View style={s.dots}>
            {[0, 1, 2, 3].map((i) => (
              <View key={i}
                    style={[s.dot, i < entry.length && { backgroundColor: C.green }]} />
            ))}
          </View>

          {checking ? (
            <View style={s.errRow}>
              <ActivityIndicator size="small" color={C.green} />
              <Text style={[T.meta, { color: C.dim }]}>
                {mode === 'set' ? 'Saving…' : 'Checking…'}
              </Text>
            </View>
          ) : locked ? (
            <View style={s.errRow}>
              <Icon name="clock" size={14} color={C.red} />
              <Text style={[T.meta, { color: C.red }]}>
                {(error ? error + ' ' : '')}
                {`Try again in ${lockedFor >= 60000
                  ? `${Math.ceil(lockedFor / 60000)} min`
                  : `${Math.ceil(lockedFor / 1000)}s`}.`}
              </Text>
            </View>
          ) : error ? (
            <View style={s.errRow}>
              <Icon name="alert-circle" size={14} color={C.red} />
              <Text style={[T.meta, { color: C.red }]}>{error}</Text>
            </View>
          ) : null}

          <View style={s.pad}>
            {KEYS.map((k, i) => (
              <Pressable
                key={i}
                disabled={!k || locked || checking}
                onPress={() => press(k)}
                accessibilityRole="button"
                accessibilityLabel={k === 'del' ? 'Delete' : k || undefined}
                style={({ pressed }) => [
                  s.key,
                  !k && { backgroundColor: 'transparent' },
                  pressed && k && !locked && !checking && { backgroundColor: C.line },
                  (locked || checking) && k && { opacity: 0.4 },
                ]}
              >
                {k === 'del'
                  ? <Icon name="delete" size={20} color={C.dim} />
                  : <Text style={s.keyText}>{k}</Text>}
              </Pressable>
            ))}
          </View>

          <Pressable onPress={onCancel} style={s.cancel} accessibilityRole="button">
            <Text style={[T.button, { color: C.dim }]}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: C.scrim },
  sheet: {
    backgroundColor: C.surface,
    borderTopLeftRadius: R.sheet, borderTopRightRadius: R.sheet,
    padding: S.xl, paddingBottom: S.xxl, gap: S.md, alignItems: 'center',
  },
  grab: { width: 36, height: 4, borderRadius: 2, backgroundColor: C.line, marginBottom: S.sm },
  body: { color: C.dim, textAlign: 'center', paddingHorizontal: S.sm },
  dots: { flexDirection: 'row', gap: S.md, marginVertical: S.md },
  dot: { width: 13, height: 13, borderRadius: 7, backgroundColor: C.raised },
  errRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pad: { flexDirection: 'row', flexWrap: 'wrap', width: 264, gap: S.sm, justifyContent: 'center' },
  key: {
    width: 80, height: 60, borderRadius: R.control, backgroundColor: C.raised,
    alignItems: 'center', justifyContent: 'center',
  },
  keyText: { ...T.h1, color: C.text, fontSize: 22 },
  cancel: { minHeight: 48, justifyContent: 'center', paddingHorizontal: S.xl, marginTop: 2 },
});
