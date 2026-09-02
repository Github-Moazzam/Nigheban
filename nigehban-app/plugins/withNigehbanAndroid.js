const {
  AndroidConfig,
  withAndroidManifest,
  withAppBuildGradle,
  withPlugins,
} = require('@expo/config-plugins');

/**
 * Expo Config Plugin: withNigehbanAndroid
 * Automatically configures Android Manifest for Nigehban background survival:
 * - Foreground service permissions (location, connected device BLE, data sync)
 * - Wake lock & battery optimization bypass permissions
 * - Full-screen intent permission for emergency alert takeover
 * - Boot completed permission for auto-restarting background watchdog
 */
function withNigehbanPermissions(config) {
  return withAndroidManifest(config, (config) => {
    const androidManifest = config.modResults;

    if (!androidManifest.manifest['uses-permission']) {
      androidManifest.manifest['uses-permission'] = [];
    }

    const permissionsToAdd = [
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_LOCATION',
      'android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE',
      'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
      'android.permission.RECEIVE_BOOT_COMPLETED',
      'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
      'android.permission.USE_FULL_SCREEN_INTENT',
      'android.permission.WAKE_LOCK',
      'android.permission.ACCESS_BACKGROUND_LOCATION',
    ];

    permissionsToAdd.forEach((permName) => {
      const exists = androidManifest.manifest['uses-permission'].some(
        (item) => item.$ && item.$['android:name'] === permName
      );
      if (!exists) {
        androidManifest.manifest['uses-permission'].push({
          $: { 'android:name': permName },
        });
      }
    });

    return config;
  });
}

/**
 * Let MainActivity appear over the keyguard, and wake the screen when it does.
 *
 * The `USE_FULL_SCREEN_INTENT` permission above only buys the right to *fire* a
 * full-screen intent. What happens next is decided by the activity it launches:
 * without these two flags Android brings MainActivity up behind the lock screen
 * and leaves the display off, so an SOS that fired perfectly is waiting silently
 * under a black screen for somebody to pick the phone up and unlock it.
 *
 * These are the same flags an incoming-call screen uses, and they replace the
 * deprecated FLAG_SHOW_WHEN_LOCKED / FLAG_TURN_SCREEN_ON window flags. Setting
 * them in the manifest rather than in Java is what makes them apply to a cold
 * launch, which is the case that matters -- the family's app will usually have
 * been killed hours before the emergency.
 *
 * `NigehbanAlarmModule.kt` is the other half of this.
 */
function withLockScreenTakeover(config) {
  return withAndroidManifest(config, (config) => {
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(config.modResults);
    activity.$['android:showWhenLocked'] = 'true';
    activity.$['android:turnScreenOn'] = 'true';
    return config;
  });
}

/**
 * Make `release` the only build variant that exists.
 *
 * Android Studio keeps the Build Variants selection in android/.idea/workspace.xml.
 * That file is out of reach from here twice over: .idea/.gitignore ignores
 * workspace.xml, and nigehban-app/.gitignore ignores the whole generated /android
 * folder. So the choice is per-machine scratch state, and a Gradle sync that fails
 * partway -- or any `expo prebuild --clean` -- throws it away and drops the panel
 * back to `debug`. That is the flapping, not a mis-click.
 *
 * Gradle has no "default variant for the IDE" setting to reach for instead. The
 * only way to make the selection stop moving is to leave the IDE nothing else to
 * pick, which is what disabling the debug variant does. It is re-applied on every
 * sync, from the build files, with no per-machine state involved.
 *
 * THE COST, so it is not a surprise three weeks from now: this deletes the debug
 * build. Everything that assumes a debug APK stops working --
 *   - `npm run android` (expo run:android). Use `expo run:android --variant release`.
 *   - the `development` profile in eas.json, which is a dev-client debug build.
 *   - Metro fast refresh and the expo-dev-launcher menu, which only ship in debug.
 * When you want that workflow back, delete this mod from the withPlugins list
 * below and re-run prebuild.
 *
 * Release is signed with the debug keystore in the app/build.gradle template, so a
 * release build still installs on a handset with no keystore setup of your own.
 */
const RELEASE_ONLY_MARKER = '// nigehban:release-only';

const RELEASE_ONLY_GROOVY = `
${RELEASE_ONLY_MARKER}
androidComponents {
    beforeVariants(selector().withBuildType("debug")) { variantBuilder ->
        variantBuilder.enable = false
    }
}
`;

function withReleaseOnlyVariant(config) {
  return withAppBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') {
      throw new Error(
        'withNigehbanAndroid: expected a Groovy android/app/build.gradle, got ' +
          `"${config.modResults.language}". The release-only block below is Groovy ` +
          'syntax and would not compile as Kotlin DSL.'
      );
    }

    // `expo prebuild` without --clean re-runs mods over the android/ folder that is
    // already on disk, so an unguarded append stacks a second copy every time.
    if (!config.modResults.contents.includes(RELEASE_ONLY_MARKER)) {
      config.modResults.contents += RELEASE_ONLY_GROOVY;
    }

    return config;
  });
}

module.exports = function withNigehbanAndroid(config) {
  return withPlugins(config, [
    withNigehbanPermissions,
    withLockScreenTakeover,
    withReleaseOnlyVariant,
  ]);
};
