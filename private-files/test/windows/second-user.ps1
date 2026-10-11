param([string]$Request)
$ErrorActionPreference = 'Stop'
$data = Get-Content -Raw -LiteralPath $Request | ConvertFrom-Json
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
$standard = !$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$control = [IO.File]::ReadAllText($data.control) -eq 'public-control'
function IsDenied([scriptblock]$Operation) {
  try { & $Operation | Out-Null; return $false }
  catch {
    $errorObject = $_.Exception
    while ($errorObject.InnerException) { $errorObject = $errorObject.InnerException }
    if ($errorObject -is [UnauthorizedAccessException]) { return $true }
    throw
  }
}
$fileDenied = IsDenied { [IO.File]::ReadAllText($data.file) }
$directoryDenied = IsDenied { [IO.Directory]::GetFileSystemEntries($data.directory) }
$profile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
& $data.runtime $data.writerScript $profile
if ($LASTEXITCODE) { throw 'Standard-user native writer/reader test failed' }
@{ standardUser = $standard; controlRead = $control; fileDenied = $fileDenied; directoryDenied = $directoryDenied; standardWriter = $true } | ConvertTo-Json | Set-Content -LiteralPath $data.result
