import React, { useState } from 'react';
import { Pressable, StyleSheet, View, Text } from 'react-native';
import Dashboard from './user/Dashboard';
import UserSettings from './user/UserSettings';
import SosLiveView from '../components/SosLiveView';
import { clearSession } from '../api';
import { C, S, T } from '../theme';
import { Icon } from '../ui';

export default function UserShell({
  session, band, ctx, deliveredTo, serverOnline, fix,
  onRaise, onResolve, onSignOut, refreshKey, onAckCheckin
}) {
  const [tab, setTab] = useState('dashboard');

  const signOut = async () => {
    await clearSession();
    onSignOut();
  };

  // 1. If SOS is live, force the SOS view (Screenshot 3).
  if (ctx.activeSos) {
    return (
      <View style={s.sosRoot}>
        <SosLiveView 
          alert={ctx.activeSos} 
          deliveredTo={deliveredTo} 
          responders={ctx.responders} 
          fix={fix}
          onStandDown={onResolve} 
        />
      </View>
    );
  }

  // 2. Otherwise render the tabbed shell (Screenshots 1 & 2).
  return (
    <View style={s.root}>
      <View style={s.content}>
        {tab === 'dashboard' && (
          <Dashboard 
            session={session} 
            ctx={ctx} 
            refreshKey={refreshKey} 
            serverOnline={serverOnline}
            onRaise={onRaise} 
            onAckCheckin={onAckCheckin}
          />
        )}
        {tab === 'settings' && (
          <UserSettings 
            session={session} 
            band={band} 
            onSignOut={signOut} 
          />
        )}
      </View>
      <View style={s.tabBar}>
        <TabButton 
          icon="home" 
          label="Dashboard" 
          active={tab === 'dashboard'} 
          onPress={() => setTab('dashboard')} 
        />
        <TabButton 
          icon="settings" 
          label="Settings" 
          active={tab === 'settings'} 
          onPress={() => setTab('settings')} 
        />
      </View>
    </View>
  );
}

function TabButton({ icon, label, active, onPress }) {
  return (
    <Pressable style={s.tab} onPress={onPress}>
      <Icon name={icon} size={24} color={active ? C.green : C.faint} />
      <Text style={[T.label, { color: active ? C.green : C.faint, marginTop: 4 }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  sosRoot: { flex: 1, backgroundColor: C.bg, padding: S.lg, justifyContent: 'center' },
  content: { flex: 1 },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: C.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: C.line,
    paddingBottom: 24, // safe area inset roughly
    paddingTop: S.sm,
  },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
