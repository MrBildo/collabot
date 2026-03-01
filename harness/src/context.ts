import fs from 'node:fs';
import path from 'node:path';
import { getDispatchStore } from './dispatch-store.js';
import type { DispatchEnvelope } from './types.js';

/**
 * Build a context prompt from task history.
 * Used when drafting a follow-up agent on an existing task.
 *
 * Returns a markdown section that can be prepended to the agent's prompt.
 * Includes the original request and results from all prior dispatches
 * that produced a structured result.
 */
export function buildTaskContext(taskDir: string): string {
  // Read task-level metadata (name, description) from task.json
  const manifestPath = path.join(taskDir, 'task.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
    name: string;
    description?: string;
  };

  const lines: string[] = [];
  lines.push('## Task History');
  lines.push('');
  lines.push('### Original Request');
  lines.push(manifest.description ?? manifest.name);
  lines.push('');

  // Read dispatch envelopes from the dispatch store
  const store = getDispatchStore();
  const envelopes = store.getDispatchEnvelopes(taskDir);

  // Filter to dispatches with structured results, ordered by startedAt
  const withResults = envelopes
    .filter((d: DispatchEnvelope) => d.structuredResult != null)
    .sort((a: DispatchEnvelope, b: DispatchEnvelope) => a.startedAt.localeCompare(b.startedAt));

  if (withResults.length > 0) {
    lines.push('### Previous Work');
    lines.push('');

    for (const d of withResults) {
      const result = d.structuredResult!;
      lines.push(`**${d.role}** (${d.status})`);
      lines.push(`Summary: ${result.summary}`);

      if (result.changes && result.changes.length > 0) {
        lines.push('Changes:');
        for (const change of result.changes) {
          lines.push(`- ${change}`);
        }
      }

      if (result.issues && result.issues.length > 0) {
        lines.push('Issues:');
        for (const issue of result.issues) {
          lines.push(`- ${issue}`);
        }
      }

      if (result.questions && result.questions.length > 0) {
        lines.push('Questions:');
        for (const q of result.questions) {
          lines.push(`- ${q}`);
        }
      }

      lines.push('');
    }
  }

  return lines.join('\n');
}
