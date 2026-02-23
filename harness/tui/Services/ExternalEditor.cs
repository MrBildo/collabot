using System.Diagnostics;

namespace Collabot.Tui.Services;

public record EditorResult(bool Success, string Content, string? Error = null);

public static class ExternalEditor
{
    private static readonly HashSet<string> WaitEditors = new(StringComparer.OrdinalIgnoreCase)
    {
        "code", "cursor", "subl"
    };

    public static async Task<EditorResult> EditAsync(string initialContent)
    {
        var tempFile = Path.Combine(Path.GetTempPath(), $"collabot-{Guid.NewGuid():N}.md");

        try
        {
            await File.WriteAllTextAsync(tempFile, initialContent);

            var (command, extraArgs) = ResolveEditor();
            var needsWait = WaitEditors.Contains(Path.GetFileNameWithoutExtension(command))
                && !extraArgs.Contains("--wait", StringComparison.OrdinalIgnoreCase);
            var args = needsWait ? $"{extraArgs} --wait \"{tempFile}\"" : $"{extraArgs} \"{tempFile}\"";

            var psi = new ProcessStartInfo
            {
                FileName = command,
                Arguments = args.TrimStart(),
                UseShellExecute = true
            };

            using var process = Process.Start(psi);
            if (process is null)
                return new EditorResult(false, initialContent, $"Failed to start editor: {command}");

            await process.WaitForExitAsync();

            var content = await File.ReadAllTextAsync(tempFile);
            // Normalize line endings to match TextView
            content = content.Replace("\r\n", "\n").TrimEnd('\n');

            return new EditorResult(true, content);
        }
        catch (Exception ex)
        {
            return new EditorResult(false, initialContent, ex.Message);
        }
        finally
        {
            try { File.Delete(tempFile); } catch { }
        }
    }

    private static (string Command, string ExtraArgs) ResolveEditor()
    {
        var visual = Environment.GetEnvironmentVariable("VISUAL");
        if (!string.IsNullOrWhiteSpace(visual))
            return SplitCommand(visual);

        var editor = Environment.GetEnvironmentVariable("EDITOR");
        if (!string.IsNullOrWhiteSpace(editor))
            return SplitCommand(editor);

        return ("notepad.exe", "");
    }

    private static (string Command, string ExtraArgs) SplitCommand(string value)
    {
        value = value.Trim();
        var spaceIndex = value.IndexOf(' ');
        if (spaceIndex < 0)
            return (value, "");
        return (value[..spaceIndex], value[(spaceIndex + 1)..]);
    }
}
