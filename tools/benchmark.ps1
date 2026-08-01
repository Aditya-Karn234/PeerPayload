<#
.SYNOPSIS
  Benchmarks sender/receiver throughput across file sizes and simulated
  network latency, and writes results to a CSV.

.DESCRIPTION
  Localhost RTT is near-zero, which hides the stop-and-wait bottleneck the
  pipelining rework targets. For LatenciesMs > 0, sender connects through
  tools/latency-proxy.js instead of directly to the receiver — the proxy
  delays only the ack direction by the requested amount, standing in for
  real network RTT without requiring a WAN emulator or admin rights.

  This is deliberately NOT the same mechanism as
  shared/include/bench_latency.hpp's DTS_BENCH_LATENCY_MS (a Sleep() inside
  the receiver's single thread before each ack). That approach is fine for
  a stop-and-wait sender — there's only ever one chunk outstanding, so
  serializing its ack doesn't distort anything — but for a pipelined sender
  it artificially serializes ack delivery regardless of window size, which
  understates the improvement pipelining actually gives you. The proxy
  models concurrent in-flight acks correctly, which matters once more than
  one chunk can be outstanding at a time.

  Re-run this same script before and after an engine change to get a real
  A/B comparison — the CSV includes a "label" column for exactly that.

.EXAMPLE
  ./tools/benchmark.ps1 -Label "pipelined-w16" -SizesMB 5,50,200 -LatenciesMs 0,20,50 -Window 16
#>

param(
    [string]$Label = "run",
    [int[]]$SizesMB = @(5, 50, 200),
    [int[]]$LatenciesMs = @(0, 20, 50),
    [int]$Window = 16,
    [int[]]$ChunkSizes = @(65536),
    [switch]$NoTls,
    [string]$SenderExe = "$PSScriptRoot\..\build\sender\sender.exe",
    [string]$ReceiverExe = "$PSScriptRoot\..\build\receiver\receiver.exe",
    [string]$ProxyScript = "$PSScriptRoot\latency-proxy.js",
    [string]$WorkDir = "$env:TEMP\dts_bench",
    [string]$ResultsCsv = "$PSScriptRoot\benchmark-results.csv",
    [int]$BasePort = 24000
)

$ErrorActionPreference = "Stop"
$mingwBin = "C:\msys64\mingw64\bin"
if (Test-Path $mingwBin) { $env:PATH = "$mingwBin;$env:PATH" }

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$srcDir = Join-Path $WorkDir "src"
New-Item -ItemType Directory -Force -Path $srcDir | Out-Null

function Get-OrCreateTestFile($sizeMB) {
    $path = Join-Path $srcDir "blob_${sizeMB}MB.bin"
    if (-not (Test-Path $path) -or (Get-Item $path).Length -ne ($sizeMB * 1MB)) {
        $bytes = New-Object byte[] ($sizeMB * 1MB)
        (New-Object Random(42)).NextBytes($bytes)
        [IO.File]::WriteAllBytes($path, $bytes)
    }
    return $path
}

function Invoke-OneTransfer($sizeMB, $latencyMs, $chunkSize, $port) {
    $outDir = Join-Path $WorkDir "out_${port}"
    if (Test-Path $outDir) { Remove-Item -Recurse -Force $outDir }
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null

    $srcFile = Get-OrCreateTestFile $sizeMB
    $recvLog = Join-Path $WorkDir "recv_${port}.jsonl"
    $sendLog = Join-Path $WorkDir "send_${port}.jsonl"

    $recvArgs = @("-p", $port, "-o", $outDir, "--transfer-id", "bench-$port")
    if ($NoTls) { $recvArgs += "--no-tls" }

    $recvProc = Start-Process -FilePath $ReceiverExe `
        -ArgumentList $recvArgs `
        -PassThru -WindowStyle Hidden -RedirectStandardOutput $recvLog

    # Poll for the receiver's "listening" event instead of a fixed sleep.
    $ready = $false
    for ($i = 0; $i -lt 100; $i++) {
        Start-Sleep -Milliseconds 100
        if ((Test-Path $recvLog) -and (Get-Content $recvLog -Raw) -match '"event":"listening"') {
            $ready = $true
            break
        }
        if ($recvProc.HasExited) { break }
    }
    if (-not $ready) {
        throw "Receiver never reported listening on port $port (size=${sizeMB}MB latency=${latencyMs}ms)"
    }

    $senderTargetPort = $port
    $proxyProc = $null

    if ($latencyMs -gt 0) {
        $proxyPort = $port + 5000
        $proxyLog = Join-Path $WorkDir "proxy_${port}.log"

        $proxyProc = Start-Process -FilePath "node" `
            -ArgumentList $ProxyScript, $proxyPort, "127.0.0.1", $port, $latencyMs `
            -PassThru -WindowStyle Hidden -RedirectStandardOutput $proxyLog

        $proxyReady = $false
        for ($i = 0; $i -lt 50; $i++) {
            Start-Sleep -Milliseconds 100
            if ((Test-Path $proxyLog) -and (Get-Content $proxyLog -Raw) -match "ready:") {
                $proxyReady = $true
                break
            }
            if ($proxyProc.HasExited) { break }
        }
        if (-not $proxyReady) {
            throw "Latency proxy never reported ready on port $proxyPort"
        }

        $senderTargetPort = $proxyPort
    }

    $sendArgs = @("-p", $senderTargetPort, "--transfer-id", "bench-$port", "--window", $Window, "--chunk-size", $chunkSize)
    if ($NoTls) { $sendArgs += "--no-tls" }
    $sendArgs += $srcFile

    try {
        $sendProc = Start-Process -FilePath $SenderExe `
            -ArgumentList $sendArgs `
            -PassThru -WindowStyle Hidden -RedirectStandardOutput $sendLog -Wait
    }
    finally {
        if ($proxyProc -and -not $proxyProc.HasExited) {
            Stop-Process -Id $proxyProc.Id -Force -ErrorAction SilentlyContinue
        }
    }

    $sendText = Get-Content $sendLog -Raw
    $completeLine = ($sendText -split "`n") | Where-Object { $_ -match '"event":"transfer_complete"' } | Select-Object -Last 1

    if (-not $completeLine) {
        $failLine = ($sendText -split "`n") | Where-Object { $_ -match '"event":"transfer_failed"' } | Select-Object -Last 1
        throw "Transfer did not complete (size=${sizeMB}MB latency=${latencyMs}ms): $failLine"
    }

    $event = $completeLine | ConvertFrom-Json
    return [PSCustomObject]@{
        totalBytes = [int64]$event.totalBytes
        elapsedMs  = [int64]$event.elapsedMs
    }
}

$results = @()

foreach ($chunkSize in $ChunkSizes) {
    foreach ($latencyMs in $LatenciesMs) {
        foreach ($sizeMB in $SizesMB) {
            $port = $BasePort + $results.Count
            Write-Host "Running: size=${sizeMB}MB latency=${latencyMs}ms window=$Window chunkSize=$chunkSize port=$port..."

            $r = Invoke-OneTransfer -sizeMB $sizeMB -latencyMs $latencyMs -chunkSize $chunkSize -port $port

            $throughputMBps = [math]::Round(($r.totalBytes / 1MB) / ($r.elapsedMs / 1000), 3)

            $row = [PSCustomObject]@{
                label         = $Label
                sizeMB        = $sizeMB
                latencyMs     = $latencyMs
                window        = $Window
                chunkSize     = $chunkSize
                totalBytes    = $r.totalBytes
                elapsedMs     = $r.elapsedMs
                throughputMBs = $throughputMBps
            }
            $results += $row
            Write-Host ("  -> {0} MB/s ({1} ms)" -f $throughputMBps, $r.elapsedMs)
        }
    }
}

$writeHeader = -not (Test-Path $ResultsCsv)
$results | Export-Csv -Path $ResultsCsv -NoTypeInformation -Append:(!$writeHeader)

Write-Host "`nResults appended to $ResultsCsv"
$results | Format-Table -AutoSize
