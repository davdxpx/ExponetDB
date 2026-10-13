// Derived from supabase/supabase packages/ui/src/lib/constants.ts @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
/** Sizes of the form controls: Button, Input, Select and Combobox triggers share them. */
export type ControlSize = 'tiny' | 'small' | 'medium' | 'large'

export const SIZE = {
  text: {
    tiny: 'text-xs',
    small: 'text-base md:text-sm leading-4',
    medium: 'text-base md:text-sm',
    large: 'text-base',
    xlarge: 'text-base',
  },
  padding: {
    tiny: 'px-2.5 py-1',
    small: 'px-3 py-2',
    medium: 'px-4 py-2',
    large: 'px-4 py-2',
    xlarge: 'px-6 py-3',
  },
  height: {
    tiny: 'h-[26px]',
    small: 'h-[34px]',
    medium: 'h-[38px]',
    large: 'h-[42px]',
    xlarge: 'h-[50px]',
  },
  minHeight: {
    tiny: 'min-h-[26px]',
    small: 'min-h-[34px]',
    medium: 'min-h-[38px]',
    large: 'min-h-[42px]',
    xlarge: 'min-h-[50px]',
  },
}

// used for internal badges/buttons
// such as Button Group Items or Multi Select items
export const SIZE_INNER = {
  text: {
    tiny: 'text-xs',
    small: 'text-sm leading-4',
    medium: 'text-sm',
    large: 'text-base',
    xlarge: 'text-base',
  },
  padding: {
    tiny: 'px-2.5 py-1',
    small: 'px-3 py-2',
    medium: 'px-4 py-2',
    large: 'px-4 py-2',
    xlarge: 'px-6 py-3',
  },
  height: {
    tiny: 'h-[24px]',
    small: 'h-[28px]',
    medium: 'h-[32px]',
    large: 'h-[36px]',
    xlarge: 'h-[44px]',
  },
}

export const SIZE_VARIANTS: Record<ControlSize, string> = {
  tiny: `${SIZE.text.tiny} ${SIZE.padding.tiny} ${SIZE.height.tiny}`,
  small: `${SIZE.text.small} ${SIZE.padding.small} ${SIZE.height.small}`,
  medium: `${SIZE.text.medium} ${SIZE.padding.medium} ${SIZE.height.medium}`,
  large: `${SIZE.text.large} ${SIZE.padding.large} ${SIZE.height.large}`,
}

export const SIZE_VARIANTS_INNER: Record<ControlSize, string> = {
  tiny: `${SIZE.text.tiny} ${SIZE.padding.tiny} ${SIZE_INNER.height.tiny}`,
  small: `${SIZE.text.small} ${SIZE.padding.small} ${SIZE_INNER.height.small}`,
  medium: `${SIZE.text.medium} ${SIZE.padding.medium} ${SIZE_INNER.height.medium}`,
  large: `${SIZE.text.large} ${SIZE.padding.large} ${SIZE_INNER.height.large}`,
}

export const SIZE_VARIANTS_DEFAULT = 'small' satisfies ControlSize

export type PageSize = 'default' | 'small' | 'medium' | 'large' | 'full'

export const PAGE_SIZE_CLASSES = {
  small: 'max-w-3xl px-8',
  medium: 'max-w-5xl px-8',
  large: 'max-w-7xl px-8',
  default: 'max-w-5xl px-8',
  full: 'w-full',
} as const
