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

// --- Response Types ---

public record SubmitPromptResult(string ThreadId, string TaskSlug);

public record KillAgentResult(bool Success, string Message);

public record AgentInfo(string Id, string Role, string TaskSlug, string StartedAt);

public record ListAgentsResult(AgentInfo[] Agents);

public record TaskInfo(string Slug, string Created, string Description, int DispatchCount);

public record ListTasksResult(TaskInfo[] Tasks);

public record GetTaskContextResult(string Context);

// --- Notification Params ---

public record ChannelMessageNotification(string Id, string ChannelId, string From, string Timestamp, string Type, string Content, object? Metadata);

public record StatusUpdateNotification(string ChannelId, string Status);

public record PoolStatusNotification(AgentInfo[] Agents);

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
