import json
import os
import secrets
import time as _time

from tornado.web import StaticFileHandler
from yadacoin.http.base import BaseHandler

DIST_DIR = os.path.join(os.path.dirname(__file__), "dist")

# ── In-memory stores ──────────────────────────────────────────────────────────

# Location recovery: key=DID, value={salt, iv, ciphertext, hints}
_location_hints: dict = {}

# VP token store for QR flow: key=short_token, value={vp_token, expires}
_vp_store: dict = {}
_VP_TTL = 300  # 5 minutes


# ── Location Hints Handler ────────────────────────────────────────────────────

class LocationHintsHandler(BaseHandler):
    """
    POST /wallet/api/location-hints  — save encrypted mnemonic + hints
    GET  /wallet/api/location-hints?did=... — retrieve hints for recovery

    The server stores:
      - did          : holder DID (lookup key)
      - salt         : PBKDF2 salt
      - iv           : AES-GCM nonce
      - ciphertext   : AES-GCM encrypted mnemonic
      - hints        : list of user-written hint strings (plaintext labels only)

    Coordinates are NEVER sent to or stored on the server.
    """

    async def post(self):
        try:
            body = json.loads(self.request.body)
        except Exception:
            self.set_status(400)
            return self.write({"error": "invalid JSON"})

        did = body.get("did", "").strip()
        if not did:
            self.set_status(400)
            return self.write({"error": "did required"})

        required = {"salt", "iv", "ciphertext", "hints"}
        if not required.issubset(body):
            self.set_status(400)
            return self.write({"error": f"missing fields: {required - set(body)}"})

        if not isinstance(body["hints"], list) or len(body["hints"]) != 8:
            self.set_status(400)
            return self.write({"error": "hints must be an array of 8 strings"})

        _location_hints[did] = {
            "salt": body["salt"],
            "iv": body["iv"],
            "ciphertext": body["ciphertext"],
            "hints": [str(h)[:80] for h in body["hints"]],
        }
        self.write({"ok": True})

    async def get(self):
        did = self.get_argument("did", "").strip()
        if not did:
            self.set_status(400)
            return self.write({"error": "did required"})

        record = _location_hints.get(did)
        if not record:
            self.set_status(404)
            return self.write({"error": "not found"})

        self.write(record)


# ── VP Test Endpoints ─────────────────────────────────────────────────────────

class VPTestEchoHandler(BaseHandler):
    """
    Test-only: accepts an OID4VP direct_post and echoes the body back as JSON.
    POST /wallet/test/vp-echo
    """

    def set_default_headers(self):
        self.set_header("Access-Control-Allow-Origin", "*")
        self.set_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.set_header("Access-Control-Allow-Headers", "Content-Type")

    async def options(self):
        self.set_status(204)
        self.finish()

    async def post(self):
        try:
            body = json.loads(self.request.body)
        except Exception:
            body = {"raw": self.request.body.decode("utf-8", errors="replace")}
        self.set_header("Content-Type", "application/json")
        self.write(json.dumps({
            "status": "ok",
            "message": "VP token received by test echo endpoint",
            "received": body,
        }))


class VPStoreHandler(BaseHandler):
    """
    Stores a VP token under a short random key and returns its retrieval URL.
    POST /wallet/test/vp-store  body: { "vp_token": "eyJ..." }
    Response: { "token": "abc123", "url": "http://host/wallet/test/vp-retrieve/abc123" }
    """

    def set_default_headers(self):
        self.set_header("Access-Control-Allow-Origin", "*")
        self.set_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.set_header("Access-Control-Allow-Headers", "Content-Type")

    async def options(self):
        self.set_status(204)
        self.finish()

    async def post(self):
        now = _time.time()
        for k in [k for k, v in _vp_store.items() if v["expires"] < now]:
            del _vp_store[k]

        try:
            body = json.loads(self.request.body)
            vp_token = body.get("vp_token", "")
        except Exception:
            self.set_status(400)
            self.write(json.dumps({"error": "invalid JSON body"}))
            return

        if not vp_token:
            self.set_status(400)
            self.write(json.dumps({"error": "vp_token required"}))
            return

        token = secrets.token_urlsafe(12)
        _vp_store[token] = {"vp_token": vp_token, "expires": now + _VP_TTL}

        scheme = "https" if self.request.headers.get("X-Forwarded-Proto") == "https" else "http"
        url = f"{scheme}://{self.request.host}/wallet/test/vp-retrieve/{token}"
        self.set_header("Content-Type", "application/json")
        self.write(json.dumps({"token": token, "url": url}))


class VPRetrieveHandler(BaseHandler):
    """
    Returns the stored VP token for a given short token (one-time, deleted after fetch).
    GET /wallet/test/vp-retrieve/{token}
    """

    def set_default_headers(self):
        self.set_header("Access-Control-Allow-Origin", "*")

    async def get(self, token):
        entry = _vp_store.pop(token, None)
        if not entry or entry["expires"] < _time.time():
            self.set_status(404)
            self.write(json.dumps({"error": "token not found or expired"}))
            return
        self.set_header("Content-Type", "application/json")
        self.write(json.dumps({"vp_token": entry["vp_token"], "status": "ok"}))


# ── Route table ───────────────────────────────────────────────────────────────

HANDLERS = [
    (r"/wallet/api/location-hints", LocationHintsHandler),
    (r"/wallet/test/vp-echo", VPTestEchoHandler),
    (r"/wallet/test/vp-store", VPStoreHandler),
    (r"/wallet/test/vp-retrieve/([a-zA-Z0-9_-]+)", VPRetrieveHandler),
    (
        r"/wallet/(.*)",
        StaticFileHandler,
        {"path": DIST_DIR, "default_filename": "index.html"},
    ),
]

from yadacoin.http.base import BaseHandler

DIST_DIR = os.path.join(os.path.dirname(__file__), "dist")

# In-memory hint store (replace with MongoDB for persistence across restarts)
# Key: normalized 8-char code, Value: list of 8 hint strings
# NOTE: No cryptographic material is ever stored here — only user-written text labels.
_hints: dict = {}


class LocationHintsHandler(BaseHandler):
    """
    POST /wallet/api/location-hints  { code, hints: [8 strings] }
    GET  /wallet/api/location-hints?code=XXXXXXXX

    Stores ONLY plaintext hint labels to help the user remember their locations.
    The wallet mnemonic is derived deterministically on-device from the coordinates.
    Coordinates are never sent to the server.
    """

    async def post(self):
        try:
            body = json.loads(self.request.body)
        except Exception:
            self.set_status(400)
            return self.write({"error": "invalid JSON"})

        code = body.get("code", "").strip().upper().replace("-", "")
        if not code:
            self.set_status(400)
            return self.write({"error": "code required"})

        hints = body.get("hints", [])
        if not isinstance(hints, list) or len(hints) != 8:
            self.set_status(400)
            return self.write({"error": "hints must be an array of 8 strings"})

        _hints[code] = [str(h)[:120] for h in hints]
        self.write({"ok": True})

    async def get(self):
        code = self.get_argument("code", "").strip().upper().replace("-", "")
        if not code:
            self.set_status(400)
            return self.write({"error": "code required"})

        hints = _hints.get(code)
        if hints is None:
            self.set_status(404)
            return self.write({"error": "not found"})

        self.write({"hints": hints})


HANDLERS = [
    (r"/wallet/api/location-hints", LocationHintsHandler),
    (
        r"/wallet/(.*)",
        StaticFileHandler,
        {"path": DIST_DIR, "default_filename": "index.html"},
    ),
]


class LocationHintsHandler(BaseHandler):
    """
    POST /wallet/api/location-hints  — save encrypted mnemonic + hints
    GET  /wallet/api/location-hints?code=XXXX — retrieve for recovery

    The server stores:
      - code       : user's Recovery Code (lookup key, NOT a secret)
      - salt       : PBKDF2 salt
      - iv         : AES-GCM nonce
      - ciphertext : AES-GCM encrypted mnemonic
      - hints      : list of 8 user-written hint strings

    Coordinates are NEVER sent to or stored on the server.
    Security comes from the coordinates being correct, not from the code.
    """

    async def post(self):
        try:
            body = json.loads(self.request.body)
        except Exception:
            self.set_status(400)
            return self.write({"error": "invalid JSON"})

        code = body.get("code", "").strip().upper().replace("-", "")
        if not code:
            self.set_status(400)
            return self.write({"error": "code required"})

        required = {"salt", "iv", "ciphertext", "hints"}
        if not required.issubset(body):
            self.set_status(400)
            return self.write({"error": f"missing fields: {required - set(body)}"})

        if not isinstance(body["hints"], list) or len(body["hints"]) != 8:
            self.set_status(400)
            return self.write({"error": "hints must be an array of 8 strings"})

        _location_hints[code] = {
            "salt": body["salt"],
            "iv": body["iv"],
            "ciphertext": body["ciphertext"],
            "hints": [str(h)[:80] for h in body["hints"]],
        }
        self.write({"ok": True})

    async def get(self):
        code = self.get_argument("code", "").strip().upper().replace("-", "")
        if not code:
            self.set_status(400)
            return self.write({"error": "code required"})

        record = _location_hints.get(code)
        if not record:
            self.set_status(404)
            return self.write({"error": "not found"})

        self.write(record)


HANDLERS = [
    (r"/wallet/api/location-hints", LocationHintsHandler),
    (
        r"/wallet/(.*)",
        StaticFileHandler,
        {"path": DIST_DIR, "default_filename": "index.html"},
    ),
]


# In-memory store for location hints (replace with MongoDB in production)
# Key: DID, Value: {salt, iv, ciphertext, hints}
_location_hints: dict = {}


class LocationHintsHandler(BaseHandler):
    """
    POST /wallet/api/location-hints  — save encrypted mnemonic + hints
    GET  /wallet/api/location-hints?did=... — retrieve hints (no ciphertext exposed to wrong caller)

    The server stores:
      - did          : holder DID (lookup key)
      - salt         : PBKDF2 salt (byte array)
      - iv           : AES-GCM nonce (byte array)
      - ciphertext   : AES-GCM encrypted mnemonic (byte array)
      - hints        : list of user-written hint strings (plaintext labels only)

    Coordinates are NEVER sent to or stored on the server.
    """

    async def post(self):
        try:
            body = json.loads(self.request.body)
        except Exception:
            self.set_status(400)
            return self.write({"error": "invalid JSON"})

        did = body.get("did", "").strip()
        if not did:
            self.set_status(400)
            return self.write({"error": "did required"})

        required = {"salt", "iv", "ciphertext", "hints"}
        if not required.issubset(body):
            self.set_status(400)
            return self.write({"error": f"missing fields: {required - set(body)}"})

        if not isinstance(body["hints"], list) or len(body["hints"]) != 8:
            self.set_status(400)
            return self.write({"error": "hints must be an array of 8 strings"})

        _location_hints[did] = {
            "salt": body["salt"],
            "iv": body["iv"],
            "ciphertext": body["ciphertext"],
            "hints": [str(h)[:80] for h in body["hints"]],
        }
        self.write({"ok": True})

    async def get(self):
        did = self.get_argument("did", "").strip()
        if not did:
            self.set_status(400)
            return self.write({"error": "did required"})

        record = _location_hints.get(did)
        if not record:
            self.set_status(404)
            return self.write({"error": "not found"})

        # Return everything — client needs salt+iv+ciphertext to decrypt
        self.write(record)


from plugins.yadacoinwallet.wallet_api import WALLET_HANDLERS as _WALLET_API_HANDLERS

HANDLERS = _WALLET_API_HANDLERS + [
    (r"/wallet/api/location-hints", LocationHintsHandler),
    (
        r"/wallet/(.*)",
        StaticFileHandler,
        {"path": DIST_DIR, "default_filename": "index.html"},
    ),
]
