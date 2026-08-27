import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { call } from '../api';
import { useEdgeInsets } from '../safeArea';
import { S, T } from '../theme';
import { Icon } from '../ui';
import Dashboard from './user/Dashboard';
import SosLive from './user/SosLive';
import UserAlerts from './user/UserAlerts';
import UserSettings from './user/UserSettings';
import { U } from './user/kit';

/**
 * Everything a non-admin account ever sees: three tabs, and the one screen that
 * replaces all of them while an alert of her own is live.
 *
 * The admin console keeps its five tabs and its diagnostics. Nothing from
 * this shell reaches into them, so the two can move independently.
 */
export default function UserShell({
  session, band, ctx, deliveredTo, serverOnline,
  onRaise, onResolve, onSignOut, refreshKey, onAckCheckin,
  onToggleHighAlert, onFix,
}) {
  const [tab, setTab] = useState('dashboard');
  const [liveFamily, setLiveFamily] = useState(0);
  const insets = useEdgeInsets();

  // A dot on the Alerts tab, and only for an emergency that is still running.
  // `refreshKey` bumps on every socket frame, so this follows the alert rather
  // than a timer. Severity 4 and up is the band torn off, a fall, an SOS --
  // the kinds somebody stands down, so the dot clears itself. A missed
  // check-in stays in the list but does not sit on the tab bar forever.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await call(session, '/alerts?scope=incoming');
        if (cancelled) return;
        setLiveFamily(rows.filter((a) => a.severity >= 4 && !a.resolved_at).length);
      } catch { /* the tab still opens; it just does not glow */ }
    })();
    return () => { cancelled = true; };
  }, [session, refreshKey]);

  // A live SOS is not a tab. It takes the whole shell until it is stood down.
  if (ctx.activeSos) {
    return (
      <View style={s.root}>
        <SosLive
          alert={ctx.activeSos}
          deliveredTo={deliveredTo}
          responders={ctx.responders}
          onStandDown={onResolve}
        />
      </View>
    );
  }

  return (
    <View style={s.root}>
      <View style={s.content}>
        {tab === 'dashboard' ? (
          <Dashboard
            session={session}
            band={band}
            ctx={ctx}
            refreshKey={refreshKey}
            serverOnline={serverOnline}
            onRaise={onRaise}
            onAckCheckin={onAckCheckin}
            onToggleHighAlert={onToggleHighAlert}
            onFix={onFix}
          />
        ) : tab === 'alerts' ? (
          <UserAlerts
            session={session}
            refreshKey={refreshKey}
            onResolve={onResolve}
          />
        ) : (
          <UserSettings
            session={session}
            band={band}
            serverOnline={serverOnline}
            onSignOut={onSignOut}
          />
        )}
      </View>

      <View style={[s.tabBar, { paddingBottom: S.sm + insets.bottom }]}>
        <Tab icon="home" label="Home"
             active={tab === 'dashboard'} onPress={() => setTab('dashboard')} />
        <Tab icon="bell" label="Alerts" dot={liveFamily > 0}
             active={tab === 'alerts'} onPress={() => setTab('alerts')} />
        <Tab icon="settings" label="Setup"
             active={tab === 'settings'} onPress={() => setTab('settings')} />
      </View>
    </View>
  );
}

function Tab({ icon, label, active, onPress, dot }) {
  return (
    <Pressable
      onPress={onPress}
      style={s.tab}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={dot ? `${label}, a family emergency is live` : label}
    >
      <View>
        <Icon name={icon} size={21} color={active ? U.mint : U.faint} />
        {dot ? <View style={s.dot} /> : null}
      </View>
      <Text style={[T.label, { color: active ? U.mint : U.faint }]}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: U.bg },
  content: { flex: 1 },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: U.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: U.line,
    paddingTop: S.sm,
  },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4, minHeight: 48 },
  dot: {
    position: 'absolute', top: -2, right: -3,
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: U.red, borderWidth: 1.5, borderColor: U.card,
  },
});
