/**
 * The look every recharts axis and tooltip in this app already had.
 *
 * Six tooltips and thirteen axes carried the same literal object. One of
 * them drifting is a chart that quietly stops matching the others, and
 * nothing in a diff says the other eighteen exist.
 */

export const AXIS_TICK = { fill: '#71717a', fontSize: 16 } as const;

/** The denser variant, for node charts that stack several to a row. */
export const AXIS_TICK_SM = { fill: '#71717a', fontSize: 12 } as const;

export const TOOLTIP_STYLE = {
  background: '#18181b',
  border: '1px solid #3f3f46',
  borderRadius: 4,
  color: '#fafafa',
  fontSize: 14,
} as const;
