import { readFileSync } from 'node:fs';
import { getInstancePath } from './paths.js';
import type { VirtualProjectSkill } from './comms.js';

let _systemPrompt: string | undefined;
let _toolDocs: string | undefined;

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
 * Load and cache MCP tool documentation (prompts/tools.md).
 * Conditionally injected for roles with the 'agent-draft' permission.
 */
export function loadToolDocs(): string {
  if (_toolDocs === undefined) {
    const toolsPath = getInstancePath('prompts', 'tools.md');
    _toolDocs = readFileSync(toolsPath, 'utf8');
  }
  return _toolDocs;
}

/**
 * Assemble the full prompt for an agent: system prompt + role prompt + optional tool docs.
 */
export function assemblePrompt(rolePrompt: string, permissions?: string[]): string {
  const parts = [loadSystemPrompt(), rolePrompt];
  if (permissions?.includes('agent-draft')) {
    parts.push(loadToolDocs());
  }
  return parts.join('\n\n');
}

/**
 * Assemble the full prompt for a bot session: system prompt + role prompt + optional tool docs + project skills + soul prompt.
 * Skills are injected between role prompt and soul prompt.
 * The soul prompt defines the bot's personality and is appended last (highest context priority).
 */
export function assembleBotPrompt(soulPrompt: string, rolePrompt: string, permissions?: string[], projectSkills?: VirtualProjectSkill[]): string {
  const parts = [loadSystemPrompt(), rolePrompt];
  if (permissions?.includes('agent-draft')) {
    parts.push(loadToolDocs());
  }
  if (projectSkills && projectSkills.length > 0) {
    for (const skill of projectSkills) {
      parts.push(`## Skill: ${skill.name}\n\n${skill.content}`);
    }
  }
  parts.push('\n## Bot Identity\n\n' + soulPrompt);
  return parts.join('\n\n');
}
