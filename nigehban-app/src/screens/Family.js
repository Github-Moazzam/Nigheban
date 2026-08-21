import * as Clipboard from 'expo-clipboard';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, Platform, StyleSheet, Text, TextInput, View,
} from 'react-native';
import WatchStatusTile from '../components/WatchStatusTile';
import { call } from '../api';
import { C, MONO } from '../theme';
import { Button, Card, Label, Pill } from '../ui';

const mono = Platform.select(MONO);

/**
 * FAMILY — pairing, and the consent that has to come before it.
 *
 * The rule this screen exists to enforce: a link needs two people to act. You
 * hand someone a code that dies in ten minutes, or you ask and they accept.
 * Nothing is shared, in either direction, until that has happened.
 *
 * The permanent NGB code is still here because "add me when you get a chance"
 * is a real thing people need, but it is deliberately the second option: it is
 * a bearer secret that cannot be taken back, and one screenshot of it is
 * forever. The pairing code is the one the screen leads with.
 */
export default function Family({ session, refreshKey }) {
  const [members, setMembers] = useState([]);
  const [invites, setInvites] = useState({ incoming: [], outgoing: [] });
  const [pair, setPair] = useState(null);      // { code, until }
  const [left, setLeft] = useState(0);         // seconds on the clock
  const [code, setCode] = useState('');
  const [relation, setRelation] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);

  const load = useCallback(async () => {
    try {
      const [m, i] = await Promise.all([
        call(session, '/family'),
        call(session, '/invites'),
      ]);
      const membersWithWatch = await Promise.all(m.map(async (member) => {
        try {
          const w = await call(session, `/watch/${member.id}`);
          return { ...member, watchState: w };
        } catch {
          return { ...member, watchState: null };
        }
      }));
      setMembers(membersWithWatch);
      setInvites(i);
      setErr(null);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => { load(); }, [load, refreshKey]);

  // The countdown runs off the phone's own clock from the moment the code
  // arrived, not off the server's timestamp -- the two clocks disagree by
  // enough to show a code as expired while it still works, or worse.
  const tick = useRef(null);
  useEffect(() => {
    clearInterval(tick.current);
    if (!pair) { setLeft(0); return undefined; }
    const update = () => {
      const s = Math.max(0, Math.round((pair.until - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) setPair(null);
    };
    update();
    tick.current = setInterval(update, 1000);
    return () => clearInterval(tick.current);
  }, [pair]);

  const makePair = async () => {
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await call(session, '/pair',
        { method: 'POST', body: { relation: relation.trim() } });
      setPair({ code: r.code, until: Date.now() + r.ttl_s * 1000 });
      try { await Clipboard.setStringAsync(r.code); setNote('Copied. Read it out or paste it to them.'); }
      catch { /* clipboard is a convenience, not the feature */ }
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!code.trim()) return;
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await call(session, '/invite',
        { method: 'POST', body: { code: code.trim(), relation: relation.trim() } });
      setCode(''); setRelation('');
      setNote(r.linked
        ? `${r.member.name} is now in your family. You will each see the other's alerts.`
        // Carefully worded. The server answers the same way whether or not that
        // code belongs to anybody, so that guessing codes cannot be used to
        // find out who exists. Promising "sent" would be a lie half the time.
        : 'If that code belongs to someone, they have been asked. Nothing is '
          + 'shared until they say yes.');
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const answer = async (inv, accept) => {
    try {
      await call(session, `/invite/${inv.id}/${accept ? 'accept' : 'decline'}`,
        { method: 'POST' });
      setNote(accept
        ? `${inv.from.name} is now in your family.`
        : 'Declined. They are not told, and they cannot ask again.');
      await load();
    } catch (e) {
      setErr(e.message);
    }
  };

  const confirmDecline = (inv) => {
    Alert.alert(`Say no to ${inv.from.name}?`,
      'They will not be told, and they will not be able to ask you again.',
      [{ text: 'Cancel', style: 'cancel' },
       { text: 'Say no', style: 'destructive', onPress: () => answer(inv, false) }]);
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
        (r.online ? `${m.name}'s phone has it now.`
                  : `${m.name} is offline — they will see it when the app reconnects.`)
        + '\n\nThe deadline is on the server, so you will hear either way.');
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
          {/* ---- someone is asking to be family ---- */}
          {invites.incoming.map((inv) => (
            <Card key={inv.id} tone={C.amber} style={{ backgroundColor: C.raised }}>
              <Label color={C.amber}>Asking to be family</Label>
              <Text style={s.name}>{inv.from.name}</Text>
              <Text style={s.meta}>
                {inv.from.id}{inv.relation ? ` · says they are your ${inv.relation}` : ''}
              </Text>
              <Text style={s.warn}>
                If you accept, you will each see the other's alerts and be able to
                ask each other for a check-in. Only accept if you know who this is.
              </Text>
              <View style={s.btnRow}>
                <View style={{ flex: 1 }}>
                  <Button title="ACCEPT" tone={C.green} filled
                          onPress={() => answer(inv, true)} />
                </View>
                <View style={{ flex: 1 }}>
                  <Button title="SAY NO" tone={C.alarm}
                          onPress={() => confirmDecline(inv)} />
                </View>
              </View>
            </Card>
          ))}

          {/* ---- the good way to add someone ---- */}
          <Card tone={C.green}>
            <Label>Add someone who is with you</Label>
            {pair ? (
              <>
                <Text style={s.code}>{pair.code}</Text>
                <Text style={[s.meta, left <= 60 && { color: C.amber }]}>
                  works once · expires in {Math.floor(left / 60)}:
                  {String(left % 60).padStart(2, '0')}
                </Text>
                <Button title="COPY AGAIN" tone={C.green}
                        onPress={async () => {
                          try { await Clipboard.setStringAsync(pair.code); setNote('Copied.'); }
                          catch { setNote(pair.code); }
                        }} />
              </>
            ) : (
              <>
                <Text style={s.meta}>
                  Make a code, read it out to them, and it stops working ten
                  minutes later — or the moment they use it. Unlike your own
                  code below, a screenshot of it is worthless tomorrow.
                </Text>
                <Button title="MAKE A PAIRING CODE" filled tone={C.green}
                        disabled={busy} onPress={makePair} />
              </>
            )}
          </Card>

          {/* ---- entering one ---- */}
          <Card>
            <Label>Got a code?</Label>
            <TextInput
              style={s.input} value={code} onChangeText={setCode}
              placeholder="PAIR-7K2M-QX9F  or  NGB-4F2A" placeholderTextColor={C.faint}
              autoCapitalize="characters" autoCorrect={false}
            />
            <TextInput
              style={s.input} value={relation} onChangeText={setRelation}
              placeholder="mother, brother, friend… (optional)" placeholderTextColor={C.faint}
            />
            {busy ? <ActivityIndicator color={C.green} />
                  : <Button title="CONTINUE" filled onPress={submit} />}
            <Text style={s.meta}>
              A PAIR code links you straight away. A person's own NGB code sends
              them a request — nothing is shared until they accept it.
            </Text>
            {note ? <Text style={s.ok}>{note}</Text> : null}
            {err ? <Text style={s.err}>{err}</Text> : null}
          </Card>

          {/* ---- waiting on them ---- */}
          {invites.outgoing.length ? (
            <Card>
              <Label>Waiting for an answer</Label>
              {invites.outgoing.map((o) => (
                <Text key={o.id} style={s.meta}>
                  {o.to} — asked, not answered yet
                </Text>
              ))}
              <Text style={s.meta}>
                People are never told who asked to be their family until they
                choose to accept, so there is nothing more to see here.
              </Text>
            </Card>
          ) : null}

          {/* ---- your own permanent code ---- */}
          <Card>
            <Label>Your own code</Label>
            <Text style={s.codeDim}>{session.user_id}</Text>
            <Text style={s.meta}>
              This one never changes. Anyone who has it can ask to be your
              family — you still have to say yes, and saying no is permanent.
              Prefer the pairing code above when you can.
            </Text>
            <Button
              title="COPY CODE" tone={C.dim}
              onPress={async () => {
                try { await Clipboard.setStringAsync(session.user_id); setNote('Code copied.'); }
                catch { setNote(session.user_id); }
              }}
            />
          </Card>

          <Label>{members.length ? `Family · ${members.length}` : 'Family'}</Label>
        </View>
      }
      ListEmptyComponent={
        loading ? <ActivityIndicator color={C.green} style={{ marginTop: 20 }} />
        : <Text style={s.empty}>
            Nobody yet. Make a pairing code and read it out to whoever is with you.
          </Text>
      }
      renderItem={({ item }) => (
        <Card style={{ marginTop: 10, gap: 10 }}>
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
          {item.watchState ? (
            <WatchStatusTile watchState={item.watchState} isVirtual={!item.watchState.band_link} />
          ) : null}
          <View style={{ gap: 8, marginTop: 4 }}>
            <Button title="ASK FOR A CHECK-IN" tone={C.green} filled onPress={() => checkin(item)} />
            <Button title="REMOVE MEMBER" tone={C.dim} onPress={() => remove(item)} />
          </View>
        </Card>
      )}
    />
  );
}

const s = StyleSheet.create({
  wrap: { padding: 16, paddingBottom: 40 },
  code: {
    fontFamily: mono, color: C.green, fontSize: 26, letterSpacing: 2, fontWeight: '700',
  },
  codeDim: {
    fontFamily: mono, color: C.dim, fontSize: 24, letterSpacing: 3, fontWeight: '700',
  },
  meta: { fontFamily: mono, color: C.faint, fontSize: 11, lineHeight: 17 },
  warn: { fontFamily: mono, color: C.amber, fontSize: 11, lineHeight: 17 },
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
