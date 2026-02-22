using Terminal.Gui.App;
using Terminal.Gui.ViewBase;
using Terminal.Gui.Views;
using Terminal.Gui.Input;
using Collabot.Tui.Models;
using Collabot.Tui.Services;

namespace Collabot.Tui.Views;

public class MainWindow : Window
{
    private readonly HarnessConnection _connection;
    private readonly MessageView _messageView;
    private readonly TextField _inputField;

    private string? _currentRole;
    private string? _currentTask;
    private int _agentCount;
    private FilterLevel _filterLevel = FilterLevel.Feedback;

    private bool _draftActive;
    private string? _draftRole;
    private int _draftTurnCount;
    private double _draftCostUsd;
    private int _draftContextPct;

    private readonly List<string> _commandHistory = [];
    private int _historyIndex = -1;
    private string _historyStash = "";

    private const int _maxHistorySize = 50;

    public MainWindow()
    {
        Title = "Collabot — ○ Disconnected";

        _connection = new HarnessConnection();
        _connection.ConnectionStateChanged += OnConnectionStateChanged;
        _connection.ReconnectingIn += OnReconnectingIn;
        _connection.ChannelMessageReceived += OnChannelMessage;
        _connection.StatusUpdateReceived += OnStatusUpdate;
        _connection.PoolStatusReceived += OnPoolStatus;
        _connection.DraftStatusReceived += OnDraftStatus;
        _connection.ContextCompactedReceived += OnContextCompacted;

        _messageView = new MessageView
        {
            X = 0,
            Y = 0,
            Width = Dim.Fill(),
            Height = Dim.Fill(2)
        };

        var inputPrompt = new Label
        {
            Text = "> ",
            X = 0,
            Y = Pos.Bottom(_messageView)
        };

        _inputField = new TextField
        {
            X = 2,
            Y = Pos.Bottom(_messageView),
            Width = Dim.Fill()
        };
        _inputField.Accepting += OnInputAccepted;
        _inputField.KeyDown += OnInputKeyDown;

        var statusBar = new StatusBar(
        [
            new Shortcut(Key.F1, "Help", ShowHelp),
            new Shortcut(Key.L.WithCtrl, "Clear", ClearMessages),
            new Shortcut(Key.Q.WithCtrl, "Quit", () => App?.RequestStop())
        ]);

        Add(_messageView, inputPrompt, _inputField, statusBar);

        Initialized += OnWindowInitialized;
    }

    private async void OnWindowInitialized(object? sender, EventArgs e)
    {
        _inputField.SetFocus();
        ShowStartupBanner();
        await StartConnectionAsync();
    }

    private void ShowStartupBanner()
    {
        AddBannerLine("   ____ ___  _     _        _    ", "____   ___ _____ ");
        AddBannerLine("  / ___/ _ \\| |   | |      / \\  ", "| __ ) / _ \\_   _|");
        AddBannerLine(" | |  | | | | |   | |     / _ \\ ", "|  _ \\| | | || |  ");
        AddBannerLine(" | |__| |_| | |___| |___ / ___ \\", "| |_) | |_| || |  ");
        AddBannerLine("  \\____\\___/|_____|_____/_/   \\_\\", "____/ \\___/ |_|  ");
        AddSystemMessage("        the collaborative agent platform");
        AddSystemMessage("");
        AddSystemMessage("/help for commands, Ctrl+Q quit, Ctrl+L clear");
    }

    private void AddBannerLine(string cyanPart, string orangePart) =>
        _messageView.AddMessage(new ChatMessage(DateTime.Now, "banner", "", cyanPart + "\t" + orangePart));

    private async Task StartConnectionAsync()
    {
        try
        {
            await _connection.ConnectAsync();
        }
        catch (Exception ex)
        {
            App?.Invoke(() => AddMessage("error", "system", $"Connection failed: {ex.Message}"));
        }
    }

    private void OnConnectionStateChanged(object? sender, ConnectionState state)
    {
        App?.Invoke(() =>
        {
            UpdateTitle();

            var message = state switch
            {
                ConnectionState.Connected => $"Connected to {_connection.ServerUri}",
                ConnectionState.Disconnected => "Disconnected from harness",
                ConnectionState.Reconnecting => "Disconnected — reconnecting...",
                _ => null
            };

            if (message is not null)
            {
                AddMessage("lifecycle", "system", message);
            }

            if (state == ConnectionState.Connected)
            {
                _ = RefreshPoolStatusAsync();
                _ = RefreshDraftStatusAsync();
            }
        });
    }

    private void OnReconnectingIn(object? sender, int seconds)
    {
        App?.Invoke(() => AddMessage("lifecycle", "system", $"Reconnecting in {seconds}s..."));
    }

    private async Task RefreshPoolStatusAsync()
    {
        try
        {
            var result = await _connection.ListAgentsAsync();
            App?.Invoke(() =>
            {
                _agentCount = result.Agents.Length;
                UpdateTitle();
            });
        }
        catch
        {
            // Best-effort refresh
        }
    }

    private async Task RefreshDraftStatusAsync()
    {
        try
        {
            var result = await _connection.GetDraftStatusAsync();
            App?.Invoke(() =>
            {
                if (result.Active && result.Session is not null)
                {
                    _draftActive = true;
                    _draftRole = result.Session.Role;
                    _draftTurnCount = result.Session.TurnCount;
                    _draftCostUsd = result.Session.CostUsd;
                    _draftContextPct = result.Session.ContextPct;
                }
                else
                {
                    _draftActive = false;
                    _draftRole = null;
                    _draftTurnCount = 0;
                    _draftCostUsd = 0;
                    _draftContextPct = 0;
                }

                UpdateTitle();
            });
        }
        catch
        {
            // Best-effort refresh
        }
    }

    private void OnDraftStatus(object? sender, DraftStatusNotification e)
    {
        App?.Invoke(() =>
        {
            _draftActive = true;
            _draftRole = e.Role;
            _draftTurnCount = e.TurnCount;
            _draftCostUsd = e.CostUsd;
            _draftContextPct = e.ContextPct;
            UpdateTitle();
        });
    }

    private void OnContextCompacted(object? sender, ContextCompactedNotification e)
    {
        App?.Invoke(() =>
        {
            AddMessage("lifecycle", "system", $"Context auto-compacted (was {e.PreTokens:N0} tokens)");
        });
    }

    private void OnChannelMessage(object? sender, ChannelMessageNotification e)
    {
        if (!PassesFilter(e.Type)) return;

        App?.Invoke(() =>
        {
            var timestamp = DateTime.TryParse(e.Timestamp, out var ts) ? ts : DateTime.Now;
            _messageView.AddMessage(new ChatMessage(timestamp, e.Type, e.From, e.Content));
        });
    }

    private bool PassesFilter(string type) => _filterLevel switch
    {
        FilterLevel.Minimal => type is "result",
        FilterLevel.Feedback => type is not "tool_use" and not "thinking" and not "warning" and not "lifecycle",
        FilterLevel.Verbose => true,
        _ => true
    };

    private void OnStatusUpdate(object? sender, StatusUpdateNotification e)
    {
        App?.Invoke(() => AddMessage("lifecycle", "system", $"Status: {e.Status}"));
    }

    private void OnPoolStatus(object? sender, PoolStatusNotification e)
    {
        App?.Invoke(() =>
        {
            _agentCount = e.Agents.Length;
            UpdateTitle();
        });
    }

    private async void OnInputAccepted(object? sender, CommandEventArgs e)
    {
        e.Handled = true;

        try
        {
            var text = _inputField.Text?.Trim();
            if (string.IsNullOrEmpty(text))
            {
                return;
            }

            _inputField.Text = "";
            AddToHistory(text);

            if (text.StartsWith('/'))
            {
                await HandleCommandAsync(text);
            }
            else
            {
                await HandlePromptAsync(text);
            }
        }
        catch (Exception ex)
        {
            AddMessage("error", "system", $"Error: {ex.Message}");
        }
    }

    private void OnInputKeyDown(object? sender, Key e)
    {
        if (e == Key.CursorUp)
        {
            NavigateHistory(-1);
            e.Handled = true;
        }
        else if (e == Key.CursorDown)
        {
            NavigateHistory(1);
            e.Handled = true;
        }
    }

    private void AddToHistory(string text)
    {
        if (_commandHistory.Count > 0 && _commandHistory[^1] == text)
        {
            _historyIndex = -1;
            _historyStash = "";
            return;
        }

        _commandHistory.Add(text);

        if (_commandHistory.Count > _maxHistorySize)
        {
            _commandHistory.RemoveAt(0);
        }

        _historyIndex = -1;
        _historyStash = "";
    }

    private void NavigateHistory(int direction)
    {
        if (_commandHistory.Count == 0)
        {
            return;
        }

        if (_historyIndex == -1 && direction == 1)
        {
            return;
        }

        if (_historyIndex == -1)
        {
            _historyStash = _inputField.Text ?? "";
            _historyIndex = _commandHistory.Count;
        }

        var newIndex = _historyIndex + direction;

        if (newIndex < 0)
        {
            return;
        }

        if (newIndex >= _commandHistory.Count)
        {
            _inputField.Text = _historyStash;
            _historyIndex = -1;
            _historyStash = "";
            return;
        }

        _historyIndex = newIndex;
        _inputField.Text = _commandHistory[_historyIndex];
    }

    private async Task HandleReconnectAsync()
    {
        AddSystemMessage("Forcing reconnect...");
        await _connection.DisconnectAsync();
        await _connection.ConnectAsync();
    }

    private void ClearMessages()
    {
        _messageView.ClearMessages();
        AddSystemMessage("Messages cleared");
    }

    private async Task HandlePromptAsync(string text)
    {
        if (!_draftActive)
        {
            AddSystemMessage("No active draft session. Use /draft <role> to start one.");
            return;
        }

        AddMessage("user", "you", text);

        if (_connection.ConnectionState != ConnectionState.Connected)
        {
            AddMessage("error", "system", "Not connected to harness");
            return;
        }

        try
        {
            var result = await _connection.SubmitPromptAsync(text, _currentRole, _currentTask);
            App?.Invoke(() => AddMessage("lifecycle", "system", $"Submitted → task: {result.TaskSlug}, thread: {result.ThreadId}"));
        }
        catch (Exception ex)
        {
            App?.Invoke(() => AddMessage("error", "system", $"Failed to submit: {ex.Message}"));
        }
    }

    private async Task HandleCommandAsync(string input)
    {
        var parts = input.Split(' ', 2);
        var command = parts[0].ToLowerInvariant();
        var arg = parts.Length > 1 ? parts[1].Trim() : null;

        switch (command)
        {
            case "/agents":
                await HandleAgentsCommandAsync();
                break;

            case "/tasks":
                await HandleTasksCommandAsync();
                break;

            case "/kill":
                if (arg is null)
                {
                    AddSystemMessage("Usage: /kill <agentId>");
                    break;
                }
                await HandleKillCommandAsync(arg);
                break;

            case "/draft":
                if (arg is null)
                {
                    AddSystemMessage("Usage: /draft <role>");
                    break;
                }
                await HandleDraftCommandAsync(arg);
                break;

            case "/undraft":
                await HandleUndraftCommandAsync();
                break;

            case "/context":
                if (arg is null)
                {
                    if (_draftActive)
                    {
                        await HandleDraftContextCommandAsync();
                    }
                    else
                    {
                        AddSystemMessage("Usage: /context <slug>");
                    }
                    break;
                }
                await HandleContextCommandAsync(arg);
                break;

            case "/role":
                HandleRoleCommand(arg);
                break;

            case "/task":
                HandleTaskCommand(arg);
                break;

            case "/filter":
                HandleFilterCommand(arg);
                break;

            case "/clear":
                ClearMessages();
                break;

            case "/reconnect":
                await HandleReconnectAsync();
                break;

            case "/help":
                ShowHelp();
                break;

            case "/quit":
                App?.RequestStop();
                break;

            default:
                AddSystemMessage($"Unknown command: {command}. Type /help for available commands.");
                break;
        }
    }

    private async Task HandleAgentsCommandAsync()
    {
        try
        {
            var result = await _connection.ListAgentsAsync();

            App?.Invoke(() =>
            {
                if (result.Agents.Length == 0)
                {
                    AddSystemMessage("No active agents");
                }
                else
                {
                    AddSystemMessage($"Active agents ({result.Agents.Length}):");
                    foreach (var agent in result.Agents)
                    {
                        AddSystemMessage($"  {agent.Id} — {agent.Role} — {agent.TaskSlug} — since {agent.StartedAt}");
                    }
                }
            });
        }
        catch (Exception ex)
        {
            App?.Invoke(() => AddMessage("error", "system", $"Failed to list agents: {ex.Message}"));
        }
    }

    private async Task HandleTasksCommandAsync()
    {
        try
        {
            var result = await _connection.ListTasksAsync();

            App?.Invoke(() =>
            {
                if (result.Tasks.Length == 0)
                {
                    AddSystemMessage("No tasks");
                }
                else
                {
                    AddSystemMessage($"Tasks ({result.Tasks.Length}):");
                    foreach (var task in result.Tasks)
                    {
                        AddSystemMessage($"  {task.Slug} — {task.Description} — {task.DispatchCount} dispatches — {task.Created}");
                    }
                }
            });
        }
        catch (Exception ex)
        {
            App?.Invoke(() => AddMessage("error", "system", $"Failed to list tasks: {ex.Message}"));
        }
    }

    private async Task HandleKillCommandAsync(string agentId)
    {
        try
        {
            var result = await _connection.KillAgentAsync(agentId);
            App?.Invoke(() => AddSystemMessage(result.Message));
        }
        catch (Exception ex)
        {
            App?.Invoke(() => AddMessage("error", "system", $"Failed to kill agent: {ex.Message}"));
        }
    }

    private async Task HandleContextCommandAsync(string slug)
    {
        try
        {
            var result = await _connection.GetTaskContextAsync(slug);

            App?.Invoke(() =>
            {
                AddSystemMessage($"Context for task '{slug}':");
                foreach (var line in result.Context.Split('\n'))
                {
                    AddSystemMessage($"  {line}");
                }
            });
        }
        catch (Exception ex)
        {
            App?.Invoke(() => AddMessage("error", "system", $"Failed to get context: {ex.Message}"));
        }
    }

    private async Task HandleDraftCommandAsync(string roleName)
    {
        if (_draftActive)
        {
            AddMessage("error", "system", "Draft already active. Use /undraft first.");
            return;
        }

        try
        {
            var result = await _connection.DraftAsync(roleName);
            App?.Invoke(() =>
            {
                _draftActive = true;
                _draftRole = roleName;
                _draftTurnCount = 0;
                _draftCostUsd = 0;
                _draftContextPct = 0;
                _currentRole = null;
                _currentTask = null;
                UpdateTitle();
                AddMessage("lifecycle", "system", $"Drafted {roleName} — task: {result.TaskSlug}");
                AddSystemMessage("Type messages to converse. /undraft to end session.");
            });
        }
        catch (Exception ex)
        {
            App?.Invoke(() => AddMessage("error", "system", $"Failed to draft: {ex.Message}"));
        }
    }

    private async Task HandleUndraftCommandAsync()
    {
        if (!_draftActive)
        {
            AddSystemMessage("No active draft");
            return;
        }

        try
        {
            var result = await _connection.UndraftAsync();
            App?.Invoke(() =>
            {
                _draftActive = false;
                _draftRole = null;
                _draftTurnCount = 0;
                _draftCostUsd = 0;
                _draftContextPct = 0;
                UpdateTitle();

                var duration = TimeSpan.FromMilliseconds(result.DurationMs);
                var durationStr = duration.TotalMinutes >= 1
                    ? $"{duration.TotalMinutes:F1}m"
                    : $"{duration.TotalSeconds:F0}s";
                AddMessage("lifecycle", "system",
                    $"Draft ended — {result.Turns} turns, ${result.Cost:F2}, {durationStr}");
            });
        }
        catch (Exception ex)
        {
            App?.Invoke(() => AddMessage("error", "system", $"Failed to undraft: {ex.Message}"));
        }
    }

    private async Task HandleDraftContextCommandAsync()
    {
        try
        {
            var result = await _connection.GetDraftStatusAsync();
            App?.Invoke(() =>
            {
                if (!result.Active || result.Session is null)
                {
                    AddSystemMessage("No active draft");
                    return;
                }

                var s = result.Session;
                AddSystemMessage($"Draft: {s.Role} — task: {s.TaskSlug}");
                AddSystemMessage($"  Turns: {s.TurnCount}");
                AddSystemMessage($"  Cost: ${s.CostUsd:F2}");
                AddSystemMessage($"  Context: {s.ContextPct}% ({s.LastInputTokens:N0} / {s.ContextWindow:N0} tokens)");
                AddSystemMessage($"  Last activity: {s.LastActivity}");
            });
        }
        catch (Exception ex)
        {
            App?.Invoke(() => AddMessage("error", "system", $"Failed to get draft status: {ex.Message}"));
        }
    }

    private void HandleRoleCommand(string? role)
    {
        if (string.IsNullOrWhiteSpace(role))
        {
            _currentRole = null;
            AddSystemMessage("Role cleared");
        }
        else
        {
            _currentRole = role;
            AddSystemMessage($"Role set to: {role}");
        }

        UpdateTitle();
    }

    private void HandleTaskCommand(string? task)
    {
        if (string.IsNullOrWhiteSpace(task))
        {
            _currentTask = null;
            AddSystemMessage("Task cleared");
        }
        else
        {
            _currentTask = task;
            AddSystemMessage($"Task set to: {task}");
        }

        UpdateTitle();
    }

    private void HandleFilterCommand(string? level)
    {
        if (string.IsNullOrWhiteSpace(level))
        {
            AddSystemMessage($"Filter level: {_filterLevel.ToString().ToLowerInvariant()}");
            AddSystemMessage("Usage: /filter <minimal|feedback|verbose>");
            return;
        }

        if (Enum.TryParse<FilterLevel>(level, ignoreCase: true, out var parsed))
        {
            _filterLevel = parsed;
            AddSystemMessage($"Filter set to: {_filterLevel.ToString().ToLowerInvariant()}");
            UpdateTitle();
        }
        else
        {
            AddSystemMessage($"Unknown filter level: {level}. Use minimal, feedback, or verbose.");
        }
    }

    private void ShowHelp()
    {
        AddSystemMessage("Available commands:");
        AddSystemMessage("  /draft <role>    Draft an agent for conversation");
        AddSystemMessage("  /undraft         End the active draft session");
        AddSystemMessage("  /context         Show draft context metrics (or /context <slug> for task)");
        AddSystemMessage("  /agents          List active agents");
        AddSystemMessage("  /tasks           List tasks");
        AddSystemMessage("  /kill <id>       Kill an agent");
        AddSystemMessage("  /role <name>     Set default role (empty to clear)");
        AddSystemMessage("  /task <slug>     Set default task slug (empty to clear)");
        AddSystemMessage("  /filter <level>  Set filter (minimal|feedback|verbose)");
        AddSystemMessage("  /clear           Clear messages (or Ctrl+L)");
        AddSystemMessage("  /reconnect       Force reconnect");
        AddSystemMessage("  /help            Show this help");
        AddSystemMessage("  /quit            Exit");
        AddSystemMessage("");
        AddSystemMessage("Shortcuts: Ctrl+Q quit, Ctrl+L clear, Up/Down input history");
        AddSystemMessage("Type anything else to send as a prompt to the active draft session.");
    }

    private void UpdateTitle()
    {
        var indicator = _connection.ConnectionState switch
        {
            ConnectionState.Connected => "●",
            ConnectionState.Connecting => "◌",
            ConnectionState.Reconnecting => "◌",
            _ => "○"
        };
        var stateName = _connection.ConnectionState switch
        {
            ConnectionState.Reconnecting => "Reconnecting",
            _ => _connection.ConnectionState.ToString()
        };

        var leftParts = new List<string>();
        var rightParts = new List<string> { $"{indicator} {stateName}" };

        if (_draftActive && _draftRole is not null)
        {
            leftParts.Add($"Draft: {_draftRole}");
            leftParts.Add($"Context: {_draftContextPct}%");
            leftParts.Add($"Turns: {_draftTurnCount}");
            leftParts.Add($"${_draftCostUsd:F2}");
        }
        else
        {
            if (_agentCount > 0)
            {
                leftParts.Add($"Agents: {_agentCount}");
            }

            if (_currentRole is not null)
            {
                leftParts.Add($"Role: {_currentRole}");
            }

            if (_currentTask is not null)
            {
                leftParts.Add($"Task: {_currentTask}");
            }
        }

        if (_filterLevel != FilterLevel.Feedback)
        {
            leftParts.Add($"Filter: {_filterLevel.ToString().ToLowerInvariant()}");
        }

        var left = leftParts.Count > 0
            ? $"Collabot — {string.Join(" — ", leftParts)}"
            : "Collabot";
        var right = string.Join(" — ", rightParts);

        // Pad so connection status is right-aligned in the title bar
        var frameWidth = Frame.Width;
        var minWidth = left.Length + right.Length + 4; // 4 = border chars + spacing
        if (frameWidth > minWidth)
        {
            var gap = frameWidth - left.Length - right.Length - 4;
            Title = $"{left}{new string(' ', gap)}{right}";
        }
        else
        {
            Title = $"{left} — {right}";
        }
    }

    private void AddSystemMessage(string content) =>
        AddMessage("system", "", content);

    private void AddMessage(string type, string from, string content)
    {
        if (!PassesFilter(type)) return;
        _messageView.AddMessage(new ChatMessage(DateTime.Now, type, from, content));
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            Initialized -= OnWindowInitialized;
            _connection.ConnectionStateChanged -= OnConnectionStateChanged;
            _connection.ReconnectingIn -= OnReconnectingIn;
            _connection.ChannelMessageReceived -= OnChannelMessage;
            _connection.StatusUpdateReceived -= OnStatusUpdate;
            _connection.PoolStatusReceived -= OnPoolStatus;
            _connection.DraftStatusReceived -= OnDraftStatus;
            _connection.ContextCompactedReceived -= OnContextCompacted;
            _inputField.Accepting -= OnInputAccepted;
            _inputField.KeyDown -= OnInputKeyDown;
            _connection.Dispose();
        }

        base.Dispose(disposing);
    }
}
