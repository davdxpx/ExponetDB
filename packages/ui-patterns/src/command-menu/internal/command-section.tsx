// Derived from supabase/supabase packages/ui-patterns/src/CommandMenu/internal/CommandSection.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import type { ICommandSection } from './types.ts'

const toSectionId = (str: string) => str.toLowerCase().replace(/\s+/g, '-')

const section$new = (
  name: string,
  { forceMount = false, id }: { forceMount?: boolean; id?: string } = {},
): ICommandSection => ({
  id: id ?? toSectionId(name),
  name,
  forceMount,
  commands: [],
})

export { section$new }
