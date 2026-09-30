#!/usr/bin/env python3
"""Summarize one arm's openai-auth WebSocket dumps and usage diagnostics.

Usage: analyze.py <arm root> [<session id>]

Pairs each dumped request (phase prewarm/main, in send order) with the
matching `prewarm_completed` / `main_completed` diagnostic line in the
openai-auth debug log, then prints, per request: phase, previous_response_id,
input item count, item kinds, whether an assistant message is present, the
first characters of every text item, and usage (input, cached, uncached),
plus the provider's per-item cache attribution.
"""
import glob
import json
import os
import re
import sys

root = sys.argv[1]
only_session = sys.argv[2] if len(sys.argv) > 2 else None


def item_kind(item):
    t = item.get("type") or "message"
    if t == "message":
        return f"message:{item.get('role')}"
    return t


def item_text(item):
    content = item.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " | ".join(
            c.get("text", "") for c in content if isinstance(c, dict) and "text" in c
        )
    if item.get("type") == "function_call":
        return f"{item.get('name')}({item.get('arguments')}) call_id={item.get('call_id')}"
    if item.get("type") == "function_call_output":
        out = item.get("output")
        out = out if isinstance(out, str) else json.dumps(out)
        return f"call_id={item.get('call_id')} output[{len(out)} chars]={out[:40]!r}"
    return ""


dumps = []
for body_path in sorted(glob.glob(os.path.join(root, "dumps", "*.body.json"))):
    name = os.path.basename(body_path)
    m = re.search(r"-(\d{5})-(ses_[A-Za-z0-9]+)-websocket-(prewarm|main)\.body\.json$", name)
    if not m:
        continue
    seq, session, phase = m.groups()
    if only_session and session != only_session:
        continue
    with open(body_path) as fh:
        body = json.load(fh)
    dumps.append({"seq": int(seq), "session": session, "phase": phase, "file": name, "body": body})

diags = []
log_path = os.path.join(root, "logs", "openai-auth.log")
with open(log_path) as fh:
    for line in fh:
        if "[dump] diagnostic " not in line:
            continue
        d = json.loads(line.split("[dump] diagnostic ", 1)[1])
        if only_session and d.get("sessionID") != only_session:
            continue
        diags.append(d)

# Pair in order within each phase: the n-th prewarm dump completes as the n-th
# prewarm_completed, likewise for main (requests on one pooled socket are serial).
queues = {"prewarm": [d for d in diags if d["event"] == "prewarm_completed"],
          "main": [d for d in diags if d["event"] == "main_completed"]}
for d in dumps:
    q = queues[d["phase"]]
    d["diag"] = q.pop(0) if q else None

for d in dumps:
    body = d["body"]
    inp = body.get("input") or []
    kinds = [item_kind(i) for i in inp]
    usage = (d["diag"] or {}).get("usage") or {}
    it = usage.get("input_tokens")
    ct = (usage.get("input_tokens_details") or {}).get("cached_tokens")
    print(f"## #{d['seq']} {d['phase']}  ({d['file']})")
    print(f"previous_response_id: {body.get('previous_response_id')!r}")
    print(f"generate: {body.get('generate', '(absent)')!r}")
    print(f"input items: {len(inp)} -> {kinds}")
    print(f"assistant message in input: {any(k == 'message:assistant' for k in kinds)}")
    for idx, i in enumerate(inp):
        txt = item_text(i).replace("\n", "\\n")
        print(f"  [{idx}] {item_kind(i)}: {txt[:160]}")
    if d["diag"]:
        print(f"response: {d['diag'].get('responseID')}")
        uncached = it - ct if isinstance(it, int) and isinstance(ct, int) else None
        print(f"usage: input_tokens={it} cached_tokens={ct} uncached={uncached} output_tokens={usage.get('output_tokens')}")
        attr = (usage.get("attribution") or {}).get("items") or {}
        if attr:
            print("per-item attribution (provider item id: input / cached):")
            for k, v in attr.items():
                print(f"    {k[:28]}…  {v.get('input_tokens')} / {v.get('cached_tokens')}")
    print()
