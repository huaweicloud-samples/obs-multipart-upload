# 浏览器分片并发上传 OBS（FunctionGraph + APIG）

[English](README.md) | **简体中文**

浏览器分片上传示例：大文件在客户端按分片拆分，经分片级预签名 URL **并发直传 OBS**，
后端函数只负责初始化上传任务、签发分片 URL 与完成合并：

- 四个 FunctionGraph 函数（Node.js 18.15，inline 单文件代码，零 npm 依赖）：
  `initialize` / `getPresignedUrls` / `finalize` 使用函数委托的临时凭据直调 OBS
  REST API（OBS SigV1 头签名；面向浏览器的分片 URL 采用查询串签名）；`index`
  返回 SPA 页面壳。
- 页面由 `index` 函数经 APIG 分组调试子域名提供；运行时配置
  （`window.__CONFIG__`）注入 HTML，静态资产（JS / CSS / 图片）从公共读 OBS 桶
  直链加载。
- 上传器保留原分片 / 并发 / 指数退避重试 / ETag 收集逻辑：分片用
  `XMLHttpRequest` PUT 直传，失败按指数退避重试，逐片收集 `ETag`
  （经桶 CORS 规则暴露给浏览器）供最终合并使用。

## 架构

```
浏览器（React SPA，由 APIG 分组调试子域名提供）
  │  HTTPS（分组调试子域名；请求携带 X-Stage: <发布环境名>）
  ├── GET  /                      ──► FunctionGraph omu-index（Node.js18）
  │                                     返回 HTML 壳 + window.__CONFIG__
  ├── POST /api/initialize         ──► FunctionGraph omu-initialize
  │                                     OBS POST /{key}?uploads  →  UploadId
  ├── POST /api/getPreSignedUrls   ──► FunctionGraph omu-get-presigned-urls
  │                                     逐分片 PUT URL，查询串签名
  ├── POST /api/finalize           ──► FunctionGraph omu-finalize
  │                                     OBS POST /{key}?uploadId=…（合并分片）
  │
  │  PUT 分片 1 … N（XHR 并发、退避重试、ETag 收集）
  ╰═══════════════════════════════════► OBS uploads 桶（私有）
                                          CORS 允许页面来源的 PUT/GET/POST
                                          并暴露 ETag 响应头
OBS assets 桶（公共读）◄──── 页面内静态 JS/CSS/图片直链
LTS 日志组 ──── 每函数一条日志流
```

- `omu-initialize`：在 OBS 中创建分段上传任务（`POST /{key}?uploads`），返回
  `{fileId, fileKey}`（`fileId` 即 OBS 的 `UploadId`）。
- `omu-get-presigned-urls`：为每个分片签发一条 PUT URL
  （`PUT /{key}?partNumber=N&uploadId=…`，OBS URL 携带签名形态，委托临时凭据，
  有效期经 `url_expires` 变量配置）。
- 浏览器把所有分片并发直传 OBS；文件字节流不经过函数。
- `omu-finalize`：分片按 PartNumber 升序排序，手拼 `CompleteMultipartUpload`
  XML 请求体，在 OBS 中完成合并。
- `omu-index`：渲染页面 HTML，把 API 基址、发布环境名（上传器以 `X-Stage`
  请求头携带）与资产前缀注入 `window.__CONFIG__`。

## API 契约

| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| GET | `/` | – | `text/html` 页面壳 |
| POST | `/api/initialize` | `{"name": "<对象名>"}` | `{"fileId": "<UploadId>", "fileKey": "<对象名>"}` |
| POST | `/api/getPreSignedUrls` | `{"fileId": "…", "fileKey": "…", "parts": <分片数>}` | `{"parts": [{"signedUrl": "…", "PartNumber": 1}, …]}` |
| POST | `/api/finalize` | `{"fileId": "…", "fileKey": "…", "parts": [{"PartNumber": 1, "ETag": "…"}]}` | `200` 空体 |

错误返回非 2xx 状态码与 JSON 体 `{"error": "…", "detail": "…"}`；OBS 拒绝请求时，
其状态码与 XML 错误体在 `detail` 字段中透传。

## 资源清单

| 资源 | 名称 / 说明 |
|---|---|
| `huaweicloud_fgs_function` × 4 | `omu-initialize`、`omu-get-presigned-urls`、`omu-finalize`、`omu-index`；Node.js18.15，128MB / 15s，inline 代码 |
| `huaweicloud_identity_agency` | `omu-obs-access`，信任 `op_svc_cff`，`OBS OperateAccess`（OBS 为全局服务，按全部资源范围授权） |
| `huaweicloud_obs_bucket` `uploads` | 私有、`force_destroy`；浏览器分片 PUT 的 CORS 规则（PUT/GET/POST，暴露 `ETag`）；生命周期：上传对象 10 天过期、未完成分段上传 1 天后自动中止 |
| `huaweicloud_obs_bucket` `assets` + `huaweicloud_obs_bucket_object` | 公共读桶（随机后缀桶名）与前端构建产物对象 |
| `huaweicloud_lts_group` + `huaweicloud_lts_stream` × 4 | 日志组 `omu-logs` + 每函数一条日志流 |
| `huaweicloud_apig_instance` | `omu-instance`（BASIC 版、5M 带宽），仅当两个 `shared_apig_*` 变量均为空时创建；含 VPC / 子网 / 安全组 |
| `huaweicloud_apig_group` / `huaweicloud_apig_environment` | `omu-group`（开启调试子域名）；环境 `prod`（调用须携带 `X-Stage: prod`） |
| `huaweicloud_apig_api` × 4 + `huaweicloud_apig_api_publishment` × 4 | `GET /` → index；`POST /api/initialize` / `POST /api/getPreSignedUrls` / `POST /api/finalize` → 对应函数；均发布到环境 |

## 目录结构

```
├── main.tf / variables.tf / outputs.tf / versions.tf
├── functions/                # 4 个 FunctionGraph 函数源码（inline 上传）
├── frontend/                 # React 18 前端（CRA），上传器位于 src/utils/upload.js
├── scripts/
│   ├── build.py              # 一键构建：CRA 产物 → dist/frontend-build → dist/assets-manifest.json
│   ├── verify_e2e.py         # apply 后端到端验证，写 verification-result.json
│   └── static_check.py       # 全部函数 node --check + 凭据字面量扫描
└── dist/                     # 构建产物（frontend-build/、assets-manifest.json）
```

## 部署

前置条件：

- 华为云账号，具备 APIG、FunctionGraph、OBS、IAM（委托）与网络资源权限；
  凭据经 `HW_ACCESS_KEY` / `HW_SECRET_KEY` 环境变量注入。
- Terraform ≥ 1.5、Python 3.9+（验证脚本依赖 `requests` 包）、Node.js 18+
  （本机构建用）。
- 已有共享 APIG 专享实例与环境（经变量传入 ID），或两者留空由本目录自建实例。
  自建 BASIC 版专享实例以控制台显示信息为准。

步骤：

```bash
# 0. 若 shell 配置了代理，先取消代理，保证 Terraform 直连云
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy

# 1. 构建前端（首次运行自动安装前端依赖；依赖安装需要可访问 npm 仓库）
python scripts/build.py

# 2. 初始化（离线插件缓存，缓存目录须为 registry.terraform.io 层级布局）
terraform init -plugin-dir=../../.terraform-plugin-cache

# 3. 校验
terraform validate

# 4. 预览与部署
#    复用已有共享专享实例而不自建时：
#      export TF_VAR_shared_apig_instance_id=<实例ID>
#      export TF_VAR_shared_apig_env_id=<环境ID>     # Windows 使用 set
terraform apply
```

## 验证

`terraform apply` 成功后：

```bash
python scripts/verify_e2e.py
```

脚本读取 `terraform output`，携带 `X-Stage` 请求头依次验证：

1. `GET /` 返回页面壳（200，HTML 含 `window.__CONFIG__` 与应用根节点），页面内
   静态资产直链可从公共读桶访问；缺少 `X-Stage` 头时路由不可达；
2. 数据面主链路（20MB 随机文件）：`initialize` → `getPreSignedUrls`（断言分片数
   ≥ 3）→ 逐片 PUT 直传预签名 URL → `finalize` → 从私有桶下载合并对象并断言
   MD5 与原文件一致；响应体/响应头符合上表 API 契约；
3. 负例：`finalize` 传错误 ETag 返回非 2xx 且 OBS 错误体透传；分段任务被中止后
   再次分片 PUT 应失败（`NoSuchUpload`）——本样例未开放中止接口，脚本直接调
   OBS 完成中止。

手工验证：浏览器打开 `terraform output page_base_url`，选择分片大小（MB）与并发
数，选择一个大文件后观察进度面板。结果写入 `verification-result.json`。

```bash
curl -k -H "X-Stage: prod" https://<分组调试子域名>/
```

## 清理

```bash
terraform destroy
```

- 两个桶均设置 `force_destroy`，桶内对象随栈一并删除。
- 未完成的分段任务（如上传中途放弃）会占用存储：桶生命周期规则会在任务开始
  1 天后自动中止。如需立即清理，可在控制台 / obsutil 中中止，或按验证脚本的
  方式调用 `DELETE /{key}?uploadId=…`。

## 已知限制

- 页面经分组调试子域名访问；生产场景需自备已完成备案的域名与证书绑定自定义
  域名。
- 浏览器分片 PUT 是跨域请求（页面在 APIG 域、PUT 到桶域名），由桶 CORS 规则
  放行；调试子域名在 apply 时才分配，故 Origin 保留通配——桶本身为私有，任何
  请求仍须持有有效预签名 URL。
- 分片级预签名 URL 按 OBS「URL 中携带签名」接口规范生成，默认 300 秒过期
  （`url_expires` 可调）。若运行期 OBS 拒绝分片级查询串签名 URL（如 HTTP 403），
  备选方案为前端改用 OBS 浏览器 SDK + 后端签发临时凭据，函数 API 契约保持不变。
- OBS 要求除最后一片外每片 ≥ 100KB；上传器保留 5MB 默认分片大小，对重试粒度也
  最稳妥。
- API 未配置鉴权（演示用途）；生产使用请按需配置认证与流控策略。上传对象经
  桶生命周期规则 10 天后过期。
- 样例有意不开放中止接口（浏览器演示不需要）；放弃的上传由上述生命周期规则
  清理。
