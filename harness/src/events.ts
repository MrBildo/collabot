import fs from 'node:fs';
import path from 'node:path';
import type { CapturedEvent, CapturedEventType, EventLog } from './types.js';

/**
 * Abstraction layer for event storage (D7).
 * Starts as JSON files; can evolve to a lightweight DB later.
 */
export interface EventStore {
  append(taskDir: string, role: string, taskSlug: string, event: CapturedEvent): void;
  read(taskDir: string): EventLog | null;
}

/**
 * Create a CapturedEvent with consistent timestamp.
 */
export function makeEvent(type: CapturedEventType, data?: Record<string, unknown>): CapturedEvent {
  return {
    type,
    timestamp: new Date().toISOString(),
    ...(data !== undefined ? { data } : {}),
  };
}

/**
 * JSON-file-based event store. One file per task at {taskDir}/events.json.
 */
class JsonEventStore implements EventStore {
  append(taskDir: string, role: string, taskSlug: string, event: CapturedEvent): void {
    const filePath = path.join(taskDir, 'events.json');
    let log: EventLog;

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      log = JSON.parse(content) as EventLog;
    } catch {
      // File doesn't exist or is invalid — create new log
      log = {
        taskSlug,
        role,
        startedAt: event.timestamp,
        events: [],
      };
    }

    log.events.push(event);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(log, null, 2), 'utf8');
  }

  read(taskDir: string): EventLog | null {
    const filePath = path.join(taskDir, 'events.json');
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(content) as EventLog;
    } catch {
      return null;
    }
  }
}

// Singleton
let _store: EventStore | undefined;

export function getEventStore(): EventStore {
  if (!_store) {
    _store = new JsonEventStore();
  }
  return _store;
}

/**
 * Render an EventLog into the legacy markdown journal format (D6).
 * Derived view — the event log is the source of truth.
 */
export function renderJournalView(log: EventLog): string {
  const lines: string[] = [
    `# Events: ${log.taskSlug}`,
    `Role: ${log.role}`,
    `Started: ${log.startedAt}`,
    '',
    '## Log',
    '',
  ];

  for (const event of log.events) {
    const time = event.timestamp.slice(11, 16); // HH:MM
    switch (event.type) {
      case 'dispatch_start':
        lines.push(`- ${time} — [harness] Agent dispatched (${event.data?.role ?? log.role}, ${event.data?.model ?? 'unknown'})`);
        break;
      case 'dispatch_end':
        lines.push(`- ${time} — [harness] Agent ${event.data?.status ?? 'completed'}`);
        break;
      case 'tool_use':
        lines.push(`- ${time} — [harness] tool_use: ${event.data?.tool ?? 'unknown'}${event.data?.target ? ' ' + event.data.target : ''}`);
        break;
      case 'text':
        lines.push(`- ${time} — [agent] ${(event.data?.text as string ?? '').slice(0, 200)}`);
        break;
      case 'thinking':
        lines.push(`- ${time} — [thinking] ${(event.data?.text as string ?? '').slice(0, 200)}`);
        break;
      case 'compaction':
        lines.push(`- ${time} — [harness] Context compacted (trigger: ${event.data?.trigger ?? 'auto'})`);
        break;
      case 'loop_warning':
        lines.push(`- ${time} — [harness] Loop warning: ${event.data?.pattern ?? 'unknown'} (${event.data?.count ?? '?'}x)`);
        break;
      case 'loop_kill':
        lines.push(`- ${time} — [harness] Agent killed: error loop (${event.data?.pattern ?? 'unknown'}, ${event.data?.count ?? '?'}x)`);
        break;
      case 'stall':
        lines.push(`- ${time} — [harness] Agent stalled (inactivity timeout)`);
        break;
      case 'abort':
        lines.push(`- ${time} — [harness] Agent aborted${event.data?.reason ? ': ' + event.data.reason : ''}`);
        break;
      case 'error':
        lines.push(`- ${time} — [harness] Error: ${event.data?.message ?? 'unknown'}`);
        break;
      default:
        lines.push(`- ${time} — [${event.type}]`);
    }
  }

  return lines.join('\n') + '\n';
}
