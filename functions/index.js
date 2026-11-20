"use strict";

// index：页面函数，APIG 路由 GET / 返回前端 SPA 的 HTML 壳。
// - 构建产物（哈希命名的 js/css）上传到公共读 OBS 桶，页面内以绝对 URL 直链引用；
// - 资产清单由 scripts/build.py 扫描 CRA 产物生成 dist/assets-manifest.json，经 user_data 注入；
// - API 基址、发布环境名（X-Stage）、资产前缀经 user_data 注入，并写入 window.__CONFIG__
//   供前端运行时读取（前端代码不写任何环境相关地址）。

function assetTags(manifest, assetPrefix) {
  const css = (manifest.css || []).map((file) => `<link rel="stylesheet" href="${assetPrefix}/${file}" />`);
  const js = (manifest.js || []).map((file) => `<script defer src="${assetPrefix}/${file}"></script>`);
  const icons = [
    `<link rel="icon" href="${assetPrefix}/favicon.ico" />`,
    `<link rel="apple-touch-icon" href="${assetPrefix}/logo192.png" />`,
    `<link rel="manifest" href="${assetPrefix}/manifest.json" />`,
  ];
  return [...icons, ...css, ...js].join("\n    ");
}

exports.handler = async (event, context) => {
  const apiBase = (process.env.API_BASE_URL || "").replace(/\/$/, "");
  const stage = process.env.APIG_STAGE || "";
  const assetPrefix = (process.env.OBS_ASSET_PREFIX || "").replace(/\/$/, "");
  let manifest = {};
  try {
    manifest = JSON.parse(process.env.ASSET_MANIFEST || "{}");
  } catch (error) {
    manifest = {};
  }
  if (!assetPrefix) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      isBase64Encoded: false,
      body: "OBS asset prefix is not configured",
    };
  }

  // 注入运行时配置；把 "<" 转义避免提前闭合 script 标签。
  const configJson = JSON.stringify({ apiBase, stage, obsAssetPrefix: assetPrefix }).replace(/</g, "\\u003c");

  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#000000" />
    <meta
      name="description"
      content="Browser multipart upload sample on FunctionGraph + APIG + OBS"
    />
    <title>OBS Multipart Upload</title>
    ${assetTags(manifest, assetPrefix)}
  </head>
  <body>
    <noscript>You need to enable JavaScript to run this app.</noscript>
    <div id="root"></div>
    <script>window.__CONFIG__ = ${configJson};</script>
  </body>
</html>`;

  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    isBase64Encoded: false,
    body: html,
  };
};
