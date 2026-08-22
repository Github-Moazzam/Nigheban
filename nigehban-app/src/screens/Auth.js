import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import {
  call, discoverServers, loadServerUrl, normaliseUrl, probe,
  saveServerUrl, saveSession, serverFromDevHost,
} from '../api';
import { C, MONO } from '../theme';
import { Button, Card, Label } from '../ui';

const mono = Platform.select(MONO);

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

  // Work out the server address without asking. Cheapest source first: the
  // dev host the bundle came from, then whatever worked last time. Only if
  // both miss does the user see an empty box.
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
        setErr('No server found on this Wi-Fi. Is it running, and is the '
             + 'laptop on the same network? The firewall may also be blocking it.');
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
        throw new Error('Invalid server response. Make sure port is 8000 (http://localhost:8000), not 8081!');
      }
      const session = { url: clean, token: r.token, user_id: r.user_id, name: r.name };
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
    <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.wrap} keyboardShouldPersistTaps="handled">
        <View style={s.brand}>
          <Text style={s.mark}>◈</Text>
          <Text style={s.title}>NIGEHBAN</Text>
          <Text style={s.sub}>someone is watching out for you</Text>
        </View>

        <Card style={{ gap: 16 }}>
          <View>
            <Label>Server address</Label>
            <TextInput
              style={s.input} value={url} onChangeText={setUrl}
              placeholder="abc123.ngrok-free.app" placeholderTextColor={C.faint}
              autoCapitalize="none" autoCorrect={false} keyboardType="url"
            />
            <Text style={resolved ? s.hintOk : s.hint}>
              {resolved
                ? `found automatically from the ${resolved}`
                : 'Paste the address the laptop printed. A tunnel URL works from '
                  + 'anywhere — mobile data included — and needs no Wi-Fi in common.'}
            </Text>
            {scanning ? (
              <View style={s.scanRow}>
                <ActivityIndicator color={C.green} size="small" />
                <Text style={s.hint}>
                  searching this Wi-Fi… {Math.round(progress * 100)}%
                </Text>
              </View>
            ) : (
              <View style={{ marginTop: 8 }}>
                <Button title="FIND MY LAPTOP ON THIS WI-FI" tone={C.dim}
                        sub="only works on the same network" onPress={findServer} />
              </View>
            )}
          </View>

          {mode === 'register' && (
            <View>
              <Label>Your name</Label>
              <TextInput
                style={s.input} value={name} onChangeText={setName}
                placeholder="Ali" placeholderTextColor={C.faint}
              />
            </View>
          )}

          <View>
            <Label>Username</Label>
            <TextInput
              style={s.input} value={username} onChangeText={setUsername}
              placeholder="ali" placeholderTextColor={C.faint}
              autoCapitalize="none" autoCorrect={false}
            />
          </View>

          <View>
            <Label>Password</Label>
            <TextInput
              style={s.input} value={password} onChangeText={setPassword}
              placeholder="••••" placeholderTextColor={C.faint} secureTextEntry
            />
          </View>

          {err ? <Text style={s.err}>{err}</Text> : null}

          {busy ? (
            <ActivityIndicator color={C.green} style={{ paddingVertical: 14 }} />
          ) : (
            <Button
              title={mode === 'login' ? 'SIGN IN' : 'CREATE ACCOUNT'}
              filled onPress={submit}
            />
          )}

          <Button
            title={mode === 'login' ? 'New here? Create an account' : 'I already have an account'}
            tone={C.dim}
            onPress={() => { setMode(mode === 'login' ? 'register' : 'login'); setErr(null); }}
          />
        </Card>

        <Text style={s.footer}>
          Your account, your family list and every alert live on the server you
          point this at. During testing that is a laptop, reachable through a
          tunnel; nothing is stored anywhere else.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1, backgroundColor: C.bg },
  wrap: { padding: 22, paddingTop: 72, paddingBottom: 48, gap: 26 },
  brand: { alignItems: 'center', gap: 6 },
  mark: { color: C.green, fontSize: 34, marginBottom: 2 },
  title: { fontFamily: mono, color: C.text, fontSize: 24, letterSpacing: 7 },
  sub: { fontFamily: mono, color: C.faint, fontSize: 11, letterSpacing: 0.6 },
  input: {
    backgroundColor: C.bg, borderWidth: 1, borderColor: C.line, borderRadius: 4,
    color: C.text, fontFamily: mono, fontSize: 15, paddingHorizontal: 12,
    paddingVertical: 11,
  },
  hint: { fontFamily: mono, color: C.faint, fontSize: 10, marginTop: 5 },
  hintOk: { fontFamily: mono, color: C.green, fontSize: 10, marginTop: 5 },
  scanRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  err: {
    fontFamily: mono, color: C.alarm, fontSize: 12, backgroundColor: C.alarmBg,
    borderRadius: 4, padding: 10, lineHeight: 17,
  },
  footer: {
    fontFamily: mono, color: C.faint, fontSize: 10, lineHeight: 16,
    textAlign: 'center', paddingHorizontal: 8,
  },
});
