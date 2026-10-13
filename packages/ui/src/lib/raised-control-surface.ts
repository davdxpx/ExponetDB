// Derived from supabase/supabase packages/ui/src/lib/raised-control-surface.ts @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
export const controlRadiusBySize = {
  tiny: 'rounded-md',
  small: 'rounded-[calc(var(--radius-md)*(1+(34/26-1)*0.35))]',
  medium: 'rounded-[calc(var(--radius-md)*(1+(38/26-1)*0.35))]',
  large: 'rounded-[calc(var(--radius-md)*(1+(42/26-1)*0.35))]',
  xlarge: 'rounded-[calc(var(--radius-md)*(1+(50/26-1)*0.35))]',
}
