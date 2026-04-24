#!/usr/bin/env python3
"""
Don's Repo Viewer - optional no-framework local repository scanner.

Run:
  python server.py --root "C:/path/to/repo"
  python server.py --port 8080

Open:
  http://localhost:8080

No dependencies outside Python stdlib.
"""
from __future__ import annotations

import argparse
import html
import json
import mimetypes
import os
import re
import subprocess
import sys
import time
import traceback
import urllib.parse
from dataclasses import dataclass, asdict
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from typing import Any

APP_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = APP_DIR / "public"
CACHE_DIR = APP_DIR / "cache"
CACHE_DIR.mkdir(exist_ok=True)
MAX_SCAN_FILES = 12_000
MAX_LINK_DEPTH = 16
TOOL_OWN_NAMES = {"server.py", "README.md", "public", "__pycache__"}

DEFAULT_IGNORE_DIRS = {
    ".git", ".hg", ".svn", ".idea", ".vs", ".vscode", "node_modules", "vendor",
    "build", "bin", "obj", "out", "dist", "target", "Debug", "Release", "x64",
    "__pycache__", ".pytest_cache", ".cache", "CMakeFiles"
}
DEFAULT_IGNORE_EXTS = {
    ".exe", ".dll", ".lib", ".pdb", ".obj", ".o", ".a", ".so", ".dylib",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tga",
    ".wav", ".mp3", ".ogg", ".flac", ".mp4", ".mov", ".avi",
    ".zip", ".7z", ".rar", ".tar", ".gz", ".blend", ".fbx", ".glb", ".gltf",
    ".ttf", ".otf", ".woff", ".woff2", ".pdf"
}
TEXT_EXTS = {
    ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx", ".inl",
    ".lua", ".py", ".js", ".ts", ".jsx", ".tsx", ".html", ".css", ".json",
    ".xml", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".cmake", ".md", ".txt",
    ".glsl", ".vert", ".frag", ".comp", ".metal", ".wgsl", ".bat", ".sh", ".ps1",
    ".java", ".cs", ".go", ".rs", ".rb", ".php", ".sql"
}

SYMBOL_PATTERNS = [
    re.compile(r"^\s*(?:class|struct)\s+([A-Za-z_]\w*)"),
    re.compile(r"^\s*namespace\s+([A-Za-z_]\w*)"),
    re.compile(r"^\s*(?:static\s+)?(?:inline\s+)?(?:virtual\s+)?(?:[A-Za-z_:<>~*&]+\s+)+([A-Za-z_~]\w*(?:::[A-Za-z_~]\w*)?)\s*\([^;]*\)\s*(?:const\s*)?(?:\{|$)"),
    re.compile(r"^\s*function\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\("),
    re.compile(r"^\s*local\s+function\s+([A-Za-z_]\w*)\s*\("),
    re.compile(r"^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)\s*\("),
    re.compile(r"^\s*(?:export\s+)?class\s+([A-Za-z_]\w*)"),
    re.compile(r"^\s*def\s+([A-Za-z_]\w*)\s*\("),
]
IMPORT_PATTERNS = [
    re.compile(r'^\s*#\s*include\s+[<"]([^>"]+)[>"]'),
    re.compile(r'^\s*import\s+.*?from\s+["\']([^"\']+)["\']'),
    re.compile(r'^\s*import\s+["\']([^"\']+)["\']'),
    re.compile(r'^\s*(?:local\s+)?[A-Za-z_]\w*\s*=\s*require\s*\(?["\']([^"\']+)["\']\)?'),
    re.compile(r'^\s*require\s*\(?["\']([^"\']+)["\']\)?'),
]

@dataclass
class RepoFile:
    path: str
    name: str
    ext: str
    size: int
    lines: int
    kind: str
    symbols: list[str]
    imports: list[str]
    todos: int
    modified: float

class RepoState:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.data: dict[str, Any] = {}
        self.scanned_at = 0.0
        self.error = ""
        self.scan_cache: dict[str, dict[str, Any]] = {}
        self.path_map_cache: dict[str, dict[str, Path]] = {}
        self.cache_times: dict[str, float] = {}
        self.recent_roots: list[str] = []

        # virtual repo-browser path -> real disk path
        self.path_map: dict[str, Path] = {}

    def set_root(self, root: Path):
        self.root = resolve_user_path(root).resolve()
        self.data = {}
        self.path_map = {}
        self.scanned_at = 0.0
        self.error = ""
        root_key = str(self.root)
        self.recent_roots = [root_key] + [r for r in self.recent_roots if r != root_key]
        self.recent_roots = self.recent_roots[:30]

STATE = RepoState(Path.cwd())

def is_junction(path: Path) -> bool:
    fn = getattr(path, "is_junction", None)
    if fn is None:
        return False
    try:
        return bool(fn())
    except OSError:
        return False


def resolve_windows_lnk(path: Path) -> Path | None:
    """
    Resolve a Windows .lnk shortcut using the built-in Windows Script Host COM object.
    No third-party dependencies.
    """
    if os.name != "nt" or path.suffix.lower() != ".lnk":
        return None

    try:
        ps = (
            "$p = [Console]::In.ReadToEnd().Trim(); "
            "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($p); "
            "[Console]::Out.Write($s.TargetPath)"
        )
        out = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
            input=str(path),
            capture_output=True,
            text=True,
            timeout=4,
        )
        if out.returncode != 0:
            return None

        target = out.stdout.strip().strip('"')
        if not target:
            return None

        p = Path(target).expanduser()
        if p.exists():
            return p.resolve()
    except Exception:
        return None

    return None


def resolve_url_shortcut(path: Path) -> Path | None:
    """
    Resolve simple file:// .url shortcuts.
    This does not clone web URLs. It only resolves local file/folder URLs.
    """
    if path.suffix.lower() != ".url":
        return None

    try:
        text = path.read_text(encoding="utf-8", errors="replace")
        for line in text.splitlines():
            if line.lower().startswith("url=file://"):
                raw = line.split("=", 1)[1].strip()
                parsed = urllib.parse.urlparse(raw)
                local = urllib.parse.unquote(parsed.path)

                # Windows file URLs often look like /C:/path
                if os.name == "nt" and re.match(r"^/[A-Za-z]:/", local):
                    local = local[1:]

                p = Path(local).expanduser()
                if p.exists():
                    return p.resolve()
    except Exception:
        return None

    return None


def resolve_user_path(path: Path) -> Path:
    """
    Resolve a typed/opened path. Allows opening:
      - normal folders
      - symlink folders
      - junction folders
      - Windows .lnk files pointing to folders
      - file:// .url shortcuts pointing to folders
    """
    raw = os.path.expandvars(str(path))
    p = Path(raw).expanduser()

    if p.suffix.lower() == ".lnk":
        target = resolve_windows_lnk(p)
        if target:
            return target

    if p.suffix.lower() == ".url":
        target = resolve_url_shortcut(p)
        if target:
            return target

    return p

def safe_rel(root: Path, rel: str) -> Path:
    decoded = urllib.parse.unquote(rel or "").replace("\\", "/").lstrip("/")

    # The browser can only read files that the scanner already discovered.
    mapped = STATE.path_map.get(decoded)
    if mapped is not None:
        return mapped

    candidate = (root / decoded).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError:
        raise PermissionError("Path escapes repo root or was not discovered during scan")

    return candidate

def is_probably_text(path: Path) -> bool:
    if path.suffix.lower() in TEXT_EXTS:
        return True
    try:
        with path.open("rb") as f:
            chunk = f.read(2048)
        if b"\x00" in chunk:
            return False
        if not chunk:
            return True
        textish = sum(1 for b in chunk if b in b"\n\r\t" or 32 <= b < 127)
        return textish / len(chunk) > 0.85
    except OSError:
        return False


def read_text_limited(path: Path, max_bytes: int = 400_000) -> str:
    with path.open("rb") as f:
        raw = f.read(max_bytes + 1)
    if len(raw) > max_bytes:
        raw = raw[:max_bytes]
    return raw.decode("utf-8", errors="replace")


def analyze_file(root: Path, path: Path, rel_override: str | None = None) -> RepoFile:
    rel = rel_override or path.relative_to(root).as_posix()
    ext = path.suffix.lower()
    stat = path.stat()
    kind = "text" if is_probably_text(path) else "binary"
    symbols: list[str] = []
    imports: list[str] = []
    todos = 0
    lines = 0

    if kind == "text":
        try:
            text = read_text_limited(path)
            split = text.splitlines()
            lines = len(split)

            for line in split[:4000]:
                if "TODO" in line or "FIXME" in line or "HACK" in line or "BUG" in line:
                    todos += 1

                if len(symbols) < 80:
                    for pat in SYMBOL_PATTERNS:
                        m = pat.search(line)
                        if m:
                            s = m.group(1)
                            if s not in symbols and s not in {"if", "for", "while", "switch", "catch"}:
                                symbols.append(s)
                            break

                if len(imports) < 120:
                    for pat in IMPORT_PATTERNS:
                        m = pat.search(line)
                        if m:
                            imp = m.group(1).strip()
                            if imp not in imports:
                                imports.append(imp)
                            break
        except Exception:
            kind = "unreadable"

    return RepoFile(rel, path.name, ext, stat.st_size, lines, kind, symbols, imports, todos, stat.st_mtime)

def resolve_import(files_by_name: dict[str, list[str]], importer_path: str, imp: str) -> str | None:
    imp_norm = imp.replace("\\", "/")
    if imp_norm.startswith("./") or imp_norm.startswith("../"):
        base = Path(importer_path).parent
        test = (base / imp_norm).as_posix()
        if test in files_by_name.get(Path(test).name, []):
            return test
    base_name = Path(imp_norm).name
    candidates = files_by_name.get(base_name, [])
    if candidates:
        return candidates[0]
    # Lua require foo.bar -> foo/bar.lua
    lua_guess = imp_norm.replace(".", "/") + ".lua"
    candidates = files_by_name.get(Path(lua_guess).name, [])
    for c in candidates:
        if c.endswith(lua_guess):
            return c
    # JS relative imports without extension
    for ext in [".js", ".ts", ".jsx", ".tsx", ".lua", ".py", ".hpp", ".h", ".cpp"]:
        name = Path(imp_norm + ext).name
        candidates = files_by_name.get(name, [])
        if candidates:
            return candidates[0]
    return None


def build_tree(files: list[RepoFile]) -> dict[str, Any]:
    root: dict[str, Any] = {"name": STATE.root.name, "path": "", "type": "dir", "children": {}}
    for f in files:
        parts = f.path.split("/")
        node = root
        cur = ""
        for part in parts[:-1]:
            cur = f"{cur}/{part}" if cur else part
            node = node["children"].setdefault(part, {"name": part, "path": cur, "type": "dir", "children": {}})
        node["children"][parts[-1]] = {"name": parts[-1], "path": f.path, "type": "file", "size": f.size, "lines": f.lines, "kind": f.kind, "ext": f.ext, "todos": f.todos}
    def finish(n: dict[str, Any]) -> dict[str, Any]:
        if n.get("type") == "dir":
            kids = list(n["children"].values())
            kids.sort(key=lambda x: (x["type"] != "dir", x["name"].lower()))
            n["children"] = [finish(k) for k in kids]
            n["fileCount"] = sum((c.get("fileCount", 1 if c["type"] == "file" else 0)) for c in n["children"])
            n["totalSize"] = sum((c.get("totalSize", c.get("size", 0))) for c in n["children"])
        return n
    return finish(root)


def scan_repo(force: bool = False) -> dict[str, Any]:
    root = STATE.root
    root_key = str(root)

    if not force and root_key in STATE.scan_cache and time.time() - STATE.cache_times.get(root_key, 0) < 600:
        STATE.data = STATE.scan_cache[root_key]
        STATE.path_map = STATE.path_map_cache.get(root_key, {})
        STATE.scanned_at = STATE.cache_times.get(root_key, time.time())
        return STATE.data

    if STATE.data and not force and time.time() - STATE.scanned_at < 10:
        return STATE.data

    if not root.exists() or not root.is_dir():
        raise FileNotFoundError(f"Repo root does not exist or is not a directory: {root}")

    STATE.path_map = {}

    files: list[RepoFile] = []
    dir_count = 0
    skipped = 0
    link_count = 0
    visited_dirs: set[Path] = set()

    def virtual_join(prefix: str, name: str) -> str:
        return f"{prefix}/{name}" if prefix else name

    def scan_dir(real_dir: Path, virtual_prefix: str = "", link_depth: int = 0):
        nonlocal dir_count, skipped, link_count

        if len(files) >= MAX_SCAN_FILES:
            skipped += 1
            return

        if link_depth > MAX_LINK_DEPTH:
            skipped += 1
            return

        try:
            real_dir = real_dir.resolve()
        except OSError:
            skipped += 1
            return

        if real_dir in visited_dirs:
            return

        visited_dirs.add(real_dir)
        dir_count += 1

        try:
            entries = sorted(real_dir.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except OSError:
            skipped += 1
            return

        for entry in entries:
            name = entry.name

            # Do not accidentally index self
            if real_dir == APP_DIR and name in TOOL_OWN_NAMES:
                skipped += 1
                continue

            # Folder ignores
            if name in DEFAULT_IGNORE_DIRS or name.startswith(".cache"):
                skipped += 1
                continue

            # Windows .lnk / .url folder shortcut traversal
            if entry.suffix.lower() in {".lnk", ".url"}:
                target = resolve_windows_lnk(entry) if entry.suffix.lower() == ".lnk" else resolve_url_shortcut(entry)
                if target and target.exists() and target.is_dir():
                    link_count += 1
                    scan_dir(target, virtual_join(virtual_prefix, name), link_depth + 1)
                else:
                    skipped += 1
                continue

            try:
                is_dir = entry.is_dir()
            except OSError:
                skipped += 1
                continue

            if is_dir:
                try:
                    if entry.is_symlink() or is_junction(entry):
                        link_count += 1
                    scan_dir(entry, virtual_join(virtual_prefix, name), link_depth + 1)
                except OSError:
                    skipped += 1
                continue

            # File ignores
            if entry.suffix.lower() in DEFAULT_IGNORE_EXTS:
                skipped += 1
                continue

            try:
                if entry.stat().st_size > 8_000_000:
                    skipped += 1
                    continue

                virtual_path = virtual_join(virtual_prefix, name).replace("\\", "/")
                real_path = entry.resolve()

                STATE.path_map[virtual_path] = real_path
                files.append(analyze_file(root, real_path, rel_override=virtual_path))
            except OSError:
                skipped += 1

            if len(files) >= MAX_SCAN_FILES:
                skipped += 1
                return

    scan_dir(root)

    files_by_name: dict[str, list[str]] = {}
    for f in files:
        files_by_name.setdefault(f.name, []).append(f.path)

    edges = []
    for f in files:
        for imp in f.imports:
            target = resolve_import(files_by_name, f.path, imp)
            edges.append({
                "from": f.path,
                "to": target or imp,
                "type": "import",
                "resolved": bool(target),
                "label": imp,
            })

    total_lines = sum(f.lines for f in files)
    total_size = sum(f.size for f in files)

    ext_counts: dict[str, int] = {}
    for f in files:
        ext_counts[f.ext or "[none]"] = ext_counts.get(f.ext or "[none]", 0) + 1

    top_large = sorted(files, key=lambda f: f.size, reverse=True)[:30]
    top_symbols = sorted(files, key=lambda f: len(f.symbols), reverse=True)[:30]

    data = {
        "root": str(root),
        "name": root.name,
        "scannedAt": time.time(),
        "dirs": dir_count,
        "skipped": skipped,
        "links": link_count,
        "stats": {
            "files": len(files),
            "dirs": dir_count,
            "links": link_count,
            "lines": total_lines,
            "bytes": total_size,
            "imports": len(edges),
            "todos": sum(f.todos for f in files),
            "extCounts": ext_counts,
        },
        "files": [asdict(f) for f in files],
        "tree": build_tree(files),
        "edges": edges,
        "hotspots": {
            "largest": [asdict(f) for f in top_large],
            "symbols": [asdict(f) for f in top_symbols],
        },
    }

    STATE.data = data
    STATE.path_map_cache[root_key] = dict(STATE.path_map)
    STATE.scan_cache[root_key] = data
    STATE.cache_times[root_key] = time.time()
    STATE.scanned_at = STATE.cache_times[root_key]
    return data

def list_cached_repos() -> dict[str, Any]:
    repos: list[dict[str, Any]] = []
    try:
        for child in sorted(CACHE_DIR.iterdir(), key=lambda p: p.name.lower()):
            if child.is_dir():
                repos.append({"name": child.name, "root": str(child.resolve()), "source": "cache"})
    except OSError:
        pass

    for root in STATE.recent_roots:
        if not any(r["root"] == root for r in repos):
            repos.append({"name": Path(root).name or root, "root": root, "source": "recent"})

    return {"current": str(STATE.root), "repos": repos}

def git_status(root: Path) -> dict[str, Any]:
    try:
        out = subprocess.run(["git", "-C", str(root), "status", "--short", "--branch"], capture_output=True, text=True, timeout=5)
        return {"ok": out.returncode == 0, "stdout": out.stdout, "stderr": out.stderr, "code": out.returncode}
    except Exception as e:
        return {"ok": False, "stdout": "", "stderr": str(e), "code": -1}


def clone_repo(url: str) -> Path:
    if not re.match(r"^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/?$", url):
        raise ValueError("Only simple public GitHub repo URLs are accepted by the optional local cache, like https://github.com/user/repo")
    repo_name = url.rstrip("/").split("/")[-1].replace(".git", "")
    target = CACHE_DIR / repo_name
    if target.exists():
        subprocess.run(["git", "-C", str(target), "pull", "--ff-only"], capture_output=True, text=True, timeout=60)
    else:
        subprocess.run(["git", "clone", "--depth", "1", url, str(target)], check=True, timeout=120)
    return target


class Handler(BaseHTTPRequestHandler):
    server_version = "DonsRepoViewer/0.2"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def send_json(self, obj: Any, status: int = 200):
        body = json.dumps(obj, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path
            qs = urllib.parse.parse_qs(parsed.query)
            if path == "/api/health":
                self.send_json({"ok": True, "name": "Don's Repo Viewer", "root": str(STATE.root)})
            elif path == "/api/repos":
                self.send_json(list_cached_repos())
            elif path == "/api/scan":
                self.send_json(scan_repo(force=qs.get("force", ["0"])[0] == "1"))
            elif path == "/api/file":
                rel = qs.get("path", [""])[0]
                p = safe_rel(STATE.root, rel)
                if not p.exists() or not p.is_file():
                    self.send_json({"error": "file not found"}, 404); return
                if not is_probably_text(p):
                    self.send_json({"path": rel, "binary": True, "content": ""}); return
                content = read_text_limited(p, 800_000)
                self.send_json({"path": rel, "binary": False, "content": content, "size": p.stat().st_size})
            elif path == "/api/search":
                q = qs.get("q", [""])[0].lower().strip()
                data = scan_repo()
                results = []
                if q:
                    for f in data["files"]:
                        score = 0
                        hay = (f["path"] + " " + " ".join(f.get("symbols", []))).lower()
                        if q in hay:
                            score += 10
                        if f["kind"] == "text" and score < 10:
                            try:
                                text = read_text_limited(safe_rel(STATE.root, f["path"]), 120_000).lower()
                                if q in text:
                                    score += 3
                            except Exception:
                                pass
                        if score:
                            item = dict(f)
                            item["score"] = score
                            results.append(item)
                results.sort(key=lambda x: (-x["score"], x["path"]))
                self.send_json({"query": q, "results": results[:200]})
            elif path == "/api/git/status":
                self.send_json(git_status(STATE.root))
            else:
                self.serve_static(path)
        except Exception as e:
            self.send_json({"error": str(e), "trace": traceback.format_exc()}, 500)

    def do_POST(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path == "/api/repo/open":
                body = self.read_json()
                root = Path(body.get("path", "")).expanduser()
                STATE.set_root(root)
                data = scan_repo(force=True)
                self.send_json({"ok": True, "root": str(STATE.root), "stats": data["stats"]})
            elif parsed.path == "/api/repo/clone":
                body = self.read_json()
                target = clone_repo(str(body.get("url", "")))
                STATE.set_root(target)
                data = scan_repo(force=True)
                self.send_json({"ok": True, "root": str(STATE.root), "stats": data["stats"]})
            else:
                self.send_json({"error": "not found"}, 404)
        except Exception as e:
            self.send_json({"error": str(e), "trace": traceback.format_exc()}, 500)

    def serve_static(self, path: str):
        if path == "/":
            path = "/index.html"
        rel = path.lstrip("/")
        target = (PUBLIC_DIR / rel).resolve()
        try:
            target.relative_to(PUBLIC_DIR.resolve())
        except ValueError:
            self.send_error(403); return
        if not target.exists() or not target.is_file():
            self.send_error(404); return
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    parser = argparse.ArgumentParser(description="Don\'s Repo Viewer")
    parser.add_argument("--root", default=str(CACHE_DIR), help="Repo folder or repo-cache folder to scan")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    STATE.set_root(Path(args.root))
    print(f"Don's Repo Viewer serving {STATE.root}")
    print(f"Open http://{args.host}:{args.port}")
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.serve_forever()

if __name__ == "__main__":
    main()
