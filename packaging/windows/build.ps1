# Builds the Windows binaries of inside-llm and packs one zip per GPU backend
# (<version> is project(inside_llm VERSION ...) of CMakeLists.txt):
#
#   inside-llm-v<version>-windows-cuda.zip    inside-llm.exe + cudart/cuBLAS DLLs + MSVC runtime
#   inside-llm-v<version>-windows-vulkan.zip  inside-llm.exe + MSVC runtime (vulkan-1.dll comes with the driver)
#
# Both also carry LICENSE.txt, LICENSE.llama.cpp.txt, LICENSE.libressl.txt and
# THIRD_PARTY_NOTICES.txt (every third-party component and its license text).
#
# Needs the toolchain of setup-tools.ps1 and a source tree with web/dist already
# built (both copied from a Linux host).
param(
    [string]$Src = "C:\ils\src",
    [string]$Out = "C:\ils\out",
    [string]$Tools = "C:\ils\tools",
    # Comma-separated, so it also works through `powershell -File`.
    [string]$Variants = "cuda,vulkan",
    [string]$CudaVersion = "12.9.1",
    # The same list as DIST_CUDA_ARCH in the Makefile: Turing (RTX 20) to Blackwell (RTX 50).
    [string]$CudaArch = "75-real;80-real;86-real;89-real;120a-real",
    [int]$Jobs = 8,
    # Optional tar of the source tree: replaces $Src (except build\ for incremental rebuilds and models\ for the tests).
    [string]$Tarball = ""
)
$ErrorActionPreference = "Stop"

function Invoke-Checked([string]$what, [scriptblock]$cmd) {
    & $cmd
    if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" }
}

if ($Tarball) {
    New-Item -ItemType Directory -Force -Path $Src | Out-Null
    Get-ChildItem $Src -Exclude build, models | Remove-Item -Recurse -Force
    Invoke-Checked "unpack $Tarball" { tar.exe -xf $Tarball -C $Src }
    Remove-Item $Tarball
}

# ------------------------------------------------------------ environment
# MSVC x64 environment from vcvars64.bat, imported into this PowerShell.
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw "no Visual Studio with the C++ x64 tools" }
cmd /c "`"$vs\VC\Auxiliary\Build\vcvars64.bat`" >nul && set" | ForEach-Object {
    if ($_ -match "^([^=]+)=(.*)$") { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2]) }
}
$cuda = Join-Path $Tools "cuda-$CudaVersion"
$vcpkg = Join-Path $Tools "vcpkg"
$sdk = [Environment]::GetEnvironmentVariable("VULKAN_SDK", "Machine")
if ($sdk) { $env:VULKAN_SDK = $sdk; $env:PATH = "$sdk\Bin;$env:PATH" }

# MSVC runtime DLLs, deployed next to the exe (app-local), so no VC++ redist install is needed.
$redist = Get-ChildItem "$vs\VC\Redist\MSVC" -Directory | Where-Object { Test-Path "$($_.FullName)\x64" } |
    Sort-Object Name -Descending | Select-Object -First 1
# Only what inside-llm.exe imports (dumpbin /dependents): the C++ runtime and OpenMP.
$crt = Get-ChildItem "$($redist.FullName)\x64\Microsoft.VC*.CRT\*.dll", "$($redist.FullName)\x64\Microsoft.VC*.OpenMP\*.dll" |
    Where-Object { $_.Name -in "msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll", "vcomp140.dll" }
if ($crt.Count -ne 4) { throw "MSVC runtime DLLs not found in $($redist.FullName)" }

if (-not (Test-Path "$Src\web\dist\index.html")) { throw "$Src\web\dist is missing: build the web first" }
# The version comes from CMakeLists.txt only, as in the Makefile.
$m = Select-String -Path "$Src\CMakeLists.txt" -Pattern 'project\(inside_llm VERSION ([0-9.]+)'
if (-not $m) { throw "no project(inside_llm VERSION ...) in $Src\CMakeLists.txt" }
$Version = $m.Matches[0].Groups[1].Value
New-Item -ItemType Directory -Force -Path $Out | Out-Null

foreach ($v in ($Variants -split ",")) {
    $build = Join-Path $Src "build\win-$v"
    $cfg = @("-S", $Src, "-B", $build, "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release", "-DILS_DIST=ON",
              "-DCMAKE_TOOLCHAIN_FILE=$vcpkg\scripts\buildsystems\vcpkg.cmake",
              "-DVCPKG_TARGET_TRIPLET=x64-windows-static-md")
    if ($v -eq "cuda") {
        if (-not (Test-Path "$cuda\bin\nvcc.exe")) { throw "CUDA not found in $cuda (run setup-tools.ps1)" }
        $env:CUDA_PATH = $cuda
        $cfg += "-DILS_BACKEND=CUDA", "-DCUDAToolkit_ROOT=$cuda", "-DCMAKE_CUDA_COMPILER=$cuda\bin\nvcc.exe",
                 "-DCMAKE_CUDA_ARCHITECTURES=$CudaArch"
    } elseif ($v -eq "vulkan") {
        if (-not $sdk) { throw "Vulkan SDK not installed (see setup-tools.ps1)" }
        $cfg += "-DILS_BACKEND=VULKAN"
    } else { throw "unknown variant $v" }

    Write-Host "== ${v}: configure"
    Invoke-Checked "cmake configure ($v)" { cmake @cfg }
    Write-Host "== ${v}: build"
    Invoke-Checked "cmake build ($v)" { cmake --build $build --target inside-llm -j $Jobs }

    # ---------------------------------------------------------------- pack
    $pkg = Join-Path $Out "inside-llm-v$Version-windows-$v"
    if (Test-Path $pkg) { Remove-Item -Recurse -Force $pkg }
    New-Item -ItemType Directory -Path $pkg | Out-Null
    Copy-Item "$build\inside-llm.exe" $pkg
    Copy-Item "$Src\LICENSE" "$pkg\LICENSE.txt"
    Copy-Item "$Src\third_party\llama.cpp\LICENSE" "$pkg\LICENSE.llama.cpp.txt"
    Copy-Item "$build\_deps\libressl-src\COPYING" "$pkg\LICENSE.libressl.txt"
    Copy-Item "$Src\THIRD_PARTY_NOTICES" "$pkg\THIRD_PARTY_NOTICES.txt"
    $crt | Copy-Item -Destination $pkg
    if ($v -eq "cuda") {
        foreach ($d in "cudart64_12.dll", "cublas64_12.dll", "cublasLt64_12.dll") { Copy-Item "$cuda\bin\$d" $pkg }
    }
    # What the exe imports, for the results document.
    dumpbin /nologo /dependents "$pkg\inside-llm.exe" | Out-File -Encoding utf8 "$Out\deps-$v.txt"
    # The CUDA exe imports nvcuda.dll, which only the NVIDIA driver installs: without it
    # Windows refuses to start the process (0xC0000135), so the smoke test is skipped.
    if ($v -eq "cuda" -and -not (Test-Path "$env:SystemRoot\System32\nvcuda.dll")) {
        "smoke test skipped: no NVIDIA driver (nvcuda.dll) on this machine" | Out-File -Encoding utf8 "$Out\help-$v.txt"
    } else {
        Invoke-Checked "smoke test ($v)" { & "$pkg\inside-llm.exe" --help | Out-File -Encoding utf8 "$Out\help-$v.txt" }
    }

    $zip = "$pkg.zip"
    if (Test-Path $zip) { Remove-Item -Force $zip }
    Push-Location $Out
    Invoke-Checked "zip ($v)" { tar.exe -a -c -f $zip (Split-Path $pkg -Leaf) }
    Pop-Location
    "{0}: {1:N1} MB" -f $zip, ((Get-Item $zip).Length / 1MB)
}
