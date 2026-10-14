/** Messages of the pages that wait for Wave 9 (`src/features/wave9/`): a named state and what will come. */
export const wave9Messages = {
  'wave9.reason': 'Its data comes from a part of ExponetDB that arrives with Wave 9.',
  'wave9.comes.title': 'What will come',
  'wave9.performance.item1':
    'Statement statistics by digest: calls, total and mean time, rows and buffer hits.',
  'wave9.performance.item2': 'Regressions after a migration, linked to the migration.',
  'wave9.performance.item3': 'Table and index health, wraparound, I/O and checkpoints.',
  'wave9.advisors.item1': 'Findings from live advisors, each with its remediation.',
  'wave9.advisors.item2':
    'Draft fixes that become migrations through a plan, never a direct write.',
  'wave9.backups.item1': 'The backups that protect this target and the state of that protection.',
  'wave9.backups.item2': 'The point-in-time recovery window and the recovery point measured.',
  'wave9.backups.item3': 'Restore plans and restore drills with their evidence.',
  'wave9.global.title': 'Backups',
  'wave9.global.description': 'Backup protection across all clusters.',
  'wave9.global.item1':
    'Per cluster: the protection state, the recovery point measured against its objective, and the last verified backup.',
  'wave9.global.item2': 'The point-in-time recovery window of each cluster.',
  'wave9.global.item3': 'Restore drills and the evidence they leave.',
} as const
