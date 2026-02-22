namespace Collabot.Tui.Models;

// --- Connection State ---

public enum ConnectionState
{
    Disconnected,
    Connecting,
    Connected,
    Reconnecting
}

// --- Request Params ---

public record SubmitPromptParams(string Content, string? Role, string? TaskSlug);

public record KillAgentParams(string AgentId);

public record GetTaskContextParams(string Slug);

public record DraftParams(string Role);

// --- Response Types ---

public record SubmitPromptResult(string ThreadId, string TaskSlug);

public record KillAgentResult(bool Success, string Message);

public record AgentInfo(string Id, string Role, string TaskSlug, string StartedAt);

public record ListAgentsResult(AgentInfo[] Agents);

public record TaskInfo(string Slug, string Created, string Description, int DispatchCount);

public record ListTasksResult(TaskInfo[] Tasks);

public record GetTaskContextResult(string Context);

public record DraftResult(string SessionId, string TaskSlug);

public record UndraftResult(string SessionId, string TaskSlug, int Turns, double Cost, long DurationMs);

public record DraftStatusResult(bool Active, DraftSessionInfo? Session);

public record DraftSessionInfo(
    string SessionId, string Role, string TaskSlug,
    int TurnCount, double CostUsd, int ContextPct,
    int LastInputTokens, int ContextWindow, string LastActivity);

// --- Notification Params ---

public record ChannelMessageNotification(string Id, string ChannelId, string From, string Timestamp, string Type, string Content, object? Metadata);

public record StatusUpdateNotification(string ChannelId, string Status);

public record PoolStatusNotification(AgentInfo[] Agents);

public record DraftStatusNotification(
    string SessionId, string Role, int TurnCount,
    double CostUsd, int ContextPct, string LastActivity);

public record ContextCompactedNotification(string SessionId, int PreTokens, string Trigger);

// --- Filter ---

public enum FilterLevel
{
    Minimal,
    Feedback,
    Verbose
}

// --- UI Model ---

public record ChatMessage(DateTime Timestamp, string Type, string From, string Content)
{
    public override string ToString()
    {
        if (Type == "banner") return Content;

        var prefix = Type switch
        {
            "user" => "> ",
            _ when !string.IsNullOrEmpty(From) => $"[{From}] ",
            _ => ""
        };
        return $"[{Timestamp:HH:mm:ss}] {prefix}{Content}";
    }
}
