/**
 * Task rotation — closes open tasks and creates a new daily task
 * for each virtual project with cron-enabled bots.
 *
 * Migrated from the hardcoded handler in index.ts.
 * This is a pure harness-level operation — no agent dispatch needed.
 */
export default async function (ctx: any) {
  // This handler needs access to harness internals (projects, tasks).
  // It will be wired up by the startup sequence, not invoked generically.
  // For now, this is a template placeholder. The actual logic is in index.ts
  // until the full migration is complete.
  ctx.log.info('task-rotation: stub handler — actual logic in index.ts startup');
}
