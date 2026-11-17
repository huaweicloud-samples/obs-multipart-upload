output "region" {
  description = "部署区域"
  value       = var.region
}

output "apig_instance_id" {
  description = "APIG 专享实例 ID（共享或本目录创建）"
  value       = local.apig_instance_id
}

output "apig_env_id" {
  description = "APIG 环境 ID（共享或本目录创建）"
  value       = local.apig_env_id
}

output "apig_env_name" {
  description = "APIG 环境名称（调用该环境的 API 需携带 X-Stage 请求头）"
  value       = local.apig_env_name
}

output "page_base_url" {
  description = "页面访问基地址（分组调试子域名）"
  value       = local.page_base_url
}

output "api_base_url" {
  description = "上传 API 基地址（分组调试子域名 /api 前缀，验证脚本用）"
  value       = "${local.page_base_url}/api"
}

output "uploads_bucket" {
  description = "分片上传目标桶名（私有）"
  value       = local.uploads_bucket
}

output "assets_bucket" {
  description = "前端构建产物桶名（公共读）"
  value       = local.assets_bucket
}

output "static_base_url" {
  description = "前端静态资产对象存储访问前缀"
  value       = local.static_base_url
}

output "function_urns" {
  description = "4 个 FunctionGraph 函数的 URN"
  value = {
    initialize         = huaweicloud_fgs_function.initialize.urn
    get_presigned_urls = huaweicloud_fgs_function.get_presigned_urls.urn
    finalize           = huaweicloud_fgs_function.finalize.urn
    index              = huaweicloud_fgs_function.index.urn
  }
}

output "agency_name" {
  description = "函数 OBS 访问委托名"
  value       = huaweicloud_identity_agency.obs.name
}

output "log_group_id" {
  description = "LTS 日志组 ID"
  value       = huaweicloud_lts_group.omu.id
}

output "log_stream_ids" {
  description = "LTS 日志流 ID（按函数）"
  value = {
    initialize         = huaweicloud_lts_stream.initialize.id
    get_presigned_urls = huaweicloud_lts_stream.get_presigned_urls.id
    finalize           = huaweicloud_lts_stream.finalize.id
    index              = huaweicloud_lts_stream.index.id
  }
}
