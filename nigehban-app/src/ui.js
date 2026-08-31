// One icon family, imported by path so the bundle carries Feather alone
// rather than every set @expo/vector-icons ships.
import Feather from '@expo/vector-icons/Feather';
import React, { useEffect } from 'react';
import {
  ActivityIndicator, Animated, Easing, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { C, F, HIT, R, S, T, toneSoft } from './theme';

/**
 * The component kit.
 *
 * Every screen is built from these, so a change here is a change everywhere --
 * which is the only way a four-tab app stays consistent under a deadline.
 * Rules the kit enforces on its callers:
 *
 *   - Controls are at least 48pt tall. A person raising an alarm is not aiming.
 *   - Every pressable dims on press within a frame, and none of them move.
 *   - Icons come from one family (Feather, 2px stroke). No emoji anywhere.
 *   - Colour never carries meaning on its own; there is always a word next to it.
 */

// --------------------------------------------------------------- text ---
export function Txt({ style, variant = 'body', color = C.text, children, ...rest }) {
  return <Text {...rest} style={[T[variant], { color }, style]}>{children}</Text>;
}

/** Section eyebrow. Uppercased in place rather than by transform, for VoiceOver. */
export function Label({ children, color = C.faint, style }) {
  return (
    <Text style={[T.label, { color, textTransform: 'uppercase' }, style]}>
      {children}
    </Text>
  );
}

export function Icon({ name, size = 18, color = C.dim, style }) {
  return <Feather name={name} size={size} color={color} style={style} />;
}

// ------------------------------------------------------------ surface ---
/**
 * `tone` tints the whole card instead of outlining it. `accent` adds the one
 * piece of chrome the system allows: a 3pt bar down the left of a card that is
 * reporting a live emergency.
 */
export function Card({ children, tone, accent, style }) {
  return (
    <View
      style={[
        s.card,
        tone && { backgroundColor: toneSoft(tone) },
        accent && { borderLeftWidth: 3, borderLeftColor: accent },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Divider({ style }) {
  return <View style={[s.divider, style]} />;
}

// -------------------------------------------------------------- state ---
/** A labelled figure. `tone` colours the value when the value means something. */
export function Stat({ label, value, tone = C.text, sub, icon }) {
  return (
    <View style={s.stat}>
      <Label>{label}</Label>
      <View style={s.statRow}>
        {icon ? <Icon name={icon} size={14} color={tone} /> : null}
        <Text style={[T.number, { color: tone, flexShrink: 1 }]} numberOfLines={2}>
          {value}
        </Text>
      </View>
      {sub ? <Text style={[T.meta, { color: C.faint, fontSize: 12 }]}>{sub}</Text> : null}
    </View>
  );
}

/**
 * Status chip: a filled tint, a dot and a word. Deliberately not a bordered
 * pill -- the fill is what separates it from the card, and the word is what
 * carries the meaning for anyone who cannot see the hue.
 */
export function Chip({ text, tone = C.dim, icon, style }) {
  return (
    <View style={[s.chip, { backgroundColor: toneSoft(tone) }, style]}>
      {icon
        ? <Icon name={icon} size={12} color={tone} />
        : <View style={[s.dot, { backgroundColor: tone }]} />}
      <Text style={[T.label, { color: tone }]}>{text.toUpperCase()}</Text>
    </View>
  );
}

/** Back-compat alias for the old bordered pill. Same call sites, new look. */
export function Pill({ text, tone = C.dim, icon }) {
  return <Chip text={text} tone={tone} icon={icon} />;
}

// ------------------------------------------------------------ actions ---
/**
 * One button, four jobs:
 *   filled            the single primary action on a screen
 *   plain (default)   a secondary action, tinted rather than outlined
 *   tone={C.dim}      tertiary; reads as a link but keeps the 48pt target
 *   big               the emergency size, used by takeovers only
 */
export function Button({
  title, onPress, onLongPress, delayLongPress, tone = C.green, filled, disabled,
  loading, sub, big, icon, style, accessibilityLabel,
}) {
  const inactive = disabled || loading;
  const fg = filled && !inactive ? C.bg : inactive ? C.faint : tone;

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={delayLongPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!inactive }}
      accessibilityLabel={accessibilityLabel || title}
      style={({ pressed }) => [
        s.btn,
        big && s.btnBig,
        { backgroundColor: filled && !inactive ? tone : toneSoft(tone) },
        pressed && !inactive && s.btnPressed,
        inactive && { opacity: 0.45 },
        style,
      ]}
    >
      <View style={s.btnRow}>
        {loading ? <ActivityIndicator size="small" color={fg} /> : null}
        {icon && !loading ? <Icon name={icon} size={big ? 22 : 16} color={fg} /> : null}
        <Text style={[T.button, big && s.btnTextBig, { color: fg }]}>{title}</Text>
      </View>
      {sub ? (
        <Text style={[T.meta, s.btnSub, { color: filled && !inactive ? C.bg : C.faint }]}>
          {sub}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** Icon-only control. Carries a label for screen readers and a 44pt hit area. */
export function IconButton({ name, onPress, label, tone = C.dim, size = 20 }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={HIT}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [s.iconBtn, pressed && { backgroundColor: C.raised }]}
    >
      <Icon name={name} size={size} color={tone} />
    </Pressable>
  );
}

// ------------------------------------------------------------- inputs ---
/** A labelled field. Never a placeholder standing in for a label. */
export function Field({
  label, hint, error, value, onChangeText, style, ...rest
}) {
  return (
    <View style={{ gap: 6 }}>
      {label ? <Label>{label}</Label> : null}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholderTextColor={C.faint}
        accessibilityLabel={label}
        style={[s.input, error && { backgroundColor: C.redSoft }, style]}
        {...rest}
      />
      {error ? (
        <View style={s.fieldNote}>
          <Icon name="alert-circle" size={13} color={C.red} />
          <Text style={[T.meta, { color: C.red, flex: 1 }]}>{error}</Text>
        </View>
      ) : hint ? (
        <Text style={[T.meta, { color: C.faint }]}>{hint}</Text>
      ) : null}
    </View>
  );
}

// ----------------------------------------------------------- feedback ---
/** Inline message. `tone` picks the hue; the icon and the words carry it too. */
export function Banner({ tone = C.amber, icon = 'info', title, children, style }) {
  return (
    <View style={[s.banner, { backgroundColor: toneSoft(tone) }, style]}>
      <Icon name={icon} size={16} color={tone} style={{ marginTop: 1 }} />
      <View style={{ flex: 1, gap: 3 }}>
        {title ? <Text style={[T.bodyMed, { color: tone }]}>{title}</Text> : null}
        {typeof children === 'string'
          ? <Text style={[T.meta, { color: C.dim }]}>{children}</Text>
          : children}
      </View>
    </View>
  );
}

/** What a list says when it is empty, which is most of the time in a safety app. */
export function EmptyState({ icon = 'inbox', title, body, action, onAction }) {
  return (
    <View style={s.empty}>
      <View style={s.emptyIcon}>
        <Icon name={icon} size={22} color={C.faint} />
      </View>
      <Text style={[T.h2, { color: C.dim, textAlign: 'center' }]}>{title}</Text>
      {body ? (
        <Text style={[T.meta, { color: C.faint, textAlign: 'center' }]}>{body}</Text>
      ) : null}
      {action ? (
        <View style={{ alignSelf: 'stretch', marginTop: S.sm }}>
          <Button title={action} onPress={onAction} />
        </View>
      ) : null}
    </View>
  );
}

/** Determinate bar. Used for countdowns, where the shrink *is* the message. */
export function ProgressBar({ value = 0, tone = C.green, height = 4 }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <View style={[s.barOuter, { height, borderRadius: height / 2 }]}
          accessibilityRole="progressbar"
          accessibilityValue={{ min: 0, max: 100, now: Math.round(pct) }}>
      <View style={{ width: `${pct}%`, height: '100%', backgroundColor: tone }} />
    </View>
  );
}

// ----------------------------------------------------------- skeleton ---
/**
 * A block standing in for a value that has not arrived yet.
 *
 * Every skeleton in the app breathes on ONE shared driver, so a screen full of
 * them reads as a single surface rather than a dozen unsynchronised blinks --
 * and so twenty placeholders still cost one animation. The loop is started by
 * the first skeleton mounted and stopped by the last one unmounted; nothing
 * animates once the data is on screen.
 *
 * Opacity only, on the native driver. A shimmer driven from JS is the first
 * thing to stutter on the cheap phone this app is built for, and a stuttering
 * placeholder reads as a hung app -- the opposite of what it is there to say.
 *
 * Skeletons are invisible to screen readers; `SkeletonGroup` says "Loading"
 * once, which is the entire content of a loading screen as far as a screen
 * reader is concerned.
 */
const pulse = new Animated.Value(0);
let pulseUsers = 0;
let pulseLoop = null;

function beginPulse() {
  pulseUsers += 1;
  if (pulseLoop) return;
  const leg = (toValue) => Animated.timing(pulse, {
    toValue, duration: 620, easing: Easing.inOut(Easing.quad), useNativeDriver: true,
  });
  pulseLoop = Animated.loop(Animated.sequence([leg(1), leg(0)]));
  pulseLoop.start();
}

function endPulse() {
  pulseUsers = Math.max(0, pulseUsers - 1);
  if (pulseUsers > 0) return;
  // Stopped where it stands, not reset. The node is native-driven, and the
  // next skeleton to mount simply animates on from wherever this left it --
  // which nobody can see, because by definition none are on screen.
  pulseLoop?.stop();
  pulseLoop = null;
}

const pulseOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.85] });

export function Skeleton({
  width = '100%', height = 12, radius = R.chip, color = C.raised, style,
}) {
  useEffect(() => { beginPulse(); return endPulse; }, []);
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        { width, height, borderRadius: radius, backgroundColor: color, opacity: pulseOpacity },
        style,
      ]}
    />
  );
}

/** Wraps a set of placeholders so the screen announces itself once, not N times. */
export function SkeletonGroup({ label = 'Loading', gap = S.md, children, style }) {
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      style={[{ gap }, style]}
    >
      {children}
    </View>
  );
}

// -------------------------------------------------------------- style ---
const s = StyleSheet.create({
  card: {
    backgroundColor: C.surface,
    borderRadius: R.card,
    padding: S.lg,
    gap: S.md,
  },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: C.line },

  stat: { flex: 1, minWidth: 90, gap: 4 },
  statRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },

  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: S.sm, paddingVertical: 5,
    borderRadius: R.chip, alignSelf: 'flex-start',
  },
  dot: { width: 6, height: 6, borderRadius: 3 },

  btn: {
    minHeight: 48, borderRadius: R.control,
    paddingVertical: 13, paddingHorizontal: S.lg,
    alignItems: 'center', justifyContent: 'center', gap: 2,
  },
  btnRow: { flexDirection: 'row', alignItems: 'center', gap: S.sm },
  btnBig: { minHeight: 76, paddingVertical: 22, borderRadius: R.card },
  btnTextBig: { fontSize: 21, letterSpacing: 0.4 },
  btnPressed: { opacity: 0.72 },
  btnSub: { fontSize: 12, opacity: 0.85 },

  iconBtn: {
    width: 40, height: 40, borderRadius: R.control,
    alignItems: 'center', justifyContent: 'center',
  },

  input: {
    backgroundColor: C.raised, borderRadius: R.control,
    color: C.text, fontFamily: F.body, fontSize: 16,
    paddingHorizontal: S.md, minHeight: 48, paddingVertical: 12,
  },
  fieldNote: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },

  banner: {
    flexDirection: 'row', gap: S.md, padding: S.md,
    borderRadius: R.control, alignItems: 'flex-start',
  },

  empty: {
    alignItems: 'center', gap: S.sm, paddingVertical: S.xxl,
    paddingHorizontal: S.xl,
  },
  emptyIcon: {
    width: 48, height: 48, borderRadius: R.card, backgroundColor: C.surface,
    alignItems: 'center', justifyContent: 'center', marginBottom: 2,
  },

  barOuter: { backgroundColor: C.raised, overflow: 'hidden' },
});
