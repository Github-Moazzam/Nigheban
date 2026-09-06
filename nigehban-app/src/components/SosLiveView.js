import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { C, S, T, fmtAgo, fmtCount } from '../theme';
import { Button, Card, Chip, Divider, Icon, Label, Txt } from '../ui';

const KIND = {
  sos:    { label: 'SOS is live',        lede: 'Your family has been alerted' },
  fall:   { label: 'Fall reported',      lede: 'Your family has been told you fell' },
  snatch: { label: 'Band torn off',      lede: 'Your family has been alerted' },
};

// When offline, the lede changes to reflect the honest state.
const KIND_QUEUED = {
  sos:    { label: 'SOS ACTIVATED',      lede: 'Waiting for connection' },
  fall:   { label: 'Fall reported',      lede: 'Waiting for connection' },
  snatch: { label: 'Band torn off',      lede: 'Waiting for connection' },
};

/**
 * U3.5 — what the wearer sees while her own SOS is live.
 *
 * The question this screen answers is the one she is actually asking, which is
 * not "is it sent" but "is anyone coming". So the first line is how long it
 * has been running, and the body is the names of the people who have pressed
 * "I'm on it" -- not a delivery receipt.
 *
 * Standing down is deliberately not the biggest thing here. It is a real
 * button, reachable in one tap, but the screen does not lead with it: the band
 * can also stand it down, and a person under pressure should not be able to
 * cancel her own alarm by fumbling the phone.
 *
 * OFFLINE QUEUE ADDITION: when deliveryStatus is 'queued', an amber banner
 * explains that the alert is saved locally and will be sent automatically
 * when signal returns. The user must never be told their family was alerted
 * when they have not been.
 */
export default function SosLiveView({
  alert, deliveredTo, deliveryStatus, responders = [], onStandDown, onOptinSamaritan, busy, fix,
}) {
  const isQueued = deliveryStatus === 'queued';
  // Standing down owns its own flag. `busy` is the caller's, and on Home that
  // is the flag for *raising* an alert -- which is never true while this card
  // is on screen, so the one button here spent the entire round trip looking
  // like nothing had happened. It is still honoured, so a press cannot land
  // while the screen above is mid-dispatch.
  const [standingDown, setStandingDown] = useState(false);
  const [samaritanBusy, setSamaritanBusy] = useState(false);
  const working = busy || standingDown;
  const kind = isQueued
    ? (KIND_QUEUED[alert?.kind] || KIND_QUEUED.sos)
    : (KIND[alert?.kind] || KIND.sos);

  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const elapsed = alert?.created_at
    ? Math.max(0, Math.floor(Date.now() / 1000 - alert.created_at))
    : 0;

  const samaritanStatus = alert?.samaritan_status || 'pending';

  // Is the trail still moving? Forty-five seconds is three missed fast pings
  // or one missed slow one -- see LIVE_FIX_STALE_S in server/config.py. The
  // one-second `force` tick above is what makes this go stale on screen
  // without anything having to push a frame.
  const liveFresh = !!alert?.live_at
    && (Date.now() / 1000 - alert.live_at) <= 45;

  const handleSamaritan = async (action) => {
    if (samaritanBusy || !alert?.id) return;
    setSamaritanBusy(true);
    try {
      await onOptinSamaritan?.(alert.id, action);
    } finally {
      setSamaritanBusy(false);
    }
  };

  return (
    <Card tone={C.red} accent={C.red} style={{ gap: S.lg }}>
      <View style={s.head}>
        <View style={{ gap: 4 }}>
          <Label color={C.red}>{kind.label}</Label>
          <Txt variant="h1">{kind.lede}</Txt>
        </View>
        <Chip text={fmtCount(elapsed)} tone={C.red} icon="clock" />
      </View>

      {/* ---- offline banner ---- */}
      {isQueued && (
        <View style={s.offlineBanner}>
          <Icon name="wifi-off" size={18} color={C.amber} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[T.bodyMed, { color: C.amber }]}>
              Alert saved on this device
            </Text>
            <Text style={[T.meta, { color: C.dim }]}>
              It will be sent to your family the moment signal returns. Stay where help can reach you.
            </Text>
          </View>
        </View>
      )}

      {/* ---- Good Samaritan controls / status ---- */}
      {!isQueued && samaritanStatus === 'pending' && (
        <View style={s.samaritanCard}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm }}>
            <Icon name="users" size={18} color={C.blue} />
            <Text style={[T.bodyMed, { color: C.text, flex: 1 }]}>
              Alert nearby people (Good Samaritan)?
            </Text>
          </View>
          <Text style={[T.meta, { color: C.dim }]}>
            Active Nigehban users within 800m can be asked to assist you.
          </Text>
          <View style={{ flexDirection: 'row', gap: S.sm, marginTop: S.xs }}>
            <View style={{ flex: 1 }}>
              <Button
                title="📢 ALERT NEARBY"
                tone={C.blue}
                filled
                loading={samaritanBusy}
                onPress={() => handleSamaritan('allow')}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                title="FAMILY ONLY"
                tone={C.dim}
                loading={samaritanBusy}
                onPress={() => handleSamaritan('deny')}
              />
            </View>
          </View>
        </View>
      )}

      {/* Disclosure, not decoration. The phone is sending this person's
          position every few seconds and they are entitled to be told so in the
          app as well as in the service notification -- a safety product that
          reports where somebody is without saying so is a tracking product. */}
      {!isQueued && liveFresh ? (
        <View style={s.samaritanBanner}>
          <Icon name="navigation" size={16} color={C.green} />
          <Text style={[T.meta, { color: C.green, flex: 1 }]}>
            Your family can see where you are, and it updates as you move
          </Text>
        </View>
      ) : null}

      {!isQueued && samaritanStatus === 'allowed' && (
        <View style={s.samaritanBanner}>
          <Icon name="check-circle" size={16} color={C.green} />
          <Text style={[T.meta, { color: C.green, flex: 1 }]}>
            Nearby Good Samaritans have been notified
          </Text>
        </View>
      )}

      <View style={s.grid}>
        <View style={s.cell}>
          <Label>Sent to</Label>
          <Text style={[T.number, { color: isQueued ? C.amber : C.text }]}>
            {isQueued
              ? 'Not yet — waiting for signal'
              : deliveredTo == null
                ? '—'
                : `${deliveredTo} ${deliveredTo === 1 ? 'person' : 'people'}`}
          </Text>
        </View>
        <View style={s.cell}>
          <Label>Raised from</Label>
          <Text style={[T.number, { color: C.text }]}>
            {alert?.source === 'band' ? 'The band' : 'This phone'}
          </Text>
        </View>
        <View style={s.cell}>
          <Label>Location</Label>
          {/* Three states, not two, and the middle one is the important one.
              "Attached" used to mean a fix went out with the alert, which was
              the whole truth when an alert had exactly one position. Now the
              pin moves, so what the wearer needs to know is whether it is
              still moving -- a tracker that quietly stopped in a dead zone
              must not read as one that is working. */}
          <Text style={[T.number, { color: liveFresh ? C.green : (fix ? C.amber : C.red) }]}>
            {liveFresh ? 'Live'
              : alert?.live_at ? `${fmtAgo(alert.live_at)}`
                : fix ? 'Sent once' : 'Not yet'}
          </Text>
        </View>
      </View>

      <Divider />

      <View style={{ gap: S.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Label color={responders.length ? C.green : (elapsed >= 20 ? C.amber : C.dim)}>
            {responders.length
              ? `On their way (${responders.length})`
              : (isQueued ? 'Saved locally' : (elapsed >= 20 ? 'No responses yet' : 'Waiting for someone to answer'))}
          </Label>
          {!responders.length && !isQueued && (
            <Text style={[T.meta, { color: elapsed >= 20 ? C.amber : C.faint }]}>
              {fmtCount(elapsed)}
            </Text>
          )}
        </View>

        {responders.length ? (
          <View style={{ gap: S.sm }}>
            {responders.map((r) => (
              <View key={r.id || `${r.name}-${r.at}`} style={s.responder}>
                <Icon name="user-check" size={16} color={C.green} />
                <View style={{ flex: 1 }}>
                  <Text style={[T.bodyMed, { color: C.text }]}>{r.name}</Text>
                  <Text style={[T.meta, { color: C.green }]}>Confirmed on the way</Text>
                </View>
                <Text style={[T.meta, { color: C.faint }]}>{fmtAgo(r.at)}</Text>
              </View>
            ))}
          </View>
        ) : isQueued ? (
          <Text style={[T.meta, { color: C.dim }]}>
            Your family will be alerted as soon as your phone finds signal. The alert is safe — it cannot be lost.
          </Text>
        ) : elapsed >= 20 ? (
          <View style={[s.noResponseCard, { borderColor: 'rgba(245, 158, 11, 0.3)', backgroundColor: 'rgba(245, 158, 11, 0.08)' }]}>
            <Icon name="alert-triangle" size={18} color={C.amber} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[T.bodyMed, { color: C.amber }]}>
                No one has answered yet ({fmtCount(elapsed)})
              </Text>
              <Text style={[T.meta, { color: C.dim }]}>
                Emergency sirens continue sounding on your family's and nearby helpers' phones.
              </Text>
            </View>
          </View>
        ) : (
          <Text style={[T.meta, { color: C.dim }]}>
            Their phones are ringing, and they keep ringing while this is open — a closed app does not stop the alarm getting through.
          </Text>
        )}
      </View>

      <View style={{ gap: S.sm }}>
        {(() => {
          const isSending = !alert?.id || deliveryStatus === 'sending';
          const canStandDown = !isSending && !working;
          return (
            <Button
              title={isSending ? 'SENDING ALERT…' : working ? 'STANDING DOWN…' : "I'M SAFE — STAND DOWN"}
              tone={isSending ? C.dim : C.green}
              filled
              icon="shield"
              loading={working || isSending}
              disabled={!canStandDown}
              onPress={async () => {
                if (!canStandDown) return;
                setStandingDown(true);
                try { await onStandDown?.(alert.id); } finally { setStandingDown(false); }
              }}
            />
          );
        })()}
        <Text style={[T.meta, s.foot]}>
          The band can do this too: press key 1 to stand down without the phone.
        </Text>
      </View>
    </Card>
  );
}



const s = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: S.md },
  grid: { flexDirection: 'row', gap: S.md },
  cell: { flex: 1, gap: 4 },
  responder: { flexDirection: 'row', alignItems: 'center', gap: S.sm },
  foot: { color: C.faint, textAlign: 'center' },
  offlineBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: S.sm,
    backgroundColor: C.amberSoft,
    borderRadius: 8,
    padding: S.md,
  },
  samaritanCard: {
    backgroundColor: C.surface,
    borderRadius: 12,
    padding: S.md,
    gap: S.xs,
    borderWidth: 1,
    borderColor: C.blueSoft || '#1E3A8A',
  },
  samaritanBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: S.sm,
    backgroundColor: C.greenSoft || 'rgba(16, 185, 129, 0.1)',
    borderRadius: 8,
    padding: S.md,
  },
  noResponseCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: S.sm,
    padding: S.md,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderWidth: 1,
    borderColor: C.raised || '#1F2937',
  },
});


