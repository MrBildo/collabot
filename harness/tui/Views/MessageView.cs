using System.Drawing;
using Terminal.Gui.ViewBase;
using Terminal.Gui.Drawing;
using Terminal.Gui.Input;
using Collabot.Tui.Models;
using Attribute = Terminal.Gui.Drawing.Attribute;
using Color = Terminal.Gui.Drawing.Color;

namespace Collabot.Tui.Views;

public class MessageView : View
{
    private readonly List<ChatMessage> _messages = [];
    private readonly List<DisplayLine> _displayLines = [];
    private int _lastWrapWidth;
    private bool _autoScroll = true;

    private const int TimestampIndent = 11; // "[HH:mm:ss] "

    /// <summary>Maximum messages to retain. 0 = unlimited. When exceeded, oldest 20% are pruned.</summary>
    public int MaxMessages { get; set; } = 10_000;

    private record DisplayLine(int MessageIndex, string Text);

    public MessageView()
    {
        CanFocus = true;
        VerticalScrollBar.AutoShow = true;

        KeyBindings.Add(Key.CursorUp, Command.ScrollUp);
        KeyBindings.Add(Key.CursorDown, Command.ScrollDown);
        KeyBindings.Add(Key.PageUp, Command.PageUp);
        KeyBindings.Add(Key.PageDown, Command.PageDown);

        MouseBindings.Add(MouseFlags.WheeledUp, Command.ScrollUp);
        MouseBindings.Add(MouseFlags.WheeledDown, Command.ScrollDown);

        AddCommand(Command.ScrollUp, () =>
        {
            ScrollVertical(-1);
            _autoScroll = false;
            return true;
        });

        AddCommand(Command.ScrollDown, () =>
        {
            ScrollVertical(1);
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
        _displayLines.Clear();
        var width = GetWrapWidth();

        for (var i = 0; i < _messages.Count; i++)
        {
            WrapMessage(i, width);
        }

        _lastWrapWidth = width;
        UpdateContentSize();
    }

    private void WrapMessage(int index, int width)
    {
        var msg = _messages[index];
        var text = msg.ToString();

        // Banner lines are pre-formatted ASCII art — never word-wrap
        if (msg.Type == "banner")
        {
            _displayLines.Add(new DisplayLine(index, text));
            return;
        }

        if (width <= 0)
        {
            width = 80;
        }

        if (text.Length <= width)
        {
            _displayLines.Add(new DisplayLine(index, text));
            return;
        }

        // First line: full width
        var firstBreak = FindWordBreak(text, width);
        _displayLines.Add(new DisplayLine(index, text[..firstBreak]));
        var remaining = text[firstBreak..].TrimStart();

        // Continuation lines: indented past timestamp
        var indent = new string(' ', TimestampIndent);
        var contWidth = Math.Max(width - TimestampIndent, 20);

        while (remaining.Length > 0)
        {
            if (remaining.Length <= contWidth)
            {
                _displayLines.Add(new DisplayLine(index, indent + remaining));
                break;
            }

            var breakAt = FindWordBreak(remaining, contWidth);
            _displayLines.Add(new DisplayLine(index, indent + remaining[..breakAt]));
            remaining = remaining[breakAt..].TrimStart();
        }
    }

    private static int FindWordBreak(string text, int maxWidth)
    {
        if (text.Length <= maxWidth)
        {
            return text.Length;
        }

        var breakAt = text.LastIndexOf(' ', maxWidth - 1);
        return breakAt > 0 ? breakAt : maxWidth;
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

                SetAttribute(new Attribute(new Color(0, 180, 255), Color.Black));
                AddStr(cyanPart);

                if (orangePart.Length > 0)
                {
                    SetAttribute(new Attribute(new Color(255, 160, 0), Color.Black));
                    AddStr(orangePart);
                }

                var totalLen = cyanPart.Length + orangePart.Length;
                if (totalLen < width)
                {
                    SetAttributeForRole(VisualRole.Normal);
                    AddStr(new string(' ', width - totalLen));
                }

                continue;
            }

            SetAttribute(GetMessageAttribute(msg.Type));

            var lineText = displayLine.Text;

            if (lineText.Length > width)
            {
                lineText = lineText[..width];
            }
            else
            {
                lineText = lineText.PadRight(width);
            }

            AddStr(lineText);
        }

        return true;
    }

    private static Attribute GetMessageAttribute(string type)
    {
        return type.ToLowerInvariant() switch
        {
            "lifecycle" => new Attribute(Color.Cyan, Color.Black),
            "result" => new Attribute(Color.Green, Color.Black),
            "chat" => new Attribute(new Color(255, 160, 0), Color.Black),
            "question" => new Attribute(Color.BrightYellow, Color.Black),
            "warning" => new Attribute(Color.Yellow, Color.Black),
            "error" => new Attribute(Color.Red, Color.Black),
            "tool_use" => new Attribute(Color.DarkGray, Color.Black),
            "thinking" => new Attribute(Color.DarkGray, Color.Black),
            "user" => new Attribute(new Color(0, 180, 255), Color.Black),
            "system" => new Attribute(Color.Gray, Color.Black),
            _ => new Attribute(Color.White, Color.Black)
        };
    }
}
