/**
 * THE PERMISSION LADDER, once, for both shells.
 *
 * This lived inside the admin Setup screen, and only there. The end-user shell
 * -- the one an actual wearer signs into -- shipped with no permission screen
 * at all: it got notifications when something tried to post one, and location
 * when the foreground service started, and nothing else was ever asked for. So
 * a fresh account on a stock Android 14 phone had:
 *
 *   - no USE_FULL_SCREEN_INTENT, which is the whole lock-screen takeover. It
 *     does not fail when missing, it silently downgrades to a heads-up
 *     notification, so "the screen call when the phone is off" simply did not
 *     happen and nothing anywhere said why.
 *   - no battery exemption and no vendor autostart, which is how the watch
 *     stops the first time the phone gets warm.
 *
 * None of that is admin diagnostics. It is the difference between the product
 * working and the product looking like it works, so it belongs to whoever is
 * wearing the thing. The copy lives here so both screens say the same words,
 * and the OEM table has one home rather than two that drift.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Linking, Platform } from 'react-native';
import { fullScreenIntentAllowed, openFullScreenIntentSettings } from './alarm';

let Location = null;
let Notifications = null;
let IntentLauncher = null;
try { Location = require('expo-location'); } catch { /* degrades below */ }
try { Notifications = require('expo-notifications'); } catch { /* degrades below */ }
try { IntentLauncher = require('expo-intent-launcher'); } catch { /* degrades below */ }

// Execution plan §7. Vendor, activity, and what the screen is called there.
export const OEM = {
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

export function vendorKey() {
  const m = (Platform.constants?.Manufacturer || Platform.constants?.Brand || '').toLowerCase();
  if (/xiaomi|redmi|poco/.test(m)) return 'xiaomi';
  if (/huawei|honor/.test(m)) return 'huawei';
  if (/oppo|realme/.test(m)) return 'oppo';
  if (/vivo|iqoo/.test(m)) return 'vivo';
  if (/samsung/.test(m)) return 'samsung';
  return null;
}

export async function openActivity(pkg, cls) {
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

export async function openBatterySettings() {
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
 * What this phone has granted. Each value is true / false / null, and null --
 * "cannot tell" -- is deliberately not folded into false: a build without the
 * module, or an Android that has no such permission, is not a refusal and must
 * not be nagged about.
 */
export async function readPermissions() {
  const out = { notif: null, loc: null, bg: null, fsi: null };
  try { out.notif = (await Notifications?.getPermissionsAsync())?.granted ?? null; } catch { /* unknown */ }
  try { out.loc = (await Location?.getForegroundPermissionsAsync())?.granted ?? null; } catch { /* unknown */ }
  try { out.bg = (await Location?.getBackgroundPermissionsAsync())?.granted ?? null; } catch { /* unknown */ }
  // null on Android 13 and below, in Expo Go, and on web -- the question does
  // not apply there, and the rung is dropped rather than shown as missing.
  try { out.fsi = await fullScreenIntentAllowed(); } catch { /* unknown */ }
  return out;
}

/**
 * Just the full-screen-intent answer, for callers that need only that one.
 * true / false / null, where null means the question does not apply.
 */
export async function fullScreenIntentState() {
  try { return await fullScreenIntentAllowed(); } catch { return null; }
}

/** This app's page in Android settings — the only way back from a denial. */
export async function openAppSettings() {
  try { await Linking.openSettings(); return true; } catch { return false; }
}

/**
 * Ask for one rung. The caller re-reads afterwards rather than trusting this.
 *
 * `denied` matters: Android only ever shows a runtime prompt once, so asking
 * again after a refusal does nothing at all and leaves the user tapping a
 * button that has no effect. The settings page is the only way back.
 */
export async function askPermission(key, denied = false) {
  if (denied && key !== 'fsi') return openAppSettings();
  try {
    if (key === 'notif') await Notifications?.requestPermissionsAsync();
    if (key === 'loc') await Location?.requestForegroundPermissionsAsync();
    if (key === 'bg') await Location?.requestBackgroundPermissionsAsync();
    // There is no runtime prompt for this one. Android 14 stopped granting it
    // at install to anything that is not a phone or an alarm clock, and the
    // only way to get it is the Settings page.
    if (key === 'fsi') await openFullScreenIntentSettings();
  } catch { /* the re-read reports whatever actually happened */ }
}

/**
 * The rungs, in the order they should be asked for, with the one sentence of
 * why that turns a denial into a yes. Rungs that do not apply to this phone
 * are left out entirely.
 */
export function ladderRows(perm) {
  const rows = [
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

  if (perm.fsi !== null && perm.fsi !== undefined) {
    rows.push({
      key: 'fsi', icon: 'phone-incoming', title: 'Take over the screen, like a call',
      why: 'A family emergency should ring through a locked phone instead of '
         + 'waiting in the notification tray. Android calls this "full screen '
         + 'notifications" and it has to be switched on by hand.',
      granted: perm.fsi, action: 'ALLOW FULL-SCREEN ALERTS',
    });
  }

  return rows;
}

const ASKED_KEY = 'nigehban.permissionsAsked';

/**
 * Ask, on the first launch of a new account, rather than waiting for somebody
 * to go looking for a settings tab.
 *
 * Two rungs only, and the omissions are deliberate:
 *
 *   - **Background location is not asked for here.** "Allow all the time" is
 *     the most alarming prompt Android has, and a family member watching from
 *     across town does not need it -- their emergencies arrive by push, which
 *     works with the app dead. It is asked for by startBackgroundWatch, at the
 *     moment this phone actually becomes a safety device, which is also the
 *     moment the request makes sense to the person reading it.
 *   - **The full-screen intent is not asked for here** because it cannot be:
 *     there is no prompt, only a Settings page, and throwing somebody into
 *     Settings before they have seen the app is how they leave. The Home
 *     screen asks for it in place, once there is something to explain.
 *
 * Runs once per install. A refusal is not re-asked -- Android would not show
 * the prompt a second time anyway -- and the Setup tab is where it is fixed.
 */
export async function runFirstRunAsks() {
  try {
    if (await AsyncStorage.getItem(ASKED_KEY)) return false;
  } catch { /* ask anyway: a duplicate prompt beats a missing one */ }

  const before = await readPermissions();
  if (before.notif !== true) await askPermission('notif');
  if (before.loc !== true) await askPermission('loc');

  try { await AsyncStorage.setItem(ASKED_KEY, String(Date.now())); } catch { /* non-fatal */ }
  return true;
}

/**
 * What is still missing, for the nudge on the Home screen. Returns the number
 * of permissions not yet granted; unknown counts as granted, because a build
 * without the module cannot be fixed from here and nagging about it is noise.
 */
export async function pendingPermissions() {
  const perm = await readPermissions();
  return ladderRows(perm).filter((r) => r.granted === false).length;
}
