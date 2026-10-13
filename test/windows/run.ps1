param([ValidateSet('node','bun')][string]$Runtime, [string]$ExpectedVersion)
$ErrorActionPreference = 'Stop'
$version = (& $Runtime --version).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Runtime version command failed' }
if ($ExpectedVersion -and $version -ne $ExpectedVersion) { throw "Wrong runtime: expected $ExpectedVersion, got $version" }
Write-Host "$Runtime $version"
New-Item -ItemType Directory -Force -Path windows-private-files-evidence | Out-Null
$log = Join-Path windows-private-files-evidence ("suite-$Runtime-$version.log")
if ($Runtime -eq 'node') { $output = & node --test test/windows/common-auth.mjs 2>&1; $exit = $LASTEXITCODE }
else { $output = & bun test ./test/windows/common-auth.mjs --timeout 120000 2>&1; $exit = $LASTEXITCODE }
$output | Out-File -LiteralPath $log
$output | ForEach-Object { Write-Host $_ }
$text = $output -join "`n"
if ($exit -ne 0) { throw "Windows writers failed ($exit)" }
if ($Runtime -eq 'node') {
  if ($text -notmatch '(?m)^# tests 7\s*$' -or $text -notmatch '(?m)^# pass 7\s*$' -or $text -notmatch '(?m)^# fail 0\s*$' -or $text -notmatch '(?m)^# skipped 0\s*$') { throw 'Windows verification count guard: expected exactly seven executed Windows tests without skips' }
} elseif ($text -notmatch '(?m)^\s*7 pass\s*$' -or $text -notmatch '(?m)^\s*0 fail\s*$' -or $text -notmatch 'Ran 7 tests' -or $text -match '[1-9][0-9]* skip') {
  throw 'Windows verification count guard: expected exactly seven executed Windows tests without skips'
}
