"use strict";

// initialize：初始化分段上传任务。
// APIG 路由 POST /api/initialize，事件体 {name}；返回 200 {fileId, fileKey}
// （fileId = OBS 的 UploadId，fileKey = 对象名，字段名与前端约定保持一致）。
// 通过函数委托注入的临时凭据直调 OBS REST API：POST /{key}?uploads（Header 携带 OBS SigV1 签名）。

const https = require("https");
const crypto = require("crypto");

const OBS_REGION = process.env.OBS_REGION || "";
const OBS_BUCKET = process.env.OBS_BUCKET || "";

// OBS 签名口径的 URL 编码：仅 a-z A-Z 0-9 . - _ ~ 不转义，其余按 %XX 大写十六进制转义。
function uriEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

// 对象名按“/”分段编码，保留路径分隔符。
function encodeObjectKey(key) {
  return key.split("/").map(uriEncode).join("/");
}

function obsHost() {
  return `${OBS_BUCKET}.obs.${OBS_REGION}.myhuaweicloud.com`;
}

// 参与签名的子资源按字典序拼成 ?a=1&b=2；值为空时只拼名字（如 ?uploads）。
function canonicalResourceSuffix(subresources) {
  const names = Object.keys(subresources).sort();
  if (names.length === 0) {
    return "";
  }
  return "?" + names.map((name) => (subresources[name] === "" ? name : `${name}=${subresources[name]}`)).join("&");
}

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.setTimeout(10000, () => {
      req.destroy(new Error("request timeout"));
    });
    if (body != null) {
      req.write(body);
    }
    req.end();
  });
}

// 函数运行时通过委托拿到临时 AK/SK/security token。
function agencyCredentials(context) {
  const ak = context.getSecurityAccessKey && context.getSecurityAccessKey();
  const sk = context.getSecuritySecretKey && context.getSecuritySecretKey();
  const token = context.getSecurityToken && context.getSecurityToken();
  if (!ak || !sk || !token) {
    throw new Error("agency temporary credentials are unavailable");
  }
  return { ak, sk, token };
}

// OBS SigV1 Header 签名：StringToSign = METHOD\nContent-MD5\nContent-Type\nDate\nCanonicalizedHeaders+CanonicalizedResource。
// 用 x-obs-date 头代替 Date 行，x-obs-security-token 以 CanonicalizedHeaders 参与。
function obsSign(method, key, creds, contentType, subresources) {
  const date = new Date().toUTCString();
  const canonicalHeaders = `x-obs-date:${date}\n` + `x-obs-security-token:${creds.token}\n`;
  const canonicalResource = `/${OBS_BUCKET}/${encodeObjectKey(key)}` + canonicalResourceSuffix(subresources);
  const stringToSign = `${method}\n\n${contentType || ""}\n\n${canonicalHeaders}${canonicalResource}`;
  const signature = crypto.createHmac("sha1", creds.sk).update(stringToSign, "utf8").digest("base64");
  return {
    "x-obs-date": date,
    "x-obs-security-token": creds.token,
    "Authorization": `OBS ${creds.ak}:${signature}`,
  };
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

// OBS 返回 4xx/5xx 时把状态码与响应体透传给调用方，便于前端与验证脚本定位。
function obsError(operation, resp) {
  const error = new Error(`OBS ${operation} failed: HTTP ${resp.statusCode}`);
  error.statusCode = resp.statusCode >= 400 ? resp.statusCode : 500;
  error.obsBody = resp.body;
  return error;
}

// APIG 触发的事件体：body 为 JSON 字符串（isBase64Encoded 时先解码）。
function jsonBody(event) {
  let raw = event && event.body;
  if (raw === undefined || raw === null || raw === "") {
    throw httpError(400, "event.body is not defined");
  }
  if (event.isBase64Encoded) {
    raw = Buffer.from(raw, "base64").toString("utf8");
  }
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw httpError(400, "request body must be a JSON object");
  }
  return parsed;
}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    isBase64Encoded: false,
    body: JSON.stringify(payload),
  };
}

function errorResponse(error) {
  const statusCode = Number.isInteger(error && error.statusCode) && error.statusCode >= 400 ? error.statusCode : 500;
  const payload = { error: String(error && error.message) };
  if (error && error.obsBody) {
    payload.detail = error.obsBody;
  }
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    isBase64Encoded: false,
    body: JSON.stringify(payload),
  };
}

exports.handler = async (event, context) => {
  try {
    const body = jsonBody(event);
    if (typeof body.name !== "string" || body.name.trim() === "") {
      throw httpError(400, "name of the file is required");
    }
    const key = body.name;

    const creds = agencyCredentials(context);
    const headers = obsSign("POST", key, creds, "", { uploads: "" });
    const resp = await httpsRequest({
      method: "POST",
      host: obsHost(),
      path: `/${encodeObjectKey(key)}?uploads`,
      headers,
    });
    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      throw obsError("POST ?uploads", resp);
    }

    // OBS 初始化分段上传返回 XML，这里用简单正则提取 UploadId，避免引入 XML 解析库。
    const uploadId = (resp.body.match(/<UploadId>([^<]+)<\/UploadId>/) || [])[1];
    if (!uploadId) {
      throw httpError(502, "OBS initiate multipart upload response has no UploadId");
    }

    return jsonResponse(200, { fileId: uploadId, fileKey: key });
  } catch (error) {
    console.log(`[initialize] error: ${error && error.message}`);
    return errorResponse(error);
  }
};
