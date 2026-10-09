# Shows the Windows Share sheet for one file (docs/research-files-share-style.md B.2.3).
# Run by src/main/share.ts with -EncodedCommand; the file and anchor come from PP_SHARE_*.
# Output (stdout): completed:<AppUserModelId> | canceled | timeout | error:<message>
$Path = $env:PP_SHARE_PATH; $X = [int]$env:PP_SHARE_X; $Y = [int]$env:PP_SHARE_Y
$ErrorActionPreference = 'Stop'
$fw = [Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
$wm = Join-Path $env:WINDIR 'System32\WinMetadata'
$src = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Windows.Forms;
using Windows.ApplicationModel.DataTransfer;
using Windows.Storage;

[ComImport, Guid("3A3DCD6C-3EAB-43DC-BCDE-45671CE800C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IDataTransferManagerInterop
{
    [return: MarshalAs(UnmanagedType.IInspectable)]
    object GetForWindow(IntPtr appWindow, [In] ref Guid riid);
    void ShowShareUIForWindow(IntPtr appWindow);
}

public static class PpShare
{
    static readonly Guid DtmIid = new Guid(0xa5caee9b, 0x8708, 0x49d1, 0x8d, 0x36, 0x67, 0xd2, 0x5a, 0x8d, 0xa0, 0x0c);
    public static string Run(string path, int x, int y)
    {
        string result = "timeout";
        var form = new Form { FormBorderStyle = FormBorderStyle.None, ShowInTaskbar = false, Width = 1, Height = 1,
                              StartPosition = FormStartPosition.Manual, TopMost = true };
        if (x >= 0) form.Location = new System.Drawing.Point(x, y);
        form.Shown += (s, e) =>
        {
            try
            {
                // No 'await' (the .NET Framework compiler lacks the WinRT awaiter here): pump until done.
                var op = StorageFile.GetFileFromPathAsync(path);
                while (op.Status == Windows.Foundation.AsyncStatus.Started) { Application.DoEvents(); System.Threading.Thread.Sleep(5); }
                var file = op.GetResults();
                var interop = (IDataTransferManagerInterop)WindowsRuntimeMarshal.GetActivationFactory(typeof(DataTransferManager));
                Guid iid = DtmIid;
                var dtm = (DataTransferManager)interop.GetForWindow(form.Handle, ref iid);
                dtm.DataRequested += (sender, a) =>
                {
                    a.Request.Data.Properties.Title = Path.GetFileName(path);
                    a.Request.Data.SetStorageItems(new IStorageItem[] { file });
                    a.Request.Data.ShareCompleted += (p, q) => { result = "completed:" + q.ShareTarget.AppUserModelId; form.BeginInvoke((Action)form.Close); };
                    try { a.Request.Data.ShareCanceled += (p, q) => { result = "canceled"; form.BeginInvoke((Action)form.Close); }; } catch { }
                };
                interop.ShowShareUIForWindow(form.Handle);
            }
            catch (Exception ex) { result = "error:" + ex.Message; form.Close(); }
        };
        var timer = new Timer { Interval = 120000 };   // give up after 2 minutes
        timer.Tick += (s, e) => form.Close();
        timer.Start();
        Application.Run(form);
        return result;
    }
}
'@
$refs = @(
  (Join-Path $fw 'System.dll'), (Join-Path $fw 'System.Windows.Forms.dll'), (Join-Path $fw 'System.Drawing.dll'),
  (Join-Path $fw 'System.Runtime.WindowsRuntime.dll'), (Join-Path $fw 'System.Runtime.dll'),
  (Join-Path $fw 'System.Runtime.InteropServices.WindowsRuntime.dll'),
  (Join-Path $wm 'Windows.ApplicationModel.winmd'), (Join-Path $wm 'Windows.Foundation.winmd'), (Join-Path $wm 'Windows.Storage.winmd'))
# Add-Type cannot take .winmd references (it tries to load them); CodeDom hands them straight to csc.
$cp = New-Object Microsoft.CSharp.CSharpCodeProvider
$cpar = New-Object System.CodeDom.Compiler.CompilerParameters
$cpar.ReferencedAssemblies.AddRange([string[]]$refs)
$cpar.GenerateInMemory = $true
$cpar.CompilerOptions = '/nowarn:1701'
$res = $cp.CompileAssemblyFromSource($cpar, $src)
if ($res.Errors.HasErrors) { $res.Errors | ForEach-Object { [Console]::Error.WriteLine($_.ToString()) }; exit 2 }
$res.CompiledAssembly.GetType('PpShare').GetMethod('Run').Invoke($null, @((Resolve-Path -LiteralPath $Path).ProviderPath, $X, $Y))
