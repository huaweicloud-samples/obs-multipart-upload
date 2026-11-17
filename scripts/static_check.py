#!/usr/bin/env python3
"""Local static checks for this directory (no cloud access required):

1. Syntax check every FunctionGraph function file with `node --check`.
2. Credential hygiene: scan all deliverable files for real access key / secret key
   literals — both the exact values found in the local credentials.csv and generic
   access-key patterns. Any hit fails the check.

Writes static-check-result.json next to this script's parent directory.
"""
from __future__ import annotations

import csv
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FUNCTIONS = ROOT / "functions"
CREDENTIALS_CSV = Path("E:/code/huawei-samples/credentials.csv")

SKIP_DIRS = {"node_modules", ".terraform", "build", "__pycache__", ".git"}
TEXT_SUFFIXES = {".js", ".py", ".tf", ".md", ".json", ".html", ".css", ".txt", ".gitignore", ".example", ".cfg", ".yml", ".yaml"}

GENERIC_PATTERNS = [
    # AWS-style access key ids
    (re.compile(r"AKIA[0-9A-Z]{16}"), "aws access key id pattern"),
    # 40-char base64 secret-looking blobs
    (re.compile(r"(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])"), "40-char secret key blob"),
    # Huawei Cloud IAM user names of the hw<digits> form
    (re.compile(r"\bhw\d{6,}\b"), "iam user name pattern"),
]


def node_check() -> list[dict]:
    results = []
    ok = True
    for path in sorted(FUNCTIONS.glob("*.js")):
        proc = subprocess.run(["node", "--check", str(path)], capture_output=True, text=True)
        item = {"file": str(path.relative_to(ROOT)), "passed": proc.returncode == 0}
        if proc.returncode != 0:
            ok = False
            item["error"] = (proc.stderr or proc.stdout).strip()[:400]
        results.append(item)
        print(f"[static] {'PASS' if item['passed'] else 'FAIL'} node --check {item['file']}")
    return results, ok


def collect_secret_literals() -> list[str]:
    """Exact values from the local credentials.csv (user name, AK, SK)."""
    if not CREDENTIALS_CSV.exists():
        return []
    with open(CREDENTIALS_CSV, encoding="utf-8-sig", newline="") as handle:
        row = next(csv.reader(handle))
    return [value for value in row if value]


# 通用密钥形态扫描只针对手写文件：构建产物（压缩后的第三方代码）与 lock 文件
# 可能包含长 base64/hex 片段，容易误报；它们仍然会做下方的“精确值”扫描。
HANDWRITTEN_PREFIXES = ("functions", "scripts", "frontend/src", "frontend/public")


def scan_credentials() -> tuple[list[dict], bool]:
    secrets = collect_secret_literals()
    findings = []
    ok = True
    scanned = 0
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        scanned += 1
        rel = path.relative_to(ROOT)
        rel_posix = rel.as_posix()
        blob = path.read_bytes()
        for secret in secrets:
            if secret.encode("utf-8") in blob:
                findings.append({"file": rel_posix, "kind": "exact credential literal", "value": secret[:3] + "..."})
                ok = False
        hand_written = rel_posix.startswith(HANDWRITTEN_PREFIXES) or rel.parent == Path(".")
        if hand_written and (path.suffix.lower() in TEXT_SUFFIXES or path.name == ".gitignore"):
            try:
                text = blob.decode("utf-8", "replace")
            except Exception:
                continue
            for pattern, kind in GENERIC_PATTERNS:
                for match in pattern.findall(text):
                    findings.append({"file": rel_posix, "kind": kind, "value": (match if isinstance(match, str) else str(match))[:3] + "..."})
                    ok = False
    for finding in findings:
        print(f"[static] FAIL credential leak: {finding['file']} ({finding['kind']})")
    if ok:
        print(f"[static] PASS credential hygiene: {scanned} files scanned, no literal secrets")
    return findings, ok


def main() -> int:
    node_results, node_ok = node_check()
    credential_findings, cred_ok = scan_credentials()
    passed = node_ok and cred_ok
    result = {
        "passed": passed,
        "node_check": node_results,
        "credential_findings": credential_findings,
    }
    out = ROOT / "static-check-result.json"
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"passed": passed}, ensure_ascii=False))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
