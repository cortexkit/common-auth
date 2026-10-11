$ErrorActionPreference = 'Stop'
$source = 'native/addon.c'
$original = [IO.File]::ReadAllText((Join-Path (Get-Location) $source))
if ((git diff -- $source) -or (git diff --cached -- $source)) { throw 'Negative control requires clean native source' }
# Stage the unchanged source so reverting the verifier mutation cannot discard existing implementation changes.
git add -- $source
if (git diff --stat) { throw 'Negative control requires an empty working diff' }
try {
  $mutant = $original.Replace('if (valid && canonical) {', 'if (0 && valid && canonical) { /* NON-VACUITY BREAK */')
  if ($mutant -eq $original) { throw 'Verifier mutation did not match' }
  [IO.File]::WriteAllText((Join-Path (Get-Location) $source), $mutant)
  $during = git diff --stat
  if (!$during) { throw 'No mutation diff recorded' }
  $during | Tee-Object -FilePath private-files-evidence/negative-during.txt
  & ./native/build.ps1
  $env:PRIVATE_FILES_NEGATIVE_CONTROL = '1'
  & node --test '--test-name-pattern=^foreign-grant fixture refuses before reading bytes$' test/windows/windows-acl.mjs 2>&1 | Tee-Object -FilePath private-files-evidence/negative-test.txt
  $code = $LASTEXITCODE
  if ($code -eq 0) { throw 'Disabled verifier was not detected by the foreign-grant test' }
  $output = [IO.File]::ReadAllText((Join-Path (Get-Location) 'private-files-evidence/negative-test.txt'))
  if ($output -notmatch 'not ok.*foreign-grant fixture refuses before reading bytes' -or $output -notmatch 'Missing expected rejection') { throw 'Negative control failed for an unrelated reason' }
} finally {
  git checkout -- $source
  (Get-Item $source).LastWriteTime = Get-Date
  Remove-Item Env:PRIVATE_FILES_NEGATIVE_CONTROL -ErrorAction SilentlyContinue
  $after = git diff --stat
  if ($after) { throw "Mutation restoration left changes: $after" }
  'empty git diff --stat after restore' | Set-Content private-files-evidence/negative-after.txt
  & ./native/build.ps1
}
