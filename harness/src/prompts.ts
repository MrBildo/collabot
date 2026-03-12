import { readFileSync } from 'node:fs';
import { getInstancePath } from './paths.js';
import type { VirtualProjectSkill } from './comms.js';
import type { BotDefinition, RoleDefinition } from './types.js';

let _systemPrompt: string | undefined;

/**
 * Load and cache the harness system prompt (prompts/system.md).
 * Common rules injected into every agent dispatch.
 */
export function loadSystemPrompt(): string {
  if (_systemPrompt === undefined) {
    const promptPath = getInstancePath('prompts', 'system.md');
    _systemPrompt = readFileSync(promptPath, 'utf8');
  }
  return _systemPrompt;
}

/**
 * Assemble the full prompt for an agent: system prompt + role prompt.
 */
export function assemblePrompt(rolePrompt: string, _permissions?: string[]): string {
  const parts = [loadSystemPrompt(), rolePrompt];
  return parts.join('\n\n');
}

/** Metadata for assembleBotPrompt — accepts full entity objects for future-proofing. */
export type BotPromptContext = {
  bot: BotDefinition;
  role: RoleDefinition;
  project: string;
  projectSkills?: VirtualProjectSkill[];
};

/**
 * Assemble the full prompt for a bot session.
 *
 * Structure:
 *   <system prompt>
 *   <role prompt body>
 *   <project skills (if any)>
 *   ## Identity — derived from frontmatter metadata
 *   ## Personality — soul prompt body
 */
export function assembleBotPrompt(ctx: BotPromptContext): string {
  const { bot, role, project, projectSkills } = ctx;
  const parts = [loadSystemPrompt(), role.prompt];

  if (projectSkills && projectSkills.length > 0) {
    for (const skill of projectSkills) {
      parts.push(`## Skill: ${skill.name}\n\n${skill.content}`);
    }
  }

  const botDisplayName = bot.displayName ?? bot.name;
  const roleDisplayName = role.displayName ?? role.name;

  parts.push(
    `## Identity\n\nYou are **${botDisplayName}** (${roleDisplayName}).\nYou are currently working on project **${project}**.`,
  );

  parts.push(`## Personality\n\n${bot.soulPrompt}`);

  return parts.join('\n\n');
}
