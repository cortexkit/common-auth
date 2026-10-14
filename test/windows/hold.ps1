$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$handle = [IO.File]::Open($request.path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
try {
  [Console]::Out.WriteLine('ready')
  [Console]::Out.Flush()
  # Keep delete sharing denied until the test signals that the writer has finished.
  while (-not [IO.File]::Exists($request.releaseFile)) { [Threading.Thread]::Sleep(10) }
} finally { $handle.Dispose() }
