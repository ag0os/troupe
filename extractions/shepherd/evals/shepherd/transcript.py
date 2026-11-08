#!/usr/bin/env python3
"""Render native session JSONL, retaining full calls and bounded tool results."""
import json
import sys
from pathlib import Path


def content_text(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(content_text(part) for part in value)
    if isinstance(value, dict):
        for key in ("text", "content"):
            if key in value:
                return content_text(value[key])
    return json.dumps(value, ensure_ascii=False, indent=2)


def read_log(path):
    events = []
    with Path(path).open() as stream:
        for number, line in enumerate(stream, 1):
            if line.strip():
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError as error:
                    raise ValueError(f"{path}:{number}: malformed JSONL: {error}") from error
    return events


def decode(events, backend):
    meta = {"model": [], "session": "unknown", "cwd": "unknown",
            "start": "unknown", "end": "unknown"}
    steps = []
    stamps = [event.get("timestamp") for event in events if event.get("timestamp")]
    if stamps:
        meta.update(start=min(stamps), end=max(stamps))
    for event in events:
        stamp = event.get("timestamp", "unknown")
        payload = event.get("payload", {})
        if backend == "claude":
            meta["session"] = event.get("sessionId", meta["session"])
            meta["cwd"] = event.get("cwd", meta["cwd"])
            if event.get("type") not in ("user", "assistant"):
                continue
            message = event.get("message", {})
            model = message.get("model")
            if model and model not in meta["model"]:
                meta["model"].append(model)
            parts = message.get("content", [])
            if isinstance(parts, str):
                parts = [{"type": "text", "text": parts}]
            for part in parts:
                kind = part.get("type")
                if kind == "tool_use":
                    steps.append((stamp, "tool call", part.get("name", "unknown"),
                                  part.get("id", ""), json.dumps(part.get("input", {}), ensure_ascii=False, indent=2)))
                elif kind == "tool_result":
                    steps.append((stamp, "tool output", "", part.get("tool_use_id", ""), content_text(part.get("content", ""))))
                elif kind in ("text", "thinking"):
                    steps.append((stamp, message.get("role", event["type"]),
                                  "thinking" if kind == "thinking" else "", "",
                                  part.get("text", part.get("thinking", ""))))
                else:
                    steps.append((stamp, message.get("role", event["type"]), kind or "content", "", content_text(part)))
        else:
            if event.get("type") == "session_meta":
                meta["session"] = payload.get("id", payload.get("session_id", "unknown"))
                meta["cwd"] = payload.get("cwd", "unknown")
                meta["start"] = payload.get("timestamp", meta["start"])
            if event.get("type") == "turn_context":
                model = payload.get("model")
                if model and model not in meta["model"]:
                    meta["model"].append(model)
            if event.get("type") != "response_item":
                continue
            kind = payload.get("type", "")
            if kind == "message" and payload.get("role") in ("user", "assistant"):
                steps.append((stamp, payload["role"], payload.get("phase", ""), "", content_text(payload.get("content", []))))
            elif kind in ("function_call", "custom_tool_call"):
                # Arguments/input stay verbatim, including multiline code.
                steps.append((stamp, "tool call", payload.get("name", "unknown"), payload.get("call_id", ""),
                              content_text(payload.get("arguments", payload.get("input", "")))))
            elif kind in ("function_call_output", "custom_tool_call_output"):
                steps.append((stamp, "tool output", "", payload.get("call_id", ""), content_text(payload.get("output", ""))))
            elif kind == "reasoning":
                text = content_text(payload.get("summary", []))
                if text:
                    steps.append((stamp, "assistant", "reasoning summary", "", text))
            elif kind.endswith("_call"):
                steps.append((stamp, "tool call", kind, payload.get("id", ""), content_text(payload)))
    return meta, steps


def fence(text):
    # Do not let a tool's own fences close the transcript's code block.
    longest = max((len(run) for run in __import__('re').findall(r'`+', text)), default=0)
    marker = '`' * max(3, longest + 1)
    return f"{marker}\n{text}\n{marker}"


def render(meta, steps, backend):
    out = [f"# {backend.capitalize()} session transcript", "",
           f"Model: {', '.join(meta['model']) or 'unknown (not recorded in log)'}",
           f"Session id: {meta['session']}", f"Cwd: {meta['cwd']}",
           f"Start: {meta['start']}", f"End: {meta['end']}", "",
           "Tool outputs are capped at 150 lines each. Tool calls are complete.", ""]
    for stamp, kind, name, call_id, text in steps:
        out.extend([f"## {stamp} | {kind}" + (f" | {name}" if name else ""), ""])
        if call_id:
            out.extend([f"Call id: {call_id}", ""])
        if kind == "tool output":
            lines = text.splitlines()
            if len(lines) > 150:
                text = '\n'.join(lines[:150]) + f"\n[output cut: {len(lines) - 150} further lines omitted]"
        out.extend([fence(text), ""])
    return '\n'.join(out)


def main():
    if len(sys.argv) != 3 or sys.argv[2] not in ("claude", "codex"):
        raise SystemExit("Usage: transcript.py <log.jsonl> <claude|codex>")
    meta, steps = decode(read_log(sys.argv[1]), sys.argv[2])
    print(render(meta, steps, sys.argv[2]))


if __name__ == "__main__":
    main()
