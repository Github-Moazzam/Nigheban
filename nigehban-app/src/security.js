import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * The security PIN (matrix #16). Historically the disarm PIN, and the storage
 * key still says so.
 *
 * High Alert exists for the walk home that somebody else might be watching.
 * If a phone taken out of your hand can switch it off with one tap, the mode
 * protects nobody -- so disarming asks for four digits, and arming never does.
 * Arming must stay free: a control you have to authenticate into is a control
 * you do not use when you are frightened.
 *
 * The same four digits now stand in front of removing somebody from the family
 * list, on the same reasoning: it is the other way to make this phone stop
 * calling for help, it takes effect in both directions immediately, and nobody
 * is told it happened. Adding family is not gated for the same reason arming
 * is not.
 *
 * Note for callers building a gate: `verifyPin` answers TRUE when nothing has
 * been stored, deliberately -- see below. A screen that means "prove it" has to
 * check `hasPin()` first and ask for one to be set, or it will let anybody
 * through.
 *
 * Stored in the platform keystore when it is available, falling back to the
 * same AsyncStorage the session token already lives in. That fallback is worth
 * being honest about: it is device-local and unencrypted, so it stops the
 * person holding your phone, not someone with a forensic image of it. That is
 * the threat this feature is actually about.
 */

const KEY = 'nigehban.disarmPin';

let Secure = null;
try { Secure = require('expo-secure-store'); } catch { /* fall back below */ }

async function put(value) {
  if (Secure?.setItemAsync) {
    try { await Secure.setItemAsync(KEY, value); return; } catch { /* fall through */ }
  }
  await AsyncStorage.setItem(KEY, value);
}

async function get() {
  if (Secure?.getItemAsync) {
    try {
      const v = await Secure.getItemAsync(KEY);
      if (v) return v;
    } catch { /* fall through */ }
  }
  try { return await AsyncStorage.getItem(KEY); } catch { return null; }
}

export async function hasPin() {
  return !!(await get());
}

export async function setPin(pin) {
  if (!/^\d{4}$/.test(pin || '')) throw new Error('A PIN is four digits.');
  await put(pin);
}

export async function verifyPin(pin) {
  const stored = await get();
  if (!stored) return true;          // nothing set yet: do not lock anyone out
  return stored === pin;
}

export async function clearPin() {
  if (Secure?.deleteItemAsync) {
    try { await Secure.deleteItemAsync(KEY); } catch { /* fall through */ }
  }
  try { await AsyncStorage.removeItem(KEY); } catch { /* best effort */ }
}
