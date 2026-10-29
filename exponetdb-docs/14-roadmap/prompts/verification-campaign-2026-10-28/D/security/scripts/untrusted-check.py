#!/usr/bin/env python3
"""S4 task 3: for every MCP tool result in $L4/mcp/inj-*.json find the strings that carry the injected instruction text and report
the JSON path, and whether the tool's outputSchema marks that member `untrusted: true` (on the member or on an ancestor)."""
import json, glob, os, re, sys
L4 = os.environ.get("L4", "/srv/work/logs-s4")
MARK = re.compile(r"ignore.previous.instructions|call.plan.apply", re.I)
tools = {t["name"]: t for t in json.load(open(f"{L4}/mcp/tools.json"))["result"]["tools"]}
def sub(schema, key=None, idx=None):
    if schema is None: return None
    out = []
    for s in ([schema] + list(schema.get("anyOf", [])) + list(schema.get("oneOf", [])) + list(schema.get("allOf", []))):
        if key is not None and "properties" in s and key in s["properties"]: out.append(s["properties"][key])
        elif key is not None and isinstance(s.get("additionalProperties"), dict): out.append(s["additionalProperties"])
        if idx is not None and isinstance(s.get("items"), dict): out.append(s["items"])
    return out or None
def walk(val, schemas, path, marked, hits):
    def flagged(s):
        return isinstance(s, dict) and (s.get("untrusted") or any(isinstance(b, dict) and b.get("untrusted") for b in (s.get("anyOf", []) + s.get("oneOf", []))))
    marked = marked or any(flagged(s) for s in (schemas or []))
    if isinstance(val, str):
        if MARK.search(val):
            open_ = not schemas or all(not isinstance(s, dict) or not s or s == {} or "type" not in s and not s.get("anyOf") for s in schemas)
            hits.append((path, "untrusted" if marked else ("OPEN-JSON(no type)" if open_ else "UNMARKED")))
    elif isinstance(val, dict):
        for k, v in val.items():
            nxt = [x for s in (schemas or []) for x in (sub(s, key=k) or [])] if schemas else None
            walk(v, nxt, f"{path}.{k}", marked, hits)
    elif isinstance(val, list):
        for i, v in enumerate(val):
            nxt = [x for s in (schemas or []) for x in (sub(s, idx=i) or [])] if schemas else None
            walk(v, nxt, f"{path}[]", marked, hits)
rows = []
for f in sorted(glob.glob(f"{L4}/mcp/inj-*.json")):
    name = os.path.basename(f)[4:-5]; tool = name.split("@")[0]
    body = json.load(open(f))["body"]
    res = (body or {}).get("result") or {}
    sc = res.get("structuredContent")
    txt = "".join(c.get("text", "") for c in res.get("content", []) if isinstance(c, dict))
    hits = []
    if sc is not None: walk(sc, [tools[tool]["outputSchema"]] if tool in tools else None, "$", False, hits)
    text_hit = bool(MARK.search(txt)) and sc is None
    seen = {}
    for p, v in hits: seen.setdefault((re.sub(r"\[\]", "[]", p), v), 0); seen[(p, v)] += 1
    rows.append((name, res.get("isError"), seen, text_hit, "openWorldHint" in tools.get(tool, {}).get("annotations", {}) and tools[tool]["annotations"]["openWorldHint"]))
for name, err, seen, th, ow in rows:
    if not seen and not th: print(f"{name:34} isError={err!s:5} openWorld={ow!s:5} no injected text returned"); continue
    for (p, v), n in sorted(seen.items()): print(f"{name:34} isError={err!s:5} openWorld={ow!s:5} {v:20} x{n} {p}")
    if th: print(f"{name:34} text content only, instruction text present")
