// Derived from supabase/supabase packages/ui-patterns/src/FilterBar/OperatorSymbolBadge.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
export type OperatorSymbolBadgeProps = {
  symbol: string
}

export function OperatorSymbolBadge({ symbol }: OperatorSymbolBadgeProps) {
  return (
    <span className="ml-auto text-xs text-foreground-light bg-surface-200 rounded-sm px-1.5 py-0.5 font-mono">
      {symbol}
    </span>
  )
}
