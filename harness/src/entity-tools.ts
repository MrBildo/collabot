import fs from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';
import { parseFrontmatter, RoleFrontmatterSchema } from './roles.js';

export type EntityType = 'role';

export type ScaffoldResult = {
  content: string;
  id: string;
  filePath: string;
};

export type ValidationResult = {
  valid: boolean;
  errors?: string[];
};

export type LinkValidationResult = {
  valid: boolean;
  broken?: string[];
};

function formatRfc3339(): string {
  return new Date().toISOString();
}

function formatHumanDate(isoDate: string): string {
  const d = new Date(isoDate);
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const year = d.getUTCFullYear();
  let hours = d.getUTCHours();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  const hh = String(hours).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${month}/${day}/${year} ${hh}:${mm}:${ss} ${ampm}`;
}

const ROLE_BODY_TEMPLATE = `You are a [ROLE DESCRIPTION]. You [WHAT YOU DO].

## How You Work

1. Read the task spec or prompt carefully
2. Check for relevant documentation in the project
3. Implement the changes
4. Run tests and verify your work
5. Report results with a summary of changes

## Practices

- Follow the project's existing code style and patterns
- If you get stuck or are unsure, report back rather than guessing
`;

export function scaffoldEntity(type: EntityType, name: string, author: string): ScaffoldResult {
  const id = ulid();
  const now = formatRfc3339();
  const humanDate = formatHumanDate(now);

  let frontmatter: string;
  let body: string;
  let filePath: string;

  switch (type) {
    case 'role': {
      frontmatter = [
        '---',
        `id: ${id}`,
        `version: 1.0.0`,
        `name: ${name}`,
        `description: TODO — describe what this role does.`,
        `createdOn: "${now}"  # ${humanDate}`,
        `createdBy: ${author}`,
        `model-hint: sonnet-latest`,
        '---',
      ].join('\n');
      body = ROLE_BODY_TEMPLATE;
      filePath = `${name}.md`;
      break;
    }
    default:
      throw new Error(`Unknown entity type: ${type}`);
  }

  return {
    content: frontmatter + '\n' + body,
    id,
    filePath,
  };
}

export function validateEntityFrontmatter(content: string, type: EntityType): ValidationResult {
  let frontmatter: unknown;
  try {
    ({ frontmatter } = parseFrontmatter(content, '<validate>'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { valid: false, errors: [msg] };
  }

  let schema;
  switch (type) {
    case 'role':
      schema = RoleFrontmatterSchema;
      break;
    default:
      return { valid: false, errors: [`Unknown entity type: ${type}`] };
  }

  const result = schema.safeParse(frontmatter);
  if (!result.success) {
    const errors = result.error.issues.map(
      (i) => `${i.path.join('.')}: ${i.message}`,
    );
    return { valid: false, errors };
  }

  return { valid: true };
}

const MARKDOWN_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

export function validateLinks(content: string, basePath: string): LinkValidationResult {
  const broken: string[] = [];

  for (const match of content.matchAll(MARKDOWN_LINK_RE)) {
    const target = match[2];
    if (!target) continue;

    // Skip URLs, anchors, and protocol links
    if (target.startsWith('http://') || target.startsWith('https://') || target.startsWith('#') || target.includes('://')) {
      continue;
    }

    // Strip anchor fragment from path
    const pathOnly = target.split('#')[0];
    if (!pathOnly) continue;

    const resolved = path.resolve(basePath, pathOnly);
    if (!fs.existsSync(resolved)) {
      broken.push(target);
    }
  }

  if (broken.length > 0) {
    return { valid: false, broken };
  }

  return { valid: true };
}
