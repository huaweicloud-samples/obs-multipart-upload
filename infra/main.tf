data "huaweicloud_availability_zones" "omu" {}

resource "random_string" "bucket_suffix" {
  length  = 8
  special = false
  upper   = false
}

locals {
  # 共享专享实例/环境切换：两个 shared_apig_* 变量同时为空时，本目录自建专享实例与环境。
  use_shared_apig  = var.shared_apig_instance_id != "" && var.shared_apig_env_id != ""
  apig_instance_id = local.use_shared_apig ? var.shared_apig_instance_id : huaweicloud_apig_instance.omu[0].id

  bucket_suffix   = var.bucket_suffix != "" ? var.bucket_suffix : random_string.bucket_suffix.result
  uploads_bucket  = "${var.app_name}-uploads-${local.bucket_suffix}"
  assets_bucket   = "${var.app_name}-assets-${local.bucket_suffix}"
  static_base_url = "https://${local.assets_bucket}.obs.${var.region}.myhuaweicloud.com"

  # 分组调试子域名在 apply 时由 APIG 分配，页面/API 基址据此拼接（数据源读取在
  # plan 阶段因分组未建而自动推迟到 apply，与已验证先例一致，无需显式 depends_on）。
  page_base_url = "https://${data.huaweicloud_apig_groups.omu.groups[0].sl_domain}"

  api_routes = {
    index = {
      method   = "GET"
      path     = "/"
      function = "index"
    }
    initialize = {
      method   = "POST"
      path     = "/api/initialize"
      function = "initialize"
    }
    getPresignedUrls = {
      method   = "POST"
      path     = "/api/getPreSignedUrls"
      function = "getPresignedUrls"
    }
    finalize = {
      method   = "POST"
      path     = "/api/finalize"
      function = "finalize"
    }
  }

  route_function_urns = {
    index            = trimsuffix(huaweicloud_fgs_function.index.urn, ":latest")
    initialize       = trimsuffix(huaweicloud_fgs_function.initialize.urn, ":latest")
    getPresignedUrls = trimsuffix(huaweicloud_fgs_function.get_presigned_urls.urn, ":latest")
    finalize         = trimsuffix(huaweicloud_fgs_function.finalize.urn, ":latest")
  }

  content_types = {
    js          = "application/javascript"
    css         = "text/css"
    json        = "application/json"
    png         = "image/png"
    ico         = "image/x-icon"
    svg         = "image/svg+xml"
    txt         = "text/plain"
    html        = "text/html"
    webmanifest = "application/manifest+json"
    map         = "application/json"
    woff        = "font/woff"
    woff2       = "font/woff2"
  }

  # 前端构建产物全部上传到公共读资产桶，但排除 CRA 生成的 index.html——
  # 页面壳由 index 函数动态生成（注入 window.__CONFIG__ 与资产直链）。
  static_files = {
    for path in fileset("${path.module}/dist/frontend-build", "**/*") :
    path => path if path != "index.html"
  }

  # APIG 环境：共享实例上同名环境只能有一个，传入 shared_apig_env_id 时复用该环境。
  apig_env_id = local.use_shared_apig ? var.shared_apig_env_id : huaweicloud_apig_environment.omu[0].id
}

# ---------------------------------------------------------------------------
# 网络 + APIG 专享实例（自建形态；shared_apig_* 变量非空时全部 count=0）
# ---------------------------------------------------------------------------

resource "huaweicloud_vpc" "omu" {
  count = local.use_shared_apig ? 0 : 1

  name = "${var.app_name}-network"
  cidr = var.vpc_cidr
}

resource "huaweicloud_vpc_subnet" "omu" {
  count             = local.use_shared_apig ? 0 : 1
  name              = "${var.app_name}-subnet"
  cidr              = var.subnet_cidr
  gateway_ip        = cidrhost(var.subnet_cidr, 1)
  vpc_id            = huaweicloud_vpc.omu[0].id
  availability_zone = data.huaweicloud_availability_zones.omu.names[0]
}

resource "huaweicloud_networking_secgroup" "omu" {
  count                = local.use_shared_apig ? 0 : 1
  name                 = "${var.app_name}-security"
  description          = "Security group for ${var.app_name} APIG"
  delete_default_rules = true
}

resource "huaweicloud_apig_instance" "omu" {
  count             = local.use_shared_apig ? 0 : 1
  name              = "${var.app_name}-instance"
  edition           = "BASIC"
  vpc_id            = huaweicloud_vpc.omu[0].id
  subnet_id         = huaweicloud_vpc_subnet.omu[0].id
  security_group_id = huaweicloud_networking_secgroup.omu[0].id
  bandwidth_size    = 5

  ingress_bandwidth_size          = 5
  ingress_bandwidth_charging_mode = "bandwidth"
  available_zones                 = [data.huaweicloud_availability_zones.omu.names[0]]
}

# ---------------------------------------------------------------------------
# 日志（LTS）：1 个日志组，每个函数独立日志流
# ---------------------------------------------------------------------------

resource "huaweicloud_lts_group" "omu" {
  group_name  = "${var.app_name}-logs"
  ttl_in_days = 7
}

resource "huaweicloud_lts_stream" "initialize" {
  group_id    = huaweicloud_lts_group.omu.id
  stream_name = "${var.app_name}-initialize"
}

resource "huaweicloud_lts_stream" "get_presigned_urls" {
  group_id    = huaweicloud_lts_group.omu.id
  stream_name = "${var.app_name}-get-presigned-urls"
}

resource "huaweicloud_lts_stream" "finalize" {
  group_id    = huaweicloud_lts_group.omu.id
  stream_name = "${var.app_name}-finalize"
}

resource "huaweicloud_lts_stream" "index" {
  group_id    = huaweicloud_lts_group.omu.id
  stream_name = "${var.app_name}-index"
}

# ---------------------------------------------------------------------------
# 函数委托：直调 OBS（初始化/完成分段上传）与签发查询串签名 URL（临时凭据）
# ---------------------------------------------------------------------------

resource "huaweicloud_identity_agency" "obs" {
  name                  = "${var.app_name}-obs-access"
  description           = "Allow the ${var.app_name} functions to operate OBS objects and multipart uploads"
  delegated_domain_name = "op_svc_cff"
  duration              = "FOREVER"

  # OBS 是全局服务，对象操作权限必须按全部资源范围授权（项目级授权运行时 AccessDenied）。
  all_resources_roles = ["OBS OperateAccess"]

  # 服务端会将 delegated_domain_name 读回到 delegated_service_name，
  # 两者表示同一委托主体；忽略该只读归一化，避免刷新后永久差异。
  lifecycle {
    ignore_changes = [delegated_service_name]
  }
}

# ---------------------------------------------------------------------------
# FunctionGraph 函数（4 个，Node.js 18.15，inline 单文件，零 npm 依赖）
# ---------------------------------------------------------------------------

resource "huaweicloud_fgs_function" "initialize" {
  name        = "${var.app_name}-initialize"
  app         = "default"
  handler     = "initialize.handler"
  runtime     = "Node.js18.15"
  memory_size = 128
  timeout     = 15
  code_type   = "inline"
  func_code   = base64encode(file("${path.module}/functions/initialize.js"))
  agency      = huaweicloud_identity_agency.obs.name
  user_data = jsonencode({
    OBS_REGION = var.region
    OBS_BUCKET = local.uploads_bucket
  })
  enable_lts_log = true
  depends_on     = [huaweicloud_identity_agency.obs]

  log_group_id    = huaweicloud_lts_group.omu.id
  log_group_name  = huaweicloud_lts_group.omu.group_name
  log_stream_id   = huaweicloud_lts_stream.initialize.id
  log_stream_name = huaweicloud_lts_stream.initialize.stream_name
}

resource "huaweicloud_fgs_function" "get_presigned_urls" {
  name        = "${var.app_name}-get-presigned-urls"
  app         = "default"
  handler     = "getPresignedUrls.handler"
  runtime     = "Node.js18.15"
  memory_size = 128
  timeout     = 15
  code_type   = "inline"
  func_code   = base64encode(file("${path.module}/functions/getPresignedUrls.js"))
  agency      = huaweicloud_identity_agency.obs.name
  user_data = jsonencode({
    OBS_REGION  = var.region
    OBS_BUCKET  = local.uploads_bucket
    URL_EXPIRES = tostring(var.url_expires)
  })
  enable_lts_log = true
  depends_on     = [huaweicloud_identity_agency.obs]

  log_group_id    = huaweicloud_lts_group.omu.id
  log_group_name  = huaweicloud_lts_group.omu.group_name
  log_stream_id   = huaweicloud_lts_stream.get_presigned_urls.id
  log_stream_name = huaweicloud_lts_stream.get_presigned_urls.stream_name
}

resource "huaweicloud_fgs_function" "finalize" {
  name        = "${var.app_name}-finalize"
  app         = "default"
  handler     = "finalize.handler"
  runtime     = "Node.js18.15"
  memory_size = 128
  timeout     = 15
  code_type   = "inline"
  func_code   = base64encode(file("${path.module}/functions/finalize.js"))
  agency      = huaweicloud_identity_agency.obs.name
  user_data = jsonencode({
    OBS_REGION = var.region
    OBS_BUCKET = local.uploads_bucket
  })
  enable_lts_log = true
  depends_on     = [huaweicloud_identity_agency.obs]

  log_group_id    = huaweicloud_lts_group.omu.id
  log_group_name  = huaweicloud_lts_group.omu.group_name
  log_stream_id   = huaweicloud_lts_stream.finalize.id
  log_stream_name = huaweicloud_lts_stream.finalize.stream_name
}

# 页面函数：GET / 返回 HTML 壳；资产清单（构建产物扫描）与运行时配置经 user_data 注入。
resource "huaweicloud_fgs_function" "index" {
  name        = "${var.app_name}-index"
  app         = "default"
  handler     = "index.handler"
  runtime     = "Node.js18.15"
  memory_size = 128
  timeout     = 15
  code_type   = "inline"
  func_code   = base64encode(file("${path.module}/functions/index.js"))
  user_data = jsonencode({
    API_BASE_URL     = "${local.page_base_url}/api"
    APIG_STAGE       = local.apig_env_name
    OBS_ASSET_PREFIX = local.static_base_url
    ASSET_MANIFEST   = file("${path.module}/dist/assets-manifest.json")
  })
  enable_lts_log = true

  log_group_id    = huaweicloud_lts_group.omu.id
  log_group_name  = huaweicloud_lts_group.omu.group_name
  log_stream_id   = huaweicloud_lts_stream.index.id
  log_stream_name = huaweicloud_lts_stream.index.stream_name
}

# ---------------------------------------------------------------------------
# OBS：uploads 私有桶（分片上传目标，CORS 允许浏览器直连）+ assets 公共读桶（前端产物）
# ---------------------------------------------------------------------------

resource "huaweicloud_obs_bucket" "uploads" {
  bucket        = local.uploads_bucket
  acl           = "private"
  force_destroy = true

  # CORS 规则：允许浏览器跨域直连上传/下载，暴露 ETag 响应头
  # 供前端收集分片校验值。Origin 保留 "*"——分组调试子域名由 APIG 在 apply 时才分配，
  # 无法预先写死，故保留通配；桶为私有，实际访问仍必须持有有效签名。
  cors_rule {
    allowed_origins = ["*"]
    allowed_methods = ["PUT", "GET", "POST"]
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 100
  }

  # 生命周期规则：上传对象 10 天后过期；未完成的分段上传 1 天后自动中止
  # （清理残留分片任务）。
  lifecycle_rule {
    name    = "expire-uploads-and-abort-mpu"
    enabled = true

    expiration {
      days = 10
    }

    abort_incomplete_multipart_upload {
      days = 1
    }
  }
}

resource "huaweicloud_obs_bucket" "assets" {
  bucket = local.assets_bucket
  acl    = "public-read"
}

resource "huaweicloud_obs_bucket_object" "assets" {
  for_each = local.static_files

  bucket       = huaweicloud_obs_bucket.assets.bucket
  key          = each.key
  source       = "${path.module}/dist/frontend-build/${each.key}"
  content_type = lookup(local.content_types, try(reverse(split(".", each.key))[0], ""), "application/octet-stream")
  acl          = "public-read"
}

# ---------------------------------------------------------------------------
# APIG：分组（调试子域名）、环境、API、发布
# ---------------------------------------------------------------------------

resource "huaweicloud_apig_group" "omu" {
  instance_id           = local.apig_instance_id
  name                  = "${var.app_name}-group"
  description           = "OBS multipart upload API group"
  domain_access_enabled = true
}

resource "huaweicloud_apig_environment" "omu" {
  count = local.use_shared_apig ? 0 : 1

  instance_id = local.apig_instance_id
  name        = var.environment_name
  description = "OBS multipart upload validation environment"
}

# 复用共享环境时按 ID 反查环境名（X-Stage 请求头的取值）；不存在的 ID 在 plan 阶段即失败。
data "huaweicloud_apig_environments" "omu" {
  count       = local.use_shared_apig ? 1 : 0
  instance_id = local.apig_instance_id
}

# 分组调试子域名（page_base_url 与 outputs 均取自该数据源）。
data "huaweicloud_apig_groups" "omu" {
  instance_id = local.apig_instance_id
  group_id    = huaweicloud_apig_group.omu.id
}

locals {
  shared_apig_env_matches = [
    for env in flatten(data.huaweicloud_apig_environments.omu[*].environments) :
    env if env.id == var.shared_apig_env_id
  ]
  apig_env_name = local.use_shared_apig ? local.shared_apig_env_matches[0].name : huaweicloud_apig_environment.omu[0].name
}

resource "huaweicloud_apig_api" "omu" {
  for_each = local.api_routes

  instance_id             = local.apig_instance_id
  group_id                = huaweicloud_apig_group.omu.id
  type                    = "Public"
  name                    = "${var.app_name}-${each.key}"
  request_protocol        = "HTTPS"
  request_method          = each.value.method
  request_path            = each.value.path
  security_authentication = "NONE"
  matching                = "Exact"

  func_graph {
    function_urn     = local.route_function_urns[each.value.function]
    version          = "latest"
    network_type     = "V1"
    request_protocol = "HTTPS"
    timeout          = 15000
    invocation_type  = "sync"
  }
}

resource "huaweicloud_apig_api_publishment" "omu" {
  for_each = local.api_routes

  instance_id = local.apig_instance_id
  env_id      = local.apig_env_id
  api_id      = huaweicloud_apig_api.omu[each.key].id
  description = "Published by ${var.app_name}"
}
