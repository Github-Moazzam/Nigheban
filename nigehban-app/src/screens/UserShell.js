import React, { useEffect, useRef, useState } from 'react';
import { BackHandler, Pressable, StyleSheet, Text, View } from 'react-native';
import { call } from '../api';
import { useEdgeInsets } from '../safeArea';
import { S, T, fmtCount } from '../theme';
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
  session, band, ctx, deliveredTo, deliveryStatus, serverOnline,
  onRaise, onResolve, onOptinSamaritan, onSignOut, refreshKey, onAckCheckin,
  onToggleHighAlert, onFix,
}) {
  const [tab, setTab] = useState('dashboard');
  const [liveFamily, setLiveFamily] = useState(0);
  const insets = useEdgeInsets();

  // A live SOS takes the whole shell -- but it must not trap her in it. There
  // is nothing on that screen for looking up an address, telling her family
  // something in her own words, or checking what has already been raised, and
  // "the only way out is to cancel your own emergency" is the wrong price for
  // any of those. `minimised` gives the tabs back; the alert, the siren, the
  // responders and the server's deadline are all untouched by it, because not
  // one of them lives in this view.
  const [minimised, setMinimised] = useState(false);
  // People waiting on an answer from this phone. Counted by the board below,
  // which loads the list anyway, and reported up so the tab bar can carry a
  // dot from any of the three tabs -- a request answered nowhere is a person
  // who thinks they are covered and is not.
  const [requests, setRequests] = useState(0);

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

  // A new emergency always takes the screen again, however the last one was
  // left. Keyed on an alert *arriving* rather than on its id: `raise` swaps a
  // local `pending-…` placeholder for the server's own row part-way through a
  // single SOS, and watching the id would throw her back into a view she had
  // deliberately just stepped out of.
  const sosLive = !!ctx.activeSos;
  const wasLive = useRef(false);
  useEffect(() => {
    if (sosLive !== wasLive.current) {
      wasLive.current = sosLive;
      setMinimised(false);
    }
  }, [sosLive]);

  // Android's back gesture is the first thing anybody reaches for, so on the
  // takeover it does what the button does rather than nothing at all. Only on
  // the takeover: once she is back in the tabs, back means what it means
  // everywhere else on this phone, and quietly eating it there would be its
  // own kind of trap.
  useEffect(() => {
    if (!sosLive || minimised) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setMinimised(true);
      return true;
    });
    return () => sub.remove();
  }, [sosLive, minimised]);

  // A live SOS is not a tab. It takes the whole shell until it is stood down
  // -- or until she asks for the rest of the app back, which is the one thing
  // it gives up without giving up the alert.
  if (sosLive && !minimised) {
    return (
      <View style={s.root}>
        <SosLive
          alert={ctx.activeSos}
          deliveredTo={deliveredTo}
          deliveryStatus={deliveryStatus}
          responders={ctx.responders}
          onStandDown={onResolve}
          onOptinSamaritan={onOptinSamaritan}
          onMinimise={() => setMinimised(true)}
        />
      </View>
    );
  }


  return (
    <View style={s.root}>
      {/* Stepping out of the takeover must never be able to become forgetting
          about it. This bar is pinned above the tabs on every screen, it does
          not scroll away, and it is the way back in. */}
      {sosLive ? (
        <LiveSosBar
          alert={ctx.activeSos}
          deliveryStatus={deliveryStatus}
          responders={ctx.responders}
          onPress={() => setMinimised(false)}
        />
      ) : null}

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
            onInvites={setRequests}
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
        <Tab icon="home" label="Home" dot={requests > 0}
             dotLabel={`${requests} waiting to be your family`}
             active={tab === 'dashboard'} onPress={() => setTab('dashboard')} />
        <Tab icon="bell" label="Alerts" dot={liveFamily > 0}
             dotLabel="a family emergency is live"
             active={tab === 'alerts'} onPress={() => setTab('alerts')} />
        <Tab icon="settings" label="Setup"
             active={tab === 'settings'} onPress={() => setTab('settings')} />
      </View>
    </View>
  );
}

/**
 * The strip that stands in for the takeover while she is somewhere else.
 *
 * It says the same three things that screen leads with -- that it is live, how
 * long it has been, and whether anybody has answered -- so that stepping out
 * of the takeover costs her no information, only the space it was taking. It
 * is a button, and the only thing it does is bring the takeover back; standing
 * down still happens on that screen and nowhere else, because a control that
 * ends an emergency does not belong on a strip you might brush past.
 */
function LiveSosBar({ alert, deliveryStatus, responders = [], onPress }) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const elapsed = alert?.created_at
    ? Math.max(0, Math.floor(Date.now() / 1000 - alert.created_at))
    : 0;

  // Queued is not sent, and this strip does not get to round that up. It is
  // the same rule the takeover follows: never say her family has been told
  // while the alert is still sitting on the phone.
  const said = deliveryStatus === 'queued'
    ? 'Waiting for signal'
    : responders.length
      ? `${responders.length} on the way`
      : elapsed >= 20
        ? 'No responses yet'
        : 'Family alerted';


  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`SOS still live, ${fmtCount(elapsed)}. ${said}. Open it.`}
      style={({ pressed }) => [s.sosBar, pressed && { opacity: 0.85 }]}
    >
      <View style={s.sosBarDot} />
      <Text style={[T.label, { color: U.bg }]}>SOS LIVE</Text>
      <Text style={[T.label, { color: U.bg }]}>{fmtCount(elapsed)}</Text>
      <Text style={[T.meta, s.sosBarSaid]} numberOfLines={1}>{said}</Text>
      <Icon name="chevron-up" size={16} color={U.bg} />
    </Pressable>
  );
}

function Tab({ icon, label, active, onPress, dot, dotLabel }) {
  return (
    <Pressable
      onPress={onPress}
      style={s.tab}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={dot && dotLabel ? `${label}, ${dotLabel}` : label}
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

  sosBar: {
    flexDirection: 'row', alignItems: 'center', gap: S.sm,
    backgroundColor: U.red, paddingHorizontal: S.lg,
    minHeight: 48, paddingVertical: S.sm,
  },
  sosBarDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: U.bg },
  sosBarSaid: { color: U.bg, flex: 1, textAlign: 'right', opacity: 0.9 },
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
