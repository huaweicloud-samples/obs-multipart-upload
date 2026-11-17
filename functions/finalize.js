"use strict";

// finalize：完成分段上传（合并分片）。
// APIG 路由 POST /api/finalize，事件体 {fileKey, fileId, parts: [{PartNumber, ETag}]}
// （前端上传各分片时从 OBS 响应头收集 ETag 并去掉引号，这里在 XML 中补回引号）；
// 成功返回 200 空体；OBS 校验失败时把 OBS 的状态码与错误体透传。
// 通过函数委托注入的临时凭据直调 OBS REST API：POST /{key}?uploadId=...（Header 携带 OBS SigV1 签名）。
//
// 注：OBS 要求完成分段上传时分片按 PartNumber 升序提交；前端各分片并发完成顺序不定，
// 这里显式排序后再合并。

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

function xmlEscape(value) {
  const amp = String.fromCharCode(38);
  return String(value)
    .replace(/&/g, amp + "amp;")
    .replace(/</g, amp + "lt;")
    .replace(/>/g, amp + "gt;")
    .replace(/"/g, amp + "quot;")
    .replace(/'/g, amp + "apos;");
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
    if (!fileKey || !fileId) {
      throw httpError(400, "fileKey and fileId are required");
    }
    if (!Array.isArray(body.parts) || body.parts.length === 0) {
      throw httpError(400, "parts must be a non-empty array");
    }

    const parts = body.parts
      .map((part) => {
        const partNumber = Number(part && part.PartNumber);
        const etag = part && typeof part.ETag === "string" ? part.ETag : "";
        return { PartNumber: partNumber, ETag: etag };
      })
      .filter((part) => Number.isInteger(part.PartNumber) && part.PartNumber >= 1 && part.ETag !== "");
    if (parts.length !== body.parts.length) {
      throw httpError(400, "each part must have an integer PartNumber and a non-empty ETag");
    }

    // ordering the parts to make sure they are in the right order
    parts.sort((a, b) => a.PartNumber - b.PartNumber);

    // 手拼 CompleteMultipartUpload XML；ETag 去引号后传输，这里补回引号并对内文做 XML 转义。
    const xml =
      "<CompleteMultipartUpload>" +
      parts
        .map((part) => `<Part><PartNumber>${part.PartNumber}</PartNumber><ETag>"${xmlEscape(part.ETag)}"</ETag></Part>`)
        .join("") +
      "</CompleteMultipartUpload>";

    const creds = agencyCredentials(context);
    const headers = obsSign("POST", fileKey, creds, "application/xml", { uploadId: fileId });
    headers["Content-Type"] = "application/xml";
    headers["Content-Length"] = Buffer.byteLength(xml);
    const resp = await httpsRequest(
      {
        method: "POST",
        host: obsHost(),
        path: `/${encodeObjectKey(fileKey)}?uploadId=${uriEncode(fileId)}`,
        headers,
      },
      xml
    );
    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      throw obsError("POST ?uploadId (complete multipart upload)", resp);
    }

    // 成功返回 200 空体（与前端约定一致）。
    return {
      statusCode: 200,
      headers: { "Access-Control-Allow-Origin": "*" },
      isBase64Encoded: false,
      body: "",
    };
  } catch (error) {
    console.log(`[finalize] error: ${error && error.message}`);
    return errorResponse(error);
  }
};
