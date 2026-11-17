# Browser Multipart Upload to OBS (FunctionGraph + APIG)

**English** | [简体中文](README.zh-CN.md)

A browser-based multipart upload sample: a large file is split into parts on the client and
uploaded **concurrently and directly to OBS** through part-level presigned URLs, while the
serverless backend only initializes the upload task, signs the part URLs and finalizes the
merge:

- Four FunctionGraph functions (Node.js 18.15, inline single-file code, zero npm dependencies):
  `initialize` / `getPresignedUrls` / `finalize` call the OBS REST API with the function
  agency's temporary credentials (OBS SigV1 header signature, or query-string signature for
  the browser-facing URLs); `index` returns the SPA page shell.
- The page is served by the `index` function through the APIG group debug subdomain;
  runtime configuration (`window.__CONFIG__`) is injected into the HTML, and static
  assets (JS / CSS / images) are served by direct links from a public-read OBS bucket.
- The browser uploader keeps the original chunking / concurrency / exponential-backoff /
  ETag collection logic: parts are uploaded with `XMLHttpRequest` PUTs, retried with
  exponential backoff, and each part's `ETag` (exposed via the bucket CORS rule) is
  collected for the final merge request.

## Architecture

```
Browser (React SPA, served from the APIG group debug subdomain)
  │  HTTPS (group debug subdomain; requests carry X-Stage: <published env>)
  ├── GET  /                      ──► FunctionGraph omu-index (Node.js 18)
  │                                     returns the HTML shell + window.__CONFIG__
  ├── POST /api/initialize         ──► FunctionGraph omu-initialize
  │                                     OBS POST /{key}?uploads  →  UploadId
  ├── POST /api/getPreSignedUrls   ──► FunctionGraph omu-get-presigned-urls
  │                                     per-part PUT URLs, query-string signature
  ├── POST /api/finalize           ──► FunctionGraph omu-finalize
  │                                     OBS POST /{key}?uploadId=…  (merge parts)
  │
  │  PUT part 1 … part N (concurrent XHR, backoff retry, ETag collection)
  ╰═══════════════════════════════════► OBS uploads bucket (private)
                                          CORS allows the page origin's PUT/GET/POST
                                          and exposes the ETag response header
OBS assets bucket (public read) ◄──── static JS/CSS/image direct links from the page
LTS log group ──── one log stream per function
```

- `omu-initialize`: creates the multipart upload task in OBS (`POST /{key}?uploads`) and
  returns `{fileId, fileKey}` (`fileId` is the OBS `UploadId`).
- `omu-get-presigned-urls`: signs one PUT URL per part
  (`PUT /{key}?partNumber=N&uploadId=…`, OBS signature-in-URL form, temporary
  agency credentials, configurable expiry via the `url_expires` variable).
- The browser uploads all parts concurrently straight to OBS; no file bytes transit the
  functions.
- `omu-finalize`: orders the parts by part number, builds the `CompleteMultipartUpload`
  XML body and merges the parts in OBS.
- `omu-index`: renders the page HTML, injecting the API base URL, the published
  environment name (sent by the uploader as the `X-Stage` header) and the asset prefix
  into `window.__CONFIG__`.

## API contract

| Method | Path | Request body | Response |
|---|---|---|---|
| GET | `/` | – | `text/html` page shell |
| POST | `/api/initialize` | `{"name": "<object key>"}` | `{"fileId": "<UploadId>", "fileKey": "<object key>"}` |
| POST | `/api/getPreSignedUrls` | `{"fileId": "…", "fileKey": "…", "parts": <count>}` | `{"parts": [{"signedUrl": "…", "PartNumber": 1}, …]}` |
| POST | `/api/finalize` | `{"fileId": "…", "fileKey": "…", "parts": [{"PartNumber": 1, "ETag": "…"}]}` | `200` empty body |

Errors return a non-2xx status with a JSON body `{"error": "…", "detail": "…"}`; when OBS
rejects a request, its status code and XML error body are passed through in `detail`.

## Resource inventory

| Resource | Name / description |
|---|---|
| `huaweicloud_fgs_function` × 4 | `omu-initialize`, `omu-get-presigned-urls`, `omu-finalize`, `omu-index`; Node.js18.15, 128 MB / 15 s, inline code |
| `huaweicloud_identity_agency` | `omu-obs-access`, trusts `op_svc_cff`, granted `OBS OperateAccess` at the all-resources scope (OBS is a global service) |
| `huaweicloud_obs_bucket` `uploads` | private, `force_destroy`; CORS rule for browser part PUTs (PUT/GET/POST, exposes `ETag`); lifecycle: uploaded objects expire after 10 days, incomplete multipart uploads are aborted after 1 day |
| `huaweicloud_obs_bucket` `assets` + `huaweicloud_obs_bucket_object` | public-read bucket (random-suffix name) and the frontend build artifacts |
| `huaweicloud_lts_group` + `huaweicloud_lts_stream` × 4 | log group `omu-logs` + one log stream per function |
| `huaweicloud_apig_instance` | `omu-instance` (BASIC edition, 5 Mbit/s), created only when both `shared_apig_*` variables are empty; along with its VPC / subnet / security group |
| `huaweicloud_apig_group` / `huaweicloud_apig_environment` | `omu-group` with the debug subdomain enabled; environment `prod` (calls must carry `X-Stage: prod`) |
| `huaweicloud_apig_api` × 4 + `huaweicloud_apig_api_publishment` × 4 | `GET /` → index; `POST /api/initialize` / `POST /api/getPreSignedUrls` / `POST /api/finalize` → the matching functions; all published to the environment |

## Directory structure

```
├── main.tf / variables.tf / outputs.tf / versions.tf
├── functions/                # 4 FunctionGraph function sources (inline upload)
├── frontend/                 # React 18 frontend (CRA), incl. the uploader in src/utils/upload.js
├── scripts/
│   ├── build.py              # one-shot build: CRA output → dist/frontend-build → dist/assets-manifest.json
│   ├── verify_e2e.py         # post-apply end-to-end verification, writes verification-result.json
│   └── static_check.py       # node --check on all functions + credential-literal scan
└── dist/                     # build artifacts (frontend-build/, assets-manifest.json)
```

## Deployment

Prerequisites:

- A Huawei Cloud account with permissions for APIG, FunctionGraph, OBS, IAM (agencies) and
  network resources; credentials injected through the `HW_ACCESS_KEY` / `HW_SECRET_KEY`
  environment variables.
- Terraform ≥ 1.5, Python 3.9+ (with the `requests` package for the verification script),
  Node.js 18+ (for local builds).
- Either an existing shared APIG dedicated instance and environment (IDs passed via
  variables), or leave them empty and this directory creates its own instance. A
  self-created BASIC-edition dedicated instance is managed according to the cloud console settings.

Steps:

```bash
# 0. If your shell has proxies configured, unset them first so Terraform reaches the cloud directly
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy

# 1. Build the frontend (first run installs frontend dependencies; requires access to an npm registry)
python scripts/build.py

# 2. Initialize (offline plugin cache; the cache directory must use the registry.terraform.io layout)
terraform init -plugin-dir=../../.terraform-plugin-cache

# 3. Validate
terraform validate

# 4. Preview and deploy
#    To reuse an existing shared dedicated instance instead of creating one:
#      export TF_VAR_shared_apig_instance_id=<instance ID>
#      export TF_VAR_shared_apig_env_id=<environment ID>     # Windows: use `set` instead
terraform apply
```

## Verification

After a successful `terraform apply`:

```bash
python scripts/verify_e2e.py
```

The script reads `terraform output` and verifies, carrying the `X-Stage` header:

1. `GET /` returns the page shell (200 HTML containing `window.__CONFIG__` and the app
   root) and the static asset direct links resolve from the public-read bucket;
   without the `X-Stage` header the route is not served;
2. the full data plane with a 20 MB random file: `initialize` → `getPreSignedUrls`
   (≥ 3 parts asserted) → every part PUT directly to the presigned URLs → `finalize`
   → the merged object is downloaded from the private bucket and its MD5 must match
   the original file; the response bodies/headers follow the API contract above;
3. negative cases: `finalize` with a wrong ETag returns a non-2xx status with the OBS
   error passed through; after the multipart task is aborted, a further part PUT fails
   with `NoSuchUpload` (the sample exposes no abort endpoint, so the script aborts the
   task directly against OBS).

Manual verification: open `terraform output page_base_url` in a browser, choose a part
size (MB) and the number of parallel uploads, then pick a large file and watch the
progress monitor. Results are written to `verification-result.json`.

```bash
curl -k -H "X-Stage: prod" https://<group debug subdomain>/
```

## Cleanup

```bash
terraform destroy
```

- Both buckets set `force_destroy`, so their objects are deleted with the stack.
- Incomplete multipart tasks (e.g. abandoned mid-upload) hold storage: the bucket
  lifecycle rule aborts them one day after they start. For immediate cleanup, abort them
  from the console / obsutil, or call `DELETE /{key}?uploadId=…` the same way the
  verification script does.

## Known limitations

- The page is accessed through the group debug subdomain; production scenarios need a
  custom domain (with a completed ICP filing) and certificate bound to the group.
- Browser part PUTs are cross-origin (page on the APIG domain, PUT to the bucket domain);
  this is handled by the bucket CORS rule. The rule keeps the wildcard origin because the
  debug subdomain is only assigned at apply time — the bucket itself stays private, and
  every request still requires a valid presigned URL.
- Part-level presigned URLs follow the OBS signature-in-URL API; their expiry defaults to
  300 seconds (`url_expires`). If OBS were to reject part-level query-signed URLs at
  runtime (e.g. HTTP 403), the fallback is to switch the frontend to the OBS browser SDK
  with backend-issued temporary credentials — the function API contract stays unchanged.
- OBS requires each part except the last to be at least 100 KB; the uploader keeps the
  5 MB default part size, which is also the safest value for retry granularity.
- The API has no authentication configured (demonstration); configure authentication and
  throttling policies for production use. Uploaded objects expire after 10 days through
  the bucket lifecycle rule.
- The sample intentionally exposes no abort endpoint (the browser demo does not need
  one); abandoned uploads are cleaned up by the lifecycle rule described above.
