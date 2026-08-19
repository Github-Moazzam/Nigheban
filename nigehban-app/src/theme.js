// One dark palette, tuned for a phone held up in a bright demo room:
// high contrast text, and severity carried by hue so a glance is enough.
export const C = {
  bg:      '#0B1310',
  surface: '#17231E',
  raised:  '#1E2D26',
  line:    '#2A3A33',
  text:    '#E8EDE8',
  dim:     '#8CA096',
  faint:   '#5F7069',
  green:   '#63BE93',
  greenBg: '#16301F',
  amber:   '#D9A65A',
  amberBg: '#33260F',
  alarm:   '#E8705F',
  alarmBg: '#3A1712',
};

export const MONO = { android: 'monospace', ios: 'Menlo', default: 'monospace' };

// Severity drives colour everywhere: 5 sos/snatch, 4 fall, 3 missed, 1 battery.
export function sevColor(sev) {
  if (sev >= 4) return C.alarm;
  if (sev >= 2) return C.amber;
  return C.green;
}

export function fmtAgo(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function fmtCount(s) {
  if (s == null) return '—';
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${String(r).padStart(2, '0')}s` : `${r}s`;
}
