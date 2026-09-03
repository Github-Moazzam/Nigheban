"""
`python -m server` -- the banner, and uvicorn.

Kept apart from app.py so that importing the application never starts one, and
never prints anything. The banner is the only reason this file exists: the
address it prints is the one that has to be typed into the phones.
"""

import json

from server.app import app
from server.config import PORT


def main():
    import socket
    import uvicorn

    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80)); ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()

    # If a tunnel is already up, its address is the one worth printing: it is
    # the only one that works from a phone on mobile data.
    tunnel = None
    try:
        import urllib.request
        with urllib.request.urlopen("http://127.0.0.1:4040/api/tunnels", timeout=1) as r:
            for t in json.load(r).get("tunnels", []):
                if t.get("proto") == "https":
                    tunnel = t["public_url"]
                    break
    except Exception:
        pass

    print("=" * 66)
    print("  NIGEHBAN SERVER")
    print(f"  Same Wi-Fi:      http://{ip}:{PORT}")
    if tunnel:
        print(f"  From anywhere:   {tunnel}   <-- put this in the phones")
    else:
        print("  From anywhere:   run scripts/dev-tunnel.ps1 to open a tunnel")
    print("=" * 66)
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
