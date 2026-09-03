import * as Location from 'expo-location';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import CheckinBanner from '../components/CheckinBanner';
import HighAlertPanel from '../components/HighAlertPanel';
import SosLiveView from '../components/SosLiveView';
import { pendingPermissions } from './Setup';
import { C, S, T, fmtAgo } from '../theme';
import { Banner, Button, Card, Chip, Divider, Icon, Stat, Txt } from '../ui';

// Every status band.js can set needs a line here. The lookup falls back to the
// raw key, which is how `error:Undocumented scan throttle (code 2147483646),
// suggested retry date is ...` ended up on screen as a wristband's status.
const BAND_LABEL = {
  idle: 'Not connected', scanning: 'Searching', connecting: 'Connecting',
  connected: 'Connected', disconnected: 'Lost the band', simulated: 'Simulated',
  virtual: 'This phone is the band',
  'no-permission': 'Bluetooth denied',
  'not-found': 'Band not found',
  throttled: 'Bluetooth busy',
  'bt-stuck': 'Restart Bluetooth',
  'bluetooth-off': 'Bluetooth off',
  'location-off': 'Location off',
  'no-service': 'Band needs re-pairing',
  'no-notify': 'Band not responding',
  // The states the band's PIN introduced. All three mean the radio is fine and
  // a person has to do something, so none of them may read as a fault -- "Band
  // not found" would send somebody looking for a wristband that is six inches
  // away and asking to be let in.
  pairing: 'Pairing with the band',
  authenticating: 'Unlocking the band',
  'needs-pin': 'Band needs its PIN',
  'bad-pin': 'Wrong band PIN',
  'pair-failed': 'Band refused this phone',
  'old-firmware': 'Band needs re-flashing',
};

/**
 * HOME — one question answered above the fold: can she raise an alarm right now?
 *
 * Everything on this screen is ordered by what a frightened person needs
 * first. The SOS control is the largest thing on it and never moves, never
 * scrolls out of reach behind a card, and never changes size when state
 * changes elsewhere. The rest is status: the band, the watch, the battery, the
 * fix — each one written so that a failure reads as a sentence, not a colour.
 */
export default function Home({
  session, band, ctx, deliveredTo, deliveryStatus, onRaise, onResolve, serverOnline,
  onOpenBand, onOpenSetup, onAckCheckin, onToggleHighAlert, onFix,
}) {
  const [fix, setFix] = useState(null);
  const [locState, setLocState] = useState('asking');   // asking|ok|denied|error
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [setupLeft, setSetupLeft] = useState(0);
  // The band's controls all cross a radio link. `bandBusy` holds which one is
  // waiting on it, so the press is answered on the button that was pressed.
  const [bandBusy, setBandBusy] = useState(null);

  // A safety app that has been denied notifications is a safety app that does
  // not work, and nothing else on this screen would say so.
  useEffect(() => {
    let alive = true;
    pendingPermissions().then((n) => { if (alive) setSetupLeft(n); }).catch(() => {});
    return () => { alive = false; };
  }, [refreshing]);

  // Location is requested once and then watched, so an SOS never waits on GPS.
  useEffect(() => {
    let sub;
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') { setLocState('denied'); return; }
        sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, timeInterval: 5000, distanceInterval: 5 },
          (p) => {
            const next = { lat: p.coords.latitude, lon: p.coords.longitude,
                           acc: p.coords.accuracy, at: Date.now() };
            setFix(next);
            setLocState('ok');
            onFix?.(next);
          });
      } catch {
        setLocState('error');
      }
    })();
    return () => sub?.remove();
  }, [onFix]);

  const fire = useCallback(async (kind, source) => {
    setBusy(true);
    try {
      await onRaise({ kind, source, lat: fix?.lat, lon: fix?.lon, accuracy: fix?.acc });
    } finally {
      setBusy(false);
    }
  }, [fix, onRaise]);

  const runBand = useCallback(async (key, fn) => {
    if (bandBusy) return;
    setBandBusy(key);
    try { await fn?.(); } catch { /* the chip above reports the link state */ }
    finally { setBandBusy(null); }
  }, [bandBusy]);

  const bandTone =
    band.status === 'connected' ? C.green
    : band.status === 'virtual' || band.simulated ? C.amber
    // Waiting out Android's scan throttle is a pause, not a fault -- the link
    // comes back on its own -- so it must not read like a band that is gone.
    : band.status === 'throttled' || band.status === 'authenticating'
      || band.status === 'pairing' ? C.amber
    : band.status === 'disconnected' || band.status === 'no-permission'
      || band.status === 'not-found' || band.status === 'bt-stuck'
      || band.status === 'bluetooth-off' || band.status === 'location-off'
      || band.status === 'needs-pin' || band.status === 'bad-pin'
      || band.status === 'pair-failed' || band.status === 'old-firmware' ? C.red
    : C.dim;

  const batt = ctx.battery;

  return (
    <ScrollView
      contentContainerStyle={s.wrap}
      refreshControl={
        <RefreshControl refreshing={refreshing} tintColor={C.green}
          onRefresh={() => { setRefreshing(true); setTimeout(() => setRefreshing(false), 600); }} />
      }
    >
      {/* ---- things that are wrong, before anything else ---- */}
      {!serverOnline ? (
        <Banner tone={C.red} icon="wifi-off" title="Not connected to the server">
          Alerts raised now will not reach anybody. Check the address on the sign-in
          screen — a tunnel URL changes every time the laptop restarts.
        </Banner>
      ) : null}

      {setupLeft > 0 ? (
        <Banner tone={C.amber} icon="settings"
                title={`${setupLeft} permission${setupLeft === 1 ? '' : 's'} still missing`}>
          <>
            <Text style={[T.meta, { color: C.dim }]}>
              Until these are granted, parts of the watch cannot run — and Android
              will not ask you again on its own.
            </Text>
            <View style={{ marginTop: S.sm }}>
              <Button title="FINISH SETUP" icon="arrow-right" onPress={onOpenSetup} />
            </View>
          </>
        </Banner>
      ) : null}

      {batt.goingDark ? (
        <Banner tone={C.red} icon="battery" title="This phone is about to die">
          Your family has been told where you were. Charge it, or tell someone
          where you are going while you still can.
        </Banner>
      ) : batt.low ? (
        <Banner tone={C.amber} icon="battery" title={`Battery at ${Math.round(batt.level)}%`}>
          Your family has been warned. Below 5% the watch stops being able to help.
        </Banner>
      ) : null}

      {/* ---- an open question ---- */}
      {ctx.checkin ? <CheckinBanner checkin={ctx.checkin} onAck={onAckCheckin} /> : null}

      {/* ---- the one control that matters ---- */}
      {ctx.activeSos ? (
        <SosLiveView alert={ctx.activeSos} deliveredTo={deliveredTo}
                     deliveryStatus={deliveryStatus}
                     responders={ctx.responders} busy={busy}
                     fix={fix} onStandDown={onResolve} />
      ) : (
        <Pressable
          onLongPress={() => fire('sos', 'app')}
          delayLongPress={600}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Raise an SOS. Press and hold."
          style={({ pressed }) => [s.sos, pressed && { backgroundColor: C.red }]}
        >
          {({ pressed }) => (
            <>
              {busy ? (
                <ActivityIndicator size="large" color={C.red} />
              ) : (
                <Icon name="alert-octagon" size={30} color={pressed ? C.bg : C.red} />
              )}
              <Text style={[s.sosGlyph, pressed && { color: C.bg }]}>SOS</Text>
              <Text style={[s.sosHint, pressed && { color: C.bg }]}>
                {busy ? 'Sending…' : 'Press and hold for a second'}
              </Text>
            </>
          )}
        </Pressable>
      )}

      {/* ---- the mode ---- */}
      <HighAlertPanel isArmed={ctx.highAlert} nextBuzzAt={ctx.nextBuzzAt}
                      onToggle={onToggleHighAlert} />

      {/* ---- the band ---- */}
      <Card>
        <View style={s.row}>
          <Txt variant="h2">Wristband</Txt>
          {/* Feather has no `bluetooth-off`, so every render of a band that was
              not connected logged a warning -- and while the link was failing
              that was most of them. `slash` is the set's own "not available". */}
          <Chip text={BAND_LABEL[band.status] || band.status} tone={bandTone}
                icon={band.status === 'connected' ? 'bluetooth' : 'slash'} />
        </View>

        <View style={s.stats}>
          {/* In virtual mode `band.battery` is this phone read through
              expo-battery -- the stand-in for the band's ADC pin. Showing it
              under "Band battery" reported a wristband cell that does not
              exist, which is the same conflation migration 002 fixed on the
              family side. There is no band here, so the honest value is N/A;
              the phone's own charge is on the banner above. */}
          <Stat label="Band battery" icon="battery"
                value={band.status === 'virtual' ? 'N/A'
                       : band.battery != null ? `${Math.round(band.battery)}%` : '—'}
                sub={band.status === 'virtual' ? 'phone is the band' : undefined}
                tone={band.status === 'virtual' ? C.dim
                      : band.battery == null ? C.dim
                      : band.battery <= 5 ? C.red
                      : band.battery <= 20 ? C.amber : C.text} />
          <Stat label="Anti-snatch" icon={band.armed ? 'lock' : 'unlock'}
                value={band.armed ? 'Armed' : 'Off'}
                tone={band.armed ? C.green : C.dim} />
          <Stat label="Last heard" icon="activity"
                value={band.lastSeen ? fmtAgo(band.lastSeen / 1000) : '—'}
                tone={C.text} />
        </View>

        {band.status === 'virtual' ? (
          <>
            <Divider />
            <Text style={[T.meta, { color: C.dim }]}>
              No wristband here, so this phone is running the band firmware itself —
              the same gestures, the same events on the wire.
            </Text>
            <Button title="OPEN BAND CONSOLE" icon="terminal" onPress={onOpenBand} />
          </>
        ) : band.status === 'connected' ? (
          <View style={s.btnRow}>
            <View style={{ flex: 1 }}>
              <Button title="BUZZ IT" icon="bell" tone={C.dim}
                      loading={bandBusy === 'buzz'}
                      disabled={!!bandBusy && bandBusy !== 'buzz'}
                      onPress={() => runBand('buzz', () => band.send({ c: 'buzz', n: 2 }))} />
            </View>
            <View style={{ flex: 1 }}>
              <Button title="DISCONNECT" icon="x" tone={C.dim}
                      loading={bandBusy === 'disconnect'}
                      disabled={!!bandBusy && bandBusy !== 'disconnect'}
                      onPress={() => runBand('disconnect', band.disconnect)} />
            </View>
          </View>
        ) : band.status === 'no-permission' ? (
          <>
            <Text style={[T.meta, { color: C.amber }]}>
              Bluetooth permission was denied, so the band cannot be found.
            </Text>
            <Button title="FIX THIS IN SETUP" icon="settings" onPress={onOpenSetup} />
          </>
        ) : (
          /* Scanning outlives the press by seconds, so the link state is the
             honest busy signal here -- not the promise `connect` returns. */
          <Button title="CONNECT TO BAND" filled icon="bluetooth"
                  loading={bandBusy === 'connect' || band.status === 'scanning'
                           || band.status === 'connecting'
                           || band.status === 'pairing'
                           || band.status === 'authenticating'}
                  onPress={() => runBand('connect', band.connect)} />
        )}
      </Card>

      {/* ---- location ---- */}
      <Card>
        <View style={s.row}>
          <Txt variant="h2">Your location</Txt>
          <Chip text={locState === 'ok' ? 'live' : locState === 'denied' ? 'denied' : 'waiting'}
                tone={locState === 'ok' ? C.green : locState === 'denied' ? C.red : C.amber}
                icon="map-pin" />
        </View>

        {locState === 'ok' && fix ? (
          <>
            <Text style={[T.number, { color: C.text }]}>
              {fix.lat.toFixed(5)}, {fix.lon.toFixed(5)}
            </Text>
            <Text style={[T.meta, { color: C.faint }]}>
              Accurate to about {Math.round(fix.acc)} m · updated {fmtAgo(fix.at / 1000)}.
              This is attached to every alert you raise, so your family gets a map
              pin rather than a guess.
            </Text>
          </>
        ) : locState === 'denied' ? (
          <>
            <Text style={[T.meta, { color: C.amber }]}>
              Without location, an alert says that something happened but not where.
              It is the single most useful thing you can turn on.
            </Text>
            <Button title="TURN LOCATION ON" icon="map-pin" onPress={onOpenSetup} />
          </>
        ) : (
          <Text style={[T.meta, { color: C.dim }]}>
            {locState === 'error'
              ? 'Location is unavailable on this device.'
              : 'Waiting for a fix from the phone…'}
          </Text>
        )}
      </Card>

      <Text style={s.foot}>Signed in as {session.name} · {session.user_id}</Text>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  wrap: { padding: S.lg, gap: S.md, paddingBottom: 40 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: S.sm },
  stats: { flexDirection: 'row', gap: S.md },
  btnRow: { flexDirection: 'row', gap: S.md },

  sos: {
    backgroundColor: C.redSoft, borderRadius: 8, paddingVertical: 36,
    alignItems: 'center', gap: S.sm,
  },
  sosGlyph: { ...T.display, color: C.red, fontSize: 46, letterSpacing: 4 },
  sosHint: { ...T.meta, color: C.dim },

  foot: { ...T.meta, color: C.faint, textAlign: 'center', marginTop: S.sm },
});
