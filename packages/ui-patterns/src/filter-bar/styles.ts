/**
 * A text field that sits flush inside the bar: no border, background or ring of its own (the bar
 * shows the focus ring around everything that has focus).
 */
export const BARE_INPUT_CLASS_NAME =
  'border-none bg-transparent text-xs shadow-none hover:border-transparent focus:border-transparent focus:shadow-none focus:outline-hidden focus:ring-0 focus-visible:border-transparent focus-visible:ring-0 focus-visible:ring-offset-0 md:text-xs'

/** Attributes that keep password managers and form fillers out of the bar's fields. */
export const NO_AUTOFILL = {
  autoComplete: 'off',
  'data-1p-ignore': true,
  'data-lpignore': 'true',
  'data-form-type': 'other',
} as const
