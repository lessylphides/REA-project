// public/ 폴더의 파일을 Worker 안에 넣어 배포하기 위한 생성 스크립트
// (npm run deploy / npm run dev 때 자동 실행)
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { createHash } from "node:crypto";

const ROOT = new URL("../public/", import.meta.url).pathname;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".glb": "model/gltf-binary", ".webp": "image/webp", ".txt": "text/plain; charset=utf-8",
};
const files = {};
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (name === "LICENSE" || name.startsWith(".")) continue;
    const buf = readFileSync(p);
    const type = TYPES[extname(name)] || "application/octet-stream";
    const text = type.startsWith("text/") || type.includes("json") || type.includes("svg");
    files["/" + relative(ROOT, p)] = {
      type,
      etag: '"' + createHash("sha1").update(buf).digest("hex").slice(0, 16) + '"',
      b64: !text,
      body: text ? buf.toString("utf8") : buf.toString("base64"),
    };
  }
};
walk(ROOT);
writeFileSync(
  new URL("../src/assets.generated.ts", import.meta.url),
  "// 자동 생성 파일 (scripts/build-assets.mjs). 직접 수정하지 마세요.\n" +
    "export const ASSETS: Record<string, { type: string; etag: string; b64: boolean; body: string }> = " +
    JSON.stringify(files) + ";\n"
);
console.log(`assets: ${Object.keys(files).length} files`);
