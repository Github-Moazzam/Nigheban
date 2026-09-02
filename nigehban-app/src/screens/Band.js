import React, { useMemo, useState } from 'react';
import {
  Platform, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { MODES } from '../bandLink';
import { C, MONO, S, T, fmtAgo } from '../theme';
import { Banner, Button, Card, Chip, Divider, Icon, ProgressBar, Stat, Txt } from '../ui';
import { HOLD_1_MS } from '../virtualBand';
import { VEHICLE_KMH, noteSpeed, speedWatchStatus } from '../motion';

const mono = Platform.select(MONO);

/**
 * THE BAND CONSOLE.
 *
 * A stand-in for hardware that is deliberately *not* a row of shortcuts. The
 * big key runs the real gesture engine — you have to actually double-tap to
 * raise an SOS and actually hold for three seconds to arm High Alert — the
 * point is to find out today whether those gestures are usable by a frightened
 * person, while changing them still costs nothing.
 *
 * This is the one screen allowed a monospace face, and only in the wire log,
 * where alignment carries meaning. Everything else obeys the type scale.
 */
export default function Band({ band, serverOnline }) {
  const v = band.virtual;
  const virtual = band.mode === MODES.VIRTUAL;
  // Read on each render rather than watched. This is a diagnostic panel,
  // and a subscription that re-rendered the console on every GPS fix would
  // cost more than the number is worth.
  const speedCtx = speedWatchStatus();
  // Only so the note can say "armed". The seeded samples age out of
  // motion.js on their own; nothing here holds the arming.
  const [armedAt, setArmedAt] = useState(0);

  // How far the finger is through the one hold threshold there is.
  const holdPhase = useMemo(() => {
    if (!v?.holding) return null;
    if (v.holdMs >= HOLD_1_MS) {
      return { label: 'High Alert toggled — let go', pct: 1, tone: C.amber };
    }
    return { label: 'Hold for High Alert', pct: v.holdMs / HOLD_1_MS, tone: C.green };
  }, [v?.holding, v?.holdMs]);

  return (
    <ScrollView contentContainerStyle={s.wrap}>
      {/* ---- which radio ---- */}
      <Card>
        <View style={s.row}>
          <Txt variant="h2">Band source</Txt>
          <Chip text={serverOnline ? 'server ok' : 'server offline'}
                tone={serverOnline ? C.green : C.red}
                icon={serverOnline ? 'wifi' : 'wifi-off'} />
        </View>

        <View style={s.modeRow}>
          <ModeTab active={virtual} label="This phone" icon="smartphone"
                   sub="no hardware needed"
                   onPress={() => band.chooseMode(MODES.VIRTUAL)} />
          <ModeTab active={!virtual} label="Real band" icon="bluetooth"
                   sub={band.bleAvailable ? 'over bluetooth' : 'needs the dev build'}
                   onPress={() => band.chooseMode(MODES.BLE)} />
        </View>

        <Text style={s.note}>
          {virtual
            ? 'This phone is running the band firmware in JavaScript — the same '
              + 'gesture engine, the same event JSON. The server cannot tell the '
              + 'difference, so everything downstream of the band is under test.'
            : 'Scanning for a physical Nigehban band over Bluetooth. Switch back to '
              + 'This phone if you have no band with you.'}
        </Text>
      </Card>

      {/* ---- the accident path, at a desk, with no vehicle ----------------
          Outside the `virtual` block on purpose. An impact on its own is
          ignored -- motion.js only calls it an accident if the phone was
          travelling in the twenty seconds before it -- so with a REAL band this
          is the only way to test the crash path without actually driving
          somewhere and hitting something. The band supplies the impact by being
          struck; this supplies the speed that gives it meaning.

          It writes real samples into the same history a GPS fix feeds, so
          nothing downstream can tell them apart. That is the point, and it is
          also why the window is short: twenty seconds, then it goes cold on its
          own and cannot leave a phone permanently believing it is in traffic. */}
      <Card>
        <Txt variant="h2">Crash test</Txt>
        <View style={s.btnRow}>
          <View style={s.cell}>
            <Button title="ARM CRASH TEST" tone={C.amber} icon="navigation"
                    onPress={() => {
                      // A run of samples, not one. `travellingSteadily` and the
                      // peak both read a window, so a lone sample would prove
                      // less than a real ride does.
                      const t = Date.now();
                      for (let i = 8; i >= 0; i--) {
                        noteSpeed(VEHICLE_KMH * 1.8 / 3.6, t - i * 2000);
                      }
                      setArmedAt(Date.now());
                    }} />
          </View>
          <View style={s.cell}>
            {/* Three states, not two. "in a vehicle, no fix" is the journey
                latch carrying it through a tunnel -- the case a driver hit at
                speed depends on, and the one that would be invisible if this
                only ever reported the live reading. */}
            <Stat label="Speed seen" icon="activity"
                  value={speedCtx.nowKmh == null ? '—' : `${Math.round(speedCtx.nowKmh)} km/h`}
                  sub={!speedCtx.wasTravelling ? 'an impact now = ignored'
                       : speedCtx.sawSpeed ? 'an impact now = accident'
                       : 'an impact now = accident (in a vehicle, no fix)'}
                  tone={speedCtx.wasTravelling ? C.amber : C.dim} />
          </View>
        </View>
        <Text style={s.note}>
          Pretends this phone has been doing {Math.round(VEHICLE_KMH * 1.8)} km/h for the
          last 20 seconds. Press it, then within 20 seconds either hit the band hard
          (real band) or press FORCE CRASH above (this phone). You should get the
          accident countdown. Do it the other way round and nothing happens — that is
          the speed gate working, not a fault.
          {armedAt ? ' Armed — the window closes 20s after you pressed it.' : ''}
        </Text>
      </Card>

      {virtual && v ? (
        <>
          {/* ---- the key ---- */}
          <Card>
            <Txt variant="h2">Key A — the band&apos;s only button</Txt>

            <View style={s.keyWrap}>
              <Pressable
                onPressIn={() => v.onPressIn(1)}
                onPressOut={() => v.onPressOut(1)}
                accessibilityRole="button"
                accessibilityLabel="Band key A. Tap once for I am fine, twice for SOS, hold for High Alert."
                style={({ pressed }) => [
                  s.key,
                  pressed && { backgroundColor: C.greenSoft },
                  v.buzzing && { backgroundColor: C.amberSoft },
                ]}
              >
                <Icon name={v.buzzing ? 'radio' : 'circle'} size={38}
                      color={v.buzzing ? C.amber : C.green} />
                <Text style={s.keyHint}>
                  {v.holding ? `${(v.holdMs / 1000).toFixed(1)}s` : 'press'}
                </Text>
              </Pressable>
            </View>

            {/* hold progress: the cue the motor gives on the real band */}
            <ProgressBar value={holdPhase?.pct ?? 0} tone={holdPhase?.tone ?? C.line} />
            <Text style={[s.note, { textAlign: 'center' },
                          holdPhase && { color: holdPhase.tone }]}>
              {holdPhase?.label ?? 'idle'}
            </Text>

            <Divider />

            <View style={{ gap: S.sm }}>
              <LegendRow g="1 tap" m="I'm fine — answers a check-in, or stands down a live SOS" />
              <LegendRow g="2+ taps" m="SOS — three or four taps work too, on purpose" tone={C.red} />
              <LegendRow g="hold 3s" m={v.highAlert ? 'Turn High Alert off' : 'Turn High Alert on'} />
            </View>

            <Text style={s.note}>
              Two gestures, on purpose. Taps are grouped into a burst — the gesture
              fires once you stop tapping, so tap deliberately rather than fast.
              Holding past 3 s does nothing further; anti-snatch is a v2 feature and
              nothing is bound to a longer hold.
            </Text>
          </Card>

          {/* ---- second key + manual events ---- */}
          <Card>
            <Txt variant="h2">Prototype extras</Txt>
            <View style={s.btnRow}>
              <View style={s.cell}>
                <Pressable
                  onPressIn={() => v.onPressIn(2)}
                  onPressOut={() => v.onPressOut(2)}
                  accessibilityRole="button" accessibilityLabel="Key B, raises an SOS"
                  style={({ pressed }) => [s.keyB, pressed && { backgroundColor: C.red }]}
                >
                  {({ pressed }) => (
                    <Text style={[T.button, { color: pressed ? C.bg : C.red }]}>
                      KEY B — SOS
                    </Text>
                  )}
                </Pressable>
              </View>
              <View style={s.cell}>
                <Button title="FORCE FALL" tone={C.amber} icon="trending-down"
                        onPress={() => v.trigger('fall', { peak_g: 3.1 })} />
              </View>
            </View>
            <View style={s.btnRow}>
              <View style={s.cell}>
                <Button title="SNATCH" tone={C.red} icon="alert-octagon"
                        onPress={() => v.trigger('snatch')} />
              </View>
              <View style={s.cell}>
                <Button title="BATTERY 15%" tone={C.dim} icon="battery"
                        onPress={() => v.deliver({ c: 'bat', v: 15 })} />
              </View>
            </View>

            <View style={s.btnRow}>
              <View style={s.cell}>
                <Button title="FORCE CRASH" tone={C.red} icon="alert-triangle"
                        onPress={() => v.trigger('impact', { peak_g: 19.4, rot: 640, still: 92 })} />
              </View>
              <View style={s.cell} />
            </View>

            <Text style={s.note}>
              Events a thumb cannot produce at a desk. SNATCH has no gesture behind
              it — anti-snatch is v2 — but the server already routes the event, so the
              alert path stays testable. FORCE CRASH needs ARM CRASH TEST pressed
              first, in the card below; on its own it is correctly ignored.
            </Text>
          </Card>

          {/* ---- what the band thinks ---- */}
          <Card>
            <Txt variant="h2">Band state</Txt>
            {/* Two rows rather than one, because this console is where the two
                batteries are easiest to confuse. What the firmware calls its
                cell is, here, this phone's own -- expo-battery standing in for
                the ADC pin. Labelling that "Battery" is how the number ends up
                on a family screen as a wristband's charge. */}
            <View style={s.statRow}>
              <Stat label="Phone battery" icon="battery" value={`${Math.round(v.battery)}%`}
                    sub={v.batteryAvailable ? 'read from this phone' : 'simulated drain'}
                    tone={v.battery <= 20 ? C.amber : C.text} />
              <Stat label="Band battery" icon="watch" value="N/A"
                    sub="no wristband — this phone is it" tone={C.dim} />
              <Stat label="High alert" icon="shield" value={v.highAlert ? 'On' : 'Off'}
                    tone={v.highAlert ? C.amber : C.dim} />
            </View>
            <View style={s.statRow}>
              <Stat label="Last event" icon="activity"
                    value={band.lastSeen ? fmtAgo(band.lastSeen / 1000) : '—'} />
              <Stat label="Accelerometer" icon="cpu" value={v.imu}
                    tone={v.imu === 'live' ? C.green : C.dim} />
              <Stat label="Fall state" icon="trending-down" value={v.fallStage}
                    tone={v.fallStage === 'idle' ? C.dim : C.amber} />
              {/* The other half of the accident detector, and the half that is
                  invisible everywhere else. "Ignored" against a real impact is
                  almost always this reading being blank. */}
              <Stat label="Speed" icon="navigation"
                    value={speedCtx.nowKmh == null ? '—'
                                                   : `${Math.round(speedCtx.nowKmh)} km/h`}
                    sub={speedCtx.error ? 'GPS unavailable — crash detection OFF'
                         : speedCtx.wasTravelling ? 'crash detection armed'
                         : speedCtx.armed ? 'not travelling'
                         : 'no fix yet'}
                    tone={speedCtx.error ? C.red
                          : speedCtx.wasTravelling ? C.amber : C.dim} />
              <Stat label="Check-in" icon="help-circle"
                    value={v.awaitingAck ? 'Waiting' : 'Clear'}
                    tone={v.awaitingAck ? C.amber : C.dim} />
            </View>

            {v.imuAvailable ? (
              <Text style={s.note}>
                Fall detection is live and watching. It wants free-fall, then an impact,
                then stillness — in that order — so waving the phone will not trip it.
                Drop it onto a cushion from waist height to see it fire.
              </Text>
            ) : (
              <Banner tone={C.amber} icon="alert-triangle" title="No accelerometer in this build">
                expo-sensors is missing, so fall detection cannot run. FORCE FALL still
                exercises everything downstream of the sensor.
              </Banner>
            )}
          </Card>

          {/* ---- the wire ---- */}
          <Card>
            <View style={s.row}>
              <Txt variant="h2">Wire log</Txt>
              <Pressable onPress={v.clearLog} hitSlop={8} accessibilityRole="button">
                <Text style={[T.label, { color: C.dim }]}>CLEAR</Text>
              </Pressable>
            </View>

            {v.log.length === 0 ? (
              <Text style={s.note}>Nothing yet. Press the key.</Text>
            ) : (
              <View style={{ gap: 5 }}>
                {v.log.map((l, i) => (
                  <View key={`${l.at}-${i}`} style={s.logRow}>
                    <Icon name={l.dir === 'tx' ? 'arrow-up-right' : 'arrow-down-left'}
                          size={12} color={l.dir === 'tx' ? C.green : C.amber} />
                    <Text style={s.logText} numberOfLines={2}>{l.text}</Text>
                  </View>
                ))}
              </View>
            )}

            <Text style={s.note}>
              Up is band to phone, down is phone to band. Heartbeats are hidden; they
              fire every 10 s regardless.
            </Text>
          </Card>
        </>
      ) : (
        <Card>
          <Txt variant="h2">Bluetooth</Txt>
          <Stat label="Link" icon="bluetooth" value={band.status} />
          {/* "Connected" alone has been lying: the link comes up and the data
              path fails separately. Whatever the radio actually said belongs
              on screen, not swallowed in a catch. */}
          {band.lastError ? <Text style={s.note}>{band.lastError}</Text> : null}
          {band.status === 'connected' ? (
            <View style={s.btnRow}>
              <View style={s.cell}>
                <Button title="BUZZ" icon="bell" tone={C.dim}
                        onPress={() => band.send({ c: 'buzz', n: 2 })} />
              </View>
              <View style={s.cell}>
                <Button title="DISCONNECT" icon="x" tone={C.dim} onPress={band.disconnect} />
              </View>
            </View>
          ) : (
            /* The scan runs for seconds after the press returns, so the link
               state -- not the promise -- is what this button waits on. */
            <Button title={band.status === 'connecting' ? 'CONNECTING' : 'SCAN FOR THE BAND'}
                    filled icon="search"
                    loading={band.status === 'scanning' || band.status === 'connecting'}
                    onPress={band.connect} />
          )}
          {band.bleError ? (
            <Banner tone={C.amber} icon="alert-triangle" title="Bluetooth is unavailable">
              {`${band.bleError}. Expo Go cannot load it — use This phone, or install the development build.`}
            </Banner>
          ) : null}
        </Card>
      )}
    </ScrollView>
  );
}

function ModeTab({ active, label, sub, icon, onPress }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="tab"
               accessibilityState={{ selected: active }}
               style={[s.modeTab, active && s.modeTabOn]}>
      <Icon name={icon} size={16} color={active ? C.green : C.faint} />
      <Text style={[T.bodyMed, { color: active ? C.green : C.dim }]}>{label}</Text>
      <Text style={[T.meta, { color: C.faint, fontSize: 12 }]}>{sub}</Text>
    </Pressable>
  );
}

function LegendRow({ g, m, tone }) {
  return (
    <View style={s.legendRow}>
      <Text style={[T.bodyMed, { color: tone || C.text, width: 74 }]}>{g}</Text>
      <Text style={[T.meta, { color: C.dim, flex: 1 }]}>{m}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { padding: S.lg, gap: S.md, paddingBottom: 40 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  statRow: { flexDirection: 'row', gap: S.md, flexWrap: 'wrap' },
  btnRow: { flexDirection: 'row', gap: S.md },
  cell: { flex: 1 },

  modeRow: { flexDirection: 'row', gap: S.md },
  modeTab: {
    flex: 1, borderRadius: 6, backgroundColor: C.raised,
    paddingVertical: S.md, paddingHorizontal: S.md, gap: 3, minHeight: 48,
  },
  modeTabOn: { backgroundColor: C.greenSoft },

  keyWrap: { alignItems: 'center', paddingVertical: S.sm },
  key: {
    width: 150, height: 150, borderRadius: 75, backgroundColor: C.raised,
    alignItems: 'center', justifyContent: 'center', gap: 6,
  },
  keyHint: { ...T.label, color: C.faint, fontVariant: ['tabular-nums'] },

  keyB: {
    minHeight: 48, borderRadius: 6, backgroundColor: C.redSoft,
    alignItems: 'center', justifyContent: 'center',
  },

  legendRow: { flexDirection: 'row', gap: S.md, alignItems: 'flex-start' },

  logRow: { flexDirection: 'row', gap: S.sm, alignItems: 'flex-start' },
  logText: { fontFamily: mono, color: C.dim, fontSize: 11, flex: 1, lineHeight: 16 },

  note: { ...T.meta, color: C.faint },
});
