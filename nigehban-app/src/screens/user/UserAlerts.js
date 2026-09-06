import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable, RefreshControl, SectionList, StyleSheet, Text, View,
} from 'react-native';
import { call, optinSamaritan } from '../../api';

import { S, T, fmtAgo } from '../../theme';
import { Icon, Skeleton, SkeletonGroup, Txt } from '../../ui';
import { RU, U } from './kit';
import { Action, tone, watchable } from './alertKit';
import AlertDay from './AlertDay';
import {
  RANGES, buildSections, fmtClock, initials, kindOf, rangeAt,
} from '../alertGroups';

const SCOPES = [['incoming', 'From family'], ['mine', 'Mine']];

/**
 * ALERTS — one card per person per day, and the way into the day itself.
 *
 * The list used to be flat: every trigger the system had ever written, newest
 * first, one card each. That is the correct *record* and the wrong *screen*.
 * Five low-battery notes and a check-in push the one thing that matters off
 * the fold, and a week of ordinary days looks exactly like the day something
 * happened.
 *
 * So it is folded twice. By day, because "Today" is the only timeframe anybody
 * opens this screen for; and inside the day by person, because the question is
 * never "what events occurred" — it is "is Amma alright". One card per person
 * per day, their name set large enough to find without reading.
 *
 * The detail is a page (AlertDay), not a drop-down. A card that unfolds into a
 * timeline pushes every other card down the screen and loses the name it is
 * about at the first flick; opening a page keeps the list exactly where it was
 * and gives the day the whole screen.
 *
 * Two guarantees the folding does not get to break:
 *
 *   1. A live emergency is never folded away. It survives the date filter and
 *      sorts to the top of its day.
 *   2. If there is something to answer, its button is on the card — not one
 *      navigation away. Summarising is allowed to cost a tap; responding is not.
 */
export default function UserAlerts({ session, refreshKey, onResolve }) {
  const [scope, setScope] = useState('incoming');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(null);
  const [acked, setAcked] = useState(() => new Set());
  const [err, setErr] = useState(null);
  // How far back the list reaches. Index into RANGES: today, a week, the lot.
  const [rangeI, setRangeI] = useState(0);
  // The open day page, held as a key rather than as the group object: the
  // socket reloads this list under the page, and a page rendering the snapshot
  // it was opened with would keep saying "still live" after a stand-down.
  const [dayKey, setDayKey] = useState(null);
  const [, force] = useState(0);

  const load = useCallback(async () => {
    try {
      setRows(await call(session, `/alerts?scope=${scope}`));
      setErr(null);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [session, scope]);

  useEffect(() => { setLoading(true); load(); }, [load, refreshKey]);

  // Switching scope is switching question. Nothing about the last answer --
  // how far back it reached, whose day was open -- applies to the new one.
  useEffect(() => { setRangeI(0); setDayKey(null); }, [scope]);

  // Every row on this screen is a relative time. Without a tick they freeze at
  // whatever they said when the list was built, which on a live alert is the
  // one number somebody is actually watching.
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

  const standDown = async (a) => {
    setBusy(a.id);
    try {
      await onResolve?.(a.id);
      await load();
    } finally {
      setBusy(null);
    }
  };

  const handleOptin = async (a, action) => {
    setBusy(`samaritan-${a.id}`);
    try {
      await optinSamaritan(session, a.id, action);
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  const range = rangeAt(rangeI);
  const { sections, hidden, shown, liveCount, needsCount } = useMemo(
    () => buildSections(rows, {
      rangeDays: range.days, scope, myId: session?.user_id, localAcked: acked,
    }),
    // `acked` is in the deps on purpose: answering an alert is what moves a
    // group out of "waiting for you", and that has to show without a reload.
    [rows, range.days, scope, session?.user_id, acked],
  );

  // The open day, re-found in the freshly built sections on every render, so
  // the page redraws from the same data the list does. Holding the group
  // object instead would leave the page saying "still live" after a stand-down
  // it was watching.
  const day = useMemo(() => {
    if (!dayKey) return null;
    for (const sec of sections) for (const g of sec.data) if (g.key === dayKey) return g;
    return null;
  }, [sections, dayKey]);

  // What the page keeps showing while it slides shut. Without it the content
  // is gone a frame before the animation is, which reads as a flicker.
  const lastDay = useRef(null);
  if (day) lastDay.current = day;

  return (
    <>
      <SectionList
        style={s.root}
        contentContainerStyle={s.content}
        sections={sections}
        keyExtractor={(g) => g.key}
        stickySectionHeadersEnabled
        ItemSeparatorComponent={() => <View style={{ height: S.md }} />}
        refreshControl={(
          <RefreshControl
            refreshing={refreshing}
            tintColor={U.mint}
            onRefresh={() => { setRefreshing(true); load(); }}
          />
        )}
        ListHeaderComponent={(
          <View style={s.header}>
            <View style={{ gap: 3 }}>
              <Txt variant="h1" color={U.text}>Alerts</Txt>
              <Summary loading={loading} range={range} shown={shown}
                       live={liveCount} needs={needsCount} scope={scope} />
            </View>

            <View style={s.segment}>
              {SCOPES.map(([k, label]) => {
                const on = scope === k;
                return (
                  <Pressable
                    key={k}
                    onPress={() => setScope(k)}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: on }}
                    style={[s.segBtn, on && { backgroundColor: U.raised }]}
                  >
                    <Text style={[T.button, { fontSize: 14, color: on ? U.text : U.faint }]}>
                      {label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {err ? (
              <View style={s.errBox}>
                <Icon name="alert-circle" size={14} color={U.red} />
                <Text style={[T.meta, { color: U.dim, flex: 1 }]}>{err}</Text>
              </View>
            ) : null}
          </View>
        )}
        renderSectionHeader={({ section }) => (
          <View style={s.dayHeadWrap}>
            <Text style={s.dayHead}>{section.title.toUpperCase()}</Text>
          </View>
        )}
        renderItem={({ item }) => (
          <GroupCard
            group={item}
            scope={scope}
            busy={busy}
            onOpen={() => setDayKey(item.key)}
            onAck={ack}
            onStandDown={standDown}
          />
        )}
        ListEmptyComponent={loading ? (
          <SkeletonGroup label="Loading alerts">
            <GroupCardSkeleton />
            <GroupCardSkeleton />
          </SkeletonGroup>
        ) : (
          <Empty scope={scope} hidden={hidden} />
        )}
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

      {/* One person, one day, in full. It carries the live map itself. */}
      <AlertDay
        visible={!!day}
        group={day || lastDay.current}
        scope={scope}
        session={session}
        busy={busy}
        onClose={() => setDayKey(null)}
        onAck={ack}
        onStandDown={standDown}
        onSamaritan={handleOptin}
      />
    </>
  );
}

// ------------------------------------------------------------ header ---
/**
 * One line under the title saying what is on screen and what is wrong.
 *
 * It exists because the fold hides counts: "Today · 6 events" is the thing the
 * flat list used to say by simply being long. When something is live it stops
 * being a count and becomes a sentence, in red, because that is the only fact
 * on this screen that cannot wait for somebody to scroll.
 */
function Summary({ loading, range, shown, live, needs, scope }) {
  if (loading) return <Text style={[T.meta, { color: U.faint }]}>Loading…</Text>;

  if (live > 0) {
    return (
      <Text style={[T.bodyMed, { color: U.red }]}>
        {live === 1 ? '1 emergency still live' : `${live} emergencies still live`}
      </Text>
    );
  }
  if (needs > 0) {
    return (
      <Text style={[T.bodyMed, { color: U.amber }]}>
        {needs === 1 ? '1 alert waiting for you' : `${needs} alerts waiting for you`}
      </Text>
    );
  }
  return (
    <Text style={[T.meta, { color: U.faint }]}>
      {range.label}
      {shown > 0 ? ` · ${shown} event${shown === 1 ? '' : 's'}` : ''}
      {shown > 0 ? (scope === 'mine' ? ' · all clear' : ' · nothing outstanding') : ''}
    </Text>
  );
}

// -------------------------------------------------------- group card ---
/**
 * A person, a day, and the state of it.
 *
 * Four facts and at most one button. The facts are who, how bad, what kinds,
 * and how long ago; the button is whatever is still outstanding, and it is
 * here rather than on the day page because a tap is an acceptable price for
 * *reading* an emergency and not for *answering* one.
 *
 * Everything else — the timeline, the map, the note somebody typed — is one
 * press away on the page. The whole card is that press.
 */
function GroupCard({ group, scope, busy, onOpen, onAck, onStandDown }) {
  const live = group.live.length > 0;
  const needs = group.needs.length > 0;
  const mine = scope === 'mine';
  const n = group.items.length;

  // Status rides on the avatar, not on a rule down the edge of the card. A
  // 3pt bar is the admin console's vocabulary, where corners are 8px and it
  // reads as an instrument marking; against this shell's 24px radius it is a
  // clipped sliver, and it breaks the one thing kit.js asks of this palette --
  // that nothing on screen is coloured unless it is saying something. The
  // avatar is already the thing the card is about, so it carries the state.
  const mark = live
    ? { backgroundColor: U.red, color: U.bg }
    : needs
      ? { backgroundColor: U.amberSoft, color: U.amber }
      : { backgroundColor: U.raised, color: U.dim };

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
          ? `${kindOf(group.needs[0]).title} · needs your answer`
          : `${group.needs.length} waiting for your answer`)
      : n === 1
        ? kindOf(group.items[0]).title
        : `${n} events`;

  // The one button, and the one row it belongs to. Ending your own emergency
  // outranks answering somebody else's; both outrank looking at a map, which
  // is not an answer and stays on the page.
  const standTarget = mine && live ? group.live[0] : null;
  const ackTarget = !mine && needs ? group.needs[0] : null;

  return (
    <View style={[s.card, live && { backgroundColor: U.redSoft }]}>
      <Pressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={`${group.name}, ${headline}, ${group.dayLabel}`}
        accessibilityHint={`Opens all ${n} event${n === 1 ? '' : 's'}`}
        style={({ pressed }) => [s.groupHead, pressed && { opacity: 0.7 }]}
      >
        <View style={[s.avatar, { backgroundColor: mark.backgroundColor }]}>
          <Text style={[s.avatarTxt, { color: mark.color }]}>{initials(group.name)}</Text>
        </View>

        <View style={{ flex: 1, gap: 3 }}>
          <Text style={s.name} numberOfLines={1}>{group.name}</Text>
          <Text
            style={[live || needs ? T.bodyMed : T.meta,
                    { color: live ? U.red : needs ? U.amber : U.dim }]}
            numberOfLines={1}
          >
            {headline}
          </Text>
        </View>

        <View style={s.headRight}>
          <Text style={s.when}>{when}</Text>
          <Icon name="chevron-right" size={18} color={U.faint} />
        </View>
      </Pressable>

      <View style={s.kindRow}>
        {group.kinds.slice(0, 4).map((k) => (
          <View key={k.kind} style={s.kindChip}>
            <Icon name={k.icon} size={11} color={tone(k.severity)} />
            <Text style={[T.label, { color: tone(k.severity) }]}>
              {k.short.toUpperCase()}{k.n > 1 ? ` ×${k.n}` : ''}
            </Text>
          </View>
        ))}
        {group.kinds.length > 4 ? (
          <View style={s.kindChip}>
            <Text style={[T.label, { color: U.faint }]}>+{group.kinds.length - 4}</Text>
          </View>
        ) : null}
      </View>

      {standTarget || ackTarget ? (
        <View style={s.cardAction}>
          {standTarget ? (
            <Action
              filled tint={U.mint} icon="shield" label="I am safe — stand down"
              busyLabel="Standing down…"
              busy={busy === standTarget.id}
              onPress={() => onStandDown(standTarget)}
            />
          ) : (
            <Action
              filled tint={tone(ackTarget.severity)} icon="user-check"
              label="I've seen this — I'm on it" busyLabel="Telling them…"
              sub={watchable(ackTarget) ? 'Their live map is inside' : null}
              busy={busy === ackTarget.id}
              onPress={() => onAck(ackTarget)}
            />
          )}
        </View>
      ) : null}
    </View>
  );
}

// ------------------------------------------------------------ footer ---
/**
 * History, on request.
 *
 * The default view is today, so this is how last week is reached. It says how
 * much is behind it rather than just "more", because "12 earlier events" is
 * the answer to the question somebody is actually asking when they look at the
 * bottom of a safety log.
 */
function Footer({ hidden, next, canReset, onMore, onReset }) {
  if (!hidden && !canReset) return null;
  return (
    <View style={{ gap: S.sm, marginTop: S.lg }}>
      {hidden > 0 && next ? (
        <Pressable onPress={onMore} accessibilityRole="button"
                   accessibilityLabel={`${next}, ${hidden} earlier events`}
                   style={({ pressed }) => [s.more, pressed && { opacity: 0.7 }]}>
          <Icon name="chevron-down" size={16} color={U.dim} />
          <View>
            <Text style={[T.button, { color: U.dim }]}>{next}</Text>
            <Text style={[T.meta, { color: U.faint }]}>
              {hidden} earlier {hidden === 1 ? 'event' : 'events'}
            </Text>
          </View>
        </Pressable>
      ) : null}
      {canReset ? (
        <Pressable onPress={onReset} accessibilityRole="button"
                   style={({ pressed }) => [s.reset, pressed && { opacity: 0.6 }]}>
          <Text style={[T.meta, { color: U.faint }]}>Back to today</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * What the screen says when the fold, not the world, is why it is empty.
 *
 * "Nothing from your family" is a good answer and a dangerous one to give
 * wrongly. If there are older events sitting behind the date filter this says
 * so, because a person who reads "nothing" and stops looking has been misled
 * by a default they never chose.
 */
function Empty({ scope, hidden }) {
  if (hidden > 0) {
    return (
      <View style={s.empty}>
        <Icon name="calendar" size={22} color={U.faint} />
        <Txt variant="h2" color={U.text}>Nothing today</Txt>
        <Text style={[T.meta, { color: U.dim, textAlign: 'center' }]}>
          {hidden} earlier {hidden === 1 ? 'event is' : 'events are'} kept below.
        </Text>
      </View>
    );
  }
  return (
    <View style={s.empty}>
      <Icon name={scope === 'incoming' ? 'shield' : 'activity'} size={22} color={U.faint} />
      <Txt variant="h2" color={U.text}>
        {scope === 'incoming' ? 'Nothing from your family' : 'You have not raised anything'}
      </Txt>
      <Text style={[T.meta, { color: U.dim, textAlign: 'center' }]}>
        {scope === 'incoming'
          ? 'That is the good outcome. Anything they raise lands here.'
          : 'Your own alerts, check-ins and near misses are kept here.'}
      </Text>
    </View>
  );
}

/**
 * A group card before its group arrives.
 *
 * Two of these rather than a spinner, because the question this screen answers
 * is "how many, and how bad" -- and a spinner in the middle of an empty screen
 * is indistinguishable from the answer being none.
 */
function GroupCardSkeleton() {
  return (
    <View style={s.card}>
      <View style={s.groupHead}>
        <Skeleton width={44} height={44} radius={RU.pill} color={U.raised} />
        <View style={{ flex: 1, gap: 7 }}>
          <Skeleton width={150} height={22} color={U.raised} />
          <Skeleton width={96} height={12} color={U.raised} />
        </View>
        <Skeleton width={44} height={12} color={U.raised} />
      </View>
      <View style={s.kindRow}>
        <Skeleton width={84} height={24} radius={RU.pill} color={U.raised} />
        <Skeleton width={66} height={24} radius={RU.pill} color={U.raised} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: U.bg },
  content: { padding: S.lg, paddingBottom: S.xxl },

  header: { gap: S.md, marginBottom: S.sm },
  segment: {
    flexDirection: 'row', backgroundColor: U.card,
    borderRadius: RU.pill, padding: 4,
  },
  segBtn: {
    flex: 1, minHeight: 42, alignItems: 'center', justifyContent: 'center',
    borderRadius: RU.pill,
  },
  errBox: {
    flexDirection: 'row', alignItems: 'center', gap: S.sm,
    backgroundColor: U.redSoft, borderRadius: RU.card, padding: S.md,
  },

  // The day heading. Sticky, on the ground colour rather than on a card, so it
  // reads as a divider in the scroll rather than as another thing to press.
  dayHeadWrap: { backgroundColor: U.bg, paddingTop: S.md, paddingBottom: S.sm },
  dayHead: { ...T.label, color: U.faint, letterSpacing: 1.4 },

  card: { backgroundColor: U.card, borderRadius: RU.card, overflow: 'hidden' },

  groupHead: {
    flexDirection: 'row', alignItems: 'center', gap: S.md,
    padding: S.lg, paddingBottom: S.md, minHeight: 80,
  },
  avatar: {
    width: 44, height: 44, borderRadius: RU.pill, backgroundColor: U.raised,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarTxt: { ...T.title, color: U.dim, letterSpacing: 0.3 },

  // The one piece of type on this screen that is meant to be read across a
  // room: the name of the person the card is about.
  name: { ...T.h1, color: U.text },
  headRight: { alignItems: 'flex-end', gap: 8 },
  when: { ...T.meta, color: U.faint, fontSize: 12, fontVariant: ['tabular-nums'] },

  kindRow: {
    flexDirection: 'row', flexWrap: 'wrap', gap: S.sm,
    paddingHorizontal: S.lg, paddingBottom: S.lg,
  },
  kindChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: U.raised, borderRadius: RU.pill,
    paddingHorizontal: S.md, paddingVertical: 6,
  },
  cardAction: { paddingHorizontal: S.lg, paddingBottom: S.lg },

  more: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: S.sm,
    minHeight: 52, borderRadius: RU.inner, backgroundColor: U.card,
    paddingHorizontal: S.lg,
  },
  reset: { minHeight: 40, alignItems: 'center', justifyContent: 'center' },

  empty: {
    alignItems: 'center', gap: S.sm,
    paddingVertical: S.xxl, paddingHorizontal: S.lg,
  },
});
