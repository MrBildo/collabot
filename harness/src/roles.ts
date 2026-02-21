import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import type { RoleDefinition } from './types.js';

const RoleFrontmatterSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  category: z.string(),
  model: z.string().optional(),
  cwd: z.string().optional(),
});

export function parseFrontmatter(content: string, filename: string): { frontmatter: unknown; body: string } {
  // Must start with ---
  if (!content.startsWith('---')) {
    throw new Error(`${filename}: missing YAML frontmatter (file must start with ---)`);
  }

  const afterOpen = content.slice(3); // strip leading ---
  const closeIdx = afterOpen.indexOf('\n---');
  if (closeIdx === -1) {
    throw new Error(`${filename}: frontmatter closing --- not found`);
  }

  const frontmatterRaw = afterOpen.slice(0, closeIdx);
  const body = afterOpen.slice(closeIdx + 4); // skip \n---

  return {
    frontmatter: yaml.load(frontmatterRaw),
    body: body.startsWith('\n') ? body.slice(1) : body,
  };
}

export function loadRoles(rolesDir: string): Map<string, RoleDefinition> {
  let files: string[];
  try {
    files = readdirSync(rolesDir).filter((f) => f.endsWith('.md'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read roles directory (${rolesDir}): ${msg}`);
  }

  if (files.length === 0) {
    throw new Error(`Roles directory is empty or contains no .md files: ${rolesDir}`);
  }

  const roles = new Map<string, RoleDefinition>();

  for (const file of files) {
    const filePath = join(rolesDir, file);
    const content = readFileSync(filePath, 'utf8');

    const { frontmatter, body } = parseFrontmatter(content, file);

    const result = RoleFrontmatterSchema.safeParse(frontmatter);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n');
      throw new Error(`${file}: invalid frontmatter:\n${issues}`);
    }

    const { name, displayName, category, model, cwd } = result.data;
    roles.set(name, { name, displayName, category, model, cwd, prompt: body });
  }

  return roles;
}
