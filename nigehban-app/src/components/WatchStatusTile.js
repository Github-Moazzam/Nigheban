import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { C, MONO } from '../theme';

/**
 * WatchStatusTile — Displays real-time health and connection status of a Ward's wristband.
 * Clean, high-contrast inner card styling.
 */
export default function WatchStatusTile({ watchState = {}, isVirtual = false, style }) {
  const {
    mode = 'idle',
    band_link = false,
    phone_batt = null,
    last_beat = null,
  } = watchState;

  const now = Date.now() / 1000;
  const elapsedSec = last_beat ? Math.max(0, Math.floor(now - last_beat)) : null;
  const isSilent = elapsedSec !== null && elapsedSec > 180;

  let linkStatusText = 'disconnected';
  let linkStatusTone = C.amber;
  if (band_link) {
    linkStatusText = 'connected';
    linkStatusTone = '#63BE93';
  } else if (isVirtual) {
    linkStatusText = 'this phone is the band';
    linkStatusTone = '#A0A0A0';
  }

  const battDisplay = phone_batt != null ? `${phone_batt}%` : '—';
  let battTone = '#63BE93';
  if (phone_batt != null && phone_batt <= 15) battTone = C.red;
  else if (phone_batt != null && phone_batt <= 30) battTone = C.amber;

  return (
    <View style={[s.container, style]}>
      <View style={s.header}>
        <Text style={s.title}>WRISTBAND HEALTH</Text>
        <View style={[s.badge, { backgroundColor: '#18241D', borderColor: linkStatusTone }]}>
          <Text style={[s.badgeText, { color: linkStatusTone }]}>
            {band_link ? 'BLE OK' : isVirtual ? 'VIRTUAL' : 'OFFLINE'}
          </Text>
        </View>
      </View>

      <View style={s.metricsRow}>
        {/* Link Status */}
        <View style={[s.metricCol, { flex: 1.5 }]}>
          <Text style={s.metricLabel}>LINK</Text>
          <Text style={[s.metricValue, { color: linkStatusTone }]} numberOfLines={2}>
            {linkStatusText}
          </Text>
        </View>

        {/* Battery Level */}
        <View style={s.metricCol}>
          <Text style={s.metricLabel}>BATTERY</Text>
          <View style={s.battRow}>
            <Text style={[s.metricValue, { color: battTone }]}>{battDisplay}</Text>
            {phone_batt != null && (
              <View style={s.battBarOuter}>
                <View style={[s.battBarInner, { width: `${Math.min(100, Math.max(0, phone_batt))}%`, backgroundColor: battTone }]} />
              </View>
            )}
          </View>
        </View>

        {/* High Alert Indicator */}
        <View style={s.metricCol}>
          <Text style={s.metricLabel}>HIGH ALERT</Text>
          <Text style={[s.metricValue, { color: mode === 'high_alert' ? '#63BE93' : '#A0A0A0' }]}>
            {mode === 'high_alert' ? 'ARMED' : 'OFF'}
          </Text>
        </View>
      </View>

      {/* Heartbeat Timestamp */}
      <View style={s.beatFooter}>
        <Text style={[s.beatText, isSilent && { color: C.amber }]}>
          {elapsedSec === null
            ? 'waiting for initial beat...'
            : isSilent
            ? `⚠️ quiet — last beat ${Math.floor(elapsedSec / 60)}m ago`
            : `last beat ${elapsedSec}s ago`}
        </Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    padding: 12,
    gap: 10,
    backgroundColor: '#121815',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#233028',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    fontFamily: MONO.fontFamily,
    fontSize: 11,
    letterSpacing: 1,
    color: '#B0B0B0',
    fontWeight: '600',
  },
  badge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
  },
  badgeText: {
    fontFamily: MONO.fontFamily,
    fontSize: 9,
    fontWeight: 'bold',
  },
  metricsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 10,
  },
  metricCol: {
    flex: 1,
  },
  metricLabel: {
    fontFamily: MONO.fontFamily,
    fontSize: 10,
    color: '#888888',
    marginBottom: 3,
  },
  metricValue: {
    fontFamily: MONO.fontFamily,
    fontSize: 12,
    fontWeight: 'bold',
    color: '#EAEAEA',
  },
  battRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  battBarOuter: {
    height: 8,
    width: 28,
    backgroundColor: '#1A1D1B',
    borderRadius: 2,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: C.dim,
  },
  battBarInner: {
    height: '100%',
  },
  beatFooter: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#233028',
    paddingTop: 6,
  },
  beatText: {
    fontFamily: MONO.fontFamily,
    fontSize: 10,
    color: '#B0B0B0',
  },
});
