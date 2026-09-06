/**
 * ALERT GROUPING — the arithmetic behind the alerts screens.
 *
 * Both alert lists (the user shell's and the admin console's) show the same
 * rows arranged the same way: newest day first, one card per person per day,
 * the day's events folded inside it. None of that arrangement is a matter of
 * palette, so it lives here and each screen draws it in its own colours.
 *
 * The one rule this file exists to protect: **folding is a display trick and
 * must never hide an emergency.** A live severity-4 alert is kept in the
 * visible set whatever date range is asked for, and the group carrying it
 * reports itself as live so the screen can open it without being asked.
 */

/** Every kind the server can write, said the way a person would say it. */
export const KIND = {
  sos:            { title: 'SOS',                    icon: 'alert-octagon', short: 'SOS' },
  snatch:         { title: 'Band torn off',          icon: 'alert-octagon', short: 'Torn off' },
  fall:           { title: 'Fall detected',          icon: 'trending-down',  short: 'Fall' },
  accident:       { title: 'Road accident',          icon: 'alert-triangle', short: 'Accident' },
  checkin_missed: { title: 'Missed check-in',        icon: 'clock',          short: 'Missed' },
  watch_lost:     { title: 'Went quiet while armed', icon: 'wifi-off',       short: 'Went quiet' },
  going_dark:     { title: 'Phone about to die',     icon: 'battery',        short: 'Going dark' },
  checkin_req:    { title: 'Check-in asked',         icon: 'help-circle',    short: 'Check-in' },
  checkin_ack:    { title: 'Checked in — fine',      icon: 'check-circle',   short: 'Checked in' },
  low_battery:    { title: 'Phone battery low',      icon: 'battery',        short: 'Battery' },
  band_battery:   { title: 'Band battery low',       icon: 'battery',        short: 'Band battery' },
  near_miss:      { title: 'Near miss — private',    icon: 'eye-off',        short: 'Near miss' },
};

export function kindOf(a) {
  return KIND[a.kind] || {
    title: String(a.kind || 'Alert').replace(/_/g, ' '),
    icon: 'circle',
    short: String(a.kind || 'Alert').replace(/_/g, ' '),
  };
}

/** Live means: bad enough that somebody must act, and nobody has stood it down. */
export function isLive(a) {
  return a.severity >= 4 && !a.resolved_at;
}

/** Did *this* account already answer? The server remembers; the session may not. */
export function ackedByMe(a, myId, localAcked) {
  if (localAcked && localAcked.has(a.id)) return true;
  return Array.isArray(a.acks) && a.acks.some((k) => String(k.id) === String(myId));
}

// ------------------------------------------------------------ time ---
const DAY_MS = 86400000;
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
               'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                    'August', 'September', 'October', 'November', 'December'];

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** `10:14` and `AM`, split so the gutter can stack them and stay narrow. */
export function fmtClock(ts) {
  if (!ts) return { time: '—', meridiem: '' };
  const d = new Date(ts * 1000);
  const h = d.getHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return {
    time: `${h12}:${String(d.getMinutes()).padStart(2, '0')}`,
    meridiem: h < 12 ? 'AM' : 'PM',
  };
}

/**
 * How a day is named at the top of a section.
 *
 * "Today" and "Yesterday" first, because that is how anybody scanning this
 * actually thinks; the weekday for the rest of the week, because "Tuesday" is
 * something a person remembers and "17 Mar" is not; the date once it is far
 * enough back that the weekday has stopped meaning anything.
 */
export function dayBucket(ts, nowMs = Date.now()) {
  const start = startOfDay(ts * 1000);
  const today = startOfDay(nowMs);
  const back = Math.round((today - start) / DAY_MS);
  const d = new Date(start);
  const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

  if (back <= 0) return { key, label: 'Today', start };
  if (back === 1) return { key, label: 'Yesterday', start };
  if (back < 7) return { key, label: WEEKDAY[d.getDay()], start };
  const sameYear = d.getFullYear() === new Date(nowMs).getFullYear();
  return {
    key,
    label: `${d.getDate()} ${MONTH[d.getMonth()]}${sameYear ? '' : ` ${d.getFullYear()}`}`,
    start,
  };
}

/**
 * The unambiguous version, for the one place there is room for it: the foot of
 * the day page. "Today" is what you navigate by; "Sunday, 6 September 2026" is
 * what you write down, and a safety log that can only say "Yesterday" is not a
 * record anybody can quote later.
 */
export function fmtFullDay(ts, nowMs = Date.now()) {
  const d = new Date(ts * 1000);
  const sameYear = d.getFullYear() === new Date(nowMs).getFullYear();
  return `${WEEKDAY[d.getDay()]}, ${d.getDate()} ${MONTH_FULL[d.getMonth()]}`
       + (sameYear ? '' : ` ${d.getFullYear()}`);
}

/** Two letters for the avatar. Falls back to a shape rather than to nothing. */
export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// -------------------------------------------------------- grouping ---
/**
 * The date windows the footer walks through. `days: 0` means everything.
 *
 * One day, then a week, then the lot: three presses is the whole history, and
 * the first screen anybody lands on is the one they came for.
 */
export const RANGES = [
  { days: 1, label: 'Today', next: 'Show the last 7 days' },
  { days: 7, label: 'Last 7 days', next: 'Show everything' },
  { days: 0, label: 'Everything', next: null },
];

export function rangeAt(i) {
  return RANGES[Math.min(Math.max(i, 0), RANGES.length - 1)];
}

/**
 * Fold a flat list of alerts into day sections of per-person groups.
 *
 * @param rows      what /alerts returned
 * @param rangeDays 1 = today, 7 = this week, 0 = everything
 * @param scope     'mine' collapses the person axis to "You"
 * @param myId      the signed-in account, for "have I already answered this"
 * @param localAcked a Set of ids acked in this session, not yet reloaded
 * @returns { sections, hidden, shown, liveCount, needsCount, groupCount }
 */
export function buildSections(rows, {
  rangeDays = 1, scope = 'incoming', myId, localAcked, now = Date.now(),
} = {}) {
  const sorted = [...(rows || [])].sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  const cutoff = rangeDays > 0
    ? (startOfDay(now) - (rangeDays - 1) * DAY_MS) / 1000
    : -Infinity;

  const visible = [];
  let hidden = 0;
  for (const a of sorted) {
    // A live emergency is never old enough to fold away.
    if (a.created_at >= cutoff || isLive(a)) visible.push(a);
    else hidden += 1;
  }

  const days = new Map();
  for (const a of visible) {
    const b = dayBucket(a.created_at, now);
    if (!days.has(b.key)) days.set(b.key, { key: b.key, title: b.label, start: b.start, groups: new Map() });
    const day = days.get(b.key);

    const who = scope === 'mine'
      ? { id: 'me', name: 'You' }
      : { id: String(a.user?.id ?? a.user?.name ?? '?'), name: a.user?.name || 'Family' };

    if (!day.groups.has(who.id)) {
      day.groups.set(who.id, {
        key: `${b.key}:${who.id}`, dayKey: b.key, dayLabel: b.label,
        userId: who.id, name: who.name, items: [],
      });
    }
    day.groups.get(who.id).items.push(a);
  }

  let liveCount = 0;
  let needsCount = 0;
  let groupCount = 0;

  const sections = [...days.values()]
    .sort((x, y) => y.start - x.start)
    .map((day) => {
      const data = [...day.groups.values()].map((g) => {
        const live = g.items.filter(isLive);
        // Answered once, by this account, from either the server's record or
        // this session's. Carried on the group so that neither screen has to
        // thread `myId` down to every row it draws.
        const ackedIds = new Set(
          g.items.filter((a) => ackedByMe(a, myId, localAcked)).map((a) => a.id));
        const needs = scope === 'mine'
          ? []
          : g.items.filter((a) => a.severity >= 3 && !a.resolved_at && !ackedIds.has(a.id));
        liveCount += live.length;
        needsCount += needs.length;
        groupCount += 1;

        // Distinct kinds, worst first, so the chip row reads as a summary of
        // the day rather than as the order things happened to arrive in.
        const seen = new Map();
        for (const a of g.items) {
          const k = seen.get(a.kind);
          if (k) { k.n += 1; k.severity = Math.max(k.severity, a.severity); }
          else seen.set(a.kind, { kind: a.kind, n: 1, severity: a.severity, ...kindOf(a) });
        }
        const kinds = [...seen.values()].sort((p, q) => q.severity - p.severity || q.n - p.n);

        return {
          ...g,
          kinds,
          live,
          needs,
          ackedIds,
          latest: g.items[0],
          peak: g.items.reduce((m, a) => Math.max(m, a.severity || 0), 0),
        };
      });

      // The person with something live is the person you are looking for.
      data.sort((p, q) => (q.live.length - p.live.length)
                       || (q.needs.length - p.needs.length)
                       || (q.peak - p.peak)
                       || (q.latest.created_at - p.latest.created_at));

      return { key: day.key, title: day.title, data };
    });

  return { sections, hidden, shown: visible.length, liveCount, needsCount, groupCount };
}

/**
 * Should this group be open before anybody touches it?
 *
 * Anything live or waiting on an answer, always. And a list with a single
 * group in it, because there is nothing to disclose progressively when there
 * is only one thing — the fold would be a tap charged for no information.
 */
export function autoOpen(group, groupCount) {
  return group.live.length > 0 || group.needs.length > 0 || groupCount === 1;
}
