"""Run the library privately on your own computer, including your personal files.

Usage:
    python website/serve_local.py            # then open http://127.0.0.1:8000
    python website/serve_local.py --port 9000

Only listens on 127.0.0.1 (this computer). Personal files are served only if
they are listed in data/catalog.private.json (run tools/build_catalog.py first).
"""
import argparse
import json
import mimetypes
import os
import shutil
import urllib.parse
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

SITE = os.path.dirname(os.path.abspath(__file__))
LIBRARY = os.path.dirname(SITE)
PRIVATE = os.path.join(SITE, "data", "catalog.private.json")


def allowed_paths():
    try:
        with open(PRIVATE, encoding="utf-8") as fh:
            return {b["path"] for b in json.load(fh)["books"] if b.get("path")}
    except (OSError, ValueError):
        return set()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=SITE, **kw)

    def send_file(self, path, ctype):
        size = os.path.getsize(path)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        with open(path, "rb") as fh:
            shutil.copyfileobj(fh, self.wfile)

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        if url.path == "/data/catalog.json" and os.path.isfile(PRIVATE):
            return self.send_file(PRIVATE, "application/json; charset=utf-8")
        if url.path.startswith("/files/"):
            rel = urllib.parse.unquote(url.path[len("/files/"):])
            if rel not in allowed_paths():
                return self.send_error(404, "Not in catalog")
            full = os.path.join(LIBRARY, *rel.split("/"))
            if not os.path.isfile(full):
                return self.send_error(404, "Missing file")
            ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
            return self.send_file(full, ctype)
        return super().do_GET()

    def log_message(self, fmt, *args):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{args.port}/"
    print(f"KLibrary running privately at {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
