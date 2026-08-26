#!/usr/bin/env python3
"""The execution graph: what to build next, and nothing else.

A loop that has to re-derive priorities every iteration will drift. This holds
the order once, as a dependency graph, so each pass answers one question —
what is the next thing with all its prerequisites met — and gets on with it.

    python3 tools/backlog.py next        one unblocked item, or DONE
    python3 tools/backlog.py graph       the whole graph, with what blocks what
    python3 tools/backlog.py done <id>   mark it built
    python3 tools/backlog.py start <id>  mark it in progress
    python3 tools/backlog.py block <id> "reason"

Ordering is dependency-first, then declaration order — the file is the
priority. Items blocked on something outside this repo (a GPU, an API key, a
legal entity) live in `blocked_external` and are never returned by `next`,
because a loop cannot unblock them and should not keep trying.

Stdlib only.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

PATH = Path(__file__).resolve().parent / "backlog.json"
STATUSES = ("todo", "doing", "done", "blocked")


def load() -> dict:
    return json.loads(PATH.read_text())


def save(data: dict) -> None:
    PATH.write_text(json.dumps(data, indent=2) + "\n")


def by_id(data: dict) -> dict[str, dict]:
    return {n["id"]: n for n in data["nodes"]}


def unmet(node: dict, index: dict[str, dict]) -> list[str]:
    """Dependencies that are not done yet."""
    return [d for d in node.get("needs", []) if index.get(d, {}).get("status") != "done"]


def next_node(data: dict) -> dict | None:
    index = by_id(data)
    # Something already in progress wins: finish it before starting anything new.
    for node in data["nodes"]:
        if node["status"] == "doing":
            return node
    for node in data["nodes"]:
        if node["status"] == "todo" and not unmet(node, index):
            return node
    return None


def cmd_next(data: dict) -> int:
    node = next_node(data)
    if node is None:
        remaining = [n for n in data["nodes"] if n["status"] not in ("done", "blocked")]
        if not remaining:
            print("DONE — every node in the graph is built.")
        else:
            index = by_id(data)
            print("STUCK — nothing is unblocked. Waiting on:")
            for n in remaining:
                print(f"  {n['id']} needs {', '.join(unmet(n, index))}")
        print("\nStill blocked outside this repo:")
        for b in data["blocked_external"]:
            print(f"  {b['id']}: {b['blocker']}")
        return 0

    print(f"id:     {node['id']}")
    print(f"title:  {node['title']}")
    print(f"why:    {node['why']}")
    print(f"verify: {node['verify']}")
    if node.get("needs"):
        print(f"needs:  {', '.join(node['needs'])} (all done)")
    return 0


def cmd_graph(data: dict) -> int:
    index = by_id(data)
    mark = {"done": "x", "doing": ">", "todo": " ", "blocked": "!"}
    print(f"# {data['gate']['name']} gate: {data['gate']['criterion']}\n")
    for node in data["nodes"]:
        needs = node.get("needs", [])
        suffix = ""
        if needs:
            missing = unmet(node, index)
            suffix = f"   ← {', '.join(needs)}" + (" (blocked)" if missing else "")
        print(f"[{mark[node['status']]}] {node['id']:24s} {node['title']}{suffix}")
        if node["status"] == "blocked" and node.get("blocked_reason"):
            print(f"      blocked: {node['blocked_reason']}")

    done = sum(1 for n in data["nodes"] if n["status"] == "done")
    print(f"\n{done}/{len(data['nodes'])} built")
    print("\noutside this repo:")
    for b in data["blocked_external"]:
        print(f"  {b['id']:16s} {b['blocker']}")
    return 0


def cmd_set(data: dict, node_id: str, status: str, reason: str | None = None) -> int:
    index = by_id(data)
    if node_id not in index:
        print(f"no node {node_id!r}. known: {', '.join(index)}", file=sys.stderr)
        return 1
    node = index[node_id]
    node["status"] = status
    if reason:
        node["blocked_reason"] = reason
    elif status != "blocked":
        node.pop("blocked_reason", None)
    save(data)
    print(f"{node_id} -> {status}")
    return 0


def main() -> int:
    args = sys.argv[1:]
    if not args:
        args = ["next"]
    data = load()
    command = args[0]

    if command == "next":
        return cmd_next(data)
    if command == "graph":
        return cmd_graph(data)
    if command in ("done", "start", "block"):
        if len(args) < 2:
            print(f"usage: backlog.py {command} <id>", file=sys.stderr)
            return 1
        status = {"done": "done", "start": "doing", "block": "blocked"}[command]
        reason = args[2] if len(args) > 2 else None
        if status == "blocked" and not reason:
            print("a block needs a reason", file=sys.stderr)
            return 1
        return cmd_set(data, args[1], status, reason)

    print(__doc__)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
