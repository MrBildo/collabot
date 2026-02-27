import { readFileSync, existsSync } from 'node:fs';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { getInstancePath, getPackagePath } from './paths.js';

const RoutingRuleSchema = z.object({
  pattern: z.string(),
  role: z.string(),
  cwd: z.string().optional(),
});

const LogLevelSchema = z.enum(['minimal', 'debug', 'verbose']).default('debug');

export const ConfigSchema = z.object({
  models: z.object({
    default: z.string(),
    aliases: z.record(z.string(), z.string()).default({}),
  }),
  defaults: z.object({
    stallTimeoutSeconds: z.number().positive().default(300),
  }).default({ stallTimeoutSeconds: 300 }),
  agent: z.object({
    maxTurns: z.number().int().positive().default(50),
    maxBudgetUsd: z.number().positive().default(1.00),
  }).default({ maxTurns: 50, maxBudgetUsd: 1.00 }),
  logging: z.object({
    level: LogLevelSchema,
  }).default({ level: 'debug' }),
  routing: z.object({
    default: z.string(),
    rules: z.array(RoutingRuleSchema).default([]),
  }).optional().default({ default: 'product-analyst', rules: [] }),
  slack: z.object({
    debounceMs: z.number().positive().default(2000),
    reactions: z.object({
      received: z.string().default('eyes'),
      working: z.string().default('hammer'),
      success: z.string().default('white_check_mark'),
      failure: z.string().default('x'),
    }).default({ received: 'eyes', working: 'hammer', success: 'white_check_mark', failure: 'x' }),
  }).optional(),
  pool: z.object({
    maxConcurrent: z.number().int().min(0).default(0), // 0 = unlimited
  }).default({ maxConcurrent: 0 }),
  mcp: z.object({
    streamTimeout: z.number().int().positive().default(600000), // CLAUDE_CODE_STREAM_CLOSE_TIMEOUT (ms)
  }).default({ streamTimeout: 600000 }),
  ws: z.object({
    port: z.number().int().positive().default(9800),
    host: z.string().default('127.0.0.1'),
  }).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function resolveModelId(modelHint: string, config: Config): string {
  return config.models.aliases[modelHint] ?? config.models.default;
}

let _config: Config | undefined;

/**
 * Deep-merge two plain objects. `override` values win over `base`.
 * Arrays and non-object values are replaced entirely, not merged.
 */
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const baseVal = base[key];
    const overrideVal = override[key];
    if (
      baseVal !== null && typeof baseVal === 'object' && !Array.isArray(baseVal) &&
      overrideVal !== null && typeof overrideVal === 'object' && !Array.isArray(overrideVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      );
    } else {
      result[key] = overrideVal;
    }
  }
  return result;
}

export function loadConfig(): Config {
  // Load package defaults (fallback for missing user fields)
  let defaults: Record<string, unknown> = {};
  const defaultsPath = getPackagePath('config.defaults.toml');
  if (existsSync(defaultsPath)) {
    try {
      defaults = parseToml(readFileSync(defaultsPath, 'utf8')) as Record<string, unknown>;
    } catch {
      // Malformed defaults — continue without them
    }
  }

  // Load user config
  const configPath = getInstancePath('config.toml');
  let userConfig: Record<string, unknown>;
  try {
    const content = readFileSync(configPath, 'utf8');
    userConfig = parseToml(content) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read config.toml: ${msg}`);
  }

  // Merge: defaults <- user overrides
  const merged = deepMerge(defaults, userConfig);

  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`config.toml is invalid:\n${issues}`);
  }

  _config = result.data;
  return _config;
}

export function getConfig(): Config {
  if (_config === undefined) {
    throw new Error('getConfig() called before loadConfig()');
  }
  return _config;
}
