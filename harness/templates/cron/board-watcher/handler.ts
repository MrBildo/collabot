/**
 * Board watcher — checks Collaboard for new activity, dispatches agents
 * only for dirty boards. Clean boards = zero agent cost.
 *
 * The `ctx` parameter is a CronHandlerContext from cron-bridge.ts, injected
 * by the cron bridge at runtime. Handlers are loaded dynamically so we type
 * the parameter inline rather than importing from a path that won't resolve.
 */
export default async function (ctx: any) {
  const boards = ctx.config.job.boards as Array<{ slug: string; project: string }> | undefined;
  if (!boards || boards.length === 0) {
    ctx.log.warn('board-watcher: no boards configured in settings.toml');
    return;
  }

  const since = ctx.lastRunAt?.toISOString()
    ?? new Date(Date.now() - 86400000).toISOString();

  for (const board of boards) {
    const authKey = ctx.config.projectEnv(board.project).COLLABOARD_AUTH_KEY;
    if (!authKey) {
      ctx.log.warn({ board: board.slug, project: board.project }, 'no COLLABOARD_AUTH_KEY — skipping');
      continue;
    }

    const res = await fetch(
      `http://localhost:8080/api/v1/boards/${board.slug}/cards?since=${since}`,
      { headers: { 'X-User-Key': authKey }, signal: ctx.signal },
    );

    if (!res.ok) {
      ctx.log.error({ board: board.slug, status: res.status }, 'board API error');
      continue;
    }

    const cards = await res.json() as Array<{ number: number; laneName: string; name: string }>;

    if (cards.length === 0) {
      ctx.log.info({ board: board.slug }, 'clean — skipping');
      continue;
    }

    await ctx.dispatch({
      project: board.project,
      role: ctx.job.role ?? 'researcher',
      prompt: [
        `Board "${board.slug}" has ${cards.length} cards with new activity since ${since}.`,
        '',
        cards.map(c => `- #${c.number} (${c.laneName}): ${c.name}`).join('\n'),
        '',
        'Review each card and take appropriate action.',
      ].join('\n'),
    });
  }
}
