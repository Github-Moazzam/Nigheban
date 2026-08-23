import React, { useCallback, useEffect, useState } from 'react';
import {
  Linking, Platform, RefreshControl, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { C, S, T } from '../theme';
import { Banner, Button, Card, Chip, Divider, Icon, Label, Txt } from '../ui';

let Location = null;
let Notifications = null;
let IntentLauncher = null;
try { Location = require('expo-location'); } catch { /* degrades below */ }
try { Notifications = require('expo-notifications'); } catch { /* degrades below */ }
try { IntentLauncher = require('expo-intent-launcher'); } catch { /* degrades below */ }

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

// Execution plan §7. Vendor, activity, and what the screen is called there.
const OEM = {
  xiaomi: {
    label: 'Xiaomi / Redmi / POCO',
    pkg: 'com.miui.securitycenter',
    cls: 'com.miui.permcenter.autostart.AutoStartManagementActivity',
    how: 'Find Nigehban in the Autostart list and switch it on.',
  },
  huawei: {
    label: 'Huawei / Honor',
    pkg: 'com.huawei.systemmanager',
    cls: 'com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity',
    how: 'Turn off "Manage automatically" for Nigehban, then allow all three switches.',
  },
  oppo: {
    label: 'Oppo / Realme',
    pkg: 'com.coloros.safecenter',
    cls: 'com.coloros.safecenter.permission.startup.StartupAppListActivity',
    how: 'Allow Nigehban to start in the background.',
  },
  vivo: {
    label: 'Vivo / iQOO',
    pkg: 'com.vivo.permissionmanager',
    cls: 'com.vivo.permissionmanager.activity.BgStartUpManagerActivity',
    how: 'Allow background start, then set battery use to unrestricted.',
  },
  samsung: {
    label: 'Samsung',
    pkg: 'com.samsung.android.lool',
    cls: 'com.samsung.android.sm.ui.battery.BatteryActivity',
    how: 'Add Nigehban to "Never sleeping apps".',
  },
};

function vendorKey() {
  const m = (Platform.constants?.Manufacturer || Platform.constants?.Brand || '').toLowerCase();
  if (/xiaomi|redmi|poco/.test(m)) return 'xiaomi';
  if (/huawei|honor/.test(m)) return 'huawei';
  if (/oppo|realme/.test(m)) return 'oppo';
  if (/vivo|iqoo/.test(m)) return 'vivo';
  if (/samsung/.test(m)) return 'samsung';
  return null;
}

async function openActivity(pkg, cls) {
  if (Platform.OS !== 'android') return false;
  try {
    await IntentLauncher.startActivityAsync('android.intent.action.MAIN', {
      packageName: pkg, className: cls,
    });
    return true;
  } catch {
    try { await Linking.openSettings(); } catch { /* nothing left to try */ }
    return false;
  }
}

async function openBatterySettings() {
  if (Platform.OS !== 'android') return false;
  try {
    await IntentLauncher.startActivityAsync(
      'android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS');
    return true;
  } catch {
    try { await Linking.openSettings(); } catch { /* nothing left to try */ }
    return false;
  }
}

/**
 * What is still missing, for the nudge on the Home screen. Returns the number
 * of permissions not yet granted; unknown counts as granted, because a build
 * without the module cannot be fixed from here and nagging about it is noise.
 */
export async function pendingPermissions() {
  const checks = [
    async () => (await Notifications?.getPermissionsAsync())?.granted,
    async () => (await Location?.getForegroundPermissionsAsync())?.granted,
    async () => (await Location?.getBackgroundPermissionsAsync())?.granted,
  ];
  let missing = 0;
  for (const check of checks) {
    try { if ((await check()) === false) missing += 1; } catch { /* unknown */ }
  }
  return missing;
}


export default function Setup({ onDone }) {
  const [perm, setPerm] = useState({ notif: null, loc: null, bg: null });
  const [checking, setChecking] = useState(true);
  const vendor = vendorKey();

  const refresh = useCallback(async () => {
    setChecking(true);
    const next = { notif: null, loc: null, bg: null };
    try { next.notif = (await Notifications?.getPermissionsAsync())?.granted ?? null; } catch { /* unknown */ }
    try { next.loc = (await Location?.getForegroundPermissionsAsync())?.granted ?? null; } catch { /* unknown */ }
    try { next.bg = (await Location?.getBackgroundPermissionsAsync())?.granted ?? null; } catch { /* unknown */ }
    setPerm(next);
    setChecking(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const ask = async (which) => {
    try {
      if (which === 'notif') await Notifications?.requestPermissionsAsync();
      if (which === 'loc') await Location?.requestForegroundPermissionsAsync();
      if (which === 'bg') await Location?.requestBackgroundPermissionsAsync();
    } catch { /* the refresh below reports whatever actually happened */ }
    refresh();
  };

  const ladder = [
    {
      key: 'notif', icon: 'bell', title: 'Alerts that make a sound',
      why: 'Without this, an SOS from your family arrives silently — which is the '
         + 'same as not arriving.',
      granted: perm.notif, action: 'ALLOW NOTIFICATIONS',
    },
    {
      key: 'loc', icon: 'map-pin', title: 'Your location',
      why: 'Attached to every alert you raise, so your family gets a map pin '
         + 'rather than a guess.',
      granted: perm.loc, action: 'ALLOW LOCATION',
    },
    {
      key: 'bg', icon: 'navigation', title: 'Location while the app is closed',
      why: 'This is what keeps the watch running in your pocket. Choose "Allow all '
         + 'the time" on the screen Android shows next.',
      granted: perm.bg, action: 'ALLOW IN BACKGROUND',
      blocked: perm.loc === false,
    },
  ];

  const remaining = ladder.filter((r) => r.granted !== true).length;

  return (
    <ScrollView
      contentContainerStyle={s.wrap}
      refreshControl={<RefreshControl refreshing={checking} onRefresh={refresh} tintColor={C.green} />}
    >
      <View style={{ gap: 6 }}>
        <Label>Setup</Label>
        <Txt variant="h1">Make sure Nigehban survives your phone</Txt>
        <Text style={[T.body, { color: C.dim }]}>
          Four steps, once. Every one of them is something Android will otherwise
          switch off quietly, on the day it matters.
        </Text>
      </View>

      {remaining === 0 ? (
        <Banner tone={C.green} icon="check-circle" title="Permissions are all set">
          Only the vendor step below is left, and it is the one people skip.
        </Banner>
      ) : null}

      <View style={{ gap: S.md }}>
        {ladder.map((r, i) => (
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
                      icon={r.icon} onPress={() => ask(r.key)} />
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
              <Text style={[T.title, { color: C.dim }]}>4</Text>
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
      </View>

      {onDone ? (
        <Button title="DONE" filled icon="check" onPress={onDone} />
      ) : null}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  wrap: { padding: S.lg, gap: S.lg, paddingBottom: 48 },
  stepHead: { flexDirection: 'row', gap: S.md, alignItems: 'flex-start' },
  num: {
    width: 32, height: 32, borderRadius: 6, backgroundColor: C.raised,
    alignItems: 'center', justifyContent: 'center',
  },
});
