# Installs the Windows build toolchain for inside-llm under $Root (default C:\ils\tools).
# Prerequisites already on the machine: Visual Studio 2022 Build Tools (C++ workload,
# Windows SDK), CMake >= 3.24, Ninja and Git.
#
#   CUDA 12.9    NVIDIA redistributable zips (no installer, no admin rights)
#   vcpkg        git clone + bootstrap; zlib for the x64-windows-static-md triplet
#   Vulkan SDK   LunarG installer through winget: needs an elevated shell, so it is
#                only checked here (-InstallVulkan to run winget from an elevated shell)
#
# Idempotent: what is already there is skipped.
param(
    [string]$Root = "C:\ils\tools",
    [string]$CudaVersion = "12.9.1",
    [switch]$InstallVulkan,
    [switch]$SkipZlib
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest is very slow with the progress bar
New-Item -ItemType Directory -Force -Path $Root | Out-Null

# ---------------------------------------------------------------- CUDA
$cuda = Join-Path $Root "cuda-$CudaVersion"
if (-not (Test-Path (Join-Path $cuda "bin\nvcc.exe"))) {
    $base = "https://developer.download.nvidia.com/compute/cuda/redist"
    $manifest = Invoke-RestMethod "$base/redistrib_$CudaVersion.json"
    # What ggml-cuda needs to build and link: compiler, runtime, headers, cuBLAS.
    $parts = "cuda_nvcc", "cuda_cudart", "cuda_cccl", "cuda_profiler_api", "libcublas"
    $dl = Join-Path $Root "downloads"
    New-Item -ItemType Directory -Force -Path $dl, $cuda | Out-Null
    foreach ($p in $parts) {
        $rel = $manifest.$p."windows-x86_64".relative_path
        if (-not $rel) { throw "no windows-x86_64 build of $p in CUDA $CudaVersion" }
        $zip = Join-Path $dl (Split-Path $rel -Leaf)
        if (-not (Test-Path $zip)) {
            Write-Host "downloading $p"
            Invoke-WebRequest "$base/$rel" -OutFile "$zip.part"
            Move-Item "$zip.part" $zip
        }
        $tmp = Join-Path $dl "x-$p"
        if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
        New-Item -ItemType Directory -Path $tmp | Out-Null
        tar.exe -xf $zip -C $tmp
        if ($LASTEXITCODE -ne 0) { throw "cannot extract $zip" }
        # Each zip holds one <name>-archive folder with bin/, include/, lib/...: merge them.
        $top = Get-ChildItem $tmp -Directory | Select-Object -First 1
        Copy-Item -Recurse -Force (Join-Path $top.FullName "*") $cuda
        Remove-Item -Recurse -Force $tmp
    }
    Write-Host "CUDA $CudaVersion in $cuda"
} else { Write-Host "CUDA $CudaVersion already in $cuda" }

# ---------------------------------------------------------------- vcpkg + zlib
$vcpkg = Join-Path $Root "vcpkg"
if (-not (Test-Path (Join-Path $vcpkg "vcpkg.exe"))) {
    if (-not (Test-Path $vcpkg)) { git clone --depth 1 https://github.com/microsoft/vcpkg $vcpkg }
    & (Join-Path $vcpkg "bootstrap-vcpkg.bat") -disableMetrics
    if ($LASTEXITCODE -ne 0) { throw "vcpkg bootstrap failed" }
}
if (-not $SkipZlib) {
    & (Join-Path $vcpkg "vcpkg.exe") install zlib:x64-windows-static-md
    if ($LASTEXITCODE -ne 0) { throw "vcpkg install zlib failed" }
}

# ---------------------------------------------------------------- Vulkan SDK
if ($InstallVulkan) {
    winget install -e --id KhronosGroup.VulkanSDK --accept-package-agreements --accept-source-agreements --disable-interactivity
}
$sdk = [Environment]::GetEnvironmentVariable("VULKAN_SDK", "Machine")
if ($sdk -and (Test-Path (Join-Path $sdk "Bin\glslc.exe"))) {
    Write-Host "Vulkan SDK in $sdk"
} else {
    Write-Warning "Vulkan SDK missing: in an elevated PowerShell run  winget install -e --id KhronosGroup.VulkanSDK"
}
