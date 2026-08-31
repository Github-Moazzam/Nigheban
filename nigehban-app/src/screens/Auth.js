import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import {
  call, discoverServers, loadServerUrl, normaliseUrl, probe,
  saveServerUrl, saveSession, serverFromDevHost,
} from '../api';
import { S, T } from '../theme';
import { Icon, Txt } from '../ui';
import { RU, U } from './user/kit';

/**
 * The first screen, and the only one that asks for anything before it earns
 * trust. Three fields, one of which the app usually fills in by itself, and a
 * sentence at the bottom saying exactly where the data goes.
 *
 * It is dressed in the user theme rather than the console one on purpose: this
 * is the first thing anybody sees, admin included, and the product it should
 * look like is the one the wearer will be holding -- charcoal, wide corners,
 * mint as the only saturated colour. Nothing here knows the role yet; that is
 * decided by the server, one request after the last tap on this screen.
 */
export default function Auth({ initialUrl, onDone }) {
  const [mode, setMode] = useState('login');
  const [url, setUrl] = useState(initialUrl || '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [resolved, setResolved] = useState(null);
  const [showPw, setShowPw] = useState(false);

  // Work out the server address without asking. Cheapest source first: the dev
  // host the bundle came from, then whatever worked last time. Only if both
  // miss does anyone see an empty box.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (initialUrl) return;
      const fromHost = serverFromDevHost();
      const saved = await loadServerUrl();
      for (const [candidate, how] of [[fromHost, 'dev server'], [saved, 'last used']]) {
        if (!candidate || cancelled) continue;
        if (await probe(candidate)) {
          if (cancelled) return;
          setUrl(candidate);
          setResolved(how);
          return;
        }
      }
      if (!cancelled && (fromHost || saved)) setUrl(fromHost || saved);
    })();
    return () => { cancelled = true; };
  }, [initialUrl]);

  // Typing an IP on a phone is the worst part of a local-network app, so offer
  // to sweep the subnet instead. One hit is the common case; if a teammate is
  // also running a server we show both rather than guessing.
  const findServer = async () => {
    setScanning(true); setErr(null); setProgress(0);
    try {
      const hits = await discoverServers(setProgress);
      if (hits.length === 0) {
        setErr('No server found on this Wi-Fi. Is it running, and is the laptop on '
             + 'the same network? A firewall may also be blocking it.');
      } else if (hits.length === 1) {
        setUrl(hits[0]);
      } else {
        setUrl(hits[0]);
        setErr(`Found ${hits.length}: ${hits.join(', ')} — using the first.`);
      }
    } catch (e) {
      setErr(e.message);
    } finally {
      setScanning(false);
    }
  };

  const submit = async () => {
    setErr(null);
    const clean = normaliseUrl(url);
    if (!clean) { setErr('Enter the server address shown in the laptop terminal.'); return; }
    setBusy(true);
    try {
      const body = mode === 'login'
        ? { username, password }
        : { username, password, name };
      const r = await call({ url: clean }, mode === 'login' ? '/login' : '/register',
                           { method: 'POST', body });
      if (!r || !r.token) {
        throw new Error('That address answered, but not like the Nigehban server. '
                      + 'Check the port — the server is on 8000, Metro is on 8081.');
      }
      const session = { url: clean, token: r.token, user_id: r.user_id, name: r.name, role: r.role || 'user' };
      await saveSession(session);
      await saveServerUrl(clean);
      onDone(session);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const register = mode === 'register';

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
                  onPress={() => { setMode(k); setErr(null); }}
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

          <View style={{ gap: S.sm }}>
            <Field
              label="Server address" value={url} onChangeText={setUrl}
              placeholder="abc123.ngrok-free.app"
              autoCapitalize="none" autoCorrect={false} keyboardType="url"
              hint={resolved
                ? undefined
                : 'Paste the address the laptop printed. A tunnel URL works from '
                  + 'anywhere, mobile data included.'}
            />
            {resolved ? (
              <View style={s.found}>
                <Icon name="check" size={12} color={U.mint} />
                <Text style={[T.label, { color: U.mint }]}>
                  {`FOUND FROM THE ${resolved.toUpperCase()}`}
                </Text>
              </View>
            ) : null}

            {scanning ? (
              <View style={s.scanRow}>
                <ActivityIndicator color={U.mint} size="small" />
                <Text style={[T.meta, { color: U.dim }]}>
                  Searching this Wi-Fi… {Math.round(progress * 100)}%
                </Text>
              </View>
            ) : (
              <Button
                icon="search" title="Find my laptop on this Wi-Fi"
                sub="only works on the same network" onPress={findServer}
              />
            )}
          </View>

          <View style={s.line} />

          {register ? (
            <Field label="Your name" value={name} onChangeText={setName}
                   placeholder="Ali" autoCapitalize="words"
                   hint="This is the name your family sees on an alert." />
          ) : null}

          <Field label="Username" value={username} onChangeText={setUsername}
                 placeholder="ali" autoCapitalize="none" autoCorrect={false}
                 textContentType="username" />

          <View style={{ gap: 6 }}>
            <Field label="Password" value={password} onChangeText={setPassword}
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

          {err ? (
            <View style={s.err}>
              <Icon name="alert-circle" size={15} color={U.red} style={{ marginTop: 2 }} />
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={[T.bodyMed, { color: U.red }]}>That did not work</Text>
                <Text style={[T.meta, { color: U.dim }]}>{err}</Text>
              </View>
            </View>
          ) : null}

          <Button
            filled icon={register ? 'user-plus' : 'log-in'}
            title={register ? 'Create account' : 'Sign in'}
            busy={busy} onPress={submit}
          />
        </View>

        <Text style={s.footer}>
          Your account, your family list and every alert live on the server you point
          this at. During testing that is a laptop reachable through a tunnel; nothing
          is stored anywhere else.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** Label, input, and one line underneath saying why the box exists. */
function Field({ label, hint, value, onChangeText, ...rest }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={[T.label, { color: U.faint }]}>{label.toUpperCase()}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholderTextColor={U.faint}
        accessibilityLabel={label}
        style={s.input}
        {...rest}
      />
      {hint ? <Text style={[T.meta, { color: U.faint }]}>{hint}</Text> : null}
    </View>
  );
}

/** Filled is the one thing to do next; the rest sit on the card. */
function Button({ icon, title, sub, onPress, filled, busy }) {
  const fg = filled ? U.bg : U.dim;
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={title}
      style={({ pressed }) => [
        s.btn,
        { backgroundColor: filled ? U.mint : U.raised },
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

  found: {
    flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
    backgroundColor: U.mintSoft, borderRadius: RU.pill,
    paddingHorizontal: S.md, paddingVertical: 6,
  },
  scanRow: { flexDirection: 'row', alignItems: 'center', gap: S.sm, paddingVertical: S.md },
  pwToggle: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6 },

  line: { height: StyleSheet.hairlineWidth, backgroundColor: U.line },

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
