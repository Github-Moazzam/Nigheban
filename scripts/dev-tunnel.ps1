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

    Free-tier URLs rotate on every restart, which means re-pasting the address
    into every phone each morning. Reserve a domain at dashboard.ngrok.com (the
    free plan includes one) and pass it as -Domain, or set it once and forget:

        setx NIGEHBAN_NGROK_DOMAIN overcoat-quizzical-chatty.ngrok-free.dev

    Either way the app stores the address rather than baking it in, so a rotated
    URL is recoverable -- paste the new one on the Auth screen and carry on.
#>

param(
    # A reserved ngrok domain, so the address in the phones never changes.
    # Usually left unset here and put in .env at the repo root instead:
    #
    #     NIGEHBAN_NGROK_DOMAIN=overcoat-quizzical-chatty.ngrok-free.dev
    #
    # With no domain at all the tunnel gets a random address, and every phone
    # has to be re-pasted after each restart.
    [string] $Domain
)

$ErrorActionPreference = 'Stop'

$Port     = 8000
$Root     = Split-Path -Parent $PSScriptRoot
$ServerPy = Join-Path $Root 'server\nigehban_server.py'

function Write-Step($msg) { Write-Host "  $msg" -ForegroundColor DarkGray }
function Write-Bad($msg)  { Write-Host "  $msg" -ForegroundColor Red }

Write-Host ''
Write-Host '  NIGEHBAN DEV TUNNEL' -ForegroundColor Green
Write-Host '  -------------------' -ForegroundColor DarkGray

# ---- .env ----------------------------------------------------------------
# A plain KEY=VALUE file at the repo root, already gitignored, so a reserved
# domain lives with the project instead of in your Windows user environment --
# and every teammate keeps their own without touching the repo.
#
# Deliberately not `Invoke-Expression`: a .env is data, and running it as
# PowerShell would make an innocuous-looking config file arbitrary code.
#
# Precedence, most specific first:  -Domain  >  the shell  >  .env
$EnvFile = Join-Path $Root '.env'
if (Test-Path $EnvFile) {
    foreach ($line in (Get-Content $EnvFile)) {
        $t = $line.Trim()
        if (-not $t -or $t.StartsWith('#')) { continue }
        $eq = $t.IndexOf('=')
        if ($eq -lt 1) { continue }
        $k = $t.Substring(0, $eq).Trim()
        $v = $t.Substring($eq + 1).Trim().Trim('"').Trim("'")
        # An already-exported variable wins, so a one-off override still works.
        if (-not [Environment]::GetEnvironmentVariable($k)) {
            Set-Item -Path "env:$k" -Value $v
        }
    }
    Write-Step 'loaded .env'
}

if (-not $Domain) { $Domain = $env:NIGEHBAN_NGROK_DOMAIN }

# ---- prerequisites -------------------------------------------------------
if (-not (Test-Path $ServerPy)) {
    Write-Bad "Cannot find $ServerPy"
    exit 1
}

# The venv first, deliberately. A global python that happens to be on PATH is
# the one without fastapi in it, and the check below would then tell you to
# install something you have already installed -- into an interpreter that is
# never going to run the server.
$py = Join-Path $Root '.venv\Scripts\python.exe'
if (-not (Test-Path $py)) {
    $cmd = (Get-Command python -ErrorAction SilentlyContinue)
    if (-not $cmd) { $cmd = (Get-Command py -ErrorAction SilentlyContinue) }
    if (-not $cmd) {
        Write-Bad 'No python found. Create the venv and install the deps:'
        Write-Host '      python -m venv .venv' -ForegroundColor Yellow
        Write-Host '      .\.venv\Scripts\python.exe -m pip install -r requirements.txt' -ForegroundColor Yellow
        exit 1
    }
    $py = $cmd.Source
}
Write-Step "python: $py"

& $py -c "import fastapi, uvicorn" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Bad 'FastAPI is not installed for that interpreter. Run this first:'
    Write-Host "      $py -m pip install -r requirements.txt" -ForegroundColor Yellow
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
    Start-Process -FilePath $py -ArgumentList $ServerPy -WorkingDirectory $Root
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

# A tunnel that is already up on the wrong address is worse than none: it looks
# like success, and every phone is pointed somewhere else. Free ngrok runs one
# agent at a time, so the fix is to close it rather than open a second.
if ($url -and $Domain -and $url -notmatch [regex]::Escape($Domain)) {
    Write-Bad "a tunnel is already open on $url -- that is not $Domain"
    Write-Host '      free ngrok allows one agent at a time. Close it, then re-run:' -ForegroundColor Yellow
    Write-Host '      Get-Process ngrok -ErrorAction SilentlyContinue | Stop-Process' -ForegroundColor Yellow
    exit 1
}

if ($url) {
    Write-Step 'a tunnel is already open -- reusing it'
} else {
    $ngrokArgs = @('http', "$Port", '--log=stdout')
    if ($Domain) {
        # --url is the current flag. Older CLIs spell it --domain; if the tunnel
        # never appears, the failure message below names the alternative.
        $ngrokArgs += "--url=$Domain"
        Write-Step "opening the tunnel on $Domain"
    } else {
        Write-Step 'opening the tunnel (random address -- see -Domain)'
    }
    Start-Process -FilePath $ngrok.Source -ArgumentList $ngrokArgs
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
    if ($Domain) {
        Write-Host '      The other cause is an older ngrok that spells it --domain:' -ForegroundColor Yellow
        Write-Host "      ngrok http $Port --domain=$Domain" -ForegroundColor Yellow
    }
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
if ($Domain) {
    Write-Step 'this address is reserved -- it survives restarts, so paste it once'
} else {
    Write-Step 'this URL changes when ngrok restarts -- re-run this script and re-paste'
    Write-Step 'to stop that: reserve a domain at dashboard.ngrok.com, then -Domain <it>'
}
Write-Host ''

try { Set-Clipboard -Value $url; Write-Step 'copied to your clipboard' } catch { }
