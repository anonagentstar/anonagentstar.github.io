"""Serve the page locally with HTTP byte ranges, like GitHub Pages does.

`python -m http.server` ignores Range requests, and Chromium then refuses to
seek a <video> (its seekable range stays empty), so the timelapse timeline
cannot be scrubbed when the page is served that way. Usage, from the repo root:

    python scripts/serve.py [port]        # default 8765, binds 127.0.0.1
"""
import os
import re
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class RangeHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def send_head(self):
        path = self.translate_path(self.path)
        match = re.fullmatch(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
        if not match or os.path.isdir(path) or not os.path.isfile(path):
            self.range = None
            return super().send_head()
        size = os.path.getsize(path)
        start, end = match.groups()
        if start == "":                       # suffix range: the last N bytes
            start, end = max(0, size - int(end)), size - 1
        else:
            start = int(start)
            end = min(int(end), size - 1) if end else size - 1
        if start > end or start >= size:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None
        self.range = (start, end)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        return open(path, "rb")

    def end_headers(self):
        if getattr(self, "range", None) is None and self.command in ("GET", "HEAD"):
            self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def copyfile(self, source, outputfile):
        if getattr(self, "range", None) is None:
            return super().copyfile(source, outputfile)
        start, end = self.range
        source.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            chunk = source.read(min(65536, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)

    def log_message(self, format, *args):  # quiet, like a static host
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    server = ThreadingHTTPServer(("127.0.0.1", port), RangeHandler)
    print(f"serving {os.getcwd()} at http://127.0.0.1:{port}/ (byte ranges on)")
    server.serve_forever()
