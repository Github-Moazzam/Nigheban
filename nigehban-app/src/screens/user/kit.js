import { StyleSheet } from 'react-native';
import { S, T } from '../../theme';

/**
 * THE USER-ROLE THEME.
 *
 * The admin console is an instrument panel: cool greys, 8px corners, a hue for
 * every state. This is the opposite brief. It is held by somebody who is
 * worried about a person they love, so it is quieter -- one accent, wide
 * corners, and no colour on screen that is not saying something.
 *
 * Charcoal ground, a single step up to the card, one step further for anything
 * nested inside it. Mint is the only saturated colour in the resting state;
 * amber and red exist solely so that "wrong" and "urgent" cannot be missed.
 *
 * Keeping the palette here rather than in theme.js is what stops it reaching
 * the admin screens, which are meant to look exactly as they did.
 */
export const U = {
  bg:        '#121212',   // charcoal ground
  card:      '#1C1C1C',   // the 24px card
  raised:    '#262626',   // a panel inside a card, inputs, pressed states
  line:      '#2E2E2E',   // hairline dividers

  text:      '#F5F5F5',   // 15.6:1 on card
  dim:       '#A3A3A3',   //  6.6:1 -- secondary copy
  faint:     '#737373',   //  3.6:1 -- metadata only, never body text

  // Mint Teal. Safe, connected, and every primary action. 9.2:1 on the card,
  // and 10.1:1 against `bg` used as the label colour on a filled mint button.
  mint:      '#2DD4BF',
  mintSoft:  '#10302B',

  amber:     '#FBBF24',   // 10.2:1 -- attention, degraded, waiting
  amberSoft: '#2E2411',
  red:       '#F87171',   //  6.2:1 -- danger, live emergency
  redSoft:   '#301616',
  redPress:  '#DC2626',   // the SOS circle held down -- deeper, never lighter

  scrim:     'rgba(0,0,0,0.7)',
};

/**
 * Shape. 24 for a card, 16 for anything nested in one, fully round for pills.
 * Wider than the admin scale on purpose: round reads as calm, and calm is the
 * entire product here.
 */
export const RU = { card: 24, inner: 16, pill: 999 };

/** Row of a settings list: icon tile, title, optional sub, right-hand value. */
export const rowStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingVertical: S.md },
  tile: {
    width: 38, height: 38, borderRadius: RU.inner, backgroundColor: U.raised,
    alignItems: 'center', justifyContent: 'center',
  },
  body: { flex: 1, gap: 2 },
  title: { ...T.bodyMed, color: U.text },
  sub: { ...T.meta, color: U.faint },
  line: { height: StyleSheet.hairlineWidth, backgroundColor: U.line },
});
