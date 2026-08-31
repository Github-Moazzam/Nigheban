const { AndroidConfig, withAndroidManifest, withPlugins } = require('@expo/config-plugins');

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

module.exports = function withNigehbanAndroid(config) {
  return withPlugins(config, [withNigehbanPermissions, withLockScreenTakeover]);
};
