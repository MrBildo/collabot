using Terminal.Gui.App;
using Collabot.Tui.Views;

using IApplication app = Application.Create();
app.Init();
app.Run<MainWindow>();

// Defensive cleanup: ensure alternate screen buffer is exited and terminal state is reset.
// Terminal.Gui may leave residual state that accumulates in Windows Terminal across runs.
Console.Write("\x1b[?1049l"); // exit alternate screen buffer
Console.Write("\x1b[!p");     // soft terminal reset (DECSTR)
Console.Write("\x1b[?25h");   // ensure cursor visible
