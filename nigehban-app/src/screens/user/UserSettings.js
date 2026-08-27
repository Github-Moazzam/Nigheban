import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { C, S, T } from '../../theme';
import { Banner, Button, Card, Icon, Txt } from '../../ui';

export default function UserSettings({ session, band, onSignOut }) {
  return (
    <ScrollView style={s.list} contentContainerStyle={s.content}>
      <View style={s.headerWrap}>
        <Txt variant="h2">Setup & Diagnostics</Txt>
        <Text style={[T.meta, { color: C.dim }]}>System health, sensors & device configuration</Text>
      </View>

      {band?.status !== 'connected' && (
        <Banner tone={C.amber} icon="alert-triangle" title="ACTIVE NOTICE">
          Bluetooth sync is currently paused. Please reconnect your wearable for real-time monitoring.
        </Banner>
      )}

      <Text style={[T.label, { color: C.dim, marginTop: S.xl, marginBottom: S.sm }]}>
        ACCOUNT & WEARABLE HARDWARE
      </Text>

      <Card>
        <SettingRow icon="watch" label="Paired Wearable Bands" value={band?.status === 'connected' ? '1 Device' : '0 Devices'} />
        <View style={s.divider} />
        <SettingRow icon="users" label="Emergency Contact Configured" value="Yes" />
        <View style={s.divider} />
        <SettingRow icon="cloud" label="Cloud Sync & Backup" value="Active" />
      </Card>

      <Text style={[T.label, { color: C.dim, marginTop: S.xl, marginBottom: S.sm }]}>
        SYSTEM SENSOR DIAGNOSTICS
      </Text>

      <Card>
        <SettingRow icon="bluetooth" label="Bluetooth Low Energy" value={band?.status === 'connected' ? 'Connected' : 'Disconnected'} valueColor={band?.status === 'connected' ? C.green : C.amber} />
      </Card>

      <View style={{ marginTop: S.xxl }}>
        <Button title="SIGN OUT" tone={C.dim} icon="log-out" onPress={onSignOut} />
      </View>
    </ScrollView>
  );
}

function SettingRow({ icon, label, value, valueColor = C.dim }) {
  return (
    <View style={s.row}>
      <View style={s.rowLeft}>
        <Icon name={icon} size={20} color={C.text} />
        <Text style={[T.body, { color: C.text, marginLeft: S.md }]}>{label}</Text>
      </View>
      <Text style={[T.body, { color: valueColor }]}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  list: { flex: 1, backgroundColor: C.bg },
  content: { padding: S.lg, paddingBottom: 40 },
  headerWrap: { marginBottom: S.xl },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: S.sm },
  rowLeft: { flexDirection: 'row', alignItems: 'center' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: C.line, marginVertical: S.sm },
});
