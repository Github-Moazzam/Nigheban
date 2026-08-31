import { requireOptionalNativeModule } from 'expo';

/**
 * The band-SOS wake, or `null` where it does not exist.
 *
 * `requireOptionalNativeModule` rather than `requireNativeModule`, for the same
 * reason as nigehban-alarm: this is Android-only and lives in the app binary,
 * so it is absent in Expo Go and on web. Throwing there would take the whole
 * app down on import, which is the opposite of what a safety feature should do
 * when it is missing. `src/bandWake.js` checks for null.
 */
export default requireOptionalNativeModule('NigehbanBandWake');
