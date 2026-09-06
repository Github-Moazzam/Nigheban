import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadSession } from './api';

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
 * NOT the band's PIN. That one is six digits, lives in `bandIdentity.js` under
 * `nigehban.band.pin`, and is forgotten on a deliberate disconnect -- a rule
 * this file has nothing to do with. Two separate secrets with two separate
 * lifetimes, and `bandIdentity.js` says why they must never be merged.
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
 *
 * Device-local also means device-only: nothing is kept on the server, so a
 * reinstall or a new handset starts with no PIN at all. Carrying it across is a
 * separate job, and it wants a hash held against the account -- never the
 * digits. This PIN is only ever compared, never read back, which is exactly
 * what makes it the opposite case from the band PIN escrow.
 */

/**
 * THE KEYS, AND WHY THEY CARRY AN ACCOUNT.
 *
 * These were three bare constants, which made the PIN belong to the HANDSET
 * rather than to the person. That forced sign-out to delete it: leave it, and
 * the next account to sign in on this phone inherits a four-digit gate nobody
 * on it knows, standing in front of its own High Alert disarm and its own
 * family list.
 *
 * The cost of that was paid by the ordinary case. Signing out and back in on
 * your own phone threw your PIN away without saying so, and the first you heard
 * of it was High Alert disarming on one tap because there was no longer
 * anything to ask for -- a gate that quietly stops being a gate, which is worse
 * than one that was never there.
 *
 * An account in the key answers both at once. Two people on one phone get two
 * PINs that cannot see each other, and neither has to be destroyed for the
 * other to be safe. So nothing here is cleared at sign-out any more: the only
 * things that remove a PIN are the wearer asking for it in Settings, and
 * uninstalling the app.
 */
const BASE = 'nigehban.disarmPin';

/**
 * What the key was before it carried an account. Read once, then moved.
 *
 * A PIN still sitting here belongs to whoever is signed in now, and that is not
 * a guess: the sign-out wipe this change removes means anybody still holding a
 * legacy PIN has not signed out since setting it.
 */
const LEGACY_KEY = BASE;

/** SecureStore keys are [A-Za-z0-9._-] only, and an id arrives off the wire. */
function slug(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * The three keys for whoever is signed in, resolved at the moment of use rather
 * than bound once at login. Nothing elsewhere has to remember to re-point this
 * file at the new account, and there is no window in which a screen that
 * mounted early reads the last person's PIN.
 *
 * Signed out they collapse to the bare names. No screen that can set or ask for
 * a PIN is reachable there, so that is a fallback rather than a path -- it
 * exists so a stray call cannot throw inside somebody's useEffect.
 */
async function keys() {
  let who = null;
  try {
    const s = await loadSession();
    if (s?.user_id) who = slug(s.user_id);
  } catch { /* signed out or unreadable: fall back to the bare names */ }
  const tail = who ? `.${who}` : '';
  return { pin: `${BASE}${tail}`, fails: `${BASE}.fails${tail}`, until: `${BASE}.until${tail}` };
}

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
 *
 * The counter carries an account for the same reason the PIN does, and
 * switching accounts is not a way around it: that needs a password the person
 * this limit exists to stop does not have.
 */
const FREE_TRIES = 3;
const PIN_LOCKOUT_MS = [30000, 120000, 300000];

// The failure counter, and when the gate reopens. Plain AsyncStorage: neither
// is a secret, and both must survive things the keystore is not guaranteed to.
async function readNum(key) {
  try { return parseInt((await AsyncStorage.getItem(key)) || '0', 10) || 0; }
  catch { return 0; }
}

async function lockoutLeft(k) {
  const until = await readNum(k.until);
  if (!until) return 0;
  const left = until - Date.now();
  // A clock moved backwards, or a lockout that has expired. Either way, clear
  // it rather than leaving a stale number to be reasoned about later.
  if (left <= 0 || left > PIN_LOCKOUT_MS[PIN_LOCKOUT_MS.length - 1]) {
    try { await AsyncStorage.removeItem(k.until); } catch { /* best effort */ }
    return 0;
  }
  return left;
}

/** Milliseconds until the gate will look at another PIN. 0 means now. */
export async function pinLockoutLeft() {
  return lockoutLeft(await keys());
}

async function notePinFailure(k) {
  const fails = (await readNum(k.fails)) + 1;
  try { await AsyncStorage.setItem(k.fails, String(fails)); } catch { /* best effort */ }
  if (fails <= FREE_TRIES) return 0;

  const idx = Math.min(fails - FREE_TRIES - 1, PIN_LOCKOUT_MS.length - 1);
  const wait = PIN_LOCKOUT_MS[idx];
  try { await AsyncStorage.setItem(k.until, String(Date.now() + wait)); }
  catch { /* best effort */ }
  return wait;
}

async function clearPinFailures(k) {
  try {
    await AsyncStorage.removeItem(k.fails);
    await AsyncStorage.removeItem(k.until);
  } catch { /* best effort */ }
}

let Secure = null;
try { Secure = require('expo-secure-store'); } catch { /* fall back below */ }

async function put(key, value) {
  if (Secure?.setItemAsync) {
    try { await Secure.setItemAsync(key, value); return; } catch { /* fall through */ }
  }
  await AsyncStorage.setItem(key, value);
}

async function readKey(key) {
  if (Secure?.getItemAsync) {
    try {
      const v = await Secure.getItemAsync(key);
      if (v) return v;
    } catch { /* fall through */ }
  }
  try { return await AsyncStorage.getItem(key); } catch { return null; }
}

async function del(key) {
  if (Secure?.deleteItemAsync) {
    try { await Secure.deleteItemAsync(key); } catch { /* fall through */ }
  }
  try { await AsyncStorage.removeItem(key); } catch { /* best effort */ }
}

async function get(k) {
  const v = await readKey(k.pin);
  if (v) return v;
  // Nothing under this account's key. Before answering "no PIN" -- an answer
  // that opens gates -- look for one set before the keys carried an account and
  // adopt it. Moved rather than copied, so it happens once and cannot later
  // surface again under a second account on the same phone.
  if (k.pin === LEGACY_KEY) return null;
  const legacy = await readKey(LEGACY_KEY);
  if (!legacy) return null;
  await put(k.pin, legacy);
  await del(LEGACY_KEY);
  return legacy;
}

export async function hasPin() {
  return !!(await get(await keys()));
}

export async function setPin(pin) {
  if (!/^\d{4}$/.test(pin || '')) throw new Error('A PIN is four digits.');
  const k = await keys();
  await put(k.pin, pin);
  // Choosing a PIN is proof enough of the owner, and leaving a stale lockout
  // behind would lock somebody out of a PIN they had just set.
  await clearPinFailures(k);
}

/**
 * Check a PIN, and count it if it is wrong.
 *
 * Returns `{ ok, lockedFor }` rather than a bare boolean, because "no" and
 * "not right now" are different answers and the sheet has to say which.
 * `lockedFor` is milliseconds and is 0 unless this attempt closed the gate.
 */
export async function verifyPin(pin) {
  const k = await keys();
  const waiting = await lockoutLeft(k);
  if (waiting > 0) return { ok: false, lockedFor: waiting };

  const stored = await get(k);
  // Nothing set yet: do not lock anyone out. Callers that mean "prove it" must
  // check hasPin() first -- see the note at the top of this file.
  if (!stored) return { ok: true, lockedFor: 0 };

  if (stored === pin) {
    await clearPinFailures(k);
    return { ok: true, lockedFor: 0 };
  }
  return { ok: false, lockedFor: await notePinFailure(k) };
}

/**
 * Remove this account's PIN.
 *
 * Named for the PIN it removes, because as `clearPin` it sat next to
 * `clearBandPin` in `bandIdentity.js` and read as the general one beside the
 * special case -- when both are specific. That is how a sign-out meaning to
 * forget the WRISTBAND came to delete the wearer's disarm PIN instead.
 *
 * The wearer asking for it in Settings is the only caller. Sign-out is not one:
 * it forgets the band, and the band's own six digits go with it through
 * `band.disconnect()`, which is what that step was always for.
 */
export async function clearDisarmPin() {
  const k = await keys();
  await del(k.pin);
  await clearPinFailures(k);
}
