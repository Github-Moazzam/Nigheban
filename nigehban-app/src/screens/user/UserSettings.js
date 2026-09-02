import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, AppState, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { updateUserSettings } from '../../api';
import { MODES } from '../../bandLink';

import PinSheet from '../../components/PinSheet';
import {
  OEM, askPermission, ladderRows, openActivity, openBatterySettings,
  readPermissions, vendorKey,
} from '../../permissions';
import { clearPin, hasPin } from '../../security';
import { S, T, fmtAgo } from '../../theme';
import { Icon, Skeleton, SkeletonGroup, Txt } from '../../ui';
import { usePhoneBattery } from '../../watch';
import { RU, U, rowStyles as r } from './kit';

/**
 * The link states, said as a person would say them.
 *
 * Every status band.js can set needs a line here. The lookup falls back to the
 * raw key, which is how `error:Scan failed because application registration
 * failed (code 6)` ended up on this screen as a wristband's status.
 */
const BAND_LABEL = {
  idle: 'Not connected', scanning: 'Searching…', connecting: 'Connecting…',
  connected: 'Connected', disconnected: 'Lost the band',
  simulated: 'Simulated', virtual: 'This phone',
  'no-permission': 'Bluetooth denied', 'not-found': 'Band not found',
  throttled: 'Bluetooth busy…', 'bt-stuck': 'Restart Bluetooth',
  'bluetooth-off': 'Bluetooth off', 'location-off': 'Location off',
  'no-service': 'Needs re-pairing', 'no-notify': 'Band not responding',
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
  const phoneBatt = usePhoneBattery();

  const [pinSet, setPinSet] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [samaritanEnabled, setSamaritanEnabled] = useState(
    session?.samaritan_enabled !== false
  );
  const [samaritanBusy, setSamaritanBusy] = useState(false);

  const toggleSamaritan = async () => {
    if (samaritanBusy) return;
    setSamaritanBusy(true);
    const next = !samaritanEnabled;
    try {
      await updateUserSettings(session, { samaritan_enabled: next });
      setSamaritanEnabled(next);
      if (session) session.samaritan_enabled = next;
    } catch { /* non-fatal */ }
    finally { setSamaritanBusy(false); }
  };

  // Which control is mid-flight. One at a time is the truth here: every one of
  // these hands off to Android or to the band, and both take long enough that
  // a button with no answer on it reads as a button that did nothing.
  const [pending, setPending] = useState(null);   // 'connect' | 'buzz' | …

  const refreshPin = useCallback(async () => setPinSet(await hasPin()), []);
  useEffect(() => { refreshPin(); }, [refreshPin]);

  const [perm, setPerm] = useState({ notif: null, loc: null, bg: null, fsi: null });
  // Nothing is known until the first read comes back, and "not granted" is the
  // wrong thing to draw in the meantime -- it puts an amber ladder in front of
  // somebody whose phone is already set up correctly.
  const [permLoading, setPermLoading] = useState(true);
  const [asking, setAsking] = useState(null);     // the rung being asked for
  const refreshPerm = useCallback(async () => {
    try { setPerm(await readPermissions()); } finally { setPermLoading(false); }
  }, []);
  useEffect(() => { refreshPerm(); }, [refreshPerm]);

  // Android hands the answer back through the Settings app, not through the
  // promise, so nothing is known until this screen is looked at again.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') refreshPerm();
    });
    return () => sub.remove();
  }, [refreshPerm]);

  const askAndRefresh = useCallback(async (key, denied) => {
    setAsking(key);
    try {
      await askPermission(key, denied);
      await refreshPerm();
    } finally {
      setAsking(null);
    }
  }, [refreshPerm]);

  /** Re-read the ladder on demand, saying so while it happens. */
  const recheck = useCallback(async () => {
    setAsking('recheck');
    try { await refreshPerm(); } finally { setAsking(null); }
  }, [refreshPerm]);

  /**
   * Hand off to a Settings page. Android takes a visible moment to swap
   * activities, and on the phones that need these rows most it takes several.
   */
  const openSettingsRow = useCallback(async (key, open) => {
    setAsking(key);
    try { await open(); } catch { /* the row stays; there is nothing else to say */ }
    finally { setAsking(null); }
  }, []);

  /** Runs one band control, and marks it as running while it does. */
  const run = useCallback(async (key, fn) => {
    if (pending) return;
    setPending(key);
    try { await fn?.(); } catch { /* the rows above report the outcome */ }
    finally { setPending(null); }
  }, [pending]);

  const ladder = ladderRows(perm);
  const permLeft = ladder.filter((row) => row.granted !== true).length;
  const vendor = vendorKey();

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
              onPress={() => run('reconnect', band?.connect)}
              disabled={!!pending}
              accessibilityRole="button"
              accessibilityState={{ busy: pending === 'reconnect', disabled: !!pending }}
              style={({ pressed }) => [
                s.noticeBtn,
                !!pending && { opacity: 0.6 },
                pressed && { opacity: 0.75 },
              ]}
            >
              {pending === 'reconnect' ? (
                <>
                  <ActivityIndicator size="small" color={U.bg} />
                  <Text style={[T.button, { color: U.bg }]}>Reconnecting…</Text>
                </>
              ) : (
                <>
                  <Text style={[T.button, { color: U.bg }]}>Reconnect</Text>
                  <Icon name="chevron-right" size={16} color={U.bg} />
                </>
              )}
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
          {/* Two cells, and in virtual mode only one of them exists.
              `band.battery` is the *phone's* charge read through expo-battery
              when this phone is standing in for the band, so showing it here
              labelled "Band battery" told the wearer her wristband was at 77%
              when she is not wearing one. The band's row says N/A instead, and
              the phone's own charge gets the row it never had. */}
          <Row
            icon="battery" title="Phone battery"
            sub={virtual ? 'This phone is the safety device' : undefined}
            value={phoneBatt != null ? `${Math.round(phoneBatt)}%` : '—'}
            tone={phoneBatt == null ? U.dim
                  : phoneBatt <= 5 ? U.red
                  : phoneBatt <= 20 ? U.amber : U.mint}
          />
          <View style={r.line} />
          <Row
            icon="battery" title="Band battery"
            sub={virtual ? 'No wristband paired — nothing to report' : undefined}
            value={virtual ? 'N/A'
                   : band?.battery != null ? `${Math.round(band.battery)}%` : '—'}
            tone={!virtual && band?.battery != null && band.battery <= 20 ? U.amber : U.dim}
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
                icon="bell" label="Buzz it" busyLabel="Buzzing…"
                busy={pending === 'buzz'} disabled={!!pending}
                onPress={() => run('buzz', () => band.send?.({ c: 'buzz', n: 2 }))}
              />
              <Action
                icon="x" label="Disconnect" busyLabel="Disconnecting…"
                busy={pending === 'disconnect'} disabled={!!pending}
                onPress={() => run('disconnect', band.disconnect)}
              />
            </>
          ) : virtual ? (
            <Action
              icon="bluetooth" label="Connect a real band" busyLabel="Switching…" filled
              busy={pending === 'mode'} disabled={!!pending}
              onPress={() => run('mode', () => band.chooseMode?.(MODES.BLE))}
            />
          ) : (
            <>
              {/* The band's own scan is the busy signal here -- it outlives this
                  press by seconds, so the link state says "searching" long
                  after `connect` has returned. */}
              {/* `throttled` counts as busy for the same reason `scanning`
                  does -- the app is mid-attempt and the press would do nothing
                  but queue another one. Leaving it pressable is how a wearer
                  helps Android decide this app scans too often. */}
              <Action
                icon="bluetooth" label="Connect to band" busyLabel="Searching…"
                filled
                busy={band?.status === 'scanning' || band?.status === 'connecting'
                      || band?.status === 'throttled' || pending === 'connect'}
                disabled={band?.status === 'scanning' || band?.status === 'connecting'
                          || band?.status === 'throttled' || !!pending}
                onPress={() => run('connect', band?.connect)}
              />
              <Action
                icon="smartphone" label="Use this phone instead" busyLabel="Switching…"
                busy={pending === 'mode'} disabled={!!pending}
                onPress={() => run('mode', () => band?.chooseMode?.(MODES.VIRTUAL))}
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

        {/* The one link failure the app cannot get itself out of. Android will
            not register this app's scanner again until the adapter is reset, so
            the only useful thing to put on screen is how to reset it. */}
        {band?.status === 'bt-stuck' ? (
          <Text style={[T.meta, { color: U.red, marginTop: S.sm }]}>
            Android has stopped letting this app use Bluetooth. Turn Bluetooth
            off and on again — and if the band still does not appear after that,
            force-stop the app and reopen it.
          </Text>
        ) : null}

        {band?.status === 'throttled' ? (
          <Text style={[T.meta, { color: U.amber, marginTop: S.sm }]}>
            Android is rate-limiting Bluetooth scans from this app. Waiting for
            that to lift — the band reconnects on its own, so there is nothing
            to press.
          </Text>
        ) : null}

        {/* ---- what Android has to allow ----
            This shell had no permission screen at all. Notifications were
            asked for by whatever tried to post one, location by the background
            service, and the rest -- the full-screen takeover, the battery
            exemption, the vendor autostart -- were never asked for by anybody,
            because they only existed on the admin console. A wearer with a
            fresh account therefore had an app that looked configured and could
            not ring through a locked phone. */}
        <Section title="PHONE PERMISSIONS" tone={U.mint} />
        {permLoading ? (
          <View style={s.group}>
            <SkeletonGroup label="Checking what Android allows" gap={0}>
              <PermissionRowSkeleton />
              <View style={r.line} />
              <PermissionRowSkeleton />
              <View style={r.line} />
              <PermissionRowSkeleton />
            </SkeletonGroup>
          </View>
        ) : permLeft === 0 ? (
          <View style={s.group}>
            <Row icon="check-circle" title="Everything Nigehban needs is allowed"
                 sub="Re-check it any time — Android switches these off on its own."
                 value="Ready" tone={U.mint}
                 busy={asking === 'recheck'}
                 onPress={recheck} />
          </View>
        ) : (
          <View style={s.group}>
            {ladder.map((row, i) => (
              <React.Fragment key={row.key}>
                {i ? <View style={r.line} /> : null}
                <Row
                  icon={row.granted === true ? 'check-circle' : row.icon}
                  title={row.title}
                  sub={row.granted === true ? undefined
                       : row.blocked ? 'Do the step above first'
                       : row.granted === false ? `Denied — tap to open settings. ${row.why}`
                       : row.why}
                  value={row.granted === true ? 'Allowed' : 'Tap to allow'}
                  tone={row.granted === true ? U.mint : U.amber}
                  busy={asking === row.key}
                  onPress={row.blocked ? undefined : () => askAndRefresh(row.key)}
                />
              </React.Fragment>
            ))}
          </View>
        )}

        {/* The one Android will not prompt for and will not report. A phone
            that stops the app to save power fails silently, weeks later. */}
        <View style={s.group}>
          <Row
            icon="battery-charging" title="Let Nigehban keep running"
            sub={vendor
              ? `${OEM[vendor].label}: ${OEM[vendor].how}`
              : 'Set battery use to unrestricted, or the watch stops when the screen does.'}
            value="Open settings" tone={U.dim}
            busy={asking === 'battery'}
            onPress={() => openSettingsRow('battery', openBatterySettings)}
          />
          {vendor ? (
            <>
              <View style={r.line} />
              <Row
                icon="external-link" title="Allow autostart"
                sub="Your phone's own list, separate from Android's"
                value="Open" tone={U.dim}
                busy={asking === 'autostart'}
                onPress={() => openSettingsRow('autostart',
                  () => openActivity(OEM[vendor].pkg, OEM[vendor].cls))}
              />
            </>
          ) : null}
        </View>

        <Section title="SAFETY" tone={U.mint} />
        <View style={s.group}>
          <Row
            icon="lock" title="Security PIN"
            sub="Asked for before an alert is cancelled, or family is removed"
            value={pinSet ? 'Set' : 'Not set'}
            tone={pinSet ? U.mint : U.amber}
            onPress={() => setSheet(true)}
          />
          {pinSet ? (
            <>
              <View style={r.line} />
              <Row
                icon="rotate-ccw" title="Remove PIN"
                sub="High Alert disarms with one tap again"
                tone={U.dim}
                busy={pinBusy}
                onPress={async () => {
                  if (pinBusy) return;
                  setPinBusy(true);
                  try { await clearPin(); await refreshPin(); } finally { setPinBusy(false); }
                }}
              />
            </>
          ) : null}
        </View>

        <Section title="COMMUNITY & HELPERS" tone={U.mint} />
        <View style={s.group}>
          <Row
            icon="users" title="Good Samaritan Helper"
            sub="Receive emergency requests if someone within 800m needs help"
            value={samaritanEnabled ? 'Participating' : 'Disabled'}
            tone={samaritanEnabled ? U.mint : U.dim}
            busy={samaritanBusy}
            onPress={toggleSamaritan}
          />
        </View>


        <Pressable
          onPress={async () => {
            if (signingOut) return;
            setSigningOut(true);
            try { await onSignOut?.(); } finally { setSigningOut(false); }
          }}
          disabled={signingOut}
          accessibilityRole="button"
          accessibilityState={{ busy: signingOut, disabled: signingOut }}
          style={({ pressed }) => [s.signOut, pressed && { opacity: 0.75 }]}
        >
          {signingOut ? (
            <ActivityIndicator size="small" color={U.dim} />
          ) : (
            <Icon name="log-out" size={16} color={U.dim} />
          )}
          <Text style={[T.button, { color: U.dim }]}>
            {signingOut ? 'Signing out…' : 'Sign out'}
          </Text>
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

/**
 * A band control. Filled is the one thing to do next; the rest are outlines.
 *
 * `busy` swaps the icon for a spinner and the label for `busyLabel`, so the
 * control says which of these it is doing -- "Searching…" and "Switching…" are
 * different waits, and a bare spinner makes them look like the same one.
 */
function Action({ icon, label, busyLabel, onPress, filled, disabled, busy }) {
  const fg = filled ? U.bg : U.dim;
  const inactive = disabled || busy;
  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!inactive, busy: !!busy }}
      style={({ pressed }) => [
        s.action,
        { backgroundColor: filled ? U.mint : U.card },
        inactive && { opacity: 0.5 },
        pressed && { opacity: 0.75 },
      ]}
    >
      {busy
        ? <ActivityIndicator size="small" color={fg} />
        : <Icon name={icon} size={16} color={fg} />}
      <Text style={[T.button, { color: fg }]}>
        {busy ? (busyLabel || label) : label}
      </Text>
    </Pressable>
  );
}

/**
 * A settings row. `busy` replaces the right-hand value with a spinner: these
 * rows hand off to Android, which can take a second to put its dialog up, and
 * a row that does not flinch when tapped gets tapped again.
 */
function Row({ icon, title, sub, value, tone = U.dim, onPress, busy }) {
  const body = (
    <View style={r.row}>
      <View style={r.tile}>
        <Icon name={icon} size={17} color={U.text} />
      </View>
      <View style={r.body}>
        <Text style={r.title}>{title}</Text>
        {sub ? <Text style={r.sub}>{sub}</Text> : null}
      </View>
      {busy ? <ActivityIndicator size="small" color={tone} /> : null}
      {value && !busy ? <Text style={[T.meta, { color: tone }]}>{value}</Text> : null}
      {onPress ? <Icon name="chevron-right" size={16} color={U.faint} /> : null}
    </View>
  );

  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} disabled={!!busy}
               accessibilityRole="button" accessibilityLabel={title}
               accessibilityState={{ busy: !!busy, disabled: !!busy }}
               style={({ pressed }) => pressed && { opacity: 0.7 }}>
      {body}
    </Pressable>
  );
}

/** A settings row before Android has answered what it allows. */
function PermissionRowSkeleton() {
  return (
    <View style={r.row}>
      <Skeleton width={38} height={38} radius={RU.inner} color={U.raised} />
      <View style={[r.body, { gap: 7 }]}>
        <Skeleton width={148} height={14} color={U.raised} />
        <Skeleton width={210} height={10} color={U.raised} />
      </View>
      <Skeleton width={58} height={12} color={U.raised} />
    </View>
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
