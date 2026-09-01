import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { S, T } from '../../theme';
import { Icon, Txt } from '../../ui';
import { RU, U } from './kit';

/**
 * The popup this shell uses instead of Alert.alert.
 *
 * Two reasons it exists. The first is that the system dialog is a different
 * app on the screen -- system font, system blue, no icon, and buttons that are
 * words in a row -- which on the one screen where somebody is deciding whether
 * to break a safety link is exactly the wrong moment to look like a different
 * product.
 *
 * The second is the one that actually matters: `Alert.alert` cannot show that
 * it is working. Every button on it is a plain callback, so a press that goes
 * to the server leaves the dialog sitting there looking untouched, and the
 * second press is a second request. Every action here can return a promise;
 * while it is running that button carries a spinner and its own wording, and
 * the rest of the dialog -- including the backdrop -- stops responding.
 *
 *   actions: [{ label, busyLabel, icon, tone, filled, danger, onPress }]
 *
 * `loading` is the other half: a stage that has no buttons at all, for the
 * moment between one popup and the next.
 */
export default function Dialog({
  visible, tone = U.mint, icon = 'info', title, body, points, note,
  loading = false, loadingLabel, actions = [], onClose,
}) {
  const [pending, setPending] = useState(null);
  const alive = useRef(true);

  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => { if (!visible) setPending(null); }, [visible]);

  // Nothing on this dialog responds while one of its own buttons is mid-flight
  // -- not the other buttons, not the backdrop, not the Android back gesture.
  // Half of these actions are not undoable, and a dialog that can be dismissed
  // out from under its own request is how you end up with a link removed and
  // no screen that ever said so.
  const busy = loading || pending !== null;
  const close = () => { if (!busy) onClose?.(); };

  const run = async (i, fn) => {
    if (busy) return;
    setPending(i);
    try { await fn?.(); } finally { if (alive.current) setPending(null); }
  };

  return (
    <Modal visible={!!visible} transparent animationType="fade" onRequestClose={close}>
      <View style={s.wrap}>
        <Pressable
          style={s.backdrop}
          onPress={close}
          disabled={busy}
          accessibilityLabel="Close"
        />

        <View style={s.card} accessibilityViewIsModal accessibilityLiveRegion="polite">
          <View style={[s.mark, { backgroundColor: soft(tone) }]}>
            {loading
              ? <ActivityIndicator size="small" color={tone} />
              : <Icon name={icon} size={22} color={tone} />}
          </View>

          <Txt variant="h1" color={U.text} style={s.title}>
            {loading ? (loadingLabel || title) : title}
          </Txt>

          {/* Everything between the title and the buttons scrolls as one. The
              buttons never do: a popup that can push its own actions off the
              bottom of a small phone is a popup with no way out of it. */}
          {body || points?.length || note ? (
            <ScrollView
              style={s.scroll}
              contentContainerStyle={s.scrollBody}
              showsVerticalScrollIndicator={false}
            >
              {body ? <Text style={[T.body, s.body]}>{body}</Text> : null}

              {/* What the link actually does, said as three facts rather than
                  one paragraph. The only part anybody re-reads. */}
              {points?.length ? (
                <View style={s.points}>
                  {points.map((p) => (
                    <View key={p} style={s.point}>
                      <Icon name="check" size={13} color={tone} style={{ marginTop: 2 }} />
                      <Text style={[T.meta, { color: U.dim, flex: 1 }]}>{p}</Text>
                    </View>
                  ))}
                </View>
              ) : null}

              {note ? (
                <View style={[s.note, { backgroundColor: soft(tone) }]}>
                  <Icon name="info" size={13} color={tone} style={{ marginTop: 1 }} />
                  <Text style={[T.meta, { color: U.dim, flex: 1 }]}>{note}</Text>
                </View>
              ) : null}
            </ScrollView>
          ) : null}

          {loading ? null : (
            <View style={s.actions}>
              {actions.map((a, i) => {
                const on = pending === i;
                const fg = a.filled ? U.bg : (a.tone || U.dim);
                return (
                  <Pressable
                    key={a.label}
                    onPress={() => run(i, a.onPress)}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel={a.label}
                    accessibilityState={{ busy: on, disabled: busy && !on }}
                    style={({ pressed }) => [
                      s.btn,
                      { backgroundColor: a.filled ? (a.tone || U.mint) : U.raised },
                      busy && !on && { opacity: 0.45 },
                      pressed && !busy && { opacity: 0.75 },
                    ]}
                  >
                    {on ? (
                      <ActivityIndicator size="small" color={fg} />
                    ) : a.icon ? (
                      <Icon name={a.icon} size={16} color={fg} />
                    ) : null}
                    <Text style={[T.button, { color: fg }]}>
                      {on ? (a.busyLabel || a.label) : a.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

/** The soft variants are named in the kit; this maps a tone onto its own. */
function soft(tone) {
  if (tone === U.red) return U.redSoft;
  if (tone === U.amber) return U.amberSoft;
  if (tone === U.mint) return U.mintSoft;
  return U.raised;
}

const s = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: S.lg },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: U.scrim },

  card: {
    width: '100%', maxWidth: 420, maxHeight: '85%',
    backgroundColor: U.card, borderRadius: RU.card,
    padding: S.xl, gap: S.md, alignItems: 'center',
  },
  mark: {
    width: 52, height: 52, borderRadius: RU.pill,
    alignItems: 'center', justifyContent: 'center',
  },
  title: { textAlign: 'center' },
  scroll: { alignSelf: 'stretch', flexGrow: 0, flexShrink: 1 },
  scrollBody: { gap: S.md },
  body: { color: U.dim, textAlign: 'center' },

  points: {
    alignSelf: 'stretch', gap: S.sm,
    backgroundColor: U.raised, borderRadius: RU.inner, padding: S.md,
  },
  point: { flexDirection: 'row', alignItems: 'flex-start', gap: S.sm },

  note: {
    alignSelf: 'stretch', flexDirection: 'row', alignItems: 'flex-start',
    gap: S.sm, borderRadius: RU.inner, padding: S.md,
  },

  actions: { alignSelf: 'stretch', gap: S.sm, marginTop: S.xs },
  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: S.sm, minHeight: 48, borderRadius: RU.inner, paddingHorizontal: S.md,
  },
});
