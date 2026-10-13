param([Parameter(Mandatory)][string]$ExpectedVersion)
$ErrorActionPreference = 'Stop'
if ((& bun --version).Trim() -ne $ExpectedVersion) { throw 'Wrong Bun version for mutation proofs' }
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
  try {
    $original = [IO.File]::ReadAllText((Join-Path $PWD $row.file))
    if (-not $original.Contains($row.old)) { throw "Mutation anchor not found: $($row.id)" }
    [IO.File]::WriteAllText((Join-Path $PWD $row.file), $original.Replace($row.old, $row.new))
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
    & git checkout -- $row.file
    if ($LASTEXITCODE) { throw 'Mutation restore failed' }
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

# A zero-work run must not qualify the Windows security suite merely by exiting 0.
$harness = 'test/windows/common-auth.mjs'
& git add -- $harness
if (((& git diff --stat) -join "`n").Trim()) { throw 'Count control requires an empty unstaged diff' }
try {
  $original = [IO.File]::ReadAllText((Join-Path $PWD $harness))
  $anchor = 'const registerTest = nativeTest'
  if (-not $original.Contains($anchor)) { throw 'Count-control import anchor missing' }
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
  & git checkout -- $harness
  if ($LASTEXITCODE) { throw 'Count-control restore failed' }
  (Get-Item -LiteralPath $harness).LastWriteTime = Get-Date
  if (((& git diff --stat) -join "`n").Trim()) { throw 'Count-control restore left a non-empty diff' }
}
