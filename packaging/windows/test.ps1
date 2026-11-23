# Runs the engine tests on Windows, in a build tree made by build.ps1.
#
#   test.ps1                 unit tests (no model, no GPU)
#   test.ps1 -Gpu            also the integration tests with models\Qwen3.5-0.8B-Q4_K_M.gguf
#   test.ps1 -Gpu -Icd FILE  ... on the Vulkan driver of that ICD file (e.g. a software one)
param(
    [string]$Src = "C:\ils\src",
    [string]$Variant = "vulkan",
    [switch]$Gpu,
    [string]$Icd = ""
)
$ErrorActionPreference = "Stop"

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
cmd /c "`"$vs\VC\Auxiliary\Build\vcvars64.bat`" >nul && set" | ForEach-Object {
    if ($_ -match "^([^=]+)=(.*)$") { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2]) }
}
$sdk = [Environment]::GetEnvironmentVariable("VULKAN_SDK", "Machine")
if ($sdk) { $env:VULKAN_SDK = $sdk; $env:PATH = "$sdk\Bin;$env:PATH" }

$build = Join-Path $Src "build\win-$Variant"
if (-not (Test-Path "$build\CMakeCache.txt")) { throw "$build is not configured: run build.ps1 first" }
$targets = @("unit_tests") + $(if ($Gpu) { @("gpu_tests") } else { @() })
foreach ($t in $targets) {
    cmake --build $build --target $t
    if ($LASTEXITCODE -ne 0) { throw "building $t failed" }
}

Push-Location $build
try {
    ctest -LE gpu --output-on-failure
    $unit = $LASTEXITCODE
    $gpuRc = 0
    if ($Gpu) {
        if ($Icd) {
            # Loader of the Vulkan SDK; ggml-vulkan skips CPU-type devices unless told.
            $env:VK_DRIVER_FILES = $Icd; $env:VK_ICD_FILENAMES = $Icd; $env:GGML_VK_VISIBLE_DEVICES = "0"
        }
        ctest -L gpu -E gemma --output-on-failure   # the Gemma test needs a 4B model: too slow off the GPU
        $gpuRc = $LASTEXITCODE
    }
} finally { Pop-Location }
"unit: exit $unit; gpu: exit $gpuRc"
if ($unit -ne 0 -or $gpuRc -ne 0) { exit 1 }
