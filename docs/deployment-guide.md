# 部署与运维指南

本文说明 OBS 分段上传示例（obs-multipart-upload）的前置环境、构建与一键部署流程。
架构设计详见 [architecture.md](architecture.md)。

## 1. 前置准备

- 华为云账号，具备 OBS、FunctionGraph、APIG 及 IAM 权限。
- 本地安装 Terraform ≥ 1.5、Python 3.9+、Node.js 18+。
- 配置认证环境变量：
  ```bash
  export HW_ACCESS_KEY="<your-ak>"
  export HW_SECRET_KEY="<your-sk>"
  export HW_REGION_NAME="cn-north-4"
  ```

## 2. 构建与部署

### 2.1 构建前端静态资产
```bash
python scripts/build.py
```

### 2.2 Terraform 初始化与部署
```bash
cd infra
terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

## 3. 功能验证

执行全链路集成测试：
```bash
python scripts/verify_e2e.py
```

## 4. 资源销毁

```bash
cd infra
terraform destroy -auto-approve
```
