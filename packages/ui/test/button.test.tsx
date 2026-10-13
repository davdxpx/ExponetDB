// Derived from supabase/supabase packages/ui/src/components/Button/Button.test.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { describe, expect, it, vi } from 'vitest'

import { Button, buttonVariants } from '../src/button.tsx'
import { axeViolations } from './support/axe.ts'

const SIZES = {
  tiny: 'h-[26px]',
  small: 'h-[34px]',
  medium: 'h-[38px]',
  large: 'h-[42px]',
} as const
const VARIANTS = {
  primary: 'bg-primary-solid',
  default: 'raised-control-surface',
  secondary: 'bg-foreground',
  outline: 'border-strong',
  dashed: 'border-dashed',
  link: 'text-primary',
  text: 'hover:bg-accent',
  danger: 'bg-destructive',
  warning: 'bg-warning',
} as const

describe('#Button', () => {
  it('should render button correctly', () => {
    const wrapper = render(<Button>Button</Button>)

    expect(wrapper.getByText('Button')).toBeInTheDocument()
    expect(() => wrapper.unmount()).not.toThrow()
  })

  it('should default to the neutral default variant', () => {
    render(<Button>Neutral</Button>)

    const button = screen.getByRole('button', { name: 'Neutral' })
    expect(button.className).toContain('control-surface-shadows')
    expect(button.className).toContain('raised-control-surface')
    expect(button.className).toContain('border-0')
    expect(button.className).not.toContain('bg-primary-solid')
  })

  it('should apply tiny size classes when buttonVariants omits size', () => {
    const className = buttonVariants({ variant: 'default' })
    expect(className).toContain('h-[26px]')
    expect(className).toContain('px-2.5')
  })

  it('should allow an explicit primary variant override', () => {
    render(<Button variant="primary">Primary</Button>)

    const button = screen.getByRole('button', { name: 'Primary' })
    expect(button.className).toContain('bg-primary-solid')
  })

  it('should render different text', () => {
    const wrapper = render(<Button>Button</Button>)

    expect(screen.getByText('Button')).toBeInTheDocument()

    wrapper.rerender(<Button>按钮</Button>)

    expect(screen.getByText('按钮')).toBeInTheDocument()
  })

  it('should use native disabled when loading by default', () => {
    render(<Button loading>Button</Button>)

    const button = screen.getByRole('button')
    expect(button).toBeDisabled()
    expect(button).not.toHaveAttribute('aria-disabled', 'true')
  })

  it('should remain focusable and ignore events when disabled with focusableWhenDisabled', () => {
    const WrapperButton = () => {
      const [state, setState] = React.useState('state1')
      return (
        <Button disabled focusableWhenDisabled onClick={() => setState('state2')}>
          {state}
        </Button>
      )
    }

    render(<WrapperButton />)
    const button = screen.getByRole('button', { name: 'state1' })

    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).not.toBeDisabled()
    expect(button).toHaveAttribute('tabIndex', '0')

    fireEvent.click(button)

    expect(screen.getByText('state1')).toBeInTheDocument()
    expect(screen.queryByText('state2')).not.toBeInTheDocument()
  })

  it('should ignore child onClick when focusably disabled with asChild', () => {
    const childOnClick = vi.fn()
    const buttonOnClick = vi.fn()

    render(
      <Button asChild disabled focusableWhenDisabled onClick={buttonOnClick}>
        <a href="/foo" onClick={childOnClick}>
          Open targets
        </a>
      </Button>,
    )

    fireEvent.click(screen.getByRole('link'))

    expect(childOnClick).not.toHaveBeenCalled()
    expect(buttonOnClick).not.toHaveBeenCalled()
  })

  it('should not call Button onClick when asChild child calls preventDefault', () => {
    const childOnClick = vi.fn((e: React.MouseEvent) => e.preventDefault())
    const buttonOnClick = vi.fn()

    render(
      <Button asChild onClick={buttonOnClick}>
        <a href="/foo" onClick={childOnClick}>
          Open targets
        </a>
      </Button>,
    )

    fireEvent.click(screen.getByRole('link'))

    expect(childOnClick).toHaveBeenCalled()
    expect(buttonOnClick).not.toHaveBeenCalled()
  })

  it('should ignore events when disabled', () => {
    const WrapperButton = () => {
      const [state, setState] = React.useState('state1')
      return (
        <Button disabled onClick={() => setState('state2')}>
          {state}
        </Button>
      )
    }

    render(<WrapperButton />)
    expect(screen.getByText('state1')).toBeInTheDocument()

    fireEvent.click(screen.getByText('state1'))

    expect(screen.getByText('state1')).toBeInTheDocument()
    expect(screen.queryByText('state2')).not.toBeInTheDocument()
  })

  it('should ignore events when loading', () => {
    const WrapperButton = () => {
      const [state, setState] = React.useState('state1')
      return (
        <Button loading onClick={() => setState('state2')}>
          {state}
        </Button>
      )
    }
    render(<WrapperButton />)
    fireEvent.click(screen.getByText('state1'))
    expect(screen.queryByText('state2')).not.toBeInTheDocument()
  })

  it('should have "w-full" class when block is true', async () => {
    render(<Button block>Button Block</Button>)
    expect(screen.queryByRole('button')).toHaveClass('w-full')
  })

  it('should hide decorative icons from assistive technology', () => {
    render(<Button icon={<svg data-testid="button-icon" />}>Save</Button>)

    expect(screen.getByTestId('button-icon').parentElement).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
  })

  it('should forward ref', () => {
    const ref: React.MutableRefObject<HTMLButtonElement | null> = {
      current: null,
    }

    render(<Button ref={ref}>Button</Button>)

    expect(ref.current).toBeInstanceOf(HTMLButtonElement)
  })

  describe('variants and sizes', () => {
    for (const [variant, marker] of Object.entries(VARIANTS)) {
      it(`renders the ${variant} variant as a named button without accessibility violations`, async () => {
        render(<Button variant={variant as keyof typeof VARIANTS}>Create plan</Button>)

        const button = screen.getByRole('button', { name: 'Create plan' })
        expect(button.className).toContain(marker)
        expect(button).toHaveAttribute('type', 'button')
        expect(await axeViolations()).toEqual([])
      })
    }

    for (const [size, marker] of Object.entries(SIZES)) {
      it(`renders the ${size} size`, () => {
        render(<Button size={size as keyof typeof SIZES}>Apply</Button>)

        const button = screen.getByRole('button', { name: 'Apply' })
        expect(button).toHaveClass(marker)
        expect(button).toHaveAttribute('data-size', size)
      })
    }

    it('makes an icon-only button square at the height of its size', async () => {
      render(
        <>
          <Button aria-label="Copy" icon={<svg data-testid="a" />} />
          <Button aria-label="Copy large" size="large" icon={<svg data-testid="b" />} />
        </>,
      )

      expect(screen.getByRole('button', { name: 'Copy' })).toHaveClass(
        'w-[26px]',
        'h-[26px]',
        'px-0',
      )
      expect(screen.getByRole('button', { name: 'Copy large' })).toHaveClass('w-[42px]', 'h-[42px]')
      expect(await axeViolations()).toEqual([])
    })

    it('shows icons before and after the label and hides them from assistive technology', () => {
      render(
        <Button icon={<svg data-testid="left" />} iconRight={<svg data-testid="right" />}>
          Save
        </Button>,
      )

      expect(screen.getByTestId('left').parentElement).toHaveAttribute('aria-hidden', 'true')
      expect(screen.getByTestId('right').parentElement).toHaveAttribute('aria-hidden', 'true')
      expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
    })

    it('applies the block and rounded options', () => {
      render(
        <Button block rounded>
          Wide
        </Button>,
      )

      expect(screen.getByRole('button', { name: 'Wide' })).toHaveClass('w-full', 'rounded-full')
    })

    it('lets a className override a utility of the variant', () => {
      render(<Button className="px-8">Roomy</Button>)

      const button = screen.getByRole('button', { name: 'Roomy' })
      expect(button).toHaveClass('px-8')
      expect(button).not.toHaveClass('px-2.5')
    })
  })

  describe('type', () => {
    it('defaults to type="button" so it never submits a form by accident', async () => {
      const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault())
      render(
        <form onSubmit={onSubmit}>
          <Button>Inside a form</Button>
        </form>,
      )

      await userEvent.click(screen.getByRole('button', { name: 'Inside a form' }))
      expect(onSubmit).not.toHaveBeenCalled()
    })

    it('submits a form when it is type="submit"', async () => {
      const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault())
      render(
        <form onSubmit={onSubmit}>
          <Button type="submit">Create plan</Button>
        </form>,
      )

      await userEvent.click(screen.getByRole('button', { name: 'Create plan' }))
      expect(onSubmit).toHaveBeenCalledTimes(1)
    })

    it('puts no type on an asChild link', () => {
      render(
        <Button asChild>
          <a href="/targets">Targets</a>
        </Button>,
      )

      expect(screen.getByRole('link', { name: 'Targets' })).not.toHaveAttribute('type')
    })
  })

  describe('disabled', () => {
    it('uses native disabled, leaves the tab order and ignores a click', async () => {
      const onClick = vi.fn()
      render(
        <Button disabled onClick={onClick}>
          Apply
        </Button>,
      )

      const button = screen.getByRole('button', { name: 'Apply' })
      expect(button).toBeDisabled()
      expect(button).not.toHaveAttribute('aria-disabled')
      expect(button).toHaveAttribute('tabindex', '-1')
      expect(button).toHaveClass('opacity-50', 'cursor-not-allowed', 'pointer-events-none')

      await userEvent.tab()
      expect(button).not.toHaveFocus()
      await userEvent.click(button)
      expect(onClick).not.toHaveBeenCalled()
      expect(await axeViolations()).toEqual([])
    })
  })

  describe('focusableWhenDisabled', () => {
    it('stays focusable with aria-disabled instead of disabled', async () => {
      render(
        <Button disabled focusableWhenDisabled>
          Apply to production
        </Button>,
      )

      const button = screen.getByRole('button', { name: 'Apply to production' })
      expect(button).not.toBeDisabled()
      expect(button).toHaveAttribute('aria-disabled', 'true')
      expect(button).toHaveAttribute('tabindex', '0')
      expect(button).toHaveClass('opacity-50', 'cursor-not-allowed')
      expect(button).not.toHaveClass('pointer-events-none')

      await userEvent.tab()
      expect(button).toHaveFocus()
      expect(await axeViolations()).toEqual([])
    })

    it('swallows a click', async () => {
      const onClick = vi.fn()
      render(
        <Button disabled focusableWhenDisabled onClick={onClick}>
          Apply
        </Button>,
      )

      await userEvent.click(screen.getByRole('button', { name: 'Apply' }))
      expect(onClick).not.toHaveBeenCalled()
    })

    it('swallows keyboard activation with Enter and Space', async () => {
      const onClick = vi.fn()
      const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault())
      render(
        <form onSubmit={onSubmit}>
          <Button type="submit" disabled focusableWhenDisabled onClick={onClick}>
            Apply
          </Button>
        </form>,
      )

      await userEvent.tab()
      expect(screen.getByRole('button', { name: 'Apply' })).toHaveFocus()
      await userEvent.keyboard('{Enter}')
      await userEvent.keyboard(' ')

      expect(onClick).not.toHaveBeenCalled()
      expect(onSubmit).not.toHaveBeenCalled()
    })

    it('does nothing without disabled', async () => {
      const onClick = vi.fn()
      render(
        <Button focusableWhenDisabled onClick={onClick}>
          Apply
        </Button>,
      )

      const button = screen.getByRole('button', { name: 'Apply' })
      expect(button).not.toHaveAttribute('aria-disabled')
      await userEvent.click(button)
      expect(onClick).toHaveBeenCalledTimes(1)
    })

    it('still passes other key presses to onKeyDown', async () => {
      const onKeyDown = vi.fn()
      render(
        <Button disabled focusableWhenDisabled onKeyDown={onKeyDown}>
          Apply
        </Button>,
      )

      await userEvent.tab()
      await userEvent.keyboard('{ArrowDown}')
      expect(onKeyDown).toHaveBeenCalledTimes(1)
    })
  })

  describe('loading', () => {
    it('shows a spinner, sets aria-busy, disables the button and keeps the label', async () => {
      render(<Button loading>Applying</Button>)

      const button = screen.getByRole('button', { name: 'Applying' })
      expect(button).toBeDisabled()
      expect(button).toHaveAttribute('aria-busy', 'true')
      const spinner = button.querySelector('svg')
      expect(spinner).not.toBeNull()
      expect(spinner?.parentElement).toHaveAttribute('aria-hidden', 'true')
      expect(spinner).toHaveClass('animate-spin')
      expect(await axeViolations()).toEqual([])
    })

    it('replaces the left icon and hides the right icon while loading', () => {
      render(
        <Button loading icon={<svg data-testid="left" />} iconRight={<svg data-testid="right" />}>
          Applying
        </Button>,
      )

      expect(screen.queryByTestId('left')).not.toBeInTheDocument()
      expect(screen.queryByTestId('right')).not.toBeInTheDocument()
    })

    it('does not set aria-busy when it is not loading', () => {
      render(<Button>Apply</Button>)

      expect(screen.getByRole('button', { name: 'Apply' })).not.toHaveAttribute('aria-busy')
    })

    it('stays focusable and keeps its focus while loading with focusableWhenDisabled', async () => {
      const onClick = vi.fn()
      render(
        <Button loading focusableWhenDisabled onClick={onClick}>
          Applying
        </Button>,
      )

      const button = screen.getByRole('button', { name: 'Applying' })
      expect(button).toHaveAttribute('aria-busy', 'true')
      expect(button).toHaveAttribute('aria-disabled', 'true')
      expect(button).not.toBeDisabled()

      await userEvent.tab()
      expect(button).toHaveFocus()
      await userEvent.click(button)
      expect(onClick).not.toHaveBeenCalled()
    })
  })

  describe('asChild', () => {
    it('renders the child element with the button classes and keeps its link semantics', async () => {
      render(
        <Button asChild variant="link">
          <a href="/targets">Targets</a>
        </Button>,
      )

      const link = screen.getByRole('link', { name: 'Targets' })
      expect(link).toHaveAttribute('href', '/targets')
      expect(link).toHaveClass('text-primary', 'focus-ring')
      expect(screen.queryByRole('button')).not.toBeInTheDocument()
      expect(await axeViolations()).toEqual([])
    })

    it('calls the child onClick and then the Button onClick', async () => {
      const calls: string[] = []
      render(
        <Button asChild onClick={() => calls.push('button')}>
          <a
            href="/targets"
            onClick={(event) => {
              event.preventDefault()
              calls.push('child')
            }}
          >
            Targets
          </a>
        </Button>,
      )

      await userEvent.click(screen.getByRole('link'))
      // A child that prevents the default action keeps the Button handler from running.
      expect(calls).toEqual(['child'])
    })

    it('marks a disabled child aria-disabled, takes it out of the tab order and ignores a click', async () => {
      const onClick = vi.fn()
      render(
        <Button asChild disabled onClick={onClick}>
          <a href="/targets">Targets</a>
        </Button>,
      )

      const link = screen.getByRole('link', { name: 'Targets' })
      expect(link).toHaveAttribute('aria-disabled', 'true')
      expect(link).not.toHaveAttribute('disabled')
      expect(link).toHaveAttribute('tabindex', '-1')
      await userEvent.click(link)
      expect(onClick).not.toHaveBeenCalled()
    })

    it('keeps a focusably disabled child in the tab order', async () => {
      render(
        <Button asChild disabled focusableWhenDisabled>
          <a href="/targets">Targets</a>
        </Button>,
      )

      await userEvent.tab()
      expect(screen.getByRole('link', { name: 'Targets' })).toHaveFocus()
      expect(screen.getByRole('link', { name: 'Targets' })).toHaveAttribute('aria-disabled', 'true')
    })

    it('adds the icons around the label of the child', () => {
      render(
        <Button asChild icon={<svg data-testid="left" />} iconRight={<svg data-testid="right" />}>
          <a href="/targets">Targets</a>
        </Button>,
      )

      const link = screen.getByRole('link', { name: 'Targets' })
      expect(link).toContainElement(screen.getByTestId('left'))
      expect(link).toContainElement(screen.getByTestId('right'))
    })
  })
})
