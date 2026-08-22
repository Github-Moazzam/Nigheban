import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { C, MONO } from '../theme';
import { Button, Card } from '../ui';

/**
 * CheckinBanner — Displays an active 90-second check-in countdown banner.
 * High contrast styling for dark mode readability.
 */
export default function CheckinBanner({ checkin, onAck, style }) {
  if (!checkin) return null;

  const [remaining, setRemaining] = useState(checkin.window || 90);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Target completion timestamp
    const targetTime = checkin.due_at || (checkin._startAt ? checkin._startAt + (checkin.window || 90) : Date.now() / 1000 + (checkin.window || 90));

    const update = () => {
      const rem = Math.max(0, Math.ceil(targetTime - Date.now() / 1000));
      setRemaining(rem);
    };

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [checkin]);

  const handleAck = async () => {
    if (busy || !onAck) return;
    setBusy(true);
    try {
      await onAck(checkin.checkin_id || checkin.id);
    } finally {
      setBusy(false);
    }
  };

  const isUrgent = remaining <= 30;

  return (
    <Card style={[s.container, isUrgent ? s.urgentContainer : s.normalContainer, style]}>
      <View style={s.topRow}>
        <Text style={s.icon}>{isUrgent ? '⚠️' : '🔔'}</Text>
        <View style={s.textWrap}>
          <Text style={[s.title, isUrgent && { color: C.red }]}>
            {isUrgent ? 'CHECK-IN EXPIRING SOON' : 'CHECK-IN REQUESTED'}
          </Text>
          <Text style={s.reason}>
            {checkin.name ? `${checkin.name} is checking on you` : 'Safety Check'} · Server will escalate if unanswered
          </Text>
        </View>
      </View>

      {/* Countdown Timer Display */}
      <View style={s.timerBox}>
        <Text style={s.timerLabel}>TIME REMAINING</Text>
        <Text style={[s.timerValue, isUrgent && { color: C.red }]}>
          {remaining}s
        </Text>
      </View>

      <Button
        title={busy ? 'CONFIRMING...' : "I'M SAFE — ANSWER CHECK-IN"}
        tone={C.green}
        filled
        onPress={handleAck}
        disabled={busy}
      />
    </Card>
  );
}

const s = StyleSheet.create({
  container: {
    padding: 16,
    gap: 12,
    borderWidth: 1.5,
  },
  normalContainer: {
    borderColor: '#63BE93',
    backgroundColor: '#13281E',
  },
  urgentContainer: {
    borderColor: C.red,
    backgroundColor: '#2A1315',
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  icon: {
    fontSize: 24,
  },
  textWrap: {
    flex: 1,
  },
  title: {
    fontFamily: MONO.fontFamily,
    fontSize: 14,
    fontWeight: 'bold',
    color: '#63BE93',
    letterSpacing: 0.5,
  },
  reason: {
    fontFamily: MONO.fontFamily,
    fontSize: 11,
    color: '#A0A0A0', // High contrast readable grey
    marginTop: 3,
  },
  timerBox: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#181C19',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: C.border,
  },
  timerLabel: {
    fontFamily: MONO.fontFamily,
    fontSize: 11,
    color: '#CCCCCC', // High contrast label
    letterSpacing: 0.5,
  },
  timerValue: {
    fontFamily: MONO.fontFamily,
    fontSize: 24,
    fontWeight: 'bold',
    color: '#63BE93',
  },
});
