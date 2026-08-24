import * as Clipboard from 'expo-clipboard';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, StyleSheet, Text, View,
} from 'react-native';
import WatchStatusTile from '../components/WatchStatusTile';
import { call } from '../api';
import { C, S, T } from '../theme';
import { Banner, Button, Card, Chip, Divider, EmptyState, Field, Icon, Label, Txt } from '../ui';

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
      const withWatch = await Promise.all(m.map(async (member) => {
        try {
          return { ...member, watchState: await call(session, `/watch/${member.id}`) };
        } catch {
          return { ...member, watchState: null };
        }
      }));
      setMembers(withWatch);
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

  const copy = async (value, said) => {
    try { await Clipboard.setStringAsync(value); setNote(said); }
    catch { setNote(value); }
  };

  const makePair = async () => {
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await call(session, '/pair',
        { method: 'POST', body: { relation: relation.trim() } });
      setPair({ code: r.code, until: Date.now() + r.ttl_s * 1000 });
      copy(r.code, 'Copied. Read it out or paste it to them.');
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
    Alert.alert(`Remove ${m.name}?`,
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
      ItemSeparatorComponent={() => <View style={{ height: S.md }} />}
      ListHeaderComponent={
        <View style={{ gap: S.md, marginBottom: S.md }}>
          {/* ---- somebody is asking to be family ---- */}
          {invites.incoming.map((inv) => (
            <Card key={inv.id} tone={C.amber} accent={C.amber}>
              <Label color={C.amber}>Asking to be family</Label>
              <View style={{ gap: 2 }}>
                <Txt variant="h1">{inv.from.name}</Txt>
                <Text style={[T.meta, { color: C.faint }]}>
                  {inv.from.id}{inv.relation ? ` · says they are your ${inv.relation}` : ''}
                </Text>
              </View>
              <Text style={[T.meta, { color: C.dim }]}>
                If you accept, you will each see the other's alerts and be able to ask
                each other for a check-in. Only accept if you know who this is.
              </Text>
              <View style={s.btnRow}>
                <View style={{ flex: 1 }}>
                  <Button title="ACCEPT" tone={C.green} filled icon="check"
                          onPress={() => answer(inv, true)} />
                </View>
                <View style={{ flex: 1 }}>
                  <Button title="SAY NO" tone={C.red} icon="x"
                          onPress={() => confirmDecline(inv)} />
                </View>
              </View>
            </Card>
          ))}

          {/* ---- the good way to add someone ---- */}
          <Card tone={pair ? C.green : undefined}>
            <View style={s.row}>
              <Txt variant="h2">Add someone who is with you</Txt>
              {pair ? <Chip text={`expires in ${fmtClock(left)}`}
                            tone={left <= 60 ? C.amber : C.green} icon="clock" /> : null}
            </View>

            {pair ? (
              <>
                <Text style={s.code}>{pair.code}</Text>
                <Text style={[T.meta, { color: C.dim }]}>
                  Works once, for one person, and then never again.
                </Text>
                <Button title="COPY AGAIN" icon="copy"
                        onPress={() => copy(pair.code, 'Copied.')} />
              </>
            ) : (
              <>
                <Text style={[T.meta, { color: C.dim }]}>
                  Make a code, read it out to them, and it stops working ten minutes
                  later — or the moment they use it. Unlike your own code below, a
                  screenshot of it is worthless tomorrow.
                </Text>
                <Button title="MAKE A PAIRING CODE" filled icon="user-plus"
                        loading={busy} onPress={makePair} />
              </>
            )}
          </Card>

          {/* ---- entering one ---- */}
          <Card>
            <Txt variant="h2">Got a code?</Txt>
            <Field label="Their code" value={code} onChangeText={setCode}
                   placeholder="PAIR-7K2M-QX9F or NGB-4F2A"
                   autoCapitalize="characters" autoCorrect={false} />
            <Field label="What they are to you" value={relation} onChangeText={setRelation}
                   placeholder="mother, brother, friend…"
                   hint="Optional. Only the two of you ever see it." />
            <Button title="CONTINUE" filled icon="arrow-right"
                    loading={busy} onPress={submit} />
            <Text style={[T.meta, { color: C.faint }]}>
              A PAIR code links you straight away. A person's own NGB code sends them
              a request — nothing is shared until they accept it.
            </Text>
            {note ? <Banner tone={C.green} icon="check-circle">{note}</Banner> : null}
            {err ? <Banner tone={C.red} icon="alert-circle">{err}</Banner> : null}
          </Card>

          {/* ---- waiting on them ---- */}
          {invites.outgoing.length ? (
            <Card>
              <Txt variant="h2">Waiting for an answer</Txt>
              {invites.outgoing.map((o) => (
                <View key={o.id} style={s.pending}>
                  <Icon name="clock" size={14} color={C.faint} />
                  <Text style={[T.meta, { color: C.dim, flex: 1 }]}>{o.to}</Text>
                  <Chip text="asked" tone={C.faint} />
                </View>
              ))}
              <Text style={[T.meta, { color: C.faint }]}>
                People are never told who asked to be their family until they choose
                to accept, so there is nothing more to see here.
              </Text>
            </Card>
          ) : null}

          {/* ---- your own permanent code ---- */}
          <Card>
            <Txt variant="h2">Your own code</Txt>
            <Text style={s.codeDim}>{session.user_id}</Text>
            <Text style={[T.meta, { color: C.dim }]}>
              This one never changes. Anyone who has it can ask to be your family —
              you still have to say yes, and saying no is permanent. Prefer the
              pairing code above when you can.
            </Text>
            <Button title="COPY CODE" tone={C.dim} icon="copy"
                    onPress={() => copy(session.user_id, 'Code copied.')} />
          </Card>

          <Label>{members.length ? `Family · ${members.length}` : 'Family'}</Label>
        </View>
      }
      ListEmptyComponent={
        loading
          ? <ActivityIndicator color={C.green} style={{ marginTop: S.xl }} />
          : <EmptyState icon="users" title="Nobody yet"
                        body="Make a pairing code and read it out to whoever is with you. Until then, an alert has nowhere to go." />
      }
      renderItem={({ item }) => (
        <Card>
          <View style={s.row}>
            <View style={{ flex: 1, gap: 2 }}>
              <Txt variant="h2">{item.name}</Txt>
              <Text style={[T.meta, { color: C.faint }]}>
                {item.id}{item.relation ? ` · ${item.relation}` : ''}
              </Text>
            </View>
            <Chip text={item.online ? 'online' : 'offline'}
                  tone={item.online ? C.green : C.faint} />
          </View>

          {item.watchState ? (
            <WatchStatusTile watchState={item.watchState}
                             isVirtual={!item.watchState.band_link} />
          ) : (
            <Text style={[T.meta, { color: C.faint }]}>
              Their watch has not reported yet.
            </Text>
          )}

          <Divider />
          <Button title="ASK FOR A CHECK-IN" filled icon="help-circle"
                  onPress={() => checkin(item)} />
          <Button title="REMOVE FROM FAMILY" tone={C.dim} icon="user-minus"
                  onPress={() => remove(item)} />
        </Card>
      )}
    />
  );
}

function fmtClock(s) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const s = StyleSheet.create({
  wrap: { padding: S.lg, paddingBottom: 40 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: S.sm },
  btnRow: { flexDirection: 'row', gap: S.md },
  pending: { flexDirection: 'row', alignItems: 'center', gap: S.sm },
  code: {
    fontFamily: T.display.fontFamily, fontSize: 28, color: C.green,
    letterSpacing: 1.5, fontVariant: ['tabular-nums'],
  },
  codeDim: {
    fontFamily: T.display.fontFamily, fontSize: 24, color: C.dim,
    letterSpacing: 2, fontVariant: ['tabular-nums'],
  },
});
