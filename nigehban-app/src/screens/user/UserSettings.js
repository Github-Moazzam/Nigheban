import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, AppState, Pressable, ScrollView, StyleSheet, Text,
  TextInput, View,
} from 'react-native';
import { fetchBandPin, saveSession, updateUserSettings } from '../../api';
import { MODES } from '../../bandLink';

import PinSheet from '../../components/PinSheet';
import Dialog from './Dialog';
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
  // The states the band's PIN introduced. None of them is a fault -- the radio
  // is fine and a person has to do something -- so none may read like one.
  pairing: 'Pairing…', authenticating: 'Unlocking…',
  'needs-pin': 'Needs its PIN', 'bad-pin': 'Wrong PIN',
  'pair-failed': 'Band refused this phone', 'old-firmware': 'Needs re-flashing',
  'locked-out': 'Locked — too many PINs',
};

/**
 * The band is waiting on six digits, and only a person can supply them.
 *
 * This is the second of the two prompts on the way to a linked band. The first
 * is Android's own passkey dialog, which the OS raises and this app can neither
 * draw nor influence. This one is the band asking again over the encrypted
 * link, because a bond proves the phone paired once and not that it still
 * should be here.
 *
 * It has to be on THIS screen. Connecting the band happens here, so a status
 * row that says "Needs its PIN" with nothing to type into is a dead end -- the
 * exact dead end this screen shipped with, and the reason a wearer could get
 * stuck with a band that was six inches away and merely asking to be let in.
 */
const NEEDS_PIN = new Set(['needs-pin', 'bad-pin']);

/** The recovery dialog's three non-answers; anything else is the PIN itself. */
const RECOVER_TONE = { offline: U.amber, none: U.amber, loading: U.mint };

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
  // Which of the band's two settings is open, if either. One at a time: they
  // sit inside the same group and two expanded panels push the rest of the
  // screen somewhere nobody expected it to go.
  const [editing, setEditing] = useState(null);
  const [confirmDrop, setConfirmDrop] = useState(false);
  // The forgotten-PIN path: 'ask' while the disarm gate is up, then the six
  // digits themselves once it has been passed. Never held in state before that.
  const [recover, setRecover] = useState(null);
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
      if (session) {
        session.samaritan_enabled = next;
        // The server has it now, but a reload reads the phone's own cached
        // session, not the server -- so without this the switch snaps back
        // to Participating the moment the page (or the app) reopens.
        await saveSession(session);
      }
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

        {NEEDS_PIN.has(band?.status) ? (
          /* The band is right there and asking to be let in. Offering
             "Reconnect" here would be offering the one button that cannot
             help -- the link is already up, it is the six digits that are
             missing -- so this replaces the notice rather than sitting under
             it. */
          <View style={s.notice}>
            <View style={s.noticeHead}>
              <View style={s.noticeMark}>
                <Icon name="lock" size={17} color={U.amber} />
              </View>
              <Text style={[T.h2, { color: U.amber, flex: 1 }]}>
                The band wants its PIN
              </Text>
            </View>
            <Text style={[T.meta, { color: U.dim }]}>
              {band?.status === 'bad-pin'
                ? 'Those six digits were not right. Try again — this is the same '
                  + 'PIN Android asked for when it paired.'
                : 'Your wristband is paired but locked. Type the same six digits '
                  + 'Android asked for. You only do this once on this phone.'}
            </Text>
            <BandPinAsk wrong={band?.status === 'bad-pin'}
                        onForgot={() => setRecover('ask')}
                        onSubmit={(pin) => band?.submitPin?.(pin)} />
          </View>
        ) : !linked ? (
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

          {/* ---- the two things about the band that are hers to change ------
              Only while it is actually connected: both are commands written to
              the wristband, so offering them against a band that is not there
              would be offering a control that silently does nothing. */}
          {linked ? (
            <>
              <Row
                icon="edit-3" title="Band name"
                sub="Shown here, and in your phone's Bluetooth list"
                value={band?.bandName || '—'}
                onPress={() => setEditing(editing === 'name' ? null : 'name')}
              />
              {editing === 'name' ? (
                <NameEditor
                  current={band?.bandName}
                  onCancel={() => setEditing(null)}
                  onSave={async (n) => {
                    const okDone = await band?.renameBand?.(n);
                    if (okDone) setEditing(null);
                    return okDone;
                  }}
                />
              ) : null}
              <View style={r.line} />
            </>
          ) : null}

          {/* The PIN row is gated on `canSetPin` as well, because when this
              phone IS the band there is nobody to keep out and a lock that
              locks nothing is worse than no lock on the screen. */}
          {/* Shown whenever a real band is the chosen radio, connected or not.
              Gating this on `linked` put the only route to "I have forgotten
              it" behind being connected -- which is precisely what a forgotten
              PIN prevents. Changing a PIN still needs the band present, because
              it is a command written to it; looking one up does not, because it
              comes from the account. So the row is always here and the panel
              offers whichever of the two is actually possible. */}
          {!virtual && band?.canSetPin !== false ? (
            <>
              <Row
                icon="key" title="Band PIN"
                sub={!linked
                  ? 'Connect the band to change it — or tap to look it up'
                  : band?.defaultPin
                    ? 'Still the factory PIN — anyone who knows it can pair'
                    : 'Asked for once on each phone you link'}
                value={!linked ? 'Forgot it?'
                       : band?.defaultPin ? 'Change it' : '••••••'}
                tone={band?.defaultPin && linked ? U.amber : U.dim}
                onPress={() => {
                  // With no band on the other end there is nothing to change,
                  // so the tap goes straight to the only useful action.
                  if (!linked) { setRecover('ask'); return; }
                  setEditing(editing === 'pin' ? null : 'pin');
                }}
              />
              {editing === 'pin' && linked ? (
                <PinEditor
                  onCancel={() => setEditing(null)}
                  onForgot={() => setRecover('ask')}
                  onSave={async (op, np) => {
                    const okDone = await band?.changePin?.(op, np);
                    if (okDone) setEditing(null);
                    return okDone;
                  }}
                />
              ) : null}
              <View style={r.line} />
            </>
          ) : null}

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
                onPress={() => setConfirmDrop(true)}
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
                      || band?.status === 'throttled' || band?.status === 'pairing'
                      || band?.status === 'authenticating' || pending === 'connect'}
                disabled={band?.status === 'scanning' || band?.status === 'connecting'
                          || band?.status === 'throttled' || band?.status === 'pairing'
                          || band?.status === 'authenticating' || !!pending}
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
            sub={samaritanEnabled
              ? 'On — strangers within 800m may ask for your help, and your own SOS will ask whether to include them too'
              : 'Off — you will not be asked to help strangers, and your own SOS goes straight to family only, with no prompt'}
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

      {/* Unlinking on purpose now costs the PIN on the way back -- see
          disconnect() in band.js. That is the point of it, and it is exactly
          why it cannot be a button that just happens. A band that walked out of
          range is not this: that comes back on its own and never asks. */}
      <Dialog
        visible={confirmDrop}
        tone={U.amber}
        icon="unlock"
        title="Unlink the wristband?"
        body={'Fall detection and the SOS key stop working until you link it '
              + 'again — and this phone will forget the band’s PIN, so you '
              + 'will need those six digits to reconnect.'}
        note="Losing signal or walking out of range does none of this. The band comes back on its own."
        actions={[
          {
            label: 'Unlink it', busyLabel: 'Disconnecting…', icon: 'x', danger: true,
            onPress: async () => {
              await run('disconnect', band.disconnect);
              setConfirmDrop(false);
            },
          },
          { label: 'Keep it linked', icon: 'check', onPress: () => setConfirmDrop(false) },
        ]}
        onClose={() => setConfirmDrop(false)}
      />

      <PinSheet
        visible={sheet}
        mode="set"
        onCancel={() => setSheet(false)}
        onDone={() => { setSheet(false); refreshPin(); }}
      />

      {/* ---- a forgotten band PIN ---------------------------------------
          This phone is still linked, so it is still holding the six digits in
          the keystore. Showing them to whoever is holding the handset would be
          careless, so the disarm PIN stands in front -- the gate this app
          already uses for "prove you are the owner of this phone".
          It gives away nothing an attacker with this unlocked, signed-in phone
          could not already do: the band is linked and obeys it. What it saves
          is the alternative, which is a factory reset and re-pairing every
          phone in the family. */}
      <PinSheet
        visible={recover === 'ask'}
        mode={pinSet ? 'verify' : 'set'}
        title={pinSet ? 'Enter your PIN to see the band PIN' : 'Choose a PIN first'}
        body={pinSet
          ? 'This is your four-digit app PIN, not the band’s six.'
          : 'You have no app PIN yet, and it is what protects the band’s. '
            + 'Choose one now and the band PIN will be shown.'}
        wrongNote="Wrong PIN."
        lockedNote="Too many attempts. The band PIN stays hidden."
        onCancel={() => setRecover(null)}
        onDone={async () => {
          await refreshPin();
          setRecover('loading');
          // The ACCOUNT, not the keystore. The phone deliberately forgets the
          // band PIN when somebody presses Disconnect, so the local copy is
          // gone in exactly the situation this screen exists for. The account's
          // copy is written every time the band accepts a PIN, and a PIN change
          // is refused without a network so the two cannot drift apart.
          try {
            const stored = await fetchBandPin(session);
            setRecover(stored || 'none');
          } catch {
            setRecover('offline');
          }
        }}
      />

      <Dialog
        visible={!!recover && recover !== 'ask'}
        loading={recover === 'loading'}
        loadingLabel="Asking your account…"
        tone={RECOVER_TONE[recover] || U.mint}
        icon={recover === 'offline' ? 'wifi-off'
              : recover === 'none' ? 'alert-circle' : 'key'}
        title={recover === 'offline' ? 'No connection'
               : recover === 'none' ? 'Your account does not have it'
               : 'Your band PIN'}
        body={recover === 'offline'
          ? 'Your band PIN is kept on your account, not on this phone — the '
            + 'phone forgets it whenever you disconnect the band. Getting it '
            + 'back needs an internet connection. Try again when you have signal.'
          : recover === 'none'
            ? 'No band PIN has ever been saved to your account, so there is '
              + 'nothing to give you. The band itself is the way back — hold '
              + 'its button down while it restarts, keep holding for five '
              + 'seconds, and its name and PIN go back to factory. Then forget '
              + 'the band in Android’s Bluetooth settings before linking again.'
            : recover}
        note={recover === 'offline' || recover === 'none' || recover === 'loading'
          ? undefined
          : 'Write it somewhere safe. If the band refuses it, it was changed on '
            + 'another phone that had no signal at the time — reset the band '
            + 'with its own button.'}
        actions={recover === 'loading' ? [] : [
          { label: 'Done', icon: 'check', onPress: () => setRecover(null) },
        ]}
        onClose={() => setRecover(null)}
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
/**
 * Renaming the band, from the screen the wearer actually uses.
 *
 * Worth being plain about what this changes, because it is not what "device
 * name" usually means in an app: it is written into the wristband's own memory
 * and broadcast, so her phone's Bluetooth list and every other phone in the
 * family follow it. The band's reply is what closes the panel -- closing on the
 * strength of the write alone would show a rename the band may have refused.
 */
function NameEditor({ current, onCancel, onSave }) {
  const [draft, setDraft] = useState(current || '');
  const [busy, setBusy] = useState(false);

  const n = draft.trim();
  const ok = n.length >= 1 && n.length <= 20 && !/["\\]/.test(n) && n !== current;

  return (
    <View style={p.panel}>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        placeholder="e.g. Ayesha's band"
        placeholderTextColor={U.faint}
        maxLength={20}
        autoFocus
        accessibilityLabel="Band name"
        style={p.text}
      />
      <Text style={[T.meta, { color: U.faint }]}>
        Up to 20 characters. Stored on the wristband, so your Bluetooth list and
        the rest of your family see it too.
      </Text>
      <View style={p.row}>
        <View style={{ flex: 1 }}>
          <Action icon="check" label="Save" busyLabel="Saving…" filled
                  busy={busy} disabled={!ok || busy}
                  onPress={async () => {
                    setBusy(true);
                    try { await onSave?.(n); } finally { setBusy(false); }
                  }} />
        </View>
        <View style={{ flex: 1 }}>
          <Action icon="x" label="Cancel" disabled={busy} onPress={onCancel} />
        </View>
      </View>
    </View>
  );
}

/**
 * Changing the six digits.
 *
 * Typed twice, because getting this wrong is expensive in a way almost nothing
 * else on this screen is: the band takes the new PIN whether or not she meant
 * it, and the only way back from a PIN nobody knows is holding the wristband's
 * button down while it restarts.
 *
 * Every other phone in the family is asked for the new one the next time it
 * links. That is the feature, not a side effect -- it is how a phone is
 * revoked without anybody touching Android's Bluetooth settings.
 */
function PinEditor({ onCancel, onSave, onForgot }) {
  const [current, setCurrent] = useState('');
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = /^\d{6}$/.test(current) && /^\d{6}$/.test(pin) && pin === again;

  return (
    <View style={p.panel}>
      {/* Typed, never filled in from the keystore.
          The band checks this, and the check is only worth anything if a PERSON
          supplied the answer. Pre-filling it would mean anybody holding this
          phone unlocked could change the PIN and lock the real owner out of
          their own band -- which is the exact thing a PIN is for. */}
      <TextInput
        value={current}
        onChangeText={(t) => setCurrent(t.replace(/\D/g, '').slice(0, 6))}
        placeholder="current PIN"
        placeholderTextColor={U.faint}
        keyboardType="number-pad" maxLength={6} secureTextEntry autoFocus
        accessibilityLabel="Current band PIN"
        style={p.input}
      />
      <Pressable onPress={onForgot} hitSlop={8} accessibilityRole="button"
                 accessibilityLabel="I have forgotten the band PIN">
        <Text style={[T.meta, { color: U.mint }]}>I have forgotten it</Text>
      </Pressable>

      <View style={p.rule} />

      <TextInput
        value={pin}
        onChangeText={(t) => setPin(t.replace(/\D/g, '').slice(0, 6))}
        placeholder="new PIN"
        placeholderTextColor={U.faint}
        keyboardType="number-pad" maxLength={6} secureTextEntry
        accessibilityLabel="New band PIN, six digits"
        style={p.input}
      />
      <TextInput
        value={again}
        onChangeText={(t) => setAgain(t.replace(/\D/g, '').slice(0, 6))}
        placeholder="once more"
        placeholderTextColor={U.faint}
        keyboardType="number-pad" maxLength={6} secureTextEntry
        accessibilityLabel="Repeat the new band PIN"
        style={[p.input, again && pin !== again ? { borderColor: U.red } : null]}
      />
      <Text style={[T.meta, { color: again && pin !== again ? U.red : U.faint }]}>
        {again && pin !== again
          ? 'Those two do not match.'
          : 'Six digits. This phone remembers the new one straight away; every '
            + 'OTHER phone linked to this band has to be told it.'}
      </Text>
      <View style={p.row}>
        <View style={{ flex: 1 }}>
          <Action icon="lock" label="Set it" busyLabel="Saving…" filled
                  busy={busy} disabled={!ok || busy}
                  onPress={async () => {
                    setBusy(true);
                    try { await onSave?.(current, pin); } finally { setBusy(false); }
                  }} />
        </View>
        <View style={{ flex: 1 }}>
          <Action icon="x" label="Cancel" disabled={busy} onPress={onCancel} />
        </View>
      </View>
    </View>
  );
}

/** Six digits, in this shell's own kit rather than the console's. */
function BandPinAsk({ wrong, onSubmit, onForgot }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = /^\d{6}$/.test(pin);

  return (
    <View style={{ gap: S.md }}>
      <TextInput
        value={pin}
        onChangeText={(t) => setPin(t.replace(/\D/g, '').slice(0, 6))}
        placeholder="******"
        placeholderTextColor={U.faint}
        keyboardType="number-pad"
        maxLength={6}
        secureTextEntry
        autoFocus
        accessibilityLabel="Band PIN, six digits"
        style={[p.input, wrong && { borderColor: U.red }]}
      />
      <Action
        icon="unlock" label="Unlock the band" busyLabel="Unlocking…" filled
        busy={busy} disabled={!ok || busy}
        onPress={async () => {
          setBusy(true);
          try { await onSubmit?.(pin); } finally { setBusy(false); }
        }}
      />
      {/* THE screen a person with a forgotten PIN is looking at.
          The way out used to live only inside the change-PIN panel, which only
          renders while the band is connected -- so it was reachable exactly
          when it was not needed, and gone the moment it was. Somebody who has
          forgotten the PIN cannot connect; this is where they end up, so this
          is where the way out belongs. */}
      <Pressable onPress={onForgot} hitSlop={8} accessibilityRole="button"
                 accessibilityLabel="I have forgotten the band PIN">
        <Text style={[T.meta, { color: U.mint }]}>I have forgotten it</Text>
      </Pressable>
    </View>
  );
}

const p = StyleSheet.create({
  panel: { gap: S.md, paddingHorizontal: S.lg, paddingBottom: S.lg, paddingTop: S.sm },
  rule: { height: 1, backgroundColor: U.line, marginVertical: 2 },
  row: { flexDirection: 'row', gap: S.md },
  text: {
    backgroundColor: U.raised,
    borderRadius: RU.inner,
    borderWidth: 1,
    borderColor: U.line,
    color: U.text,
    paddingHorizontal: S.lg,
    minHeight: 52,
    fontSize: 16,
  },
  input: {
    backgroundColor: U.raised,
    borderRadius: RU.inner,
    borderWidth: 1,
    borderColor: U.line,
    color: U.text,
    paddingHorizontal: S.lg,
    minHeight: 52,
    fontSize: 20,
    letterSpacing: 8,
    textAlign: 'center',
  },
});

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
