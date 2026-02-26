import fs from "node:fs";
import { watch, type FSWatcher } from "chokidar";

export type JournalChangeHandler = (journalPath: string, newEntries: string[]) => void;

export type JournalStatus = {
  status: string;
  lastEntries: string[];
  lastActivity: Date;
};

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

/**
 * Watches a journals directory for file changes and calls onChange with new log lines.
 * Tracks byte offsets per file so only new content is surfaced.
 * Returns the chokidar FSWatcher so the caller can close it on shutdown.
 */
export function watchJournals(
  journalsDir: string,
  onChange: JournalChangeHandler,
  usePolling = false,
): FSWatcher {
  const offsets = new Map<string, number>();

  const watcher = watch(journalsDir, {
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    ignoreInitial: true,
    usePolling,
  });

  watcher.on("change", (filePath: string) => {
    try {
      const buf = fs.readFileSync(filePath);
      const fileOffset = offsets.get(filePath) ?? 0;
      if (buf.length <= fileOffset) return;

      const newContent = buf.subarray(fileOffset).toString("utf-8");
      offsets.set(filePath, buf.length);

      const newLines = newContent.split("\n").filter((l) => l.trim() !== "");
      if (newLines.length > 0) {
        onChange(filePath, newLines);
      }
    } catch {
      // Journal read failure is non-fatal
    }
  });

  return watcher;
}

/**
 * Reads a journal file and returns its status, last N entries, and last activity time.
 * Plumbing for the future PM agent — nothing calls this in Milestone B.
 */
export function getJournalStatus(journalPath: string): JournalStatus {
  const content = fs.readFileSync(journalPath, "utf-8");
  const statusMatch = content.match(/^Status: (.+)$/m);
  const status = statusMatch?.[1]?.trim() ?? "unknown";

  const lines = content.split("\n").filter((l) => l.trim() !== "");
  const lastEntries = lines.slice(-5);

  const stat = fs.statSync(journalPath);
  const lastActivity = stat.mtime;

  return { status, lastEntries, lastActivity };
}
