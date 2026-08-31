import os
import sys
import time
import statistics
import requests

def run_benchmark(url, token, endpoints, n=10):
    print(f"Benchmarking against {url}")
    print(f"Running {n} iterations per endpoint...\n")
    
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    
    for endpoint, method, payload in endpoints:
        times = []
        full_url = f"{url.rstrip('/')}{endpoint}"
        
        for _ in range(n):
            start = time.perf_counter()
            try:
                if method.upper() == "GET":
                    res = requests.get(full_url, headers=headers)
                elif method.upper() == "POST":
                    res = requests.post(full_url, json=payload, headers=headers)
                else:
                    raise ValueError(f"Unsupported method: {method}")
                
                # We could check res.raise_for_status() but even errors take time
                res.content # wait for response body
            except requests.RequestException as e:
                print(f"Request failed: {e}")
                continue
            
            end = time.perf_counter()
            times.append((end - start) * 1000) # in ms
            
        if not times:
            print(f"{method} {endpoint} - Failed all requests")
            continue
            
        times.sort()
        p50 = statistics.median(times)
        # Approximate p95
        p95_idx = int(len(times) * 0.95)
        p95 = times[p95_idx]
        
        print(f"{method} {endpoint}")
        print(f"  p50: {p50:.2f} ms")
        print(f"  p95: {p95:.2f} ms")
        print()

if __name__ == "__main__":
    # Example token if endpoints require auth.
    # Replace with a valid test user session token if needed.
    TOKEN = os.environ.get("TEST_TOKEN", "")
    
    # You can customize these endpoints to hit the ones you care about
    endpoints_to_test = [
        # (path, method, json_payload_if_post)
        ("/health", "GET", None),
        # ("/checkins", "GET", None),
        # ("/alerts", "POST", {"kind": "test", "severity": 1})
    ]
    
    local_url = "http://127.0.0.1:8000"
    
    print("=== LOCAL (Direct) ===")
    run_benchmark(local_url, TOKEN, endpoints_to_test, n=20)
    
    print("Note: To benchmark against ngrok or production Supabase, change the local_url variable.")

