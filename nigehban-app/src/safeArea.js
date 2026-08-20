import { Platform, TurboModuleRegistry } from 'react-native';

/**
 * Android 16 makes edge-to-edge mandatory, so the app draws underneath the
 * system navigation bar and anything at the bottom of the screen ends up
 * behind the back/home buttons.
 *
 * react-native-safe-area-context measures that bar properly, but an APK built
 * before it was added does not contain the native module -- and that APK still
 * loads this JavaScript from Metro. require() is no help there: it resolves out
 * of node_modules whether or not the binary was built with the module, so the
 * JS loads and the crash lands later, when Fabric looks up the
 * 'RNCSafeAreaProvider' view manager. Asking the native registry directly is
 * the check that matches the binary. It runs once at import time and falls back
 * to a constant that clears both gesture and three-button navigation. The
 * reference never changes between renders, so the hook below keeps a stable
 * call order.
 */
let useInsets = null;
let Provider = null;
// Returns null when the module is absent from the binary, so this is the one
// probe that tells us whether the native view managers exist.
if (TurboModuleRegistry.get('RNCSafeAreaContext')) {
  const mod = require('react-native-safe-area-context');
  useInsets = mod.useSafeAreaInsets;
  Provider = mod.SafeAreaProvider;
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
