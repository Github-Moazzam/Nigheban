import React, { useMemo } from 'react';
import {
  Platform, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { MODES } from '../bandLink';
import { C, MONO, fmtAgo } from '../theme';
import { Button, Card, Label, Pill, Stat } from '../ui';
import { HOLD_1_MS } from '../virtualBand';

const mono = Platform.select(MONO);

/**
 * THE BAND CONSOLE.
 *
 * A stand-in for hardware that is deliberately *not* a row of shortcuts. The
 * big key runs the real gesture engine — you have to actually double-tap to
 * raise an SOS and actually hold for three seconds to arm High Alert — the point
 * is to find out today whether those gestures are usable by a frightened
 * person, while changing them still costs nothing.
 *
 * The log at the bottom is the wire. Every line in it is exactly what would
 * have crossed the BLE characteristic.
 */
export default function Band({ band, serverOnline }) {
  const v = band.virtual;
  const virtual = band.mode === MODES.VIRTUAL;

  // How far the finger is through the one hold threshold there is.
  const holdPhase = useMemo(() => {
    if (!v?.holding) return null;
    if (v.holdMs >= HOLD_1_MS) {
      return { label: 'HIGH ALERT TOGGLED — LET GO', pct: 1, tone: C.amber };
    }
    return { label: 'HOLD FOR HIGH ALERT', pct: v.holdMs / HOLD_1_MS, tone: C.green };
  }, [v?.holding, v?.holdMs]);

  return (
    <ScrollView contentContainerStyle={s.wrap}>
      {/* ---- which radio ---- */}
      <Card>
        <View style={s.row}>
          <Label>Band source</Label>
          <Pill text={serverOnline ? 'server ok' : 'server offline'}
                tone={serverOnline ? C.green : C.alarm} />
        </View>
        <View style={s.modeRow}>
          <ModeTab
            active={virtual} label="THIS PHONE"
            sub="no hardware needed"
            onPress={() => band.chooseMode(MODES.VIRTUAL)} />
          <ModeTab
            active={!virtual} label="REAL BAND"
            sub={band.bleAvailable ? 'over bluetooth' : 'needs the dev build'}
            onPress={() => band.chooseMode(MODES.BLE)} />
        </View>
        <Text style={s.note}>
          {virtual
            ? 'This phone is running the band firmware in JavaScript — the same '
              + 'gesture engine, the same event JSON. The server cannot tell the '
              + 'difference, so everything downstream of the band is under test.'
            : 'Scanning for a physical Nigehban-01 over Bluetooth. Switch back to '
              + 'THIS PHONE if you have no band with you.'}
        </Text>
      </Card>

      {virtual && v ? (
        <>
          {/* ---- the key ---- */}
          <Card>
            <Label>Key A — the band&apos;s only button</Label>

            <View style={s.keyWrap}>
              <Pressable
                onPressIn={() => v.onPressIn(1)}
                onPressOut={() => v.onPressOut(1)}
                style={({ pressed }) => [
                  s.key,
                  pressed && { backgroundColor: C.raised, borderColor: C.green },
                  v.buzzing && { borderColor: C.amber },
                ]}
              >
                <Text style={s.keyGlyph}>{v.buzzing ? '≈' : '●'}</Text>
                <Text style={s.keyHint}>
                  {v.holding ? `${(v.holdMs / 1000).toFixed(1)}s` : 'press'}
                </Text>
              </Pressable>
            </View>

            {/* hold progress: the cue the motor gives on the real band */}
            <View style={s.holdTrack}>
              <View style={[
                s.holdFill,
                {
                  width: `${Math.round((holdPhase?.pct ?? 0) * 100)}%`,
                  backgroundColor: holdPhase?.tone ?? 'transparent',
                },
              ]} />
            </View>
            <Text style={[s.holdLabel, holdPhase && { color: holdPhase.tone }]}>
              {holdPhase?.label ?? 'idle'}
            </Text>

            <View style={s.legend}>
              <LegendRow g="1 tap" m="I'm fine — answers a check-in, or stands down a live SOS" />
              <LegendRow g="2+ taps" m="SOS — three or four taps work too, on purpose" tone={C.alarm} />
              <LegendRow g="hold 3s" m={v.highAlert ? 'turn High Alert off' : 'turn High Alert on'} />
            </View>

            <Text style={s.note}>
              Two gestures, on purpose. Taps are grouped into a burst — the
              gesture fires once you stop tapping, so tap deliberately rather
              than fast. Holding past 3 s does nothing further; anti-snatch is
              a v2 feature and nothing is bound to a longer hold.
            </Text>
          </Card>

          {/* ---- second key + manual events ---- */}
          <Card>
            <Label>Prototype extras</Label>
            <View style={s.btnRow}>
              <View style={s.cell}>
                <Pressable
                  onPressIn={() => v.onPressIn(2)}
                  onPressOut={() => v.onPressOut(2)}
                  style={({ pressed }) => [s.keyB, pressed && { backgroundColor: C.alarmBg }]}
                >
                  <Text style={s.keyBText}>KEY B — SOS</Text>
                </Pressable>
              </View>
              <View style={s.cell}>
                <Button title="FORCE FALL" tone={C.amber}
                        onPress={() => v.trigger('fall', { peak: 3.1 })} />
              </View>
            </View>
            <View style={s.btnRow}>
              <View style={s.cell}>
                <Button title="SNATCH" tone={C.alarm} onPress={() => v.trigger('snatch')} />
              </View>
              <View style={s.cell}>
                <Button title="BATTERY → 15%" tone={C.dim}
                        onPress={() => v.deliver({ c: 'bat', v: 15 })} />
              </View>
            </View>
            <Text style={s.note}>
              Two events a thumb cannot produce at a desk. SNATCH has no gesture
              behind it — anti-snatch is v2 — but the server already routes the
              event, so the alert path stays testable. Everything else on this
              screen goes through the real gesture engine.
            </Text>
          </Card>

          {/* ---- what the band thinks ---- */}
          <Card>
            <Label>Band state</Label>
            <View style={s.statRow}>
              <Stat label="battery" value={`${Math.round(v.battery)}%`}
                    sub={v.batteryAvailable ? 'this phone' : 'simulated drain'}
                    tone={v.battery <= 20 ? C.amber : C.text} />
              <Stat label="high alert" value={v.highAlert ? 'ON' : 'off'}
                    tone={v.highAlert ? C.amber : C.dim} />
            </View>
            <View style={s.statRow}>
              <Stat label="accelerometer" value={v.imu}
                    tone={v.imu === 'live' ? C.green : C.dim} />
              <Stat label="fall state" value={v.fallStage}
                    tone={v.fallStage === 'idle' ? C.dim : C.amber} />
              <Stat label="check-in" value={v.awaitingAck ? 'WAITING' : 'clear'}
                    tone={v.awaitingAck ? C.amber : C.dim} />
              <Stat label="last event"
                    value={band.lastSeen ? fmtAgo(band.lastSeen / 1000) : '—'} />
            </View>
            {v.imuAvailable ? (
              <Text style={s.note}>
                Fall detection is live and watching. It wants free-fall, then an
                impact, then stillness — in that order — so waving the phone will
                not trip it. Drop it onto a cushion from waist height to see it fire.
              </Text>
            ) : (
              <Text style={s.warn}>
                expo-sensors is not in this build, so fall detection cannot run.
                FORCE FALL still exercises everything downstream of the sensor.
              </Text>
            )}
          </Card>

          {/* ---- the wire ---- */}
          <Card>
            <View style={s.row}>
              <Label>Wire log</Label>
              <Pressable onPress={v.clearLog}><Text style={s.clear}>clear</Text></Pressable>
            </View>
            {v.log.length === 0 ? (
              <Text style={s.note}>Nothing yet. Press the key.</Text>
            ) : (
              v.log.map((l, i) => (
                <View key={`${l.at}-${i}`} style={s.logRow}>
                  <Text style={[s.logDir, { color: l.dir === 'tx' ? C.green : C.amber }]}>
                    {l.dir === 'tx' ? '▸' : '◂'}
                  </Text>
                  <Text style={s.logText} numberOfLines={2}>{l.text}</Text>
                </View>
              ))
            )}
            <Text style={s.note}>
              ▸ band → phone   ◂ phone → band.  Heartbeats are hidden; they fire
              every 10 s regardless.
            </Text>
          </Card>
        </>
      ) : (
        <Card>
          <Label>Bluetooth</Label>
          <Stat label="link" value={band.status} />
          {band.status === 'connected' ? (
            <View style={s.btnRow}>
              <View style={s.cell}>
                <Button title="BUZZ" tone={C.dim} onPress={() => band.send({ c: 'buzz', n: 2 })} />
              </View>
              <View style={s.cell}>
                <Button title="DISCONNECT" tone={C.dim} onPress={band.disconnect} />
              </View>
            </View>
          ) : (
            <Button title="SCAN FOR THE BAND" filled onPress={band.connect} />
          )}
          {band.bleError ? (
            <Text style={s.warn}>
              Bluetooth is unavailable in this build ({band.bleError}). Expo Go
              cannot load it — use THIS PHONE, or install the development build.
            </Text>
          ) : null}
        </Card>
      )}
    </ScrollView>
  );
}

function ModeTab({ active, label, sub, onPress }) {
  return (
    <Pressable onPress={onPress} style={[s.modeTab, active && s.modeTabOn]}>
      <Text style={[s.modeLabel, active && { color: C.green }]}>{label}</Text>
      <Text style={s.modeSub}>{sub}</Text>
    </Pressable>
  );
}

function LegendRow({ g, m, tone }) {
  return (
    <View style={s.legendRow}>
      <Text style={[s.legendG, tone && { color: tone }]}>{g}</Text>
      <Text style={s.legendM}>{m}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { padding: 16, gap: 14, paddingBottom: 40 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  statRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  btnRow: { flexDirection: 'row', gap: 10 },
  cell: { flex: 1 },

  modeRow: { flexDirection: 'row', gap: 10 },
  modeTab: {
    flex: 1, borderWidth: 1, borderColor: C.line, borderRadius: 4,
    paddingVertical: 12, paddingHorizontal: 10, gap: 3,
  },
  modeTabOn: { borderColor: C.green, backgroundColor: C.greenBg },
  modeLabel: { fontFamily: mono, color: C.dim, fontSize: 12, letterSpacing: 1.2 },
  modeSub: { fontFamily: mono, color: C.faint, fontSize: 9 },

  keyWrap: { alignItems: 'center', paddingVertical: 8 },
  key: {
    width: 148, height: 148, borderRadius: 74, borderWidth: 3, borderColor: C.line,
    backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', gap: 4,
  },
  keyGlyph: { fontFamily: mono, color: C.green, fontSize: 40 },
  keyHint: {
    fontFamily: mono, color: C.faint, fontSize: 11, letterSpacing: 1.4,
    fontVariant: ['tabular-nums'],
  },

  holdTrack: { height: 4, backgroundColor: C.line, borderRadius: 2, overflow: 'hidden' },
  holdFill: { height: 4, borderRadius: 2 },
  holdLabel: {
    fontFamily: mono, color: C.faint, fontSize: 10, letterSpacing: 1.4,
    textAlign: 'center',
  },

  legend: { gap: 6, marginTop: 4 },
  legendRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  legendG: { fontFamily: mono, color: C.text, fontSize: 11, width: 62 },
  legendM: { fontFamily: mono, color: C.dim, fontSize: 11, flex: 1, lineHeight: 16 },

  keyB: {
    borderWidth: 1, borderColor: C.alarm, borderRadius: 4,
    paddingVertical: 13, alignItems: 'center',
  },
  keyBText: { fontFamily: mono, color: C.alarm, fontSize: 12, letterSpacing: 1.2 },

  logRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  logDir: { fontFamily: mono, fontSize: 11, width: 12 },
  logText: { fontFamily: mono, color: C.dim, fontSize: 10, flex: 1, lineHeight: 15 },
  clear: { fontFamily: mono, color: C.faint, fontSize: 10, textDecorationLine: 'underline' },

  note: { fontFamily: mono, color: C.faint, fontSize: 10, lineHeight: 16 },
  warn: {
    fontFamily: mono, color: C.amber, fontSize: 10, lineHeight: 16,
    backgroundColor: C.amberBg, padding: 10, borderRadius: 4,
  },
});
