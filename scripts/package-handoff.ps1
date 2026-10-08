param([string]$OutputName = 'sandbee-admin-source-2026-09-27.zip')
$ErrorActionPreference = 'Stop'
if ([IO.Path]::GetFileName($OutputName) -ne $OutputName -or -not $OutputName.EndsWith('.zip')) { throw 'OutputName must be a ZIP filename.' }
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$handoffRoot = Join-Path $projectRoot 'handoff'
New-Item -ItemType Directory -Path $handoffRoot -Force | Out-Null
$outputPath = Join-Path $handoffRoot $OutputName
if (Test-Path -LiteralPath $outputPath) { throw 'Handoff already exists. Choose a new filename.' }
$directories = @('backend','frontend','shared','scripts','test','docs')
$rootFiles = @('package.json','package-lock.json','README.md','Dockerfile','compose.yaml','compose.production.yaml','.env.example','.gitignore','.dockerignore','vite.config.mjs','playwright.config.mjs')
$files = @()
foreach ($directory in $directories) { $files += Get-ChildItem -LiteralPath (Join-Path $projectRoot $directory) -File -Recurse }
foreach ($name in $rootFiles) { $files += Get-Item -LiteralPath (Join-Path $projectRoot $name) }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$manifest = @()
$stream = [IO.File]::Open($outputPath, [IO.FileMode]::CreateNew)
$archive = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($projectRoot.Length + 1).Replace('\','/')
    if ($relative -match '(^|/)(\.env(?!\.example$)|\.local|node_modules|backups|test-results)(/|$)') { throw 'Private path reached the archive allowlist.' }
    $entryName = 'sandbee-admin/' + $relative
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $entryName, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
    $manifest += [PSCustomObject]@{ path = $entryName; bytes = $file.Length; sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
  }
  $entry = $archive.CreateEntry('sandbee-admin/HANDOFF-MANIFEST.json')
  $writer = New-Object IO.StreamWriter($entry.Open())
  try { $writer.Write(($manifest | ConvertTo-Json -Depth 3)) } finally { $writer.Dispose() }
} finally { $archive.Dispose(); $stream.Dispose() }
$verify = [IO.Compression.ZipFile]::OpenRead($outputPath)
try {
  foreach ($item in $manifest) {
    $entry = $verify.GetEntry($item.path)
    if (-not $entry -or $entry.Length -ne $item.bytes) { throw 'Archive size verification failed.' }
    $entryStream = $entry.Open(); $sha = [Security.Cryptography.SHA256]::Create()
    try { $actual = ([BitConverter]::ToString($sha.ComputeHash($entryStream))).Replace('-','').ToLowerInvariant() } finally { $entryStream.Dispose(); $sha.Dispose() }
    if ($actual -ne $item.sha256) { throw 'Archive checksum verification failed.' }
  }
} finally { $verify.Dispose() }
$digest = (Get-FileHash -LiteralPath $outputPath -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText($outputPath + '.sha256', $digest + '  ' + $OutputName + [Environment]::NewLine)
Write-Output ('Verified ' + $manifest.Count + ' source files: ' + $outputPath)
