import { Platform } from 'react-native';

/**
 * The design system.
 *
 * One dark theme, built for a phone that may be held up in a bright hall or
 * pulled out of a pocket at night. Three rules the whole app obeys:
 *
 *   1. Surfaces are separated by *tone*, never by an outline. Borders are
 *      reserved for structural dividers and for the one card that is shouting.
 *   2. Nothing glows. Severity is carried by hue, weight and a solid fill --
 *      not by a halo, and never by colour alone (every state also has words).
 *   3. Corners stay tight. 8 for a card, 6 for a control, 4 for a chip.
 *      Anything rounder reads as a toy, and this is not one.
 */

// ------------------------------------------------------------- colour ---
// Neutral cool greys so that the three semantic hues are the only saturated
// things on screen. Contrast against `surface` is noted where it matters.
export const C = {
  bg:        '#0B0D0F',   // app background
  surface:   '#14181C',   // cards
  raised:    '#1C2126',   // a card inside a card, inputs, pressed states
  line:      '#242A31',   // hairline dividers
  lineSoft:  '#1A1F24',

  text:      '#F1F3F5',   // 15.3:1 on surface
  dim:       '#A6B0BA',   //  7.2:1 -- secondary copy
  faint:     '#717C86',   //  3.6:1 -- metadata only, never body text

  green:     '#3CC183',   //  6.4:1 -- safe, armed, connected
  greenSoft: '#10281D',
  amber:     '#E0A33F',   //  8.4:1 -- attention, degraded, waiting
  amberSoft: '#2A2011',
  red:       '#F2645A',   //  5.5:1 -- danger, live emergency
  redSoft:   '#2C1310',
  blue:      '#5A9BFF',   //  6.1:1 -- informational, Good Samaritan
  blueSoft:  '#101B2C',

  // Kept as aliases so nothing that still speaks the old vocabulary breaks.
  alarm:     '#F2645A',
  alarmBg:   '#2C1310',
  greenBg:   '#10281D',
  amberBg:   '#2A2011',

  scrim:     'rgba(0,0,0,0.66)',   // modal backdrop, 60%+ per the a11y pass
};

// --------------------------------------------------------- typography ---
// Space Grotesk carries the headings, numbers and anything that has to be read
// at a glance: it has a wide aperture and unmistakable figures, which is what
// a countdown needs. Outfit carries everything a person actually reads.
export const F = {
  display:  'SpaceGrotesk_700Bold',
  heading:  'SpaceGrotesk_600SemiBold',
  headingMd:'SpaceGrotesk_500Medium',
  body:     'Outfit_400Regular',
  bodyMed:  'Outfit_500Medium',
  bodyBold: 'Outfit_600SemiBold',
  mono:     Platform.select({ android: 'monospace', ios: 'Menlo', default: 'monospace' }),
};

/** Kept for the band console's wire log, which genuinely wants a monospace. */
export const MONO = { android: 'monospace', ios: 'Menlo', default: 'monospace' };

/** The type scale. Nothing in the app sets a raw fontSize outside this. */
export const T = {
  display:  { fontFamily: F.display,   fontSize: 40, lineHeight: 44, letterSpacing: -0.6 },
  h1:       { fontFamily: F.heading,   fontSize: 24, lineHeight: 30, letterSpacing: -0.2 },
  h2:       { fontFamily: F.heading,   fontSize: 18, lineHeight: 24, letterSpacing: -0.1 },
  title:    { fontFamily: F.headingMd, fontSize: 15, lineHeight: 21 },
  body:     { fontFamily: F.body,      fontSize: 15, lineHeight: 22 },
  bodyMed:  { fontFamily: F.bodyMed,   fontSize: 15, lineHeight: 22 },
  meta:     { fontFamily: F.body,      fontSize: 13, lineHeight: 19 },
  label:    { fontFamily: F.bodyMed,   fontSize: 11, lineHeight: 14, letterSpacing: 0.9 },
  button:   { fontFamily: F.bodyBold,  fontSize: 15, lineHeight: 20, letterSpacing: 0.2 },
  // Figures that change in place -- timers, percentages, coordinates.
  number:   { fontFamily: F.heading,   fontSize: 17, lineHeight: 22,
              fontVariant: ['tabular-nums'] },
};

// ------------------------------------------------------ space & shape ---
export const S = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
export const R = { chip: 4, control: 6, card: 8, sheet: 14 };
export const HIT = { top: 8, bottom: 8, left: 8, right: 8 };   // 44pt tap floor

// ------------------------------------------------------------ helpers ---
/** Severity drives colour everywhere: 5 sos/snatch, 4 fall, 3 missed, 1 battery. */
export function sevColor(sev) {
  if (sev >= 4) return C.red;
  if (sev >= 2) return C.amber;
  return C.green;
}

/** The matching low-saturation fill, so a tone never needs a border to read. */
export function toneSoft(tone) {
  if (tone === C.red || tone === C.alarm) return C.redSoft;
  if (tone === C.amber) return C.amberSoft;
  if (tone === C.green) return C.greenSoft;
  if (tone === C.blue) return C.blueSoft;
  return C.raised;
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
  return m > 0 ? `${m}:${String(r).padStart(2, '0')}` : `${r}s`;
}
