using System.Drawing;
using System.Text;
using Terminal.Gui.ViewBase;
using Terminal.Gui.Drawing;
using Terminal.Gui.Input;
using Collabot.Tui.Models;
using Collabot.Tui.Rendering;
using Attribute = Terminal.Gui.Drawing.Attribute;
using Color = Terminal.Gui.Drawing.Color;

namespace Collabot.Tui.Views;

public class MessageView : View, IDisposable
{
    private readonly List<ChatMessage> _messages = [];
    private readonly List<DisplayLine> _displayLines = [];
    private int _lastWrapWidth;
    private bool _autoScroll = true;

    private const int TimestampIndent = 11; // "[HH:mm:ss] "
    private const int ScrollSpeed = 3;

    // Working indicator
    private static readonly string[] SpinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    private static readonly string[] WorkingMessages =
        ["Thinking...", "Collaborating...", "Analyzing...", "Reasoning...", "Working on it...", "Processing..."];
    private bool _isWorking;
    private int _spinnerFrame;
    private object? _spinnerTimer;
    private DateTime _workingStartTime;
    private int _workingMessageIndex;

    // Text selection
    private bool _isSelecting;
    private (int Line, int Col)? _selectionStart;
    private (int Line, int Col)? _selectionEnd;

    public event Action? SelectionCopied;

    /// <summary>Maximum messages to retain. 0 = unlimited. When exceeded, oldest 20% are pruned.</summary>
    public int MaxMessages { get; set; } = 10_000;

    private record DisplayLine(int MessageIndex, string Text, IReadOnlyList<StyledRun>? Runs = null);

    public MessageView()
    {
        CanFocus = true;
        ViewportSettings |= ViewportSettingsFlags.HasVerticalScrollBar;

        KeyBindings.Add(Key.CursorUp, Command.ScrollUp);
        KeyBindings.Add(Key.CursorDown, Command.ScrollDown);
        KeyBindings.Add(Key.PageUp, Command.PageUp);
        KeyBindings.Add(Key.PageDown, Command.PageDown);

        MouseBindings.Add(MouseFlags.WheeledUp, Command.ScrollUp);
        MouseBindings.Add(MouseFlags.WheeledDown, Command.ScrollDown);

        AddCommand(Command.ScrollUp, () =>
        {
            ScrollVertical(-ScrollSpeed);
            _autoScroll = false;
            return true;
        });

        AddCommand(Command.ScrollDown, () =>
        {
            ScrollVertical(ScrollSpeed);
            CheckAutoScrollRestore();
            return true;
        });

        AddCommand(Command.PageUp, () =>
        {
            ScrollVertical(-Viewport.Height);
            _autoScroll = false;
            return true;
        });

        AddCommand(Command.PageDown, () =>
        {
            ScrollVertical(Viewport.Height);
            CheckAutoScrollRestore();
            return true;
        });

        KeyBindings.Add(Key.C.WithCtrl, Command.Copy);
        AddCommand(Command.Copy, () =>
        {
            if (HasSelection)
            {
                CopySelectionToClipboard();
                SelectionCopied?.Invoke();
            }
            return true;
        });

    }

    public void AddMessage(ChatMessage message)
    {
        _messages.Add(message);
        var width = GetWrapWidth();
        WrapMessage(_messages.Count - 1, width);

        if (MaxMessages > 0 && _messages.Count > MaxMessages)
        {
            PruneOldMessages();
        }

        UpdateContentSize();

        if (_autoScroll)
        {
            ScrollToEnd();
        }

        SetNeedsDraw();
    }

    public void ClearMessages()
    {
        _messages.Clear();
        _displayLines.Clear();
        _lastWrapWidth = 0;
        _autoScroll = true;
        UpdateContentSize();
        SetNeedsDraw();
    }

    private void PruneOldMessages()
    {
        var targetCount = (int)(MaxMessages * 0.8);
        var removeCount = _messages.Count - targetCount;
        if (removeCount <= 0) return;

        _messages.RemoveRange(0, removeCount);
        RewrapAll();
    }

    private int GetWrapWidth() => Viewport.Width > 0 ? Viewport.Width : 80;

    private void RewrapAll()
    {
        ClearSelection();
        _displayLines.Clear();
        var width = GetWrapWidth();

        for (var i = 0; i < _messages.Count; i++)
        {
            WrapMessage(i, width);
        }

        _lastWrapWidth = width;
        UpdateContentSize();
    }

    private static readonly HashSet<string> MarkdownTypes = new(StringComparer.OrdinalIgnoreCase) { "chat", "result" };

    private void WrapMessage(int index, int width)
    {
        var msg = _messages[index];
        var text = msg.ToString();

        // Banner lines are pre-formatted — never word-wrap
        if (msg.Type is "banner" or "banner-sub")
        {
            _displayLines.Add(new DisplayLine(index, text));
            return;
        }

        if (width <= 0)
        {
            width = 80;
        }

        // Markdown rendering for chat/result messages
        if (MarkdownTypes.Contains(msg.Type))
        {
            WrapMarkdownMessage(index, msg, width);
            return;
        }

        if (TextHelpers.DisplayWidth(text) <= width)
        {
            _displayLines.Add(new DisplayLine(index, text));
            return;
        }

        // First line: full width
        var firstBreak = TextHelpers.FindWordBreakByColumns(text, width);
        _displayLines.Add(new DisplayLine(index, text[..firstBreak]));
        var remaining = text[firstBreak..].TrimStart();

        // Continuation lines: indented past timestamp
        var indent = new string(' ', TimestampIndent);
        var contWidth = Math.Max(width - TimestampIndent, 20);

        while (remaining.Length > 0)
        {
            if (TextHelpers.DisplayWidth(remaining) <= contWidth)
            {
                _displayLines.Add(new DisplayLine(index, indent + remaining));
                break;
            }

            var breakAt = TextHelpers.FindWordBreakByColumns(remaining, contWidth);
            _displayLines.Add(new DisplayLine(index, indent + remaining[..breakAt]));
            remaining = remaining[breakAt..].TrimStart();
        }
    }

    private void WrapMarkdownMessage(int index, ChatMessage msg, int width)
    {
        var bg = GetAttributeForRole(VisualRole.Normal).Background;
        var baseAttr = GetMessageAttribute(msg.Type, bg);

        // Build timestamp prefix: "[HH:mm:ss] [from] "
        var prefix = msg.Type switch
        {
            "user" => $"[{msg.Timestamp:HH:mm:ss}] > ",
            _ when !string.IsNullOrEmpty(msg.From) => $"[{msg.Timestamp:HH:mm:ss}] [{msg.From}] ",
            _ => $"[{msg.Timestamp:HH:mm:ss}] "
        };

        // Continuation lines use TimestampIndent, not full prefix width
        var contentWidth = Math.Max(width - TimestampIndent, 20);

        // Render markdown content
        var mdLines = Rendering.MarkdownRenderer.Render(msg.Content, contentWidth, bg, baseAttr);

        if (mdLines.Count == 0)
        {
            _displayLines.Add(new DisplayLine(index, prefix, [new StyledRun(prefix, baseAttr)]));
            return;
        }

        // First line: prepend timestamp prefix
        var firstMd = mdLines[0];
        var firstRuns = new List<StyledRun> { new(prefix, baseAttr) };
        firstRuns.AddRange(firstMd.Runs);
        _displayLines.Add(new DisplayLine(index, prefix + firstMd.Text, firstRuns));

        // Continuation lines: indent past timestamp only
        var indent = new string(' ', TimestampIndent);
        for (var i = 1; i < mdLines.Count; i++)
        {
            var md = mdLines[i];
            var runs = new List<StyledRun> { new(indent) };
            runs.AddRange(md.Runs);
            _displayLines.Add(new DisplayLine(index, indent + md.Text, runs));
        }
    }

    private void UpdateContentSize()
    {
        var width = GetWrapWidth();
        SetContentSize(new Size(width, Math.Max(_displayLines.Count, 1)));
    }

    private void ScrollToEnd()
    {
        var maxY = Math.Max(0, _displayLines.Count - Viewport.Height);
        Viewport = Viewport with { Location = new Point(0, maxY) };
    }

    private void CheckAutoScrollRestore()
    {
        var maxY = Math.Max(0, _displayLines.Count - Viewport.Height);

        if (Viewport.Y >= maxY)
        {
            _autoScroll = true;
        }
    }

    protected override bool OnDrawingContent(DrawContext? context)
    {
        var width = GetWrapWidth();

        if (width != _lastWrapWidth && _messages.Count > 0)
        {
            RewrapAll();

            if (_autoScroll)
            {
                ScrollToEnd();
            }
        }

        _lastWrapWidth = width;

        var bg = GetAttributeForRole(VisualRole.Normal).Background;
        var startIndex = Viewport.Y;

        for (var row = 0; row < Viewport.Height; row++)
        {
            var lineIndex = startIndex + row;
            Move(0, row);

            if (lineIndex >= _displayLines.Count)
            {
                SetAttributeForRole(VisualRole.Normal);
                AddStr(new string(' ', width));
                continue;
            }

            var displayLine = _displayLines[lineIndex];
            var msg = _messages[displayLine.MessageIndex];

            if (msg.Type == "banner")
            {
                var parts = displayLine.Text.Split('\t', 2);
                var cyanPart = parts[0];
                var orangePart = parts.Length > 1 ? parts[1] : "";

                SetAttribute(new Attribute(new Color(0, 180, 255), bg));
                AddStr(cyanPart);

                if (orangePart.Length > 0)
                {
                    SetAttribute(new Attribute(new Color(255, 160, 0), bg));
                    AddStr(orangePart);
                }

                var totalLen = TextHelpers.DisplayWidth(cyanPart) + TextHelpers.DisplayWidth(orangePart);
                if (totalLen < width)
                {
                    SetAttributeForRole(VisualRole.Normal);
                    AddStr(new string(' ', width - totalLen));
                }

                continue;
            }

            if (msg.Type == "banner-sub")
            {
                SetAttribute(new Attribute(new Color(140, 140, 140), bg));
                var subText = TextHelpers.DisplayWidth(displayLine.Text) > width
                    ? TextHelpers.TruncateToWidth(displayLine.Text, width)
                    : TextHelpers.PadToWidth(displayLine.Text, width);
                AddStr(subText);
                continue;
            }

            if (displayLine.Runs is not null)
            {
                // Styled rendering: iterate runs
                var col = 0;
                foreach (var run in displayLine.Runs)
                {
                    var text = run.Text;
                    var textWidth = TextHelpers.DisplayWidth(text);
                    if (col + textWidth > width)
                        text = TextHelpers.TruncateToWidth(text, width - col);

                    SetAttribute(run.Style ?? GetMessageAttribute(msg.Type, bg));
                    AddStr(text);
                    col += TextHelpers.DisplayWidth(text);

                    if (col >= width) break;
                }

                // Pad remainder
                if (col < width)
                {
                    SetAttributeForRole(VisualRole.Normal);
                    AddStr(new string(' ', width - col));
                }
            }
            else
            {
                SetAttribute(GetMessageAttribute(msg.Type, bg));

                var lineText = displayLine.Text;

                if (TextHelpers.DisplayWidth(lineText) > width)
                {
                    lineText = TextHelpers.TruncateToWidth(lineText, width);
                }
                else
                {
                    lineText = TextHelpers.PadToWidth(lineText, width);
                }

                AddStr(lineText);
            }

            // Selection overlay for this row
            DrawSelectionOverlay(row, lineIndex, width, bg);
        }

        if (_isWorking)
        {
            DrawWorkingIndicator(width, bg);
        }

        return true;
    }

    public void StartWorking()
    {
        if (_isWorking) return;
        _isWorking = true;
        _spinnerFrame = 0;
        _workingStartTime = DateTime.Now;
        _workingMessageIndex = (_workingMessageIndex + 1) % WorkingMessages.Length;

        _spinnerTimer = App?.AddTimeout(TimeSpan.FromMilliseconds(150), () =>
        {
            if (!_isWorking) return false;
            _spinnerFrame = (_spinnerFrame + 1) % SpinnerFrames.Length;
            SetNeedsDraw();
            return true;
        });
    }

    public void StopWorking()
    {
        if (!_isWorking) return;
        _isWorking = false;
        if (_spinnerTimer is not null)
        {
            App?.RemoveTimeout(_spinnerTimer);
            _spinnerTimer = null;
        }
        SetNeedsDraw();
    }

    private static string FormatElapsed(TimeSpan elapsed)
    {
        if (elapsed.TotalHours >= 1)
            return $"{(int)elapsed.TotalHours}h {elapsed.Minutes}m";
        if (elapsed.TotalMinutes >= 1)
            return $"{(int)elapsed.TotalMinutes}m {elapsed.Seconds:D2}s";
        return $"{(int)elapsed.TotalSeconds}s";
    }

    private void DrawWorkingIndicator(int width, Color bg)
    {
        // Blank line + indicator line, right after last display line
        var blankLine = _displayLines.Count;
        var indicatorLine = blankLine + 1;
        var blankRow = blankLine - Viewport.Y;
        var indicatorRow = indicatorLine - Viewport.Y;

        // Clear the blank row if visible
        if (blankRow >= 0 && blankRow < Viewport.Height)
        {
            Move(0, blankRow);
            SetAttributeForRole(VisualRole.Normal);
            AddStr(new string(' ', width));
        }

        if (indicatorRow < 0 || indicatorRow >= Viewport.Height) return;

        Move(0, indicatorRow);

        var spinner = SpinnerFrames[_spinnerFrame] + " ";
        var message = WorkingMessages[_workingMessageIndex];
        var elapsed = FormatElapsed(DateTime.Now - _workingStartTime);
        var timeStr = $"  ({elapsed})";

        var spinnerAttr = new Attribute(new Color(255, 160, 0), bg);
        var messageAttr = new Attribute(new Color(140, 140, 140), bg);
        var timeAttr = new Attribute(new Color(100, 100, 100), bg);

        SetAttribute(spinnerAttr);
        AddStr(spinner);

        SetAttribute(messageAttr);
        AddStr(message);

        SetAttribute(timeAttr);
        AddStr(timeStr);

        var used = TextHelpers.DisplayWidth(spinner) + TextHelpers.DisplayWidth(message) + TextHelpers.DisplayWidth(timeStr);
        if (used < width)
        {
            SetAttributeForRole(VisualRole.Normal);
            AddStr(new string(' ', width - used));
        }
    }

    // --- Text selection ---

    protected override bool OnMouseEvent(Mouse mouse)
    {
        if (mouse.Position is not { } pos) return base.OnMouseEvent(mouse);

        var flags = mouse.Flags;
        var line = Viewport.Y + pos.Y;
        var col = pos.X;

        // Handle ongoing drag FIRST — drag events have both PositionReport and LeftButtonPressed
        if (_isSelecting && flags.HasFlag(MouseFlags.PositionReport))
        {
            _selectionEnd = (line, col);
            SetNeedsDraw();
            return true;
        }

        // Start new selection on fresh press (not already dragging)
        if (flags.HasFlag(MouseFlags.LeftButtonPressed) && !_isSelecting)
        {
            _isSelecting = true;
            _selectionStart = (line, col);
            _selectionEnd = (line, col);
            App?.Mouse.GrabMouse(this);
            SetNeedsDraw();
            return true;
        }

        // End selection on release
        if (flags.HasFlag(MouseFlags.LeftButtonReleased) && _isSelecting)
        {
            _selectionEnd = (line, col);
            _isSelecting = false;
            App?.Mouse.UngrabMouse();
            SetNeedsDraw();
            return true;
        }

        return base.OnMouseEvent(mouse);
    }

    private void ClearSelection()
    {
        _selectionStart = null;
        _selectionEnd = null;
        _isSelecting = false;
    }

    private ((int Line, int Col) Start, (int Line, int Col) End)? GetNormalizedSelection()
    {
        if (_selectionStart is null || _selectionEnd is null) return null;

        var s = _selectionStart.Value;
        var e = _selectionEnd.Value;

        // Normalize so start <= end
        if (s.Line > e.Line || (s.Line == e.Line && s.Col > e.Col))
            (s, e) = (e, s);

        return (s, e);
    }

    private bool IsInSelection(int lineIndex, int col)
    {
        var sel = GetNormalizedSelection();
        if (sel is null) return false;

        var (s, e) = sel.Value;

        if (lineIndex < s.Line || lineIndex > e.Line) return false;
        if (lineIndex == s.Line && lineIndex == e.Line)
            return col >= s.Col && col < e.Col;
        if (lineIndex == s.Line) return col >= s.Col;
        if (lineIndex == e.Line) return col < e.Col;
        return true; // middle lines fully selected
    }

    public bool HasSelection => _selectionStart is not null && _selectionEnd is not null
        && _selectionStart != _selectionEnd;

    public void CopySelectionToClipboard()
    {
        var sel = GetNormalizedSelection();
        if (sel is null) return;

        var (s, e) = sel.Value;
        var sb = new StringBuilder();

        for (var line = s.Line; line <= e.Line && line < _displayLines.Count; line++)
        {
            var text = _displayLines[line].Text;
            var startCol = line == s.Line ? s.Col : 0;
            var endCol = line == e.Line ? e.Col : text.Length;

            startCol = Math.Max(0, Math.Min(startCol, text.Length));
            endCol = Math.Max(startCol, Math.Min(endCol, text.Length));

            if (startCol < endCol)
                sb.Append(text[startCol..endCol]);

            if (line < e.Line)
                sb.AppendLine();
        }

        var clipText = sb.ToString();
        if (!string.IsNullOrEmpty(clipText))
        {
            App?.Clipboard?.TrySetClipboardData(clipText);
        }

        ClearSelection();
        SetNeedsDraw();
    }

    private void DrawSelectionOverlay(int row, int lineIndex, int width, Color bg)
    {
        var sel = GetNormalizedSelection();
        if (sel is null) return;

        var (s, e) = sel.Value;
        if (lineIndex < s.Line || lineIndex > e.Line) return;

        var startCol = lineIndex == s.Line ? s.Col : 0;
        var endCol = lineIndex == e.Line ? e.Col : width;
        startCol = Math.Max(0, Math.Min(startCol, width));
        endCol = Math.Max(startCol, Math.Min(endCol, width));

        if (startCol >= endCol) return;

        // Get the text for this line to re-render with inverted colors
        var text = lineIndex < _displayLines.Count ? _displayLines[lineIndex].Text : "";
        var selAttr = new Attribute(bg, new Color(180, 210, 255)); // inverted: bg as fg, light blue as bg

        for (var col = startCol; col < endCol; col++)
        {
            Move(col, row);
            SetAttribute(selAttr);
            var ch = col < text.Length ? text[col].ToString() : " ";
            AddStr(ch);
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            StopWorking();
        }
        base.Dispose(disposing);
    }

    private static Attribute GetMessageAttribute(string type, Color bg)
    {
        return type.ToLowerInvariant() switch
        {
            "lifecycle" => new Attribute(Color.Cyan, bg),
            "result" => new Attribute(Color.Green, bg),
            "chat" => new Attribute(new Color(255, 160, 0), bg),
            "question" => new Attribute(Color.BrightYellow, bg),
            "warning" => new Attribute(Color.Yellow, bg),
            "error" => new Attribute(Color.Red, bg),
            "tool_use" => new Attribute(Color.DarkGray, bg),
            "thinking" => new Attribute(Color.DarkGray, bg),
            "user" => new Attribute(new Color(0, 180, 255), bg),
            "system" => new Attribute(Color.Gray, bg),
            _ => new Attribute(Color.White, bg)
        };
    }
}
