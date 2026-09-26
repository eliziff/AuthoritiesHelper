$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Owner = $PSScriptRoot
$Repo = Split-Path -Parent (Split-Path -Parent $Owner)
$Out = Join-Path $Owner 'out'
$Stage = Join-Path $Out 'authorities-win-x64'
$Zip = Join-Path $Out 'Authorities-win-x64.zip'
$Cache = Join-Path $Out '.cache'
$NodeVersion = '22.20.0'
$NodeArchive = "node-v$NodeVersion-win-x64.zip"
$NodeSha256 = 'bb819d6eb8f5bfda294bbc83a7e4ec6539da67c4233d54b0d655b9248b15e29d'

foreach ($target in @($Stage, $Zip)) {
    $resolved = [IO.Path]::GetFullPath($target)
    if (-not $resolved.StartsWith(([IO.Path]::GetFullPath($Repo) + [IO.Path]::DirectorySeparatorChar),
        [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe package target: $resolved" }
}

function Invoke-Checked([string]$Command, [string[]]$Arguments, [string]$Directory = $Repo) {
    Push-Location $Directory
    try { & $Command @Arguments; if ($LASTEXITCODE -ne 0) { throw "$Command failed ($LASTEXITCODE)" } }
    finally { Pop-Location }
}

New-Item -ItemType Directory -Path $Out, $Cache -Force | Out-Null
Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $Zip -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $Stage -Force | Out-Null

$frontend = Join-Path $Repo 'frontend'
Invoke-Checked (Join-Path $frontend 'node_modules\.bin\tsc.cmd') @('--noEmit') $frontend
Invoke-Checked 'npm.cmd' @('run', 'build', '--prefix', 'backend')
$NativeDll = Join-Path $Repo 'native\legal-structure-node\target\release\legal_structure_node.dll'
foreach ($required in @('legal-pdf-parser\runtime\onnxruntime.dll',
    'legal-pdf-parser\runtime\legalpdf_tesseract_layout.dll',
    'legal-pdf-parser\runtime\kraken\model.onnx',
    'legal-pdf-parser\runtime\kraken\codec.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $Repo $required) -PathType Leaf)) {
        throw "Missing package input: $required"
    }
}
if (-not (Test-Path -LiteralPath $NativeDll -PathType Leaf)) {
    throw "Missing package input: $NativeDll. Build the pinned native engine before packaging."
}

Invoke-Checked 'node.exe' @('--test', (Join-Path $Owner 'scripts/authorities-package/bundle.test.mjs'))
Invoke-Checked 'node.exe' @((Join-Path $Owner 'scripts/authorities-package/bundle.mjs'), $Stage)

$runtime = Join-Path $Stage 'runtime'
$pdfRuntime = Join-Path $runtime 'legal-pdf-parser\runtime'
New-Item -ItemType Directory -Path (Join-Path $runtime 'legal-structure'),
    (Join-Path $pdfRuntime 'kraken') -Force | Out-Null
Copy-Item -LiteralPath $NativeDll `
    -Destination (Join-Path $runtime 'legal-structure\legal_structure_node.dll')
Copy-Item -LiteralPath (Join-Path $Repo 'legal-pdf-parser\runtime\onnxruntime.dll'),
    (Join-Path $Repo 'legal-pdf-parser\runtime\legalpdf_tesseract_layout.dll') -Destination $pdfRuntime
Copy-Item -LiteralPath (Join-Path $Repo 'legal-pdf-parser\runtime\kraken\model.onnx'),
    (Join-Path $Repo 'legal-pdf-parser\runtime\kraken\codec.json') `
    -Destination (Join-Path $pdfRuntime 'kraken')

$download = Join-Path $Cache $NodeArchive
if (-not (Test-Path -LiteralPath $download -PathType Leaf)) {
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVersion/$NodeArchive" -OutFile $download
}
if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant() -ne $NodeSha256) {
    throw "Node archive hash mismatch: $download"
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($download)
try {
    foreach ($item in @(@("node-v$NodeVersion-win-x64/node.exe", 'runtime\node.exe'),
            @("node-v$NodeVersion-win-x64/LICENSE", 'licenses\Node.js.txt'))) {
        $entry = $archive.GetEntry($item[0]); if (-not $entry) { throw "Node archive misses $($item[0])" }
        $destination = Join-Path $Stage $item[1]
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $true)
    }
}
finally { $archive.Dispose() }

$licenses = Join-Path $Stage 'licenses'
Copy-Item -LiteralPath (Join-Path $Repo 'LICENSE') -Destination (Join-Path $licenses 'Beaver.txt')
Copy-Item -LiteralPath (Join-Path $Repo 'legal-structure\LICENSE') `
    -Destination (Join-Path $licenses 'legal-structure.txt')
Copy-Item -LiteralPath (Join-Path $Repo 'legal-pdf-parser\LICENSE') `
    -Destination (Join-Path $licenses 'legal-pdf-parser.txt')
Copy-Item -LiteralPath (Join-Path $Repo 'frontend\node_modules\pdfjs-dist\standard_fonts\LICENSE_FOXIT'),
    (Join-Path $Repo 'frontend\node_modules\pdfjs-dist\standard_fonts\LICENSE_LIBERATION') -Destination $licenses
Copy-Item -Path (Join-Path $Owner 'scripts\authorities-package\*.cmd'),
    (Join-Path $Owner 'scripts\authorities-package\*.ps1'),
    (Join-Path $Owner 'scripts\authorities-package\README.txt') -Destination $Stage

$manifest = [ordered]@{ format = 1; app = 'Authorities'; platform = 'win-x64'
    origin = 'http://127.0.0.1:32147'; node = $NodeVersion; buildId = ''; files = @() }
$manifest.files = @(Get-ChildItem -LiteralPath $Stage -File -Recurse | Sort-Object FullName |
    ForEach-Object { [ordered]@{ path = $_.FullName.Substring($Stage.Length + 1).Replace('\', '/')
        bytes = $_.Length; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() } })
$sha256 = [Security.Cryptography.SHA256]::Create()
try { $manifest.buildId = ([BitConverter]::ToString($sha256.ComputeHash(
            [Text.Encoding]::UTF8.GetBytes(($manifest.files | ConvertTo-Json -Depth 3 -Compress))))
        ).Replace('-', '').ToLowerInvariant() }
finally { $sha256.Dispose() }
$manifestPath = Join-Path $Stage 'manifest.json'
[IO.File]::WriteAllText($manifestPath, (($manifest | ConvertTo-Json -Depth 5) + "`n"),
    [Text.UTF8Encoding]::new($false))

Invoke-Checked (Join-Path $Stage 'runtime\node.exe') @((Join-Path $Owner 'scripts/authorities-package/smoke.mjs'), $Stage)
Compress-Archive -Path (Join-Path $Stage '*') -DestinationPath $Zip -CompressionLevel Optimal
$size = (Get-Item -LiteralPath $Zip).Length
$hash = (Get-FileHash -LiteralPath $Zip -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "Authorities package: $Zip ($size bytes, sha256 $hash)"
