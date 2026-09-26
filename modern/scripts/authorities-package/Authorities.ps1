[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'stop', 'status')]
    [string]$Action = 'start',
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Port = 32147
$Url = "http://127.0.0.1:$Port/authorities.html"
$HealthUrl = "http://127.0.0.1:$Port/health"
$StateRoot = Join-Path $env:LOCALAPPDATA 'OpenLegalProducts\Authorities'
$StateFile = Join-Path $StateRoot 'lifecycle.json'
$BrowserProfile = Join-Path $StateRoot 'browser'
$ManifestFile = Join-Path $Root 'manifest.json'
$BuildId = try { [string](Get-Content -LiteralPath $ManifestFile -Raw | ConvertFrom-Json).buildId }
    catch { '' }

function Get-ProcessStamp([int]$Id) {
    try { (Get-Process -Id $Id -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o') }
    catch { $null }
}

function Read-State {
    if (Test-Path -LiteralPath $StateFile -PathType Leaf) {
        try { Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json } catch { $null }
    }
}

function Test-Owned($State) {
    $State -and (Get-ProcessStamp ([int]$State.pid)) -eq [string]$State.startedAt
}

function Test-Healthy {
    try {
        $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2
        $health.status -eq 'ok' -and $health.app -eq 'authorities' -and
            $health.buildId -eq $BuildId
    }
    catch { $false }
}

function Write-State($Process, [string]$Stdout, [string]$Stderr) {
    New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null
    $state = [ordered]@{ pid = $Process.Id; startedAt = Get-ProcessStamp $Process.Id
        stdout = $Stdout; stderr = $Stderr }
    $temporary = "$StateFile.new"
    $state | ConvertTo-Json | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $StateFile -Force
}

function Resolve-Chromium {
    $paths = @(
        (Get-Command msedge.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1),
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe'),
        (Get-Command chrome.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1),
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe')
    )
    $paths | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } |
        Select-Object -First 1
}

function Open-Authorities {
    if ($NoBrowser) { return }
    $browser = Resolve-Chromium
    if (-not $browser) { throw 'Authorities requires Microsoft Edge or Google Chrome.' }
    New-Item -ItemType Directory -Path $BrowserProfile -Force | Out-Null
    Start-Process -FilePath $browser -ArgumentList @(
        "--user-data-dir=`"$BrowserProfile`"", '--no-first-run', "--app=$Url")
}

function Stop-Authorities {
    $state = Read-State
    if (Test-Owned $state) {
        Stop-Process -Id ([int]$state.pid) -Force
        Write-Host "Stopped Authorities (PID $($state.pid))."
    }
    else { Write-Host 'This launcher has no running Authorities process.' }
    Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
}

function Start-Authorities {
    if ($BuildId -notmatch '^[a-f0-9]{64}$') { throw "Authorities is incomplete: $ManifestFile" }
    if (Test-Healthy) { Write-Host "Authorities is already running at $Url"; Open-Authorities; return }
    $state = Read-State
    if (Test-Owned $state) { Stop-Process -Id ([int]$state.pid) -Force }
    Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue

    $node = Join-Path $Root 'runtime\node.exe'
    $entry = Join-Path $Root 'backend\dist\authoritiesStandalone.js'
    $native = Join-Path $Root 'runtime\legal-structure\legal_structure_node.dll'
    $pdf = Join-Path $Root 'runtime\legal-pdf-parser'
    foreach ($file in @($node, $entry, $native, (Join-Path $Root 'frontend\dist\authorities.html'))) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Authorities is incomplete: $file" }
    }
    if (-not $NoBrowser -and -not (Resolve-Chromium)) {
        throw 'Authorities requires Microsoft Edge or Google Chrome.'
    }
    $logRoot = Join-Path $StateRoot 'logs'; New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
    $stdout = Join-Path $logRoot 'stdout.log'; $stderr = Join-Path $logRoot 'stderr.log'
    $values = [ordered]@{ PORT = "$Port"; NODE_ENV = 'production'
        AUTHORITIES_BUILD_ID = $BuildId
        LEGAL_STRUCTURE_NATIVE = $native; LEGALPDF_ENGINE_ROOT = $pdf
        MIKE_LOCAL_DATA_DIR = (Join-Path $StateRoot 'data') }
    $prior = @{}
    try {
        foreach ($name in $values.Keys) {
            $prior[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
            [Environment]::SetEnvironmentVariable($name, $values[$name], 'Process')
        }
        $process = Start-Process -FilePath $node `
            -ArgumentList @('backend\dist\authoritiesStandalone.js') -WorkingDirectory $Root `
            -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    }
    finally {
        foreach ($name in $values.Keys) {
            [Environment]::SetEnvironmentVariable($name, $prior[$name], 'Process')
        }
    }
    Write-State $process $stdout $stderr
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while ([DateTime]::UtcNow -lt $deadline -and -not (Test-Healthy)) {
        if ($process.HasExited) { break }
        Start-Sleep -Milliseconds 100
    }
    if (-not (Test-Healthy)) {
        if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
        Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
        throw "Authorities could not start. See $stderr"
    }
    Write-Host "Authorities ready at $Url"
    Open-Authorities
}

if ($MyInvocation.InvocationName -ne '.') {
    switch ($Action) {
        'start' { Start-Authorities }
        'stop' { Stop-Authorities }
        'status' {
            $state = Read-State
            Write-Host "Authorities: $(if (Test-Healthy) { 'running' } else { 'stopped' })"
            if (Test-Owned $state) { Write-Host "Launcher PID: $($state.pid)" }
        }
    }
}
