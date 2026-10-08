/**
 * A maintenance task's failure with a reason the task loop records (a
 * short code, never a message: `task_failed` when it is not one).
 */
export class TaskFailure extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(reason)
    this.reason = /^[a-z][a-z0-9_]{0,63}$/.test(reason) ? reason : 'task_failed'
  }
}
