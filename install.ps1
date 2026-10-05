<#
.SYNOPSIS
  Install the omp-portable-kit templates into ~/.omp (Windows; PowerShell 5.1 or 7+).

.DESCRIPTION
  - Checks prerequisites and prints how to install anything missing. Installs nothing itself.
  - Copies kit/home/.omp/** into <TargetHome>/.omp/**, replacing {{HOME}} and {{OWNER}} in the
    text templates. Existing files are kept unless -Force is given; with -Force every replaced
    file is first backed up to <TargetHome>/.omp/_kit-backup/<timestamp>/.
  - Creates ~/.omp/wt/_logs, ~/.omp/wt/_compact and ~/.omp/secrets.
  - Downloads the impeccable engine binary (not kept in the repo) from its official GitHub
    release, pinned to skills/impeccable/scripts/VERSION and checked against the release's
    .sha256 sidecar.
  - Prints the post-install checklist.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Owner Sam
.EXAMPLE
  $env:OMP_KIT_HOME = "$env:TEMP\fake-home"; .\install.ps1 -Owner Sam    # dry rehearsal
#>
[CmdletBinding()]
param(
	[string]$Owner = "Owner",
	[string]$TargetHome = $(if ($env:OMP_KIT_HOME) { $env:OMP_KIT_HOME } else { $HOME }),
	[switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$KitRoot = $PSScriptRoot
$Source = Join-Path $KitRoot 'home\.omp'
if (-not (Test-Path -LiteralPath $Source -PathType Container)) { throw "kit layout broken: $Source not found" }
if ($Owner -notmatch '^[\p{L}\p{N} ._-]{1,40}$') { throw "-Owner must be 1-40 letters, digits, spaces, '.', '_' or '-'" }
$TargetHome = [System.IO.Path]::GetFullPath($TargetHome)
$Dest = Join-Path $TargetHome '.omp'
$HomeFwd = $TargetHome.TrimEnd('\', '/') -replace '\\', '/'
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false
$RenderExt = @('.md', '.yml', '.yaml', '.json')
# Third-party skills are copied byte-for-byte, never rendered.
$NoRender = @('agent\skills\impeccable\', 'agent\skills\skill-creator\')

# ------------------------------------------------------------------ prerequisites
function Test-Tool([string]$Name, [string]$Hint, [switch]$Optional) {
	$cmd = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
	if ($cmd) {
		$ver = ''
		try { $ver = (& $cmd.Source --version 2>$null | Select-Object -First 1) } catch { }
		Write-Host ("  ok       {0,-10} {1}" -f $Name, $ver)
		return $true
	}
	$tag = if ($Optional) { 'optional' } else { 'MISSING ' }
	Write-Host ("  {0} {1,-10} {2}" -f $tag, $Name, $Hint) -ForegroundColor $(if ($Optional) { 'DarkYellow' } else { 'Red' })
	return [bool]$Optional
}

Write-Host "omp-portable-kit installer"
Write-Host "  kit:    $KitRoot"
Write-Host "  target: $Dest"
Write-Host "  owner:  $Owner"
Write-Host ""
Write-Host "Prerequisites (nothing is installed for you):"
$ok = $true
$ok = (Test-Tool 'node' 'Node.js 20+: winget install OpenJS.NodeJS.LTS  (or https://nodejs.org)') -and $ok
$ok = (Test-Tool 'git' 'Git for Windows (includes Git Bash): winget install Git.Git') -and $ok
$ok = (Test-Tool 'gh' 'GitHub CLI: winget install GitHub.cli, then gh auth login') -and $ok
$ok = (Test-Tool 'omp' 'oh-my-pi: see https://github.com/can1357/oh-my-pi (install, then open a new terminal)') -and $ok
[void](Test-Tool 'playwright' 'browser smoke tests: npm i -g playwright; npx playwright install chromium' -Optional)
[void](Test-Tool 'ffmpeg' 'video/frame tools: winget install Gyan.FFmpeg' -Optional)
[void](Test-Tool 'blender' '3D asset work: winget install BlenderFoundation.Blender' -Optional)
if (-not $ok) { Write-Host "`nSome required tools are missing; templates are installed anyway. Install them before the first session." -ForegroundColor Yellow }
Write-Host ""

# ------------------------------------------------------------------ copy templates
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupRoot = Join-Path $Dest "_kit-backup\$stamp"
$counts = [ordered]@{ created = 0; unchanged = 0; kept = 0; replaced = 0 }
$kept = New-Object System.Collections.Generic.List[string]

# The leading comma keeps PowerShell from unrolling the byte[] into the pipeline.
function Get-RenderedBytes([System.IO.FileInfo]$File, [string]$Rel) {
	$render = ($RenderExt -contains $File.Extension.ToLowerInvariant())
	foreach ($p in $NoRender) { if ($Rel.StartsWith($p, [System.StringComparison]::OrdinalIgnoreCase)) { $render = $false } }
	if (-not $render) { return , [System.IO.File]::ReadAllBytes($File.FullName) }
	$text = [System.IO.File]::ReadAllText($File.FullName, $Utf8NoBom)
	$text = $text.Replace('{{HOME}}', $HomeFwd).Replace('{{OWNER}}', $Owner)
	return , $Utf8NoBom.GetBytes($text)
}

$Sha = [System.Security.Cryptography.SHA256]::Create()
function Test-SameBytes([byte[]]$A, [byte[]]$B) {
	if ($A.Length -ne $B.Length) { return $false }
	return [System.BitConverter]::ToString($Sha.ComputeHash($A)) -eq [System.BitConverter]::ToString($Sha.ComputeHash($B))
}

Write-Host "Templates:"
$sourceFull = (Resolve-Path -LiteralPath $Source).Path.TrimEnd('\') + '\'
Get-ChildItem -LiteralPath $Source -Recurse -File -Force | Sort-Object FullName | ForEach-Object {
	$rel = $_.FullName.Substring($sourceFull.Length)
	$target = Join-Path $Dest $rel
	$bytes = Get-RenderedBytes $_ $rel
	if (Test-Path -LiteralPath $target -PathType Leaf) {
		$current = [System.IO.File]::ReadAllBytes($target)
		if (Test-SameBytes $current $bytes) { $counts.unchanged++; return }
		if (-not $Force) { $counts.kept++; $kept.Add($rel); return }
		$bak = Join-Path $BackupRoot $rel
		New-Item -ItemType Directory -Force -Path (Split-Path -Parent $bak) | Out-Null
		Copy-Item -LiteralPath $target -Destination $bak -Force
		[System.IO.File]::WriteAllBytes($target, $bytes)
		$counts.replaced++
		Write-Host "  replaced $rel (backup in _kit-backup\$stamp)"
		return
	}
	New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
	[System.IO.File]::WriteAllBytes($target, $bytes)
	$counts.created++
}
foreach ($d in @('wt\_logs', 'wt\_compact', 'secrets')) {
	New-Item -ItemType Directory -Force -Path (Join-Path $Dest $d) | Out-Null
}
Write-Host ("  {0} created, {1} unchanged, {2} kept (differ; use -Force to replace), {3} replaced" -f $counts.created, $counts.unchanged, $counts.kept, $counts.replaced)
foreach ($k in $kept) { Write-Host "    kept existing: $k" -ForegroundColor DarkYellow }
Write-Host "  dirs: .omp\wt\_logs, .omp\wt\_compact, .omp\secrets"
Write-Host ""

# ------------------------------------------------------------------ impeccable engine
# The skill's launcher (scripts\impeccable.cmd) runs bin\windows-<arch>\impeccable.exe when present
# and otherwise downloads into %USERPROFILE%\.impeccable on first use. Fetch it now so the skill
# works offline later. There is no windows-arm64 asset; Windows on ARM runs the x64 binary.
$ImpScripts = Join-Path $Dest 'agent\skills\impeccable\scripts'
$ImpVersion = (Get-Content -LiteralPath (Join-Path $ImpScripts 'VERSION') -TotalCount 1).Trim()
$ImpAsset = 'impeccable-windows-x64.exe'
$ImpUrl = "https://github.com/pbakaus/impeccable/releases/download/engine-v$ImpVersion/$ImpAsset"
$ImpBin = Join-Path $ImpScripts 'bin\windows-x64\impeccable.exe'
Write-Host "impeccable engine:"
if (Test-Path -LiteralPath $ImpBin -PathType Leaf) {
	Write-Host "  present  $ImpBin"
} else {
	$part = "$ImpBin.part"
	try {
		New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ImpBin) | Out-Null
		[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
		$ProgressPreference = 'SilentlyContinue'   # PowerShell 5.1's progress bar slows downloads ~10x
		Invoke-WebRequest -UseBasicParsing -Uri $ImpUrl -OutFile $part
		# The sidecar is served as application/octet-stream, which PowerShell 5.1 returns as bytes.
		$sidecar = (Invoke-WebRequest -UseBasicParsing -Uri "$ImpUrl.sha256").Content
		if ($sidecar -is [byte[]]) { $sidecar = [Text.Encoding]::ASCII.GetString($sidecar) }
		$expected = ($sidecar.Trim() -split '\s+')[0]
		$actual = (Get-FileHash -LiteralPath $part -Algorithm SHA256).Hash
		if (-not $expected -or $actual -ne $expected) { throw "checksum mismatch (expected $expected, got $actual)" }
		Move-Item -LiteralPath $part -Destination $ImpBin -Force
		Write-Host "  fetched  engine v$ImpVersion (sha256 verified) -> $ImpBin"
	} catch {
		Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
		Write-Host "  not fetched: $($_.Exception.Message)" -ForegroundColor DarkYellow
		Write-Host "  The skill downloads it on first use instead. To install it by hand, save" -ForegroundColor DarkYellow
		Write-Host "  $ImpUrl" -ForegroundColor DarkYellow
		Write-Host "  as $ImpBin  (release page: https://github.com/pbakaus/impeccable/releases/tag/engine-v$ImpVersion)" -ForegroundColor DarkYellow
	}
}
Write-Host ""

# ------------------------------------------------------------------ checklist
Write-Host @"
Next steps (full detail in README.md):
  1. omp login <provider> for each subscription you have (anthropic, openai-codex, cursor, ...); omp usage
  2. Edit $Dest\agent\config.yml: modelRoles + retry.fallbackChains for the providers you have
  3. Edit $Dest\agent\agents\*-worker.md: model: lines (omp models <provider>)
  4. Edit $Dest\farm.config.json: "repo" = your project's main checkout (+ refs, setupCommands)
  5. Edit $Dest\agent\APPEND_SYSTEM.md: the <FILL: ...> lines (routing, datastores, build limit)
  6. MCP: set "enabled": true in $Dest\agent\mcp.json for the servers you use, then /mcp in omp
     gmail: cd $Dest\agent\mcp-servers\gmail; npm ci; put GMAIL_* keys in $Dest\secrets\gmail.env
  7. Clone the project, install deps, write its CLAUDE.md from repo-template\CLAUDE.md
  8. node $Dest\farm-add-worker.mjs <Name> claude   (one per worker), then start omp in the repo
"@
