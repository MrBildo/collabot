using Terminal.Gui.App;
using Collabot.Tui.Views;

using IApplication app = Application.Create();
app.Init();
app.Run<MainWindow>();
