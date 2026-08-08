# Build ESB64Native.dll (the ESB64 ExternalObject accelerator for ESPACK).
# FREESTANDING: no CRT - kernel32 imports only (own allocator + libc
# substitutes in espk-b64.c). clang+lld with the ArcFit family flags
# (-O3 -ffreestanding -fno-builtin -march=x86-64-v2 -mtune=generic -flto,
# portable to any Windows x64 >= Win10 2015) when available; MSVC fallback
# (both link /nodefaultlib /entry:DllMain). The PE timestamp is fixed
# (/timestamp:0, or /Brepro for MSVC) so rebuilds are byte-identical -
# espack's vendor drift guard and the parity contract compare DLL bytes.
# Usage: powershell -ExecutionPolicy Bypass -File build.ps1 [-Name ESB64Native2.dll]
# Numbered output name: a loaded DLL stays locked until the host app exits
# (LNK1104). Pass -Name to build an iteration without closing Illustrator.

param(
    [string]$Name = "ESB64Native.dll"
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Find-VsDevCmd {
    $candidates = @(
        "C:\Program Files\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat",
        "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat",
        "C:\Program Files\Microsoft Visual Studio\2019\BuildTools\Common7\Tools\VsDevCmd.bat",
        "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\Common7\Tools\VsDevCmd.bat"
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
    throw "VsDevCmd.bat not found - install 'Desktop development with C++' (Build Tools)"
}

# Capture the environment vcvars64 sets (INCLUDE/LIB for the Windows SDK
# headers + kernel32.lib), then build inside it.
$devcmd = Find-VsDevCmd
$envBlock = cmd /c "`"$devcmd`" -arch=x64 -host_arch=x64 >nul 2>&1 && set"
$envBlock | ForEach-Object {
    if ($_ -match "^(.*?)=(.*)$") {
        [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
    }
}

$outDir = Join-Path $here "bin"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$dllName = "ESB64Native.dll"
if ($Name) { $dllName = $Name }

$src = Join-Path $here "espk-b64.c"
$obj = Join-Path $here "espk-b64.obj"
$out = Join-Path $outDir $dllName

# Locate clang + lld (family toolchain): env override, emsdk default, then
# any LLVM install found by vswhere.
$clang = $env:CLANG_PATH
$lld = $env:LLD_PATH
if (-not $clang -or -not $lld) {
    $emsdk = "C:\dev\emsdk\upstream\bin"
    if (-not $clang -and (Test-Path (Join-Path $emsdk "clang.exe"))) { $clang = Join-Path $emsdk "clang.exe" }
    if (-not $lld -and (Test-Path (Join-Path $emsdk "lld.exe"))) { $lld = Join-Path $emsdk "lld.exe" }
}
if (-not $clang -or -not $lld) {
    $vswhere = "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $vswhere) {
        $llvmDir = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Llvm.Clang -property installationPath 2>$null
        if ($llvmDir) {
            if (-not $clang) { $clang = Join-Path $llvmDir "VC\Tools\Llvm\x64\bin\clang.exe" }
            if (-not $lld) { $lld = Join-Path $llvmDir "VC\Tools\Llvm\x64\bin\lld.exe" }
        }
    }
}

$libPaths = @()
foreach ($lp in ($env:LIB -split ';')) {
    if ($lp.Trim()) { $libPaths += "/libpath:$($lp.Trim())" }
}
$incPaths = @()
foreach ($ip in ($env:INCLUDE -split ';')) {
    if ($ip.Trim()) { $incPaths += "-I$($ip.Trim().Replace('\\', '\'))" }
}

$built = $false
if ($clang -and $lld -and (Test-Path $clang) -and (Test-Path $lld)) {
    Write-Output "ESB64Native build: clang+lld (freestanding, x86-64-v2, -O3 -flto)"
    & $clang --target=x86_64-pc-windows-msvc -O3 -ffast-math -ffreestanding `
        -fno-stack-protector -mno-stack-arg-probe -fno-builtin `
        -march=x86-64-v2 -mtune=generic -flto @incPaths -c "$src" -o "$obj"
    if ($LASTEXITCODE -ne 0) { throw "clang failed with exit $LASTEXITCODE" }
    & $lld -flavor link /dll /entry:DllMain /subsystem:windows /nodefaultlib `
        /machine:x64 /timestamp:0 /out:"$out" "$obj" @libPaths kernel32.lib
    if ($LASTEXITCODE -ne 0) { throw "lld failed with exit $LASTEXITCODE" }
    $built = $true
} elseif (Get-Command cl -ErrorAction SilentlyContinue) {
    Write-Output "ESB64Native build: MSVC fallback (freestanding, /nodefaultlib)"
    & cl /nologo /O2 /GS- /c "$src" /Fo:"$obj"
    if ($LASTEXITCODE -ne 0) { throw "cl failed with exit $LASTEXITCODE" }
    & link /dll /nodefaultlib /entry:DllMain /subsystem:windows /machine:x64 `
        /Brepro /out:"$out" "$obj" @libPaths kernel32.lib
    if ($LASTEXITCODE -ne 0) { throw "link failed with exit $LASTEXITCODE" }
    $built = $true
} else {
    throw "No toolchain: set CLANG_PATH/LLD_PATH (or install Build Tools with the MSVC fallback)"
}

if ($built) {
    Write-Output ""
    $size = (Get-Item $out).Length
    Write-Output "Built: $out ($size bytes)"
    try { & dumpbin /exports $out | Select-Object -First 20 } catch { }
    Remove-Item -LiteralPath $obj -Force -ErrorAction SilentlyContinue
}
