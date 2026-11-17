#!/usr/bin/env python3
"""Build the React frontend (CRA) and produce the deterministic asset manifest.

Steps:
1. npm install (if node_modules missing) / react-scripts build (CRA output -> dist/frontend-build)
2. Scan the CRA build output and write dist/assets-manifest.json (hashed js/css names).
   The manifest is read by Terraform (`file()`) and injected into the page function
   (functions/index.js) so the served HTML references the exact hashed asset names.

Options:
  --npm   skip the npm build and only regenerate the manifest from an existing
          dist/frontend-build (useful while iterating on Terraform).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
DIST = ROOT / "dist"
FRONTEND_BUILD = DIST / "frontend-build"


def run(cmd: list[str], env: dict, cwd: Path) -> None:
    print(f"[build] $ {' '.join(cmd)}", flush=True)
    # shell=True on Windows so that npm.cmd is resolved through PATHEXT.
    result = subprocess.run(cmd, cwd=str(cwd), env=env, shell=(os.name == "nt"))
    if result.returncode != 0:
        raise SystemExit(f"[build] command failed: {' '.join(cmd)}")


def npm_env() -> dict:
    env = dict(os.environ)
    env["CI"] = "false"
    env["GENERATE_SOURCEMAP"] = "false"
    env.setdefault("NODE_OPTIONS", "--max-old-space-size=2048")
    return env


def build_cra(env: dict) -> None:
    if not (FRONTEND / "node_modules").is_dir():
        run(["npm", "install", "--no-audit", "--no-fund"], env, FRONTEND)
    shutil.rmtree(FRONTEND / "build", ignore_errors=True)
    run(["npm", "run", "build"], env, FRONTEND)
    shutil.rmtree(FRONTEND_BUILD, ignore_errors=True)
    shutil.copytree(FRONTEND / "build", FRONTEND_BUILD)


def write_assets_manifest() -> dict:
    js_files = sorted(
        p.relative_to(FRONTEND_BUILD).as_posix()
        for p in (FRONTEND_BUILD / "static" / "js").glob("*.js")
        if not p.name.endswith((".LICENSE.txt", ".map"))
    )
    css_files = sorted(
        p.relative_to(FRONTEND_BUILD).as_posix()
        for p in (FRONTEND_BUILD / "static" / "css").glob("*.css")
        if not p.name.endswith(".map")
    )
    manifest = {"js": js_files, "css": css_files}
    target = DIST / "assets-manifest.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"[build] assets manifest -> {target}: {manifest}", flush=True)
    return manifest


def main() -> int:
    env = npm_env()
    npm_only = "--npm" in sys.argv
    if not npm_only:
        build_cra(env)
    manifest = write_assets_manifest() if FRONTEND_BUILD.is_dir() else None
    if manifest is None:
        raise SystemExit("[build] frontend build output missing")
    print("[build] done", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
