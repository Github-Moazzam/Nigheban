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
// The failure counter, and when the gate reopens. Plain AsyncStorage: it is not
// a secret, and it must survive things the keystore is not guaranteed to.
const FAILS_KEY = 'nigehban.disarmPin.fails';
const UNTIL_KEY = 'nigehban.disarmPin.until';

/**
 * THE ATTEMPT LIMIT, and why it had to leave the sheet.
 *
 * `PinSheet` counted three wrong tries and then disabled its keypad -- but it
 * reset that counter every time it closed. Three guesses, close the sheet,
 * three more, forever. Four digits is ten thousand combinations and this is a
 * person holding a phone with nothing else to do, so the limit was decoration.
 *
 * It matters more than it used to. This same gate stands in front of disarming
 * High Alert, removing somebody from the family, and now revealing what the
 * band will accept -- and the first two are exactly what a person who has taken
 * this phone wants. So the count is persisted, and the wait escalates.
 *
 * Three free attempts, then 30s, 2min, and 5min from there on. At three tries
 * per five minutes, walking all ten thousand takes about eleven days of
 * uninterrupted work, which is enough to make it not worth starting.
 *
 * The ceiling is deliberately low. This gate's other job is letting a
 * frightened person turn High Alert off, and a lockout measured in hours would
 * be this app holding its own user hostage. Five minutes stops a search without
 * ever becoming that.
 */
const FREE_TRIES = 3;
const PIN_LOCKOUT_MS = [30000, 120000, 300000];

async function readNum(key) {
  try { return parseInt((await AsyncStorage.getItem(key)) || '0', 10) || 0; }
  catch { return 0; }
}

/** Milliseconds until the gate will look at another PIN. 0 means now. */
export async function pinLockoutLeft() {
  const until = await readNum(UNTIL_KEY);
  if (!until) return 0;
  const left = until - Date.now();
  // A clock moved backwards, or a lockout that has expired. Either way, clear
  // it rather than leaving a stale number to be reasoned about later.
  if (left <= 0 || left > PIN_LOCKOUT_MS[PIN_LOCKOUT_MS.length - 1]) {
    try { await AsyncStorage.removeItem(UNTIL_KEY); } catch { /* best effort */ }
    return 0;
  }
  return left;
}

async function notePinFailure() {
  const fails = (await readNum(FAILS_KEY)) + 1;
  try { await AsyncStorage.setItem(FAILS_KEY, String(fails)); } catch { /* best effort */ }
  if (fails <= FREE_TRIES) return 0;

  const idx = Math.min(fails - FREE_TRIES - 1, PIN_LOCKOUT_MS.length - 1);
  const wait = PIN_LOCKOUT_MS[idx];
  try { await AsyncStorage.setItem(UNTIL_KEY, String(Date.now() + wait)); }
  catch { /* best effort */ }
  return wait;
}

async function clearPinFailures() {
  try {
    await AsyncStorage.removeItem(FAILS_KEY);
    await AsyncStorage.removeItem(UNTIL_KEY);
  } catch { /* best effort */ }
}

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
  // Choosing a PIN is proof enough of the owner, and leaving a stale lockout
  // behind would lock somebody out of a PIN they had just set.
  await clearPinFailures();
}

/**
 * Check a PIN, and count it if it is wrong.
 *
 * Returns `{ ok, lockedFor }` rather than a bare boolean, because "no" and
 * "not right now" are different answers and the sheet has to say which.
 * `lockedFor` is milliseconds and is 0 unless this attempt closed the gate.
 */
export async function verifyPin(pin) {
  const waiting = await pinLockoutLeft();
  if (waiting > 0) return { ok: false, lockedFor: waiting };

  const stored = await get();
  // Nothing set yet: do not lock anyone out. Callers that mean "prove it" must
  // check hasPin() first -- see the note at the top of this file.
  if (!stored) return { ok: true, lockedFor: 0 };

  if (stored === pin) {
    await clearPinFailures();
    return { ok: true, lockedFor: 0 };
  }
  return { ok: false, lockedFor: await notePinFailure() };
}

export async function clearPin() {
  if (Secure?.deleteItemAsync) {
    try { await Secure.deleteItemAsync(KEY); } catch { /* fall through */ }
  }
  try { await AsyncStorage.removeItem(KEY); } catch { /* best effort */ }
  await clearPinFailures();
}
