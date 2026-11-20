#!/usr/bin/env python3
"""Post-apply end-to-end verification for the OBS multipart upload sample.

Reads terraform outputs, then verifies over the deployed stack:

1. Page layer: GET / (with X-Stage) returns 200 HTML containing window.__CONFIG__ and the
   app root; asset URLs point at the public-read object storage bucket and one direct link
   resolves; without the X-Stage header the route is not served.
2. Main data plane (hard assertions): generate a 20MB random file, then
   POST /api/initialize -> POST /api/getPreSignedUrls -> PUT every part directly to the
   presigned URLs (simulating the browser XHR PUTs) -> POST /api/finalize, then download the
   assembled object from the private uploads bucket (OBS SigV1 header signature) and assert
   MD5 equality; the part count must be >= 3; response bodies/headers follow the sample API
   contract ({fileId, fileKey} / {parts: [{signedUrl, PartNumber}]} / 200 empty body).
3. Negative cases:
   - finalize with a wrong ETag -> the OBS error is passed through (status >= 400 with the
     OBS XML error body embedded in the response detail field);
   - abort: the source sample exposes no abort endpoint, so the abort leg is exercised
     directly against OBS by the script (DELETE ?uploadId=...) for cleanup, and a further
     part PUT against the aborted upload must fail (NoSuchUpload).
4. Results are written to verification-result.json next to this script's parent directory.

Usage:
    <python> scripts/verify_e2e.py        # after terraform apply

The OBS access key / secret key are read from credentials.csv (first data row, columns
AK / SK) and are used only for the direct-to-OBS download / abort legs; they are never
written to the result file.
"""
from __future__ import annotations

import base64
import csv
import email.utils
import hashlib
import hmac
import json
import os
import re
import subprocess
import time
import urllib.parse
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
TERRAFORM_EXE = "C:/Users/Administrator/AppData/Local/Temp/terraform.exe"
CREDENTIALS_CSV = Path("E:/code/huawei-samples/credentials.csv")

FILE_SIZE = 20 * 1024 * 1024  # 20MB -> 4 parts at 5MB (>= 3 required by the check)
CHUNK_SIZE = 5 * 1024 * 1024  # sample default part size (>= 5MB, OBS minimum part is 100KB)

# All HTTP calls bypass any system proxy configuration for direct cloud access.
SESSION = requests.Session()
SESSION.trust_env = False


def load_outputs() -> dict:
    exe = TERRAFORM_EXE if Path(TERRAFORM_EXE).exists() else "terraform"
    raw = subprocess.run(
        [exe, "output", "-json"], cwd=str(ROOT), capture_output=True, check=True
    ).stdout
    return {key: item["value"] for key, item in json.loads(raw.decode("utf-8")).items()}


def load_obs_credentials() -> tuple[str, str]:
    with open(CREDENTIALS_CSV, encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.reader(handle))
    # 首行为表头，数据行取 rows[1]：row[1]=Access Key，row[2]=Secret Key（与部署账号一致）。
    row = rows[1]
    return row[1], row[2]


# ---------------------------------------------------------------------------
# OBS SigV1 header signing (mirrors the functions' signing scheme, permanent
# credentials instead of the function agency's temporary ones)
# ---------------------------------------------------------------------------

def uri_encode(value) -> str:
    # 与函数侧同一口径：仅字母数字与 - _ . ~ 不转义，其余 %XX 大写。
    return urllib.parse.quote(str(value), safe="-_.~")


def encode_object_key(key: str) -> str:
    return "/".join(uri_encode(segment) for segment in key.split("/"))


def canonical_suffix(subresources: dict) -> str:
    names = sorted(subresources)
    if not names:
        return ""
    return "?" + "&".join(
        name if subresources[name] == "" else f"{name}={subresources[name]}" for name in names
    )


def obs_signed_headers(method: str, bucket: str, key: str, ak: str, sk: str, subresources=None) -> dict:
    date = email.utils.formatdate(usegmt=True)
    canonical_headers = f"x-obs-date:{date}\n"
    canonical_resource = f"/{bucket}/{encode_object_key(key)}" + canonical_suffix(subresources or {})
    string_to_sign = f"{method}\n\n\n\n{canonical_headers}{canonical_resource}"
    signature = base64.b64encode(
        hmac.new(sk.encode("utf-8"), string_to_sign.encode("utf-8"), hashlib.sha1).digest()
    ).decode("ascii")
    return {"x-obs-date": date, "Authorization": f"OBS {ak}:{signature}"}


def obs_download_object(region: str, bucket: str, key: str, ak: str, sk: str) -> requests.Response:
    url = f"https://{bucket}.obs.{region}.myhuaweicloud.com/{encode_object_key(key)}"
    headers = obs_signed_headers("GET", bucket, key, ak, sk)
    return SESSION.get(url, headers=headers, timeout=180)


def obs_abort_multipart(region: str, bucket: str, key: str, upload_id: str, ak: str, sk: str) -> requests.Response:
    url = (
        f"https://{bucket}.obs.{region}.myhuaweicloud.com/{encode_object_key(key)}"
        f"?uploadId={uri_encode(upload_id)}"
    )
    headers = obs_signed_headers("DELETE", bucket, key, ak, sk, {"uploadId": upload_id})
    return SESSION.delete(url, headers=headers, timeout=60)


# ---------------------------------------------------------------------------
# APIG calls (group debug subdomain; the published environment requires X-Stage)
# ---------------------------------------------------------------------------

def call_api(base: str, stage: str, path: str, payload: dict, expect_status: int = 200, attempts: int = 6):
    """POST JSON to an APIG route. Retries transient failures (agency credential
    propagation, DNS hiccups) but not business-level 4xx errors."""
    url = f"{base}{path}"
    headers = {"X-Stage": stage}
    last = None
    for attempt in range(attempts):
        try:
            response = SESSION.post(url, json=payload, headers=headers, timeout=30)
        except requests.RequestException as error:
            last = error
            time.sleep(10)
            continue
        if response.status_code == expect_status:
            return response
        # 5xx（如委托临时凭据尚未传播）才重试；4xx 是业务断言，直接返回。
        if response.status_code >= 500 and attempt < attempts - 1:
            last = f"HTTP {response.status_code}: {response.text[:200]}"
            time.sleep(10)
            continue
        return response
    raise RuntimeError(f"POST {url} failed after {attempts} attempts: {last}")


def http_get(url: str, stage: str | None = None, timeout: int = 30) -> requests.Response:
    headers = {"User-Agent": "omu-verify/1.0"}
    if stage:
        headers["X-Stage"] = stage
    return SESSION.get(url, headers=headers, timeout=timeout)


def http_get_retry(url: str, stage: str | None = None, attempts: int = 6, delay: float = 10.0) -> requests.Response:
    last_error = None
    for _ in range(attempts):
        try:
            return http_get(url, stage)
        except requests.RequestException as error:
            last_error = error
            time.sleep(delay)
    raise RuntimeError(f"GET {url} failed after {attempts} attempts: {last_error}")


def main() -> int:
    outputs = load_outputs()
    region = outputs["region"]
    stage = outputs["apig_env_name"]
    page_base = outputs["page_base_url"].rstrip("/")
    api_base = outputs["api_base_url"].rstrip("/")
    uploads_bucket = outputs["uploads_bucket"]
    static_base = outputs["static_base_url"].rstrip("/")
    ak, sk = load_obs_credentials()

    checks: list[dict] = []

    def record(name: str, passed: bool, detail: dict) -> None:
        checks.append({"name": name, "passed": passed, **detail})
        print(f"[verify] {'PASS' if passed else 'FAIL'} {name}: {json.dumps(detail, ensure_ascii=False)[:300]}")
        if not passed:
            raise AssertionError(f"check failed: {name}")

    def expect(condition: bool, message: str) -> None:
        if not condition:
            raise AssertionError(message)

    # ------------------------------------------------------------------
    # 1. Page layer
    # ------------------------------------------------------------------
    response = http_get_retry(f"{page_base}/", stage)
    html = response.text
    content_type = response.headers.get("Content-Type", "")
    config_match = re.search(r"window\.__CONFIG__\s*=\s*(\{.*?\});", html)
    record(
        "index_page",
        response.status_code == 200
        and "text/html" in content_type
        and config_match is not None
        and '<div id="root"></div>' in html,
        {"status": response.status_code, "content_type": content_type, "bytes": len(response.content)},
    )
    config = json.loads(config_match.group(1)) if config_match else {}
    record(
        "page_config_injected",
        config.get("apiBase", "").startswith(page_base)
        and config.get("stage") == stage
        and config.get("obsAssetPrefix") == static_base,
        {"config": config},
    )

    asset_urls = re.findall(r'(?:src|href)="(https://[^"]+\.(?:js|css))"', html)
    record(
        "asset_urls_use_object_storage",
        len(asset_urls) >= 1 and all(url.startswith(static_base) for url in asset_urls),
        {"asset_urls": asset_urls[:5]},
    )
    asset_response = http_get_retry(asset_urls[0])
    record(
        "static_asset_direct_link",
        asset_response.status_code == 200 and len(asset_response.content) > 0,
        {"url": asset_urls[0], "status": asset_response.status_code, "bytes": len(asset_response.content)},
    )

    no_stage = http_get(f"{page_base}/")
    record(
        "stage_header_required",
        no_stage.status_code != 200,
        {"status_without_stage": no_stage.status_code},
    )

    # ------------------------------------------------------------------
    # 2. Main data plane: 20MB -> multipart upload -> assembled object MD5
    # ------------------------------------------------------------------
    stamp = int(time.time())
    # 对象名带空格与子目录，覆盖函数侧的对象名分段 URL 编码路径。
    file_key = f"verify dir/e2e upload {stamp}.bin"
    data = os.urandom(FILE_SIZE)
    original_md5 = hashlib.md5(data).hexdigest()
    number_of_parts = -(-len(data) // CHUNK_SIZE)  # ceil division
    expect(number_of_parts >= 3, f"test file must produce >= 3 parts, got {number_of_parts}")

    response = call_api(api_base, stage, "/initialize", {"name": file_key})
    body = response.json()
    record(
        "initialize_contract",
        response.status_code == 200
        and "application/json" in response.headers.get("Content-Type", "")
        and isinstance(body.get("fileId"), str)
        and len(body["fileId"]) > 0
        and body.get("fileKey") == file_key,
        {"status": response.status_code, "file_key": body.get("fileKey"), "upload_id": body.get("fileId", "")[:12] + "..."},
    )
    upload_id = body["fileId"]

    response = call_api(api_base, stage, "/getPreSignedUrls", {
        "fileId": upload_id,
        "fileKey": file_key,
        "parts": number_of_parts,
    })
    body = response.json()
    parts = body.get("parts")
    part_numbers = [part.get("PartNumber") for part in parts or []]
    expected_host = f"{uploads_bucket}.obs.{region}.myhuaweicloud.com"
    url_checks_ok = all(
        isinstance(part.get("signedUrl"), str)
        and urllib.parse.urlparse(part["signedUrl"]).hostname == expected_host
        and all(param in urllib.parse.urlparse(part["signedUrl"]).query for param in
                ("AccessKeyId=", "Expires=", "Signature=", "partNumber=", "uploadId=", "x-obs-security-token="))
        for part in parts or []
    )
    record(
        "get_pre_signed_urls_contract",
        response.status_code == 200
        and "application/json" in response.headers.get("Content-Type", "")
        and isinstance(parts, list)
        and part_numbers == list(range(1, number_of_parts + 1))
        and url_checks_ok,
        {"status": response.status_code, "part_numbers": part_numbers, "expected_host": expected_host},
    )

    etags: dict[int, str] = {}
    for index, part in enumerate(parts):
        chunk = data[index * CHUNK_SIZE:(index + 1) * CHUNK_SIZE]
        part_response = SESSION.put(part["signedUrl"], data=chunk, timeout=300)
        expect(
            part_response.status_code == 200,
            f"part {part['PartNumber']} upload failed: HTTP {part_response.status_code}: {part_response.text[:200]}",
        )
        etag = part_response.headers.get("ETag", "")
        expect(etag != "", f"part {part['PartNumber']} upload returned no ETag header")
        etags[part["PartNumber"]] = etag.replace('"', "")
    record(
        "part_uploads_and_etags",
        len(etags) == number_of_parts,
        {"parts": number_of_parts, "etag_samples": [etags[1][:10] + "...", etags[number_of_parts][:10] + "..."]},
    )

    finalize_parts = [
        {"PartNumber": number, "ETag": etags[number]} for number in sorted(etags)
    ]
    response = call_api(api_base, stage, "/finalize", {
        "fileId": upload_id,
        "fileKey": file_key,
        "parts": finalize_parts,
    })
    record(
        "finalize_success_contract",
        response.status_code == 200 and response.text == "",
        {"status": response.status_code, "body_bytes": len(response.content)},
    )

    downloaded = obs_download_object(region, uploads_bucket, file_key, ak, sk)
    downloaded_md5 = hashlib.md5(downloaded.content).hexdigest()
    record(
        "assembled_object_md5",
        downloaded.status_code == 200 and downloaded_md5 == original_md5,
        {"status": downloaded.status_code, "bytes": len(downloaded.content),
         "original_md5": original_md5, "downloaded_md5": downloaded_md5},
    )

    # ------------------------------------------------------------------
    # 3. Negative case 1: finalize with a wrong ETag -> OBS error passthrough
    # ------------------------------------------------------------------
    negative_key = f"verify dir/e2e negative {stamp}.bin"
    response = call_api(api_base, stage, "/initialize", {"name": negative_key})
    negative_upload_id = response.json()["fileId"]

    response = call_api(api_base, stage, "/getPreSignedUrls", {
        "fileId": negative_upload_id,
        "fileKey": negative_key,
        "parts": 2,
    })
    negative_parts = response.json()["parts"]
    chunk = data[:CHUNK_SIZE]
    part_response = SESSION.put(negative_parts[0]["signedUrl"], data=chunk, timeout=300)
    expect(part_response.status_code == 200, "negative flow part upload failed")

    response = call_api(api_base, stage, "/finalize", {
        "fileId": negative_upload_id,
        "fileKey": negative_key,
        "parts": [{"PartNumber": 1, "ETag": "0" * 32}],
    }, expect_status=400)
    parsed = response.json() if response.text else {}
    detail = str(parsed.get("detail", ""))
    record(
        "finalize_wrong_etag_passthrough",
        response.status_code >= 400 and "<Code>" in detail,
        {"status": response.status_code, "error_code": (re.search(r"<Code>([^<]+)</Code>", detail) or [None, "?"])[1]},
    )

    # ------------------------------------------------------------------
    # 3. Negative case 2: abort the multipart task (no abort endpoint exists in
    #    the sample, so the script aborts directly against OBS as cleanup) and
    #    verify that a further part PUT against the aborted upload fails.
    # ------------------------------------------------------------------
    abort_response = obs_abort_multipart(region, uploads_bucket, negative_key, negative_upload_id, ak, sk)
    record(
        "abort_multipart_cleanup",
        abort_response.status_code == 204,
        {"status": abort_response.status_code, "key": negative_key},
    )

    reupload = SESSION.put(negative_parts[1]["signedUrl"], data=chunk, timeout=120)
    record(
        "aborted_upload_reupload_rejected",
        reupload.status_code == 404 and "NoSuchUpload" in reupload.text,
        {"status": reupload.status_code, "body_head": reupload.text[:120]},
    )

    result = {
        "passed": all(item["passed"] for item in checks),
        "mode": "apig",
        "base_url": page_base,
        "api_base_url": api_base,
        "stage": stage,
        "uploads_bucket": uploads_bucket,
        "checks": checks,
    }
    out = ROOT / "verification-result.json"
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"passed": result["passed"], "checks": len(checks)}, ensure_ascii=False))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as error:
        result = {"passed": False, "error": str(error)}
        (ROOT / "verification-result.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(str(error))
        raise SystemExit(1)
