import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated, Linking, Pressable, RefreshControl, SectionList, StyleSheet, Text, View,
} from 'react-native';
import { call } from '../api';
import { C, R, S, T, fmtAgo, sevColor } from '../theme';
import {
  Banner, Button, Chip, EmptyState, Icon, Skeleton, SkeletonGroup,
} from '../ui';
import {
  RANGES, ackedByMe, autoOpen, buildSections, fmtClock, initials, isLive, kindOf, rangeAt,
} from './alertGroups';

const SCOPES = [['incoming', 'From family'], ['mine', 'Mine']];

/** How many events a group shows before it offers to show the rest. */
const FOLD_AT = 8;

/**
 * ALERTS — the record, folded so that a week of it is still readable.
 *
 * The console list was flat and newest-first, which is the correct record and
 * the wrong screen: every battery note and check-in the system has ever
 * written, at the same weight as an SOS, pushing the one live row off the fold
 * by lunchtime. It is now folded by day and, inside the day, by the person the
 * alerts are about — one card each, their name set large, the timeline of what
 * happened one tap inside.
 *
 * The arithmetic is shared with the user shell's list (see ./alertGroups), and
 * so is the rule it protects: a live emergency is never folded away. It ignores
 * the date filter, its card opens itself, and it sorts to the top of its day.
 */
export default function Alerts({ session, refreshKey }) {
  const [scope, setScope] = useState('incoming');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [acked, setAcked] = useState(() => new Set());
  const [err, setErr] = useState(null);
  const [rangeI, setRangeI] = useState(0);
  const [open, setOpen] = useState({});
  const [unfolded, setUnfolded] = useState({});
  // A group that has been open once stays open for as long as the screen is.
  // `autoOpen` is derived from what is still live or still waiting, so
  // answering the last outstanding alert flips it to false -- and without this
  // the card would fold shut under the finger that just pressed the button on
  // it. An explicit collapse still wins; this only stops the list from
  // closing itself.
  const stickyOpen = useRef(new Set());
  const [, force] = useState(0);

  const load = useCallback(async () => {
    try {
      setRows(await call(session, `/alerts?scope=${scope}`));
      setErr(null);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [session, scope]);

  useEffect(() => { setLoading(true); load(); }, [load, refreshKey]);

  // Switching scope is switching question. Nothing about how the last answer
  // was folded open applies to the new one.
  useEffect(() => {
    setRangeI(0); setOpen({}); setUnfolded({}); stickyOpen.current = new Set();
  }, [scope]);

  // Relative times freeze at whatever they said when the list was built, which
  // on a live alert is the one number somebody is actually watching.
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 30000);
    return () => clearInterval(id);
  }, []);

  const seen = useRef(acked);
  seen.current = acked;

  const ack = async (a) => {
    setBusy(a.id);
    try {
      await call(session, `/alert/${a.id}/ack`, { method: 'POST' });
      setAcked(new Set([...seen.current, a.id]));
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  const range = rangeAt(rangeI);
  const { sections, hidden, shown, liveCount, needsCount, groupCount } = useMemo(
    () => buildSections(rows, {
      rangeDays: range.days, scope, myId: session?.user_id, localAcked: acked,
    }),
    [rows, range.days, scope, session?.user_id, acked],
  );

  const openState = (g) => {
    const on = open[g.key] ?? (autoOpen(g, groupCount) || stickyOpen.current.has(g.key));
    if (on) stickyOpen.current.add(g.key);
    return on;
  };

  return (
    <SectionList
      contentContainerStyle={s.wrap}
      sections={sections}
      keyExtractor={(g) => g.key}
      stickySectionHeadersEnabled
      refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={C.green} />}
      ItemSeparatorComponent={() => <View style={{ height: S.md }} />}
      ListHeaderComponent={
        <View style={{ gap: S.md, marginBottom: S.sm }}>
          <View style={s.segment}>
            {SCOPES.map(([k, label]) => {
              const on = scope === k;
              return (
                <Pressable key={k} onPress={() => setScope(k)}
                           accessibilityRole="tab" accessibilityState={{ selected: on }}
                           style={[s.segBtn, on && s.segBtnOn]}>
                  <Text style={[T.button, { fontSize: 14, color: on ? C.text : C.dim }]}>
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {!loading ? (
            <Text style={[liveCount || needsCount ? T.bodyMed : T.meta, {
              color: liveCount ? C.red : needsCount ? C.amber : C.faint,
            }]}>
              {liveCount
                ? `${liveCount} still live`
                : needsCount
                  ? `${needsCount} waiting for an answer`
                  : `${range.label}${shown ? ` · ${shown} event${shown === 1 ? '' : 's'}` : ''}`}
            </Text>
          ) : null}

          {err ? (
            <Banner tone={C.red} icon="alert-circle" title="Could not load your alerts">
              {err}
            </Banner>
          ) : null}
        </View>
      }
      renderSectionHeader={({ section }) => (
        <View style={s.dayHeadWrap}>
          <Text style={s.dayHead}>{section.title.toUpperCase()}</Text>
        </View>
      )}
      renderItem={({ item }) => {
        const isOpen = openState(item);
        return (
          <GroupCard
            group={item}
            scope={scope}
            expanded={isOpen}
            onToggle={() => setOpen((o) => ({ ...o, [item.key]: !isOpen }))}
            unfolded={!!unfolded[item.key]}
            onUnfold={() => setUnfolded((u) => ({ ...u, [item.key]: true }))}
            myId={session?.user_id}
            acked={acked}
            busy={busy}
            onAck={ack}
          />
        );
      }}
      ListEmptyComponent={
        loading ? (
          <SkeletonGroup label="Loading alerts">
            <GroupCardSkeleton />
            <GroupCardSkeleton />
          </SkeletonGroup>
        ) : hidden > 0 ? (
          <EmptyState icon="calendar" title="Nothing today"
                      body={`${hidden} earlier ${hidden === 1 ? 'event is' : 'events are'} kept below.`} />
        ) : scope === 'incoming' ? (
          <EmptyState icon="shield" title="Nothing from your family"
                      body="That is the good outcome. Anything they raise appears here the moment it happens." />
        ) : (
          <EmptyState icon="activity" title="You have not raised anything"
                      body="Your own alerts, check-ins and near misses are kept here so you can see what the band actually did." />
        )
      }
      ListFooterComponent={loading ? null : (
        <Footer
          hidden={hidden}
          next={range.next}
          canReset={rangeI > 0}
          onMore={() => setRangeI((i) => Math.min(i + 1, RANGES.length - 1))}
          onReset={() => setRangeI(0)}
        />
      )}
    />
  );
}

// -------------------------------------------------------- group card ---
/**
 * A person, a day, and everything that happened to them on it.
 *
 * Closed: who, how bad, how many, how long ago. Open: the timeline, which is
 * also where the one button a record can still carry lives.
 */
function GroupCard({
  group, scope, expanded, onToggle, unfolded, onUnfold, myId, acked, busy, onAck,
}) {
  const live = group.live.length > 0;
  const needs = group.needs.length > 0;
  // Live only. ui.js reserves the 3pt bar for "a card that is reporting a live
  // emergency" and nothing else; putting it on an amber card too spends the
  // one piece of chrome the console allows on a state that is merely waiting.
  const accent = live ? C.red : null;
  const mark = live
    ? { backgroundColor: C.red, color: C.bg }
    : needs
      ? { backgroundColor: C.amberSoft, color: C.amber }
      : { backgroundColor: C.raised, color: C.dim };

  // Chevron only. Height is not animated: this list can hold two hundred rows
  // on a cheap phone, and a stuttering accordion reads as a hung app.
  const spin = useRef(new Animated.Value(expanded ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(spin, {
      toValue: expanded ? 1 : 0, duration: 160, useNativeDriver: true,
    }).start();
  }, [expanded, spin]);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] });

  const items = group.items;
  const visible = (unfolded || items.length <= FOLD_AT) ? items : items.slice(0, FOLD_AT);

  const clock = fmtClock(group.latest.created_at);
  const when = group.dayLabel === 'Today'
    ? fmtAgo(group.latest.created_at)
    : `${clock.time} ${clock.meridiem}`;

  const headline = live
    ? (group.live.length === 1
        ? `${kindOf(group.live[0]).title} · still live`
        : `${group.live.length} emergencies still live`)
    : needs
      ? (group.needs.length === 1
          ? `${kindOf(group.needs[0]).title} · needs an answer`
          : `${group.needs.length} waiting for an answer`)
      : items.length === 1
        ? kindOf(items[0]).title
        : `${items.length} events`;

  return (
    <View style={[s.card, live && { backgroundColor: C.redSoft },
                  accent && { borderLeftWidth: 3, borderLeftColor: accent }]}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${group.name}, ${headline}, ${group.dayLabel}`}
        accessibilityHint={expanded ? 'Hides the timeline' : 'Shows what happened'}
        style={({ pressed }) => [s.groupHead, pressed && { opacity: 0.7 }]}
      >
        {/* The waiting state has lost the bar, so the mark carries it here the
            way it does in the user shell: tone, not chrome. */}
        <View style={[s.avatar, { backgroundColor: mark.backgroundColor }]}>
          <Text style={[s.avatarTxt, { color: mark.color }]}>{initials(group.name)}</Text>
        </View>

        <View style={{ flex: 1, gap: 3 }}>
          <Text style={s.name} numberOfLines={1}>{group.name}</Text>
          <Text style={[live || needs ? T.bodyMed : T.meta,
                        { color: live ? C.red : needs ? C.amber : C.dim }]}
                numberOfLines={1}>
            {headline}
          </Text>
        </View>

        <View style={s.headRight}>
          <Text style={s.when}>{when}</Text>
          <Animated.View style={{ transform: [{ rotate }] }}>
            <Icon name="chevron-down" size={18} color={C.faint} />
          </Animated.View>
        </View>
      </Pressable>

      {/* Closed, the kind chips are the whole summary of the day. Open, the
          timeline says all of it in more detail, so they would be noise. */}
      {!expanded ? (
        <View style={s.kindRow}>
          {group.kinds.slice(0, 4).map((k) => (
            <Chip key={k.kind} icon={k.icon} tone={sevColor(k.severity)}
                  text={`${k.short}${k.n > 1 ? ` ×${k.n}` : ''}`} />
          ))}
          {group.kinds.length > 4 ? (
            <Chip text={`+${group.kinds.length - 4}`} tone={C.faint} icon="more-horizontal" />
          ) : null}
        </View>
      ) : null}

      {expanded ? (
        <View style={s.timeline}>
          {visible.map((a, i) => (
            <EventRow
              key={a.id}
              item={a}
              scope={scope}
              last={i === visible.length - 1}
              mineAcked={ackedByMe(a, myId, acked)}
              busy={busy}
              onAck={onAck}
            />
          ))}
          {visible.length < items.length ? (
            <Pressable onPress={onUnfold} accessibilityRole="button"
                       style={({ pressed }) => [s.unfold, pressed && { opacity: 0.7 }]}>
              <Icon name="more-horizontal" size={15} color={C.dim} />
              <Text style={[T.meta, { color: C.dim }]}>
                Show {items.length - visible.length} earlier
                {' '}{items.length - visible.length === 1 ? 'event' : 'events'} from this day
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

// -------------------------------------------------------- event row ---
/**
 * One thing that happened, on a rail, with the clock time in the gutter.
 *
 * Relative time is what you need in a list of days; absolute time is what you
 * need inside one — and "11:42 PM" is the thing somebody reads down a phone.
 */
function EventRow({ item, scope, last, mineAcked, busy, onAck }) {
  const meta = kindOf(item);
  const t = sevColor(item.severity);
  const live = isLive(item);
  const clock = fmtClock(item.created_at);

  const source = item.source === 'band' ? 'from the band'
    : item.source === 'server' ? 'from the server watchdog'
    : 'from the phone';

  return (
    <View style={s.event}>
      <View style={s.gutter}>
        <Text style={s.clock}>{clock.time}</Text>
        <Text style={s.meridiem}>{clock.meridiem}</Text>
      </View>

      <View style={s.rail}>
        <View style={[s.railDot, { backgroundColor: live ? t : C.raised, borderColor: t }]} />
        {!last ? <View style={s.railLine} /> : null}
      </View>

      <View style={s.eventBody}>
        <View style={s.eventTitleRow}>
          <Icon name={meta.icon} size={15} color={t} />
          <Text style={[T.bodyMed, { color: C.text, flex: 1 }]} numberOfLines={2}>
            {meta.title}
          </Text>
          {live ? <Chip text="live" tone={t} icon="radio" /> : null}
        </View>

        <Text style={[T.meta, { color: C.faint }]}>
          {source}
          {item.resolved_at ? ` · stood down ${fmtAgo(item.resolved_at)}` : ''}
          {!item.maps ? ' · no location' : ''}
        </Text>

        {item.note ? (
          <Text style={[T.meta, { color: C.dim }]}>“{item.note}”</Text>
        ) : null}

        {mineAcked ? (
          <View style={s.chips}>
            <Chip text="you are on it" tone={C.green} icon="user-check" />
          </View>
        ) : null}

        {item.maps ? (
          <Button title="OPEN IN MAPS" icon="navigation" tone={live ? t : C.dim}
                  sub={item.accuracy ? `accurate to about ${Math.round(item.accuracy)} m` : null}
                  onPress={() => Linking.openURL(item.maps)} />
        ) : null}

        {scope === 'incoming' && item.severity >= 3 && !item.resolved_at && !mineAcked ? (
          <Button title="I'VE SEEN THIS — I'M ON IT" filled tone={t}
                  icon="user-check" loading={busy === item.id}
                  onPress={() => onAck(item)} />
        ) : null}
      </View>
    </View>
  );
}

// ------------------------------------------------------------ footer ---
/** History, on request: today, then a week, then the lot. */
function Footer({ hidden, next, canReset, onMore, onReset }) {
  if (!hidden && !canReset) return null;
  return (
    <View style={{ gap: S.sm, marginTop: S.lg }}>
      {hidden > 0 && next ? (
        <Button title={next.toUpperCase()} icon="chevron-down" tone={C.dim}
                sub={`${hidden} earlier ${hidden === 1 ? 'event' : 'events'}`}
                onPress={onMore} />
      ) : null}
      {canReset ? (
        <Pressable onPress={onReset} accessibilityRole="button"
                   style={({ pressed }) => [s.reset, pressed && { opacity: 0.6 }]}>
          <Text style={[T.meta, { color: C.faint }]}>Back to today</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** The card's own geometry, drawn empty, so the list does not jump on arrival. */
function GroupCardSkeleton() {
  return (
    <View style={s.card}>
      <View style={s.groupHead}>
        <Skeleton width={40} height={40} radius={R.control} />
        <View style={{ flex: 1, gap: 7 }}>
          <Skeleton width={148} height={22} />
          <Skeleton width={94} height={12} />
        </View>
        <Skeleton width={44} height={12} />
      </View>
      <View style={s.kindRow}>
        <Skeleton width={84} height={24} radius={R.chip} />
        <Skeleton width={66} height={24} radius={R.chip} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { padding: S.lg, paddingBottom: 40 },
  segment: { flexDirection: 'row', backgroundColor: C.surface, borderRadius: 6, padding: 3 },
  segBtn: { flex: 1, minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 4 },
  segBtnOn: { backgroundColor: C.raised },

  // Sticky, on the app ground rather than on a card, so it reads as a divider
  // in the scroll rather than as another thing to press.
  dayHeadWrap: { backgroundColor: C.bg, paddingTop: S.md, paddingBottom: S.sm },
  dayHead: { ...T.label, color: C.faint, letterSpacing: 1.4 },

  card: { backgroundColor: C.surface, borderRadius: R.card, overflow: 'hidden' },
  groupHead: {
    flexDirection: 'row', alignItems: 'center', gap: S.md,
    padding: S.lg, minHeight: 80,
  },
  avatar: {
    width: 40, height: 40, borderRadius: R.control, backgroundColor: C.raised,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarTxt: { ...T.title, color: C.dim, letterSpacing: 0.3 },

  name: { ...T.h1, color: C.text },
  headRight: { alignItems: 'flex-end', gap: 6 },
  when: { ...T.meta, color: C.faint, fontSize: 12, fontVariant: ['tabular-nums'] },

  kindRow: {
    flexDirection: 'row', flexWrap: 'wrap', gap: S.sm,
    paddingHorizontal: S.lg, paddingBottom: S.lg,
  },

  timeline: {
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line,
    paddingHorizontal: S.lg, paddingTop: S.lg, paddingBottom: S.sm,
  },

  event: { flexDirection: 'row', gap: S.sm },
  gutter: { width: 46, alignItems: 'flex-end', paddingTop: 1 },
  clock: { ...T.meta, color: C.dim, fontVariant: ['tabular-nums'], lineHeight: 17 },
  meridiem: { ...T.label, color: C.faint, fontSize: 10 },

  rail: { width: 14, alignItems: 'center' },
  railDot: { width: 10, height: 10, borderRadius: 5, borderWidth: 2, marginTop: 5 },
  railLine: { flex: 1, width: StyleSheet.hairlineWidth, backgroundColor: C.line, marginTop: 4 },

  eventBody: { flex: 1, gap: S.sm, paddingBottom: S.lg },
  eventTitleRow: { flexDirection: 'row', alignItems: 'center', gap: S.sm },
  chips: { flexDirection: 'row', gap: S.sm, flexWrap: 'wrap' },

  unfold: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: S.sm,
    minHeight: 44, marginBottom: S.sm,
  },
  reset: { minHeight: 40, alignItems: 'center', justifyContent: 'center' },
});
