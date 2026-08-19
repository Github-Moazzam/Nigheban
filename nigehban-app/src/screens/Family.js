import * as Clipboard from 'expo-clipboard';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, Platform, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { call } from '../api';
import { C, MONO } from '../theme';
import { Button, Card, Label, Pill } from '../ui';

const mono = Platform.select(MONO);

export default function Family({ session, refreshKey }) {
  const [members, setMembers] = useState([]);
  const [code, setCode] = useState('');
  const [relation, setRelation] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);

  const load = useCallback(async () => {
    try {
      setMembers(await call(session, '/family'));
      setErr(null);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const add = async () => {
    if (!code.trim()) return;
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await call(session, '/family',
        { method: 'POST', body: { code: code.trim(), relation: relation.trim() } });
      setNote(`${r.member.name} is now in your family. You will each see the other's alerts.`);
      setCode(''); setRelation('');
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = (m) => {
    Alert.alert('Remove ' + m.name + '?',
      'You will stop seeing each other\'s alerts.',
      [{ text: 'Cancel', style: 'cancel' },
       { text: 'Remove', style: 'destructive', onPress: async () => {
           try { await call(session, `/family/${m.id}`, { method: 'DELETE' }); await load(); }
           catch (e) { setErr(e.message); }
         } }]);
  };

  const checkin = async (m) => {
    try {
      const r = await call(session, `/checkin/${m.id}`, { method: 'POST' });
      Alert.alert('Check-in sent',
        r.online ? `${m.name}'s phone has it now.`
                 : `${m.name} is offline — they'll see it when the app reconnects.`);
    } catch (e) {
      Alert.alert('Could not send', e.message);
    }
  };

  return (
    <FlatList
      contentContainerStyle={s.wrap}
      data={members}
      keyExtractor={(m) => m.id}
      ListHeaderComponent={
        <View style={{ gap: 14 }}>
          <Card tone={C.green}>
            <Label>Your code — share this</Label>
            <Text style={s.code}>{session.user_id}</Text>
            <Text style={s.meta}>
              Anyone who enters this code becomes family: they see your alerts and
              you see theirs.
            </Text>
            <Button
              title="COPY CODE" tone={C.green}
              onPress={async () => {
                try {
                  await Clipboard.setStringAsync(session.user_id);
                  setNote('Code copied.');
                } catch { setNote(session.user_id); }
              }}
            />
          </Card>

          <Card>
            <Label>Add a family member</Label>
            <TextInput
              style={s.input} value={code} onChangeText={setCode}
              placeholder="NGB-4F2A" placeholderTextColor={C.faint}
              autoCapitalize="characters" autoCorrect={false}
            />
            <TextInput
              style={s.input} value={relation} onChangeText={setRelation}
              placeholder="mother, brother, friend… (optional)" placeholderTextColor={C.faint}
            />
            {busy ? <ActivityIndicator color={C.green} />
                  : <Button title="ADD" filled onPress={add} />}
            {note ? <Text style={s.ok}>{note}</Text> : null}
            {err ? <Text style={s.err}>{err}</Text> : null}
          </Card>

          <Label>{members.length ? `Family · ${members.length}` : 'Family'}</Label>
        </View>
      }
      ListEmptyComponent={
        loading ? <ActivityIndicator color={C.green} style={{ marginTop: 20 }} />
        : <Text style={s.empty}>
            Nobody yet. Give your code to a parent or a friend, or type theirs above.
          </Text>
      }
      renderItem={({ item }) => (
        <Card style={{ marginTop: 10 }}>
          <View style={s.row}>
            <View style={{ flex: 1 }}>
              <Text style={s.name}>{item.name}</Text>
              <Text style={s.meta}>
                {item.id}{item.relation ? ` · ${item.relation}` : ''}
              </Text>
            </View>
            <Pill text={item.online ? 'online' : 'offline'}
                  tone={item.online ? C.green : C.faint}
                  bg={item.online ? C.greenBg : 'transparent'} />
          </View>
          <View style={s.btnRow}>
            <View style={{ flex: 1 }}>
              <Button title="ASK FOR A CHECK-IN" tone={C.green} onPress={() => checkin(item)} />
            </View>
            <View style={{ flex: 0 }}>
              <Button title="REMOVE" tone={C.faint} onPress={() => remove(item)} />
            </View>
          </View>
        </Card>
      )}
    />
  );
}

const s = StyleSheet.create({
  wrap: { padding: 16, paddingBottom: 40 },
  code: {
    fontFamily: mono, color: C.green, fontSize: 32, letterSpacing: 4, fontWeight: '700',
  },
  meta: { fontFamily: mono, color: C.faint, fontSize: 11, lineHeight: 17 },
  name: { fontFamily: mono, color: C.text, fontSize: 16 },
  input: {
    backgroundColor: C.bg, borderWidth: 1, borderColor: C.line, borderRadius: 4,
    color: C.text, fontFamily: mono, fontSize: 15, paddingHorizontal: 12, paddingVertical: 11,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  btnRow: { flexDirection: 'row', gap: 8 },
  ok: { fontFamily: mono, color: C.green, fontSize: 11, lineHeight: 17 },
  err: {
    fontFamily: mono, color: C.alarm, fontSize: 11, backgroundColor: C.alarmBg,
    padding: 9, borderRadius: 4, lineHeight: 16,
  },
  empty: {
    fontFamily: mono, color: C.faint, fontSize: 12, lineHeight: 19,
    textAlign: 'center', marginTop: 22, paddingHorizontal: 20,
  },
});
