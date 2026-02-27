import pino from 'pino';

// Three-tier log levels:
//   minimal  → warn  (headless: startup, errors, shutdown)
//   debug    → info  (default: agent lifecycle, text, thinking, tool summaries)
//   verbose  → debug (everything: full tool input, token counts, heartbeat)

export type LogTier = 'minimal' | 'debug' | 'verbose';

// Bootstrap log tier from env (available before config loads).
// Env var wins as override if explicitly set.
function resolveBootstrapLogTier(): LogTier {
  const explicit = process.env.HARNESS_LOG_LEVEL?.toLowerCase();
  if (explicit === 'minimal' || explicit === 'debug' || explicit === 'verbose') return explicit;
  // Backward compat: HARNESS_VERBOSE=true → verbose
  if (process.env.HARNESS_VERBOSE === 'true' || process.argv.includes('--verbose')) return 'verbose';
  return 'debug';
}

function tierToPinoLevel(tier: LogTier): string {
  return tier === 'minimal' ? 'warn' : tier === 'verbose' ? 'debug' : 'info';
}

// Whether an env-level override was explicitly set
const envOverride = !!(
  process.env.HARNESS_LOG_LEVEL ||
  process.env.HARNESS_VERBOSE === 'true' ||
  process.argv.includes('--verbose')
);

export let logTier: LogTier = resolveBootstrapLogTier();

export const logger = pino({ level: tierToPinoLevel(logTier) }, pino.destination({ sync: true }));

/**
 * Apply log level from config.toml. Only takes effect if no env var override was set.
 * Call this from index.ts after loadConfig().
 */
export function applyConfigLogLevel(configLevel: LogTier): void {
  if (envOverride) return; // env var wins
  if (configLevel === logTier) return; // already correct
  logTier = configLevel;
  logger.level = tierToPinoLevel(configLevel);
}
