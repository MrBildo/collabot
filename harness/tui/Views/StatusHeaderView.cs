using Terminal.Gui.ViewBase;
using Terminal.Gui.Drawing;
using Collabot.Tui.Models;
using Attribute = Terminal.Gui.Drawing.Attribute;
using Color = Terminal.Gui.Drawing.Color;

namespace Collabot.Tui.Views;

public class StatusHeaderView : View
{
    private string _leftText = "Collabot";
    private string _rightLabel = "Disconnected";
    private ConnectionState _connectionState = ConnectionState.Disconnected;

    public StatusHeaderView()
    {
        Height = 2;
        Width = Dim.Fill();
        CanFocus = false;
    }

    public void Update(string leftText, string rightLabel, ConnectionState connectionState)
    {
        _leftText = leftText;
        _rightLabel = rightLabel;
        _connectionState = connectionState;
        SetNeedsDraw();
    }

    protected override bool OnDrawingContent(DrawContext? context)
    {
        var width = Viewport.Width;
        if (width <= 0) return true;

        var bg = GetAttributeForRole(VisualRole.Normal).Background;
        var normalFg = GetAttributeForRole(VisualRole.Normal).Foreground;
        var normalAttr = new Attribute(normalFg, bg);
        var blankLine = new string(' ', width);

        // Row 0: content — left text + right indicator
        Move(0, 0);
        SetAttribute(normalAttr);

        var dot = "● ";
        var rightFull = dot + _rightLabel;
        var availableForLeft = width - rightFull.Length - 2; // 1 padding each side
        var leftTruncated = _leftText.Length > availableForLeft && availableForLeft > 0
            ? _leftText[..availableForLeft]
            : _leftText;

        // Left-aligned text with 1-char left padding
        AddStr(" ");
        AddStr(leftTruncated);

        // Fill gap between left and right
        var usedSoFar = 1 + leftTruncated.Length;
        var rightStart = width - rightFull.Length - 1; // 1-char right padding
        if (rightStart > usedSoFar)
        {
            AddStr(new string(' ', rightStart - usedSoFar));
        }

        // Colored dot
        var dotColor = _connectionState switch
        {
            ConnectionState.Connected => new Color(0, 200, 0),
            ConnectionState.Connecting or ConnectionState.Reconnecting => new Color(255, 200, 0),
            _ => new Color(200, 0, 0)
        };
        SetAttribute(new Attribute(dotColor, bg));
        AddStr(dot);

        // Connection label in normal fg
        SetAttribute(normalAttr);
        AddStr(_rightLabel);
        AddStr(" "); // right padding

        // Row 1: bottom padding
        Move(0, 1);
        SetAttribute(normalAttr);
        AddStr(blankLine);

        return true;
    }
}
