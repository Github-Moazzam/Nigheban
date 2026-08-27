import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView,
  StyleSheet, Text, View,
} from 'react-native';
import {
  call, discoverServers, loadServerUrl, normaliseUrl, probe,
  saveServerUrl, saveSession, serverFromDevHost,
} from '../api';
import { C, S, T } from '../theme';
import { Banner, Button, Card, Chip, Divider, Field, Icon, Txt } from '../ui';

/**
 * The first screen, and the only one that asks for anything before it earns
 * trust. Three fields, one of which the app usually fills in by itself, and a
 * sentence at the bottom saying exactly where the data goes.
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

  return (
    <KeyboardAvoidingView style={s.flex}
                          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.wrap} keyboardShouldPersistTaps="handled">
        <View style={s.brand}>
          <View style={s.mark}>
            <Icon name="shield" size={26} color={C.green} />
          </View>
          <Txt variant="h1" style={{ letterSpacing: 3 }}>NIGEHBAN</Txt>
          <Text style={[T.body, { color: C.dim }]}>Someone is watching out for you</Text>
        </View>

        <Card style={{ gap: S.lg }}>
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
              <Chip text={`found from the ${resolved}`} tone={C.green} icon="check" />
            ) : null}

            {scanning ? (
              <View style={s.scanRow}>
                <ActivityIndicator color={C.green} size="small" />
                <Text style={[T.meta, { color: C.dim }]}>
                  Searching this Wi-Fi… {Math.round(progress * 100)}%
                </Text>
              </View>
            ) : (
              <Button title="FIND MY LAPTOP ON THIS WI-FI" tone={C.dim} icon="search"
                      sub="only works on the same network" onPress={findServer} />
            )}
          </View>

          <Divider />

          {mode === 'register' ? (
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
              <Icon name={showPw ? 'eye-off' : 'eye'} size={14} color={C.dim} />
              <Text style={[T.meta, { color: C.dim }]}>
                {showPw ? 'Hide password' : 'Show password'}
              </Text>
            </Pressable>
          </View>

          {err ? (
            <Banner tone={C.red} icon="alert-circle" title="That did not work">{err}</Banner>
          ) : null}

          <Button title={mode === 'login' ? 'SIGN IN' : 'CREATE ACCOUNT'}
                  filled icon="log-in" loading={busy} onPress={submit} />

          <Button title={mode === 'login' ? 'New here? Create an account'
                                          : 'I already have an account'}
                  tone={C.dim}
                  onPress={() => { setMode(mode === 'login' ? 'register' : 'login'); setErr(null); }} />
        </Card>

        <Text style={s.footer}>
          Your account, your family list and every alert live on the server you point
          this at. During testing that is a laptop reachable through a tunnel; nothing
          is stored anywhere else.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1, backgroundColor: C.bg },
  wrap: { padding: S.xl, paddingTop: 64, paddingBottom: 48, gap: S.xl },
  brand: { alignItems: 'center', gap: S.sm },
  mark: {
    width: 56, height: 56, borderRadius: 10, backgroundColor: C.greenSoft,
    alignItems: 'center', justifyContent: 'center', marginBottom: S.sm,
  },
  scanRow: { flexDirection: 'row', alignItems: 'center', gap: S.sm, paddingVertical: S.md },
  pwToggle: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6 },
  footer: { ...T.meta, color: C.faint, textAlign: 'center', paddingHorizontal: S.sm },
});
