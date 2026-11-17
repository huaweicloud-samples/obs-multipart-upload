variable "region" {
  description = "华为云区域"
  type        = string
  default     = "cn-north-4"
}

variable "app_name" {
  description = "应用前缀；所有资源名称均由该前缀派生"
  type        = string
  default     = "omu"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,14}$", var.app_name))
    error_message = "app_name 必须以小写字母开头，仅含小写字母、数字、连字符，长度为 2~15。"
  }
}

variable "shared_apig_instance_id" {
  description = "已有共享 APIG 专享实例 ID；与 shared_apig_env_id 同时为空时本目录自建专享实例"
  type        = string
  default     = ""
}

variable "shared_apig_env_id" {
  description = "已有共享 APIG 环境 ID；需与 shared_apig_instance_id 同时为空或非空"
  type        = string
  default     = ""
}

variable "environment_name" {
  description = "APIG 发布环境名称（仅自建环境时生效）；调用该环境的 API 需携带 X-Stage 请求头"
  type        = string
  default     = "prod"
}

variable "vpc_cidr" {
  description = "自建 APIG 专享实例所在 VPC 网段"
  type        = string
  default     = "192.168.0.0/16"
}

variable "subnet_cidr" {
  description = "自建 APIG 专享实例所在子网网段"
  type        = string
  default     = "192.168.10.0/24"
}

variable "bucket_suffix" {
  description = "OBS 桶名后缀；留空时自动生成随机后缀以保证桶名全局唯一"
  type        = string
  default     = ""

  validation {
    condition     = var.bucket_suffix == "" || can(regex("^[a-z0-9][a-z0-9-]{1,30}$", var.bucket_suffix))
    error_message = "bucket_suffix 仅含小写字母、数字、连字符，长度 2~31，或留空自动生成。"
  }
}

variable "url_expires" {
  description = "预签名分片上传 URL 的有效期（秒），默认 300 秒"
  type        = number
  default     = 300

  validation {
    condition     = var.url_expires > 0 && var.url_expires <= 604800
    error_message = "url_expires 必须为 1~604800 秒。"
  }
}
