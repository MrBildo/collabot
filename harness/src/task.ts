import fs from 'node:fs';
import path from 'node:path';

export type TaskContext = {
  slug: string;
  taskDir: string;      // absolute path to .projects/{project}/tasks/{slug}/
  created: string;       // ISO timestamp
};

export type DispatchRecordResult = {
  summary: string;
  changes?: string[];
  issues?: string[];
  questions?: string[];
};

export type DispatchRecord = {
  role: string;
  cwd: string;
  model: string;
  startedAt: string;
  completedAt: string;
  status: string;
  journalFile: string;
  result?: DispatchRecordResult;
};

export type TaskManifest = {
  slug: string;
  name: string;
  project: string;
  description?: string;
  status: 'open' | 'closed';
  created: string;
  threadTs?: string;     // optional — only set when created from a thread
  dispatches: DispatchRecord[];
};

// Common words to strip from slug generation
const STRIP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'it', 'its', 'this', 'that',
  'and', 'or', 'but', 'not', 'so', 'if', 'then', 'please', 'just',
]);

/**
 * Generate a short slug from a task name.
 * Extracts first 3-5 meaningful words, slugifies, appends MMDD-HHmm timestamp.
 */
export function generateSlug(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STRIP_WORDS.has(w));

  const meaningful = words.slice(0, 5);
  if (meaningful.length === 0) {
    meaningful.push('task');
  }

  const base = meaningful.join('-').slice(0, 30);

  const now = new Date();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const timestamp = `${mo}${d}-${h}${m}`;

  return `${base}-${timestamp}`;
}

/**
 * Create a new task in the given tasks directory.
 */
export function createTask(tasksDir: string, opts: {
  name: string;
  project: string;
  description?: string;
  threadId?: string;
}): TaskContext {
  const slug = generateSlug(opts.name);
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
 * Records a dispatch in the task manifest.
 */
export function recordDispatch(taskDir: string, dispatch: DispatchRecord): void {
  const manifestPath = path.join(taskDir, 'task.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as TaskManifest;
  manifest.dispatches.push(dispatch);
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

// --- Legacy compatibility ---

/**
 * @deprecated Use createTask/findTaskByThread instead. Retained for backward compatibility during migration.
 */
export function getOrCreateTask(threadTs: string, firstMessage: string, tasksDir: string): TaskContext & { threadTs: string } {
  // Search existing
  const existing = findTaskByThread(tasksDir, threadTs);
  if (existing) {
    return { ...existing, threadTs };
  }

  // Create new
  const result = createTask(tasksDir, {
    name: firstMessage,
    project: 'legacy',
    threadId: threadTs,
    description: firstMessage,
  });
  return { ...result, threadTs };
}
