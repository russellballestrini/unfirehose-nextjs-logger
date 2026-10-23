import { EmptyState } from '@unturf/unfirehose-ui/EmptyState';

/**
 * The tokens page's in-panel empties. The page as a whole shows one
 * EmptyState when its range is empty; these are for a range that has tokens
 * and a panel that still has nothing — no cost, no tool calls — which is a
 * fact about the work in range, not a missing install, so both are `quiet`.
 */

export function NoCostEmpty() {
  return (
    <EmptyState
      compact
      kind="quiet"
      what="No priced tokens in range."
      action="Cost appears for models our price book knows; see Price Book above. Self-hosted and test models read as power, not price."
    />
  );
}

export function NoToolsEmpty() {
  return (
    <EmptyState
      compact
      kind="quiet"
      what="No tool calls in range."
      action="Tool calls appear when a session runs tools: Bash, Read, Edit and the rest."
    />
  );
}
