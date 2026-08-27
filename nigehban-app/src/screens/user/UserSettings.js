import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MODES } from '../../bandLink';
import PinSheet from '../../components/PinSheet';
import { clearPin, hasPin } from '../../security';
import { S, T, fmtAgo } from '../../theme';
import { Icon, Txt } from '../../ui';
import { RU, U, rowStyles as r } from './kit';

/** The link states, said as a person would say them. */
const BAND_LABEL = {
  idle: 'Not connected', scanning: 'Searching…', connecting: 'Connecting…',
  connected: 'Connected', disconnected: 'Lost the band',
  simulated: 'Simulated', virtual: 'This phone',
  'no-permission': 'Bluetooth denied', 'not-found': 'Band not found',
};

/**
 * Setup for the end user: what is working, what is not, and the two things
 * she can actually change about it.
 *
 * Everything here is a fact about her own phone or her own wristband. The wire
 * log and the raw event stream stay on the admin side -- a person is not helped
 * by watching JSON go past -- but connecting the band is not diagnostics, it is
 * the thing that makes fall detection and the SOS key work at all, so it lives
 * here where she can reach it.
 */
export default function UserSettings({ session, band, serverOnline, onSignOut }) {
  // 'virtual' is still a working band as far as the wearer is concerned, and
  // App.js already treats it as a live link when it sends heartbeats. Saying
  // otherwise here would report a fault that does not exist.
  const linked = band?.status === 'connected' || band?.status === 'virtual';
  const virtual = band?.status === 'virtual';

  const [pinSet, setPinSet] = useState(false);
  const [sheet, setSheet] = useState(false);

  const refreshPin = useCallback(async () => setPinSet(await hasPin()), []);
  useEffect(() => { refreshPin(); }, [refreshPin]);

  return (
    <>
      <ScrollView style={s.root} contentContainerStyle={s.content}>
        <View style={s.header}>
          <Txt variant="h1" color={U.text}>Setup</Txt>
          <Text style={[T.meta, { color: U.faint }]}>
            System health and device configuration
          </Text>
        </View>

        {!linked ? (
          <View style={s.notice}>
            <View style={s.noticeHead}>
              <View style={s.noticeMark}>
                <Icon name="alert-circle" size={17} color={U.amber} />
              </View>
              <Text style={[T.h2, { color: U.amber, flex: 1 }]}>Band sync paused</Text>
            </View>
            <Text style={[T.meta, { color: U.dim }]}>
              The wristband is not connected, so fall detection and the SOS key
              are not working right now.
            </Text>
            <Pressable
              onPress={() => band?.connect?.()}
              accessibilityRole="button"
              style={({ pressed }) => [s.noticeBtn, pressed && { opacity: 0.75 }]}
            >
              <Text style={[T.button, { color: U.bg }]}>Reconnect</Text>
              <Icon name="chevron-right" size={16} color={U.bg} />
            </Pressable>
          </View>
        ) : null}

        <Section title="ACCOUNT" tone={U.mint} />
        <View style={s.group}>
          <Row icon="user" title="Signed in as" value={session.name} />
          <View style={r.line} />
          <Row icon="hash" title="Your code" value={session.user_id} />
        </View>

        <Section title="DEVICE" tone={U.mint} />
        <View style={s.group}>
          <Row
            icon="watch" title="Wristband"
            sub={virtual ? 'No hardware paired — this phone is standing in' : undefined}
            value={BAND_LABEL[band?.status] || band?.status || 'Not connected'}
            tone={linked ? U.mint : U.amber}
          />
          <View style={r.line} />
          <Row
            icon="battery" title="Band battery"
            value={band?.battery != null ? `${Math.round(band.battery)}%` : '—'}
            tone={band?.battery != null && band.battery <= 20 ? U.amber : U.dim}
          />
          <View style={r.line} />
          <Row
            icon={band?.armed ? 'lock' : 'unlock'} title="Anti-snatch"
            sub="Raises an alarm if the band is pulled off"
            value={band?.armed ? 'Armed' : 'Off'}
            tone={band?.armed ? U.mint : U.dim}
          />
          <View style={r.line} />
          <Row
            icon="activity" title="Last heard from"
            value={band?.lastSeen ? fmtAgo(band.lastSeen / 1000) : '—'}
          />
          <View style={r.line} />
          <Row
            icon="cloud" title="Cloud sync"
            value={serverOnline ? 'Active' : 'Offline'}
            tone={serverOnline ? U.mint : U.red}
          />
        </View>

        {/* The band's own controls. Which ones appear is the link state -- a
            "connect" button on an already-connected band is how people end up
            disconnecting the thing they were trying to check. */}
        <View style={s.actions}>
          {band?.status === 'connected' ? (
            <>
              <Action
                icon="bell" label="Buzz it"
                onPress={() => band.send?.({ c: 'buzz', n: 2 })}
              />
              <Action
                icon="x" label="Disconnect"
                onPress={() => band.disconnect?.()}
              />
            </>
          ) : virtual ? (
            <Action
              icon="bluetooth" label="Connect a real band" filled
              onPress={() => band.chooseMode?.(MODES.BLE)}
            />
          ) : (
            <>
              <Action
                icon="bluetooth" label={band?.status === 'scanning' || band?.status === 'connecting'
                  ? 'Searching…' : 'Connect to band'}
                filled
                disabled={band?.status === 'scanning' || band?.status === 'connecting'}
                onPress={() => band?.connect?.()}
              />
              <Action
                icon="smartphone" label="Use this phone instead"
                onPress={() => band?.chooseMode?.(MODES.VIRTUAL)}
              />
            </>
          )}
        </View>

        {band?.status === 'no-permission' ? (
          <Text style={[T.meta, { color: U.amber, marginTop: S.sm }]}>
            Bluetooth permission was denied, so the band cannot be found. Grant it
            in Android settings, or let this phone stand in for the band.
          </Text>
        ) : null}

        <Section title="SAFETY" tone={U.mint} />
        <View style={s.group}>
          <Row
            icon="lock" title="Disarm PIN"
            sub="Asked for before an SOS can be cancelled"
            value={pinSet ? 'Set' : 'Not set'}
            tone={pinSet ? U.mint : U.amber}
            onPress={() => setSheet(true)}
          />
          {pinSet ? (
            <>
              <View style={r.line} />
              <Row
                icon="rotate-ccw" title="Remove PIN" tone={U.dim}
                onPress={async () => { await clearPin(); refreshPin(); }}
              />
            </>
          ) : null}
        </View>

        <Pressable
          onPress={onSignOut}
          accessibilityRole="button"
          style={({ pressed }) => [s.signOut, pressed && { opacity: 0.75 }]}
        >
          <Icon name="log-out" size={16} color={U.dim} />
          <Text style={[T.button, { color: U.dim }]}>Sign out</Text>
        </Pressable>
      </ScrollView>

      <PinSheet
        visible={sheet}
        mode="set"
        onCancel={() => setSheet(false)}
        onDone={() => { setSheet(false); refreshPin(); }}
      />
    </>
  );
}

function Section({ title, tone }) {
  return (
    <View style={s.section}>
      <View style={[s.sectionDot, { backgroundColor: tone }]} />
      <Text style={[T.label, { color: U.faint }]}>{title}</Text>
    </View>
  );
}

/** A band control. Filled is the one thing to do next; the rest are outlines. */
function Action({ icon, label, onPress, filled, disabled }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [
        s.action,
        { backgroundColor: filled ? U.mint : U.card },
        disabled && { opacity: 0.5 },
        pressed && { opacity: 0.75 },
      ]}
    >
      <Icon name={icon} size={16} color={filled ? U.bg : U.dim} />
      <Text style={[T.button, { color: filled ? U.bg : U.dim }]}>{label}</Text>
    </Pressable>
  );
}

function Row({ icon, title, sub, value, tone = U.dim, onPress }) {
  const body = (
    <View style={r.row}>
      <View style={r.tile}>
        <Icon name={icon} size={17} color={U.text} />
      </View>
      <View style={r.body}>
        <Text style={r.title}>{title}</Text>
        {sub ? <Text style={r.sub}>{sub}</Text> : null}
      </View>
      {value ? <Text style={[T.meta, { color: tone }]}>{value}</Text> : null}
      {onPress ? <Icon name="chevron-right" size={16} color={U.faint} /> : null}
    </View>
  );

  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={title}
               style={({ pressed }) => pressed && { opacity: 0.7 }}>
      {body}
    </Pressable>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: U.bg },
  content: { padding: S.lg, paddingBottom: S.xxl },

  header: { gap: 2, marginBottom: S.lg },

  notice: {
    gap: S.md, padding: S.lg, borderRadius: RU.card,
    backgroundColor: U.amberSoft,
  },
  noticeHead: { flexDirection: 'row', alignItems: 'center', gap: S.md },
  noticeMark: {
    width: 34, height: 34, borderRadius: RU.inner, backgroundColor: U.bg,
    alignItems: 'center', justifyContent: 'center',
  },
  noticeBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    minHeight: 48, borderRadius: RU.inner, backgroundColor: U.amber,
  },

  section: { flexDirection: 'row', alignItems: 'center', gap: S.sm, marginTop: S.xl, marginBottom: S.sm },
  sectionDot: { width: 6, height: 6, borderRadius: 3 },

  group: {
    backgroundColor: U.card, borderRadius: RU.card,
    paddingHorizontal: S.lg, paddingVertical: 2,
  },

  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: S.sm, marginTop: S.md },
  action: {
    flexGrow: 1, flexBasis: 140,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: S.sm,
    minHeight: 48, borderRadius: RU.inner, paddingHorizontal: S.md,
  },

  signOut: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: S.sm,
    minHeight: 48, borderRadius: RU.inner, backgroundColor: U.card,
    marginTop: S.xxl,
  },
});
