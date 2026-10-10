"""Deterministic MODEL protocol fixture, never an OpenViking replacement.

The actual official OpenViking image owns all persistence, indexing, auth,
retrieval, and session commit. Hash vectors and canned summaries only exercise
the provider boundary; they do not demonstrate semantic retrieval or learning.
No request content, headers, or credentials are logged.
"""
import hashlib
import json
import math
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DIMENSIONS = 64
COUNTS = {"embeddings": 0, "chat": 0}


def embed(value):
    vector = [0.0] * DIMENSIONS
    for token in re.findall(r"[\w]+", str(value).lower()):
        digest = hashlib.sha256(token.encode()).digest()
        vector[int.from_bytes(digest[:2], "little") % DIMENSIONS] += 1.0
    norm = math.sqrt(sum(x * x for x in vector)) or 1.0
    return [x / norm for x in vector]


def schema_value(schema, root=None):
    root = root or schema
    if "$ref" in schema:
        value = root
        for part in schema["$ref"].removeprefix("#/").split("/"):
            value = value.get(part, {})
        return schema_value(value, root)
    if "default" in schema:
        return schema["default"]
    if "enum" in schema:
        return schema["enum"][0]
    if "anyOf" in schema:
        return schema_value(schema["anyOf"][0], root)
    kind = schema.get("type")
    if kind == "array":
        return []
    if kind == "object" or "properties" in schema:
        return {key: schema_value(value, root) for key, value in schema.get("properties", {}).items()
                if key in schema.get("required", [])}
    if kind == "boolean":
        return False
    if kind in ("integer", "number"):
        return 0
    if kind == "null":
        return None
    return "Protocol fixture — no semantic inference."


def complete(body):
    prompt = "\n".join(str(row.get("content", "")) for row in body.get("messages", []))
    # OpenViking appends extraction JSON schemas to the prompt. Produce a valid
    # empty extraction result: a completed pipeline is not proof of good memory.
    for candidate in reversed(re.findall(r"```json\s*(.*?)```", prompt, re.S)):
        try:
            schema = json.loads(candidate)
            if isinstance(schema, dict) and ("properties" in schema or "$defs" in schema):
                return json.dumps(schema_value(schema))
        except (ValueError, TypeError):
            pass
    return ("# Protocol fixture summary\n\n"
            "This record exercises Rna Agent and OpenViking persistence and retrieval. "
            "The model backend is deterministic test data, not semantic inference. "
            "Project topic: RNA_MEMORY_TEST cache budgeting and checkpoint recovery.\n")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def reply(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self.reply(200, {"ok": True, "mode": "model-protocol-fixture", "counts": COUNTS})
        if self.path == "/v1/models":
            return self.reply(200, {"data": [{"id": "rna-fixture-embedding-64"}, {"id": "rna-fixture-summary"}]})
        self.reply(404, {"error": "Unknown model fixture path"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 2_000_000:
            return self.reply(413, {"error": "Request too large"})
        body = json.loads(self.rfile.read(length))
        if self.path == "/v1/embeddings":
            COUNTS["embeddings"] += 1
            values = body.get("input", [])
            if isinstance(values, str):
                values = [values]
            return self.reply(200, {"object": "list", "model": body.get("model"),
                "data": [{"object": "embedding", "index": index, "embedding": embed(value)} for index, value in enumerate(values)],
                "usage": {"prompt_tokens": 1, "total_tokens": 1}})
        if self.path == "/v1/chat/completions":
            COUNTS["chat"] += 1
            return self.reply(200, {"id": "rna-fixture-completion", "object": "chat.completion", "created": int(time.time()),
                "model": body.get("model"), "choices": [{"index": 0, "message": {"role": "assistant", "content": complete(body)}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})
        self.reply(404, {"error": "Unknown model fixture path"})


if __name__ == "__main__":
    print("Rna model protocol fixture, no semantic model, listening on container port 8010", flush=True)
    ThreadingHTTPServer(("0.0.0.0", 8010), Handler).serve_forever()
