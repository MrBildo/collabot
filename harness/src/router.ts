import type { Config } from './config.js';

/**
 * Resolves which role should handle a message by testing it against routing rules.
 * Returns the first matching role name or the default role.
 */
export function resolveRole(message: string, config: Config): string {
  for (const rule of config.routing.rules) {
    const regex = new RegExp(rule.pattern, 'i');
    if (regex.test(message)) {
      return rule.role;
    }
  }
  return config.routing.default;
}

/**
 * Returns the cwd override from the matched routing rule, or undefined.
 * This allows routing rules to override the role's default cwd.
 */
export function resolveRoutingCwd(message: string, config: Config): string | undefined {
  for (const rule of config.routing.rules) {
    const regex = new RegExp(rule.pattern, 'i');
    if (regex.test(message)) {
      return rule.cwd;
    }
  }
  return undefined;
}
