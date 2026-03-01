import fs from 'node:fs';
import path from 'node:path';
import type { DispatchIndexEntry } from './types.js';

export type TaskContext = {
  slug: string;
  taskDir: string;      // absolute path to .projects/{project}/tasks/{slug}/
  created: string;       // ISO timestamp
};

export type TaskManifest = {
  slug: string;
  name: string;
  project: string;
  description?: string;
  status: 'open' | 'closed';
  created: string;
  threadTs?: string;     // optional — only set when created from a thread
  dispatches: DispatchIndexEntry[];
};

// Common words to strip from slug generation
const STRIP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'it', 'its', 'this', 'that',
  'and', 'or', 'but', 'not', 'so', 'if', 'then', 'please', 'just',
]);

// Valid task slug: lowercase alphanumeric + hyphens, no leading/trailing/consecutive hyphens, max 64 chars.
const VALID_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export type SlugResult = {
  slug: string;
  modified: boolean;
};

/**
 * Generate a slug from a task name.
 * If the name is already a valid slug, it is returned as-is.
 * Otherwise the name is normalized (lowercased, stop-words stripped, truncated).
 */
export function generateSlug(name: string): SlugResult {
  // Sanitize: trim whitespace and leading/trailing hyphens
  const sanitized = name.trim().replace(/^-+|-+$/g, '').toLowerCase();

  // If the sanitized name is already a valid slug, use it directly
  if (sanitized.length >= 1 && sanitized.length <= 64 && VALID_SLUG_RE.test(sanitized)) {
    return { slug: sanitized, modified: false };
  }

  // Normalize: strip non-alphanumeric, remove stop words, join with hyphens
  const words = sanitized
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/[\s-]+/)
    .filter((w) => w.length > 0 && !STRIP_WORDS.has(w));

  const meaningful = words.slice(0, 5);
  if (meaningful.length === 0) {
    meaningful.push('task');
  }

  const slug = meaningful.join('-').slice(0, 64).replace(/-$/, '');
  return { slug, modified: slug !== sanitized };
}

/**
 * Find a unique slug in the tasks directory by appending -2, -3, etc. on collision.
 */
export function deduplicateSlug(tasksDir: string, base: string): { slug: string; deduplicated: boolean } {
  const candidate = path.join(tasksDir, base);
  if (!fs.existsSync(candidate)) {
    return { slug: base, deduplicated: false };
  }

  let n = 2;
  while (fs.existsSync(path.join(tasksDir, `${base}-${n}`))) {
    n++;
  }
  return { slug: `${base}-${n}`, deduplicated: true };
}

export type CreateTaskResult = TaskContext & {
  slugModified: boolean;
  originalName: string;
};

/**
 * Create a new task in the given tasks directory.
 */
export function createTask(tasksDir: string, opts: {
  name: string;
  project: string;
  description?: string;
  threadId?: string;
}): CreateTaskResult {
  const gen = generateSlug(opts.name);
  const { slug, deduplicated } = deduplicateSlug(tasksDir, gen.slug);
  const taskDir = path.join(tasksDir, slug);
  fs.mkdirSync(taskDir, { recursive: true });

  const manifest: TaskManifest = {
    slug,
    name: opts.name,
    project: opts.project,
    description: opts.description,
    status: 'open',
    created: new Date().toISOString(),
    threadTs: opts.threadId,
    dispatches: [],
  };
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

  return {
    slug: manifest.slug,
    taskDir,
    created: manifest.created,
    slugModified: gen.modified || deduplicated,
    originalName: opts.name,
  };
}

/**
 * Search for an existing task by thread ID.
 */
export function findTaskByThread(tasksDir: string, threadId: string): TaskContext | null {
  if (!fs.existsSync(tasksDir)) return null;

  const dirs = fs.readdirSync(tasksDir, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  for (const dir of dirs) {
    const manifestPath = path.join(tasksDir, dir.name, 'task.json');
    if (!fs.existsSync(manifestPath)) continue;

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as TaskManifest;
      if (manifest.threadTs === threadId) {
        return {
          slug: manifest.slug,
          taskDir: path.join(tasksDir, dir.name),
          created: manifest.created,
        };
      }
    } catch {
      // Corrupt manifest — skip
    }
  }

  return null;
}

/**
 * Look up a task by slug.
 */
export function getTask(tasksDir: string, slug: string): TaskContext {
  const taskDir = path.join(tasksDir, slug);
  const manifestPath = path.join(taskDir, 'task.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Task "${slug}" not found at ${taskDir}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as TaskManifest;
  return {
    slug: manifest.slug,
    taskDir,
    created: manifest.created,
  };
}

/**
 * List all tasks in a tasks directory.
 */
export function listTasks(tasksDir: string): Array<{ slug: string; name: string; status: string; created: string; description?: string; dispatchCount: number }> {
  if (!fs.existsSync(tasksDir)) return [];

  const entries = fs.readdirSync(tasksDir, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  const tasks: Array<{ slug: string; name: string; status: string; created: string; description?: string; dispatchCount: number }> = [];

  for (const entry of entries) {
    const manifestPath = path.join(tasksDir, entry.name, 'task.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as TaskManifest;
      tasks.push({
        slug: manifest.slug,
        name: manifest.name,
        status: manifest.status,
        created: manifest.created,
        description: manifest.description,
        dispatchCount: manifest.dispatches.length,
      });
    } catch {
      // Skip corrupt manifests
    }
  }

  return tasks;
}

/**
 * Close a task by setting status to 'closed'.
 */
export function closeTask(tasksDir: string, slug: string): void {
  const taskDir = path.join(tasksDir, slug);
  const manifestPath = path.join(taskDir, 'task.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Task "${slug}" not found at ${taskDir}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as TaskManifest;
  manifest.status = 'closed';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}

/**
 * Returns the next journal filename for a role within a task directory.
 * First dispatch: {role}.md. Subsequent: {role}-2.md, {role}-3.md, etc.
 */
export function nextJournalFile(taskDir: string, roleName: string): string {
  const base = `${roleName}.md`;
  if (!fs.existsSync(path.join(taskDir, base))) {
    return base;
  }

  let n = 2;
  while (fs.existsSync(path.join(taskDir, `${roleName}-${n}.md`))) {
    n++;
  }
  return `${roleName}-${n}.md`;
}

