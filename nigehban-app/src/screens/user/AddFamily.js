import * as Clipboard from 'expo-clipboard';
import React, { useState } from 'react';
import {
  Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import { call } from '../../api';
import { useEdgeInsets } from '../../safeArea';
import { F, S, T } from '../../theme';
import { Icon, Txt } from '../../ui';
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
 */
export default function AddFamily({ visible, session, invites, onClose, onChanged }) {
  const [code, setCode] = useState('');
  const [relation, setRelation] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);
  const [copied, setCopied] = useState(false);
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
      // Saying "sent" would be a lie half the time.
      setNote(r.linked
        ? `${r.member.name} is now in your family.`
        : 'If that code belongs to someone, they have been asked.');
      onChanged?.();
    } catch (e) {
      setErr(e.message);
    }
    setBusy(false);
  };

  const answer = async (inv, accept) => {
    try {
      await call(session, `/invite/${inv.id}/${accept ? 'accept' : 'decline'}`,
        { method: 'POST' });
      setNote(accept ? `${inv.from.name} is now in your family.` : 'Declined.');
      onChanged?.();
    } catch (e) {
      setErr(e.message);
    }
  };

  const confirmDecline = (inv) => {
    Alert.alert(
      `Say no to ${inv.from.name}?`,
      'They will not be told, and they will not be able to ask you again.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Say no', style: 'destructive', onPress: () => answer(inv, false) },
      ],
    );
  };

  const copyMine = async () => {
    await Clipboard.setStringAsync(session.user_id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const close = () => { reset(); onClose?.(); };

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
              <Txt variant="h1" color={U.text} style={{ flex: 1 }}>Family</Txt>
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
                        Accept only if you know who this is. You will each see the
                        other's alerts.
                      </Text>
                      <View style={s.inviteBtns}>
                        <Pressable
                          onPress={() => answer(inv, true)}
                          accessibilityRole="button"
                          accessibilityLabel={`Accept ${inv.from.name}`}
                          style={({ pressed }) => [
                            s.btn, { backgroundColor: U.mint, flex: 1 },
                            pressed && { opacity: 0.75 },
                          ]}
                        >
                          <Text style={[T.button, { color: U.bg }]}>Accept</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => confirmDecline(inv)}
                          accessibilityRole="button"
                          accessibilityLabel={`Decline ${inv.from.name}`}
                          style={({ pressed }) => [
                            s.btn, { backgroundColor: U.raised, flex: 1 },
                            pressed && { opacity: 0.75 },
                          ]}
                        >
                          <Text style={[T.button, { color: U.dim }]}>Not now</Text>
                        </Pressable>
                      </View>
                    </View>
                  ))}
                </>
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
                  style={({ pressed }) => [
                    s.btn,
                    { backgroundColor: U.mint },
                    (busy || !code.trim()) && { opacity: 0.45 },
                    pressed && { opacity: 0.75 },
                  ]}
                >
                  <Icon name="user-plus" size={16} color={U.bg} />
                  <Text style={[T.button, { color: U.bg }]}>Send request</Text>
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

  mine: {
    flexDirection: 'row', alignItems: 'center', gap: S.md,
    padding: S.lg, borderRadius: RU.card, backgroundColor: U.card,
  },
});
