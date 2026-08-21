<#
    NIGEHBAN -- DEV TUNNEL

    Brings up the local server and a public HTTPS tunnel to it, then prints the
    one address that goes into the phones.

        powershell -ExecutionPolicy Bypass -File scripts\dev-tunnel.ps1

    Why a tunnel rather than "just use the same Wi-Fi":

      - Phones on mobile data can reach it. Testers do not have to be in the
        room, on your network, or awake at the same time as you.
      - It is HTTPS, so the app talks to it the way it will talk to the cloud.
        The wss:// path, the certificate handling and the "no cleartext"
        Android rule are all exercised now, not discovered on deployment day.
      - University and cafe Wi-Fi almost always has client isolation on, which
        silently breaks phone-to-laptop on the same SSID. This does not care.

    The free-tier URL changes on every restart. That is survivable because the
    app stores the address rather than baking it in -- paste the new one on the
    Auth screen and carry on.
#>

$ErrorActionPreference = 'Stop'

$Port     = 8000
$Root     = Split-Path -Parent $PSScriptRoot
$ServerPy = Join-Path $Root 'server\nigehban_server.py'

function Write-Step($msg) { Write-Host "  $msg" -ForegroundColor DarkGray }
function Write-Bad($msg)  { Write-Host "  $msg" -ForegroundColor Red }

Write-Host ''
Write-Host '  NIGEHBAN DEV TUNNEL' -ForegroundColor Green
Write-Host '  -------------------' -ForegroundColor DarkGray

# ---- prerequisites -------------------------------------------------------
if (-not (Test-Path $ServerPy)) {
    Write-Bad "Cannot find $ServerPy"
    exit 1
}

$py = (Get-Command python -ErrorAction SilentlyContinue)
if (-not $py) { $py = (Get-Command py -ErrorAction SilentlyContinue) }
if (-not $py) {
    Write-Bad 'python is not on PATH. Install Python 3.10+ and try again.'
    exit 1
}

& $py.Source -c "import fastapi, uvicorn" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Bad 'FastAPI is not installed. Run this first:'
    Write-Host "      $($py.Source) -m pip install -r requirements.txt" -ForegroundColor Yellow
    exit 1
}

$ngrok = (Get-Command ngrok -ErrorAction SilentlyContinue)
if (-not $ngrok) {
    Write-Bad 'ngrok is not on PATH.'
    Write-Host '      winget install ngrok.ngrok    (then: ngrok config add-authtoken <token>)' -ForegroundColor Yellow
    exit 1
}

# ---- the server ----------------------------------------------------------
$serverUp = $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)

if ($serverUp) {
    Write-Step "server already listening on $Port -- leaving it alone"
} else {
    Write-Step "starting the server on $Port"
    Start-Process -FilePath $py.Source -ArgumentList $ServerPy -WorkingDirectory $Root
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
        if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { break }
        Start-Sleep -Milliseconds 400
    }
    if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
        Write-Bad 'the server did not come up -- check the window it opened'
        exit 1
    }
}

# ---- the tunnel ----------------------------------------------------------
# ngrok publishes its own state on 4040. Asking it for the URL beats scraping
# the console, and it is how the server banner finds the URL too.
function Get-TunnelUrl {
    try {
        $r = Invoke-RestMethod -Uri 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 2
        return ($r.tunnels | Where-Object { $_.proto -eq 'https' } | Select-Object -First 1).public_url
    } catch {
        return $null
    }
}

$url = Get-TunnelUrl
if ($url) {
    Write-Step 'a tunnel is already open -- reusing it'
} else {
    Write-Step 'opening the tunnel'
    Start-Process -FilePath $ngrok.Source -ArgumentList 'http', "$Port", '--log=stdout'
    $deadline = (Get-Date).AddSeconds(25)
    while ((Get-Date) -lt $deadline -and -not $url) {
        Start-Sleep -Milliseconds 600
        $url = Get-TunnelUrl
    }
}

if (-not $url) {
    Write-Bad 'ngrok did not report a tunnel.'
    Write-Host '      Most often this is a missing authtoken:' -ForegroundColor Yellow
    Write-Host '      ngrok config add-authtoken <token from dashboard.ngrok.com>' -ForegroundColor Yellow
    exit 1
}

# ---- prove it end to end before claiming success -------------------------
# A tunnel that is up but not forwarding looks identical from here until you
# actually ask it something. One request now saves a confused tester later.
$healthy = $false
try {
    $h = Invoke-RestMethod -Uri "$url/health" -TimeoutSec 8 `
                           -Headers @{ 'ngrok-skip-browser-warning' = 'true' }
    $healthy = [bool]$h.ok
} catch { }

Write-Host ''
Write-Host '  ==================================================================' -ForegroundColor Green
Write-Host '   PUT THIS IN THE PHONES' -ForegroundColor Green
Write-Host ''
Write-Host "     $url" -ForegroundColor White
Write-Host ''
if ($healthy) {
    Write-Host '   verified: the server answered through the tunnel' -ForegroundColor Green
} else {
    Write-Host '   WARNING: the tunnel is open but /health did not answer' -ForegroundColor Yellow
}
Write-Host '  ==================================================================' -ForegroundColor Green
Write-Host ''
Write-Step 'ngrok inspector (every request, replayable): http://127.0.0.1:4040'
Write-Step 'this URL changes when ngrok restarts -- re-run this script and re-paste'
Write-Host ''

try { Set-Clipboard -Value $url; Write-Step 'copied to your clipboard' } catch { }
