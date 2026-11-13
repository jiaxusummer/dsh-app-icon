# ============================================================
#  dsh-app-icon 的后台助手
#  由 Host 插件在“DSH 退出之后”拉起；自己等进程退出、备份、改图标、验证、重开。
#  所有参数都从 -Request 指向的 JSON 读，避免中文路径在命令行里被拆坏。
#  用法（插件自己会这样调）：
#    powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File apply.ps1 -Request request.json
# ============================================================
param(
    [Parameter(Mandatory = $true)][string]$Request
)
$ErrorActionPreference = 'Stop'

$req = Get-Content -LiteralPath $Request -Raw -Encoding UTF8 | ConvertFrom-Json
$Mode = [string]$req.mode
$Exe = [string]$req.exe
$Resources = [string]$req.resources
$AppPid = [int]$req.appPid
$WaitSeconds = if ($req.waitSeconds) { [int]$req.waitSeconds } else { 900 }
$PackName = [string]$req.pack.name
$IconPath = [string]$req.pack.icon
$TrayPath = [string]$req.pack.tray
$PngPath = [string]$req.pack.png
$DataDir = [string]$req.dataDir
$LogFile = [string]$req.logFile
$ResultFile = [string]$req.resultFile
$SnapshotDir = [string]$req.snapshotDir
$CancelFlag = [string]$req.cancelFlag
$InspectOut = [string]$req.inspectOut
$CurrentPreview = [string]$req.currentPreview
$NoLaunch = [bool]$req.noLaunch
$FullBackup = if ($null -ne $req.fullBackup) { [bool]$req.fullBackup } else { $true }
$RemoveStale = if ($null -ne $req.removeStale) { [bool]$req.removeStale } else { $true }

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogFile) | Out-Null
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

function Say([string]$m) {
    $line = (Get-Date).ToString('HH:mm:ss') + '  ' + $m
    try { Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8 } catch { }
    Write-Output $line
}

function Write-Result([string]$phase, [bool]$ok, [string]$message, $extra) {
    $obj = [ordered]@{
        phase   = $phase
        ok      = $ok
        message = $message
        pack    = $PackName
        at      = (Get-Date).ToString('o')
        pid     = $PID
        log     = $LogFile
        extra   = $extra
    }
    $json = $obj | ConvertTo-Json -Depth 8
    $tmp = $ResultFile + '.tmp'
    try {
        Set-Content -LiteralPath $tmp -Value $json -Encoding UTF8
        Move-Item -LiteralPath $tmp -Destination $ResultFile -Force
    } catch { }
}

# ---------- PE 图标资源 ----------
$code = @'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

public sealed class DshIcoEntry
{
    public int Width, Height, Planes, BitCount, Bytes;
    public ushort Id;
    public byte[] Image;
    public string Sha()
    {
        using (var sha = SHA256.Create())
        {
            byte[] h = sha.ComputeHash(Image);
            var sb = new StringBuilder();
            foreach (byte b in h) sb.Append(b.ToString("x2"));
            return sb.ToString();
        }
    }
}

public static class DshIconPe
{
    const int RT_ICON = 3;
    const int RT_GROUP_ICON = 14;
    const uint LOAD_LIBRARY_AS_DATAFILE = 0x00000002;

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr LoadLibraryEx(string file, IntPtr hFile, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool FreeLibrary(IntPtr module);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr FindResource(IntPtr module, IntPtr name, IntPtr type);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr LoadResource(IntPtr module, IntPtr res);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr LockResource(IntPtr res);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint SizeofResource(IntPtr module, IntPtr res);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool EnumResourceNames(IntPtr module, IntPtr type, EnumNameProc proc, IntPtr param);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool EnumResourceLanguages(IntPtr module, IntPtr type, IntPtr name, EnumLangProc proc, IntPtr param);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr BeginUpdateResource(string file, bool deleteAll);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateResource(IntPtr h, IntPtr type, IntPtr name, ushort lang, byte[] data, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateResource(IntPtr h, IntPtr type, IntPtr name, ushort lang, IntPtr data, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool EndUpdateResource(IntPtr h, bool discard);
    delegate bool EnumNameProc(IntPtr module, IntPtr type, IntPtr name, IntPtr param);
    delegate bool EnumLangProc(IntPtr module, IntPtr type, IntPtr name, ushort lang, IntPtr param);

    static byte[] ResData(IntPtr module, IntPtr type, IntPtr name, ushort lang)
    {
        IntPtr info = FindResource(module, name, type);
        if (info == IntPtr.Zero) return null;
        uint size = SizeofResource(module, info);
        IntPtr loaded = LoadResource(module, info);
        if (loaded == IntPtr.Zero || size == 0) return null;
        IntPtr ptr = LockResource(loaded);
        if (ptr == IntPtr.Zero) return null;
        byte[] data = new byte[size];
        Marshal.Copy(ptr, data, 0, (int)size);
        return data;
    }

    public static int IconCount(string exe)
    {
        int count = 0;
        IntPtr module = LoadLibraryEx(exe, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE);
        if (module == IntPtr.Zero) return -1;
        try { EnumResourceNames(module, (IntPtr)RT_ICON, (m, t, n, p) => { count++; return true; }, IntPtr.Zero); }
        finally { FreeLibrary(module); }
        return count;
    }

    public static List<int> IconIds(string exe)
    {
        var ids = new List<int>();
        IntPtr module = LoadLibraryEx(exe, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE);
        if (module == IntPtr.Zero) return ids;
        try
        {
            EnumResourceNames(module, (IntPtr)RT_ICON, (m, t, n, p) => { long id = n.ToInt64(); if (id >= 0 && id <= 0xFFFF) ids.Add((int)id); return true; }, IntPtr.Zero);
        }
        finally { FreeLibrary(module); }
        ids.Sort();
        return ids;
    }

    public static List<int> GroupIds(string exe)
    {
        var ids = new List<int>();
        IntPtr module = LoadLibraryEx(exe, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE);
        if (module == IntPtr.Zero) return ids;
        try
        {
            EnumResourceNames(module, (IntPtr)RT_GROUP_ICON, (m, t, n, p) => { long id = n.ToInt64(); if (id >= 0 && id <= 0xFFFF) ids.Add((int)id); return true; }, IntPtr.Zero);
        }
        finally { FreeLibrary(module); }
        ids.Sort();
        return ids;
    }

    public static List<DshIcoEntry> ReadGroup(string exe, out int groupId, out ushort groupLang)
    {
        groupId = 0; groupLang = 0;
        var list = new List<DshIcoEntry>();
        IntPtr module = LoadLibraryEx(exe, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE);
        if (module == IntPtr.Zero) return list;
        try
        {
            var ids = GroupIds(exe);
            if (ids.Count == 0) return list;
            int chosen = ids.Contains(1) ? 1 : ids[0];
            var langs = new List<ushort>();
            EnumResourceLanguages(module, (IntPtr)RT_GROUP_ICON, (IntPtr)chosen, (m, t, n, langId, p) => { langs.Add(langId); return true; }, IntPtr.Zero);
            ushort useLang = 0;
            if (langs.Count > 0) useLang = langs.Contains((ushort)1033) ? (ushort)1033 : langs[0];
            byte[] grp = ResData(module, (IntPtr)RT_GROUP_ICON, (IntPtr)chosen, useLang);
            if (grp == null || grp.Length < 6) return list;
            int count = BitConverter.ToUInt16(grp, 4);
            for (int i = 0; i < count; i++)
            {
                int o = 6 + i * 14;
                if (o + 14 > grp.Length) break;
                var e = new DshIcoEntry
                {
                    Width = grp[o] == 0 ? 256 : grp[o],
                    Height = grp[o + 1] == 0 ? 256 : grp[o + 1],
                    Planes = BitConverter.ToUInt16(grp, o + 4),
                    BitCount = BitConverter.ToUInt16(grp, o + 6),
                    Bytes = (int)BitConverter.ToUInt32(grp, o + 8),
                    Id = BitConverter.ToUInt16(grp, o + 12),
                };
                e.Image = ResData(module, (IntPtr)RT_ICON, (IntPtr)e.Id, useLang);
                if (e.Image == null) e.Image = ResData(module, (IntPtr)RT_ICON, (IntPtr)e.Id, 0);
                if (e.Image != null) list.Add(e);
            }
            groupId = chosen;
            groupLang = useLang;
        }
        finally { FreeLibrary(module); }
        return list;
    }

    public static string ExtractTo(string exe, string outPath)
    {
        int groupId; ushort lang;
        var entries = ReadGroup(exe, out groupId, out lang);
        if (entries.Count == 0) return "no-icon-group";
        int header = 6 + entries.Count * 16;
        int total = header;
        foreach (var e in entries) total += e.Image.Length;
        byte[] ico = new byte[total];
        BitConverter.GetBytes((ushort)0).CopyTo(ico, 0);
        BitConverter.GetBytes((ushort)1).CopyTo(ico, 2);
        BitConverter.GetBytes((ushort)entries.Count).CopyTo(ico, 4);
        int offset = header;
        for (int i = 0; i < entries.Count; i++)
        {
            var e = entries[i];
            int o = 6 + i * 16;
            ico[o] = (byte)(e.Width >= 256 ? 0 : e.Width);
            ico[o + 1] = (byte)(e.Height >= 256 ? 0 : e.Height);
            ico[o + 2] = 0;
            ico[o + 3] = 0;
            BitConverter.GetBytes((ushort)e.Planes).CopyTo(ico, o + 4);
            BitConverter.GetBytes((ushort)e.BitCount).CopyTo(ico, o + 6);
            BitConverter.GetBytes((uint)e.Image.Length).CopyTo(ico, o + 8);
            BitConverter.GetBytes((uint)offset).CopyTo(ico, o + 12);
            Buffer.BlockCopy(e.Image, 0, ico, offset, e.Image.Length);
            offset += e.Image.Length;
        }
        File.WriteAllBytes(outPath, ico);
        return "ok group=" + groupId + " lang=" + lang + " count=" + entries.Count;
    }

    // 把一套 .ico 写进 exe：先写 1..N 号 RT_ICON，再删掉多出来的旧图标，最后写 group。
    public static string Patch(string exe, string icoPath, bool removeStale)
    {
        byte[] b = File.ReadAllBytes(icoPath);
        if (b.Length < 22 || BitConverter.ToUInt16(b, 2) != 1) return "ico-header-invalid";
        int count = BitConverter.ToUInt16(b, 4);
        if (count < 1 || count > 64) return "ico-count-invalid";
        int groupId; ushort lang;
        ReadGroup(exe, out groupId, out lang);
        if (groupId == 0) groupId = 1;
        if (lang == 0) lang = 1033;
        var oldIds = IconIds(exe);
        IntPtr upd = BeginUpdateResource(exe, false);
        if (upd == IntPtr.Zero) return "begin-update-failed:" + Marshal.GetLastWin32Error();
        bool done = false;
        try
        {
            for (int i = 0; i < count; i++)
            {
                int off = 6 + i * 16;
                int size = (int)BitConverter.ToUInt32(b, off + 8);
                int imgOff = (int)BitConverter.ToUInt32(b, off + 12);
                if (size <= 0 || imgOff + size > b.Length) return "ico-entry-out-of-range:" + (i + 1);
                byte[] img = new byte[size];
                Buffer.BlockCopy(b, imgOff, img, 0, size);
                if (!UpdateResource(upd, (IntPtr)RT_ICON, (IntPtr)(i + 1), lang, img, (uint)size))
                    return "update-icon-failed:" + (i + 1) + ":" + Marshal.GetLastWin32Error();
            }
            if (removeStale)
            {
                foreach (int id in oldIds)
                {
                    if (id > count)
                    {
                        // 传空数据表示删除；删不掉不算致命，后面的计数会体现出来。
                        UpdateResource(upd, (IntPtr)RT_ICON, (IntPtr)id, lang, IntPtr.Zero, 0);
                    }
                }
            }
            byte[] grp = new byte[6 + count * 14];
            Buffer.BlockCopy(b, 0, grp, 0, 6);
            for (int i = 0; i < count; i++)
            {
                int so = 6 + i * 16, dof = 6 + i * 14;
                Buffer.BlockCopy(b, so, grp, dof, 8);
                Buffer.BlockCopy(b, so + 8, grp, dof + 8, 4);
                BitConverter.GetBytes((ushort)(i + 1)).CopyTo(grp, dof + 12);
            }
            if (!UpdateResource(upd, (IntPtr)RT_GROUP_ICON, (IntPtr)groupId, lang, grp, (uint)grp.Length))
                return "update-group-failed:" + Marshal.GetLastWin32Error();
            if (!EndUpdateResource(upd, false)) return "end-update-failed:" + Marshal.GetLastWin32Error();
            done = true;
            return "patched group=" + groupId + " lang=" + lang + " count=" + count;
        }
        finally
        {
            if (!done)
            {
                try { EndUpdateResource(upd, true); } catch { }
            }
        }
    }

    // 逐张比对：group 的条目数、每张图的字节都得和新 .ico 对得上。
    public static List<string> Verify(string exe, string icoPath)
    {
        var problems = new List<string>();
        byte[] b = File.ReadAllBytes(icoPath);
        int want = BitConverter.ToUInt16(b, 4);
        var src = new List<DshIcoEntry>();
        for (int i = 0; i < want; i++)
        {
            int off = 6 + i * 16;
            int size = (int)BitConverter.ToUInt32(b, off + 8);
            int imgOff = (int)BitConverter.ToUInt32(b, off + 12);
            var e = new DshIcoEntry
            {
                Width = b[off] == 0 ? 256 : b[off],
                Height = b[off + 1] == 0 ? 256 : b[off + 1],
                BitCount = BitConverter.ToUInt16(b, off + 6),
                Bytes = size,
                Image = new byte[size],
            };
            Buffer.BlockCopy(b, imgOff, e.Image, 0, size);
            src.Add(e);
        }
        int groupId; ushort lang;
        var got = ReadGroup(exe, out groupId, out lang);
        if (got.Count != src.Count) problems.Add("group count " + got.Count + " != " + src.Count);
        int n = Math.Min(got.Count, src.Count);
        for (int i = 0; i < n; i++)
        {
            if (got[i].Width != src[i].Width || got[i].Height != src[i].Height)
                problems.Add("entry " + (i + 1) + " size " + got[i].Width + "x" + got[i].Height + " != " + src[i].Width + "x" + src[i].Height);
            if (got[i].Sha() != src[i].Sha())
                problems.Add("entry " + (i + 1) + " bytes differ");
        }
        int icons = IconCount(exe);
        if (icons != src.Count) problems.Add("RT_ICON count " + icons + " != " + src.Count);
        return problems;
    }
}
'@
Add-Type -TypeDefinition $code -Language CSharp

function Get-IconFacts([string]$exe) {
    $groupId = 0; $groupLang = [uint16]0
    $entries = [DshIconPe]::ReadGroup($exe, [ref]$groupId, [ref]$groupLang)
    $list = @()
    foreach ($e in $entries) {
        $list += [ordered]@{
            width = $e.Width; height = $e.Height; bpp = $e.BitCount; bytes = $e.Bytes
            sha256 = $e.Sha()
        }
    }
    return [ordered]@{
        ok = ($entries.Count -gt 0)
        iconCount = [DshIconPe]::IconCount($exe)
        groupId = $groupId
        lang = $groupLang
        count = $entries.Count
        entries = $list
        exe = [ordered]@{
            path = $exe
            size = (Get-Item -LiteralPath $exe).Length
            mtime = (Get-Item -LiteralPath $exe).LastWriteTimeUtc.ToString('o')
        }
    }
}

function Test-AppRunning([string]$exe) {
    foreach ($p in @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)) {
        try { if ($p.Path -and ($p.Path -ieq $exe)) { return $true } } catch { }
    }
    return $false
}

function Wait-AppGone([int]$targetPid, [string]$exe, [int]$seconds) {
    $targetStart = $null
    if ($targetPid -gt 0) {
        $p0 = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
        if ($p0) { try { $targetStart = $p0.StartTime } catch { } }
    }
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        if ($CancelFlag -and (Test-Path -LiteralPath $CancelFlag)) { return 'cancelled' }
        $p = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
        if (-not $p) { return 'gone' }
        if ($targetStart) {
            try { if ($p.StartTime -ne $targetStart) { return 'gone' } } catch { }
        }
        Start-Sleep -Milliseconds 700
    }
    return 'timeout'
}

function Wait-ExeWritable([string]$exe) {
    for ($i = 0; $i -lt 120; $i++) {
        try {
            $fs = [IO.File]::Open($exe, 'Open', 'ReadWrite', 'None')
            $fs.Close()
            return $true
        } catch { Start-Sleep -Milliseconds 300 }
    }
    return $false
}

function Start-Dsh([string]$exe) {
    Say '启动 DSH……'
    Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe) | Out-Null
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 1000
        if (Test-AppRunning $exe) {
            # 刚起来不代表站住了：等几秒再看一眼，别把秒崩当成功。
            Start-Sleep -Seconds 4
            return (Test-AppRunning $exe)
        }
    }
    return $false
}

function Copy-ResourcesIn([string]$tray, [string]$png, [string]$resDir) {
    if ($tray -and (Test-Path -LiteralPath $tray)) { Copy-Item -LiteralPath $tray -Destination (Join-Path $resDir 'tray.ico') -Force }
    if ($png -and (Test-Path -LiteralPath $png)) { Copy-Item -LiteralPath $png -Destination (Join-Path $resDir 'icon.png') -Force }
}

# ============================================================
#  inspect：只读，给插件面板看“现在 exe 里是哪套图标”
# ============================================================
if ($Mode -eq 'inspect') {
    try {
        if (-not (Test-Path -LiteralPath $Exe)) { throw "找不到 exe：$Exe" }
        $facts = Get-IconFacts $Exe
        if ($CurrentPreview) {
            # 给面板一张“现在长什么样”的图；当前这套不一定是内置的。
            try {
                $tmpIco = Join-Path $DataDir 'current-inspect.ico'
                $ex = [DshIconPe]::ExtractTo($Exe, $tmpIco)
                if ($ex.StartsWith('ok')) {
                    Add-Type -AssemblyName System.Drawing
                    $ico = New-Object System.Drawing.Icon($tmpIco, 128, 128)
                    $bmp = $ico.ToBitmap()
                    $bmp.Save($CurrentPreview, [System.Drawing.Imaging.ImageFormat]::Png)
                    $bmp.Dispose()
                    $ico.Dispose()
                }
                Remove-Item -LiteralPath $tmpIco -Force -ErrorAction SilentlyContinue
            } catch { }
        }
        $json = $facts | ConvertTo-Json -Depth 8
        if ($InspectOut) {
            $tmp = $InspectOut + '.tmp'
            Set-Content -LiteralPath $tmp -Value $json -Encoding UTF8
            Move-Item -LiteralPath $tmp -Destination $InspectOut -Force
        }
        Write-Output $json
        exit 0
    } catch {
        Say ("inspect 失败：" + $_.Exception.Message)
        if ($InspectOut) { Set-Content -LiteralPath $InspectOut -Value (@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json) -Encoding UTF8 }
        exit 2
    }
}

# ============================================================
#  apply / test：等退出 → 备份 → 打补丁 → 验证 → 换资源 → 重开
# ============================================================
$phase = 'start'
$dirty = $false
$backupMadeThisRun = $false
$snapshotIco = $null
$snap = $null
try {
    Say "=== dsh-app-icon · $Mode · pack=$PackName ==="
    Say "exe=$Exe"
    New-Item -ItemType Directory -Force -Path $SnapshotDir | Out-Null

    if (-not (Test-Path -LiteralPath $Exe)) { throw "找不到 DSH 的 exe：$Exe" }
    if (-not (Test-Path -LiteralPath $IconPath)) { throw "找不到图标：$IconPath" }
    if (-not (Test-Path -LiteralPath $Resources)) { throw "找不到 resources 目录：$Resources" }

    # 1. 等 DSH 退出
    if ($AppPid -gt 0 -and -not $NoLaunch) {
        $phase = 'waiting'
        Write-Result 'waiting' $true '等你退出 DSH。退出后会自动换图标并重新打开。' @{ appPid = $AppPid }
        Say "等 DSH（pid=$AppPid）退出，最多 $WaitSeconds 秒……"
        $wait = Wait-AppGone $AppPid $Exe $WaitSeconds
        if ($wait -eq 'cancelled') { Say '收到取消。'; Write-Result 'cancelled' $false '已取消，什么都没改。' @{}; exit 0 }
        if ($wait -eq 'timeout') { Say '等超时，DSH 还在跑。'; Write-Result 'timeout' $false 'DSH 一直没退出，什么都没改。下次再试。' @{}; exit 1 }
        Say 'DSH 已退出。'
    }

    # 2. 等 exe 解锁
    $phase = 'unlock'
    Write-Result 'unlocking' $true 'DSH 已退出，正在确认文件能写。' @{}
    if (-not (Wait-ExeWritable $Exe)) { throw 'exe 还是被占用，写不了' }

    # 3. 备份：小备份（图标 + resources）+ 整只 exe（可选）
    $phase = 'backup'
    $snapStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $snap = Join-Path $SnapshotDir $snapStamp
    New-Item -ItemType Directory -Force -Path $snap | Out-Null
    $snapshotIco = Join-Path $snap 'current.ico'
    $ex = [DshIconPe]::ExtractTo($Exe, $snapshotIco)
    if ($ex -ne 'ok' -and -not $ex.StartsWith('ok ')) { throw "没法从 exe 里取出旧图标（$ex），不动它" }
    $oldFacts = Get-IconFacts $Exe
    if (Test-Path -LiteralPath (Join-Path $Resources 'icon.png')) { Copy-Item -LiteralPath (Join-Path $Resources 'icon.png') -Destination (Join-Path $snap 'icon.png') -Force }
    if (Test-Path -LiteralPath (Join-Path $Resources 'tray.ico')) { Copy-Item -LiteralPath (Join-Path $Resources 'tray.ico') -Destination (Join-Path $snap 'tray.ico') -Force }
    @{ pack = $PackName; at = (Get-Date).ToString('o'); before = $oldFacts } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $snap 'meta.json') -Encoding UTF8
    Say "旧图标备份在 $snap（$($oldFacts.count) 个尺寸）"

    $fullBackupPath = Join-Path (Join-Path $DataDir 'backup') 'exe-last-good.exe'
    if ($FullBackup) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $fullBackupPath) | Out-Null
        Say '复制整只 exe 做兜底（246 MB，稍等）……'
        Copy-Item -LiteralPath $Exe -Destination $fullBackupPath -Force
        $backupMadeThisRun = $true
    }

    # 4. 打补丁
    $phase = 'patching'
    Write-Result 'patching' $true '正在改 exe 图标……' @{}
    $dirty = $true
    $patch = [DshIconPe]::Patch($Exe, $IconPath, $RemoveStale)
    Say "exe 补丁：$patch"
    if (-not $patch.StartsWith('patched')) { throw "补丁没成：$patch" }
    $problems = @([DshIconPe]::Verify($Exe, $IconPath))
    $newFacts = Get-IconFacts $Exe
    Say "补丁后：$($newFacts.count) 个 group 尺寸，RT_ICON $($newFacts.iconCount) 个"
    if ($problems.Count -gt 0) {
        Say ('验证没过：' + ($problems -join '；'))
        throw ('打完核对不上：' + ($problems -join '；'))
    }
    Say '逐张比对通过。'

    # 5. 换 resources
    $phase = 'resources'
    Copy-ResourcesIn $TrayPath $PngPath $Resources
    Say 'resources\tray.ico 和 icon.png 换好了。'
    try { Start-Process -FilePath 'ie4uinit.exe' -ArgumentList '-show' -Wait -WindowStyle Hidden | Out-Null } catch { }

    if ($NoLaunch -or $Mode -eq 'test') {
        $msg = if ($Mode -eq 'test') { '测试模式：图标已写入副本并验证通过，没有启动。' } else { '图标已写入并验证通过；按要求没有启动 DSH。' }
        Write-Result 'done' $true $msg @{ facts = $newFacts; snapshot = $snap }
        exit 0
    }

    # 6. 重开并确认
    $phase = 'starting'
    Write-Result 'starting' $true '图标换好了，正在打开 DSH……' @{ facts = $newFacts; snapshot = $snap }
    if (Start-Dsh $Exe) {
        Say 'DSH 已经起来了。'
        Write-Result 'done' $true '换好了，DSH 已重新打开。' @{ facts = $newFacts; snapshot = $snap }
        exit 0
    }

    # 7. 起不来 → 整只还原
    $phase = 'rollback'
    Say 'DSH 没起来，开始还原……'
    if ($FullBackup -and (Test-Path -LiteralPath $fullBackupPath)) {
        Copy-Item -LiteralPath $fullBackupPath -Destination $Exe -Force
    } else {
        $restore = [DshIconPe]::Patch($Exe, $snapshotIco, $true)
        Say "按备份图标还原：$restore"
    }
    if (Test-Path -LiteralPath (Join-Path $snap 'icon.png')) { Copy-Item -LiteralPath (Join-Path $snap 'icon.png') -Destination (Join-Path $Resources 'icon.png') -Force }
    if (Test-Path -LiteralPath (Join-Path $snap 'tray.ico')) { Copy-Item -LiteralPath (Join-Path $snap 'tray.ico') -Destination (Join-Path $Resources 'tray.ico') -Force }
    $back = Start-Dsh $Exe
    if ($back) { Write-Result 'rolled-back' $false 'DSH 没起来，已整只还原并重新打开。图标还是原来的。' @{ snapshot = $snap } }
    else { Write-Result 'failed' $false 'DSH 没起来，还原后也没起来。请手动打开 DSH 看看日志。' @{ snapshot = $snap } }
    exit 1
} catch {
    $msg = $_.Exception.Message
    Say ("出错：" + $msg)
    # 只有真的动过 exe 才还原；没动过就别拿旧备份去覆盖（可能是上个版本）。
    if ($dirty) {
        try {
            if ($backupMadeThisRun -and $fullBackupPath -and (Test-Path -LiteralPath $fullBackupPath)) {
                Copy-Item -LiteralPath $fullBackupPath -Destination $Exe -Force
                Say '已用整只备份还原 exe。'
            } elseif ($snapshotIco -and (Test-Path -LiteralPath $snapshotIco)) {
                [void][DshIconPe]::Patch($Exe, $snapshotIco, $true)
                Say '已用图标备份还原 exe。'
            }
            if ($snap) {
                if (Test-Path -LiteralPath (Join-Path $snap 'icon.png')) { Copy-Item -LiteralPath (Join-Path $snap 'icon.png') -Destination (Join-Path $Resources 'icon.png') -Force }
                if (Test-Path -LiteralPath (Join-Path $snap 'tray.ico')) { Copy-Item -LiteralPath (Join-Path $snap 'tray.ico') -Destination (Join-Path $Resources 'tray.ico') -Force }
            }
        } catch { Say ('还原也失败了：' + $_.Exception.Message) }
    }
    if (-not $NoLaunch -and -not (Test-AppRunning $Exe)) {
        [void](Start-Dsh $Exe)
    }
    Write-Result 'failed' $false $msg @{ snapshot = $snap; dirty = $dirty }
    exit 1
}
