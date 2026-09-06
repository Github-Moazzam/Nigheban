import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import { call, saveSession, SERVER_URL } from '../api';
import { S, T } from '../theme';
import { Icon, Txt } from '../ui';
import { RU, U } from './user/kit';

/** Which icon carries the message. Words first, but the icon gets there first. */
const ERR_ICON = {
  network: 'wifi-off',
  timeout: 'clock',
  rate: 'clock',
  server: 'server',
  protocol: 'alert-triangle',
};

/**
 * How long the button stays disabled after the server says "too many tries".
 *
 * Deliberately shorter than the five minutes the server is enforcing, and not a
 * claim about when the lock ends -- it is the interval that stops the button
 * being pressed forty more times while the banner is being read. Pressing it
 * again after a minute simply gets the same answer and starts the same minute
 * over, which is the honest outcome and costs nothing: the rate limiter drops a
 * refused attempt rather than counting it, so a retry does not extend the lock.
 */
const COOLDOWN_S = 60;

const mmss = (n) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;

/**
 * The same rules the server applies, applied before the round trip.
 *
 * Not a replacement for the server's copy -- that is the one that decides --
 * but the trip is worth skipping twice over. An empty sign-in form comes back
 * from the server as "wrong username or password", which is untrue and sends
 * someone hunting for a typo in a box they never filled; and every refused
 * attempt spends one of the eight per account the rate limiter allows.
 *
 * Sign-in checks only that the boxes are filled. The format rules belong to
 * account creation, and an account made before a rule existed must still be
 * able to get in. Order follows the screen, so the error lands on the first
 * box with something wrong rather than the first rule in this list.
 */
function validate(mode, { username, password, name }) {
  const register = mode === 'register';
  if (register && !name.trim()) {
    return { field: 'name', message: 'Please enter your name.' };
  }
  if (!username.trim()) {
    return { field: 'username', message: 'Please enter your username.' };
  }
  if (register && !/^[a-z0-9_.]{3,20}$/.test(username.trim().toLowerCase())) {
    return {
      field: 'username',
      message: 'Username must be 3–20 characters, using only letters, numbers, dots or underscores.',
    };
  }
  if (!password) {
    return { field: 'password', message: 'Please enter your password.' };
  }
  if (register && password.length < 4) {
    return { field: 'password', message: 'Password must be at least 4 characters.' };
  }
  return null;
}

/**
 * The first screen. Username and password to sign in, or username, password and
 * name to create an account. The server address is hardcoded to
 * nigheban.duckdns.org — no setup needed.
 *
 * It is dressed in the user theme rather than the console one on purpose: this
 * is the first thing anybody sees, admin included, and the product it should
 * look like is the one the wearer will be holding -- charcoal, wide corners,
 * mint as the only saturated colour. Nothing here knows the role yet; that is
 * decided by the server, one request after the last tap on this screen.
 */
export default function Auth({ onDone }) {
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [showPw, setShowPw] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  const register = mode === 'register';

  const boxes = {
    name: useRef(null),
    username: useRef(null),
    password: useRef(null),
  };

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const t = setTimeout(() => setCooldown((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  /** Show it, and put the cursor in the box it is about. */
  const fail = (e) => {
    setErr(e);
    if (e.field) boxes[e.field]?.current?.focus();
  };

  /**
   * Any keystroke is the user acting on the message, so it stops being news --
   * except a rate limit, which is not something retyping fixes and whose banner
   * is carrying the countdown the disabled button is still running.
   */
  const typing = (setter) => (v) => {
    setter(v);
    if (err && err.kind !== 'rate') setErr(null);
  };

  const submit = async () => {
    if (busy || cooldown > 0) return;

    const bad = validate(mode, { username, password, name });
    if (bad) { fail({ ...bad, kind: 'validation' }); return; }

    setErr(null);
    setBusy(true);

    let session;
    try {
      const body = register
        ? { username: username.trim(), password, name: name.trim() }
        : { username: username.trim(), password };
      const r = await call({ url: SERVER_URL }, register ? '/register' : '/login',
                           { method: 'POST', body });
      if (!r || !r.token) {
        throw new Error("The server's answer was missing the sign-in token. Please try again.");
      }
      session = { url: SERVER_URL, token: r.token, user_id: r.user_id, name: r.name, role: r.role || 'user' };
    } catch (e) {
      if (e.status === 429) setCooldown(COOLDOWN_S);
      fail({ message: e.message, field: e.field || null, kind: e.kind || 'error' });
      setBusy(false);
      return;
    }

    // Past this line the account exists and the token is real, so nothing below
    // may report a failure to sign in. Storing the session is what keeps the
    // user signed in across launches, and it can fail on its own (a full disk,
    // a browser refusing storage in a private window) -- but it has no bearing
    // on whether this sign-in worked, and turning it into an error on screen
    // would send someone to re-type a password that was never the problem.
    try {
      await saveSession(session);
    } catch (e) {
      if (typeof __DEV__ !== 'undefined' && __DEV__) console.warn('[auth] session not stored', e);
    }
    setBusy(false);
    onDone(session);
  };

  // A message about a box that is on screen belongs under that box, where the
  // house style puts it. Everything else -- the network is down, the server is
  // unhappy, "wrong username or password" which is about both boxes and so
  // about neither -- gets the banner.
  const shown = register ? ['name', 'username', 'password'] : ['username', 'password'];
  const inField = err?.field && shown.includes(err.field);
  const noteFor = (f) => (inField && err.field === f ? err.message : null);

  return (
    <KeyboardAvoidingView style={s.flex}
                          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.wrap} keyboardShouldPersistTaps="handled">
        <View style={s.brand}>
          <View style={s.mark}>
            <Icon name="shield" size={28} color={U.mint} />
          </View>
          <Txt variant="h1" color={U.text} style={{ letterSpacing: 3 }}>NIGEHBAN</Txt>
          <Text style={[T.body, { color: U.dim }]}>Someone is watching out for you</Text>
        </View>

        <View style={s.card}>
          {/* Both doors, side by side. A link at the bottom of a form is the
              easiest thing on a sign-in screen to miss. */}
          <View style={s.segment}>
            {[['login', 'Sign in'], ['register', 'Create account']].map(([k, label]) => {
              const on = mode === k;
              return (
                <Pressable
                  key={k}
                  // The two doors are rate-limited separately on the server, so
                  // being locked out of one says nothing about the other.
                  onPress={() => { setMode(k); setErr(null); setCooldown(0); }}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: on }}
                  style={[s.segBtn, on && { backgroundColor: U.raised }]}
                >
                  <Text style={[T.button, { fontSize: 14, color: on ? U.text : U.faint }]}>
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {register ? (
            <Field label="Your name" value={name} onChangeText={typing(setName)}
                   inputRef={boxes.name} error={noteFor('name')}
                   placeholder="Ali" autoCapitalize="words"
                   hint="This is the name your family sees on an alert." />
          ) : null}

          <Field label="Username" value={username} onChangeText={typing(setUsername)}
                 inputRef={boxes.username} error={noteFor('username')}
                 placeholder="ali" autoCapitalize="none" autoCorrect={false}
                 textContentType="username" />

          <View style={{ gap: 6 }}>
            <Field label="Password" value={password} onChangeText={typing(setPassword)}
                   inputRef={boxes.password} error={noteFor('password')}
                   placeholder="••••••" secureTextEntry={!showPw}
                   textContentType="password" />
            <Pressable onPress={() => setShowPw((v) => !v)} style={s.pwToggle}
                       accessibilityRole="button">
              <Icon name={showPw ? 'eye-off' : 'eye'} size={14} color={U.faint} />
              <Text style={[T.meta, { color: U.faint }]}>
                {showPw ? 'Hide password' : 'Show password'}
              </Text>
            </Pressable>
          </View>

          {/* The reason is the headline. It used to sit underneath a fixed
              "That did not work" in the smaller, dimmer style -- which put the
              one sentence that says what to do next in the position the eye
              reads last, under a line that carries no information at all. */}
          {err && !inField ? (
            <View style={s.err} accessibilityRole="alert" accessibilityLiveRegion="polite">
              <Icon name={ERR_ICON[err.kind] || 'alert-circle'} size={15} color={U.red}
                    style={{ marginTop: 2 }} />
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={[T.bodyMed, { color: U.red }]}>{err.message}</Text>
                {cooldown > 0 ? (
                  <Text style={[T.meta, { color: U.dim }]}>
                    You can try again in {mmss(cooldown)}.
                  </Text>
                ) : null}
              </View>
            </View>
          ) : null}

          <Button
            filled icon={register ? 'user-plus' : 'log-in'}
            title={cooldown > 0
              ? `Try again in ${mmss(cooldown)}`
              : register ? 'Create account' : 'Sign in'}
            busy={busy} disabled={cooldown > 0} onPress={submit}
          />
        </View>

        <Text style={s.footer}>
          Your data is securely stored on the Nigehban server.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/**
 * Label, input, and one line underneath: normally why the box exists, and when
 * something is wrong with it, what. The error replaces the hint rather than
 * joining it -- at the moment a box is wrong, what it is for is no longer the
 * useful half.
 */
function Field({ label, hint, error, value, onChangeText, inputRef, ...rest }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={[T.label, { color: error ? U.red : U.faint }]}>{label.toUpperCase()}</Text>
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={onChangeText}
        placeholderTextColor={U.faint}
        accessibilityLabel={label}
        style={[s.input, error && { backgroundColor: U.redSoft }]}
        {...rest}
      />
      {error ? (
        <View style={s.fieldNote} accessibilityRole="alert" accessibilityLiveRegion="polite">
          <Icon name="alert-circle" size={13} color={U.red} />
          <Text style={[T.meta, { color: U.red, flex: 1 }]}>{error}</Text>
        </View>
      ) : hint ? (
        <Text style={[T.meta, { color: U.faint }]}>{hint}</Text>
      ) : null}
    </View>
  );
}

/** Filled is the one thing to do next; the rest sit on the card. */
function Button({ icon, title, sub, onPress, filled, busy, disabled }) {
  const off = busy || disabled;
  const fg = filled ? U.bg : U.dim;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      style={({ pressed }) => [
        s.btn,
        { backgroundColor: filled ? U.mint : U.raised },
        disabled && !busy && { opacity: 0.5 },
        pressed && { opacity: 0.75 },
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={fg} />
      ) : (
        <>
          <Icon name={icon} size={16} color={fg} />
          <View>
            <Text style={[T.button, { color: fg }]}>{title}</Text>
            {sub ? <Text style={[T.meta, { color: fg, opacity: 0.75 }]}>{sub}</Text> : null}
          </View>
        </>
      )}
    </Pressable>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1, backgroundColor: U.bg },
  wrap: { padding: S.xl, paddingTop: 64, paddingBottom: 48, gap: S.xl },

  brand: { alignItems: 'center', gap: S.sm },
  mark: {
    width: 60, height: 60, borderRadius: RU.inner, backgroundColor: U.mintSoft,
    alignItems: 'center', justifyContent: 'center', marginBottom: S.sm,
  },

  card: {
    backgroundColor: U.card, borderRadius: RU.card,
    padding: S.xl, gap: S.lg,
  },
  segment: {
    flexDirection: 'row', backgroundColor: U.bg,
    borderRadius: RU.pill, padding: 4,
  },
  segBtn: {
    flex: 1, minHeight: 42, alignItems: 'center', justifyContent: 'center',
    borderRadius: RU.pill,
  },

  input: {
    ...T.body,
    color: U.text,
    backgroundColor: U.raised,
    borderRadius: RU.inner,
    paddingHorizontal: S.lg,
    minHeight: 52,
  },


  fieldNote: { flexDirection: 'row', alignItems: 'center', gap: 6 },

  pwToggle: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6 },

  err: {
    flexDirection: 'row', alignItems: 'flex-start', gap: S.sm,
    backgroundColor: U.redSoft, borderRadius: RU.inner, padding: S.md,
  },

  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: S.sm,
    minHeight: 52, borderRadius: RU.inner, paddingHorizontal: S.lg,
  },

  footer: { ...T.meta, color: U.faint, textAlign: 'center', paddingHorizontal: S.sm },
});
