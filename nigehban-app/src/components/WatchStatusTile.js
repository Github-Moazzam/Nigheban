import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { C, S, T } from '../theme';
import { Chip, Icon, Label } from '../ui';

const SILENT_S = 180;   // the server's BEAT_LOST_S; the tile must agree with it

/**
 * U4.2 — is her watch actually running?
 *
 * A family member's real question is not "is she okay" but "would I be told if
 * she were not". This tile answers that one: the band link, both batteries, and
 * the age of the last heartbeat. Three minutes of silence turns it amber at the
 * same moment the server decides the same thing (matrix #19), so the screen and
 * the sweeper never disagree in front of a user.
 *
 * The two batteries are shown apart because they fail apart, and the tile used
 * to conflate them: `phone_batt` carried the *band's* reading and was labelled
 * as the phone's, so this tile said "Phone battery 4%" about a wristband. The
 * band's now sits beside the band's own link status, where it is unambiguous.
 */
export default function WatchStatusTile({ watchState = {}, isVirtual, style }) {
  const { mode = 'idle', band_link: bandLink = false,
          band_virtual: bandVirtual = false,
          phone_batt: batt = null, band_batt: bandBatt = null,
          last_beat: lastBeat = null } = watchState;

  // The server says which device this is (migration 003). The prop is kept for
  // callers that already knew locally, but it is no longer the only source --
  // a phone standing in for a band still reports band_link=true, so callers
  // were guessing from that and guessing wrong.
  const virtual = isVirtual ?? bandVirtual;

  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 15000);
    return () => clearInterval(id);
  }, []);

  const age = lastBeat ? Math.max(0, Math.floor(Date.now() / 1000 - lastBeat)) : null;
  const silent = age !== null && age > SILENT_S;

  // The band's charge rides on the band's own row. A null is "not reported"
  // -- virtual mode has no second cell, and an older build sends none -- which
  // must not read as a band at zero.
  //
  // Virtual is checked before the link, not after it. A phone standing in for
  // a band reports band_link=true, so the old order fell into the first branch
  // and drew a wristband battery that did not exist.
  const link = virtual
    ? { text: 'phone as band', sub: 'Band battery N/A', tone: C.dim }
    : bandLink
      ? { text: bandBatt == null ? 'connected' : `connected · ${bandBatt}%`,
          sub: bandBatt == null ? 'battery not reported yet' : null,
          tone: bandBatt != null && bandBatt <= 20 ? C.amber : C.green }
      : { text: 'no band', sub: null, tone: C.amber };

  const battTone = batt == null ? C.dim
                 : batt <= 5 ? C.red
                 : batt <= 20 ? C.amber
                 : C.green;

  const health = silent ? { text: 'not reporting', tone: C.amber, icon: 'wifi-off' }
               : age === null ? { text: 'no beat yet', tone: C.faint, icon: 'clock' }
               : { text: 'reporting', tone: C.green, icon: 'activity' };

  return (
    <View style={[s.wrap, style]}>
      <View style={s.head}>
        <Label>Watch health</Label>
        <Chip text={health.text} tone={health.tone} icon={health.icon} />
      </View>

      <View style={s.row}>
        <Metric label="Band" value={link.text} sub={link.sub} tone={link.tone} />
        <Metric label="Phone battery" value={batt == null ? '—' : `${batt}%`} tone={battTone} />
        <Metric label="High alert"
                value={mode === 'high_alert' ? 'Armed' : mode === 'sos' ? 'SOS' : 'Off'}
                tone={mode === 'sos' ? C.red : mode === 'high_alert' ? C.green : C.dim} />
      </View>

      <View style={s.foot}>
        <Icon name={silent ? 'alert-triangle' : 'radio'} size={13}
              color={silent ? C.amber : C.faint} />
        <Text style={[T.meta, { color: silent ? C.amber : C.faint, flex: 1 }]}>
          {age === null ? 'Waiting for the first heartbeat.'
            : silent ? `Silent for ${Math.floor(age / 60)} minutes — her phone or the service may have been stopped.`
            : `Last heartbeat ${age}s ago.`}
        </Text>
      </View>
    </View>
  );
}

function Metric({ label, value, sub, tone }) {
  return (
    <View style={s.metric}>
      <Label>{label}</Label>
      <Text style={[T.title, { color: tone }]} numberOfLines={1}>{value}</Text>
      {sub ? (
        <Text style={[T.meta, { color: C.faint }]} numberOfLines={1}>{sub}</Text>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { backgroundColor: C.raised, borderRadius: 6, padding: S.md, gap: S.md },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  row: { flexDirection: 'row', gap: S.md },
  metric: { flex: 1, gap: 4 },
  foot: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
