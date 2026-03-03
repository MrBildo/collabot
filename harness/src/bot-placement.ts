import { logger } from './logger.js';
import type { Config } from './config.js';
import type { BotDefinition, RoleDefinition } from './types.js';
import type { VirtualProjectSkill, VirtualProjectMeta } from './comms.js';
import type { Project } from './project.js';

export type BotPlacement = {
  botName: string;
  project: string;
  roleName: string;
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
      ...(meta?.disallowedTools ? { disallowedTools: meta.disallowedTools } : {}),
      ...(meta?.skills ? { skills: meta.skills } : {}),
    };

    placements.set(botName, placement);
    logger.info({ botName, project: projectName, role: roleName }, 'bot placed');
  }

  return placements;
}
