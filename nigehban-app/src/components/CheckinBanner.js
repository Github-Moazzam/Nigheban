import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { C, S, T, fmtCount } from '../theme';
import { Button, Card, Chip, Label, ProgressBar } from '../ui';

/**
 * U3.1 — the open question, and how long is left to answer it.
 *
 * The countdown runs to `due_at`, which is the server's deadline in the
 * server's clock, sent with the request. It is not a local ninety-second timer
 * that happens to agree: the sweeper escalates on its own row in the database,
 * so a phone that woke up late has to show what is actually left, not what
 * would be left if the message had arrived on time.
 *
 * Shown after the ask-sheet is dismissed, so "later" never means "forgotten".
 *
 * THREE QUESTIONS, NOT ONE. A person asking is one thing; High Alert's standing
 * five-minute question is another; and the question an SOS asks is a third, and
 * it is the opposite of the other two. Those two are answered to STAY clear.
 * The SOS one is answered to GET clear -- two in a row and the alert stands
 * itself down -- and a wearer under pressure should not have to work that out,
 * or keep count. `streak` is the server's count and it is put on the screen.
 */
export default function CheckinBanner({ checkin, onAck, style }) {
  const window = checkin?.window || 90;
  const dueAt = checkin?.due_at
    || (checkin?._startAt ? checkin._startAt + window : null);

  const [left, setLeft] = useState(() => remaining(dueAt, window));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!checkin) return undefined;
    const tick = () => setLeft(remaining(dueAt, window));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [checkin, dueAt, window]);

  if (!checkin) return null;

  const urgent = left <= 30;
  const tone = left === 0 ? C.red : urgent ? C.amber : C.green;
  const isSos = checkin.reason === 'sos';
  // How many more are needed. `streak` is what the wearer had answered BEFORE
  // this question, so answering this one is `streak + 1`. Null when the server
  // did not send it -- an older build -- and the wording falls back to
  // something true but uncounted rather than to a wrong number.
  const need = checkin.streakNeeded ?? null;
  const done = checkin.streak ?? null;
  const closes = need != null && done != null && done + 1 >= need;

  const ack = async () => {
    if (busy) return;
    setBusy(true);
    try { await onAck?.(checkin); } finally { setBusy(false); }
  };

  return (
    <Card tone={tone} style={[{ gap: S.md }, style]}>
      <View style={s.head}>
        <View style={{ flex: 1, gap: 4 }}>
          <Label color={tone}>
            {isSos ? 'Your SOS is live'
              : checkin.system ? 'Nigehban is checking on you' : 'Check-in requested'}
          </Label>
          <Text style={[T.h2, { color: C.text }]}>
            {isSos
              ? (closes ? 'Answer this and your SOS stands down' : 'Are you safe now?')
              : checkin.system
                ? 'High Alert — answer to stay clear'
                : `${checkin.name || 'Someone'} is asking if you are okay`}
          </Text>
        </View>
        <Chip text={left === 0 ? 'overdue' : fmtCount(left)} tone={tone} icon="clock" />
      </View>

      <ProgressBar value={window ? left / window : 0} tone={tone} />

      <Text style={[T.meta, { color: C.dim }]}>
        {isSos
          ? (left === 0
            // Not "your family is being told" -- they were told when the SOS
            // went out, and telling somebody in the middle of an emergency that
            // missing a question has just made it worse is both untrue and the
            // last thing they need. What it actually costs is the way out.
            ? 'Missed — the count starts again at the next check-in.'
            : need != null && done != null
              ? `Answered ${done} of ${need} in a row. ${closes
                ? 'This one ends it.'
                : 'One more after this and your family is told you are safe.'}`
              : 'Answer this and the next one, and your SOS stands down.')
          : left === 0
            ? 'Time is up — your family is being told.'
            : 'Answer here and it closes, even if you shut the app.'}
      </Text>

      <Button title={isSos ? 'I AM SAFE' : 'I AM FINE'} filled tone={C.green} icon="check"
              loading={busy} onPress={ack} />
    </Card>
  );
}

function remaining(dueAt, window) {
  if (!dueAt) return window;
  return Math.max(0, Math.ceil(dueAt - Date.now() / 1000));
}

const s = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
