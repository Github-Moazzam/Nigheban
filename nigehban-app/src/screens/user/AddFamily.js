import * as Clipboard from 'expo-clipboard';
import React, { useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { call } from '../../api';
import { useEdgeInsets } from '../../safeArea';
import { F, S, T } from '../../theme';
import { Icon, Txt } from '../../ui';
import Dialog from './Dialog';
import { RU, U } from './kit';

/**
 * Adding family, and answering the people who ask you.
 *
 * Both halves live in one sheet because they are one idea: a link needs two
 * people to agree. Asking is a request, never an add -- the other phone has
 * to accept before anything at all is shared, in either direction.
 *
 * The admin console leads with a ten-minute pairing code. This does not: the
 * end user already has her permanent code on the board behind this sheet, and
 * a second kind of code to explain is exactly the thing this shell is meant
 * not to have.
 *
 * `focus` is which door was used -- the ADD button, or the bell that carries
 * the dot when somebody is waiting. It changes the heading and what an empty
 * list says, and nothing else: opening this from a request and finding no way
 * to answer it, or from the bell and finding a form instead of the question,
 * are the same failure. Requests sit at the top either way, because somebody
 * else is waiting on those and on nothing else here.
 */
export default function AddFamily({
  visible, session, invites, focus = 'add', onClose, onChanged,
}) {
  const [code, setCode] = useState('');
  const [relation, setRelation] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);
  const [copied, setCopied] = useState(false);
  // Which invitation is being answered. Accepting is a round trip plus a
  // reload of the board behind this sheet, and until now both buttons sat
  // there looking untouched for the whole of it.
  const [answering, setAnswering] = useState(null);   // `${inv.id}:accept|decline`
  // A link being made is the one moment in this app that is good news, and it
  // used to be a line of grey text under a form. It gets the screen now: what
  // just happened, what it means from here, and one way out. `asked` is the
  // other half -- a request that has gone nowhere yet must not be dressed up
  // to look like the same thing.
  const [linked, setLinked] = useState(null);         // { name, how: 'code'|'accepted' }
  const [asked, setAsked] = useState(false);
  const [declining, setDeclining] = useState(null);   // the invite being refused
  const insets = useEdgeInsets();

  const incoming = invites?.incoming || [];

  const reset = () => { setCode(''); setRelation(''); setErr(null); setNote(null); };

  const send = async () => {
    if (!code.trim()) return;
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await call(session, '/invite', {
        method: 'POST',
        body: { code: code.trim(), relation: relation.trim() },
      });
      setCode(''); setRelation('');
      // The server answers the same way whether or not that code belongs to
      // anybody, so that guessing codes cannot be used to find out who exists.
      // Saying "sent" would be a lie half the time -- which is why the second
      // popup is worded as a condition and not as a receipt.
      if (r.linked) setLinked({ name: r.member.name, how: 'code' });
      else setAsked(true);
      onChanged?.();
    } catch (e) {
      setErr(e.message);
    }
    setBusy(false);
  };

  const answer = async (inv, accept) => {
    if (answering) return;
    setAnswering(`${inv.id}:${accept ? 'accept' : 'decline'}`);
    try {
      await call(session, `/invite/${inv.id}/${accept ? 'accept' : 'decline'}`,
        { method: 'POST' });
      await onChanged?.();
      if (accept) setLinked({ name: inv.from.name, how: 'accepted' });
      else setNote('Declined. They are not told, and they cannot ask again.');
    } catch (e) {
      setErr(e.message);
    } finally {
      setAnswering(null);
    }
  };

  const copyMine = async () => {
    await Clipboard.setStringAsync(session.user_id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const close = () => { reset(); onClose?.(); };

  // The end of a successful add: the popup goes, and so does this sheet. What
  // is behind it is the board with the new person on it, which is the only
  // thing anybody wants to look at next.
  const finish = () => { setLinked(null); close(); };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={close}>
      <View style={s.wrap}>
        <Pressable style={s.backdrop} onPress={close} accessibilityLabel="Close" />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={s.sheetWrap}
        >
          <View style={[s.sheet, { paddingBottom: S.xl + insets.bottom }]}>
            <View style={s.grab} />

            <View style={s.head}>
              <Txt variant="h1" color={U.text} style={{ flex: 1 }}>
                {focus === 'requests' ? 'Requests' : 'Family'}
              </Txt>
              <Pressable onPress={close} accessibilityRole="button" accessibilityLabel="Close"
                         style={({ pressed }) => [s.close, pressed && { opacity: 0.6 }]}>
                <Icon name="x" size={18} color={U.dim} />
              </Pressable>
            </View>

            <ScrollView keyboardShouldPersistTaps="handled"
                        contentContainerStyle={{ gap: S.md }}>

              {/* ---- people asking to be your family ---- */}
              {incoming.length ? (
                <>
                  <Text style={[T.label, { color: U.faint }]}>ASKING TO BE FAMILY</Text>
                  {incoming.map((inv) => (
                    <View key={inv.id} style={s.invite}>
                      <View style={{ gap: 2 }}>
                        <Txt variant="h2" color={U.text}>{inv.from.name}</Txt>
                        <Text style={[T.meta, { color: U.faint }]}>
                          {inv.from.id}
                          {inv.relation ? ` · says they are your ${inv.relation}` : ''}
                        </Text>
                      </View>
                      <Text style={[T.meta, { color: U.dim }]}>
                        Accept only if you know them. You will each see the other's alerts.
                      </Text>
                      <View style={s.inviteBtns}>
                        <Pressable
                          onPress={() => answer(inv, true)}
                          disabled={!!answering}
                          accessibilityRole="button"
                          accessibilityState={{
                            busy: answering === `${inv.id}:accept`, disabled: !!answering,
                          }}
                          accessibilityLabel={`Accept ${inv.from.name}`}
                          style={({ pressed }) => [
                            s.btn, { backgroundColor: U.mint, flex: 1 },
                            !!answering && { opacity: 0.6 },
                            pressed && { opacity: 0.75 },
                          ]}
                        >
                          {answering === `${inv.id}:accept` ? (
                            <ActivityIndicator size="small" color={U.bg} />
                          ) : null}
                          <Text style={[T.button, { color: U.bg }]}>
                            {answering === `${inv.id}:accept` ? 'Accepting…' : 'Accept'}
                          </Text>
                        </Pressable>
                        <Pressable
                          onPress={() => setDeclining(inv)}
                          disabled={!!answering}
                          accessibilityRole="button"
                          accessibilityState={{
                            busy: answering === `${inv.id}:decline`, disabled: !!answering,
                          }}
                          accessibilityLabel={`Decline ${inv.from.name}`}
                          style={({ pressed }) => [
                            s.btn, { backgroundColor: U.raised, flex: 1 },
                            !!answering && { opacity: 0.6 },
                            pressed && { opacity: 0.75 },
                          ]}
                        >
                          {answering === `${inv.id}:decline` ? (
                            <ActivityIndicator size="small" color={U.dim} />
                          ) : null}
                          <Text style={[T.button, { color: U.dim }]}>
                            {answering === `${inv.id}:decline` ? 'Declining…' : 'Not now'}
                          </Text>
                        </Pressable>
                      </View>
                    </View>
                  ))}
                </>
              ) : null}

              {/* Opened from the bell with nothing waiting. Said plainly and
                  then got out of the way: the form below is what somebody who
                  came looking for a request they have already answered is
                  most likely to want next. */}
              {focus === 'requests' && !incoming.length ? (
                <View style={s.none}>
                  <Icon name="check-circle" size={16} color={U.faint} />
                  <Text style={[T.meta, { color: U.dim, flex: 1 }]}>
                    Nobody is waiting for an answer.
                  </Text>
                </View>
              ) : null}

              {/* ---- asking somebody yourself ---- */}
              <Text style={[T.label, { color: U.faint, marginTop: incoming.length ? S.md : 0 }]}>
                ADD SOMEONE
              </Text>

              <View style={s.form}>
                <TextInput
                  value={code}
                  onChangeText={(t) => { setCode(t); setErr(null); }}
                  placeholder="Their code, e.g. NGB-B5WP"
                  placeholderTextColor={U.faint}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  accessibilityLabel="Their code"
                  style={s.input}
                />
                <TextInput
                  value={relation}
                  onChangeText={setRelation}
                  placeholder="Who are they to you? (optional)"
                  placeholderTextColor={U.faint}
                  accessibilityLabel="Relation"
                  style={s.input}
                />
                <Pressable
                  onPress={send}
                  disabled={busy || !code.trim()}
                  accessibilityRole="button"
                  accessibilityState={{ busy, disabled: busy || !code.trim() }}
                  style={({ pressed }) => [
                    s.btn,
                    { backgroundColor: U.mint },
                    (busy || !code.trim()) && { opacity: 0.45 },
                    pressed && { opacity: 0.75 },
                  ]}
                >
                  {busy ? (
                    <ActivityIndicator size="small" color={U.bg} />
                  ) : (
                    <Icon name="user-plus" size={16} color={U.bg} />
                  )}
                  <Text style={[T.button, { color: U.bg }]}>
                    {busy ? 'Sending…' : 'Send request'}
                  </Text>
                </Pressable>
                <Text style={[T.meta, { color: U.faint }]}>
                  Nothing is shared until they accept.
                </Text>
              </View>

              {err ? (
                <View style={[s.msg, { backgroundColor: U.redSoft }]}>
                  <Icon name="alert-circle" size={14} color={U.red} />
                  <Text style={[T.meta, { color: U.red, flex: 1 }]}>{err}</Text>
                </View>
              ) : null}
              {note ? (
                <View style={[s.msg, { backgroundColor: U.mintSoft }]}>
                  <Icon name="check" size={14} color={U.mint} />
                  <Text style={[T.meta, { color: U.dim, flex: 1 }]}>{note}</Text>
                </View>
              ) : null}

              {/* ---- the other direction: let them add you ---- */}
              <Pressable
                onPress={copyMine}
                accessibilityRole="button"
                accessibilityLabel="Copy your own code"
                style={({ pressed }) => [s.mine, pressed && { opacity: 0.75 }]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[T.meta, { color: U.faint }]}>Or give them your code</Text>
                  <Text style={[T.number, { color: U.text }]}>{session.user_id}</Text>
                </View>
                <Icon name={copied ? 'check' : 'copy'} size={16}
                      color={copied ? U.mint : U.faint} />
              </Pressable>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>

        {/* ---- it worked ----
            Nested inside this sheet rather than beside it: two modals that are
            siblings are two presentations racing each other, and the one that
            loses simply never appears. */}
        <Dialog
          visible={!!linked}
          tone={U.mint}
          icon="user-check"
          title={`${linked?.name || 'They'} is now in your family`}
          body="The link is live in both directions."
          points={[
            `An SOS from ${linked?.name || 'them'} reaches this phone, even closed.`,
            'Yours reaches them the same way.',
            'Either of you can ask for a check-in.',
          ]}
          note="Either of you can undo this later."
          onClose={finish}
          actions={[{ label: 'Done', icon: 'check', filled: true, onPress: finish }]}
        />

        {/* ---- it has been asked, which is not the same thing ---- */}
        <Dialog
          visible={asked}
          tone={U.amber}
          icon="send"
          title="Request sent"
          body="If that code belongs to somebody, they have been asked."
          note="Nothing is shared until they accept, and we cannot confirm whether the code exists."
          onClose={() => setAsked(false)}
          actions={[
            { label: 'Done', icon: 'check', filled: true,
              onPress: () => { setAsked(false); close(); } },
            { label: 'Add someone else', tone: U.dim, onPress: () => setAsked(false) },
          ]}
        />

        {/* ---- saying no, which cannot be taken back ---- */}
        <Dialog
          visible={!!declining}
          tone={U.red}
          icon="user-x"
          title={`Say no to ${declining?.from?.name || 'them'}?`}
          body="They are not told, and cannot ask again from this code."
          onClose={() => setDeclining(null)}
          actions={[
            { label: 'Say no', icon: 'user-x', filled: true, tone: U.red,
              busyLabel: 'Declining…',
              onPress: async () => {
                const inv = declining;
                await answer(inv, false);
                setDeclining(null);
              } },
            { label: 'Cancel', tone: U.dim, onPress: () => setDeclining(null) },
          ]}
        />
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: U.scrim },
  sheetWrap: { maxHeight: '90%' },
  sheet: {
    backgroundColor: U.bg,
    borderTopLeftRadius: RU.card, borderTopRightRadius: RU.card,
    paddingHorizontal: S.lg, paddingTop: S.md, gap: S.md,
  },
  grab: {
    width: 36, height: 4, borderRadius: 2,
    backgroundColor: U.line, alignSelf: 'center',
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: S.sm },
  close: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: U.card,
    alignItems: 'center', justifyContent: 'center',
  },

  invite: {
    gap: S.md, padding: S.lg,
    borderRadius: RU.card, backgroundColor: U.amberSoft,
  },
  inviteBtns: { flexDirection: 'row', gap: S.sm },

  form: {
    gap: S.sm, padding: S.lg,
    borderRadius: RU.card, backgroundColor: U.card,
  },
  input: {
    backgroundColor: U.raised, borderRadius: RU.inner,
    color: U.text, fontFamily: F.body, fontSize: 16,
    paddingHorizontal: S.md, minHeight: 48, paddingVertical: 12,
  },

  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: S.sm,
    minHeight: 48, borderRadius: RU.inner,
  },

  msg: {
    flexDirection: 'row', alignItems: 'flex-start', gap: S.sm,
    padding: S.md, borderRadius: RU.inner,
  },

  none: {
    flexDirection: 'row', alignItems: 'center', gap: S.sm,
    padding: S.lg, borderRadius: RU.card, backgroundColor: U.card,
  },

  mine: {
    flexDirection: 'row', alignItems: 'center', gap: S.md,
    padding: S.lg, borderRadius: RU.card, backgroundColor: U.card,
  },
});
