import React, { useCallback, useEffect, useState } from 'react';
import {
  RefreshControl, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import {
  backgroundWatchDiagnostics, isBackgroundWatchRunning, startBackgroundWatch,
} from '../bgService';
import { backgroundNotificationDiagnostics } from '../bgNotifications';
import { liveMapAvailable } from './LiveMap';
import {
  alarmCapability, fullScreenIntentAllowed, openFullScreenIntentSettings,
  presentAlarm, stopAlarm,
} from '../alarm';
import {
  OEM, askPermission, ladderRows, openActivity, openBatterySettings,
  readPermissions, vendorKey,
} from '../permissions';
import { DEFAULT_CHANNEL_ID, pushDiagnostics, registerPushToken } from '../notifications';
import { C, R, S, T } from '../theme';
import {
  Banner, Button, Card, Chip, Divider, Icon, Label, Skeleton, SkeletonGroup, Txt,
} from '../ui';

let Notifications = null;
try { Notifications = require('expo-notifications'); } catch { /* degrades below */ }

/**
 * U5.1 + U5.2 — the setup screen, which is the difference between an app that
 * works on the demo phone and one that works on somebody's Xiaomi.
 *
 * Two things happen here, in this order:
 *
 *   1. **The permission ladder.** One rung at a time, each with one sentence
 *      of why. Asking for four permissions on first launch is how you get four
 *      denials; asking for notifications the moment before they matter is how
 *      you get a yes.
 *   2. **OEM survival.** Chinese-market Android kills background apps on a
 *      schedule no permission dialog covers. The deep links below jump
 *      straight to the vendor's own autostart list, and every one of them is
 *      wrapped, because the class names move between OS versions. When one
 *      misses, the app settings page opens instead and the instructions stay
 *      on screen.
 */

// The OEM table, the vendor lookup, the settings openers and the ladder copy
// now live in ../permissions, because the end-user shell needs every one of
// them and had none of them. Re-exported so the existing import in Home.js
// keeps working.
export { pendingPermissions } from '../permissions';


export default function Setup({ onDone, session }) {
  const [perm, setPerm] = useState({ notif: null, loc: null, bg: null, fsi: null });
  const [checking, setChecking] = useState(true);
  const [diag, setDiag] = useState({
    bgModules: null, bgRunning: null, bgError: null,
    pushToken: null, pushError: null, pushRegistered: false, testSent: false,
    alarmLevel: null, alarmReason: null, alarmError: null, bgNotifRegistered: null,
    fsiAllowed: null, liveMap: null,
    alarmTesting: false,
  });
  const [diagBusy, setDiagBusy] = useState(false);
  // Which rung is waiting on Android's dialog. It can take a beat to appear,
  // and on a rung that has already been refused once it never appears at all.
  const [asking, setAsking] = useState(null);
  const vendor = vendorKey();

  const refresh = useCallback(async () => {
    setChecking(true);
    setPerm(await readPermissions());
    setChecking(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // U5.5 — "is it actually working" answered on-device, so a build that keeps
  // failing does not need a new APK for every guess at why.
  const refreshDiag = useCallback(async () => {
    const bg = backgroundWatchDiagnostics();
    const running = await isBackgroundWatchRunning();
    const push = pushDiagnostics();
    const alarm = alarmCapability();
    const bgNotif = backgroundNotificationDiagnostics();
    const fsiAllowed = await fullScreenIntentAllowed();
    setDiag((d) => ({
      ...d,
      bgModules: bg.modulesLoaded,
      bgRunning: running,
      // Whether react-native-webview is actually in THIS binary.
      //
      // The live map degrades silently on purpose -- a build without the
      // module shows the old static pin rather than a white screen during an
      // emergency -- and silence is exactly what makes it hard to tell a
      // working fallback from a failed install. This is the answer, on the
      // device, without having to raise an SOS to find out.
      liveMap: liveMapAvailable(),
      bgError: bg.lastError,
      pushToken: push.token,
      pushError: push.error,
      pushRegistered: push.registered,
      alarmLevel: alarm.level,
      alarmReason: alarm.reason,
      fsiAllowed,
      alarmError: alarm.lastError || bgNotif.lastError,
      bgNotifRegistered: bgNotif.registered,
    }));
  }, []);

  useEffect(() => { refreshDiag(); }, [refreshDiag]);

  const runStartBackgroundWatch = async () => {
    setDiagBusy(true);
    await startBackgroundWatch();
    await refreshDiag();
    setDiagBusy(false);
  };

  const runRegisterPush = async () => {
    if (!session) return;
    setDiagBusy(true);
    await registerPushToken(session);
    await refreshDiag();
    setDiagBusy(false);
  };

  /**
   * Android 14 stopped granting USE_FULL_SCREEN_INTENT at install to anything
   * that is not a calling or alarm-clock app, and there is no runtime prompt
   * for it -- only this Settings page. Declaring the permission in the manifest
   * is now necessary and not sufficient, and when it is missing the takeover
   * degrades to an ordinary heads-up notification without erroring, which is
   * indistinguishable from the alarm simply not working.
   */
  const runOpenFullScreenSettings = async () => {
    setDiagBusy(true);
    await openFullScreenIntentSettings();
    await refreshDiag();
    setDiagBusy(false);
  };

  const sendTestNotification = async () => {
    if (!Notifications) return;
    setDiagBusy(true);
    try {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: 'Nigehban test notification',
          body: 'If you can see this, local alerts and sound work on this phone.',
          sound: true,
        },
        // The channel is chosen by the TRIGGER, not by the content -- a
        // `channelId` in `content` is silently ignored, which made this button
        // test Android's default channel rather than Nigehban's.
        trigger: { channelId: DEFAULT_CHANNEL_ID },
      });
      setDiag((d) => ({ ...d, testSent: true }));
    } catch { /* the chip below stays "not sent" */ }
    setDiagBusy(false);
  };

  /**
   * Fire the real lock-screen alarm at yourself.
   *
   * N3.3 and N3.4 are the two features that cannot be checked by looking at the
   * app, because the whole point of them happens while the app is not on
   * screen. This runs the exact code path an incoming severity-5 SOS runs --
   * same native call, same siren -- so it can be tested alone, on one phone,
   * without arranging an emergency.
   *
   * Ten seconds, then it stops itself. A test alarm that has to be dismissed to
   * stop is a test people avoid running.
   */
  const testLockScreenAlarm = async () => {
    setDiagBusy(true);
    setDiag((d) => ({ ...d, alarmTesting: true }));
    await presentAlarm({
      id: 'test', kind: 'sos', severity: 5, maps: null,
      user: { name: 'Nigehban test' },
    });
    await refreshDiag();
    setTimeout(async () => {
      await stopAlarm();
      setDiag((d) => ({ ...d, alarmTesting: false }));
    }, 10000);
    setDiagBusy(false);
  };

  const ask = async (which) => {
    if (asking) return;
    setAsking(which);
    try {
      await askPermission(which);
      await refresh();
    } finally {
      setAsking(null);
    }
  };

  const ladder = ladderRows(perm);
  const remaining = ladder.filter((r) => r.granted !== true).length;
  // The very first read, before anything at all is known about this phone.
  const unread = checking && perm.notif === null && perm.loc === null;

  return (
    <ScrollView
      contentContainerStyle={s.wrap}
      refreshControl={<RefreshControl refreshing={checking} onRefresh={refresh} tintColor={C.green} />}
    >
      <View style={{ gap: 6 }}>
        <Label>Setup</Label>
        <Txt variant="h1">Make sure Nigehban survives your phone</Txt>
        <Text style={[T.body, { color: C.dim }]}>
          A few steps, once. Every one of them is something Android will otherwise
          switch off quietly, on the day it matters.
        </Text>
      </View>

      {remaining === 0 && !unread ? (
        <Banner tone={C.green} icon="check-circle" title="Permissions are all set">
          Only the vendor step below is left, and it is the one people skip.
        </Banner>
      ) : null}

      <View style={{ gap: S.md }}>
        {/* Until the first read comes back nothing is known, and drawing the
            ladder from all-nulls puts a stack of amber "not granted" cards in
            front of somebody whose phone is already configured. */}
        {unread ? (
          <SkeletonGroup label="Checking what Android allows">
            <StepCardSkeleton />
            <StepCardSkeleton />
            <StepCardSkeleton />
          </SkeletonGroup>
        ) : ladder.map((r, i) => (
          <Card key={r.key} tone={r.granted === true ? C.green : undefined}>
            <View style={s.stepHead}>
              <View style={[s.num, r.granted === true && { backgroundColor: C.green }]}>
                {r.granted === true
                  ? <Icon name="check" size={16} color={C.bg} />
                  : <Text style={[T.title, { color: C.dim }]}>{i + 1}</Text>}
              </View>
              <View style={{ flex: 1, gap: 3 }}>
                <Txt variant="h2">{r.title}</Txt>
                <Text style={[T.meta, { color: C.dim }]}>{r.why}</Text>
              </View>
            </View>

            {r.granted === true ? (
              <Chip text="granted" tone={C.green} icon="check" />
            ) : r.blocked ? (
              <Chip text="do the step above first" tone={C.faint} icon="lock" />
            ) : (
              <Button title={r.action} filled={r.granted !== true}
                      icon={r.icon} loading={asking === r.key}
                      disabled={!!asking && asking !== r.key}
                      onPress={() => ask(r.key)} />
            )}

            {r.granted === false ? (
              <Text style={[T.meta, { color: C.amber }]}>
                Denied. Android will not ask twice — open the app's settings and
                turn it on there.
              </Text>
            ) : null}
          </Card>
        ))}

        {/* ---- 4. the vendor step ---- */}
        <Card tone={C.amber}>
          <View style={s.stepHead}>
            <View style={s.num}>
              <Text style={[T.title, { color: C.dim }]}>{ladder.length + 1}</Text>
            </View>
            <View style={{ flex: 1, gap: 3 }}>
              <Txt variant="h2">Let it run in the background</Txt>
              <Text style={[T.meta, { color: C.dim }]}>
                {vendor
                  ? `This is a ${OEM[vendor].label} phone, and it stops background apps `
                    + 'more aggressively than stock Android does.'
                  : 'Most phones stop background apps to save battery. Nigehban has to '
                    + 'be excused from that, or the watch stops when the screen does.'}
              </Text>
            </View>
          </View>

          <Button title="BATTERY: SET TO UNRESTRICTED" icon="battery-charging"
                  onPress={openBatterySettings} />

          {vendor ? (
            <>
              <Divider />
              <Label>{OEM[vendor].label}</Label>
              <Text style={[T.meta, { color: C.dim }]}>{OEM[vendor].how}</Text>
              <Button title="OPEN AUTOSTART SETTINGS" icon="external-link"
                      onPress={() => openActivity(OEM[vendor].pkg, OEM[vendor].cls)} />
            </>
          ) : (
            <>
              <Divider />
              <Label>If your phone is one of these</Label>
              {Object.entries(OEM).map(([k, v]) => (
                <Button key={k} title={v.label.toUpperCase()} tone={C.dim}
                        sub={v.how} onPress={() => openActivity(v.pkg, v.cls)} />
              ))}
            </>
          )}

          <Text style={[T.meta, { color: C.faint }]}>
            If a button lands on the wrong page, your phone's settings have moved —
            open Settings, find Nigehban, and allow autostart and unrestricted battery.
          </Text>
        </Card>

        {/* ---- 5. self-test: answers "is it actually working" on this phone,
                  without a new build for every guess ---- */}
        <Card>
          <View style={s.stepHead}>
            <View style={s.num}>
              <Text style={[T.title, { color: C.dim }]}>{ladder.length + 2}</Text>
            </View>
            <View style={{ flex: 1, gap: 3 }}>
              <Txt variant="h2">Is it actually working?</Txt>
              <Text style={[T.meta, { color: C.dim }]}>
                Two independent paths keep alerts arriving when the app is closed:
                the sticky watch notification below (works while the app is swiped
                away but not force-stopped) and a server push (the only one that
                survives a full force-stop or reboot).
              </Text>
            </View>
          </View>

          <View style={{ gap: 4 }}>
            <View style={s.diagRow}>
              <Text style={[T.meta, { color: C.dim }]}>Watch notification</Text>
              {diag.bgModules === false ? (
                <Chip text="build missing a module" tone={C.red} icon="x" />
              ) : diag.bgRunning ? (
                <Chip text="running" tone={C.green} icon="check" />
              ) : (
                <Chip text="not running" tone={C.amber} icon="alert-triangle" />
              )}
            </View>
            {diag.bgError ? (
              <Text style={[T.meta, { color: C.faint }]}>{diag.bgError}</Text>
            ) : null}

            <View style={s.diagRow}>
              <Text style={[T.meta, { color: C.dim }]}>Live map</Text>
              {diag.liveMap ? (
                <Chip text="ready" tone={C.green} icon="check" />
              ) : (
                <Chip text="static pin only" tone={C.amber} icon="alert-triangle" />
              )}
            </View>
            {diag.liveMap === false ? (
              <Text style={[T.meta, { color: C.faint }]}>
                react-native-webview is not in this build — alerts open a fixed
                pin in Maps instead of a map that moves. Rebuild after
                `npx expo install react-native-webview`.
              </Text>
            ) : null}

            <View style={s.diagRow}>
              <Text style={[T.meta, { color: C.dim }]}>Server push</Text>
              {/* Green only once the server has accepted the token. Having a
                  token locally proves nothing -- the server is what sends the
                  push, and it spent this whole time rejecting them. */}
              {diag.pushRegistered ? (
                <Chip text="registered" tone={C.green} icon="check" />
              ) : diag.pushToken ? (
                <Chip text="server refused it" tone={C.red} icon="x" />
              ) : (
                <Chip text="not registered" tone={C.amber} icon="alert-triangle" />
              )}
            </View>
            {diag.pushError ? (
              <Text style={[T.meta, { color: C.faint }]}>{diag.pushError}</Text>
            ) : null}

            <View style={s.diagRow}>
              <Text style={[T.meta, { color: C.dim }]}>Lock-screen takeover</Text>
              {/* "vibration" is not a failure and is not green either: it is
                  what Expo Go can do, and somebody testing there should know
                  the screen will not light up on the real thing's behalf. */}
              {diag.alarmLevel === 'takeover' ? (
                <Chip text="full alarm" tone={C.green} icon="check" />
              ) : diag.alarmLevel === 'vibration' ? (
                <Chip text="vibration only" tone={C.amber} icon="alert-triangle" />
              ) : (
                <Chip text="unavailable" tone={C.red} icon="x" />
              )}
            </View>
            {diag.alarmReason ? (
              <Text style={[T.meta, { color: C.faint }]}>{diag.alarmReason}</Text>
            ) : null}

            {/* Android 14+ only. Null means the question does not apply -- below
                14 the permission is granted at install, and Expo Go has no
                native module to ask -- and neither is worth a row. `false` is
                worth a loud one: everything else here can read green while the
                takeover is quietly downgraded to a heads-up notification. */}
            {diag.fsiAllowed === false ? (
              <>
                <View style={s.diagRow}>
                  <Text style={[T.meta, { color: C.dim }]}>Full-screen permission</Text>
                  <Chip text="blocked" tone={C.red} icon="x" />
                </View>
                <Text style={[T.meta, { color: C.faint }]}>
                  Android is holding the takeover back to an ordinary notification.
                  Nothing else here can tell you that.
                </Text>
                <Button title="ALLOW FULL-SCREEN ALERTS" tone={C.red}
                        disabled={diagBusy} onPress={runOpenFullScreenSettings} />
              </>
            ) : diag.fsiAllowed === true ? (
              <View style={s.diagRow}>
                <Text style={[T.meta, { color: C.dim }]}>Full-screen permission</Text>
                <Chip text="granted" tone={C.green} icon="check" />
              </View>
            ) : null}

            <View style={s.diagRow}>
              <Text style={[T.meta, { color: C.dim }]}>Alarm on a killed app</Text>
              {diag.bgNotifRegistered ? (
                <Chip text="listening" tone={C.green} icon="check" />
              ) : (
                <Chip text="not registered" tone={C.amber} icon="alert-triangle" />
              )}
            </View>
            {diag.alarmError ? (
              <Text style={[T.meta, { color: C.faint }]}>{diag.alarmError}</Text>
            ) : null}
          </View>

          <Divider />

          <Button title="START WATCH NOTIFICATION NOW" icon="play"
                  disabled={diagBusy} onPress={runStartBackgroundWatch} />
          <Button title="REGISTER FOR SERVER PUSH" icon="refresh-cw"
                  disabled={diagBusy || !session} onPress={runRegisterPush} />
          <Button title="SEND A TEST NOTIFICATION" icon="bell"
                  disabled={diagBusy} onPress={sendTestNotification} />
          <Button title={diag.alarmTesting ? 'ALARM RUNNING — 10s' : 'TEST THE LOCK-SCREEN ALARM'}
                  icon="alert-octagon" tone={C.red}
                  disabled={diagBusy || diag.alarmTesting} onPress={testLockScreenAlarm} />
          {diag.alarmTesting ? (
            <Text style={[T.meta, { color: C.dim }]}>
              Lock the phone now. It should light up on its own, show Nigehban
              over the lock screen and sound an alarm until it stops itself.
            </Text>
          ) : null}
          {diag.testSent ? (
            <Text style={[T.meta, { color: C.green }]}>
              Sent. Pull down the notification shade — if it is not there, the
              channel or permission above is still the problem.
            </Text>
          ) : null}

          <Text style={[T.meta, { color: C.faint }]}>
            Real proof: swipe Nigehban away from Recents, then send an SOS from a
            second phone. The watch notification path should still ring within a
            few seconds. Force-stop the app from Android Settings and repeat — only
            a working server push reaches you there.
          </Text>
        </Card>
      </View>

      {onDone ? (
        <Button title="DONE" filled icon="check" onPress={onDone} />
      ) : null}
    </ScrollView>
  );
}

/** One rung of the ladder, drawn before Android has said anything about it. */
function StepCardSkeleton() {
  return (
    <Card>
      <View style={s.stepHead}>
        <Skeleton width={32} height={32} radius={R.control} />
        <View style={{ flex: 1, gap: 7 }}>
          <Skeleton width={168} height={17} />
          <Skeleton height={11} />
          <Skeleton width="72%" height={11} />
        </View>
      </View>
      <Skeleton height={48} radius={R.control} />
    </Card>
  );
}

const s = StyleSheet.create({
  wrap: { padding: S.lg, gap: S.lg, paddingBottom: 48 },
  stepHead: { flexDirection: 'row', gap: S.md, alignItems: 'flex-start' },
  num: {
    width: 32, height: 32, borderRadius: 6, backgroundColor: C.raised,
    alignItems: 'center', justifyContent: 'center',
  },
  diagRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
});
