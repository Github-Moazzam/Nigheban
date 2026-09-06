import React, { useEffect, useState } from 'react';
import {
  Modal, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { useEdgeInsets } from '../../safeArea';
import { S, T, fmtAgo } from '../../theme';
import { Icon } from '../../ui';
import { RU, U } from './kit';
import { EventRow } from './alertKit';
import LiveMap from '../LiveMap';
import { fmtFullDay, initials, kindOf } from '../alertGroups';

/**
 * ONE PERSON, ONE DAY — everything that happened, in full.
 *
 * The list gives you four facts per card and one button. This is where the
 * rest of it lives, and it is a page rather than a drop-down for three
 * reasons a card could not satisfy:
 *
 *   1. It has the whole screen, so nothing is capped. The card used to stop at
 *      eight events and offer to show the rest; a day page that hides part of
 *      a safety record to save vertical space is not a record.
 *   2. The heading stays put. Who this is, which day, and whether anything is
 *      still live are pinned above the scroll rather than scrolling away — on
 *      a long day the flat list lost the name within one flick.
 *   3. Back means back. Expanding a card left the list scrolled somewhere new
 *      and the other cards shoved down the screen; closing a page puts you
 *      exactly where you were.
 *
 * It is deliberately not a route: this shell has no navigator, and a modal is
 * what every other full-screen view here already is (see LiveMap, AddFamily).
 * Android's back gesture is wired to `onRequestClose`, so it behaves like a
 * page even though it is not one.
 */
export default function AlertDay({
  visible, group, scope, session, busy,
  onClose, onAck, onStandDown, onSamaritan,
}) {
  const insets = useEdgeInsets();
  // The live map belongs to this page rather than to the list behind it: the
  // only button that opens it is on a row, and rows only exist here. Nesting
  // it inside this modal rather than parking it alongside is what the rest of
  // the shell already does (AddFamily carries its own Dialog the same way) --
  // two modals presented as siblings is the arrangement that goes wrong.
  const [liveMap, setLiveMap] = useState(null);
  // This component never unmounts, so a map left open when the page is closed
  // would be waiting there the next time somebody opens a different day.
  useEffect(() => { if (!visible) setLiveMap(null); }, [visible]);

  const live = group ? group.live.length : 0;
  const needs = group ? group.needs.length : 0;
  const n = group ? group.items.length : 0;

  const mark = live > 0
    ? { backgroundColor: U.red, color: U.bg }
    : needs > 0
      ? { backgroundColor: U.amberSoft, color: U.amber }
      : { backgroundColor: U.raised, color: U.dim };

  const headline = !group ? ''
    : live
      ? (live === 1
          ? `${kindOf(group.live[0]).title} · raised ${fmtAgo(group.live[0].created_at)}`
          : `${live} emergencies still live`)
      : needs
        ? (needs === 1
            ? `${kindOf(group.needs[0]).title} · waiting for your answer`
            : `${needs} alerts waiting for your answer`)
        : '';

  return (
    <Modal
      visible={!!visible}
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={s.root}>
        {group ? (
          <>
            <View style={[s.head, { paddingTop: insets.top + S.sm }]}>
              <Pressable
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel="Back to alerts"
                style={({ pressed }) => [s.back, pressed && { backgroundColor: U.raised }]}
              >
                <Icon name="chevron-left" size={24} color={U.text} />
              </Pressable>

              {/* The same three-state mark the list card uses, so the thing
                  you tapped is the thing that arrives. */}
              <View style={[s.avatar, { backgroundColor: mark.backgroundColor }]}>
                <Text style={[s.avatarTxt, { color: mark.color }]}>
                  {initials(group.name)}
                </Text>
              </View>

              <View style={{ flex: 1, gap: 2 }}>
                <Text style={s.name} numberOfLines={1}>{group.name}</Text>
                <Text style={[T.meta, { color: U.faint }]}>
                  {group.dayLabel} · {n} event{n === 1 ? '' : 's'}
                </Text>
              </View>
            </View>

            {/* The alarm line, pinned. On the card this was a summary; here it
                is the one thing that must not scroll away while somebody reads
                a long day looking for what to do. */}
            {live > 0 || needs > 0 ? (
              <View style={[s.strip, { backgroundColor: live > 0 ? U.redSoft : U.amberSoft }]}>
                <Icon name={live > 0 ? 'radio' : 'clock'} size={14}
                      color={live > 0 ? U.red : U.amber} />
                <Text style={[T.bodyMed, { color: live > 0 ? U.red : U.amber, flex: 1 }]}>
                  {headline}
                </Text>
              </View>
            ) : null}

            <ScrollView
              style={s.scroll}
              contentContainerStyle={[s.scrollBody, { paddingBottom: insets.bottom + S.xxl }]}
            >
              <Text style={s.sectionLabel}>WHAT HAPPENED</Text>

              <View style={s.timeline}>
                {group.items.map((a, i) => (
                  <EventRow
                    key={a.id}
                    item={a}
                    scope={scope}
                    last={i === group.items.length - 1}
                    mineAcked={group.ackedIds.has(a.id)}
                    busy={busy}
                    onAck={onAck}
                    onStandDown={onStandDown}
                    onSamaritan={onSamaritan}
                    onWatch={setLiveMap}
                  />
                ))}
              </View>

              <Text style={s.foot}>
                {fmtFullDay(group.latest.created_at)}
                {'  ·  '}
                {n === 1 ? '1 event recorded' : `${n} events recorded`}
              </Text>
            </ScrollView>

            {/* Reached from a row rather than only from the takeover, because
                the takeover is dismissed the moment somebody taps "I'm on it"
                -- and that is exactly when they start driving and want to see
                where they are driving TO. */}
            <LiveMap visible={!!liveMap} alert={liveMap} session={session}
                     onClose={() => setLiveMap(null)} />
          </>
        ) : null}
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: U.bg },

  head: {
    flexDirection: 'row', alignItems: 'center', gap: S.md,
    paddingHorizontal: S.md, paddingBottom: S.md,
  },
  back: {
    width: 40, height: 40, borderRadius: RU.pill,
    alignItems: 'center', justifyContent: 'center', marginLeft: -S.xs,
  },
  avatar: {
    width: 40, height: 40, borderRadius: RU.pill, backgroundColor: U.raised,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarTxt: { ...T.title, color: U.dim, letterSpacing: 0.3 },
  name: { ...T.h1, color: U.text },

  strip: {
    flexDirection: 'row', alignItems: 'center', gap: S.sm,
    marginHorizontal: S.lg, marginBottom: S.sm,
    paddingHorizontal: S.md, paddingVertical: S.md,
    borderRadius: RU.inner,
  },

  scroll: { flex: 1 },
  scrollBody: { padding: S.lg, paddingTop: S.sm, gap: S.sm },
  sectionLabel: { ...T.label, color: U.faint, letterSpacing: 1.4, marginBottom: S.xs },

  timeline: {
    backgroundColor: U.card, borderRadius: RU.card,
    paddingHorizontal: S.lg, paddingTop: S.lg, paddingBottom: S.sm,
  },

  foot: {
    ...T.meta, color: U.faint, textAlign: 'center',
    marginTop: S.lg, fontSize: 12,
  },
});
