using Markdig;
using Markdig.Extensions.Tables;
using Markdig.Syntax;
using Markdig.Syntax.Inlines;
using Terminal.Gui.Drawing;
using Attribute = Terminal.Gui.Drawing.Attribute;
using Color = Terminal.Gui.Drawing.Color;

namespace Collabot.Tui.Rendering;

// Bundles inline style attributes to reduce parameter passing
internal record InlineStyles(
    Attribute Base, Attribute Bold, Attribute Italic,
    Attribute BoldItalic, Attribute InlineCode, Attribute Link);

public static class MarkdownRenderer
{
    /// <summary>
    /// Renders markdown content into styled display lines for the TUI.
    /// </summary>
    /// <param name="content">Raw markdown text</param>
    /// <param name="width">Available viewport width (full line, caller handles prefix)</param>
    /// <param name="bg">Background color for attribute construction</param>
    /// <param name="baseAttr">Default message-type attribute (fallback color)</param>
    /// <returns>List of display lines, each with its styled runs</returns>
    public static List<(string Text, List<StyledRun> Runs)> Render(
        string content, int width, Color bg, Attribute baseAttr)
    {
        if (width <= 0) width = 80;

        var pipeline = new MarkdownPipelineBuilder().UsePipeTables().Build();
        var document = Markdown.Parse(content, pipeline);
        var lines = new List<(string Text, List<StyledRun> Runs)>();

        // Style palette
        var headingAttr = new Attribute(new Color(100, 200, 255), bg);
        var codeBlockAttr = new Attribute(new Color(120, 220, 120), bg);
        var inlineCodeAttr = new Attribute(new Color(120, 220, 120), bg);
        var boldAttr = new Attribute(new Color(255, 255, 255), bg);
        var italicAttr = new Attribute(new Color(200, 200, 200), bg);
        var boldItalicAttr = new Attribute(new Color(255, 255, 255), bg);
        var blockquoteAttr = new Attribute(new Color(140, 140, 140), bg);
        var linkAttr = new Attribute(new Color(80, 200, 255), bg);
        var thematicBreakAttr = new Attribute(new Color(100, 100, 100), bg);
        var listMarkerAttr = baseAttr;
        var tableHeaderAttr = new Attribute(new Color(255, 255, 255), bg);
        var tableBorderAttr = new Attribute(new Color(100, 100, 100), bg);
        var diffAddAttr = new Attribute(new Color(80, 220, 80), bg);
        var diffRemoveAttr = new Attribute(new Color(220, 80, 80), bg);

        var styles = new InlineStyles(baseAttr, boldAttr, italicAttr, boldItalicAttr, inlineCodeAttr, linkAttr);

        // Top padding — visually separates timestamp prefix from content
        lines.Add(("", []));

        foreach (var block in document)
        {
            switch (block)
            {
                case HeadingBlock heading:
                    RenderHeading(heading, lines, width, headingAttr);
                    break;

                case FencedCodeBlock fencedCode:
                    RenderFencedCodeBlock(fencedCode, lines, width, codeBlockAttr, diffAddAttr, diffRemoveAttr);
                    break;

                case CodeBlock codeBlock:
                    RenderIndentedCodeBlock(codeBlock, lines, width, codeBlockAttr);
                    break;

                case ParagraphBlock paragraph:
                    RenderParagraph(paragraph, lines, width, styles);
                    break;

                case ListBlock listBlock:
                    RenderList(listBlock, lines, width, styles, listMarkerAttr);
                    break;

                case QuoteBlock quoteBlock:
                    RenderBlockquote(quoteBlock, lines, width, blockquoteAttr, bg);
                    break;

                case Table table:
                    RenderTable(table, lines, width, styles, tableHeaderAttr, tableBorderAttr);
                    break;

                case ThematicBreakBlock:
                    RenderThematicBreak(lines, width, thematicBreakAttr);
                    break;

                default:
                    // Fallback: render as plain text
                    var text = ExtractPlainText(block);
                    if (!string.IsNullOrEmpty(text))
                    {
                        foreach (var wl in WordWrap(text, width))
                        {
                            lines.Add((wl, [new StyledRun(wl, baseAttr)]));
                        }
                    }
                    break;
            }
        }

        // Bottom padding
        lines.Add(("", []));

        return lines;
    }

    private static void RenderHeading(HeadingBlock heading, List<(string, List<StyledRun>)> lines,
        int width, Attribute attr)
    {
        var prefix = new string('#', heading.Level) + " ";
        var text = prefix + ExtractInlineText(heading.Inline);

        // Headings don't word-wrap — truncate if needed
        if (text.Length > width)
            text = text[..width];

        lines.Add((text, [new StyledRun(text, attr)]));
    }

    private static void RenderFencedCodeBlock(FencedCodeBlock codeBlock,
        List<(string, List<StyledRun>)> lines, int width, Attribute attr,
        Attribute diffAddAttr, Attribute diffRemoveAttr)
    {
        var code = ExtractCodeBlockText(codeBlock);
        var codeLines = code.Split('\n');
        var isDiff = string.Equals(codeBlock.Info?.Trim(), "diff", StringComparison.OrdinalIgnoreCase);

        foreach (var codeLine in codeLines)
        {
            var line = codeLine.TrimEnd('\r');
            var display = line.Length > width ? line[..width] : line;

            var lineAttr = attr;
            if (isDiff && display.Length > 0)
            {
                lineAttr = display[0] switch
                {
                    '+' => diffAddAttr,
                    '-' => diffRemoveAttr,
                    _ => attr
                };
            }

            lines.Add((display, [new StyledRun(display, lineAttr)]));
        }
    }

    private static void RenderIndentedCodeBlock(CodeBlock codeBlock,
        List<(string, List<StyledRun>)> lines, int width, Attribute attr)
    {
        var code = ExtractCodeBlockText(codeBlock);
        var codeLines = code.Split('\n');

        foreach (var codeLine in codeLines)
        {
            var line = codeLine.TrimEnd('\r');
            var display = line.Length > width ? line[..width] : line;
            lines.Add((display, [new StyledRun(display, attr)]));
        }
    }

    private static void RenderParagraph(ParagraphBlock paragraph,
        List<(string, List<StyledRun>)> lines, int width, InlineStyles s)
    {
        var runs = CollectInlineRuns(paragraph.Inline, s);
        WrapStyledRuns(runs, lines, width);
    }

    private static void RenderList(ListBlock listBlock,
        List<(string, List<StyledRun>)> lines, int width,
        InlineStyles s, Attribute markerAttr, int depth = 0)
    {
        var indent = new string(' ', depth * 2);
        var orderedIndex = 1;

        foreach (var item in listBlock)
        {
            if (item is not ListItemBlock listItem) continue;

            var marker = listBlock.IsOrdered
                ? $"{indent}{orderedIndex++}. "
                : $"{indent}- ";

            var isFirst = true;

            foreach (var subBlock in listItem)
            {
                if (subBlock is ParagraphBlock para)
                {
                    var runs = CollectInlineRuns(para.Inline, s);
                    var contentWidth = Math.Max(width - marker.Length, 10);

                    // Word-wrap the content, then prepend marker/indent
                    var wrapped = new List<(string Text, List<StyledRun> Runs)>();
                    WrapStyledRuns(runs, wrapped, contentWidth);

                    var prefix = isFirst ? marker : new string(' ', marker.Length);
                    var prefixStyle = isFirst ? markerAttr : (Attribute?)null;

                    foreach (var wl in wrapped)
                    {
                        wl.Runs.Insert(0, new StyledRun(prefix, prefixStyle));
                        lines.Add((prefix + wl.Text, wl.Runs));
                        // After first line of first paragraph, switch to indent
                        prefix = new string(' ', marker.Length);
                        prefixStyle = null;
                    }

                    isFirst = false;
                }
                else if (subBlock is ListBlock nestedList)
                {
                    RenderList(nestedList, lines, width, s, markerAttr, depth + 1);
                    isFirst = false;
                }
            }
        }
    }

    private static void RenderBlockquote(QuoteBlock quoteBlock,
        List<(string, List<StyledRun>)> lines, int width, Attribute attr, Color bg)
    {
        const string prefix = "> ";
        var innerWidth = Math.Max(width - prefix.Length, 10);

        foreach (var block in quoteBlock)
        {
            var text = ExtractPlainText(block);
            if (string.IsNullOrEmpty(text)) continue;

            foreach (var wl in WordWrap(text, innerWidth))
            {
                var full = prefix + wl;
                lines.Add((full, [new StyledRun(full, attr)]));
            }
        }
    }

    private static void RenderTable(Table table,
        List<(string, List<StyledRun>)> lines, int width,
        InlineStyles s, Attribute headerAttr, Attribute borderAttr)
    {
        // Extract all cell text and compute column widths
        var rows = new List<(bool IsHeader, List<string> Cells)>();
        var colCount = 0;

        foreach (var rowObj in table)
        {
            if (rowObj is not TableRow row) continue;
            var cells = new List<string>();
            foreach (var cellObj in row)
            {
                if (cellObj is not TableCell cell) continue;
                var text = "";
                foreach (var block in cell)
                    text += ExtractPlainText(block);
                cells.Add(text.Trim());
            }
            colCount = Math.Max(colCount, cells.Count);
            rows.Add((row.IsHeader, cells));
        }

        if (rows.Count == 0 || colCount == 0) return;

        // Compute column widths (min width = header text, capped to fit viewport)
        var colWidths = new int[colCount];
        foreach (var (_, cells) in rows)
        {
            for (var c = 0; c < cells.Count; c++)
                colWidths[c] = Math.Max(colWidths[c], cells[c].Length);
        }

        // Cap total width: "| col1 | col2 | ... |" = sum(colWidths) + 3*colCount + 1
        var totalStructure = 3 * colCount + 1;
        var totalContent = colWidths.Sum();
        if (totalContent + totalStructure > width && totalContent > 0)
        {
            var scale = (double)(width - totalStructure) / totalContent;
            for (var c = 0; c < colCount; c++)
                colWidths[c] = Math.Max((int)(colWidths[c] * scale), 1);
        }

        foreach (var (isHeader, cells) in rows)
        {
            var cellAttr = isHeader ? headerAttr : s.Base;
            var lineRuns = new List<StyledRun>();
            var lineText = "";

            for (var c = 0; c < colCount; c++)
            {
                lineRuns.Add(new StyledRun("| ", borderAttr));
                lineText += "| ";

                var cellText = c < cells.Count ? cells[c] : "";
                if (cellText.Length > colWidths[c])
                    cellText = cellText[..colWidths[c]];
                else
                    cellText = cellText.PadRight(colWidths[c]);

                lineRuns.Add(new StyledRun(cellText, cellAttr));
                lineText += cellText;

                lineRuns.Add(new StyledRun(" ", borderAttr));
                lineText += " ";
            }

            lineRuns.Add(new StyledRun("|", borderAttr));
            lineText += "|";

            lines.Add((lineText, lineRuns));

            // Add separator after header row
            if (isHeader)
            {
                var sepRuns = new List<StyledRun>();
                var sepText = "";
                for (var c = 0; c < colCount; c++)
                {
                    var sep = "|" + new string('─', colWidths[c] + 2);
                    sepRuns.Add(new StyledRun(sep, borderAttr));
                    sepText += sep;
                }
                sepRuns.Add(new StyledRun("|", borderAttr));
                sepText += "|";
                lines.Add((sepText, sepRuns));
            }
        }
    }

    private static void RenderThematicBreak(List<(string, List<StyledRun>)> lines,
        int width, Attribute attr)
    {
        var rule = new string('─', Math.Min(width, 80));
        lines.Add((rule, [new StyledRun(rule, attr)]));
    }

    // --- Inline collection ---

    private static List<StyledRun> CollectInlineRuns(ContainerInline? container, InlineStyles s)
    {
        var runs = new List<StyledRun>();
        if (container is null) return runs;

        foreach (var inline in container)
        {
            CollectInline(inline, runs, s, isInBold: false, isInItalic: false);
        }

        return runs;
    }

    private static void CollectInline(Inline inline, List<StyledRun> runs,
        InlineStyles s, bool isInBold, bool isInItalic)
    {
        switch (inline)
        {
            case LiteralInline literal:
                var attr = (isInBold, isInItalic) switch
                {
                    (true, true) => s.BoldItalic,
                    (true, false) => s.Bold,
                    (false, true) => s.Italic,
                    _ => s.Base
                };
                runs.Add(new StyledRun(literal.Content.ToString(), attr));
                break;

            case CodeInline code:
                runs.Add(new StyledRun($"`{code.Content}`", s.InlineCode));
                break;

            case EmphasisInline emphasis:
                var nowBold = isInBold || (emphasis.DelimiterChar is '*' or '_' && emphasis.DelimiterCount >= 2);
                var nowItalic = isInItalic || (emphasis.DelimiterChar is '*' or '_' && emphasis.DelimiterCount == 1);

                foreach (var child in emphasis)
                {
                    CollectInline(child, runs, s, nowBold, nowItalic);
                }
                break;

            case LinkInline link:
                var linkText = ExtractInlineText(link);
                if (!string.IsNullOrEmpty(linkText))
                    runs.Add(new StyledRun(linkText, s.Link));
                break;

            case LineBreakInline:
                runs.Add(new StyledRun(" ", s.Base));
                break;

            case ContainerInline container:
                foreach (var child in container)
                {
                    CollectInline(child, runs, s, isInBold, isInItalic);
                }
                break;

            default:
                var text = inline.ToString();
                if (!string.IsNullOrEmpty(text))
                    runs.Add(new StyledRun(text, s.Base));
                break;
        }
    }

    // --- Word wrapping for styled runs ---

    private static void WrapStyledRuns(List<StyledRun> runs,
        List<(string Text, List<StyledRun> Runs)> lines, int width, int contIndent = 0)
    {
        if (runs.Count == 0) return;

        // Flatten runs into word-level tokens preserving styles
        var tokens = new List<(string Word, Attribute? Style, bool TrailingSpace)>();

        foreach (var run in runs)
        {
            if (string.IsNullOrEmpty(run.Text)) continue;

            var words = run.Text.Split(' ');
            for (var i = 0; i < words.Length; i++)
            {
                if (words[i].Length == 0 && i > 0) continue; // skip empty splits
                tokens.Add((words[i], run.Style, i < words.Length - 1));
            }
        }

        if (tokens.Count == 0) return;

        var currentRuns = new List<StyledRun>();
        var currentText = "";
        var col = 0;
        var isFirstLine = true;

        void FlushLine()
        {
            // Trim trailing space from last run
            if (currentRuns.Count > 0)
            {
                var last = currentRuns[^1];
                if (last.Text.EndsWith(' '))
                    currentRuns[^1] = last with { Text = last.Text.TrimEnd() };

                currentText = currentText.TrimEnd();
            }

            lines.Add((currentText, new List<StyledRun>(currentRuns)));
            currentRuns.Clear();
            currentText = "";
            col = 0;
            isFirstLine = false;
        }

        foreach (var (word, style, trailingSpace) in tokens)
        {
            if (word.Length == 0) continue;

            var needed = word.Length + (trailingSpace ? 1 : 0);
            var lineWidth = isFirstLine ? width : width;
            var indentStr = "";

            // Check if we need to wrap
            if (col > 0 && col + 1 + word.Length > lineWidth)
            {
                FlushLine();
            }

            // Add continuation indent if starting a new non-first line
            if (!isFirstLine && col == 0 && contIndent > 0)
            {
                indentStr = new string(' ', contIndent);
                currentRuns.Add(new StyledRun(indentStr, null));
                currentText += indentStr;
                col += contIndent;
            }

            // Add space before word if not at line start
            if (col > 0 && (isFirstLine || col > contIndent))
            {
                currentRuns.Add(new StyledRun(" ", style));
                currentText += " ";
                col++;
            }

            currentRuns.Add(new StyledRun(word, style));
            currentText += word;
            col += word.Length;
        }

        // Flush last line
        if (currentRuns.Count > 0)
            FlushLine();
    }

    // --- Text extraction helpers ---

    private static string ExtractInlineText(ContainerInline? container)
    {
        if (container is null) return "";

        var result = "";
        foreach (var inline in container)
        {
            result += inline switch
            {
                LiteralInline literal => literal.Content.ToString(),
                CodeInline code => code.Content,
                EmphasisInline emphasis => ExtractInlineText(emphasis),
                LinkInline link => ExtractInlineText(link),
                LineBreakInline => " ",
                _ => inline.ToString() ?? ""
            };
        }
        return result;
    }

    private static string ExtractPlainText(Block block)
    {
        return block switch
        {
            ParagraphBlock para => ExtractInlineText(para.Inline),
            HeadingBlock heading => ExtractInlineText(heading.Inline),
            CodeBlock code => ExtractCodeBlockText(code),
            _ => ""
        };
    }

    private static string ExtractCodeBlockText(CodeBlock codeBlock)
    {
        var lines = new List<string>();
        foreach (var line in codeBlock.Lines)
        {
            var slice = line.ToString();
            if (slice is not null)
                lines.Add(slice);
        }

        // Remove trailing empty line if present (common in fenced blocks)
        while (lines.Count > 0 && string.IsNullOrEmpty(lines[^1]))
            lines.RemoveAt(lines.Count - 1);

        return string.Join("\n", lines);
    }

    private static List<string> WordWrap(string text, int width)
    {
        var result = new List<string>();
        if (string.IsNullOrEmpty(text) || width <= 0)
        {
            result.Add(text ?? "");
            return result;
        }

        var remaining = text;
        while (remaining.Length > 0)
        {
            if (remaining.Length <= width)
            {
                result.Add(remaining);
                break;
            }

            var breakAt = remaining.LastIndexOf(' ', width - 1);
            if (breakAt <= 0) breakAt = width;

            result.Add(remaining[..breakAt]);
            remaining = remaining[breakAt..].TrimStart();
        }

        return result;
    }
}
