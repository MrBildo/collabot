import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { parseFrontmatter, EntityNameSchema } from './roles.js';
import type { BotDefinition } from './types.js';

export const BotFrontmatterSchema = z.object({
  id: z.string().length(26, 'ULID must be exactly 26 characters'),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'must be valid semver (e.g. 1.0.0)'),
  name: EntityNameSchema,
  description: z.string().min(1).max(1024),
  displayName: z.string().max(64).optional(),
});

/**
 * Load bot definitions from a directory of markdown files with YAML frontmatter.
 * Unlike roles, an empty (or missing) directory is not an error — bots are optional.
 */
export function loadBots(botsDir: string): Map<string, BotDefinition> {
  const bots = new Map<string, BotDefinition>();

  if (!existsSync(botsDir)) {
    return bots;
  }

  let files: string[];
  try {
    files = readdirSync(botsDir).filter((f) => f.endsWith('.md'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read bots directory (${botsDir}): ${msg}`);
  }

  if (files.length === 0) {
    return bots;
  }

  for (const file of files) {
    const filePath = join(botsDir, file);
    const content = readFileSync(filePath, 'utf8');

    const { frontmatter, body } = parseFrontmatter(content, file);

    const result = BotFrontmatterSchema.safeParse(frontmatter);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n');
      throw new Error(`${file}: invalid frontmatter:\n${issues}`);
    }

    const fm = result.data;
    bots.set(fm.name, {
      id: fm.id,
      name: fm.name,
      displayName: fm.displayName,
      description: fm.description,
      version: fm.version,
      soulPrompt: body,
    });
  }

  return bots;
}
