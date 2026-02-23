using Attribute = Terminal.Gui.Drawing.Attribute;

namespace Collabot.Tui.Rendering;

/// <summary>A span of text with an optional style override. Null style = use message-type default.</summary>
public record StyledRun(string Text, Attribute? Style = null);
