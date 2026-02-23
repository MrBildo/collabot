import pino from 'pino';

// Three-tier log levels:
//   minimal  → warn  (headless: startup, errors, shutdown)
//   debug    → info  (default: agent lifecycle, text, thinking, tool summaries)
//   verbose  → debug (everything: full tool input, token counts, heartbeat)

export type LogTier = 'minimal' | 'debug' | 'verbose';

function resolveLogTier(): LogTier {
  const explicit = process.env.HARNESS_LOG_LEVEL?.toLowerCase();
  if (explicit === 'minimal' || explicit === 'debug' || explicit === 'verbose') return explicit;
  // Backward compat: HARNESS_VERBOSE=true → verbose
  if (process.env.HARNESS_VERBOSE === 'true' || process.argv.includes('--verbose')) return 'verbose';
  return 'debug';
}

export const logTier: LogTier = resolveLogTier();

const pinoLevel = logTier === 'minimal' ? 'warn' : logTier === 'verbose' ? 'debug' : 'info';

export const logger = pino({ level: pinoLevel }, pino.destination({ sync: true }));
