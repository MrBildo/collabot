import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let _systemPrompt: string | undefined;
let _toolDocs: string | undefined;

/**
 * Load and cache the harness system prompt (harness/prompts/system.md).
 * Common rules injected into every agent dispatch.
 */
export function loadSystemPrompt(): string {
  if (_systemPrompt === undefined) {
    const promptPath = fileURLToPath(new URL('../prompts/system.md', import.meta.url));
    _systemPrompt = readFileSync(promptPath, 'utf8');
  }
  return _systemPrompt;
}

/**
 * Load and cache MCP tool documentation (harness/prompts/tools.md).
 * Conditionally injected for roles with the 'agent-draft' permission.
 */
export function loadToolDocs(): string {
  if (_toolDocs === undefined) {
    const toolsPath = fileURLToPath(new URL('../prompts/tools.md', import.meta.url));
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
