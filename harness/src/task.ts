import fs from 'node:fs';
import path from 'node:path';

export type TaskContext = {
  slug: string;
  taskDir: string;      // absolute path to .agents/tasks/{slug}/
  threadTs: string;
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
  created: string;
  threadTs: string;
  description: string;
  dispatches: DispatchRecord[];
};

// Common words to strip from slug generation
const STRIP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'it', 'its', 'this', 'that',
  'and', 'or', 'but', 'not', 'so', 'if', 'then', 'please', 'just',
  // Routing prefixes (stripped because they're metadata, not content)
  'api', 'portal', 'frontend', 'ui', 'test', 'e2e', 'playwright',
  'backend', 'endpoint', 'app', 'mobile',
]);

/**
 * Generate a short slug from a message.
 * Extracts first 3-5 meaningful words, slugifies, appends MMDD-HHmm timestamp.
 */
export function generateSlug(message: string): string {
  const words = message
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
 * Finds an existing task for a thread, or creates a new one.
 */
export function getOrCreateTask(threadTs: string, firstMessage: string, tasksDir: string): TaskContext {
  // Search existing task.json files for matching threadTs
  if (fs.existsSync(tasksDir)) {
    const dirs = fs.readdirSync(tasksDir, { withFileTypes: true })
      .filter((d) => d.isDirectory());

    for (const dir of dirs) {
      const manifestPath = path.join(tasksDir, dir.name, 'task.json');
      if (fs.existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as TaskManifest;
          if (manifest.threadTs === threadTs) {
            return {
              slug: manifest.slug,
              taskDir: path.join(tasksDir, dir.name),
              threadTs: manifest.threadTs,
              created: manifest.created,
            };
          }
        } catch {
          // Corrupt manifest — skip
        }
      }
    }
  }

  // Create new task
  const slug = generateSlug(firstMessage);
  const taskDir = path.join(tasksDir, slug);
  fs.mkdirSync(taskDir, { recursive: true });

  const manifest: TaskManifest = {
    slug,
    created: new Date().toISOString(),
    threadTs,
    description: firstMessage,
    dispatches: [],
  };
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

  return {
    slug: manifest.slug,
    taskDir,
    threadTs: manifest.threadTs,
    created: manifest.created,
  };
}

/**
 * Records a dispatch in the task manifest.
 *
 * NOTE: This does a read-modify-write on task.json. Two concurrent dispatches
 * finishing at the same instant could race. In practice the window is tiny
 * (dispatches end seconds apart). If this becomes a real issue, add a file-lock
 * or sequential write queue.
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
