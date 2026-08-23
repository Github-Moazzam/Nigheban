const { withAndroidManifest, withPlugins } = require('@expo/config-plugins');

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

module.exports = function withNigehbanAndroid(config) {
  return withPlugins(config, [withNigehbanPermissions]);
};
