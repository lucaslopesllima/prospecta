#!/usr/bin/env python3
import base64
import json
import time
import tomllib
import urllib.error
import urllib.request
from collections import deque
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).parent
POSTS = ROOT / "posts"
STATE_PATH = Path("/tmp/autopost-campaign-features-2026-08-13.json")
CONFIG_PATH = Path.home() / ".codex" / "config.toml"
PROTOCOL = "2026-07-28"
START = datetime(2026, 8, 14, 9, 0, tzinfo=timezone(timedelta(hours=-3)))
MAX_CALLS_PER_WINDOW = 50
WINDOW_SECONDS = 61

config = tomllib.loads(CONFIG_PATH.read_text())["mcp_servers"]["autopost"]
endpoint = config["url"]
authorization = config["http_headers"]["Authorization"]
calls = deque()


def save_state(state):
    STATE_PATH.write_text(json.dumps(state, indent=2, ensure_ascii=False))


def call_tool(name, arguments):
    now = time.monotonic()
    while calls and calls[0] <= now - WINDOW_SECONDS:
        calls.popleft()
    if len(calls) >= MAX_CALLS_PER_WINDOW:
        wait = calls[0] + WINDOW_SECONDS - now
        print(f"limite MCP: aguardando {wait:.0f}s", flush=True)
        time.sleep(max(wait, 0))
        now = time.monotonic()
        while calls and calls[0] <= now - WINDOW_SECONDS:
            calls.popleft()

    body = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": name,
            "arguments": arguments,
            "_meta": {
                "io.modelcontextprotocol/protocolVersion": PROTOCOL,
                "io.modelcontextprotocol/clientCapabilities": {},
            },
        },
    }).encode()
    request = urllib.request.Request(endpoint, data=body, headers={
        "Authorization": authorization,
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": PROTOCOL,
        "MCP-Method": "tools/call",
        "MCP-Name": name,
    })
    for attempt in range(3):
        try:
            response = json.load(urllib.request.urlopen(request, timeout=60))
            break
        except urllib.error.HTTPError as exc:
            if exc.code != 429 or attempt == 2:
                raise
            wait = int(exc.headers.get("Retry-After", "60")) + 1
            print(f"rate limit HTTP: aguardando {wait}s", flush=True)
            time.sleep(wait)
    calls.append(time.monotonic())
    result = response["result"]
    if result.get("isError"):
        message = " ".join(item.get("text", "") for item in result.get("content", []))
        raise RuntimeError(f"{name}: {message}")
    structured = result.get("structuredContent", {})
    return structured.get("result", structured)


def main():
    state = json.loads(STATE_PATH.read_text()) if STATE_PATH.exists() else {
        "media": {}, "posts": {}, "scheduled": {}
    }
    accounts = call_tool("autopost_listar_contas", {})
    selected = {
        account["provider"]: account["id"]
        for account in accounts
        if account["provider"] in ("facebook", "instagram")
        and account["status"] == "connected"
    }
    if set(selected) != {"facebook", "instagram"}:
        raise RuntimeError(f"contas Meta conectadas ausentes: {sorted(selected)}")

    post_dirs = sorted(path for path in POSTS.iterdir() if path.name.startswith("dia-"))
    images = [image for post_dir in post_dirs for image in sorted((post_dir / "instagram").glob("*.jpg"))]
    for index, image in enumerate(images, 1):
        key = str(image.relative_to(ROOT))
        if key not in state["media"]:
            uploaded = call_tool("autopost_enviar_midia", {
                "nome": image.name,
                "conteudo_base64": base64.b64encode(image.read_bytes()).decode(),
            })
            state["media"][key] = uploaded["id"]
            save_state(state)
        print(f"mídia {index}/{len(images)}", flush=True)

    for index, post_dir in enumerate(post_dirs):
        day = post_dir.name
        image_ids = [
            state["media"][str(image.relative_to(ROOT))]
            for image in sorted((post_dir / "instagram").glob("*.jpg"))
        ]
        if day not in state["posts"]:
            draft = call_tool("autopost_criar_rascunho", {
                "texto": (post_dir / "legenda.md").read_text().strip(),
                "media_ids": image_ids,
            })
            state["posts"][day] = draft["id"]
            save_state(state)
        when = START + timedelta(days=index)
        if day not in state["scheduled"]:
            call_tool("autopost_agendar_post", {
                "post_id": state["posts"][day],
                "scheduled_at": when.isoformat(),
                "account_ids": [selected["facebook"], selected["instagram"]],
                "placements": ["feed", "story"],
            })
            state["scheduled"][day] = when.isoformat()
            save_state(state)
        print(f"post {index + 1}/{len(post_dirs)}: {when.isoformat()}", flush=True)

    print(json.dumps({
        "media": len(state["media"]),
        "posts": len(state["posts"]),
        "scheduled": len(state["scheduled"]),
        "accounts": selected,
        "first": min(state["scheduled"].values()),
        "last": max(state["scheduled"].values()),
    }, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
