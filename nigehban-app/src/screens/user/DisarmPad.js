import React, { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, Vibration, View } from 'react-native';
import { FALL_WINDOW_S } from '../../components/FallCountdown';
import { S, T } from '../../theme';
import { Icon, ProgressBar, Txt } from '../../ui';
import { RU, U } from './kit';

/** How long "I'M FINE" has to be held. See THE PIN IS GONE below. */
const HOLD_MS = 1500;
const HOLD_TICK_MS = 50;

/**
 * What a fall or an accident looks like on the end user's phone.
 *
 * The admin build shows a countdown with a plain "I'M FINE" button, which is
 * right for a console being demonstrated. This is the wearer's phone, and the
 * thing it has to survive is being in a pocket against a body that is not
 * moving on purpose.
 *
 * Nothing on this screen delays dispatch. The timer keeps running while
 * anything is being pressed, and "send emergency now" is one tap away for the
 * whole window.
 *
 * ---------------------------------------------------------------------------
 * THE PIN IS GONE, AND WHY
 *
 * This screen used to be a four-digit PIN pad. The reasoning was sound for the
 * threat it was written against -- a phone that cancels its own alert in a
 * pocket, or somebody else cancelling it after taking it off you -- and it was
 * the wrong answer for the event that actually reaches this screen.
 *
 * Only a fall or an accident renders this. In both, the person being asked to
 * type four digits has just hit the ground. They may be elderly. They may be
 * face down, one-handed, without their glasses, shaken, in the dark, in the
 * rain. And the penalty for not managing it in forty-five seconds is not a
 * locked phone -- it is a false emergency sent to everybody who cares about
 * them, which is the exact outcome the countdown exists to prevent. **Asking
 * somebody who has just fallen to remember a passcode is asking for the false
 * alarm.**
 *
 * The PIN had also stopped being a gate. The band's single tap answers this
 * question directly (see CHECKIN_CLOSED in App.js), so anyone holding the band
 * could already cancel with one press while the screen demanded a code from
 * the wearer. A control that the primary input path walks straight past is not
 * security, it is an obstacle in front of the one person it was meant to help.
 *
 * ---- what replaces it: a HOLD ----------------------------------------------
 *
 * A press-and-hold of 1.5 s answers the real threat -- a pocket, a sleeve, a
 * body lying on the screen -- because sustained deliberate contact is the one
 * thing incidental pressure does not produce. It needs no memory, no reading,
 * no accuracy, and it works with one hand and with the phone upside down.
 *
 * What is given up, said plainly: somebody who has taken the phone off an
 * injured person can now cancel the countdown by holding a button, where before
 * they needed a code. That is a real loss and it is accepted, because the band
 * tap already made it true, and because the case it protects is far rarer than
 * the case it was breaking. Duress belongs to anti-snatch (v2), which has its
 * own gesture and its own affordance; it does not belong bolted onto a fall.
 */
export default function DisarmPad({ fall, onCancel, onEscalate, onExpire }) {
  // `fall.window` is the server's real deadline; the table is only the fallback
  // for an incident detected with no signal. See FallCountdown.
  const total = fall?.window ?? FALL_WINDOW_S[fall?.severity] ?? 30;
  const [left, setLeft] = useState(total);
  const [held, setHeld] = useState(0);        // 0..1 through the hold
  const fired = useRef(false);
  const holdTimer = useRef(null);
  const accident = fall?.reason === 'accident';

  useEffect(() => {
    if (!fall) return undefined;
    fired.current = false;
    setHeld(0);
    const endsAt = fall.endsAt || Date.now() + total * 1000;

    const tick = () => {
      const rem = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
      setLeft(rem);
      if (rem <= 5 && rem > 0) Vibration.vibrate(120);
      // Running out and pressing DISPATCH are opposite events and no longer
      // share a handler. When the server holds the deadline this phone must do
      // nothing at all as it passes -- the sweeper raises the alert, and a
      // second one from here would page the family twice for one fall.
      if (rem === 0 && !fired.current) { fired.current = true; onExpire?.(); }
    };

    tick();
    const id = setInterval(tick, 1000);
    Vibration.vibrate([0, 400, 200, 400]);
    return () => { clearInterval(id); Vibration.cancel(); };
    // Keyed on the deadline too: the server's `due_at` replaces the phone's
    // provisional one a moment after this mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fall, fall?.endsAt]);

  // Never leave a hold running into an unmount, or a finger down as the modal
  // closes would fire onCancel over an incident that is already resolved.
  useEffect(() => () => clearInterval(holdTimer.current), []);

  if (!fall) return null;

  const startHold = () => {
    clearInterval(holdTimer.current);
    const from = Date.now();
    holdTimer.current = setInterval(() => {
      const p = Math.min(1, (Date.now() - from) / HOLD_MS);
      setHeld(p);
      if (p < 1) return;
      clearInterval(holdTimer.current);
      Vibration.cancel();
      onCancel?.();
    }, HOLD_TICK_MS);
  };

  const endHold = () => {
    clearInterval(holdTimer.current);
    setHeld(0);
  };

  const dispatch = () => { Vibration.cancel(); onEscalate?.(); };

  return (
    <Modal visible animationType="fade" onRequestClose={dispatch}>
      <View style={s.wrap}>
        <View style={s.badge}>
          <Icon name="alert-triangle" size={14} color={U.red} />
          {/* Named for what was detected. "SOS DISPATCH" over a fall reads as
              the phone having decided something the wearer never asked for. */}
          <Text style={[T.label, { color: U.red }]}>
            {accident ? 'POSSIBLE ACCIDENT' : 'FALL DETECTED'} · {left}S
          </Text>
        </View>

        <Txt variant="h1" color={U.text} style={s.title}>Are you okay?</Txt>
        <Text style={[T.meta, s.lede]}>
          Telling your family in {left} second{left === 1 ? '' : 's'}
        </Text>

        {/* The band first, because it is the one the wearer can reach.
            Somebody on the ground has the band on their wrist and the phone
            wherever it landed -- and one press of a button they are already
            wearing beats anything on a screen they may not be holding. */}
        <View style={s.bandHint}>
          <Icon name="watch" size={15} color={U.dim} />
          <Text style={[T.meta, { color: U.dim, flexShrink: 1 }]}>
            Press your band button once to say you are fine
          </Text>
        </View>

        <Pressable
          onPressIn={startHold}
          onPressOut={endHold}
          accessibilityRole="button"
          accessibilityLabel="Hold to say you are fine and cancel this alert"
          style={({ pressed }) => [s.fine, pressed && { backgroundColor: U.mintSoft }]}
        >
          <Icon name="check" size={20} color={U.mint} />
          <Text style={[T.button, { color: U.mint }]}>
            {held > 0 ? 'KEEP HOLDING…' : "HOLD TO SAY I'M FINE"}
          </Text>
        </Pressable>

        {/* Shows what the hold is doing. Without it a partial press reads as a
            button that did not work, and the wearer taps it repeatedly. */}
        <View style={s.holdBar}>
          <ProgressBar value={held} tone={U.mint} height={6} />
        </View>

        <Text style={[T.meta, s.why]}>
          Held for a moment, not tapped — so a pocket cannot answer for you.
        </Text>

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

  bandHint: {
    flexDirection: 'row', alignItems: 'center', gap: S.sm,
    alignSelf: 'stretch', justifyContent: 'center',
    marginTop: S.xl, paddingHorizontal: S.md,
  },

  fine: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: S.sm,
    alignSelf: 'stretch', minHeight: 76, borderRadius: RU.inner,
    backgroundColor: U.card, borderWidth: 1, borderColor: U.mint,
    marginTop: S.md,
  },
  holdBar: { alignSelf: 'stretch', marginTop: S.md },
  why: { color: U.dim, textAlign: 'center', marginTop: S.sm },

  dispatch: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: S.sm,
    alignSelf: 'stretch', minHeight: 52, borderRadius: RU.inner,
    backgroundColor: U.redSoft, marginTop: S.xxl,
  },
});
