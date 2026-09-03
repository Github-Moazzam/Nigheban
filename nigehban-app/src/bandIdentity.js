import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * THE BAND'S PIN, AND WHAT THE WEARER CALLS IT.
 *
 * Six digits, and a different secret from the four-digit disarm PIN in
 * `security.js`. They are not the same thing and must never be merged:
 *
 *   the disarm PIN   protects the wearer FROM the phone in someone else's
 *                    hand. It is four digits because it is typed under stress,
 *                    on a keypad that has to leave the cancel button visible.
 *
 *   the band PIN     protects the band FROM everybody else's phone. It is six
 *                    because BLE says so -- `BLE_GAP_PASSKEY_LEN` is 6, and
 *                    this exact string is what Android's pairing dialog asks
 *                    for and what the firmware then wants again over the
 *                    encrypted link.
 *
 * Storing it at all is a deliberate trade. The alternative is asking for six
 * digits every time the band reconnects, and the band reconnects on its own
 * after every walk out of range, every app kill and every reboot -- a safety
 * device that needs typing into before it works is a safety device that is off
 * when it is needed. So it goes in the keystore and the reconnect stays silent.
 *
 * The name is not a secret and lives in plain AsyncStorage. It is only a cache:
 * the band tells us its real name in `auth_ok`, and the band is always right --
 * it may have been renamed from another phone in the family.
 */

const PIN_KEY = 'nigehban.band.pin';
const NAME_KEY = 'nigehban.band.name';

// The value the firmware ships with (`DEFAULT_PAIR_PIN`). Kept here only so the
// app can say "this band is still on its factory PIN" out loud rather than
// leaving one open and quiet.
export const FACTORY_PIN = '123456';

let Secure = null;
try { Secure = require('expo-secure-store'); } catch { /* fall back below */ }

export function pinLegal(pin) {
  return /^\d{6}$/.test(pin || '');
}

/** 1-20 printable characters, no quote or backslash -- the firmware's rule. */
export function nameLegal(name) {
  const n = (name || '').trim();
  // eslint-disable-next-line no-control-regex
  return n.length >= 1 && n.length <= 20 && !/["\\]|[^\x20-\x7E]/.test(n);
}

export async function getBandPin() {
  if (Secure?.getItemAsync) {
    try {
      const v = await Secure.getItemAsync(PIN_KEY);
      if (v) return v;
    } catch { /* fall through */ }
  }
  try { return await AsyncStorage.getItem(PIN_KEY); } catch { return null; }
}

export async function setBandPin(pin) {
  if (!pinLegal(pin)) throw new Error('The band PIN is six digits.');
  if (Secure?.setItemAsync) {
    try { await Secure.setItemAsync(PIN_KEY, pin); return; } catch { /* fall through */ }
  }
  await AsyncStorage.setItem(PIN_KEY, pin);
}

export async function clearBandPin() {
  if (Secure?.deleteItemAsync) {
    try { await Secure.deleteItemAsync(PIN_KEY); } catch { /* fall through */ }
  }
  try { await AsyncStorage.removeItem(PIN_KEY); } catch { /* best effort */ }
}

export async function getBandName() {
  try { return await AsyncStorage.getItem(NAME_KEY); } catch { return null; }
}

export async function rememberBandName(name) {
  try {
    if (name) await AsyncStorage.setItem(NAME_KEY, name);
    else await AsyncStorage.removeItem(NAME_KEY);
  } catch { /* a cache, not a source of truth */ }
}
