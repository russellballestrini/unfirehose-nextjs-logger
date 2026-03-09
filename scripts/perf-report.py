#!/usr/bin/env python3
"""
Unfirehose Performance Report
Benchmarks all pages and API routes, generates a report.

Usage:
    python3 scripts/perf-report.py [--runs N] [--base-url URL] [--threshold MS]
"""

import argparse
import json
import sys
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Optional

BASE = "http://localhost:3000"

def update_base(url: str):
    global BASE
    BASE = url

# ─── Route definitions ───────────────────────────────────────────────

# Pages (GET, expect HTML)
PAGES = [
    "/",
    "/live",
    "/active",
    "/logs",
    "/thinking",
    "/todos",
    "/todos/graph",
    "/projects",
    "/tokens",
    "/settings",
    "/styleguide",
    "/schema",
    "/scrobble",
    "/training",
    "/permacomputer",
    "/permacomputer/unsandbox",
    "/blog",
    "/keys",
]

# API routes (GET, expect JSON)
API_ROUTES = [
    "/api/dashboard",
    "/api/stats",
    "/api/projects",
    "/api/projects/activity",
    "/api/projects/metadata",
    "/api/logs?limit=50",
    "/api/thinking?limit=50",
    "/api/tokens",
    "/api/usage",
    "/api/alerts",
    "/api/settings",
    "/api/mesh",
    "/api/mesh/geoip",
    "/api/mesh/history",
    "/api/mesh/rates",
    "/api/todos",
    "/api/todos/summary",
    "/api/todos/pending?limit=20",
    "/api/todos/stale?days=7",
    "/api/schema",
    "/api/training",
    "/api/active-sessions",
    "/api/sessions/stale",
    "/api/ssh-config",
    "/api/blog",
    "/api/keys",
    "/api/llm/providers",
    "/api/scrobble/preview",
]

# Dynamic routes — resolved at runtime from API data
DYNAMIC_ROUTES_TEMPLATES = {
    "project_page": "/projects/{project}",
    "project_kanban": "/projects/{project}/kanban",
    "project_sessions_api": "/api/projects/{project}/sessions",
    "project_git_api": "/api/projects/{project}/git",
    "project_tree_api": "/api/projects/{project}/tree",
    "session_page": "/projects/{project}/{session}",
    "session_api": "/api/sessions/{session}",
    "session_thinking_api": "/api/sessions/{session}/thinking",
    "node_page": "/usage/node/{hostname}",
    "mesh_node_api": "/api/mesh/node?hostname={hostname}",
    "todos_triage_api": "/api/todos/triage?project={project}",
    "todos_graph_svg": "/api/todos/graph?project={project}",
}

# Skip these — destructive, mutation, auth, SSE streams
SKIP_PATTERNS = [
    "/api/auth/",
    "/api/account/",
    "/api/ingest",
    "/api/boot",
    "/api/harness/",
    "/api/pii-backfill",
    "/api/tmux/stream",
    "/api/unsandbox",
    "/api/webhooks/",
    "/api/triage",
    "/api/scrobble/payload",
    "/login",
]


@dataclass
class Result:
    url: str
    status: int = 0
    time_ms: float = 0.0
    size_bytes: int = 0
    error: Optional[str] = None
    runs: list = field(default_factory=list)
    category: str = "page"


def fetch_json(url: str) -> dict:
    """Quick JSON fetch for resolving dynamic params."""
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
    except Exception:
        return {}


def resolve_dynamic_routes() -> list[str]:
    """Resolve dynamic route templates with real data."""
    routes = []

    # Get a project
    data = fetch_json(f"{BASE}/api/projects")
    projects = data if isinstance(data, list) else data.get("projects", [])
    project = projects[0]["name"] if projects and isinstance(projects[0], dict) else None

    # Get a session
    session = None
    if project:
        sdata = fetch_json(f"{BASE}/api/projects/{project}/sessions")
        sessions = sdata.get("sessions", []) if isinstance(sdata, dict) else []
        if sessions:
            session = sessions[0].get("sessionId")

    # Get a mesh hostname
    hostname = None
    mdata = fetch_json(f"{BASE}/api/mesh")
    nodes = mdata.get("nodes", []) if isinstance(mdata, dict) else []
    reachable = [n for n in nodes if n.get("reachable")]
    if reachable:
        hostname = reachable[0].get("hostname")

    for key, template in DYNAMIC_ROUTES_TEMPLATES.items():
        url = template
        if "{project}" in url and not project:
            continue
        if "{session}" in url and not session:
            continue
        if "{hostname}" in url and not hostname:
            continue

        url = url.replace("{project}", project or "")
        url = url.replace("{session}", session or "")
        url = url.replace("{hostname}", hostname or "")
        routes.append(url)

    return routes


def bench_url(url: str, runs: int = 3) -> Result:
    """Benchmark a single URL over N runs."""
    full_url = f"{BASE}{url}" if url.startswith("/") else url
    is_api = "/api/" in url
    result = Result(url=url, category="api" if is_api else "page")

    times = []
    for i in range(runs):
        start = time.monotonic()
        try:
            req = urllib.request.Request(full_url)
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read()
                elapsed = (time.monotonic() - start) * 1000
                times.append(elapsed)
                if i == 0:
                    result.status = resp.status
                    result.size_bytes = len(body)
        except urllib.error.HTTPError as e:
            elapsed = (time.monotonic() - start) * 1000
            times.append(elapsed)
            if i == 0:
                result.status = e.code
                result.error = str(e.reason)
        except Exception as e:
            elapsed = (time.monotonic() - start) * 1000
            times.append(elapsed)
            if i == 0:
                result.status = 0
                result.error = str(e)[:80]

    result.runs = times
    result.time_ms = min(times) if times else 0  # best of N
    return result


def format_size(b: int) -> str:
    if b < 1024:
        return f"{b}B"
    if b < 1024 * 1024:
        return f"{b / 1024:.1f}K"
    return f"{b / (1024 * 1024):.1f}M"


def format_time(ms: float) -> str:
    if ms < 1000:
        return f"{ms:.0f}ms"
    return f"{ms / 1000:.2f}s"


def severity(ms: float, threshold: float) -> str:
    if ms > threshold * 3:
        return "CRITICAL"
    if ms > threshold:
        return "SLOW"
    return "ok"


def print_report(results: list[Result], threshold: float, runs: int):
    """Print the performance report."""
    pages = sorted([r for r in results if r.category == "page"], key=lambda r: -r.time_ms)
    apis = sorted([r for r in results if r.category == "api"], key=lambda r: -r.time_ms)

    total = len(results)
    errors = [r for r in results if r.status != 200]
    slow = [r for r in results if r.time_ms > threshold]
    critical = [r for r in results if r.time_ms > threshold * 3]

    print()
    print("=" * 80)
    print("  UNFIREHOSE PERFORMANCE REPORT")
    print(f"  {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}")
    print(f"  {total} endpoints, {runs} runs each, threshold {threshold:.0f}ms")
    print("=" * 80)

    # Summary
    print()
    all_times = [r.time_ms for r in results if r.status == 200]
    if all_times:
        avg = sum(all_times) / len(all_times)
        p50 = sorted(all_times)[len(all_times) // 2]
        p95 = sorted(all_times)[int(len(all_times) * 0.95)]
        p99 = sorted(all_times)[int(len(all_times) * 0.99)]
        print(f"  avg {format_time(avg)}  p50 {format_time(p50)}  p95 {format_time(p95)}  p99 {format_time(p99)}")
        print(f"  {len(slow)} slow (>{threshold:.0f}ms)  {len(critical)} critical (>{threshold * 3:.0f}ms)  {len(errors)} errors")

    # Errors
    if errors:
        print()
        print("  ERRORS")
        print("  " + "-" * 76)
        for r in errors:
            print(f"  {r.status:>4}  {r.url}")
            if r.error:
                print(f"        {r.error}")

    # Slow endpoints (sorted by time, worst first)
    def print_table(label: str, items: list[Result]):
        if not items:
            return
        print()
        print(f"  {label}")
        print(f"  {'URL':<55} {'best':>7} {'avg':>7} {'size':>6} {'status':>7}")
        print("  " + "-" * 86)
        for r in items:
            avg = sum(r.runs) / len(r.runs) if r.runs else 0
            sev = severity(r.time_ms, threshold)
            flag = " ***" if sev == "CRITICAL" else " *" if sev == "SLOW" else ""
            status_str = f"{r.status}" if r.status == 200 else f"{r.status} ERR"
            print(f"  {r.url:<55} {format_time(r.time_ms):>7} {format_time(avg):>7} {format_size(r.size_bytes):>6} {status_str:>7}{flag}")

    print_table("PAGES (sorted by response time)", pages)
    print_table("API ROUTES (sorted by response time)", apis)

    # Recommendations
    really_slow = [r for r in results if r.time_ms > threshold and r.status == 200]
    if really_slow:
        print()
        print("  RECOMMENDATIONS")
        print("  " + "-" * 76)
        for r in sorted(really_slow, key=lambda r: -r.time_ms)[:10]:
            sev = severity(r.time_ms, threshold)
            print(f"  [{sev}] {r.url} — {format_time(r.time_ms)}")
            if "/api/mesh" in r.url and "geoip" not in r.url:
                print(f"          SSH probes dominate. Consider caching or background refresh.")
            elif "/api/logs" in r.url or "/api/thinking" in r.url:
                print(f"          Large query. Add pagination or limit result size.")
            elif "/api/training" in r.url:
                print(f"          Training scan may be expensive. Consider caching.")
            elif r.category == "page" and r.time_ms > 2000:
                print(f"          Page server-render is slow. Check API calls in page component.")
            elif r.size_bytes > 500_000:
                print(f"          Large response ({format_size(r.size_bytes)}). Consider pagination.")

    print()
    print("=" * 80)
    print()

    # JSON output for machine consumption
    json_report = {
        "timestamp": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        "threshold_ms": threshold,
        "runs": runs,
        "total_endpoints": total,
        "errors": len(errors),
        "slow": len(slow),
        "critical": len(critical),
        "summary": {
            "avg_ms": round(avg, 1) if all_times else 0,
            "p50_ms": round(p50, 1) if all_times else 0,
            "p95_ms": round(p95, 1) if all_times else 0,
            "p99_ms": round(p99, 1) if all_times else 0,
        } if all_times else {},
        "results": [
            {
                "url": r.url,
                "category": r.category,
                "status": r.status,
                "best_ms": round(r.time_ms, 1),
                "avg_ms": round(sum(r.runs) / len(r.runs), 1) if r.runs else 0,
                "size_bytes": r.size_bytes,
                "error": r.error,
                "severity": severity(r.time_ms, threshold),
            }
            for r in sorted(results, key=lambda r: -r.time_ms)
        ],
    }

    report_path = "scripts/perf-report.json"
    with open(report_path, "w") as f:
        json.dump(json_report, f, indent=2)
    print(f"  JSON report saved to {report_path}")
    print()


def main():
    parser = argparse.ArgumentParser(description="Unfirehose Performance Report")
    parser.add_argument("--runs", type=int, default=3, help="Number of runs per endpoint (default: 3)")
    parser.add_argument("--base-url", default=BASE, help="Base URL (default: http://localhost:3000)")
    parser.add_argument("--threshold", type=float, default=500, help="Slow threshold in ms (default: 500)")
    parser.add_argument("--parallel", type=int, default=4, help="Parallel workers (default: 4)")
    args = parser.parse_args()

    # Update module-level base URL
    update_base(args.base_url)

    # Check server is up
    try:
        urllib.request.urlopen(f"{BASE}/api/stats", timeout=5)
    except Exception:
        print(f"ERROR: Server not reachable at {BASE}")
        sys.exit(1)

    print(f"Resolving dynamic routes...")
    dynamic = resolve_dynamic_routes()

    all_urls = PAGES + API_ROUTES + dynamic

    # Deduplicate
    seen = set()
    urls = []
    for u in all_urls:
        if u not in seen:
            seen.add(u)
            urls.append(u)

    print(f"Benchmarking {len(urls)} endpoints ({args.runs} runs each, {args.parallel} workers)...")

    # Run benchmarks with progress
    results = []
    done = 0
    total = len(urls)

    with ThreadPoolExecutor(max_workers=args.parallel) as pool:
        futures = {pool.submit(bench_url, url, args.runs): url for url in urls}
        for future in futures:
            result = future.result()
            results.append(result)
            done += 1
            sev = severity(result.time_ms, args.threshold)
            flag = " SLOW" if sev == "SLOW" else " CRITICAL" if sev == "CRITICAL" else ""
            sys.stdout.write(f"\r  [{done}/{total}] {result.url:<50} {format_time(result.time_ms):>7}{flag}   ")
            sys.stdout.flush()

    sys.stdout.write("\r" + " " * 90 + "\r")
    print_report(results, args.threshold, args.runs)


if __name__ == "__main__":
    main()
