"use strict";

// getPresignedUrls：为每个分片生成 OBS 查询串签名 URL（URL 中携带签名）。
// APIG 路由 POST /api/getPreSignedUrls，事件体 {fileKey, fileId, parts: N}（parts 为分片总数）；
// 返回 200 {parts: [{signedUrl, PartNumber}]}，字段名与前端约定保持一致。
//
// ⚠️ 技术风险点（如实声明）：使用函数委托的临时凭据为“分段上传的 UploadPart 请求”签发
// 查询串签名 URL，本案例按 OBS 官方“URL 中携带签名”文档实现（partNumber/uploadId/
// x-obs-security-token 均为文档列出的子资源，参与 CanonicalizedResource 签名），
// 但该组合未在 OBS 侧实测。若实测被拒（如 403 SignatureDoesNotMatch），备选路径为：
// 前端改用 OBS 浏览器 SDK + 后端签发临时 AK/SK/token，本函数入参出参契约保持不变。

const crypto = require("crypto");

const OBS_REGION = process.env.OBS_REGION || "";
const OBS_BUCKET = process.env.OBS_BUCKET || "";
const URL_EXPIRES = Number(process.env.URL_EXPIRES || 300);

const MAX_PARTS = 10000; // OBS 单对象最大分片数

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

// 参与签名的子资源按字典序拼成 ?a=1&b=2；值为空时只拼名字。
function canonicalResourceSuffix(subresources) {
  const names = Object.keys(subresources).sort();
  if (names.length === 0) {
    return "";
  }
  return "?" + names.map((name) => (subresources[name] === "" ? name : `${name}=${subresources[name]}`)).join("&");
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

// OBS V2 查询串签名（URL 中携带签名），StringToSign 中 Date 位置换成 Expires：
//   METHOD\nContent-MD5(空)\nContent-Type(空)\nExpires\nCanonicalizedHeaders(空)CanonicalizedResource
// 委托临时凭据的 security token 按官方文档以子资源形式加入 CanonicalizedResource 参与签名，
// 并作为查询参数 x-obs-security-token 随 URL 下发（浏览器无法附带自定义请求头，故不签任何头）。
// 注意：Content-MD5/Content-Type 均按空参与签名——前端分片 PUT 必须不携带
// Content-Type 请求头（upload.js 对 file.slice 显式传空 MIME 类型保证这一点）。
function obsQuerySignedUrl(method, key, creds, expires, subresources) {
  const signedSubresources = Object.assign({}, subresources, { "x-obs-security-token": creds.token });
  const canonicalResource = `/${OBS_BUCKET}/${encodeObjectKey(key)}` + canonicalResourceSuffix(signedSubresources);
  const stringToSign = `${method}\n\n\n${expires}\n${canonicalResource}`;
  const signature = crypto.createHmac("sha1", creds.sk).update(stringToSign, "utf8").digest("base64");

  const query = Object.assign({}, subresources, {
    "AccessKeyId": creds.ak,
    "Expires": String(expires),
    "x-obs-security-token": creds.token,
    // 注意：此处放原始 base64 签名，统一由下方 uriEncode 编码一次（避免 %3D 被二次编码成 %253D）。
    "Signature": signature,
  });
  const queryString = Object.keys(query)
    .map((name) => (query[name] === "" ? name : `${name}=${uriEncode(query[name])}`))
    .join("&");
  return `https://${obsHost()}/${encodeObjectKey(key)}?${queryString}`;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
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
    const fileKey = typeof body.fileKey === "string" && body.fileKey.trim() !== "" ? body.fileKey : null;
    const fileId = typeof body.fileId === "string" && body.fileId.trim() !== "" ? body.fileId : null;
    const parts = Number(body.parts);
    if (!fileKey || !fileId) {
      throw httpError(400, "fileKey and fileId are required");
    }
    if (!Number.isInteger(parts) || parts < 1 || parts > MAX_PARTS) {
      throw httpError(400, `parts must be an integer between 1 and ${MAX_PARTS}`);
    }
    if (!Number.isInteger(URL_EXPIRES) || URL_EXPIRES < 1 || URL_EXPIRES > 604800) {
      throw httpError(500, "URL_EXPIRES must be an integer between 1 and 604800 seconds");
    }

    const creds = agencyCredentials(context);
    const expires = Math.floor(Date.now() / 1000) + URL_EXPIRES;

    const signedParts = [];
    for (let partNumber = 1; partNumber <= parts; partNumber++) {
      signedParts.push({
        signedUrl: obsQuerySignedUrl("PUT", fileKey, creds, expires, {
          partNumber: String(partNumber),
          uploadId: fileId,
        }),
        PartNumber: partNumber,
      });
    }

    return jsonResponse(200, { parts: signedParts });
  } catch (error) {
    console.log(`[getPresignedUrls] error: ${error && error.message}`);
    return errorResponse(error);
  }
};
