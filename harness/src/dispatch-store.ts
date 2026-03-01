import fs from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';
import type {
  CapturedEvent,
  DispatchEnvelope,
  DispatchFile,
  DispatchIndexEntry,
  EventType,
} from './types.js';
import type { PluginManifest } from './comms.js';

/**
 * Create a CapturedEvent with ULID id and RFC 3339 timestamp.
 */
export function makeCapturedEvent(type: EventType, data?: Record<string, unknown>): CapturedEvent {
  return {
    id: ulid(),
    type,
    timestamp: new Date().toISOString(),
    ...(data !== undefined ? { data } : {}),
  };
}

// ── DispatchStoreProvider interface ──────────────────────────────

export interface DispatchStoreProvider {
  readonly manifest: PluginManifest;

  // Dispatch lifecycle
  createDispatch(taskDir: string, envelope: DispatchEnvelope): void;
  updateDispatch(taskDir: string, dispatchId: string, updates: Partial<DispatchEnvelope>): void;

  // Event capture
  appendEvent(taskDir: string, dispatchId: string, event: CapturedEvent): void;

  // Envelope reads (quick — task manifest index)
  getDispatchEnvelopes(taskDir: string): DispatchEnvelope[];
  getDispatchEnvelope(taskDir: string, dispatchId: string): DispatchEnvelope | null;

  // Event reads (full stream)
  getDispatchEvents(taskDir: string, dispatchId: string): CapturedEvent[];
  getRecentEvents(taskDir: string, dispatchId: string, count: number): CapturedEvent[];
}

// ── JsonFileDispatchStore ───────────────────────────────────────

function dispatchesDir(taskDir: string): string {
  return path.join(taskDir, 'dispatches');
}

function dispatchFilePath(taskDir: string, dispatchId: string): string {
  return path.join(dispatchesDir(taskDir), `${dispatchId}.json`);
}

function taskManifestPath(taskDir: string): string {
  return path.join(taskDir, 'task.json');
}

function toIndexEntry(envelope: DispatchEnvelope): DispatchIndexEntry {
  return {
    dispatchId: envelope.dispatchId,
    role: envelope.role,
    status: envelope.status,
    cost: envelope.cost,
    startedAt: envelope.startedAt,
    parentDispatchId: envelope.parentDispatchId,
  };
}

function readDispatchFile(taskDir: string, dispatchId: string): DispatchFile | null {
  const filePath = dispatchFilePath(taskDir, dispatchId);
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content) as DispatchFile;
  } catch {
    return null;
  }
}

function writeDispatchFile(taskDir: string, file: DispatchFile): void {
  const dir = dispatchesDir(taskDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    dispatchFilePath(taskDir, file.dispatchId),
    JSON.stringify(file, null, 2) + '\n',
    'utf8',
  );
}

type TaskManifestRaw = {
  dispatches?: DispatchIndexEntry[];
  [key: string]: unknown;
};

function readTaskManifest(taskDir: string): TaskManifestRaw | null {
  const filePath = taskManifestPath(taskDir);
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content) as TaskManifestRaw;
  } catch {
    return null;
  }
}

function writeTaskManifest(taskDir: string, manifest: TaskManifestRaw): void {
  fs.writeFileSync(
    taskManifestPath(taskDir),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );
}

/**
 * Updates the dispatch index in task.json. Upserts the entry by dispatchId.
 */
function upsertDispatchIndex(taskDir: string, entry: DispatchIndexEntry): void {
  const manifest = readTaskManifest(taskDir);
  if (!manifest) return;

  if (!Array.isArray(manifest.dispatches)) {
    manifest.dispatches = [];
  }

  const idx = manifest.dispatches.findIndex((d) => d.dispatchId === entry.dispatchId);
  if (idx >= 0) {
    manifest.dispatches[idx] = entry;
  } else {
    manifest.dispatches.push(entry);
  }

  writeTaskManifest(taskDir, manifest);
}

export class JsonFileDispatchStore implements DispatchStoreProvider {
  readonly manifest: PluginManifest = {
    id: 'collabot.dispatch-store.json-file',
    name: 'JSON File Dispatch Store',
    version: '1.0.0',
    description: 'File-based dispatch store using JSON files in task directories.',
    providerType: 'dispatch-store',
  };

  createDispatch(taskDir: string, envelope: DispatchEnvelope): void {
    const file: DispatchFile = { ...envelope, events: [] };
    writeDispatchFile(taskDir, file);
    upsertDispatchIndex(taskDir, toIndexEntry(envelope));
  }

  updateDispatch(taskDir: string, dispatchId: string, updates: Partial<DispatchEnvelope>): void {
    const file = readDispatchFile(taskDir, dispatchId);
    if (!file) return;

    // Apply updates to the envelope fields (not events)
    const { events, ...envelope } = file;
    const updated: DispatchFile = { ...envelope, ...updates, dispatchId, events };
    writeDispatchFile(taskDir, updated);
    upsertDispatchIndex(taskDir, toIndexEntry(updated));
  }

  appendEvent(taskDir: string, dispatchId: string, event: CapturedEvent): void {
    const file = readDispatchFile(taskDir, dispatchId);
    if (!file) return;

    file.events.push(event);
    writeDispatchFile(taskDir, file);
  }

  getDispatchEnvelopes(taskDir: string): DispatchEnvelope[] {
    const dir = dispatchesDir(taskDir);
    if (!fs.existsSync(dir)) return [];

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const envelopes: DispatchEnvelope[] = [];

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(dir, file), 'utf8');
        const parsed = JSON.parse(content) as DispatchFile;
        const { events: _events, ...envelope } = parsed;
        envelopes.push(envelope);
      } catch {
        // Skip corrupt files
      }
    }

    return envelopes;
  }

  getDispatchEnvelope(taskDir: string, dispatchId: string): DispatchEnvelope | null {
    const file = readDispatchFile(taskDir, dispatchId);
    if (!file) return null;

    const { events: _events, ...envelope } = file;
    return envelope;
  }

  getDispatchEvents(taskDir: string, dispatchId: string): CapturedEvent[] {
    const file = readDispatchFile(taskDir, dispatchId);
    if (!file) return [];
    return file.events;
  }

  getRecentEvents(taskDir: string, dispatchId: string, count: number): CapturedEvent[] {
    const events = this.getDispatchEvents(taskDir, dispatchId);
    if (count >= events.length) return events;
    return events.slice(-count);
  }
}

// ── Singleton ───────────────────────────────────────────────────

let _store: DispatchStoreProvider | undefined;

export function getDispatchStore(): DispatchStoreProvider {
  if (!_store) {
    _store = new JsonFileDispatchStore();
  }
  return _store;
}
