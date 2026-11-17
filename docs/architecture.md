# 架构与技术设计

本文说明 OBS 分段上传示例（obs-multipart-upload）的系统架构、数据交互流程与安全控制。
部署指导请见 [deployment-guide.md](deployment-guide.md)，功能概览见仓库根目录 `README.md`。

## 1. 架构总览

```
Browser Client (React SPA)
   │
   ├── (1) 请求初始化分段上传 ──► APIG (专用/共享实例)
   │                                  │
   │                                  ▼
   │                             FunctionGraph (getPreSignedUrls 函数)
   │                                  │ (调用 OBS SDK 初始化分段，获取 UploadId)
   │                                  ▼
   ├── (2) 直传分段数据 ────────► 对象存储服务 OBS (文档存储桶)
   │       (根据预签名 URL 并行 PUT 分段)
   │
   └── (3) 请求合并分段 ────────► FunctionGraph (completeMultipartUpload 函数)
                                      │ (组装 PartETags，通知 OBS 完成合并)
                                      ▼
                                 OBS (生成最终完整对象)
```

## 2. 核心组件与职责

| 组件 | 服务 | 说明 |
|---|---|---|
| 前端托管桶 | OBS | 静态网站托管，存放 React 前端静态资源（HTML/JS/CSS） |
| 业务文件桶 | OBS | 目标存储桶，存放分段上传合成后的大文件对象，开启 CORS 与防盗链安全策略 |
| API 网关 | APIG | 提供对外 API 入口，挂载 4 条 API 路由并转发至对应函数 |
| 预签名函数 | FunctionGraph | `getPreSignedUrls`：生成包含 OBS AK/SK 签名的预签名分段直传 URL |
| 分段合并函数 | FunctionGraph | `completeMultipartUpload`：校验分段校验和并调用 OBS API 完成对象合成 |
| 权限委托 | IAM | 为 FunctionGraph 配置最小权限委托，具备目标 OBS 桶的读写权限 |
