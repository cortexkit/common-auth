$ErrorActionPreference = 'Stop'
$folder = $env:COMMON_AUTH_SETUP_CONFIG_DIR
$reference = Join-Path $folder "acl-reference-$PID.json"
$before = (Get-Acl -LiteralPath $folder).Sddl
[IO.File]::WriteAllText($reference, '{}')
try {
  # A separately created ordinary child records the folder's file-inheritance policy.
  $expected = Get-Acl -LiteralPath $reference
  if ($expected.AreAccessRulesProtected) { throw 'Ordinary ACL reference unexpectedly has a protected DACL' }
  $expectedAccess = $expected.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
  $checks = 0
  foreach ($name in @('opencode.jsonc', 'tui.jsonc')) {
    $file = Join-Path $folder $name
    $actual = Get-Acl -LiteralPath $file
    if ($actual.AreAccessRulesProtected) { throw "$name has a protected DACL" }
    if (@($actual.Access).Count -eq 0 -or @($actual.Access | Where-Object { -not $_.IsInherited }).Count -ne 0) { throw "$name does not inherit all file ACL entries" }
    $actualAccess = $actual.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
    if ($actualAccess -ne $expectedAccess) { throw "$name ACL differs from its folder's ordinary file inheritance" }
    $checks += 3
  }
  if ((Get-Acl -LiteralPath $folder).Sddl -ne $before) { throw 'Config writing modified the parent ACL' }
  $checks++
  Write-Host "$checks inherited config ACL checks passed"
} finally { Remove-Item -LiteralPath $reference -Force }
