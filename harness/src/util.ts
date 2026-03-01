/**
 * Extracts a human-readable target from a tool_use input block.
 * Best-effort — returns empty string if nothing useful can be extracted.
 */
export function extractToolTarget(toolName: string, input: unknown): string {
  if (input == null || typeof input !== "object") return "";

  const obj = input as Record<string, unknown>;

  switch (toolName) {
    case "Edit":
    case "Read":
    case "Write":
    case "Glob":
      if (typeof obj.file_path === "string") return obj.file_path;
      if (typeof obj.path === "string") return obj.path;
      return "";

    case "Bash":
      if (typeof obj.command === "string") return obj.command.slice(0, 80);
      return "";

    case "Grep":
      if (typeof obj.pattern === "string") return obj.pattern;
      return "";

    // MCP harness tools — extract meaningful targets to avoid false positive loop detection
    case "mcp__harness__draft_agent":
      if (typeof obj.role === "string") return obj.role;
      return "";

    case "mcp__harness__await_agent":
    case "mcp__harness__kill_agent":
      if (typeof obj.agentId === "string") return obj.agentId;
      return "";

    default:
      return "";
  }
}
