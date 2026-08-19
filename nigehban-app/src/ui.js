import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { C, MONO } from './theme';

const mono = Platform.select(MONO);

export function Label({ children, color }) {
  return <Text style={[s.label, color && { color }]}>{children}</Text>;
}

export function Card({ children, tone, style }) {
  const border = tone ? { borderColor: tone, borderLeftWidth: 3 } : null;
  return <View style={[s.card, border, style]}>{children}</View>;
}

/** A labelled figure. `tone` colours the value when it means something. */
export function Stat({ label, value, tone, sub }) {
  return (
    <View style={s.stat}>
      <Label>{label}</Label>
      <Text style={[s.statValue, tone && { color: tone }]}>{value}</Text>
      {sub ? <Text style={s.statSub}>{sub}</Text> : null}
    </View>
  );
}

export function Pill({ text, tone = C.dim, bg = 'transparent' }) {
  return (
    <View style={[s.pill, { borderColor: tone, backgroundColor: bg }]}>
      <Text style={[s.pillText, { color: tone }]}>{text}</Text>
    </View>
  );
}

export function Button({ title, onPress, tone = C.green, filled, disabled, sub, big }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        s.btn,
        big && s.btnBig,
        { borderColor: disabled ? C.line : tone },
        filled && !disabled && { backgroundColor: tone },
        pressed && !disabled && { opacity: 0.7 },
        disabled && { opacity: 0.45 },
      ]}
    >
      <Text
        style={[
          s.btnText,
          big && s.btnTextBig,
          { color: filled && !disabled ? C.bg : disabled ? C.faint : tone },
        ]}
      >
        {title}
      </Text>
      {sub ? (
        <Text style={[s.btnSub, { color: filled && !disabled ? C.bg : C.faint }]}>{sub}</Text>
      ) : null}
    </Pressable>
  );
}

const s = StyleSheet.create({
  label: {
    fontFamily: mono, fontSize: 10, letterSpacing: 1.4,
    color: C.faint, textTransform: 'uppercase', marginBottom: 4,
  },
  card: {
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.line,
    borderRadius: 4, padding: 16, gap: 12,
  },
  stat: { flex: 1, minWidth: 84 },
  statValue: { fontFamily: mono, fontSize: 17, color: C.text, fontVariant: ['tabular-nums'] },
  statSub: { fontFamily: mono, fontSize: 10, color: C.faint, marginTop: 2 },
  pill: {
    borderWidth: 1, borderRadius: 100, paddingHorizontal: 9, paddingVertical: 3,
    alignSelf: 'flex-start',
  },
  pillText: { fontFamily: mono, fontSize: 10, letterSpacing: 1 },
  btn: {
    borderWidth: 1, borderRadius: 4, paddingVertical: 14, paddingHorizontal: 16,
    alignItems: 'center', gap: 3,
  },
  btnBig: { paddingVertical: 34, borderWidth: 2, borderRadius: 6 },
  btnText: { fontFamily: mono, fontSize: 13, letterSpacing: 1.2, fontWeight: '600' },
  btnTextBig: { fontSize: 26, letterSpacing: 3 },
  btnSub: { fontFamily: mono, fontSize: 10, letterSpacing: 0.5 },
});
