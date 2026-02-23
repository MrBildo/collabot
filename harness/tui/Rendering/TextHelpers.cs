using System.Text;
using Terminal.Gui.Text;

namespace Collabot.Tui.Rendering;

/// <summary>
/// Width-aware text helpers for emoji, CJK, and other wide Unicode characters.
/// All column measurements use Terminal.Gui's rune-based GetColumns() which
/// correctly returns 2 for wide glyphs (emoji, CJK) and handles combining marks.
/// </summary>
public static class TextHelpers
{
    /// <summary>Returns the display column width of a string.</summary>
    public static int DisplayWidth(string text) =>
        string.IsNullOrEmpty(text) ? 0 : text.GetColumns();

    /// <summary>Truncates a string to fit within maxCols display columns.</summary>
    public static string TruncateToWidth(string text, int maxCols)
    {
        if (string.IsNullOrEmpty(text) || maxCols <= 0) return "";
        if (text.GetColumns() <= maxCols) return text;

        var cols = 0;
        var sb = new StringBuilder();
        foreach (var rune in text.EnumerateRunes())
        {
            var w = rune.GetColumns();
            if (w < 0) w = 0;
            if (cols + w > maxCols) break;
            sb.Append(rune);
            cols += w;
        }
        return sb.ToString();
    }

    /// <summary>
    /// Finds the best word-break position that fits within maxCols display columns.
    /// Returns the character index to break at. If no space is found, breaks at the column limit.
    /// </summary>
    public static int FindWordBreakByColumns(string text, int maxCols)
    {
        if (string.IsNullOrEmpty(text)) return 0;
        if (text.GetColumns() <= maxCols) return text.Length;

        var cols = 0;
        var lastSpaceIdx = -1;
        var charIdx = 0;
        var breakIdx = 0; // character index where we exceed maxCols

        foreach (var rune in text.EnumerateRunes())
        {
            var w = rune.GetColumns();
            if (w < 0) w = 0;

            if (cols + w > maxCols)
            {
                breakIdx = charIdx;
                break;
            }

            if (rune == new Rune(' '))
                lastSpaceIdx = charIdx;

            cols += w;
            charIdx += rune.Utf16SequenceLength;
            breakIdx = charIdx;
        }

        return lastSpaceIdx > 0 ? lastSpaceIdx : breakIdx;
    }

    /// <summary>Pads a string with spaces to fill the given display column width.</summary>
    public static string PadToWidth(string text, int targetWidth)
    {
        var currentWidth = DisplayWidth(text);
        return currentWidth >= targetWidth ? text : text + new string(' ', targetWidth - currentWidth);
    }
}
