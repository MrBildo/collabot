import type { ToolCall, LoopDetection, LoopDetectionThresholds, ErrorTriplet, NonRetryableDetection } from './types.js';

const DEFAULT_THRESHOLDS: LoopDetectionThresholds = {
  repeatWarn: 3, repeatKill: 5, pingPongWarn: 3, pingPongKill: 4,
};

/**
 * Detects whether an agent is stuck in a tool-call loop.
 * Pure function — no side effects, no I/O.
 *
 * Checks for two patterns:
 * 1. Generic repeat: same "tool::target" appears N+ times in the window
 *    - repeatKill+ → kill, repeatWarn+ → warning
 * 2. Ping-pong: last N calls alternate between exactly 2 patterns (A,B,A,B,...)
 *    - pingPongKill alternations → kill, pingPongWarn alternations → warning
 *
 * Threshold of 0 = unlimited (skip that check).
 * Returns the first detection exceeding a threshold, or null if no loop.
 */
export function detectErrorLoop(
  recentCalls: ToolCall[],
  thresholds?: LoopDetectionThresholds,
): LoopDetection | null {
  if (recentCalls.length === 0) return null;

  const t = thresholds ?? DEFAULT_THRESHOLDS;
  let best: LoopDetection | null = null;

  // --- Generic repeat detection ---
  const counts = new Map<string, number>();
  for (const { tool, target } of recentCalls) {
    const key = target ? `${tool}::${target}` : tool;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  // Kill threshold takes priority (0 = unlimited, skip)
  if (t.repeatKill > 0) {
    for (const [pattern, count] of counts) {
      if (count >= t.repeatKill) {
        return { type: 'genericRepeat', pattern, count, severity: 'kill' };
      }
    }
  }

  // Warning threshold — store as candidate (0 = unlimited, skip)
  if (t.repeatWarn > 0) {
    for (const [pattern, count] of counts) {
      if (count >= t.repeatWarn) {
        best = { type: 'genericRepeat', pattern, count, severity: 'warning' };
        break;
      }
    }
  }

  // --- Ping-pong detection ---
  // Check if the tail of recentCalls alternates between exactly 2 patterns
  const pingPongEnabled = t.pingPongWarn > 0 || t.pingPongKill > 0;
  if (pingPongEnabled && recentCalls.length >= 6) {
    const keyOf = (c: ToolCall) => c.target ? `${c.tool}::${c.target}` : c.tool;

    const last = recentCalls.length - 1;
    const keyA = keyOf(recentCalls[last]!);
    const keyB = keyOf(recentCalls[last - 1]!);

    if (keyA !== keyB) {
      // Count how many alternating pairs from the end
      let alternations = 0;
      let idx = last;
      let expectA = true; // start from the end (most recent = A)

      while (idx >= 0) {
        const key = keyOf(recentCalls[idx]!);
        if (expectA && key === keyA) {
          // fine
        } else if (!expectA && key === keyB) {
          // fine
        } else {
          break;
        }
        if (expectA) alternations++;
        expectA = !expectA;
        idx--;
      }

      // alternations counts how many times A appeared in the sequence
      // Pattern A,B,A,B,A,B = 3 alternations of A (6 calls total)
      if (t.pingPongKill > 0 && alternations >= t.pingPongKill) {
        // Ping-pong kill always wins over genericRepeat warning
        return {
          type: 'pingPong',
          pattern: `${keyB} ↔ ${keyA}`,
          count: alternations,
          severity: 'kill',
        };
      }
      if (t.pingPongWarn > 0 && alternations >= t.pingPongWarn && best === null) {
        best = {
          type: 'pingPong',
          pattern: `${keyB} ↔ ${keyA}`,
          count: alternations,
          severity: 'warning',
        };
      }
    }
  }

  return best;
}

/**
 * Detects non-retryable errors — same (tool, target, errorSnippet) appearing 2+ times.
 * Pure function — no side effects, no I/O.
 */
export function detectNonRetryable(recentErrors: ErrorTriplet[]): NonRetryableDetection | null {
  if (recentErrors.length < 2) return null;

  const counts = new Map<string, { triplet: ErrorTriplet; count: number }>();

  for (const triplet of recentErrors) {
    const key = `${triplet.tool}::${triplet.target}::${triplet.errorSnippet}`;
    const existing = counts.get(key);
    if (existing) {
      existing.count++;
    } else {
      counts.set(key, { triplet, count: 1 });
    }
  }

  for (const { triplet, count } of counts.values()) {
    if (count >= 2) {
      return {
        tool: triplet.tool,
        target: triplet.target,
        errorSnippet: triplet.errorSnippet,
        count,
      };
    }
  }

  return null;
}
