import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import type { RoleDefinition } from './types.js';

// Exported enums — used by config validation and entity tooling
export const ModelHintEnum = z.enum(['opus-latest', 'sonnet-latest', 'haiku-latest']);
export const PermissionsEnum = z.enum(['agent-draft', 'projects-list', 'projects-create']);

export const EntityNameSchema = z.string()
  .min(1).max(64)
  .regex(/^[a-z0-9](?:[a-z0-9]*-?[a-z0-9])*$/,
    'lowercase alphanumeric with hyphens, no start/end/consecutive hyphens');

export const RoleFrontmatterSchema = z.object({
  // Common entity fields
  id: z.string().length(26, 'ULID must be exactly 26 characters'),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'must be valid semver (e.g. 1.0.0)'),
  name: EntityNameSchema,
  description: z.string().min(1).max(1024),
  createdOn: z.string().datetime({ offset: true }),
  createdBy: z.string().min(1).max(32),
  updatedOn: z.string().datetime({ offset: true }).optional(),
  updatedBy: z.string().max(32).optional(),
  displayName: z.string().max(64).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  // Role-specific fields (kebab-case YAML)
  'model-hint': ModelHintEnum,
  permissions: z.array(PermissionsEnum).optional(),
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

    const fm = result.data;
    roles.set(fm.name, {
      id: fm.id,
      version: fm.version,
      name: fm.name,
      description: fm.description,
      createdOn: fm.createdOn,
      createdBy: fm.createdBy,
      updatedOn: fm.updatedOn,
      updatedBy: fm.updatedBy,
      displayName: fm.displayName,
      metadata: fm.metadata,
      modelHint: fm['model-hint'],   // kebab-case YAML → camelCase TS
      permissions: fm.permissions,
      prompt: body,
    });
  }

  return roles;
}
