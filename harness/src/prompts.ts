import { readFileSync } from 'node:fs';
import { getInstancePath } from './paths.js';

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
