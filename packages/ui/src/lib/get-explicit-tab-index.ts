// Derived from supabase/supabase packages/ui/src/lib/utils/getExplicitTabIndex.ts @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
/**
 * Explicit tabIndex for keyboard focus (Safari skips buttons otherwise).
 * - Explicit `tabIndex` prop takes precedence
 * - If disabled, default to -1
 * - Otherwise, default to 0
 */
export function getExplicitTabIndex(
  tabIndex: number | undefined,
  disabled?: boolean | null,
): number {
  return tabIndex !== undefined ? tabIndex : disabled ? -1 : 0
}
