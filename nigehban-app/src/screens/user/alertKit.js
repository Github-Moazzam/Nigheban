import React from 'react';
import {
  ActivityIndicator, Linking, Pressable, StyleSheet, Text, View,
} from 'react-native';
import { S, T, fmtAgo } from '../../theme';
import { Icon } from '../../ui';
import { RU, U } from './kit';
import { fmtClock, isLive, kindOf } from '../alertGroups';

/**
 * The vocabulary the two alert surfaces share.
 *
 * The list (UserAlerts) shows one card per person per day and one button for
 * whatever is still outstanding. The day page (AlertDay) shows every event on
 * that card as a timeline. Both draw the same chips, the same buttons and the
 * same rows, so they live here rather than being copied into each — a chip
 * that means one thing on the list and another on the page is exactly the kind
 * of drift this app cannot afford.
 *
 * Palette only, no logic: the arithmetic is in ../alertGroups, which the admin
 * console shares. This file is the user shell's half, in the user shell's
 * colours.
 */

/** Severity in the user palette. Mint is the resting state everywhere else too. */
export function tone(sev) {
  if (sev >= 4) return U.red;
  if (sev >= 2) return U.amber;
  return U.mint;
}

/** Is this fix still worth opening a live map for, or is it only a pin now? */
export function watchable(a) {
  return !!a.share_path && (!a.resolved_at
    || (a.track_until && a.track_until > Date.now() / 1000));
}

export function sourceOf(a) {
  return a.source === 'band' ? 'from the band'
    : a.source === 'server' ? 'noticed by Nigehban'
    : 'from the phone';
}

export function Chip({ icon, text, tint }) {
  return (
    <View style={s.chip}>
      <Icon name={icon} size={11} color={tint} />
      <Text style={[T.label, { color: tint }]}>{text.toUpperCase()}</Text>
    </View>
  );
}

/**
 * Filled is the one thing to do next; outlined is everything else.
 *
 * `busy` keeps the words and swaps the icon for a spinner. It used to replace
 * the entire button with a bare spinner, which on a control that can carry
 * either "I'm on it" or "stand down" meant the one moment you most want to
 * know which one you pressed is the one moment the button will not say.
 */
export function Action({
  icon, label, busyLabel, sub, onPress, filled, tint = U.mint, busy, style,
}) {
  const fg = filled ? U.bg : U.dim;
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ busy: !!busy, disabled: !!busy }}
      style={({ pressed }) => [
        s.action,
        { backgroundColor: filled ? tint : U.raised },
        busy && { opacity: 0.7 },
        pressed && !busy && { opacity: 0.75 },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={fg} />
      ) : (
        <Icon name={icon} size={16} color={fg} />
      )}
      <View>
        <Text style={[T.button, { color: fg }]}>
          {busy ? (busyLabel || label) : label}
        </Text>
        {sub && !busy ? (
          <Text style={[T.meta, { color: fg, opacity: 0.8 }]}>{sub}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/**
 * One thing that happened, on a rail, with the clock time in the gutter.
 *
 * The clock time rather than "3h ago": relative time is what you need in a
 * list of days, absolute time is what you need inside one — and "11:42 PM" is
 * the thing somebody repeats down a phone line to a control room.
 *
 * Every button an alert can still carry is on this row and nowhere else, so
 * that nothing is ever pressed without the thing it acts on being read first.
 */
export function EventRow({
  item, scope, last, mineAcked, busy, onAck, onStandDown, onSamaritan, onWatch,
}) {
  const meta = kindOf(item);
  const t = tone(item.severity);
  const live = isLive(item);
  const mine = scope === 'mine';
  const clock = fmtClock(item.created_at);
  const canWatch = watchable(item);

  return (
    <View style={s.event}>
      <View style={s.gutter}>
        <Text style={s.clock}>{clock.time}</Text>
        <Text style={s.meridiem}>{clock.meridiem}</Text>
      </View>

      <View style={s.rail}>
        <View style={[s.railDot, { backgroundColor: live ? t : U.raised, borderColor: t }]} />
        {!last ? <View style={s.railLine} /> : null}
      </View>

      <View style={[s.body, last && { paddingBottom: S.sm }]}>
        <View style={s.titleRow}>
          <Icon name={meta.icon} size={15} color={t} />
          <Text style={[T.bodyMed, { color: U.text, flex: 1 }]} numberOfLines={2}>
            {meta.title}
          </Text>
          {live ? <Chip icon="radio" text="live" tint={U.red} /> : null}
        </View>

        <Text style={[T.meta, { color: U.faint }]}>
          {sourceOf(item)}
          {item.resolved_at ? ` · stood down ${fmtAgo(item.resolved_at)}` : ''}
          {!item.maps && !canWatch ? ' · no location' : ''}
        </Text>

        {item.note ? (
          <Text style={[T.meta, { color: U.dim }]}>“{item.note}”</Text>
        ) : null}

        {mineAcked || item.samaritan_status === 'allowed'
         || item.samaritan_status === 'denied' ? (
          <View style={s.chips}>
            {mineAcked ? <Chip icon="user-check" text="you are on it" tint={U.mint} /> : null}
            {item.samaritan_status === 'allowed'
              ? <Chip icon="users" text="helpers notified" tint={U.mint} />
              : item.samaritan_status === 'denied'
                ? <Chip icon="shield" text="family only" tint={U.faint} />
                : null}
          </View>
        ) : null}

        {/* Live while the server is still tracking, a plain pin after. The
            window outlives the stand-down by half an hour -- see
            TRACK_AFTER_STANDDOWN_S -- so a stood-down alert can still be worth
            watching while she walks home, and one from last Tuesday cannot.
            Getting that wrong in the other direction is the worse mistake:
            "watch live" over a dead link is a promise this never makes. */}
        {canWatch ? (
          <Action
            icon="navigation" label="Watch their live location"
            sub="The map moves as they do"
            onPress={() => onWatch?.(item)}
          />
        ) : item.maps ? (
          <Action
            icon="map-pin" label="Open in maps"
            sub={item.accuracy ? `accurate to about ${Math.round(item.accuracy)} m` : null}
            onPress={() => Linking.openURL(item.maps)}
          />
        ) : null}

        {/* The two things a record can still be. Answering somebody else's
            emergency, or ending your own -- never both on one row. */}
        {!mine && item.severity >= 3 && !item.resolved_at && !mineAcked ? (
          <Action
            filled tint={t} icon="user-check" label="I've seen this — I'm on it"
            busyLabel="Telling them…"
            busy={busy === item.id} onPress={() => onAck?.(item)}
          />
        ) : null}

        {!mine && live && item.samaritan_status === 'pending' ? (
          <Action
            tint={U.mint} icon="users" label="Alert nearby helpers"
            busyLabel="Alerting…"
            busy={busy === `samaritan-${item.id}`}
            onPress={() => onSamaritan?.(item, 'allow')}
          />
        ) : null}

        {mine && live ? (
          <Action
            filled tint={U.mint} icon="shield" label="I am safe — stand down"
            busyLabel="Standing down…"
            busy={busy === item.id} onPress={() => onStandDown?.(item)}
          />
        ) : null}
      </View>
    </View>
  );
}

export const s = StyleSheet.create({
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: U.raised, borderRadius: RU.pill,
    paddingHorizontal: S.sm + 2, paddingVertical: 5,
  },
  chips: { flexDirection: 'row', gap: S.sm, flexWrap: 'wrap' },

  action: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: S.sm,
    minHeight: 48, borderRadius: RU.inner, paddingHorizontal: S.md,
  },

  event: { flexDirection: 'row', gap: S.sm },
  gutter: { width: 46, alignItems: 'flex-end', paddingTop: 1 },
  clock: { ...T.meta, color: U.dim, fontVariant: ['tabular-nums'], lineHeight: 17 },
  meridiem: { ...T.label, color: U.faint, fontSize: 10 },

  rail: { width: 14, alignItems: 'center' },
  railDot: { width: 10, height: 10, borderRadius: 5, borderWidth: 2, marginTop: 5 },
  railLine: {
    flex: 1, width: StyleSheet.hairlineWidth, backgroundColor: U.line, marginTop: 4,
  },

  body: { flex: 1, gap: S.sm, paddingBottom: S.lg },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: S.sm },
});
