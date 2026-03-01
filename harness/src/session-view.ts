import { getDispatchStore } from './dispatch-store.js';
import type { CapturedEvent, DispatchEnvelope } from './types.js';

/**
 * Renders a full session log from a dispatch's events.
 * Used for TUI session reconstruction and PM check-ins.
 *
 * Returns null if the dispatch does not exist.
 */
export function renderSessionView(taskDir: string, dispatchId: string): string | null {
  const store = getDispatchStore();
  const envelope = store.getDispatchEnvelope(taskDir, dispatchId);
  if (!envelope) return null;

  const events = store.getDispatchEvents(taskDir, dispatchId);
  const lines: string[] = [];

  // Header
  lines.push(`## Session: ${envelope.role} (${dispatchId})`);
  lines.push(renderHeaderLine(envelope));
  lines.push('');

  // Chronological event stream
  for (const event of events) {
    lines.push(renderEvent(event));
  }

  return lines.join('\n');
}

function renderHeaderLine(envelope: DispatchEnvelope): string {
  const parts: string[] = [`Model: ${envelope.model}`];

  const startTime = formatTime(envelope.startedAt);
  parts.push(`Started: ${startTime}`);

  if (envelope.cost != null) {
    parts.push(`Cost: $${envelope.cost.toFixed(2)}`);
  }

  return parts.join(' | ');
}

function renderEvent(event: CapturedEvent): string {
  const time = formatTime(event.timestamp);
  const data = event.data ?? {};

  switch (event.type) {
    case 'agent:text':
      return `${time} [text] ${truncate(String(data.text ?? ''), 120)}`;

    case 'agent:thinking':
      return `${time} [thinking] ${truncate(String(data.text ?? ''), 120)}`;

    case 'agent:tool_call':
      return `${time} [tool] ${data.tool ?? 'unknown'}${data.target ? ' ' + data.target : ''}`;

    case 'agent:tool_result': {
      const duration = data.durationMs != null ? ` (${data.durationMs}ms)` : '';
      const status = data.status ? ` ${data.status}` : '';
      return `${time} [result] ${data.tool ?? 'unknown'}${status}${duration}`;
    }

    case 'session:init':
      return `${time} [init] Session initialized`;

    case 'session:complete': {
      const parts: string[] = [String(data.status ?? envelope_status(data))];
      if (data.cost != null) parts.push(`$${Number(data.cost).toFixed(2)}`);
      if (data.inputTokens != null || data.outputTokens != null) {
        const input = formatTokens(Number(data.inputTokens ?? 0));
        const output = formatTokens(Number(data.outputTokens ?? 0));
        parts.push(`${input} input / ${output} output`);
      }
      if (data.numTurns != null) parts.push(`${data.numTurns} turns`);
      return `${time} [complete] ${parts.join(' — ')}`;
    }

    case 'session:compaction':
      return `${time} [compaction] Context compacted`;

    case 'session:rate_limit':
      return `${time} [rate_limit] Rate limited`;

    case 'session:status':
      return `${time} [status] ${data.status ?? 'Status update'}`;

    case 'harness:loop_warning':
      return `${time} [loop_warning] ${data.pattern ?? 'Pattern detected'}`;

    case 'harness:loop_kill':
      return `${time} [loop_kill] ${data.pattern ?? 'Agent killed for looping'}`;

    case 'harness:stall':
      return `${time} [stall] Inactivity timeout`;

    case 'harness:abort':
      return `${time} [abort] Agent aborted`;

    case 'harness:error':
      return `${time} [error] ${truncate(String(data.message ?? data.error ?? 'Unknown error'), 200)}`;

    case 'user:message':
      return `${time} [user] ${truncate(String(data.text ?? ''), 120)}`;

    case 'system:files_persisted':
      return `${time} [system] Files persisted`;

    case 'system:hook_started':
      return `${time} [system] Hook started: ${data.hookName ?? 'unknown'}`;

    case 'system:hook_progress':
      return `${time} [system] Hook progress: ${data.hookName ?? 'unknown'}`;

    case 'system:hook_response':
      return `${time} [system] Hook response: ${data.hookName ?? 'unknown'}`;

    default:
      return `${time} [${event.type}] ${JSON.stringify(data)}`;
  }
}

function envelope_status(data: Record<string, unknown>): string {
  return String(data.status ?? 'completed');
}

function formatTime(isoString: string): string {
  try {
    const d = new Date(isoString);
    return d.toISOString().slice(11, 19); // HH:MM:SS
  } catch {
    return '??:??:??';
  }
}

function formatTokens(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}K`;
  }
  return String(count);
}

function truncate(text: string, maxLen: number): string {
  const oneLine = text.replace(/\n/g, ' ');
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 3) + '...';
}
