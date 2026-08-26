import { requireOptionalNativeModule } from 'expo';

/**
 * The native alarm, or `null` where it does not exist.
 *
 * `requireOptionalNativeModule` rather than `requireNativeModule` on purpose:
 * this module is Android-only and lives in the app binary, so it is absent in
 * Expo Go and on web. Throwing there would take the whole app down on import,
 * which is the opposite of what a safety feature should do when it is missing.
 * `src/alarm.js` checks for null and falls back.
 */
export default requireOptionalNativeModule('NigehbanAlarm');
