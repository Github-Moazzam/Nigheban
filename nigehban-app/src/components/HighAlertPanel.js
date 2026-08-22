import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { C, MONO } from '../theme';
import { Button, Card } from '../ui';

/**
 * HighAlertPanel — Controls High Alert mode arming and disarming.
 * High contrast styling for dark theme readability.
 */
export default function HighAlertPanel({ isArmed = false, nextBuzzAt = null, onToggle, style }) {
  const [loading, setLoading] = useState(false);

  const handlePress = async () => {
    if (!onToggle || loading) return;
    setLoading(true);
    try {
      await onToggle(!isArmed);
    } finally {
      setLoading(false);
    }
  };

  // Calculate remaining seconds to next buzz
  const now = Date.now() / 1000;
  const remainingSec = nextBuzzAt ? Math.max(0, Math.floor(nextBuzzAt - now)) : null;
  const remainingMin = remainingSec !== null ? Math.ceil(remainingSec / 60) : null;

  return (
    <Card style={[s.container, isArmed && s.containerArmed, style]}>
      <View style={s.header}>
        <View style={s.titleRow}>
          <Text style={s.icon}>{isArmed ? '🛡️' : '⏱️'}</Text>
          <View style={{ flex: 1 }}>
            <Text style={s.title}>HIGH ALERT MODE</Text>
            <Text style={s.sub}>
              {isArmed
                ? 'Random 5–10m check-in buzzes armed server-side'
                : 'Regular status monitoring'}
            </Text>
          </View>
        </View>

        <View style={[s.statusBadge, isArmed ? s.badgeArmed : s.badgeOff]}>
          <Text style={[s.statusText, { color: isArmed ? '#63BE93' : '#A0A0A0' }]}>
            {isArmed ? 'ARMED' : 'OFF'}
          </Text>
        </View>
      </View>

      {isArmed && (
        <View style={s.buzzInfo}>
          <Text style={s.buzzText}>
            {remainingMin !== null
              ? `Next check-in buzz expected in ~${remainingMin} min`
              : 'Server scheduling next buzz...'}
          </Text>
        </View>
      )}

      <Button
        title={loading ? 'UPDATING...' : isArmed ? 'DISARM HIGH ALERT' : 'ARM HIGH ALERT'}
        tone={isArmed ? C.amber : C.green}
        onPress={handlePress}
        disabled={loading}
      />
    </Card>
  );
}

const s = StyleSheet.create({
  container: {
    padding: 16,
    gap: 14,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: '#121815',
  },
  containerArmed: {
    borderColor: '#63BE93',
    backgroundColor: '#13261C',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  icon: {
    fontSize: 22,
  },
  title: {
    fontFamily: MONO.fontFamily,
    fontSize: 13,
    fontWeight: 'bold',
    color: '#EAEAEA', // High contrast title text
  },
  sub: {
    fontFamily: MONO.fontFamily,
    fontSize: 11,
    color: '#B0B0B0', // High contrast readable subtitle
    marginTop: 2,
    lineHeight: 16,
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 4,
    borderWidth: 1,
  },
  badgeArmed: {
    backgroundColor: '#1B3827',
    borderColor: '#63BE93',
  },
  badgeOff: {
    backgroundColor: '#1A1D1B',
    borderColor: C.dim,
  },
  statusText: {
    fontFamily: MONO.fontFamily,
    fontSize: 11,
    fontWeight: 'bold',
  },
  buzzInfo: {
    padding: 10,
    backgroundColor: '#18241D',
    borderRadius: 4,
    borderLeftWidth: 3,
    borderLeftColor: '#63BE93',
  },
  buzzText: {
    fontFamily: MONO.fontFamily,
    fontSize: 11,
    color: '#63BE93',
  },
});
