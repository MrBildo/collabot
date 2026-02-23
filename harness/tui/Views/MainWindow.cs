using Terminal.Gui.App;
using Terminal.Gui.ViewBase;
using Terminal.Gui.Views;
using Terminal.Gui.Drawing;
using Terminal.Gui.Drivers;
using Terminal.Gui.Input;
using Collabot.Tui.Models;
using Collabot.Tui.Services;
using Attribute = Terminal.Gui.Drawing.Attribute;
using Color = Terminal.Gui.Drawing.Color;

namespace Collabot.Tui.Views;

public class MainWindow : Window
{
    private readonly HarnessConnection _connection;
    private readonly StatusHeaderView _statusHeader;
    private readonly MessageView _messageView;
    private readonly Line _topSeparator;
    private readonly Line _bottomSeparator;
    private readonly TextView _inputField;
    private readonly Label _inputPrompt;

    private string? _currentProject;
    private string? _currentRole;
    private string? _currentTask;
    private int _agentCount;
    private FilterLevel _filterLevel = FilterLevel.Feedback;

    private bool _draftActive;
    private string? _draftRole;
    private string? _draftProject;
    private int _draftTurnCount;
    private double _draftCostUsd;
    private int _draftContextPct;

    private readonly List<string> _commandHistory = [];
    private int _historyIndex = -1;
    private string _historyStash = "";

    private const int _maxHistorySize = 50;
    private int _inputLineCount = 1;
    private const int MaxInputLines = 10;

    public MainWindow()
    {
        Title = "";

        _connection = new HarnessConnection();
        _connection.ConnectionStateChanged += OnConnectionStateChanged;
        _connection.ReconnectingIn += OnReconnectingIn;
        _connection.ChannelMessageReceived += OnChannelMessage;
        _connection.StatusUpdateReceived += OnStatusUpdate;
        _connection.PoolStatusReceived += OnPoolStatus;
        _connection.DraftStatusReceived += OnDraftStatus;
        _connection.ContextCompactedReceived += OnContextCompacted;

        // Layout: Header(3) | Messages(fill) | TopSep(1) | Input(1+) | BottomSep(1) | StatusBar(1)
        // Initial bottom reservation = 1 input + 2 separators + 1 statusbar = 4 rows
        _statusHeader = new StatusHeaderView
        {
            X = 0,
            Y = 0
        };

        _messageView = new MessageView
        {
            X = 0,
            Y = Pos.Bottom(_statusHeader),
            Width = Dim.Fill(),
            Height = Dim.Fill(4)
        };

        _topSeparator = new Line
        {
            Orientation = Orientation.Horizontal,
            X = 0,
            Y = Pos.AnchorEnd(4),
            Width = Dim.Fill()
        };

        _inputPrompt = new Label
        {
            Text = "> ",
            X = 1,
            Y = Pos.AnchorEnd(3)
        };

        _inputField = new TextView
        {
            X = 3,
            Y = Pos.AnchorEnd(3),
            Width = Dim.Fill(1),
            Height = 1,
            WordWrap = true,
            TabKeyAddsTab = false
        };
        _inputField.KeyDown += OnInputKeyDown;
        _inputField.ContentsChanged += OnInputContentsChanged;

        _bottomSeparator = new Line
        {
            Orientation = Orientation.Horizontal,
            X = 0,
            Y = Pos.AnchorEnd(2),
            Width = Dim.Fill()
        };

        var statusBar = new StatusBar(
        [
            new Shortcut(Key.F1, "Help", ShowHelp),
            new Shortcut(Key.L.WithCtrl, "Clear", ClearMessages),
            new Shortcut(Key.Q.WithCtrl, "Quit", () => App?.RequestStop())
        ]);

        Add(_statusHeader, _messageView, _topSeparator, _inputPrompt, _inputField, _bottomSeparator, statusBar);

        Initialized += OnWindowInitialized;
    }

    private async void OnWindowInitialized(object? sender, EventArgs e)
    {
        ApplyInputStyling();
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
        AddBannerSubLine("        the collaborative agent platform");
        AddBannerSubLine("");
        AddBannerSubLine("/help for commands, Ctrl+Q quit, Ctrl+L clear");
    }

    private void AddBannerLine(string cyanPart, string orangePart) =>
        _messageView.AddMessage(new ChatMessage(DateTime.Now, "banner", "", cyanPart + "\t" + orangePart));

    private void AddBannerSubLine(string text) =>
        _messageView.AddMessage(new ChatMessage(DateTime.Now, "banner-sub", "", text));

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
            UpdateStatusHeader();

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
                _ = ShowProjectsOnConnectAsync();
            }
        });
    }

    private async Task ShowProjectsOnConnectAsync()
    {
        try
        {
            var result = await _connection.ListProjectsAsync();
            App?.Invoke(() =>
            {
                if (result.Projects.Length > 0)
                {
                    var names = string.Join(", ", result.Projects.Select(p => p.Name));
                    AddSystemMessage($"Projects: {names}");
                }
                else
                {
                    AddSystemMessage("No projects loaded. Use /project init <name> to create one.");
                }
            });
        }
        catch
        {
            // Best-effort
        }
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
                UpdateStatusHeader();
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
                    _draftProject = result.Session.Project;
                    _draftTurnCount = result.Session.TurnCount;
                    _draftCostUsd = result.Session.CostUsd;
                    _draftContextPct = result.Session.ContextPct;
                }
                else
                {
                    _draftActive = false;
                    _draftRole = null;
                    _draftProject = null;
                    _draftTurnCount = 0;
                    _draftCostUsd = 0;
                    _draftContextPct = 0;
                }

                UpdateStatusHeader();
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
            _draftProject = e.Project;
            _draftTurnCount = e.TurnCount;
            _draftCostUsd = e.CostUsd;
            _draftContextPct = e.ContextPct;
            UpdateStatusHeader();
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
            UpdateStatusHeader();
        });
    }

    private async void SubmitInput()
    {
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
        if (e == Key.L.WithCtrl)
        {
            ClearMessages();
            e.Handled = true;
        }
        else if (e == Key.Enter)
        {
            SubmitInput();
            e.Handled = true;
        }
        else if (e == Key.Enter.WithShift)
        {
            _inputField.InvokeCommand(Command.NewLine);
            e.Handled = true;
        }
        else if (e == Key.CursorUp && IsOnFirstLine())
        {
            NavigateHistory(-1);
            e.Handled = true;
        }
        else if (e == Key.CursorDown && IsOnLastLine())
        {
            NavigateHistory(1);
            e.Handled = true;
        }
    }

    private void OnInputContentsChanged(object? sender, ContentsChangedEventArgs e)
    {
        UpdateInputLayout();
    }

    private void UpdateInputLayout()
    {
        var lineCount = GetInputLineCount();
        var newHeight = Math.Clamp(lineCount, 1, MaxInputLines);

        if (newHeight != _inputLineCount)
        {
            _inputLineCount = newHeight;
            // Bottom reservation = input + 2 separators + 1 statusbar
            var bottomRows = _inputLineCount + 3;
            _inputField.Height = _inputLineCount;
            _topSeparator.Y = Pos.AnchorEnd(bottomRows);
            _inputPrompt.Y = Pos.AnchorEnd(bottomRows - 1);
            _inputField.Y = Pos.AnchorEnd(bottomRows - 1);
            // _bottomSeparator.Y stays at AnchorEnd(2)
            _messageView.Height = Dim.Fill(bottomRows);
            SetNeedsLayout();
            SetNeedsDraw();
        }
    }

    private int GetInputLineCount()
    {
        var text = _inputField.Text;
        if (string.IsNullOrEmpty(text)) return 1;
        var count = 1;
        foreach (var c in text)
            if (c == '\n') count++;
        return count;
    }

    private bool IsOnFirstLine() => _inputField.CurrentRow == 0;

    private bool IsOnLastLine() => _inputField.CurrentRow >= GetInputLineCount() - 1;

    private void ApplyInputStyling()
    {
        // Block cursor for the input field
        _inputField.Cursor = new Cursor { Style = CursorStyle.SteadyBlock };

        // Force the input to use the window's Normal background for ALL visual roles
        // (otherwise Focus/Editable roles swap to a black background)
        var windowScheme = GetScheme();
        var bg = windowScheme.Normal.Background;
        var fg = windowScheme.Normal.Foreground;
        var attr = new Attribute(fg, bg);
        var inputScheme = new Scheme
        {
            Normal = attr,
            Focus = attr,
            Editable = attr,
            HotNormal = attr,
            HotFocus = attr,
            Disabled = attr
        };
        _inputField.SetScheme(inputScheme);
        _inputPrompt.SetScheme(inputScheme);

        // Dim separators
        var sepAttr = new Attribute(new Color(60, 60, 60), bg);
        var sepScheme = new Scheme { Normal = sepAttr };
        _topSeparator.SetScheme(sepScheme);
        _bottomSeparator.SetScheme(sepScheme);
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
            if (_currentProject is null)
            {
                AddSystemMessage("No project selected. Use /project <name>");
                return;
            }

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
            var result = await _connection.SubmitPromptAsync(text, _currentRole, _currentTask, _currentProject);
            App?.Invoke(() => AddMessage("lifecycle", "system", $"Submitted \u2192 task: {result.TaskSlug}, thread: {result.ThreadId}"));
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
                await HandleTaskSubcommandAsync("list");
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

            case "/project":
                await HandleProjectCommandAsync(arg);
                break;

            case "/role":
                HandleRoleCommand(arg);
                break;

            case "/task":
                await HandleTaskCommandAsync(arg);
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

    private async Task HandleProjectCommandAsync(string? arg)
    {
        if (string.IsNullOrWhiteSpace(arg))
        {
            // Show current project or list available
            if (_currentProject is not null)
            {
                AddSystemMessage($"Current project: {_currentProject}");
            }
            else
            {
                try
                {
                    var result = await _connection.ListProjectsAsync();
                    App?.Invoke(() =>
                    {
                        if (result.Projects.Length > 0)
                        {
                            var names = string.Join(", ", result.Projects.Select(p => p.Name));
                            AddSystemMessage($"No project selected. Available: {names}");
                        }
                        else
                        {
                            AddSystemMessage("No project selected. No projects loaded. Use /project init <name>");
                        }
                    });
                }
                catch (Exception ex)
                {
                    App?.Invoke(() => AddMessage("error", "system", $"Failed to list projects: {ex.Message}"));
                }
            }
            return;
        }

        var subParts = arg.Split(' ', 2);
        var subcommand = subParts[0].ToLowerInvariant();

        switch (subcommand)
        {
            case "init":
                {
                    var name = subParts.Length > 1 ? subParts[1].Trim() : null;
                    if (string.IsNullOrWhiteSpace(name))
                    {
                        AddSystemMessage("Usage: /project init <name>");
                        return;
                    }
                    await HandleProjectInitAsync(name);
                }
                break;

            case "reload":
                await HandleProjectReloadAsync();
                break;

            default:
                // Treat as project name selection
                await HandleProjectSelectAsync(arg);
                break;
        }
    }

    private async Task HandleProjectSelectAsync(string name)
    {
        try
        {
            var result = await _connection.ListProjectsAsync();
            App?.Invoke(() =>
            {
                var match = result.Projects.FirstOrDefault(
                    p => p.Name.Equals(name, StringComparison.OrdinalIgnoreCase));

                if (match is null)
                {
                    var available = result.Projects.Length > 0
                        ? string.Join(", ", result.Projects.Select(p => p.Name))
                        : "(none)";
                    AddSystemMessage($"Project \"{name}\" not found. Available: {available}");
                }
                else
                {
                    _currentProject = match.Name;
                    UpdateStatusHeader();
                    AddSystemMessage($"Project set to: {match.Name}");
                }
            });
        }
        catch (Exception ex)
        {
            App?.Invoke(() => AddMessage("error", "system", $"Failed to list projects: {ex.Message}"));
        }
    }

    private async Task HandleProjectInitAsync(string name)
    {
        try
        {
            var result = await _connection.CreateProjectAsync(name, name, []);
            App?.Invoke(() =>
            {
                AddSystemMessage($"Project \"{result.Name}\" scaffolded with roles: {string.Join(", ", result.Roles)}");
                AddSystemMessage($"Edit .projects/{result.Name.ToLowerInvariant()}/project.yaml to add paths, then /project reload.");
            });
        }
        catch (Exception ex)
        {
            App?.Invoke(() => AddMessage("error", "system", $"Failed to create project: {ex.Message}"));
        }
    }

    private async Task HandleProjectReloadAsync()
    {
        try
        {
            var result = await _connection.ReloadProjectsAsync();
            App?.Invoke(() =>
            {
                if (result.Projects.Length > 0)
                {
                    var names = string.Join(", ", result.Projects.Select(p => p.Name));
                    AddSystemMessage($"Projects reloaded: {names}");
                }
                else
                {
                    AddSystemMessage("Projects reloaded: (none)");
                }

                // Clear current project if it no longer exists
                if (_currentProject is not null &&
                    !result.Projects.Any(p => p.Name.Equals(_currentProject, StringComparison.OrdinalIgnoreCase)))
                {
                    _currentProject = null;
                    AddSystemMessage("Current project no longer exists after reload — cleared.");
                }

                UpdateStatusHeader();
            });
        }
        catch (Exception ex)
        {
            App?.Invoke(() => AddMessage("error", "system", $"Failed to reload projects: {ex.Message}"));
        }
    }

    private async Task HandleTaskCommandAsync(string? arg)
    {
        if (string.IsNullOrWhiteSpace(arg))
        {
            // Show current task
            if (_currentTask is not null)
            {
                AddSystemMessage($"Current task: {_currentTask}");
            }
            else
            {
                AddSystemMessage("No task selected");
            }
            return;
        }

        var subParts = arg.Split(' ', 2);
        var subcommand = subParts[0].ToLowerInvariant();

        switch (subcommand)
        {
            case "list":
                await HandleTaskSubcommandAsync("list");
                break;

            case "create":
                {
                    var name = subParts.Length > 1 ? subParts[1].Trim() : null;
                    if (string.IsNullOrWhiteSpace(name))
                    {
                        AddSystemMessage("Usage: /task create <name>");
                        return;
                    }
                    await HandleTaskCreateAsync(name);
                }
                break;

            case "close":
                {
                    var slug = subParts.Length > 1 ? subParts[1].Trim() : _currentTask;
                    if (string.IsNullOrWhiteSpace(slug))
                    {
                        AddSystemMessage("Usage: /task close [slug] (or set a current task first)");
                        return;
                    }
                    await HandleTaskCloseAsync(slug);
                }
                break;

            case "clear":
                _currentTask = null;
                AddSystemMessage("Task cleared");
                UpdateStatusHeader();
                break;

            default:
                // Treat as slug selection
                _currentTask = arg;
                AddSystemMessage($"Task set to: {arg}");
                UpdateStatusHeader();
                break;
        }
    }

    private async Task HandleTaskSubcommandAsync(string _)
    {
        if (_currentProject is null)
        {
            AddSystemMessage("No project selected. Use /project <name> first.");
            return;
        }

        try
        {
            var result = await _connection.ListTasksAsync(_currentProject);

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
                        AddSystemMessage($"  [{task.Status}] {task.Slug} \u2014 {task.Name} \u2014 {task.DispatchCount} dispatches \u2014 {task.Created}");
                    }
                }
            });
        }
        catch (Exception ex)
        {
            App?.Invoke(() => AddMessage("error", "system", $"Failed to list tasks: {ex.Message}"));
        }
    }

    private async Task HandleTaskCreateAsync(string name)
    {
        if (_currentProject is null)
        {
            AddSystemMessage("No project selected. Use /project <name> first.");
            return;
        }

        try
        {
            var result = await _connection.CreateTaskAsync(_currentProject, name);
            App?.Invoke(() =>
            {
                _currentTask = result.Slug;
                UpdateStatusHeader();
                AddSystemMessage($"Task created: {result.Slug}");
            });
        }
        catch (Exception ex)
        {
            App?.Invoke(() => AddMessage("error", "system", $"Failed to create task: {ex.Message}"));
        }
    }

    private async Task HandleTaskCloseAsync(string slug)
    {
        if (_currentProject is null)
        {
            AddSystemMessage("No project selected. Use /project <name> first.");
            return;
        }

        try
        {
            await _connection.CloseTaskAsync(_currentProject, slug);
            App?.Invoke(() =>
            {
                AddSystemMessage($"Task closed: {slug}");
                if (_currentTask == slug)
                {
                    _currentTask = null;
                    UpdateStatusHeader();
                }
            });
        }
        catch (Exception ex)
        {
            App?.Invoke(() => AddMessage("error", "system", $"Failed to close task: {ex.Message}"));
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
                        AddSystemMessage($"  {agent.Id} \u2014 {agent.Role} \u2014 {agent.TaskSlug} \u2014 since {agent.StartedAt}");
                    }
                }
            });
        }
        catch (Exception ex)
        {
            App?.Invoke(() => AddMessage("error", "system", $"Failed to list agents: {ex.Message}"));
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
        if (_currentProject is null)
        {
            AddSystemMessage("No project selected. Use /project <name> first.");
            return;
        }

        try
        {
            var result = await _connection.GetTaskContextAsync(slug, _currentProject);

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

        if (_currentProject is null)
        {
            AddMessage("error", "system", "No project selected. Use /project <name> first.");
            return;
        }

        try
        {
            var result = await _connection.DraftAsync(roleName, _currentProject, _currentTask);
            App?.Invoke(() =>
            {
                _draftActive = true;
                _draftRole = roleName;
                _draftProject = result.Project;
                _draftTurnCount = 0;
                _draftCostUsd = 0;
                _draftContextPct = 0;
                _currentRole = null;
                UpdateStatusHeader();
                AddMessage("lifecycle", "system", $"Drafted {roleName} @ {result.Project} \u2014 task: {result.TaskSlug}");
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
                _draftProject = null;
                _draftTurnCount = 0;
                _draftCostUsd = 0;
                _draftContextPct = 0;
                UpdateStatusHeader();

                var duration = TimeSpan.FromMilliseconds(result.DurationMs);
                var durationStr = duration.TotalMinutes >= 1
                    ? $"{duration.TotalMinutes:F1}m"
                    : $"{duration.TotalSeconds:F0}s";
                AddMessage("lifecycle", "system",
                    $"Draft ended \u2014 {result.Turns} turns, ${result.Cost:F2}, {durationStr}");
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
                AddSystemMessage($"Draft: {s.Role} @ {s.Project} \u2014 task: {s.TaskSlug}");
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

        UpdateStatusHeader();
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
            UpdateStatusHeader();
        }
        else
        {
            AddSystemMessage($"Unknown filter level: {level}. Use minimal, feedback, or verbose.");
        }
    }

    private void ShowHelp()
    {
        AddSystemMessage("Available commands:");
        AddSystemMessage("  /project [name]       Set active project (empty to show current)");
        AddSystemMessage("  /project init <name>  Scaffold a new project (edit YAML to add paths)");
        AddSystemMessage("  /project reload       Reload projects from disk");
        AddSystemMessage("  /draft <role>         Draft an agent (requires project)");
        AddSystemMessage("  /undraft              End the active draft session");
        AddSystemMessage("  /context              Show draft metrics (or /context <slug>)");
        AddSystemMessage("  /agents               List active agents");
        AddSystemMessage("  /task                 Show current task");
        AddSystemMessage("  /task <slug>          Set active task");
        AddSystemMessage("  /task list            List tasks in project");
        AddSystemMessage("  /task create <name>   Create a task in project");
        AddSystemMessage("  /task close [slug]    Close a task");
        AddSystemMessage("  /task clear           Clear current task");
        AddSystemMessage("  /kill <id>            Kill an agent");
        AddSystemMessage("  /role <name>          Set default role (empty to clear)");
        AddSystemMessage("  /filter <level>       Set filter (minimal|feedback|verbose)");
        AddSystemMessage("  /clear                Clear messages (or Ctrl+L)");
        AddSystemMessage("  /reconnect            Force reconnect");
        AddSystemMessage("  /help                 Show this help");
        AddSystemMessage("  /quit                 Exit");
        AddSystemMessage("");
        AddSystemMessage("Shortcuts: Ctrl+Q quit, Ctrl+L clear, Up/Down history, Shift+Enter newline");
        AddSystemMessage("Type anything else to send as a prompt to the active draft session.");
    }

    private void UpdateStatusHeader()
    {
        var stateName = _connection.ConnectionState switch
        {
            ConnectionState.Reconnecting => "Reconnecting",
            _ => _connection.ConnectionState.ToString()
        };

        var leftParts = new List<string>();

        if (_draftActive && _draftRole is not null)
        {
            var draftLabel = _draftProject is not null
                ? $"Draft: {_draftRole} @ {_draftProject}"
                : $"Draft: {_draftRole}";
            leftParts.Add(draftLabel);
            leftParts.Add($"Context: {_draftContextPct}%");
            leftParts.Add($"Turns: {_draftTurnCount}");
            leftParts.Add($"${_draftCostUsd:F2}");
        }
        else
        {
            if (_currentProject is not null)
            {
                leftParts.Add($"Project: {_currentProject}");
            }

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
            ? $"Collabot \u2014 {string.Join(" \u2014 ", leftParts)}"
            : "Collabot";

        _statusHeader.Update(left, stateName, _connection.ConnectionState);
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
            _inputField.KeyDown -= OnInputKeyDown;
            _inputField.ContentsChanged -= OnInputContentsChanged;
            _connection.Dispose();
        }

        base.Dispose(disposing);
    }
}
