param([Parameter(Mandatory)][string]$ExpectedVersion)
$ErrorActionPreference = 'Stop'
if ((& bun --version).Trim() -ne $ExpectedVersion) { throw 'Wrong Bun version for mutation proofs' }
& bun ./scripts/check-windows-mutation-anchors.mjs
if ($LASTEXITCODE) { throw 'Windows mutation anchor validation failed' }
$rows = Get-Content -Raw -LiteralPath test/windows/mutation-rows.json | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path windows-private-files-evidence | Out-Null
$results = @()
function Run-Selected($row, $phase) {
  $file = if ($row.testFile) { $row.testFile } else { 'test/fs/windows-private-files.test.ts' }
  $log = Join-Path windows-private-files-evidence ("mutation-$ExpectedVersion-$($row.id)-$phase.log")
  [IO.File]::WriteAllText((Join-Path $PWD $log), '')
  $output = [Collections.Generic.List[string]]::new()
  & bun test $file -t $row.test --timeout 90000 2>&1 | ForEach-Object {
    $line = $_.ToString()
    $output.Add($line)
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
    [IO.File]::AppendAllText((Join-Path $PWD $log), $line + [Environment]::NewLine)
  }
  $exit = $LASTEXITCODE
  $text = $output -join "`n"
  if ($text -notmatch 'Ran 1 test') { throw 'Mutation must execute exactly one named test' }
  if ($phase -eq 'baseline') {
    if ($exit -ne 0 -or $text -notmatch '(?m)^\s*1 pass\s*$' -or $text -notmatch '(?m)^\s*0 fail\s*$') { throw "Baseline failed: $($row.id)" }
  } elseif ($exit -eq 0 -or $text -notmatch '(?m)^\s*1 fail\s*$' -or $text -notmatch ('\(fail\).*' + [Regex]::Escape($row.test))) {
    throw "Mutation was not CAUGHT by its sole named test: $($row.id)"
  }
}
foreach ($row in $rows) {
  Run-Selected $row 'baseline'
  & git add -- $row.file
  if ($LASTEXITCODE) { throw 'Could not stage live mutation source' }
  $before = (& git diff --stat) -join "`n"
  if ($before.Trim()) { throw 'Mutation requires an empty unstaged diff' }
  $target = Join-Path $PWD $row.file
  $originalBytes = [IO.File]::ReadAllBytes($target)
  try {
    & bun ./test/windows/mutation-source.mjs ./test/windows/mutation-rows.json $row.id
    if ($LASTEXITCODE) { throw "Mutation application failed: $($row.id)" }
    $applied = (& git diff --stat) -join "`n"
    if (-not $applied.Trim()) { throw 'Mutation did not change a tracked source file' }
    Write-Host $applied
    if ($row.build) {
      & bun run build
      if ($LASTEXITCODE) { throw 'Mutated build failed before the named test' }
    }
    Run-Selected $row 'red'
    $results += @{ id = $row.id; runtime = $ExpectedVersion; outcome = 'CAUGHT'; expected_red = $row.test; applied = $applied; restored = '' }
  } finally {
    # Restore the captured bytes, including BOM/line endings, not a Git-normalized text copy.
    [IO.File]::WriteAllBytes($target, $originalBytes)
    if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($target)) -cne [Convert]::ToBase64String($originalBytes)) { throw 'Mutation byte restore failed' }
    (Get-Item -LiteralPath $row.file).LastWriteTime = Get-Date
    $restored = (& git diff --stat) -join "`n"
    if ($restored.Trim()) { throw 'Mutation restore left a non-empty diff' }
    if ($row.build) {
      & bun run build
      if ($LASTEXITCODE) { throw 'Restored build failed' }
    }
  }
}
$results | ConvertTo-Json -Depth 5 | Out-File -LiteralPath (Join-Path windows-private-files-evidence ("mutations-$ExpectedVersion.json"))
Write-Host "$($results.Count) CAUGHT controls on Bun $ExpectedVersion; no collateral failures in the selected tests"

# Skipping every real assertion must fail the wrapper's test-count guard,
# even when the test runner exits successfully with all seven tests skipped.
$harness = 'test/windows/common-auth.mjs'
& git add -- $harness
if (((& git diff --stat) -join "`n").Trim()) { throw 'Count control requires an empty unstaged diff' }
$originalBytes = [IO.File]::ReadAllBytes((Join-Path $PWD $harness))
try {
  $original = [IO.File]::ReadAllText((Join-Path $PWD $harness))
  $anchor = 'const registerTest = nativeTest'
  if ([Regex]::Matches($original, [Regex]::Escape($anchor)).Count -ne 1) { throw 'Count-control import anchor must match exactly once' }
  $mutant = 'const registerTest = nativeTest.skip /* NON-VACUITY BREAK */'
  [IO.File]::WriteAllText((Join-Path $PWD $harness), $original.Replace($anchor, $mutant))
  $applied = (& git diff --stat) -join "`n"
  if (-not $applied.Trim()) { throw 'Count control did not change a tracked file' }
  $caught = $false
  try { & ./test/windows/run.ps1 -Runtime bun -ExpectedVersion $ExpectedVersion -EvidenceLabel 'all-skipped-control' }
  catch {
    if ($_.Exception.Message -notmatch 'Windows verification count guard:') { throw }
    Write-Host '(fail) Windows verification count guard'
    $caught = $true
  }
  if (-not $caught) { throw 'Skipping all real Windows checks was incorrectly accepted' }
  @{ id = 'private-windows-count'; runtime = $ExpectedVersion; outcome = 'CAUGHT'; expected_red = 'Windows verification count guard'; applied = $applied; restored = '' } | ConvertTo-Json | Out-File -LiteralPath (Join-Path windows-private-files-evidence ("count-control-$ExpectedVersion.json"))
} finally {
  [IO.File]::WriteAllBytes((Join-Path $PWD $harness), $originalBytes)
  if ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $PWD $harness))) -cne [Convert]::ToBase64String($originalBytes)) { throw 'Count-control byte restore failed' }
  (Get-Item -LiteralPath $harness).LastWriteTime = Get-Date
  if (((& git diff --stat) -join "`n").Trim()) { throw 'Count-control restore left a non-empty diff' }
}
