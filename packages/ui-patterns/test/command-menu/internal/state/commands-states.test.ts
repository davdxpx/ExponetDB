// Derived from supabase/supabase packages/ui-patterns/src/CommandMenu/internal/state/commandsStates.test.ts @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { section$new } from '../../../../src/command-menu/internal/command-section.tsx'
import {
  initCommandsState,
  orderSectionFirst,
} from '../../../../src/command-menu/internal/state/commands-state.ts'
import type {
  ICommand,
  ICommandSection,
  ICommandsState,
} from '../../../../src/command-menu/internal/types.ts'

const command = (id: string, name: string): ICommand => ({ id, name, action: () => {} })
const isCommand = (entry: ICommand | undefined): entry is ICommand => entry !== undefined
const sectionWith = (name: string, commands: readonly ICommand[]): ICommandSection => ({
  ...section$new(name),
  commands,
})

describe('orderSectionFirst', () => {
  it('Orders newly created section first', () => {
    const first = section$new('First')
    const second = section$new('Second')
    const third = section$new('Third')
    const sections = [first, second, third]

    const expected = [third, first, second]
    const actual = orderSectionFirst(sections, 2)
    expect(actual).toEqual(expected)
  })

  it('Orders sole section first', () => {
    const only = section$new('Only')
    const sections = [only]

    const actual = orderSectionFirst(sections, 0)
    expect(actual).toEqual(sections)
  })

  it('Orders existing section first', () => {
    const first = section$new('First')
    const second = section$new('Second')
    const third = section$new('Third')
    const sections = [first, second, third]

    const expected = [second, first, third]
    const actual = orderSectionFirst(sections, 1)
    expect(actual).toEqual(expected)
  })

  it('Leaves the sections as they are for an index that does not exist', () => {
    const only = section$new('Only')
    expect(orderSectionFirst([only], 4)).toEqual([only])
  })
})

describe('commandState', () => {
  let commandsState: ICommandsState

  beforeEach(() => {
    commandsState = initCommandsState()
  })

  it('Starts without sections', () => {
    expect(commandsState.getState()).toEqual([])
  })

  it('Registers commands in new section', () => {
    const sectionName = 'Section'
    const commands = [command('first', 'First'), command('second', 'Second')]

    const expected = [sectionWith(sectionName, commands)]

    commandsState.registerSection(sectionName, commands)

    expect(commandsState.getState()).toEqual(expected)
  })

  it('Registers command in pre-existing section', () => {
    const existingCommands = [command('first', 'First'), command('second', 'Second')]
    const commandsToAdd = [command('third', 'Third')]

    commandsState.registerSection('A', existingCommands)
    commandsState.registerSection('B', [])

    const expected = [sectionWith('A', [...existingCommands, ...commandsToAdd]), section$new('B')]

    commandsState.registerSection('A', commandsToAdd)
    expect(commandsState.getState()).toEqual(expected)
  })

  it('Reorders sections if orderSection is given', () => {
    const commands = [command('first', 'First')]

    commandsState.registerSection('A', [])
    commandsState.registerSection('B', [])

    const expected = [sectionWith('B', commands), section$new('A')]

    commandsState.registerSection('B', commands, { orderSection: orderSectionFirst })
    expect(commandsState.getState()).toEqual(expected)
  })

  it('Reorders commands if orderCommands is given', () => {
    const sectionName = 'Section'
    const existingCommands = [command('first', 'First'), command('second', 'Second')]
    const commandsToAdd = [command('third', 'Third')]

    commandsState.registerSection(sectionName, existingCommands)

    const [first, second] = existingCommands
    const [third] = commandsToAdd
    const expected = [sectionWith(sectionName, [first, third, second].filter(isCommand))]

    commandsState.registerSection(sectionName, commandsToAdd, {
      orderCommands: (oldCommands, newCommands) => {
        const commands = [...oldCommands]
        commands.splice(1, 0, ...newCommands)
        return commands
      },
    })

    expect(commandsState.getState()).toEqual(expected)
  })

  it('Unregisters commands when returned function is called', () => {
    const sectionName = 'Section'
    const firstCommands = [command('command', 'Command')]
    const secondCommands = [command('second', 'Second')]

    const expected = [sectionWith(sectionName, [...firstCommands, ...secondCommands])]

    commandsState.registerSection(sectionName, firstCommands)
    const unregister = commandsState.registerSection(sectionName, secondCommands)

    expect(commandsState.getState()).toEqual(expected)

    const newExpected = [sectionWith(sectionName, firstCommands)]

    unregister()
    expect(commandsState.getState()).toHaveLength(1)
    expect(commandsState.getState()[0]?.commands).toHaveLength(1)
    expect(commandsState.getState()).toEqual(newExpected)
  })

  it('Unregisters entire section if no commands remain', () => {
    const sectionName = 'Section'
    const commands = [command('command', 'Command')]

    const expected = [sectionWith(sectionName, commands)]

    const unregister = commandsState.registerSection(sectionName, commands)

    expect(commandsState.getState()).toEqual(expected)

    const newExpected: ICommandSection[] = []

    unregister()
    expect(commandsState.getState()).toHaveLength(0)
    expect(commandsState.getState()).toEqual(newExpected)
  })

  it('Merges section meta objects and keeps a section force mounted', () => {
    commandsState.registerSection('Section', [], { sectionMeta: { a: 1 }, forceMountSection: true })
    commandsState.registerSection('Section', [], { sectionMeta: { b: 2 } })

    const [section] = commandsState.getState()
    expect(section?.meta).toEqual({ a: 1, b: 2 })
    expect(section?.forceMount).toBe(true)
  })

  it('Replaces the state instead of changing it, so a snapshot never changes under a reader', () => {
    const before = commandsState.getState()
    commandsState.registerSection('Section', [command('one', 'One')])
    const after = commandsState.getState()

    expect(before).toEqual([])
    expect(after).not.toBe(before)
    expect(commandsState.getState()).toBe(after)
  })

  it('Tells subscribers about a change and stops after they unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = commandsState.subscribe(listener)

    const unregister = commandsState.registerSection('Section', [command('one', 'One')])
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    unregister()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
