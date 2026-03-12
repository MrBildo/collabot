import { logger } from './logger.js';
import type { Config } from './config.js';
import type { BotDefinition, RoleDefinition, BotStatus } from './types.js';
import type { VirtualProjectSkill, VirtualProjectMeta } from './comms.js';
import type { Project } from './project.js';

export type BotPlacement = {
  botName: string;
  project: string;
  roleName: string;
  status: BotStatus;
  draftedBy?: string;   // adapter name that owns the draft
  disallowedTools?: string[];
  skills?: VirtualProjectSkill[];
};

/**
 * Compute bot placements from config, bots, roles, projects, and virtual project metadata.
 * Pure function — no side effects, fully testable.
 *
 * For each loaded bot:
 * 1. Read config.bots[name].defaultProject (fallback: 'lobby')
 * 2. Read config.bots[name].defaultRole (fallback: config.slack?.defaultRole → config.routing.default)
 * 3. Validate project exists, role exists — warn and use fallbacks on failure
 * 4. Inherit disallowedTools and skills from virtual project meta
 */
export function placeBots(
  config: Config,
  bots: Map<string, BotDefinition>,
  roles: Map<string, RoleDefinition>,
  projects: Map<string, Project>,
  virtualProjectMeta: Map<string, VirtualProjectMeta>,
): Map<string, BotPlacement> {
  const placements = new Map<string, BotPlacement>();
  const defaultRole = config.slack?.defaultRole ?? config.routing.default;

  for (const [botName] of bots) {
    const botConfig = config.bots?.[botName];
    let projectName = botConfig?.defaultProject ?? 'lobby';
    let roleName = botConfig?.defaultRole ?? defaultRole;

    // Validate project exists
    if (!projects.has(projectName.toLowerCase())) {
      logger.warn({ botName, project: projectName }, 'bot placement: project not found, falling back to lobby');
      projectName = 'lobby';
    }

    // Validate role exists
    if (!roles.has(roleName)) {
      logger.warn({ botName, role: roleName, fallback: defaultRole }, 'bot placement: role not found, falling back to default');
      roleName = defaultRole;
      if (!roles.has(roleName)) {
        logger.warn({ botName, role: roleName }, 'bot placement: default role not found, skipping bot');
        continue;
      }
    }

    // Inherit meta from virtual project
    const meta = virtualProjectMeta.get(projectName.toLowerCase());

    const placement: BotPlacement = {
      botName,
      project: projectName,
      roleName,
      status: 'available',
      ...(meta?.disallowedTools ? { disallowedTools: meta.disallowedTools } : {}),
      ...(meta?.skills ? { skills: meta.skills } : {}),
    };

    placements.set(botName, placement);
  }

  return placements;
}

// ── BotPlacementStore ─────────────────────────────────────────

/**
 * Mutable wrapper around bot placements. Keeps the pure `placeBots()` function
 * for initial computation, adds runtime mutation (move, status changes).
 */
export class BotPlacementStore {
  private placements: Map<string, BotPlacement>;

  constructor(initial: Map<string, BotPlacement>) {
    this.placements = new Map(initial);
  }

  get(botName: string): BotPlacement | undefined {
    return this.placements.get(botName);
  }

  getAll(): Map<string, BotPlacement> {
    return new Map(this.placements);
  }

  /**
   * Move a bot to a new project. Operator override — works regardless of current status.
   * Returns the previous project name.
   */
  moveBot(botName: string, targetProject: string, opts?: { roleName?: string }): string {
    const placement = this.placements.get(botName);
    if (!placement) {
      throw new Error(`Bot "${botName}" not found in placements`);
    }

    const previousProject = placement.project;
    placement.project = targetProject;
    if (opts?.roleName) {
      placement.roleName = opts.roleName;
    }
    // Moving to lobby makes the bot available
    if (targetProject.toLowerCase() === 'lobby') {
      placement.status = 'available';
      placement.draftedBy = undefined;
    }

    logger.info({ botName, from: previousProject, to: targetProject }, 'bot moved');
    return previousProject;
  }

  /** Mark a bot as drafted by an adapter, updating project and role */
  setDrafted(botName: string, adapterName: string, opts?: { project?: string; roleName?: string }): void {
    const placement = this.placements.get(botName);
    if (placement) {
      placement.status = 'drafted';
      placement.draftedBy = adapterName;
      if (opts?.project) placement.project = opts.project;
      if (opts?.roleName) placement.roleName = opts.roleName;
    }
  }

  /** Mark a bot as busy (e.g., processing a Slack message) */
  setBusy(botName: string): void {
    const placement = this.placements.get(botName);
    if (placement) {
      placement.status = 'busy';
    }
  }

  /** Return a bot to available status */
  setAvailable(botName: string): void {
    const placement = this.placements.get(botName);
    if (placement) {
      placement.status = 'available';
      placement.draftedBy = undefined;
    }
  }

  /** Return a bot to lobby — clears project, role, draftedBy. Always returns to lobby. */
  setUndrafted(botName: string): void {
    const placement = this.placements.get(botName);
    if (placement) {
      placement.status = 'available';
      placement.project = 'lobby';
      placement.roleName = 'lobby';
      placement.draftedBy = undefined;
      placement.disallowedTools = undefined;
      placement.skills = undefined;
      logger.info({ botName }, 'bot undrafted — returned to lobby');
    }
  }
}
