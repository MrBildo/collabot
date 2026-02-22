using System.Net.WebSockets;
using System.Text.Json;
using StreamJsonRpc;
using Collabot.Tui.Models;

namespace Collabot.Tui.Services;

public class HarnessConnection : IDisposable
{
    private readonly Uri _serverUri;
    private ClientWebSocket? _webSocket;
    private JsonRpc? _rpc;
    private CancellationTokenSource? _cts;
    private ConnectionState _connectionState = ConnectionState.Disconnected;

    private bool _intentionalDisconnect;
    private bool _reconnecting;
    private int _reconnectAttempt;
    private CancellationTokenSource? _reconnectCts;

    public Uri ServerUri => _serverUri;

    public ConnectionState ConnectionState
    {
        get => _connectionState;
        private set
        {
            if (_connectionState == value)
            {
                return;
            }

            _connectionState = value;
            ConnectionStateChanged?.Invoke(this, value);
        }
    }

    public event EventHandler<ConnectionState>? ConnectionStateChanged;
    public event EventHandler<int>? ReconnectingIn;
    public event EventHandler<ChannelMessageNotification>? ChannelMessageReceived;
    public event EventHandler<StatusUpdateNotification>? StatusUpdateReceived;
    public event EventHandler<PoolStatusNotification>? PoolStatusReceived;
    public event EventHandler<DraftStatusNotification>? DraftStatusReceived;
    public event EventHandler<ContextCompactedNotification>? ContextCompactedReceived;

    public HarnessConnection(string? serverUrl = null)
    {
        var url = serverUrl
            ?? Environment.GetEnvironmentVariable("HARNESS_WS_URL")
            ?? ReadFromAppSettings()
            ?? "ws://127.0.0.1:9800";
        _serverUri = new Uri(url);
    }

    public async Task ConnectAsync()
    {
        _intentionalDisconnect = false;
        _reconnectAttempt = 0;
        ConnectionState = ConnectionState.Connecting;

        try
        {
            await ConnectInternalAsync(CancellationToken.None);
        }
        catch
        {
            ConnectionState = ConnectionState.Disconnected;
            throw;
        }
    }

    public async Task DisconnectAsync()
    {
        _intentionalDisconnect = true;
        _reconnectCts?.Cancel();

        _cts?.Cancel();

        if (_rpc is not null)
        {
            _rpc.Disconnected -= OnRpcDisconnected;
            _rpc.Dispose();
            _rpc = null;
        }

        if (_webSocket is { State: WebSocketState.Open })
        {
            try
            {
                await _webSocket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Client closing", CancellationToken.None);
            }
            catch
            {
                // Best-effort close
            }
        }

        _webSocket?.Dispose();
        _webSocket = null;
        _reconnecting = false;
        ConnectionState = ConnectionState.Disconnected;
    }

    public async Task<SubmitPromptResult> SubmitPromptAsync(string content, string? role = null, string? taskSlug = null)
    {
        EnsureConnected();
        return await _rpc!.InvokeWithParameterObjectAsync<SubmitPromptResult>(
            "submit_prompt",
            new SubmitPromptParams(content, role, taskSlug));
    }

    public async Task<ListAgentsResult> ListAgentsAsync()
    {
        EnsureConnected();
        return await _rpc!.InvokeAsync<ListAgentsResult>("list_agents");
    }

    public async Task<ListTasksResult> ListTasksAsync()
    {
        EnsureConnected();
        return await _rpc!.InvokeAsync<ListTasksResult>("list_tasks");
    }

    public async Task<KillAgentResult> KillAgentAsync(string agentId)
    {
        EnsureConnected();
        return await _rpc!.InvokeWithParameterObjectAsync<KillAgentResult>(
            "kill_agent",
            new KillAgentParams(agentId));
    }

    public async Task<GetTaskContextResult> GetTaskContextAsync(string slug)
    {
        EnsureConnected();
        return await _rpc!.InvokeWithParameterObjectAsync<GetTaskContextResult>(
            "get_task_context",
            new GetTaskContextParams(slug));
    }

    public async Task<DraftResult> DraftAsync(string role)
    {
        EnsureConnected();
        return await _rpc!.InvokeWithParameterObjectAsync<DraftResult>(
            "draft",
            new DraftParams(role));
    }

    public async Task<UndraftResult> UndraftAsync()
    {
        EnsureConnected();
        return await _rpc!.InvokeAsync<UndraftResult>("undraft");
    }

    public async Task<DraftStatusResult> GetDraftStatusAsync()
    {
        EnsureConnected();
        return await _rpc!.InvokeAsync<DraftStatusResult>("get_draft_status");
    }

    private void EnsureConnected()
    {
        if (_rpc is null || ConnectionState != ConnectionState.Connected)
        {
            var reason = ConnectionState switch
            {
                ConnectionState.Reconnecting => "Reconnecting to harness — please wait",
                ConnectionState.Connecting => "Connecting to harness — please wait",
                _ => "Not connected to harness"
            };
            throw new InvalidOperationException(reason);
        }
    }

    private async Task ConnectInternalAsync(CancellationToken cancellationToken)
    {
        CleanupConnection();

        _cts = new CancellationTokenSource();
        _webSocket = new ClientWebSocket();

        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token, cancellationToken);
        await _webSocket.ConnectAsync(_serverUri, linkedCts.Token);

        var formatter = new SystemTextJsonFormatter();
        formatter.JsonSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
        formatter.JsonSerializerOptions.PropertyNameCaseInsensitive = true;
        formatter.JsonSerializerOptions.DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull;

        var handler = new WebSocketMessageHandler(_webSocket, formatter);
        _rpc = new JsonRpc(handler);
        _rpc.AddLocalRpcTarget(new NotificationTarget(this));
        _rpc.Disconnected += OnRpcDisconnected;
        _rpc.StartListening();

        ConnectionState = ConnectionState.Connected;
    }

    private void CleanupConnection()
    {
        if (_rpc is not null)
        {
            _rpc.Disconnected -= OnRpcDisconnected;
            _rpc.Dispose();
            _rpc = null;
        }

        if (_webSocket is not null)
        {
            _webSocket.Dispose();
            _webSocket = null;
        }

        if (_cts is not null)
        {
            _cts.Cancel();
            _cts.Dispose();
            _cts = null;
        }
    }

    private void OnRpcDisconnected(object? sender, JsonRpcDisconnectedEventArgs e)
    {
        ConnectionState = ConnectionState.Disconnected;

        if (!_intentionalDisconnect && !_reconnecting)
        {
            _ = ReconnectLoopAsync();
        }
    }

    private async Task ReconnectLoopAsync()
    {
        _reconnecting = true;
        _reconnectCts?.Cancel();
        _reconnectCts?.Dispose();
        _reconnectCts = new CancellationTokenSource();
        var token = _reconnectCts.Token;

        while (!token.IsCancellationRequested)
        {
            var delay = GetReconnectDelay(_reconnectAttempt);
            ConnectionState = ConnectionState.Reconnecting;
            ReconnectingIn?.Invoke(this, delay / 1000);

            try
            {
                await Task.Delay(delay, token);
            }
            catch (OperationCanceledException)
            {
                break;
            }

            ConnectionState = ConnectionState.Connecting;

            try
            {
                await ConnectInternalAsync(token);
                _reconnectAttempt = 0;
                _reconnecting = false;
                return;
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch
            {
                _reconnectAttempt++;
                ConnectionState = ConnectionState.Disconnected;
            }
        }

        _reconnecting = false;
    }

    private static int GetReconnectDelay(int attempt)
    {
        var delay = (int)Math.Pow(2, attempt) * 1000;
        return Math.Min(delay, 30000);
    }

    private static string? ReadFromAppSettings()
    {
        var path = Path.Combine(Directory.GetCurrentDirectory(), "appsettings.json");

        if (!File.Exists(path))
        {
            return null;
        }

        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            return doc.RootElement.TryGetProperty("HarnessWsUrl", out var prop)
                ? prop.GetString()
                : null;
        }
        catch
        {
            return null;
        }
    }

    internal void RaiseChannelMessage(ChannelMessageNotification notification) =>
        ChannelMessageReceived?.Invoke(this, notification);

    internal void RaiseStatusUpdate(StatusUpdateNotification notification) =>
        StatusUpdateReceived?.Invoke(this, notification);

    internal void RaisePoolStatus(PoolStatusNotification notification) =>
        PoolStatusReceived?.Invoke(this, notification);

    internal void RaiseDraftStatus(DraftStatusNotification notification) =>
        DraftStatusReceived?.Invoke(this, notification);

    internal void RaiseContextCompacted(ContextCompactedNotification notification) =>
        ContextCompactedReceived?.Invoke(this, notification);

    public void Dispose()
    {
        _intentionalDisconnect = true;
        _reconnectCts?.Cancel();
        _reconnectCts?.Dispose();

        _cts?.Cancel();

        if (_rpc is not null)
        {
            _rpc.Disconnected -= OnRpcDisconnected;
            _rpc.Dispose();
        }

        _webSocket?.Dispose();
        _cts?.Dispose();
        GC.SuppressFinalize(this);
    }

    private class NotificationTarget(HarnessConnection connection)
    {
        [JsonRpcMethod("channel_message", UseSingleObjectParameterDeserialization = true)]
        public void OnChannelMessage(ChannelMessageNotification notification) =>
            connection.RaiseChannelMessage(notification);

        [JsonRpcMethod("status_update", UseSingleObjectParameterDeserialization = true)]
        public void OnStatusUpdate(StatusUpdateNotification notification) =>
            connection.RaiseStatusUpdate(notification);

        [JsonRpcMethod("pool_status", UseSingleObjectParameterDeserialization = true)]
        public void OnPoolStatus(PoolStatusNotification notification) =>
            connection.RaisePoolStatus(notification);

        [JsonRpcMethod("draft_status", UseSingleObjectParameterDeserialization = true)]
        public void OnDraftStatus(DraftStatusNotification notification) =>
            connection.RaiseDraftStatus(notification);

        [JsonRpcMethod("context_compacted", UseSingleObjectParameterDeserialization = true)]
        public void OnContextCompacted(ContextCompactedNotification notification) =>
            connection.RaiseContextCompacted(notification);
    }
}
