import * as Clipboard from 'expo-clipboard';
import * as Location from 'expo-location';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, AppState, FlatList, Pressable, RefreshControl, StyleSheet,
  Text, View,
} from 'react-native';
import { call } from '../../api';
import PinSheet from '../../components/PinSheet';
import { askPermission, fullScreenIntentState } from '../../permissions';
import { hasPin } from '../../security';
import { HIT, S, T, fmtAgo } from '../../theme';
import { Icon, Skeleton, SkeletonGroup, Txt } from '../../ui';
import AddFamily from './AddFamily';
import Dialog from './Dialog';
import { RU, U } from './kit';

/**
 * The board a non-admin sees when nothing is wrong.
 *
 * It answers one question -- is everyone alright -- and it answers it without
 * diagnostics. Anything the wearer cannot act on (link modes, wire logs,
 * heartbeat ages in seconds) belongs on the admin side, not here.
 *
 * What she CAN act on lives here and nowhere else, because this shell has no
 * other screen to hide it on: the SOS, High Alert, and her own position. The
 * last of those is not decoration -- the fix this screen watches is the one
 * attached to every alert she raises, so an alert sent from a shell that was
 * not watching says that something happened but not where.
 */
export default function Dashboard({
  session, ctx, refreshKey, serverOnline, onRaise, onAckCheckin,
  onToggleHighAlert, onFix,
}) {
  const [members, setMembers] = useState([]);
  const [invites, setInvites] = useState({ incoming: [], outgoing: [] });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [adding, setAdding] = useState(false);
  // Taking somebody off the list, which is four steps rather than one: ask,
  // take the PIN, do it, say so. All four live up here rather than on the card
  // itself, because the third step reloads the list -- the card unmounts
  // half-way through, and a popup owned by it would go with it.
  const [dropping, setDropping] = useState(null);      // the member, all the way through
  const [dropStage, setDropStage] = useState(null);    // confirm|verify|set|working|done|failed
  const [dropErr, setDropErr] = useState(null);
  // The SOS is fire-and-forget from this screen's point of view -- App.js swaps
  // the whole shell for the live view the moment it dispatches -- but the fix
  // is captured before that, and on a phone with no lock yet that wait is
  // seconds long. Without this the button looks dead for exactly as long as
  // the person pressing it is least able to tolerate a dead button.
  const [sending, setSending] = useState(false);
  const [sosChoiceOpen, setSosChoiceOpen] = useState(false);
  const [acking, setAcking] = useState(false);
  const [fix, setFix] = useState(null);
  const [locState, setLocState] = useState('asking');   // asking|ok|denied|error

  // true | false | null, where null is "the question does not apply here"
  // (Android 13 and below, Expo Go, web) and must show nothing at all.
  const [fsiAllowed, setFsiAllowed] = useState(null);

  // Asked once, then watched, so an SOS never waits on a GPS lock. Every fix
  // is handed up to App.js as well: that is the copy that rides along on an
  // alert raised from anywhere -- the band, a notification, a backgrounded app.
  useEffect(() => {
    let sub;
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') { setLocState('denied'); return; }
        sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, timeInterval: 5000, distanceInterval: 5 },
          (p) => {
            const next = { lat: p.coords.latitude, lon: p.coords.longitude,
                           acc: p.coords.accuracy, at: Date.now() };
            setFix(next);
            setLocState('ok');
            onFix?.(next);
          });
      } catch {
        setLocState('error');
      }
    })();
    return () => sub?.remove();
  }, [onFix]);

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
    } catch { /* the strip below already says the server is unreachable */ }
    setLoading(false);
    setRefreshing(false);
  }, [session]);

  useEffect(() => { load(); }, [load, refreshKey]);

  // Re-read on every return to the app, because the only way this can change
  // is somebody going to Settings and coming back -- there is no callback and
  // no promise to await.
  useEffect(() => {
    let alive = true;
    const read = () => { fullScreenIntentState().then((v) => { if (alive) setFsiAllowed(v); }); };
    read();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') read();
    });
    return () => { alive = false; sub.remove(); };
  }, []);

  const copyCode = async () => {
    await Clipboard.setStringAsync(session.user_id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  /**
   * REMOVING SOMEBODY — why there is a PIN in front of it.
   *
   * Every other control on this screen makes the app shout louder. This one is
   * the only one that makes it quieter, and it is silent afterwards: nobody is
   * told they were removed, so a link cut at the wrong moment is a link nobody
   * finds out about until an alert has nowhere to go. That is the same threat
   * High Alert's PIN is for -- somebody else holding this phone -- so it is the
   * same PIN, and it is asked for here for the same reason.
   *
   * Being honest about what it is: four digits in the phone's keystore. It
   * stops the person holding the handset, which is who this is about. It is
   * not a second factor and the server does not check it.
   */
  const askDrop = (m) => {
    setDropErr(null);
    setDropping(m);
    setDropStage('confirm');
  };

  // No PIN set yet is the one case that cannot simply be waved through:
  // verifyPin() answers "true" when there is nothing stored, so a gate that
  // just called it would open for anybody. Set one first, then continue.
  const confirmDrop = async () => {
    setDropStage(await hasPin() ? 'verify' : 'set');
  };

  const doDrop = async () => {
    const m = dropping;
    if (!m) return;
    setDropStage('working');
    try {
      await call(session, `/family/${m.id}`, { method: 'DELETE' });
      // The list is reloaded before the popup changes, so the board behind it
      // has already lost the card by the time anybody reads "removed".
      await load();
      setDropStage('done');
    } catch (e) {
      setDropErr(e.message);
      setDropStage('failed');
    }
  };

  const endDrop = () => { setDropping(null); setDropStage(null); setDropErr(null); };

  const online = members.filter((m) => m.online).length;
  const pct = members.length ? Math.round((online / members.length) * 100) : 0;
  const secureTone = !members.length ? U.faint : pct === 100 ? U.mint : U.amber;

  const header = (
    <View style={s.header}>
      <View style={s.brandRow}>
        <View style={s.mark}>
          <Icon name="shield" size={17} color={U.mint} />
        </View>
        <View style={{ flex: 1 }}>
          <Txt variant="h2" color={U.text}>Family Safety</Txt>
          <Text style={[T.meta, { color: U.faint }]}>Peace of Mind Board</Text>
        </View>
        <Pressable
          onPress={copyCode}
          hitSlop={HIT}
          accessibilityRole="button"
          accessibilityLabel={`Copy your code, ${session.user_id}`}
          style={({ pressed }) => [s.codePill, pressed && { opacity: 0.7 }]}
        >
          <Text style={[T.label, { color: copied ? U.mint : U.dim }]}>
            {copied ? 'COPIED' : `CODE #${session.user_id}`}
          </Text>
          <Icon name={copied ? 'check' : 'copy'} size={12} color={copied ? U.mint : U.faint} />
        </Pressable>
      </View>

      <View style={s.strip}>
        {/* "No family added yet" is a fact about her account, not a thing to
            say while the answer is still in flight -- it read as an empty
            family list on every cold start. */}
        {loading ? (
          <>
            <Skeleton width={168} height={15} color={U.raised} style={{ flex: 1 }} />
            <Skeleton width={92} height={26} radius={RU.pill} color={U.raised} />
          </>
        ) : (
          <>
            <Text style={[T.bodyMed, { color: U.text, flex: 1 }]}>
              {members.length
                ? `${online} of ${members.length} ${members.length === 1 ? 'member' : 'members'} active`
                : 'No family added yet'}
            </Text>
            <View style={s.stripPill}>
              <Text style={[T.label, { color: secureTone }]}>
                {members.length ? `${pct}% SECURED` : 'NOT SET UP'}
              </Text>
            </View>
          </>
        )}
      </View>

      {!serverOnline ? (
        <View style={s.notice}>
          <Icon name="wifi-off" size={14} color={U.red} />
          <Text style={[T.meta, { color: U.dim, flex: 1 }]}>
            Offline — these readings may be out of date.
          </Text>
        </View>
      ) : null}

      {/* A dying battery is the one failure that takes the whole watch with
          it, and it is the only one the wearer can still do something about.
          The alert to the family has already gone out by the time this appears
          -- App.js raises it on the threshold crossing -- so this says what
          was sent, not what might be. */}
      {ctx.battery?.goingDark ? (
        <View style={s.notice}>
          <Icon name="battery" size={14} color={U.red} />
          <Text style={[T.meta, { color: U.dim, flex: 1 }]}>
            Battery critical — your family has been told where you were.
          </Text>
        </View>
      ) : ctx.battery?.low ? (
        <View style={[s.notice, { backgroundColor: U.amberSoft }]}>
          <Icon name="battery" size={14} color={U.amber} />
          <Text style={[T.meta, { color: U.dim, flex: 1 }]}>
            Battery at {Math.round(ctx.battery.level)}% — your family has been warned.
          </Text>
        </View>
      ) : null}

      {/* The one permission with no prompt behind it.
          Since Android 14, USE_FULL_SCREEN_INTENT is not granted at install to
          anything that is not a phone or an alarm clock, and when it is missing
          the lock-screen takeover quietly becomes an ordinary notification --
          no error, nothing in the log, just a family emergency that waits in
          the tray until somebody happens to look. There is no dialog to raise,
          only a Settings page, so this asks in place. */}
      {fsiAllowed === false ? (
        <Pressable
          onPress={async () => { await askPermission('fsi'); }}
          accessibilityRole="button"
          accessibilityLabel="Allow Nigehban to take over the screen for emergencies"
          style={({ pressed }) => [s.invite, pressed && { opacity: 0.75 }]}
        >
          <Icon name="phone-incoming" size={16} color={U.amber} />
          <Text style={[T.bodyMed, { color: U.amber, flex: 1 }]}>
            Allow full-screen alerts, so emergencies ring through a locked screen
          </Text>
          <Icon name="chevron-right" size={16} color={U.amber} />
        </Pressable>
      ) : null}

      {/* Somebody asked to be family. Without this the request is invisible
          until it expires -- the user shell has no Family tab to find it in. */}
      {invites.incoming.length ? (
        <Pressable
          onPress={() => setAdding(true)}
          accessibilityRole="button"
          style={({ pressed }) => [s.invite, pressed && { opacity: 0.75 }]}
        >
          <Icon name="user-plus" size={16} color={U.amber} />
          <Text style={[T.bodyMed, { color: U.amber, flex: 1 }]}>
            {invites.incoming.length === 1
              ? `${invites.incoming[0].from.name} wants to be your family`
              : `${invites.incoming.length} people want to be your family`}
          </Text>
          <Icon name="chevron-right" size={16} color={U.amber} />
        </Pressable>
      ) : null}

      {ctx.checkin ? (
        <View style={s.checkin}>
          {/* Three questions, and the SOS one is the opposite of the other
              two: those are answered to STAY clear, this one is answered to
              GET clear. Two in a row and the alert stands itself down. */}
          <Text style={[T.bodyMed, { color: U.amber }]}>
            {ctx.checkin.reason === 'sos'
              ? 'Are you safe now? Two answers stand your SOS down'
              : ctx.checkin.system
                ? 'Nigehban is checking on you'
                : `${ctx.checkin.name} is checking on you`}
          </Text>
          <Pressable
            onPress={async () => {
              if (acking) return;
              setAcking(true);
              try { await onAckCheckin(ctx.checkin); } finally { setAcking(false); }
            }}
            disabled={acking}
            accessibilityRole="button"
            accessibilityState={{ disabled: acking, busy: acking }}
            style={({ pressed }) => [
              s.primary, { backgroundColor: U.mint },
              pressed && { opacity: 0.75 },
            ]}
          >
            {acking ? (
              <ActivityIndicator size="small" color={U.bg} />
            ) : (
              <Icon name="check" size={16} color={U.bg} />
            )}
            <Text style={[T.button, { color: U.bg }]}>
              {acking ? 'Answering…' : 'I am fine'}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {/* The walk home. Server-owned, so it outlives this app being killed. */}
      <HighAlert
        armed={!!ctx.highAlert}
        nextBuzzAt={ctx.nextBuzzAt}
        onToggle={onToggleHighAlert}
      />

      {/* What her family gets instead of a guess. */}
      <LocationCard state={locState} fix={fix} />

      {/* THE BUTTON.
          Round, because nothing else on this screen is, and a shape that
          belongs to one control is findable by a thumb that is not looking.
          Big, because the hand reaching for it may not be steady. It sits
          below the two cards it depends on -- High Alert and the fix -- so
          that the answer to "is this thing even working" is read on the way
          down to it. */}
      <View style={s.sosRing}>
        <Pressable
          onPress={() => {
            if (sending) return;
            // Off means off: no stranger ever gets asked about her, so her
            // own SOS does not ask about strangers either. It goes out family
            // only, with no dialog in the way -- exactly how it worked before
            // Good Samaritan existed. The choice screen only appears at all
            // for someone who opted in to being asked for others.
            if (session?.samaritan_enabled === false) {
              (async () => {
                setSending(true);
                try { await onRaise({ kind: 'sos', source: 'app', allow_samaritan: false }); }
                finally { setSending(false); }
              })();
              return;
            }
            setSosChoiceOpen(true);
          }}
          disabled={sending}
          accessibilityRole="button"
          accessibilityState={{ busy: sending, disabled: sending }}
          accessibilityLabel="Send an emergency SOS to your family"
          style={({ pressed }) => [s.sos, pressed && { backgroundColor: U.redPress }]}
        >
          {sending ? (
            <ActivityIndicator size="large" color={U.bg} />
          ) : (
            <Icon name="alert-octagon" size={30} color={U.bg} />
          )}
          <Text style={s.sosGlyph}>SOS</Text>
          {/* The word changes, not the shape. A control this size that resized
              on press would move under a thumb that is not looking at it. */}
          <Text style={s.sosHint}>{sending ? 'Sending…' : 'Tap to send'}</Text>
        </Pressable>
      </View>


      <View style={s.sectionRow}>
        <Text style={[T.label, { color: U.faint, flex: 1 }]}>MONITORED MEMBERS</Text>
        <Pressable
          onPress={() => setAdding(true)}
          hitSlop={HIT}
          accessibilityRole="button"
          accessibilityLabel="Add a family member"
          style={({ pressed }) => [s.addBtn, pressed && { opacity: 0.7 }]}
        >
          <Icon name="user-plus" size={13} color={U.mint} />
          <Text style={[T.label, { color: U.mint }]}>ADD</Text>
        </Pressable>
      </View>
    </View>
  );

  return (
    <>
      <FlatList
        data={members}
        style={s.list}
        contentContainerStyle={s.content}
        keyExtractor={(m) => m.id}
        ListHeaderComponent={header}
        ItemSeparatorComponent={() => <View style={{ height: S.md }} />}
        refreshControl={(
          <RefreshControl
            refreshing={refreshing}
            tintColor={U.mint}
            onRefresh={() => { setRefreshing(true); load(); }}
          />
        )}
        ListEmptyComponent={loading ? (
          <SkeletonGroup label="Loading your family">
            <MemberCardSkeleton />
            <MemberCardSkeleton />
          </SkeletonGroup>
        ) : (
          <View style={s.empty}>
            <Icon name="users" size={22} color={U.faint} />
            <Text style={[T.body, { color: U.dim, textAlign: 'center' }]}>
              Add someone with their code, or give them yours.
            </Text>
            <Pressable
              onPress={() => setAdding(true)}
              accessibilityRole="button"
              style={({ pressed }) => [
                s.primary, s.emptyBtn, { backgroundColor: U.mint },
                pressed && { opacity: 0.75 },
              ]}
            >
              <Icon name="user-plus" size={16} color={U.bg} />
              <Text style={[T.button, { color: U.bg }]}>Add family</Text>
            </Pressable>
          </View>
        )}
        renderItem={({ item }) => (
          <MemberCard
            member={item}
            session={session}
            removing={dropping?.id === item.id && dropStage !== null}
            onRemove={() => askDrop(item)}
          />
        )}
      />

      <AddFamily
        visible={adding}
        session={session}
        invites={invites}
        onClose={() => setAdding(false)}
        onChanged={load}
      />

      {/* ---- taking somebody off the list ---- */}
      <Dialog
        visible={dropStage === 'confirm' || dropStage === 'working'}
        tone={U.red}
        icon="user-minus"
        title={`Remove ${dropping?.name || 'them'}?`}
        loading={dropStage === 'working'}
        loadingLabel={`Removing ${dropping?.name || 'them'}…`}
        body="This cuts the link both ways. Your PIN is asked for next."
        points={[
          `Your SOS stops reaching ${dropping?.name || 'them'}.`,
          'Theirs stops reaching you.',
          'Neither of you can ask for a check-in.',
        ]}
        note="They are not told. You can add each other again later."
        onClose={endDrop}
        actions={[
          { label: 'Remove', icon: 'user-minus', filled: true, tone: U.red,
            busyLabel: 'Removing…', onPress: confirmDrop },
          { label: 'Keep them', tone: U.dim, onPress: endDrop },
        ]}
      />

      <Dialog
        visible={dropStage === 'done'}
        tone={U.mint}
        icon="check"
        title={dropping?.name ? `${dropping.name} has been removed` : 'They have been removed'}
        body="You are no longer watching each other."
        onClose={endDrop}
        actions={[{ label: 'Done', icon: 'check', filled: true, onPress: endDrop }]}
      />

      <Dialog
        visible={dropStage === 'failed'}
        tone={U.amber}
        icon="alert-circle"
        title="Nothing was removed"
        body={dropErr || 'The server did not answer.'}
        note="You are both still on each other’s list, and alerts still reach you."
        onClose={endDrop}
        actions={[
          { label: 'Try again', icon: 'rotate-ccw', filled: true, tone: U.amber,
            busyLabel: 'Removing…', onPress: doDrop },
          { label: 'Close', tone: U.dim, onPress: endDrop },
        ]}
      />

      {/* The PIN sits between the question and the request, so the wording is
          about this screen -- not about High Alert, which is what the sheet
          says everywhere else it is used. */}
      <PinSheet
        visible={dropStage === 'verify' || dropStage === 'set'}
        mode={dropStage === 'set' ? 'set' : 'verify'}
        title={dropStage === 'set'
          ? 'Choose a PIN first'
          : `Enter your PIN to remove ${dropping?.name || 'them'}`}
        body={dropStage === 'set'
          ? 'Four digits, asked for here and when High Alert is switched off.'
          : 'The same PIN that switches High Alert off.'}
        lockedNote="Too many attempts. Nobody has been removed."
        onCancel={endDrop}
        onDone={doDrop}
      />

      <Dialog
        visible={sosChoiceOpen}
        icon="alert-octagon"
        tone={U.red}
        title="Send Emergency SOS"
        body="Who should this reach?"
        points={[
          'Family & Nearby — your family, plus helpers within 800 m.',
          'Family Only — your family and nobody else.',
        ]}
        actions={[
          {
            label: '📢 Family & Nearby Helpers',
            busyLabel: 'Broadcasting…',
            filled: true,
            tone: U.red,
            onPress: async () => {
              setSosChoiceOpen(false);
              setSending(true);
              try { await onRaise({ kind: 'sos', source: 'app', allow_samaritan: true }); }
              finally { setSending(false); }
            },
          },
          {
            label: '🛡️ Family Only',
            busyLabel: 'Sending…',
            filled: false,
            tone: U.dim,
            onPress: async () => {
              setSosChoiceOpen(false);
              setSending(true);
              try { await onRaise({ kind: 'sos', source: 'app', allow_samaritan: false }); }
              finally { setSending(false); }
            },
          },
          {
            label: 'Cancel',
            tone: U.faint,
            onPress: () => setSosChoiceOpen(false),
          },
        ]}
        onClose={() => setSosChoiceOpen(false)}
      />
    </>
  );
}


/**
 * HIGH ALERT -- arm freely, disarm deliberately.
 *
 * Arming is one tap and asks for nothing. Disarming asks for the PIN, because
 * the entire mode exists for the case where somebody else may be holding the
 * phone; that asymmetry is the feature, not an oversight. If no PIN has been
 * set we still let her disarm -- locking her out of her own phone would be a
 * worse failure than the one this guards against.
 *
 * The next check-in is printed to the minute on purpose. The interval is
 * randomised between five and ten minutes precisely so that it cannot be timed
 * and planned around; a second-accurate countdown would hand that back.
 */
function HighAlert({ armed, nextBuzzAt, onToggle }) {
  const [busy, setBusy] = useState(false);
  const [pinMode, setPinMode] = useState(null);        // null | 'verify' | 'set'
  const [pinSet, setPinSet] = useState(true);
  const [, force] = useState(0);

  useEffect(() => { hasPin().then(setPinSet).catch(() => setPinSet(false)); }, [pinMode]);

  // One tick every twenty seconds is more than enough for a value printed to
  // the minute.
  useEffect(() => {
    if (!armed || !nextBuzzAt) return undefined;
    const id = setInterval(() => force((n) => n + 1), 20000);
    return () => clearInterval(id);
  }, [armed, nextBuzzAt]);

  const apply = useCallback(async (on) => {
    if (!onToggle || busy) return;
    setBusy(true);
    try { await onToggle(on); } finally { setBusy(false); }
  }, [onToggle, busy]);

  const press = async () => {
    if (!armed) { apply(true); return; }
    if (await hasPin()) { setPinMode('verify'); return; }
    apply(false);
  };

  const mins = nextBuzzAt
    ? Math.max(0, Math.ceil((nextBuzzAt - Date.now() / 1000) / 60))
    : null;

  return (
    <>
      <View style={[s.card, armed && { backgroundColor: U.redSoft }]}>
        <View style={s.cardHead}>
          <View style={[s.cardMark, armed && { backgroundColor: U.red }]}>
            <Icon name="shield" size={17} color={armed ? U.bg : U.red} />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Txt variant="h2" color={U.text}>High Alert</Txt>
            <Text style={[T.meta, { color: U.dim }]}>
              {armed
                ? 'Checked on every five to ten minutes'
                : 'For the walk home'}
            </Text>
          </View>
          <View style={[s.statusPill, { backgroundColor: armed ? U.bg : U.raised }]}>
            <Text style={[T.label, { color: armed ? U.red : U.faint }]}>
              {armed ? 'ARMED' : 'OFF'}
            </Text>
          </View>
        </View>

        {armed ? (
          <View style={s.foot}>
            <Icon name="clock" size={11} color={U.dim} />
            <Text style={[T.meta, { color: U.dim, flex: 1 }]}>
              {mins == null ? 'First check-in is being scheduled'
                : mins <= 1 ? 'Next check-in due about now'
                : `Next check-in in about ${mins} minutes`}
            </Text>
          </View>
        ) : null}

        <Pressable
          onPress={press}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={armed ? 'Disarm High Alert' : 'Arm High Alert'}
          style={({ pressed }) => [
            s.primary,
            { backgroundColor: armed ? U.raised : U.red },
            pressed && { opacity: 0.75 },
          ]}
        >
          {busy ? (
            <ActivityIndicator size="small" color={armed ? U.red : U.bg} />
          ) : (
            <>
              <Icon name={armed ? 'unlock' : 'shield'} size={16} color={armed ? U.dim : U.bg} />
              <Text style={[T.button, { color: armed ? U.dim : U.bg }]}>
                {armed ? 'Disarm' : 'Arm High Alert'}
              </Text>
            </>
          )}
        </Pressable>

        {armed && !pinSet ? (
          <Pressable
            onPress={() => setPinMode('set')}
            accessibilityRole="button"
            style={({ pressed }) => [s.pinCta, pressed && { opacity: 0.75 }]}
          >
            <Icon name="lock" size={13} color={U.amber} />
            <Text style={[T.meta, { color: U.amber, flex: 1 }]}>
              Set a disarm PIN, so nobody else can switch this off
            </Text>
          </Pressable>
        ) : null}

        {armed ? (
          <Text style={[T.meta, { color: U.faint }]}>
            Miss one and your family is told, even with the app closed.
          </Text>
        ) : null}
      </View>

      <PinSheet
        visible={pinMode !== null}
        mode={pinMode === 'set' ? 'set' : 'verify'}
        onCancel={() => setPinMode(null)}
        onDone={() => {
          const wasVerify = pinMode === 'verify';
          setPinMode(null);
          if (wasVerify) apply(false);
        }}
      />
    </>
  );
}

/** Where an alert would say she is. Denied is the only state with an action. */
function LocationCard({ state, fix }) {
  const tone = state === 'ok' ? U.mint : state === 'denied' ? U.red : U.amber;

  return (
    <View style={s.card}>
      <View style={s.cardHead}>
        <View style={s.cardMark}>
          <Icon name="map-pin" size={17} color={tone} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Txt variant="h2" color={U.text}>Your location</Txt>
          <Text style={[T.meta, { color: U.dim }]}>
            {state === 'ok' && fix
              ? `Accurate to about ${Math.round(fix.acc)} m · updated ${fmtAgo(fix.at / 1000)}`
              : state === 'denied'
                ? 'Location is off, so an alert cannot say where you are'
                : state === 'error'
                  ? 'Location is unavailable on this device'
                  : 'Waiting for a fix from the phone…'}
          </Text>
        </View>
        <View style={[s.statusPill, { backgroundColor: U.raised }]}>
          <View style={[s.dot, { backgroundColor: tone }]} />
          <Text style={[T.label, { color: tone }]}>
            {state === 'ok' ? 'LIVE' : state === 'denied' ? 'OFF' : 'WAITING'}
          </Text>
        </View>
      </View>

      {state === 'ok' && fix ? (
        <View style={s.panel}>
          <Text style={[T.number, { color: U.text, flex: 1 }]}>
            {fix.lat.toFixed(5)}, {fix.lon.toFixed(5)}
          </Text>
        </View>
      ) : state === 'denied' ? (
        <AskForLocation />
      ) : null}
    </View>
  );
}

/**
 * The permission dialog can take a beat to appear, and on a phone that has
 * already refused once it never appears at all -- so the button has to admit
 * it was pressed by itself rather than waiting for Android to say so.
 */
function AskForLocation() {
  const [asking, setAsking] = useState(false);

  const ask = async () => {
    if (asking) return;
    setAsking(true);
    try { await Location.requestForegroundPermissionsAsync(); } catch { /* the card still says denied */ }
    setAsking(false);
  };

  return (
    <Pressable
      onPress={ask}
      disabled={asking}
      accessibilityRole="button"
      accessibilityState={{ busy: asking, disabled: asking }}
      style={({ pressed }) => [
        s.primary, { backgroundColor: U.amber }, pressed && { opacity: 0.75 },
      ]}
    >
      {asking ? (
        <ActivityIndicator size="small" color={U.bg} />
      ) : (
        <Icon name="map-pin" size={16} color={U.bg} />
      )}
      <Text style={[T.button, { color: U.bg }]}>
        {asking ? 'Asking Android…' : 'Turn location on'}
      </Text>
    </Pressable>
  );
}

function MemberCard({ member, session, removing, onRemove }) {
  const w = member.watchState || {};
  const online = !!member.online;
  const tone = online ? U.mint : U.faint;
  // Two cells, two batteries. This card used to show one number labelled
  // BATTERY that actually held the band's charge -- see migration 002. The
  // band's now rides on the BAND cell, so neither can be read as the other.
  const batt = w.phone_batt != null ? `${Math.round(w.phone_batt)}%` : '—';
  const linked = !!w.band_link;
  // Virtual mode has no second cell at all, so this cell must say so rather
  // than show the phone's own charge a second time under a band's name.
  const virtual = !!w.band_virtual;
  const bandBatt = w.band_batt != null ? `${Math.round(w.band_batt)}%` : null;
  const bandValue = virtual ? 'Phone as band'
                  : linked ? (bandBatt ? `Linked · ${bandBatt}` : 'Linked')
                  : 'None';

  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const checkin = async () => {
    setBusy(true);
    try {
      await call(session, `/checkin/${member.id}`, { method: 'POST' });
      setSent(true);
      timer.current = setTimeout(() => setSent(false), 3000);
    } catch { /* no confirmation is the failure signal */ }
    setBusy(false);
  };

  return (
    <View style={s.card}>
      <View style={[s.accent, { backgroundColor: tone }]} />

      <View style={s.cardHead}>
        <View style={s.nameRow}>
          <Txt variant="h2" color={U.text}>{member.name}</Txt>
          {member.relation ? (
            <Text style={[T.meta, { color: U.faint }]}>{member.relation}</Text>
          ) : null}
        </View>
        <View style={[s.statusPill, { backgroundColor: online ? U.mintSoft : U.raised }]}>
          <View style={[s.dot, { backgroundColor: tone }]} />
          <Text style={[T.label, { color: tone }]}>{online ? 'ONLINE' : 'OFFLINE'}</Text>
        </View>
      </View>

      <View style={s.panel}>
        <View style={s.cell}>
          <Icon name="battery" size={15} color={U.faint} />
          <View style={{ flex: 1 }}>
            <Text style={[T.label, { color: U.faint }]}>PHONE BATTERY</Text>
            <Text style={[T.number, { color: U.text }]}>{batt}</Text>
          </View>
        </View>
        <View style={s.cellLine} />
        <View style={s.cell}>
          <Icon name="radio" size={15} color={U.faint} />
          <View style={{ flex: 1 }}>
            <Text style={[T.label, { color: U.faint }]}>BAND</Text>
            <Text style={[T.number, { color: linked && !virtual ? U.text : U.faint }]}>
              {bandValue}
            </Text>
            {virtual ? (
              <Text style={[T.meta, { color: U.faint }]}>Band battery N/A</Text>
            ) : null}
          </View>
          <Bars active={linked} />
        </View>
      </View>

      <Pressable
        onPress={checkin}
        disabled={busy || sent}
        accessibilityRole="button"
        accessibilityState={{ busy, disabled: busy || sent }}
        accessibilityLabel={`Request a check-in from ${member.name}`}
        style={({ pressed }) => [
          s.primary,
          { backgroundColor: sent ? U.mintSoft : U.mint },
          pressed && { opacity: 0.75 },
        ]}
      >
        {busy ? (
          <ActivityIndicator size="small" color={U.bg} />
        ) : (
          <Icon name={sent ? 'check' : 'shield'} size={16} color={sent ? U.mint : U.bg} />
        )}
        <Text style={[T.button, { color: sent ? U.mint : U.bg }]}>
          {busy ? 'Sending…' : sent ? 'Check-in sent' : 'Request Check-in'}
        </Text>
      </Pressable>

      <View style={s.foot}>
        <Icon name="clock" size={11} color={U.faint} />
        <Text style={[T.meta, { color: U.faint, flex: 1 }]}>
          Last active {w.last_beat ? fmtAgo(w.last_beat) : '—'}
        </Text>
        <Text style={[T.meta, { color: U.faint }]}>ID {member.id}</Text>
      </View>

      {/* Below the footer, and never beside the check-in button. This is the
          one control on the card that makes the app quieter, and a thumb
          reaching for the loud one must not be able to find it by accident. */}
      {onRemove ? (
        <Pressable
          onPress={onRemove}
          disabled={removing}
          accessibilityRole="button"
          accessibilityState={{ busy: !!removing, disabled: !!removing }}
          accessibilityLabel={`Remove ${member.name} from your family`}
          style={({ pressed }) => [
            s.remove,
            removing && { opacity: 0.6 },
            pressed && !removing && { opacity: 0.75 },
          ]}
        >
          {removing ? (
            <ActivityIndicator size="small" color={U.faint} />
          ) : (
            <Icon name="user-minus" size={14} color={U.faint} />
          )}
          <Text style={[T.button, { color: removing ? U.dim : U.faint, fontSize: 13 }]}>
            {removing ? 'Removing…' : 'Remove from family'}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * The member card before its member arrives.
 *
 * Deliberately the same geometry as the real thing -- head, two-cell panel,
 * button, footer -- so the list does not jump when the data lands. A spinner
 * would have said "wait"; this says what is about to be here.
 */
function MemberCardSkeleton() {
  return (
    <View style={s.card}>
      <View style={s.cardHead}>
        <Skeleton width={132} height={20} color={U.raised} style={{ flex: 1 }} />
        <Skeleton width={82} height={26} radius={RU.pill} color={U.raised} />
      </View>

      <View style={s.panel}>
        <View style={s.cell}>
          <Skeleton width={15} height={15} color={U.line} />
          <View style={{ flex: 1, gap: 6 }}>
            <Skeleton width={78} height={9} color={U.line} />
            <Skeleton width={46} height={15} color={U.line} />
          </View>
        </View>
        <View style={s.cellLine} />
        <View style={s.cell}>
          <Skeleton width={15} height={15} color={U.line} />
          <View style={{ flex: 1, gap: 6 }}>
            <Skeleton width={38} height={9} color={U.line} />
            <Skeleton width={64} height={15} color={U.line} />
          </View>
        </View>
      </View>

      <Skeleton height={48} radius={RU.inner} color={U.raised} />
      <Skeleton width={148} height={11} color={U.raised} />
    </View>
  );
}

/** Four rising bars: signal, without needing a number beside it. */
function Bars({ active }) {
  return (
    <View style={s.bars}>
      {[6, 9, 12, 15].map((h, i) => (
        <View key={i} style={[s.bar, { height: h, backgroundColor: active ? U.mint : U.line }]} />
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  list: { flex: 1, backgroundColor: U.bg },
  content: { padding: S.lg, paddingBottom: S.xxl },

  header: { gap: S.md, marginBottom: S.md },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: S.md },
  mark: {
    width: 38, height: 38, borderRadius: RU.inner, backgroundColor: U.mintSoft,
    alignItems: 'center', justifyContent: 'center',
  },
  codePill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: S.md, paddingVertical: 8,
    borderRadius: RU.pill, backgroundColor: U.raised,
  },

  strip: {
    flexDirection: 'row', alignItems: 'center', gap: S.sm,
    backgroundColor: U.card, borderRadius: RU.card,
    paddingHorizontal: S.md, paddingVertical: S.md,
  },
  stripPill: {
    paddingHorizontal: S.md, paddingVertical: 6,
    borderRadius: RU.pill, backgroundColor: U.raised,
  },

  notice: {
    flexDirection: 'row', alignItems: 'center', gap: S.sm,
    backgroundColor: U.redSoft, borderRadius: RU.card, padding: S.md,
  },

  checkin: {
    gap: S.md, backgroundColor: U.amberSoft, borderRadius: RU.card, padding: S.lg,
  },

  // The ring is a second, softer red around the button: it reads as a halo at
  // arm's length and keeps the circle off the cards above it.
  sosRing: {
    alignSelf: 'center', marginTop: S.md, marginBottom: S.sm,
    padding: 12, borderRadius: RU.pill, backgroundColor: U.redSoft,
  },
  sos: {
    width: 188, height: 188, borderRadius: 94,
    alignItems: 'center', justifyContent: 'center', gap: 2,
    backgroundColor: U.red,
  },
  sosGlyph: { ...T.display, color: U.bg, fontSize: 44, lineHeight: 50, letterSpacing: 4 },
  sosHint: { ...T.meta, color: U.bg, opacity: 0.85 },

  invite: {
    flexDirection: 'row', alignItems: 'center', gap: S.sm,
    backgroundColor: U.amberSoft, borderRadius: RU.card, padding: S.md,
  },

  sectionRow: {
    flexDirection: 'row', alignItems: 'center', gap: S.sm, marginTop: S.md,
  },
  addBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: S.md, paddingVertical: 7,
    borderRadius: RU.pill, backgroundColor: U.mintSoft,
  },

  card: {
    backgroundColor: U.card, borderRadius: RU.card,
    padding: S.lg, gap: S.md, overflow: 'hidden',
  },
  cardMark: {
    width: 38, height: 38, borderRadius: RU.inner, backgroundColor: U.raised,
    alignItems: 'center', justifyContent: 'center',
  },
  pinCta: {
    flexDirection: 'row', alignItems: 'flex-start', gap: S.sm,
    backgroundColor: U.amberSoft, borderRadius: RU.inner, padding: S.md,
  },
  accent: { position: 'absolute', left: 0, top: S.lg, bottom: S.lg, width: 3 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: S.sm },
  nameRow: { flex: 1, flexDirection: 'row', alignItems: 'baseline', gap: S.sm },
  statusPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: S.md, paddingVertical: 6, borderRadius: RU.pill,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },

  panel: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: U.raised, borderRadius: RU.inner, padding: S.md,
  },
  cell: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: S.sm },
  cellLine: {
    width: StyleSheet.hairlineWidth, alignSelf: 'stretch',
    backgroundColor: U.line, marginHorizontal: S.md,
  },

  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 15 },
  bar: { width: 3, borderRadius: 1 },

  primary: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: S.sm,
    minHeight: 48, borderRadius: RU.inner,
  },

  foot: { flexDirection: 'row', alignItems: 'center', gap: 6 },

  /* Quiet on purpose -- no fill, no colour, and the smallest type on the card
     -- but still the 48pt target everything else here gets. */
  remove: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: S.sm, minHeight: 48, borderRadius: RU.inner,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: U.line,
    marginTop: S.xs,
  },

  empty: {
    alignItems: 'center', gap: S.md,
    paddingVertical: S.xxl, paddingHorizontal: S.lg,
  },
  emptyBtn: { alignSelf: 'stretch', marginTop: S.sm },
});
