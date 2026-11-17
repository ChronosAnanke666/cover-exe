using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;

namespace WanNengFanChangLauncher
{
    internal static class Program
    {
        private const string Port = "18321";
        private const string BaseUrl = "http://127.0.0.1:" + Port;
        private const string MutexName = "wanNengFanChang_18321_mutex";
        private const string Title = "\u4e07\u80fd\u7ffb\u5531"; // 万能翻唱

        [STAThread]
        private static void Main()
        {
            bool createdNew;
            using (var mtx = new Mutex(true, MutexName, out createdNew))
            {
                if (!createdNew)
                {
                    MessageBox.Show(Title + " \u5df2\u7ecf\u5728\u8fd0\u884c\u4e86\u3002",
                        Title, MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }
                try { Run(); }
                catch (Exception ex)
                {
                    MessageBox.Show("\u542f\u52a8\u5931\u8d25\uff1a\n" + ex.Message,
                        Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            }
        }

        private static void Run()
        {
            string appDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            string server = Path.Combine(appDir, "server.mjs");
            if (!File.Exists(server))
                throw new FileNotFoundException("\u627e\u4e0d\u5230 server.mjs\uff1a\n" + server);

            Process backend = null;

            if (!IsBackendUp())
            {
                string node = FindNode();
                var psi = new ProcessStartInfo
                {
                    FileName = node,
                    Arguments = "\"" + server + "\"",
                    WorkingDirectory = appDir,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                };
                backend = Process.Start(psi);
                if (backend == null) throw new Exception("cannot start node.exe");

                for (int i = 0; i < 40 && !IsBackendUp(); i++)
                {
                    if (backend.HasExited)
                        throw new Exception("backend exited unexpectedly (code " + backend.ExitCode + ")");
                    Thread.Sleep(500);
                }
                if (!IsBackendUp())
                    throw new Exception("backend not ready in 20s; is port " + Port + " occupied?");
            }

            string browser = FindBrowser();
            string profile = Path.Combine(Path.GetTempPath(), "wfc_browser_profile");
            var bpsi = new ProcessStartInfo
            {
                FileName = browser,
                Arguments = "--app=" + BaseUrl
                    + " --user-data-dir=\"" + profile + "\""
                    + " --window-size=1280,900 --window-position=80,60"
                    + " --no-first-run --no-default-browser-check"
                    + " --disable-features=TranslateUI",
                UseShellExecute = false
            };
            Process win = Process.Start(bpsi);
            if (win != null)
            {
                try { win.WaitForExit(); } catch { }
            }

            if (backend != null && !backend.HasExited)
            {
                try
                {
                    var kill = new ProcessStartInfo
                    {
                        FileName = "taskkill",
                        Arguments = "/PID " + backend.Id + " /T /F",
                        UseShellExecute = false,
                        CreateNoWindow = true
                    };
                    using (var kp = Process.Start(kill)) { kp.WaitForExit(); }
                }
                catch
                {
                    try { backend.Kill(); } catch { }
                }
            }
        }

        private static bool IsBackendUp()
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(BaseUrl + "/api/health");
                req.Timeout = 1000;
                req.ReadWriteTimeout = 1000;
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var sr = new StreamReader(resp.GetResponseStream()))
                {
                    string body = sr.ReadToEnd();
                    return body.Contains("\"ok\"") && body.Contains("true");
                }
            }
            catch { return false; }
        }

        private static string FindNode()
        {
            string[] candidates = {
                @"D:\node\node.exe",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "node", "node.exe")
            };
            foreach (var c in candidates) if (File.Exists(c)) return c;
            return "node";
        }

        private static string FindBrowser()
        {
            string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string pfx = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            string[] candidates = {
                Path.Combine(pfx, @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(pf,  @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(pf,  @"Google\Chrome\Application\chrome.exe"),
                Path.Combine(pfx, @"Google\Chrome\Application\chrome.exe")
            };
            foreach (var c in candidates) if (File.Exists(c)) return c;
            throw new FileNotFoundException("Edge/Chrome not found");
        }
    }
}
