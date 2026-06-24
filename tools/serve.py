#!/usr/bin/env python3
"""Dev server for docs/ that disables caching, so edits show on a normal reload.

    python tools/serve.py [port]      # default 8080

Plain `python -m http.server` sends no cache headers, so browsers reuse stale
app.js / preview.json after you change them. This sends Cache-Control: no-store
on every response, eliminating the "did my copy land?" guessing game.
"""

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
DOCS = str(Path(__file__).resolve().parent.parent / "docs")


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Pragma", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    handler = partial(NoCacheHandler, directory=DOCS)
    print(f"Serving docs/ at http://localhost:{PORT}  (no-cache)  —  Ctrl+C to stop")
    server = ThreadingHTTPServer(("", PORT), handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
