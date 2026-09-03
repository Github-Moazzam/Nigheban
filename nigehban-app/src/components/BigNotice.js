import React, { useEffect } from 'react';
import { Modal, Pressable, StyleSheet, Text, View, Vibration } from 'react-native';
import { S, T } from '../theme';
import { RU, U } from '../screens/user/kit';
import { Icon, Txt } from '../ui';

/**
 * The news that is not an emergency but is still the answer somebody has been
 * waiting for: your check-in was answered, a responder is on the way, an alert
 * was stood down.
 *
 * All of it used to be a toast pinned above the tab bar for four and a half
 * seconds. That is the wrong size for it. A toast is for confirming what you
 * just did; every one of these arrives unprompted, about a person, while the
 * phone is in a pocket -- and the one thing they have in common is that
 * missing one means not knowing whether somebody is alright.
 *
 * So they take the screen instead, and stay until they are dismissed. Not a
 * siren and not a takeover: those belong to a live emergency, and using them
 * for good news is how a family learns to swipe the loud thing away.
 *
 * One at a time. `App.js` holds the queue and hands over the next one only
 * after this closes, because two of these stacked is two Modals racing on
 * Android and the loser never appears at all.
 */
export default function BigNotice({ notice, onClose }) {
  // A short double buzz, and only for the ones that answer a question the
  // person actually asked. It is deliberately not the SOS pattern.
  useEffect(() => {
    if (!notice || notice.quiet) return;
    try { Vibration.vibrate([0, 120, 90, 120]); } catch { /* no motor */ }
  }, [notice]);

  if (!notice) return null;

  const tone = notice.tone || U.mint;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={s.wrap}>
        <Pressable style={s.backdrop} onPress={onClose} accessibilityLabel="Close" />

        <View style={s.card} accessibilityViewIsModal accessibilityLiveRegion="assertive">
          <View style={[s.mark, { backgroundColor: soft(tone) }]}>
            <Icon name={notice.icon || 'info'} size={26} color={tone} />
          </View>

          <Txt variant="h1" color={U.text} style={s.title}>{notice.title}</Txt>

          {notice.body ? (
            <Text style={[T.body, s.body]}>{notice.body}</Text>
          ) : null}

          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={notice.action || 'Got it'}
            style={({ pressed }) => [
              s.btn, { backgroundColor: tone }, pressed && { opacity: 0.75 },
            ]}
          >
            <Icon name="check" size={16} color={U.bg} />
            <Text style={[T.button, { color: U.bg }]}>{notice.action || 'Got it'}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function soft(tone) {
  if (tone === U.red) return U.redSoft;
  if (tone === U.amber) return U.amberSoft;
  return U.mintSoft;
}

const s = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: S.lg },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: U.scrim },
  card: {
    width: '100%', maxWidth: 420, backgroundColor: U.card, borderRadius: RU.card,
    padding: S.xl, gap: S.md, alignItems: 'center',
  },
  mark: {
    width: 60, height: 60, borderRadius: RU.pill,
    alignItems: 'center', justifyContent: 'center',
  },
  title: { textAlign: 'center' },
  body: { color: U.dim, textAlign: 'center' },
  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: S.sm, alignSelf: 'stretch', minHeight: 48, borderRadius: RU.inner,
    marginTop: S.xs,
  },
});
