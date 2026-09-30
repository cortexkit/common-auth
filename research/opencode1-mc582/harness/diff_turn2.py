#!/usr/bin/env python3
"""Compare turn 2's full `input` against what the provider already holds for turn 1.

Usage: diff_turn2.py <evidence dir>   (expects the 5-request layout:
#1 prewarm, #2 turn-1 main, #3 turn-1 tool continuation, #4 prewarm, #5 turn-2 main)

The provider's turn-1 context is: #2's input, #2's response output (reasoning,
assistant text, function_call), #3's input (the function_call_output), #3's
response output (final assistant text). Request inputs are compared byte-for-byte
(sorted-key JSON). Response outputs are not in the dumps, so assistant text is
compared against OpenCode's own stored copy of the model output (messages.json),
which is what the model actually generated.
"""
import glob
import json
import os
import sys

d = sys.argv[1]


def body(seq):
    (path,) = glob.glob(os.path.join(d, "dumps", f"*-{seq:05d}-*.body.json"))
    return json.load(open(path))


def canon(x):
    return json.dumps(x, sort_keys=True, ensure_ascii=False)


def text_of(item):
    c = item.get("content")
    if isinstance(c, list):
        return "".join(p.get("text", "") for p in c if isinstance(p, dict))
    return c if isinstance(c, str) else None


t1, cont, t2 = body(2)["input"], body(3)["input"], body(5)["input"]
messages = json.load(open(os.path.join(d, "messages.json")))
raw_assistant = [
    p["text"]
    for m in messages
    if m["info"]["role"] == "assistant"
    for p in m["parts"]
    if p["type"] == "text"
]
turn1_raw = raw_assistant[:-1]  # the last one is turn 2's reply

ai = 0
for i, item in enumerate(t2):
    kind = item.get("type", "message") + (f":{item['role']}" if item.get("role") else "")
    if i < len(t1):
        verdict = "identical to #2 input[%d]" % i if canon(item) == canon(t1[i]) else "DIFFERS from #2 input[%d]" % i
    elif item.get("type") == "function_call_output":
        match = [j for j, c in enumerate(cont) if canon(c) == canon(item)]
        verdict = f"identical to #3 input{match}" if match else "DIFFERS from #3 input"
    elif item.get("type") == "message" and item.get("role") == "assistant":
        sent = text_of(item)
        raw = turn1_raw[ai] if ai < len(turn1_raw) else None
        ai += 1
        verdict = (
            "identical to model output" if sent == raw
            else f"DIFFERS from model output: sent {sent[:48]!r} vs generated {raw[:48]!r}"
        )
    elif item.get("type") == "message" and item.get("role") == "user":
        verdict = "new in turn 2"
    else:
        verdict = "replayed provider output item (not in dumps; compare against arm A's cache attribution)"
    print(f"[{i}] {kind}: {verdict}")
