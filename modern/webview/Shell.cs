using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

// Native window only. Application operations run in the parent over private
// process pipes; no socket, local web server or host-object access is exposed.
internal sealed class Shell : Form
{
    private readonly WebView2 view = new WebView2();
    private readonly ConcurrentDictionary<int, TaskCompletionSource<Dictionary<string, object>>> pending =
        new ConcurrentDictionary<int, TaskCompletionSource<Dictionary<string, object>>>();
    private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 160 * 1024 * 1024 };
    private readonly string origin;
    private readonly string profile;
    private readonly object outputLock = new object();
    private int sequence;
    private bool signingIn;

    private Shell(string title, string address, string data)
    {
        Text = title;
        Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        origin = new Uri(address).GetLeftPart(UriPartial.Authority);
        profile = data;
        Width = 1440; Height = 960; MinimumSize = new System.Drawing.Size(900, 600);
        StartPosition = FormStartPosition.CenterScreen;
        view.Dock = DockStyle.Fill;
        Controls.Add(view);
        Shown += async delegate { await Start(); };
        FormClosed += delegate { view.Dispose(); };
    }

    private void Send(object message)
    {
        lock (outputLock) { Console.Out.WriteLine(json.Serialize(message)); Console.Out.Flush(); }
    }

    private async Task Start()
    {
        try
        {
            var environment = await CoreWebView2Environment.CreateAsync(null, profile);
            await view.EnsureCoreWebView2Async(environment);
            // Let Chromium discard caches while minimized without suspending verification work.
            Resize += delegate {
                view.CoreWebView2.MemoryUsageTargetLevel = WindowState == FormWindowState.Minimized
                    ? CoreWebView2MemoryUsageTargetLevel.Low : CoreWebView2MemoryUsageTargetLevel.Normal;
            };
            view.CoreWebView2.Settings.AreHostObjectsAllowed = false;
            view.CoreWebView2.Settings.IsWebMessageEnabled = false;
            // Include worker requests: the document engine reads database ranges
            // and provider responses inside its Worker.
            view.CoreWebView2.AddWebResourceRequestedFilter(origin + "/*", CoreWebView2WebResourceContext.All,
                CoreWebView2WebResourceRequestSourceKinds.All);
            view.CoreWebView2.WebResourceRequested += Resource;
            view.CoreWebView2.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e)
            {
                var destination = new Uri(e.Uri);
                if (destination.GetLeftPart(UriPartial.Authority) == origin) { signingIn = false; return; }
                // OpenRouter's PKCE flow navigates away and returns to this
                // profile with a code. Keep its sessionStorage across that trip.
                if (destination.Scheme == "https" && destination.Host == "openrouter.ai" &&
                    destination.AbsolutePath.StartsWith("/auth", StringComparison.Ordinal)) signingIn = true;
                if (signingIn && destination.Scheme == "https") return;
                e.Cancel = true;
                if (e.IsUserInitiated) OpenExternal(e.Uri);
            };
            view.CoreWebView2.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e)
            {
                e.Handled = true;
                if (e.IsUserInitiated) OpenExternal(e.Uri);
            };
            view.CoreWebView2.ProcessFailed += delegate { Fail("The application window stopped. Close and reopen the program."); };
            // Responses are read off the UI thread. Resource continuations resume
            // on the UI thread, as WebView2 requires.
            Task.Run((Action)ReadResponses);
            view.CoreWebView2.Navigate(origin + "/");
            Send(new { type = "ready" });
        }
        catch (WebView2RuntimeNotFoundException)
        {
            Fail("Install Microsoft Edge WebView2 Runtime, then reopen this program.");
        }
        catch (Exception error) { Fail(error.Message); }
    }

    private static void OpenExternal(string value)
    {
        Uri url;
        if (Uri.TryCreate(value, UriKind.Absolute, out url) && (url.Scheme == "https" || url.Scheme == "http"))
            Process.Start(new ProcessStartInfo(value) { UseShellExecute = true });
    }

    private async void Resource(object sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        using (var deferral = e.GetDeferral())
        {
            var id = Interlocked.Increment(ref sequence);
            var answer = new TaskCompletionSource<Dictionary<string, object>>();
            pending[id] = answer;
            try
            {
                var headers = new Dictionary<string, string>();
                foreach (var header in e.Request.Headers) headers[header.Key.ToLowerInvariant()] = header.Value;
                byte[] body = new byte[0];
                if (e.Request.Content != null)
                {
                    using (var copy = new MemoryStream())
                    {
                        byte[] buffer = new byte[8192]; int count;
                        while ((count = e.Request.Content.Read(buffer, 0, buffer.Length)) != 0)
                        {
                            if (copy.Length + count > 132000) throw new InvalidDataException("The request is too large.");
                            copy.Write(buffer, 0, count);
                        }
                        body = copy.ToArray();
                    }
                }
                Send(new { type = "request", id = id, url = e.Request.Uri, method = e.Request.Method,
                    headers = headers, body = Convert.ToBase64String(body) });
                if (await Task.WhenAny(answer.Task, Task.Delay(120000)) != answer.Task)
                    throw new TimeoutException("The application request timed out.");
                var result = await answer.Task;
                e.Response = view.CoreWebView2.Environment.CreateWebResourceResponse(
                    new MemoryStream((byte[])result["body"]),
                    Convert.ToInt32(result["status"]), (string)result["statusText"], (string)result["headers"]);
            }
            catch (Exception error)
            {
                if (!view.IsDisposed) e.Response = view.CoreWebView2.Environment.CreateWebResourceResponse(
                    new MemoryStream(Encoding.UTF8.GetBytes(error.Message)), 502, "Application error", "Content-Type: text/plain\r\n");
            }
            finally { TaskCompletionSource<Dictionary<string, object>> ignored; pending.TryRemove(id, out ignored); }
        }
    }

    private void ReadResponses()
    {
        try
        {
            var input = new BinaryReader(Console.OpenStandardInput());
            var reader = new JavaScriptSerializer { MaxJsonLength = 160 * 1024 * 1024 };
            while (true)
            {
                int headerLength = input.ReadInt32(), bodyLength = input.ReadInt32();
                if (headerLength < 0 || headerLength > 1048576 || bodyLength < 0 || bodyLength > 128 * 1024 * 1024)
                    throw new InvalidDataException("The application response is too large.");
                var header = input.ReadBytes(headerLength);
                var body = input.ReadBytes(bodyLength);
                if (header.Length != headerLength || body.Length != bodyLength) throw new EndOfStreamException();
                var result = reader.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(header));
                result["body"] = body;
                var type = (string)result["type"];
                if (type == "response")
                {
                    TaskCompletionSource<Dictionary<string, object>> request;
                    if (pending.TryGetValue(Convert.ToInt32(result["id"]), out request)) request.TrySetResult(result);
                }
                else if (type == "close") { BeginInvoke((Action)Close); return; }
                // The harness supplies these commands through the parent pipe.
                // Web content cannot send them or gain access to the pipe.
                else if (type == "evaluate" || type == "capture")
                    BeginInvoke((Action)(async delegate { await Inspect(result); }));
            }
        }
        catch (Exception error) { Console.Error.WriteLine(error.Message); }
        foreach (var request in pending.Values) request.TrySetException(new IOException("The application process stopped."));
        if (!IsDisposed) BeginInvoke((Action)Close);
    }

    private async Task Inspect(Dictionary<string, object> request)
    {
        try
        {
            if ((string)request["type"] == "capture")
            {
                using (var file = File.Create((string)request["path"]))
                    await view.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, file);
                Send(new { type = "inspection", id = request["id"], result = "null" });
            }
            else Send(new { type = "inspection", id = request["id"],
                result = await view.CoreWebView2.ExecuteScriptAsync((string)request["script"]) });
        }
        catch (Exception error) { Send(new { type = "inspection", id = request["id"], error = error.Message }); }
    }

    private void Fail(string message)
    {
        Console.Error.WriteLine(message);
        MessageBox.Show(this, message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
        Environment.ExitCode = 1;
        Close();
    }

    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length != 3) { Environment.ExitCode = 2; return; }
        Console.SetIn(new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false)));
        Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true });
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using (var form = new Shell(args[0], args[1], args[2])) Application.Run(form);
    }
}
