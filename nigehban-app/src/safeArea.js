import { Platform } from 'react-native';

/**
 * Android 16 makes edge-to-edge mandatory, so the app draws underneath the
 * system navigation bar and anything at the bottom of the screen ends up
 * behind the back/home buttons.
 *
 * react-native-safe-area-context measures that bar properly, but an APK built
 * before it was added does not contain the native module -- and that APK still
 * loads this JavaScript from Metro. So the module is resolved once at import
 * time and we fall back to a constant that clears both gesture and three-button
 * navigation. The reference never changes between renders, so the hook below
 * keeps a stable call order.
 */
let useInsets = null;
let Provider = null;
try {
  const mod = require('react-native-safe-area-context');
  useInsets = mod.useSafeAreaInsets;
  Provider = mod.SafeAreaProvider;
} catch {
  /* older build: constants below are used instead */
}

export const hasSafeAreaModule = !!useInsets;

// Three-button navigation is the tallest at 48dp; gesture nav is about 24dp.
const FALLBACK_BOTTOM = Platform.OS === 'android' ? 48 : 0;
const FALLBACK_TOP = Platform.OS === 'android' ? 28 : 0;

export function useEdgeInsets() {
  if (!useInsets) return { top: FALLBACK_TOP, bottom: FALLBACK_BOTTOM };
  const i = useInsets();
  // Even with the module present, keep a floor so the tab bar never sits flush
  // against the very bottom edge on devices that report zero.
  return {
    top: Math.max(i.top, Platform.OS === 'android' ? 8 : 0),
    bottom: Math.max(i.bottom, Platform.OS === 'android' ? 12 : 0),
  };
}

/** Passes children straight through when the native module is unavailable. */
export function SafeAreaRoot({ children }) {
  if (!Provider) return children;
  return <Provider>{children}</Provider>;
}
