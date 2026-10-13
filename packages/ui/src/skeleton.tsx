// Derived from supabase/supabase packages/ui/src/components/shadcn/ui/skeleton.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { cn } from './lib/utils.ts'

/** A placeholder block while content loads. Hidden from assistive technology: the loading region announces itself. */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn('animate-pulse motion-reduce:animate-none rounded-md bg-muted', className)}
      {...props}
    />
  )
}

export { Skeleton }
