param([string]$Name, [string]$ExpectedSid)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
if (-not $Name) { Write-Output 'No probe account was provisioned'; exit }
if ($Name -notmatch '^ca[0-9a-f]{12}$') { throw 'Refusing cleanup of an unexpected account name' }
$user = Get-LocalUser -Name $Name -ErrorAction SilentlyContinue
if (-not $user) { Write-Output 'Probe account already absent'; exit }
if ($ExpectedSid -and $user.SID.Value -ne $ExpectedSid) { throw 'Probe cleanup SID mismatch' }
Remove-LocalUser -Name $Name
if (Get-LocalUser -Name $Name -ErrorAction SilentlyContinue) { throw 'Probe account removal was not confirmed' }
Write-Output 'Probe account removed'
