import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import LAYOUT from "./layout.js";
// 휴대폰에서 화면이 확대되어 버리지 않게 (손가락 두 개 벌리기·두 번 톡 확대 막기, Safari)
for (const ev of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
document.addEventListener("dblclick", (e) => e.preventDefault(), { passive: false });
{ let lastEnd = 0; document.addEventListener("touchend", (e) => { const now = Date.now(); if (now - lastEnd < 320 && !e.target.closest?.("input, textarea")) e.preventDefault(); lastEnd = now; }, { passive: false }); }

// ───────── 기본 설정 ─────────
const POLL_MS = 5000; // 영업시간 중 빈자리 확인 간격
const IS_ADMIN = location.pathname === "/admin" || decodeURIComponent(location.pathname) === "/관리자";
const COLOR = { empty: "#2fa877", busy: "#ee7a62", outline: "#4a3a31", wood: "#b98a63", woodDark: "#8f6447" };
const $ = (id) => document.getElementById(id);

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

// ───────── 3D 장면 ─────────
const host = $("scene");
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
} catch {
  $("nogl").style.display = "flex";
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 200);
const R = LAYOUT.room;
const center = new THREE.Vector3(R.w / 2, 0.4, R.d / 2);

// 그림체: "toon"(기본, 3단계 음영) | "line"(굵은 검은 선 + 평면 파스텔, 손그림 느낌)
//   layout.js 의 style 또는 주소 뒤 ?style=line 으로 미리보기
const STYLE = new URLSearchParams(location.search).get("style") || LAYOUT.style || "toon";
const LINE = STYLE === "line";
const OL = LINE ? 2.6 : 1; // 외곽선 굵기 배율
document.documentElement.classList.toggle("line", LINE);

/** 손그림 낙서 무늬 (나뭇잎 'c' 선, 풀 짧은 선) */
const doodleCache = new Map();
function doodleTex(color, kind = "leaf") {
  const key = color + kind;
  if (doodleCache.has(key)) return doodleCache.get(key);
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  g.fillStyle = color; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = "#1b1b1f"; g.lineWidth = 7; g.lineCap = "round";
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < (kind === "leaf" ? 14 : 18); i++) {
    const x = rnd() * 256, y = rnd() * 256;
    g.beginPath();
    if (kind === "leaf") g.arc(x, y, 12 + rnd() * 8, Math.PI * (0.9 + rnd() * 0.3), Math.PI * (1.7 + rnd() * 0.3));
    else { g.moveTo(x, y); g.lineTo(x + (rnd() - 0.5) * 8, y - 14 - rnd() * 8); }
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  doodleCache.set(key, t);
  return t;
}
/** 나뭇잎 재질 (line 그림체면 낙서 무늬) */
const leafMat = (color) => (LINE ? toon("#ffffff", { map: doodleTex(color) }) : color);

// 만화 느낌: 3단계 음영(툰 셰이딩) + 외곽선
const gradientMap = (() => {
  const t = new THREE.DataTexture(new Uint8Array([90, 175, 255]), 3, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
})();
const matCache = new Map();
// 시간대(밤) 색 변화를 받을 재질들 — 가게 바깥을 만들 때만 모음. 빛나는 것(조명·창 불빛)은 제외
const tintables = new Set();
let tintSplit = false; // 실내/바깥 재질을 나눴는지
let tintCollect = false;
const registerTint = (m) => {
  if (!tintCollect || !LINE || !m.color) return m;
  if (!m.userData.base) m.userData.base = m.color.clone();
  tintables.add(m);
  return m;
};
const toon = (color, { unique = false, ...extra } = {}) => {
  const key = color + JSON.stringify(extra);
  if (!unique && matCache.has(key)) return registerTint(matCache.get(key));
  const m = LINE ? new THREE.MeshBasicMaterial({ color, ...extra }) : new THREE.MeshToonMaterial({ color, gradientMap, ...extra });
  if (!unique) matCache.set(key, m);
  return registerTint(m);
};
const outlineMat = new THREE.MeshBasicMaterial({ color: LINE ? "#1b1b1f" : COLOR.outline, side: THREE.BackSide });
// 매장 안: 어스름한 실내에 맞춰 가늘고 짙은 갈색 선 (바깥은 그대로)
const outlineMatIn = new THREE.MeshBasicMaterial({ color: "#24170f", side: THREE.BackSide });
/** 실내(roomGroup)와 바깥(fpGroup)이 같은 재질을 쓰면 실내 쪽은 복제해서, 각자 다른 시간대 색을 받게 함 */
function splitInteriorTints() {
  // 각 물체의 실제 위치로 실내/바깥을 나눔 (매장 윤곽 안 + 천장 높이 이하 = 실내). 아주 큰 바닥판 등은 바깥
  const v = new THREE.Vector3(), cls = new Map(); // material -> Set("in"/"out")
  const meshes = [];
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    if (!o.isMesh || !o.material || Array.isArray(o.material) || !tintables.has(o.material)) return;
    o.getWorldPosition(v);
    if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
    const big = (o.geometry.boundingSphere?.radius ?? 0) * Math.max(o.scale.x, o.scale.z) > 12;
    let a = o, outdoor = false;
    while (a) { if (a.userData?.outdoor) { outdoor = true; break; } a = a.parent; }
    const inside = !outdoor && !big && storeSD(v.x, v.z) > -0.08 && v.y < R.wallH + 0.4; // storeSD: 매장 안쪽이 + 
    meshes.push([o, inside]);
    const set = cls.get(o.material) || new Set(); set.add(inside ? "in" : "out"); cls.set(o.material, set);
  });
  const clones = new Map();
  for (const [o, inside] of meshes) {
    const m = o.material, set = cls.get(m);
    if (m.userData.forceOutside) { m.userData.inside = false; continue; }
    if (set.size === 1) { m.userData.inside = inside; continue; }
    if (!inside) { m.userData.inside = false; continue; }
    let c = clones.get(m);
    if (!c) { c = m.clone(); c.userData = { ...m.userData, base: m.userData.base.clone(), inside: true }; tintables.add(c); clones.set(m, c); }
    o.material = c;
  }
  tintSplit = true;
  lastTint = -1;
}
function softenInteriorOutlines(root, f = 0.5) {
  root.traverse((o) => {
    if (o.material !== outlineMat) return;
    o.material = outlineMatIn;
    const u = o.userData;
    if (u.ol) { const [x, y, z, w] = u.ol; o.scale.set((x + w * 2 * f) / (x || 1), (y + w * 2 * f) / (y || 1), (z + w * 2 * f) / (z || 1)); }
    else if (u.rebuild) { o.geometry.dispose(); o.geometry = u.rebuild(f); }
  });
}

/** 메쉬 하나 만들기 (외곽선 포함) */
function mk(geo, mat, pos, parent, { outline = 0.018, shadow = true } = {}) {
  const m = new THREE.Mesh(geo, typeof mat === "string" ? toon(mat) : mat);
  if (pos) m.position.set(pos[0], pos[1], pos[2]);
  m.castShadow = shadow;
  m.receiveShadow = true;
  if (outline) {
    outline *= OL;
    geo.computeBoundingBox();
    const s = new THREE.Vector3();
    geo.boundingBox.getSize(s);
    const o = new THREE.Mesh(geo, outlineMat);
    o.scale.set((s.x + outline * 2) / (s.x || 1), (s.y + outline * 2) / (s.y || 1), (s.z + outline * 2) / (s.z || 1));
    o.userData.ol = [s.x, s.y, s.z, outline];
    o.raycast = () => {};
    m.add(o);
  }
  parent.add(m);
  return m;
}
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt, rb, h, seg = 24) => new THREE.CylinderGeometry(rt, rb, h, seg);

function textSprite(text, { size = 0.32, bg = "rgba(255,255,255,.92)", fg = "#3b2f2a" } = {}) {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d");
  const font = "800 64px 'Pretendard','Apple SD Gothic Neo','Noto Sans KR',sans-serif";
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 56;
  c.width = w; c.height = 100;
  ctx.font = font;
  ctx.fillStyle = bg;
  ctx.beginPath(); ctx.roundRect(4, 4, w - 8, 92, 40); ctx.fill();
  ctx.fillStyle = fg; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(text, w / 2, 54);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
  sp.scale.set(size * (w / 100), size, 1);
  sp.renderOrder = 10;
  return sp;
}

/** 말풍선 (여러 줄) */
function bubbleSprite(text, { fg = "#3b2f2a", bg = "#ffffff", size = 0.13 } = {}) {
  const lines = String(text).split("\n");
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d");
  const font = "700 46px 'Pretendard','Apple SD Gothic Neo','Noto Sans KR',sans-serif";
  ctx.font = font;
  const w = Math.ceil(Math.max(...lines.map((l) => ctx.measureText(l).width))) + 70;
  const lh = 62, h = lines.length * lh + 60 + 26;
  c.width = w; c.height = h;
  ctx.font = font;
  ctx.fillStyle = bg;
  ctx.strokeStyle = "#4a3a31"; ctx.lineWidth = 6;
  ctx.beginPath(); ctx.roundRect(4, 4, w - 8, h - 34, 34); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(w / 2 - 22, h - 33); ctx.lineTo(w / 2, h - 6); ctx.lineTo(w / 2 + 22, h - 33); ctx.fill();
  ctx.beginPath(); ctx.moveTo(w / 2 - 22, h - 31); ctx.lineTo(w / 2, h - 6); ctx.lineTo(w / 2 + 22, h - 31); ctx.stroke();
  ctx.fillStyle = fg; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  lines.forEach((l, i) => ctx.fillText(l, w / 2, 36 + lh / 2 + i * lh));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  const k = size / 62;
  sp.scale.set(w * k, h * k, 1);
  sp.center.set(0.5, 0);
  sp.renderOrder = 20;
  return sp;
}

const heartTex = (() => {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  g.fillStyle = "#ff6f91"; g.strokeStyle = "#ffffff"; g.lineWidth = 8;
  g.beginPath();
  g.moveTo(64, 110);
  g.bezierCurveTo(10, 70, 10, 20, 40, 18);
  g.bezierCurveTo(55, 17, 62, 28, 64, 36);
  g.bezierCurveTo(66, 28, 73, 17, 88, 18);
  g.bezierCurveTo(118, 20, 118, 70, 64, 110);
  g.fill(); g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();

// 잠깐 떠올랐다 사라지는 효과들 (말풍선, 하트, 김)
const effects = [];
function addEffect(obj, parent, life, update) {
  parent.add(obj);
  effects.push({ obj, parent, t: 0, life, update });
}
function popBubble(text, x, y, z, opts) {
  // 같은 자리 말풍선은 하나만
  for (const e of effects) if (e.key === `${x},${z}`) e.t = e.life;
  // 멀리 있어도 읽을 수 있게 거리만큼 키움
  const dist = Math.hypot(camera.position.x - x, camera.position.y - y, camera.position.z - z);
  const sp = bubbleSprite(text, { ...opts, size: 0.093 * Math.max(1, dist / 2.8) * ((opts?.scale ?? 0.5) / 0.5) });
  sp.position.set(x, y, z);
  const base = sp.scale.clone();
  const follow = opts?.follow; // 움직이는 소품(바텐더)을 따라다니는 말풍선
  addEffect(sp, scene, 3.6, (e) => {
    const t = e.t;
    if (follow) sp.position.set(follow.position.x, y, follow.position.z);
    const pop = t < 0.25 ? elastic(t / 0.25) : 1;
    sp.scale.set(base.x * pop, base.y * pop, 1);
    sp.material.opacity = t > e.life - 0.5 ? (e.life - t) / 0.5 : 1;
  });
  effects[effects.length - 1].key = `${x},${z}`;
}
function popHeart(pos) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: heartTex, depthTest: false, transparent: true }));
  sp.renderOrder = 21;
  sp.position.copy(pos);
  const dx = (Math.random() - 0.5) * 0.3;
  addEffect(sp, scene, 1.6, (e) => {
    const t = e.t / e.life;
    sp.position.set(pos.x + dx * t, pos.y + t * 0.7, pos.z);
    const s = 0.22 * (t < 0.2 ? elastic(t / 0.2) : 1);
    sp.scale.set(s, s, 1);
    sp.material.opacity = 1 - Math.max(0, (t - 0.6) / 0.4);
  });
}

// ───────── 조명 ─────────
const hemi = new THREE.HemisphereLight("#fff6ea", "#c9a88a", 1.4);
scene.add(hemi);
const sun = new THREE.DirectionalLight("#fff1dc", 2.2);
sun.position.set(R.w * 0.2, 12, R.d * 1.3);
sun.target.position.copy(center);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0008;
sun.shadow.radius = 4;
const sc = sun.shadow.camera;
sc.left = -R.w; sc.right = R.w; sc.top = R.d * 1.2; sc.bottom = -R.d * 1.2; sc.far = 40;
scene.add(sun, sun.target);

// ───────── 방 (벽/바닥) ─────────
const roomGroup = new THREE.Group();
scene.add(roomGroup);
// 1인칭에서만 보이는 것(앞/오른쪽 높은 벽, 천장)
const fpGroup = new THREE.Group();
fpGroup.visible = false;
scene.add(fpGroup);
// 1인칭 이동 때 부딪히는 물체 (회전된 사각형)
const obstacles = [];
const addObstacle = (x, z, hw, hd, deg = 0) => obstacles.push({ x, z, hw, hd, deg });

function plankTexture() {
  const c = document.createElement("canvas");
  c.width = 512; c.height = 512;
  const ctx = c.getContext("2d");
  ctx.fillStyle = R.floor; ctx.fillRect(0, 0, 512, 512);
  if (LINE) {
    ctx.fillStyle = "#f4d9a6"; ctx.fillRect(0, 0, 512, 512);
    ctx.strokeStyle = "rgba(27,27,31,.75)"; ctx.lineWidth = 3; ctx.lineCap = "round";
    for (let i = 0; i < 8; i++) {
      ctx.beginPath(); ctx.moveTo(0, i * 64); ctx.lineTo(512, i * 64); ctx.stroke();
      const off = (i * 197) % 512;
      ctx.beginPath(); ctx.moveTo(off, i * 64 + 16); ctx.lineTo(off, i * 64 + 48); ctx.stroke();
      ctx.beginPath(); ctx.moveTo((off + 260) % 512, i * 64 + 32); ctx.lineTo((off + 282) % 512, i * 64 + 32); ctx.stroke();
    }
  } else for (let i = 0; i < 8; i++) {
    ctx.fillStyle = i % 2 ? "rgba(255,255,255,.07)" : "rgba(120,70,30,.06)";
    ctx.fillRect(0, i * 64, 512, 64);
    ctx.fillStyle = "rgba(110,70,40,.18)";
    ctx.fillRect(0, i * 64, 512, 2);
    const off = (i * 197) % 512;
    ctx.fillRect(off, i * 64, 2, 64);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(R.w / 4, R.d / 4);
  return t;
}

// ───────── 방 모양 (외곽선 = 꼭짓점 목록, 볼록한 모양) ─────────
const OUTLINE = R.outline || [[0, 0], [R.w, 0], [R.w, R.d], [0, R.d]];
const EDGE_KINDS = R.edges || OUTLINE.map((_, i) => (i === 2 ? "front" : "wall"));
const EDGES = (() => {
  const n = OUTLINE.length;
  let area = 0;
  for (let i = 0; i < n; i++) { const [x1, z1] = OUTLINE[i], [x2, z2] = OUTLINE[(i + 1) % n]; area += x1 * z2 - x2 * z1; }
  const s = area > 0 ? 1 : -1;
  return OUTLINE.map(([ax, az], i) => {
    const [bx, bz] = OUTLINE[(i + 1) % n];
    const len = Math.hypot(bx - ax, bz - az), dx = (bx - ax) / len, dz = (bz - az) / len;
    return { i, ax, az, bx, bz, len, dx, dz, nx: -dz * s, nz: dx * s, kind: EDGE_KINDS[i] || "wall" };
  });
})();
// 정면(가게 앞, z = R.d) 구간
const FRONT = EDGES.find((e) => e.kind === "front") || { ax: R.w, bx: 0 };
const FRONT_X0 = Math.min(FRONT.ax, FRONT.bx), FRONT_X1 = Math.max(FRONT.ax, FRONT.bx);

/** 바닥 판 (외곽선 모양으로 두께 있게) */
function slabGeo(points, depth, y0 = 0) {
  const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, -z)));
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, y0, 0);
  return g;
}
/** 외곽선 메쉬 위치 맞추기 (외곽선이 가운데 기준으로 커지도록) */
function centered(geo) {
  geo.computeBoundingBox();
  const c = new THREE.Vector3();
  geo.boundingBox.getCenter(c);
  geo.translate(-c.x, -c.y, -c.z);
  return [geo, [c.x, c.y, c.z]];
}

function floorTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d");
  g.fillStyle = R.floor; g.fillRect(0, 0, 512, 512);
  if (R.floorStyle === "concrete") {
    // 오래된 에폭시 코팅 시멘트: 얼룩덜룩한 회갈색 + 은은한 광택 + 닳은 자국·끌린 자국·가는 금
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 60; i++) { // 얼룩 (밝고 어두운 구름 무늬)
      const r = 30 + rnd() * 110, x = rnd() * 512, y = rnd() * 512, dark = rnd() < 0.55;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, dark ? `rgba(70,50,40,${0.05 + rnd() * 0.06})` : `rgba(255,240,225,${0.04 + rnd() * 0.05})`); grd.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = grd; g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    for (let i = 0; i < 8; i++) { // 코팅이 닳아 옅어진 곳
      const x = rnd() * 512, y = rnd() * 512;
      g.fillStyle = `rgba(215,205,195,${0.05 + rnd() * 0.05})`;
      g.beginPath(); g.ellipse(x, y, 25 + rnd() * 50, 12 + rnd() * 25, rnd() * 3, 0, Math.PI * 2); g.fill();
    }
    g.lineCap = "round";
    for (let i = 0; i < 40; i++) { // 의자 끌린 자국 (옅은 짧은 선)
      const x = rnd() * 512, y = rnd() * 512, a = rnd() * Math.PI, l = 8 + rnd() * 30;
      g.strokeStyle = rnd() < 0.5 ? "rgba(255,245,235,.12)" : "rgba(60,45,40,.12)"; g.lineWidth = 1 + rnd() * 1.5;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
    }
    for (let i = 0; i < 6; i++) { // 가는 금 (아주 옅게)
      let x = rnd() * 512, y = rnd() * 512;
      g.strokeStyle = "rgba(70,55,50,.22)"; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, y);
      for (let k = 0; k < 6; k++) { x += (rnd() - 0.4) * 30; y += (rnd() - 0.5) * 30; g.lineTo(x, y); }
      g.stroke();
    }
    for (let i = 0; i < 400; i++) { g.fillStyle = `rgba(${rnd() < 0.5 ? "255,255,255" : "40,30,25"},${0.06 + rnd() * 0.08})`; g.fillRect(rnd() * 512, rnd() * 512, 1.5, 1.5); } // 잔 점
    for (let i = 0; i < 5; i++) { // 에폭시 광택 (부드러운 사선 빛)
      const x = rnd() * 512, grd = g.createLinearGradient(x - 60, 0, x + 60, 0);
      grd.addColorStop(0, "rgba(255,255,255,0)"); grd.addColorStop(0.5, "rgba(255,250,240,.05)"); grd.addColorStop(1, "rgba(255,255,255,0)");
      g.save(); g.translate(256, 256); g.rotate(0.6); g.translate(-256, -256); g.fillStyle = grd; g.fillRect(x - 60, -200, 120, 900); g.restore();
    }
  } else {
    const t = plankTexture();
    return t;
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// 블라인드 (가로 살, 틈으로 바깥이 살짝)
const blindsTex = canvasTex(64, 256, (g, w, h) => {
  g.clearRect(0, 0, w, h);
  for (let y = 0; y < h; y += 16) {
    g.fillStyle = "rgba(246,240,236,.8)"; g.fillRect(0, y, w, 11);
    g.fillStyle = LINE ? "rgba(27,27,31,.45)" : "rgba(120,110,110,.4)"; g.fillRect(0, y + 10, w, 1.5);
  }
});
blindsTex.wrapS = blindsTex.wrapT = THREE.RepeatWrapping;
// 블라인드 3단계: 0 반쯤 열림(기본) / 1 거의 닫힘 / 2 완전히 닫힘(바깥 빛 차단)
const blindLevelTex = [blindsTex, ...[[15, 0.92], [16, 1]].map(([slat, a]) => {
  const t = canvasTex(64, 256, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    for (let y = 0; y < h; y += 16) {
      g.fillStyle = `rgba(240,233,228,${a})`; g.fillRect(0, y, w, slat);
      g.fillStyle = LINE ? "rgba(27,27,31,.4)" : "rgba(120,110,110,.4)"; g.fillRect(0, y + 14, w, 1.5);
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
})];
const blindFaces = new Map(); // 면 이름 → { mats: [], level }
function blindFace(key) { if (!blindFaces.has(key)) blindFaces.set(key, { mats: [], level: 0 }); return blindFaces.get(key); }
function setBlindLevel(face, lv) {
  face.level = lv;
  for (const m of face.mats) {
    const rep = m.map.repeat.clone();
    m.map = blindLevelTex[lv].clone(); m.map.repeat.copy(rep); m.map.needsUpdate = true;
    m.userData.blindOpen = [1, 0.35, 0][lv];
    m.needsUpdate = true;
  }
  lastTint = -1; // 시간대 색 다시 칠하기
}
/** 블라인드 조절 줄 (parent 로컬: x = 창 방향, +z = 방 안쪽) — 누를 때마다 3단계 */
function addBlindCord(parent, x, top, face, zIn = 0.14) {
  parent.updateMatrixWorld(true);
  const wp = parent.localToWorld(new THREE.Vector3(x, 0, zIn));
  const g = new THREE.Group(); g.position.copy(wp); g.rotation.y = parent.rotation.y;
  roomGroup.add(g);
  const sw = new THREE.Group(); sw.position.y = top - 0.04; g.add(sw); // 위에 매달려 흔들림
  const len = top - 1.15;
  for (const dx of [-0.012, 0.012]) mk(cyl(0.004, 0.004, len, 5), "#e8e2da", [dx, -len / 2, 0], sw, { outline: 0.002, shadow: false });
  mk(cyl(0.012, 0.016, 0.07, 10), "#d9d2c8", [0, -len - 0.03, 0], sw, { outline: 0.004, shadow: false }); // 손잡이
  g.userData.wiggler = sw;
  const prop = { type: "blindcord", x: wp.x, z: wp.z, say: "블라인드 줄\n당겨 볼까요?" };
  addSayHit(prop, g, [0.16, len + 0.15, 0.16, 1.1 + len / 2], 1.6);
  g.userData.sayPos = [wp.x, wp.z]; g.userData.sayScale = 0.7;
  const info = sayProps[sayProps.length - 1];
  info.onTap = () => {
    const lv = (face.level + 1) % 3;
    setBlindLevel(face, lv);
    prop.say = ["블라인드를 반쯤 열었어요\n바깥 골목이 보여요", "블라인드를 거의 닫았어요\n조금 더 아늑하게", "블라인드를 꼭 닫았어요\n바깥 빛은 이제 그만"][lv];
    if (!store.get("blind-cord")) { store.set("blind-cord", "1"); setTimeout(() => toast("숨은 재미 발견!\n블라인드 줄로 빛을 조절해요", 1700), 900); }
  };
}

function buildRoom() {
  const T = 0.14;
  const H = R.wallH;
  // 바닥
  const ft = floorTexture();
  ft.repeat.set(0.25, 0.25);
  const [fg, fc] = centered(slabGeo(OUTLINE, 0.12, -0.12));
  mk(fg, toon("#ffffff", { unique: true, map: ft }), fc, roomGroup, { outline: 0.04, shadow: false }).receiveShadow = true;

  // 벽: 카메라 쪽 벽은 위에서 볼 때 낮게(인형집처럼), 1인칭에선 천장까지
  const cam = new THREE.Vector2(0.38, 1).normalize();
  for (const e of EDGES) {
    const toward = -e.nx * cam.x + -e.nz * cam.y > 0.05;
    if (e.kind === "front") continue; // 정면은 아래 buildInsideShell 에서
    buildEdge(e, toward ? fpGroup : roomGroup, H, T);
    if (toward) buildEdge(e, roomGroup, 0.35, T);
  }
  // 모서리 기둥
  EDGES.forEach((e, i) => {
    const prev = EDGES[(i - 1 + EDGES.length) % EDGES.length];
    const low = [e, prev].some((x) => -x.nx * cam.x + -x.nz * cam.y > 0.05);
    const ox = -(e.nx + prev.nx) * T / 2, oz = -(e.nz + prev.nz) * T / 2;
    const post = (grp, h) => mk(box(T + 0.02, h, T + 0.02), R.wall, [e.ax + ox, h / 2, e.az + oz], grp, { outline: 0.02, shadow: false });
    if (low) { post(roomGroup, 0.35); post(fpGroup, H); } else post(roomGroup, H);
  });

  // 정면 (가게 앞) 낮은 벽 + 입구 표시
  const low = 0.35;
  const door = LAYOUT.door;
  const fseg = (x0, x1, h, grp) => { if (x1 - x0 > 0.01) mk(box(x1 - x0, h, T), R.wall, [(x0 + x1) / 2, h / 2, R.d + T / 2], grp, { outline: 0.02 }); };
  if (door?.wall === "front") {
    fseg(FRONT_X0 - T / 2, door.x - door.w / 2, low, roomGroup);
    fseg(door.x + door.w / 2, FRONT_X1 + T / 2, low, roomGroup);
    mk(box(door.w * 0.9, 0.02, 0.6), "#7a6152", [door.x, 0.01, R.d - 0.35], roomGroup, { outline: 0 });
    const s = textSprite("입구", { size: 0.3, bg: "rgba(59,47,42,.85)", fg: "#fff" });
    s.position.set(door.x, 0.55, R.d + 0.2);
    roomGroup.add(s);
    labelSprites.push(s);
  } else fseg(FRONT_X0 - T / 2, FRONT_X1 + T / 2, low, roomGroup);
  buildInsideShell(T);
}

const BLIND_BOTTOM = 1.12; // 블라인드는 이 높이 위로만
// 유리 바깥면의 하늘·거리 비침: 낮엔 진해서 안이 잘 안 보이고, 밤엔 거의 없어 안이 또렷이 보임 (바깥에서만 보임)
const glassRefl = [];
const reflTex = canvasTex(128, 256, (c, w, h) => {
  const grd = c.createLinearGradient(0, 0, 0, h);
  grd.addColorStop(0, "#d9e6f2"); grd.addColorStop(0.55, "#c4d2de"); grd.addColorStop(1, "#9aa6ae");
  c.fillStyle = grd; c.fillRect(0, 0, w, h);
  c.fillStyle = "rgba(255,255,255,.22)"; // 칸마다 같은 자리의 은은한 사선 반짝임
  for (const [x0, ww] of [[14, 22], [44, 8]]) { c.beginPath(); c.moveTo(x0, h); c.lineTo(x0 + ww, h); c.lineTo(x0 + ww + 60, 0); c.lineTo(x0 + 60, 0); c.fill(); }
});
function addGlassRefl(parent, w, h, pos, rotY) {
  const mat = new THREE.MeshBasicMaterial({ map: reflTex, transparent: true, opacity: 0, depthWrite: false });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  m.position.set(pos[0], pos[1], pos[2]); m.rotation.y = rotY; m.renderOrder = 4;
  m.raycast = () => {};
  parent.add(m); glassRefl.push(mat);
}
const clearGlass = () => { const m = new THREE.MeshBasicMaterial({ color: "#cfe6f0", transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide }); return m; };
/** 유리 구간 (변 로컬 x, -len/2 = a 쪽). room.pillars: [{ edge, end: "a"|"b", w }] */
function glassSpan(e) {
  let g0 = -e.len / 2, g1 = e.len / 2;
  for (const pl of R.pillars || []) if (pl.edge === e.i) { if (pl.end === "a") g0 += pl.w; else g1 -= pl.w; }
  return [g0, g1];
}
/** 이 면의 안 쓰는 문 (변 로컬 x, 폭) */
function edgeDoor(e) {
  for (const p of LAYOUT.props || []) {
    if (p.type !== "door") continue;
    if (Math.abs((p.x - e.ax) * e.nx + (p.z - e.az) * e.nz) > 0.6) continue;
    return { x: (p.x - e.ax) * e.dx + (p.z - e.az) * e.dz - e.len / 2, w: p.w ?? 1.1 };
  }
  return null;
}
/** 창틀 세로 기둥 위치 (변 로컬 x): 유리 양 끝 + 문 양옆, 나머지는 1.6m 안쪽으로 고르게 */
function mullionXs(e) {
  const [g0, g1] = glassSpan(e), d = edgeDoor(e);
  const cuts = [g0, g1];
  if (d) cuts.push(d.x - d.w / 2, d.x + d.w / 2);
  cuts.sort((a, b) => a - b);
  const xs = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i], b = cuts[i + 1], n = Math.max(1, Math.round((b - a) / 1.6));
    for (let k = 0; k < n; k++) xs.push(a + ((b - a) * k) / n);
  }
  xs.push(cuts[cuts.length - 1]);
  return xs;
}
/** 벽 한 면: wall(막힌 벽) / glass(블라인드 통유리) */
function buildEdge(e, group, h, T) {
  const g = new THREE.Group();
  g.position.set((e.ax + e.bx) / 2 - e.nx * T / 2, 0, (e.az + e.bz) / 2 - e.nz * T / 2);
  g.rotation.y = -Math.atan2(e.dz, e.dx); // 로컬 x = 벽 방향, 로컬 +z = 방 안쪽
  group.add(g);
  const wallBox = (y0, y1) => mk(box(e.len, y1 - y0, T), R.wall, [0, (y0 + y1) / 2, 0], g, { outline: 0.02, shadow: false });
  if (e.kind !== "glass" || h < 1) { wallBox(0, h); return; }
  const sill = 0.12, top = Math.min(h - 0.1, 2.75); // 입구 쪽 창과 같은 높이
  wallBox(0, sill);
  wallBox(top, h);
  // 모서리 기둥 (room.pillars): 유리는 기둥 사이만
  const [g0, g1] = glassSpan(e);
  const gw = g1 - g0, gc = (g0 + g1) / 2;
  for (const [a, b] of [[-e.len / 2, g0], [g1, e.len / 2]]) if (b - a > 0.01) mk(box(b - a, top - sill, T), R.wall, [(a + b) / 2, (top + sill) / 2, 0], g, { outline: 0.02, shadow: false });
  // 블라인드: 장 높이 위쪽에만 (아래는 맑은 유리 → 밖에서 장이 비쳐 보임)
  const bl0 = BLIND_BOTTOM;
  const t = blindsTex.clone();
  t.needsUpdate = true;
  t.repeat.set(gw / 0.5, (top - bl0) / 1.1);
  const mat = new THREE.MeshBasicMaterial({ map: t, color: "#fff6f2", transparent: true, side: THREE.DoubleSide, depthWrite: false });
  registerTint(mat);
  mat.userData.forceOutside = true; // 세 면 모두 바깥 하늘빛 기준 (낮엔 햇빛 받아 밝게)
  mk(new THREE.PlaneGeometry(gw, top - bl0), mat, [gc, (top + bl0) / 2, 0], g, { outline: 0, shadow: false });
  { const face = blindFace("edge" + e.i); face.mats.push(mat); addBlindCord(g, g1 - 0.3, top, face); } // 조절 줄 (면 한쪽 끝)
  mk(new THREE.PlaneGeometry(gw, bl0 - sill), clearGlass(), [gc, (bl0 + sill) / 2, 0], g, { outline: 0, shadow: false });
  { // 창틀로 나뉜 칸마다 같은 비침 (키 큰 창이 어느 묶음에 있든) (바깥쪽 -z 를 향함)
    const xs = mullionXs(e);
    for (let i = 0; i < xs.length - 1; i++) {
      const a = xs[i] + 0.03, b = xs[i + 1] - 0.03;
      if (b - a > 0.1) addGlassRefl(g, b - a, top - sill - 0.05, [(a + b) / 2, (top + sill) / 2, -T / 2 - 0.006], Math.PI);
    }
  }
  // 흰 창틀
  const white = "#f4f1ec";
  for (const mx of mullionXs(e)) mk(box(0.06, top - sill, T * 0.8), white, [mx, (top + sill) / 2, 0], g, { outline: 0.01, shadow: false });
  mk(box(gw, 0.05, T * 0.9), white, [gc, top - 0.02, 0], g, { outline: 0.01, shadow: false });
  mk(box(gw, 0.05, T * 0.9), white, [gc, sill + 0.02, 0], g, { outline: 0.01, shadow: false });
  // 햇살 줄무늬 (방 안쪽 바닥)
  if (group === roomGroup || !sunPatches.some((m) => m.userData.edge === e.i)) {
    addSunPatch(g, e.len * 0.95, 2.6, 0, T / 2);
    sunPatches[sunPatches.length - 1].userData.edge = e.i;
  }
  // 창밖 거리 (1인칭에서만, 블라인드 틈으로 보임)
  if (R.outside?.[e.i] === "alley") ALLEY = buildAlley3D(e); // 창에서 길게 뻗은 3D 골목
  // (그 밖의 창밖은 buildStreets3D 의 3D 골목)
}

// ───────── 창밖 거리 풍경 (블라인드 틈으로 은은하게) ─────────
const streetViews = []; // { ctx, tex, seed }
let streetPhase = "";
// 주택가 공통 색
function resiColors(phase) {
  const night = phase === "night", dusk = phase === "dusk";
  return {
    night, dusk,
    walls: night ? ["#3b2a31", "#2f2c3e", "#3e3236", "#2c3242", "#3a3330"] : dusk ? ["#a0614e", "#8a7488", "#b07a5e", "#7a7d96", "#a88a70"] : ["#c46a4f", "#e6dccb", "#b9c3cf", "#d8a27a", "#cfc2a8"],
    roof: night ? "#24222c" : dusk ? "#5e4552" : "#6f5a52",
    win: () => null,
    fence: night ? "#3a2d2c" : dusk ? "#8a5a48" : "#b56a4d",
    ground: night ? "#3b3940" : dusk ? "#7a6f78" : "#c9c1b6",
    winOff: night ? "#1d2138" : dusk ? "#5f5a80" : "#bfe0f2",
  };
}
function lampGlow(g, x, y, r, night) {
  const glow = g.createRadialGradient(x, y, 1, x, y, r);
  glow.addColorStop(0, night ? "rgba(255,226,160,.9)" : "rgba(255,220,160,.55)"); glow.addColorStop(1, "rgba(255,220,150,0)");
  g.fillStyle = glow; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
}

/** 주택가 골목 (창과 나란히 지나가는 골목): 낮은 주택·빌라, 담장, 전봇대·전깃줄, 작은 가로등 */
function drawStreet(g, W, H, phase, seed) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const C = resiColors(phase), ink = "#1b1b1f";
  const sky = g.createLinearGradient(0, 0, 0, H * 0.7);
  if (C.night) { sky.addColorStop(0, "#121833"); sky.addColorStop(1, "#2b2f55"); }
  else if (C.dusk) { sky.addColorStop(0, "#8f7fd0"); sky.addColorStop(0.6, "#f39fb0"); sky.addColorStop(1, "#ffb36b"); }
  else { sky.addColorStop(0, "#bfe0f6"); sky.addColorStop(1, "#f2eef6"); }
  g.fillStyle = sky; g.fillRect(0, 0, W, H);
  const groundY = H * 0.8;
  drawSun(g, W * 0.7, groundY - H * (C.dusk ? 0.25 : 0.62), H, phase);
  g.lineJoin = "round";
  // 낮은 주택 / 빌라 (2~3층)
  let x = -30;
  while (x < W) {
    const w = 150 + rnd() * 130, floors = 2 + (rnd() < 0.4 ? 1 : 0), h = floors * 62 + 20, y = groundY - 40 - h;
    g.fillStyle = C.walls[Math.floor(rnd() * C.walls.length)]; g.strokeStyle = ink; g.lineWidth = 5;
    g.fillRect(x, y, w, h + 40); g.strokeRect(x, y, w, h + 40);
    if (rnd() < 0.55) { // 경사 지붕
      g.fillStyle = C.roof; g.beginPath(); g.moveTo(x - 10, y); g.lineTo(x + w / 2, y - 38 - rnd() * 20); g.lineTo(x + w + 10, y); g.closePath(); g.fill(); g.stroke();
    } else { g.fillStyle = C.roof; g.fillRect(x - 6, y - 10, w + 12, 12); g.strokeRect(x - 6, y - 10, w + 12, 12); }
    for (let f = 0; f < floors; f++) {
      const wy = y + 18 + f * 62;
      for (let wx = x + 20; wx < x + w - 40; wx += 56) {
        const lit = C.night ? rnd() < 0.5 : C.dusk ? rnd() < 0.3 : false;
        g.fillStyle = lit ? "#f3c27a" : C.winOff; g.lineWidth = 3;
        g.fillRect(wx, wy, 30, 30); g.strokeRect(wx, wy, 30, 30);
        g.beginPath(); g.moveTo(wx + 15, wy); g.lineTo(wx + 15, wy + 30); g.stroke();
      }
      if (f > 0 && rnd() < 0.4) { g.lineWidth = 3; g.strokeRect(x + 14, wy + 34, Math.min(110, w - 28), 14); } // 베란다 난간
    }
    x += w + 4 + rnd() * 14;
  }
  // 담장 (벽돌) + 대문
  g.fillStyle = C.fence; g.strokeStyle = ink; g.lineWidth = 4;
  g.fillRect(0, groundY - 46, W, 46); g.strokeRect(-5, groundY - 46, W + 10, 46);
  g.lineWidth = 2;
  for (let bx = 0; bx < W; bx += 34) { g.beginPath(); g.moveTo(bx, groundY - 46); g.lineTo(bx, groundY); g.stroke(); }
  g.beginPath(); g.moveTo(0, groundY - 23); g.lineTo(W, groundY - 23); g.stroke();
  for (let i = 0; i < 2; i++) { const gx = W * (0.2 + i * 0.45 + rnd() * 0.1); g.fillStyle = C.night ? "#2a2a30" : "#5d6b72"; g.fillRect(gx, groundY - 60, 54, 60); g.lineWidth = 4; g.strokeRect(gx, groundY - 60, 54, 60); }
  // 화분
  for (let i = 0; i < 4; i++) {
    const px = W * rnd();
    g.fillStyle = "#b8714f"; g.lineWidth = 3; g.fillRect(px, groundY - 18, 22, 18); g.strokeRect(px, groundY - 18, 22, 18);
    g.fillStyle = C.night ? "#2f4a36" : "#6fa858"; g.beginPath(); g.arc(px + 11, groundY - 26, 14, 0, Math.PI * 2); g.fill(); g.stroke();
  }
  // 골목길 (좁은 콘크리트)
  g.fillStyle = C.ground; g.fillRect(0, groundY, W, H - groundY);
  g.strokeStyle = ink; g.lineWidth = 4; g.beginPath(); g.moveTo(0, groundY); g.lineTo(W, groundY); g.stroke();
  g.strokeStyle = "rgba(27,27,31,.35)"; g.lineWidth = 2;
  for (let i = 0; i < 6; i++) { const cx = W * rnd(), cy = groundY + 10 + (H - groundY - 20) * rnd(); g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + 30, cy + 4); g.stroke(); }
  // 전봇대 + 전깃줄 + 작은 가로등
  const poles = [W * (0.12 + rnd() * 0.08), W * (0.55 + rnd() * 0.1), W * 1.02];
  g.strokeStyle = ink;
  for (const px of poles) {
    g.fillStyle = C.night ? "#4a4648" : "#9c958c"; g.lineWidth = 4;
    g.fillRect(px - 7, H * 0.06, 14, groundY - H * 0.06); g.strokeRect(px - 7, H * 0.06, 14, groundY - H * 0.06);
    g.fillRect(px - 26, H * 0.1, 52, 6); g.strokeRect(px - 26, H * 0.1, 52, 6);
    const ly = groundY - H * 0.42;
    g.lineWidth = 4; g.beginPath(); g.moveTo(px, ly); g.lineTo(px + 30, ly - 6); g.stroke();
    if (C.night || C.dusk) lampGlow(g, px + 32, ly, 110, C.night);
    g.fillStyle = C.night || C.dusk ? "#fff2c0" : "#e9e4d8"; g.beginPath(); g.ellipse(px + 32, ly + 2, 10, 6, 0, 0, Math.PI * 2); g.fill(); g.lineWidth = 3; g.stroke();
  }
  g.lineWidth = 2;
  for (let k = 0; k < 3; k++) {
    g.beginPath();
    for (let i = 0; i < poles.length - 1; i++) {
      const a = poles[i] - 20 + k * 20, b = poles[i + 1] - 20 + k * 20, y0 = H * 0.11;
      g.moveTo(a, y0); g.quadraticCurveTo((a + b) / 2, y0 + 30 + k * 6, b, y0);
    }
    g.stroke();
  }
  if (C.night) { g.fillStyle = "rgba(120,110,160,.12)"; g.fillRect(0, 0, W, H); }
}

/** 하늘의 해 (낮: 작고 밝게 / 노을: 크고 주황, 번짐) */
function drawSun(g, x, y, H, phase) {
  if (phase === "night") return;
  const dusk = phase === "dusk", r = dusk ? H * 0.11 : H * 0.06;
  const glow = g.createRadialGradient(x, y, r * 0.5, x, y, r * (dusk ? 5 : 3));
  glow.addColorStop(0, dusk ? "rgba(255,170,90,.75)" : "rgba(255,250,220,.7)"); glow.addColorStop(1, "rgba(255,200,150,0)");
  g.fillStyle = glow; g.beginPath(); g.arc(x, y, r * (dusk ? 5 : 3), 0, Math.PI * 2); g.fill();
  g.fillStyle = dusk ? "#ff9548" : "#fff6c8"; g.strokeStyle = "#1b1b1f"; g.lineWidth = 5;
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); g.stroke();
}

/** 삼거리 골목: 창에서 똑바로 뻗어 나가는 좁은 주택가 골목 (원근감) */
function drawAlley(g, W, H, phase, seed) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const C = resiColors(phase), ink = "#1b1b1f";
  const sky = g.createLinearGradient(0, 0, 0, H * 0.5);
  if (C.night) { sky.addColorStop(0, "#121833"); sky.addColorStop(1, "#2b2f55"); }
  else if (C.dusk) { sky.addColorStop(0, "#8f7fd0"); sky.addColorStop(0.6, "#f39fb0"); sky.addColorStop(1, "#ffb36b"); }
  else { sky.addColorStop(0, "#bfe0f6"); sky.addColorStop(1, "#f2eef6"); }
  g.fillStyle = sky; g.fillRect(0, 0, W, H);
  const vx = W * 0.5, vy = H * 0.5; // 소실점
  drawSun(g, vx + 60, vy - H * (C.dusk ? 0.06 : 0.32), H, phase);
  const poly = (pts, fill, lw = 4) => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fillStyle = fill; g.fill(); if (lw) { g.strokeStyle = ink; g.lineWidth = lw; g.stroke(); } };
  const lerp = (a, b, t) => a + (b - a) * t;
  const edgeL = (t) => lerp(W * 0.2, vx - 18, t), edgeR = (t) => lerp(W * 0.8, vx + 18, t), ground = (t) => lerp(H, vy, t);
  // 양옆 낮은 주택 + 담장
  for (const side of [-1, 1]) {
    let t0 = 0;
    while (t0 < 0.93) {
      const t1 = Math.min(0.96, t0 + 0.14 + rnd() * 0.16);
      const xa = side < 0 ? lerp(-60, edgeL(t0) - 20, 1) : lerp(W + 60, edgeR(t0) + 20, 1);
      const xA = side < 0 ? edgeL(t0) - lerp(260, 8, t0) : edgeR(t0) + lerp(260, 8, t0);
      const xB = side < 0 ? edgeL(t1) - lerp(260, 8, t1) : edgeR(t1) + lerp(260, 8, t1);
      const sc0 = 1 - t0, sc1 = 1 - t1, hh = 150 + rnd() * 90;
      const bA = ground(t0) - 40 * sc0, bB = ground(t1) - 40 * sc1;
      const tA = bA - hh * sc0, tB = bB - hh * sc1;
      poly([[xA, bA], [xB, bB], [xB, tB], [xA, tA]], C.walls[Math.floor(rnd() * C.walls.length)], 3);
      // 지붕 처마
      poly([[xA, tA], [xB, tB], [xB, tB - 10 * sc1], [xA, tA - 14 * sc0]], C.roof, 3);
      for (let r = 0.25; r < 0.85; r += 0.35) for (let c = 0.2; c < 0.85; c += 0.35) {
        const lit = C.night ? rnd() < 0.5 : C.dusk ? rnd() < 0.3 : false;
        const x = lerp(xA, xB, c), y = lerp(lerp(bA, tA, r), lerp(bB, tB, r), c), sz = lerp(sc0, sc1, c) * 22;
        g.fillStyle = lit ? "#f3c27a" : C.winOff; g.fillRect(x - sz / 2, y - sz / 2, sz, sz);
      }
      // 담장 (길 가장자리)
      const fA = side < 0 ? edgeL(t0) : edgeR(t0), fB = side < 0 ? edgeL(t1) : edgeR(t1);
      poly([[fA, ground(t0)], [fB, ground(t1)], [fB, ground(t1) - 44 * sc1], [fA, ground(t0) - 44 * sc0]], C.fence, 3);
      poly([[fA, ground(t0)], [xA, bA + 40 * sc0], [xB, bB + 40 * sc1], [fB, ground(t1)]], C.ground, 0);
      t0 = t1;
      void xa;
    }
  }
  // 좁은 골목길
  poly([[edgeL(0), H], [edgeR(0), H], [edgeR(1), vy], [edgeL(1), vy]], C.ground, 4);
  g.strokeStyle = "rgba(27,27,31,.3)"; g.lineWidth = 2;
  for (const t of [0.15, 0.35, 0.55, 0.72]) { g.beginPath(); g.moveTo(edgeL(t), ground(t)); g.lineTo(edgeR(t), ground(t)); g.stroke(); }
  g.fillStyle = C.night ? "#2a2a30" : "#7b7a80"; g.beginPath(); g.ellipse(vx + 30, ground(0.25), 34, 9, 0, 0, Math.PI * 2); g.fill(); g.lineWidth = 2; g.strokeStyle = ink; g.stroke(); // 맨홀
  // 전봇대 + 전깃줄 (멀어질수록 작게) + 가로등
  const poles = [0.08, 0.38, 0.62, 0.8].map((t) => ({ t, x: edgeR(t) + 6 * (1 - t), yb: ground(t), h: lerp(H * 0.95, 60, t) }));
  for (const p of poles) {
    g.fillStyle = C.night ? "#4a4648" : "#9c958c"; g.strokeStyle = ink; g.lineWidth = lerp(4, 1.5, p.t);
    const w = lerp(14, 3, p.t);
    g.fillRect(p.x - w / 2, p.yb - p.h, w, p.h); g.strokeRect(p.x - w / 2, p.yb - p.h, w, p.h);
    const ly = p.yb - p.h * 0.55;
    if (C.night || C.dusk) lampGlow(g, p.x - p.h * 0.08, ly, lerp(120, 30, p.t), C.night);
    g.fillStyle = C.night || C.dusk ? "#fff2c0" : "#e9e4d8"; g.beginPath(); g.arc(p.x - p.h * 0.08, ly, lerp(8, 2, p.t), 0, Math.PI * 2); g.fill();
  }
  g.strokeStyle = ink; g.lineWidth = 2;
  for (let k = 0; k < 3; k++) {
    g.beginPath(); g.moveTo(W * 0.95, H * 0.02 + k * 10);
    for (const p of poles.slice(1)) g.quadraticCurveTo(p.x + 40, p.yb - p.h + 30, p.x, p.yb - p.h + k * 4 * (1 - p.t));
    g.stroke();
  }
  // 화분 몇 개
  for (const [t, sd] of [[0.2, -1], [0.45, 1], [0.6, -1]]) {
    const px = (sd < 0 ? edgeL(t) + 10 : edgeR(t) - 20) , py = ground(t), k = 1 - t;
    g.fillStyle = "#b8714f"; g.strokeStyle = ink; g.lineWidth = 2; g.fillRect(px, py - 16 * k, 16 * k, 16 * k); g.strokeRect(px, py - 16 * k, 16 * k, 16 * k);
    g.fillStyle = C.night ? "#2f4a36" : "#6fa858"; g.beginPath(); g.arc(px + 8 * k, py - 22 * k, 11 * k, 0, Math.PI * 2); g.fill(); g.stroke();
  }
  if (C.night) { g.fillStyle = "rgba(120,110,160,.14)"; g.fillRect(0, 0, W, H); }
}

// ───────── 대각선 창 밖으로 길게 뻗은 3D 주택가 골목 (사람이 저 끝에서 걸어옴) ─────────
const alleyWindows = []; // 밤에 켜지는 창문
function buildAlley3D(e) {
  const nx = -e.nx, nz = -e.nz; // 바깥 방향
  const mx = (e.ax + e.bx) / 2, mz = (e.az + e.bz) / 2;
  const L0 = 3.2, L1 = 27, W = ALLEY_W; // 골목: 창에서 3.2m(삼거리) ~ 27m
  const g = new THREE.Group();
  g.position.set(mx + nx * L0, 0, mz + nz * L0);
  g.rotation.y = Math.atan2(nx, nz); // 로컬 +z = 골목 안쪽(멀어지는 방향)
  fpGroup.add(g);
  const len = L1 - L0;
  let s = 41;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const no = { outline: 0, shadow: false }, ol = { outline: 0.02, shadow: false };
  // 바닥 (콘크리트) + 가운데 이음 선
  // (바닥은 주변 아스팔트 한 가지 색)
  // 걸을 수 있는 구역을 먼저 정하고(건물이 길 위에 서지 않게), 양옆에 옆면이 붙은 주택 줄
  setupOutdoorAreas({ mx, mz, nx, nz });
  const px = nz, pz = -nx; // 골목 로컬 +x 방향
  const O = [mx + nx * L0, mz + nz * L0];
  for (const sd of [-1, 1]) {
    const a = [O[0] + px * sd * W / 2, O[1] + pz * sd * W / 2], b = [a[0] + nx * len, a[1] + nz * len];
    buildHouseRow(a, b, [-px * sd, -pz * sd], 41 + (sd + 1) * 7, { poles: false });
  }
  // 전봇대 + 작은 가로등 (한쪽), 전깃줄
  const poles = [];
  for (let z = 4; z < len; z += 7) {
    const x = W / 2 - 0.2; // 담장 바로 앞
    const wx = mx + nx * (L0 + z) + nz * x, wz = mz + nz * (L0 + z) - nx * x;
    if (outdoorAreas.slice(0, 2).some((a) => inArea(a, wx, wz))) continue; // 가게 앞·왼쪽 골목 위에는 세우지 않음
    addObstacle(wx, wz, 0.13, 0.13);
    mk(cyl(0.1, 0.12, 7, 8), "#9c958c", [x, 3.4, z], g, ol);
    mk(box(1.0, 0.1, 0.1), "#9c958c", [x, 6.6, z], g, ol);
    mk(box(0.5, 0.06, 0.06), "#2a2522", [x - 0.25, 3.6, z], g, no);
    const lamp = mk(new THREE.SphereGeometry(0.1, 8, 6), new THREE.MeshBasicMaterial({ color: "#fff2c0" }), [x - 0.5, 3.55, z], g, no);
    addHalo(g, x - 0.5, 3.5, z, 3.0, "#ffe0a0");
    poles.push(new THREE.Vector3(x, 6.6, z));
    void lamp;
  }
  for (let k = -1; k <= 1; k++) {
    const pts = [];
    for (let i = 0; i < poles.length - 1; i++) for (let t = 0; t <= 1; t += 0.1) {
      const a = poles[i], b = poles[i + 1];
      pts.push(new THREE.Vector3(a.x + k * 0.4, a.y - Math.sin(t * Math.PI) * 0.5, a.z + (b.z - a.z) * t));
    }
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: "#1b1b1f" })));
  }
  // 화분 몇 개
  for (let i = 0; i < 5; i++) { const side = rnd() < 0.5 ? -1 : 1; makePlant(g, side * (W / 2 - 0.3), 4 + rnd() * (len - 6), 0.7); }
  // 골목 맨 끝: 마주 보이는 주택가 (그림)
  const far = L1 + 0.5;
  { // 그림 대신 실제 3D 주택 줄 (하늘과 끊기지 않게)
    const cx = mx + nx * far, cz = mz + nz * far, px = nz, pz = -nx;
    buildHouseRow([cx - px * 10, cz - pz * 10], [cx + px * 10, cz + pz * 10], [-nx, -nz], 17 + e.i * 31, { poles: false });
  }
  return { mx, mz, nx, nz, L0, L1 };
}

// ───────── 바깥 골목 3D (가게 앞 골목 · 왼쪽 골목) + 걸어 다닐 수 있는 구역 ─────────
const FRONT_ACROSS = 6.2; // 가게 앞 골목 폭 (건너편 담장까지)
/** a→b 를 따라 늘어선 주택 줄. f = 집 앞면이 바라보는 방향(골목 쪽) */
function buildHouseRow(a, b, f, seed, opt = {}) {
  let ux = b[0] - a[0], uz = b[1] - a[1];
  const L = Math.hypot(ux, uz); ux /= L; uz /= L;
  if (-uz * f[0] + ux * f[1] < 0) return buildHouseRow(b, a, f, seed, opt); // 로컬 +z 가 골목 쪽이 되도록
  const g = new THREE.Group();
  g.position.set(a[0], 0, a[1]);
  g.rotation.y = Math.atan2(-uz, ux);
  fpGroup.add(g);
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const ol = { outline: 0.02, shadow: false }, no = { outline: 0, shadow: false };
  const walls = ["#c46a4f", "#e6dccb", "#b9c3cf", "#d8a27a", "#cfc2a8", "#a8b4a0", "#9a5a46"];
  const fx = -uz, fz = ux; // 로컬 +z (골목 쪽)
  const W2 = (lx, lz) => [a[0] + ux * lx + fx * lz, a[1] + uz * lx + fz * lz];
  const blocked = (pts) => pts.some(([lx, lz]) => { const [x, z] = W2(lx, lz); return inOutdoor(x, z, 0) || storeSD(x, z) > -0.3; });
  const DEP = opt.depth ?? 6, SET = 0.4; // 모든 집 같은 깊이, 골목에서 같은 거리 (앞면이 한 줄)
  let x = 0;
  while (x < L - 0.5) {
    const wid = Math.min(L - x, 4 + rnd() * 3), floors = 2 + (rnd() < 0.45 ? 1 : 0), h = floors * 2.7 + 0.4;
    const cz = -SET - DEP / 2, color = walls[Math.floor(rnd() * walls.length)];
    // 0.25m 조각으로 나눠 길 위에 걸치지 않는 구간만 세움 (모퉁이까지 건물이 이어짐)
    const STEP = 0.25, runs = [];
    let r0 = null;
    for (let sx = x; sx < x + wid - 1e-6; sx += STEP) {
      const s1 = Math.min(x + wid, sx + STEP);
      const free = !blocked([[sx + 0.02, -SET - 0.02], [s1 - 0.02, -SET - 0.02], [sx + 0.02, -SET - DEP + 0.02], [s1 - 0.02, -SET - DEP + 0.02], [(sx + s1) / 2, cz]]);
      if (free && r0 == null) r0 = sx;
      if (!free && r0 != null) { runs.push([r0, sx]); r0 = null; }
    }
    if (r0 != null) runs.push([r0, x + wid]);
    for (const [q0, q1] of runs) {
      if (q1 - q0 < 0.6) continue;
      const qc = (q0 + q1) / 2, qw = q1 - q0;
      mk(box(qw, h, DEP), color, [qc, h / 2 - 0.1, cz], g, ol);                    // 옆집과 틈 없이 붙음
      mk(box(qw, 0.35, DEP), "#6f5a52", [qc, h + 0.07, cz], g, ol);              // 평지붕 난간
      mk(box(qw, 0.12, 0.25), "#e9e4d8", [qc, 2.65, -SET + 0.1], g, no);         // 1층 위 처마 띠
      for (let fl = 0; fl < floors; fl++) for (let k = 0; k < Math.floor((qw - 0.4) / 1.5); k++) { // 골목 쪽 창문 (밤엔 일부 은은한 호박색)
        const wx = q0 + 0.9 + k * 1.5, wy = 1.5 + fl * 2.7;
        const wm = new THREE.MeshBasicMaterial({ color: "#2b3150" });
        registerTint(wm);
        mk(new THREE.PlaneGeometry(0.75, 0.85), wm, [wx, wy, -SET + 0.01], g, no);
        mk(box(0.85, 0.06, 0.06), "#f2efe8", [wx, wy - 0.47, -SET + 0.03], g, no);
        if (rnd() < 0.4) { const lit = new THREE.MeshBasicMaterial({ color: "#d89a52", transparent: true, opacity: 0, depthWrite: false }); mk(new THREE.PlaneGeometry(0.75, 0.85), lit, [wx, wy, -SET + 0.02], g, no); upperWindows.push(lit); }
      }
    }
    x += wid;
  }
  // 담장 (벽돌, 군데군데 철 대문) + 화분
  if (opt.fence !== false) {
    let z = 0;
    while (z < L) {
      const seg = Math.min(2.2 + rnd() * 2.5, L - z), h = 1.1 + rnd() * 0.4;
      let f0 = null;
      const gate = rnd() < 0.45 && seg > 1.2;
      for (let q = z; q <= z + seg + 1e-6; q += 0.25) {
        const end = q >= z + seg - 1e-6, free = !end && !blocked([[Math.min(q + 0.125, z + seg - 0.02), -0.12]]);
        if (free && f0 == null) f0 = q;
        if ((!free || end) && f0 != null) { const q1 = Math.min(q, z + seg); if (q1 - f0 > 0.2) mk(box(q1 - f0, h, 0.18), "#b56a4d", [(f0 + q1) / 2, h / 2 - 0.1, -0.09], g, ol); f0 = null; }
      }
      if (gate && !blocked([[z + seg - 0.55, -0.12]])) mk(box(0.8, 1.3, 0.06), "#5d6b72", [z + seg - 0.55, 0.55, -0.02], g, ol);
      z += seg;
    }
    for (let i = 0; i < Math.floor(L / 4); i++) { const pxl = 1 + rnd() * (L - 2); if (!blocked([[pxl, -0.12]])) makePlant(g, pxl, 0.3, 0.65); }
  }
  // 전봇대 + 작은 가로등
  if (opt.poles !== false) for (let px = 2.5; px < L - 1; px += 7.5) {
    if (blocked([[px, -0.12]])) continue;
    mk(cyl(0.1, 0.12, 7, 8), "#9c958c", [px, 3.4, 0.2], g, ol);
    mk(box(1.0, 0.1, 0.1), "#9c958c", [px, 6.6, 0.2], g, ol);
    mk(box(0.06, 0.06, 0.5), "#2a2522", [px, 3.6, 0.45], g, no);
    mk(new THREE.SphereGeometry(0.1, 8, 6), new THREE.MeshBasicMaterial({ color: "#fff2c0" }), [px, 3.55, 0.7], g, no);
    addHalo(g, px, 3.5, 0.75, 3.0, "#ffe0a0");
    const [wx, wz] = [a[0] + ux * px + -uz * 0.2, a[1] + uz * px + ux * 0.2];
    addObstacle(wx, wz, 0.13, 0.13);
  }
  return g;
}

/** 걸을 수 있는 바깥 구역 (회전 사각형) */
const outdoorAreas = [];
function addOutdoorArea(cx, cz, hw, hd, rad = 0) { outdoorAreas.push({ cx, cz, hw, hd, c: Math.cos(rad), s: Math.sin(rad) }); }
function inArea(a, x, z, m = 0) {
  const dx = x - a.cx, dz = z - a.cz, lx = dx * a.c + dz * a.s, lz = -dx * a.s + dz * a.c;
  return Math.abs(lx) <= a.hw - m && Math.abs(lz) <= a.hd - m;
}
function inOutdoor(x, z, m = 0) {
  for (const a of outdoorAreas) {
    const dx = x - a.cx, dz = z - a.cz, lx = dx * a.c + dz * a.s, lz = -dx * a.s + dz * a.c;
    if (Math.abs(lx) <= a.hw - m && Math.abs(lz) <= a.hd - m) return true;
  }
  return false;
}
/** 매장 안쪽까지의 거리 (양수 = 안) */
function storeSD(x, z) {
  let m = Infinity;
  for (const e of EDGES) m = Math.min(m, (x - e.ax) * e.nx + (z - e.az) * e.nz);
  return m;
}

const ALLEY_W = 5.2, LEFT_W = 5.2; // 대각선 골목 폭, 왼쪽 골목 폭
let areasReady = false;
/** 걸을 수 있는 바깥 구역 (가게 앞 골목 · 왼쪽 골목 · 대각선 골목) */
function setupOutdoorAreas(A) {
  if (areasReady) return;
  areasReady = true;
  const T = 0.14, zF = R.d + T, zA = zF + FRONT_ACROSS, xL = -T - LEFT_W;
  addOutdoorArea(6, (zF + zA) / 2, 12.5, (zA - zF) / 2);                    // 가게 앞 골목 (x -6.5 ~ 18.5)
  addOutdoorArea((xL - T) / 2, (-7 + zA) / 2, (-T - xL) / 2, (zA + 7) / 2); // 왼쪽 골목 (z -7 ~ 앞 골목 끝)
  const yaw = Math.atan2(A.nz, A.nx), d0 = 1.2, d1 = 24;                    // 대각선 골목
  addOutdoorArea(A.mx + A.nx * (d0 + d1) / 2, A.mz + A.nz * (d0 + d1) / 2, (d1 - d0) / 2, ALLEY_W / 2 - 0.1, yaw);
}
function buildStreets3D(T) {
  const zF = R.d + T; // 가게 앞 벽 바깥면
  const zA = zF + FRONT_ACROSS; // 건너편 담장
  setupOutdoorAreas(ALLEY || { mx: 1.95, mz: 7.55, nx: -Math.SQRT1_2, nz: Math.SQRT1_2 });
  // 가게 앞 골목: 건너편 주택 줄, 이웃 건물 옆 줄
  buildHouseRow([-12, zA], [19, zA], [0, -1], 501);
  buildHouseRow([13.8, zF], [19, zF], [0, 1], 503, { poles: false });
  buildHouseRow([19.2, zF - 6], [19.2, zA + 6], [-1, 0], 511, { poles: false }); // 골목 끝: 실제 3D 주택
  // 왼쪽 골목: 건너편 주택 줄, 가게 뒤쪽 줄
  const xL = -T - LEFT_W;
  buildHouseRow([xL, -7.5], [xL, zA + 2], [1, 0], 521);
  buildHouseRow([-T, -7.5], [-T, -T], [-1, 0], 523, { poles: false });
  buildHouseRow([xL - 6, -7.8], [-T + 6, -7.8], [0, 1], 531, { poles: false }); // 골목 끝: 실제 3D 주택
}

let ALLEY = null;
/** 삼거리 길바닥 흰 노면 표시, 맨홀, 머리 위 전깃줄, 방범용 CCTV */
function buildStreetDetails(T, top) {
  const A = ALLEY || { mx: 1.95, mz: 7.55, nx: -Math.SQRT1_2, nz: Math.SQRT1_2 };
  const px = A.nz, pz = -A.nx;
  const AL = (d, o = 0) => [A.mx + A.nx * d + px * o, A.mz + A.nz * d + pz * o];
  const yaw = Math.atan2(A.nx, A.nz);
  const paint = new THREE.MeshBasicMaterial({ color: "#eeeae2", polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  registerTint(paint);
  const flatMesh = (geo, x, y, z, rot) => { const m = new THREE.Mesh(geo, paint); m.rotation.set(-Math.PI / 2, 0, rot); m.position.set(x, y, z); fpGroup.add(m); return m; };
  // 골목 위 좌회전 화살표 (가게 쪽을 향함)
  const arrow = new THREE.Shape();
  [[0, 0], [0.12, 0], [0.12, 1.2], [-0.35, 1.2], [-0.35, 1.38], [-0.7, 1.12], [-0.35, 0.86], [-0.35, 1.04], [-0.02, 1.04], [-0.02, 0]].forEach(([x, y], i) => (i ? arrow.lineTo(x, y) : arrow.moveTo(x, y)));
  const [ax, az] = AL(9, -0.6);
  flatMesh(new THREE.ShapeGeometry(arrow), ax, -0.068, az, yaw + Math.PI);
  // 정지선
  const [sx, sz] = AL(6.2);
  flatMesh(new THREE.PlaneGeometry(3.0, 0.18), sx, -0.068, sz, yaw);
  // 삼거리 X 표시
  const [xx, xz] = AL(4.4);
  for (const r of [0.6, -0.6]) flatMesh(new THREE.PlaneGeometry(2.0, 0.14), xx, -0.118, xz, yaw + r);
  // 맨홀
  for (const [mx, mz] of [AL(7.5, 0.8), [2.4, R.d + T + 1.5]]) {
    const m = mk(new THREE.CircleGeometry(0.32, 20), LINE ? "#4f4c58" : "#2a2a30", [mx, -0.066, mz], fpGroup, { outline: 0, shadow: false });
    m.rotation.x = -Math.PI / 2;
  }
  // 방범용 CCTV 기둥 (삼거리 건너편 모퉁이) + 노란 카메라 + 표지판
  const cx = -1.6, cz = R.d + T + FRONT_ACROSS - 0.25; // 건너편 모퉁이 건물 담장 앞
  addObstacle(cx, cz, 0.12, 0.12);
  const cg = new THREE.Group(); cg.position.set(cx, 0, cz); cg.rotation.y = Math.PI; fpGroup.add(cg); // 팔은 골목 쪽으로
  mk(cyl(0.08, 0.1, 5.2, 10), "#9c958c", [0, 2.5, 0], cg, { outline: 0.012 });
  mk(cyl(0.035, 0.035, 1.8, 8), "#9c958c", [0, 4.6, 0.9], cg, { outline: 0.006 }).rotation.x = Math.PI / 2;
  mk(box(0.18, 0.16, 0.34), "#f2b632", [0, 4.6, 1.75], cg, { outline: 0.008 });
  mk(new THREE.SphereGeometry(0.1, 12, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), "#f4f4f4", [0, 4.45, 1.75], cg, { outline: 0.006 });
  const sign = canvasTex(256, 64, (c, w, h) => { c.fillStyle = "#f2c94c"; c.fillRect(0, 0, w, h); c.strokeStyle = "#1b1b1f"; c.lineWidth = 6; c.strokeRect(3, 3, w - 6, h - 6); c.fillStyle = "#1b1b1f"; c.font = "800 30px 'Pretendard','Apple SD Gothic Neo',sans-serif"; c.textAlign = "center"; c.fillText("방범용 CCTV 작동중", w / 2, 43); });
  const sm = new THREE.MeshBasicMaterial({ map: sign, side: THREE.DoubleSide }); registerTint(sm);
  mk(new THREE.PlaneGeometry(0.9, 0.22), sm, [0.12, 4.3, 0.2], cg, { outline: 0.004, shadow: false }).rotation.y = Math.PI / 2;
  // 머리 위 전깃줄 (건물 모서리 ↔ CCTV 기둥 ↔ 골목 전봇대 방향)
  const pole = new THREE.Vector3(cx, 4.9, cz);
  const anchors = [new THREE.Vector3(3.9, top - 2.2, R.d + T + 0.05), new THREE.Vector3(-0.1, top - 2.6, 5.6), new THREE.Vector3(...AL(12, 1.4)).setY(6.4)];
  anchors[2] = new THREE.Vector3(AL(12, 1.4)[0], 6.4, AL(12, 1.4)[1]);
  for (const a of anchors) for (let k = 0; k < 2; k++) {
    const pts = [];
    for (let t = 0; t <= 1.001; t += 0.08) pts.push(new THREE.Vector3(pole.x + (a.x - pole.x) * t, pole.y - k * 0.18 + (a.y - pole.y) * t - Math.sin(t * Math.PI) * 0.45, pole.z + (a.z - pole.z) * t));
    fpGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: "#1b1b1f" })));
  }
}
/** 창 바깥에 거리 풍경 판 세우기 (방 안을 향하게). groundAt: 그림의 땅 높이 비율(아래에서) → 실제 바닥에 맞춤 */
function addStreetView(cx, cz, nx, nz, w, h, dist, seed, kind = "street", groundAt = 0) {
  const c = document.createElement("canvas");
  c.width = 1024; c.height = 512;
  const ctx = c.getContext("2d");
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex }));
  m.position.set(cx - nx * dist, groundAt ? h / 2 - h * groundAt - 0.08 : h / 2 - 0.3, cz - nz * dist);
  m.rotation.y = Math.atan2(nx, nz); // 판의 앞면(+z)이 방 안쪽(n)을 봄
  fpGroup.add(m);
  streetViews.push({ ctx, tex, seed, W: 1024, H: 512, kind });
}
function updateStreetViews(phase) {
  if (phase === streetPhase) return;
  streetPhase = phase;
  for (const v of streetViews) { (v.kind === "alley" ? drawAlley : drawStreet)(v.ctx, v.W, v.H, phase, v.seed); v.tex.needsUpdate = true; }
}

// ───────── 블라인드 틈으로 들어오는 햇살 / 노을빛 (바닥 줄무늬) ─────────
const sunPatches = [];
const sunTex = canvasTex(256, 256, (g, w, h) => {
  g.clearRect(0, 0, w, h);
  for (let y = 0; y < h; y += 22) {
    const grd = g.createLinearGradient(0, 0, w, 0); // 창에서 멀어질수록 옅게
    grd.addColorStop(0, "rgba(255,255,255,.95)"); grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd; g.fillRect(0, y, w, 10);
  }
});
/** parent 의 로컬 좌표: 창을 따라 x, 방 안쪽 +z */
function addSunPatch(parent, len, depth, x = 0, z0 = 0.05) {
  const mat = new THREE.MeshBasicMaterial({ map: sunTex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, color: "#fff1d6" });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(depth, len), mat);
  m.rotation.set(-Math.PI / 2, 0, Math.PI / 2); // 텍스처 가로(옅어지는 방향) = 방 안쪽
  m.position.set(x, 0.012, z0 + depth / 2);
  m.renderOrder = 1;
  parent.add(m);
  sunPatches.push(mat);
}
const SUN_DAY = new THREE.Color("#fff1d6"), SUN_DUSK = new THREE.Color("#ff8a4c");

/** 1인칭용: 정면 벽 + 자동문 + 천장 + 가게 앞 (위에서 볼 땐 숨김) */
function buildInsideShell(T) {
  const H = R.wallH, o = { outline: 0.02, shadow: false };
  const zF = R.d + T / 2;
  const door = LAYOUT.door?.wall === "front" ? LAYOUT.door : null;
  const front = (x0, x1, y0, y1) => {
    if (x1 - x0 > 0.01) mk(box(x1 - x0, y1 - y0, T), R.wall, [(x0 + x1) / 2, (y0 + y1) / 2, zF], fpGroup, o);
  };
  if (door) {
    const dh = 2.2;
    // 정면 창 자리는 뚫어 둠 → 블라인드 틈으로 진짜 바깥(골목)이 보임
    const winW0 = LAYOUT.front?.windowW ?? 2.6;
    const ox0 = door.x - door.w / 2 - 0.05 - winW0, ox1 = door.x - door.w / 2 - 0.05, oy0 = 0.12, oy1 = 2.75;
    front(FRONT_X0 - T / 2, ox0, 0, H);
    front(ox0, ox1, 0, oy0);
    front(ox0, ox1, oy1, H);
    front(ox1, door.x - door.w / 2, 0, H);
    front(door.x + door.w / 2, FRONT_X1 + T / 2, 0, H);
    front(door.x - door.w / 2, door.x + door.w / 2, dh, H);
    // 안쪽에서 보이는 정면 창 (블라인드)
    const winW = LAYOUT.front?.windowW ?? 2.6;
    const wx0 = door.x - door.w / 2 - 0.05 - winW, wx1 = door.x - door.w / 2 - 0.05;
    const t = blindsTex.clone();
    t.needsUpdate = true;
    t.repeat.set(winW / 0.5, (2.75 - BLIND_BOTTOM) / 1.1);
    const bm = new THREE.MeshBasicMaterial({ map: t, color: "#fff6f2", transparent: true, depthWrite: false, side: THREE.DoubleSide });
    registerTint(bm);
    bm.userData.forceOutside = true;
    const inner = mk(new THREE.PlaneGeometry(winW, 2.75 - BLIND_BOTTOM), bm, [(wx0 + wx1) / 2, (2.75 + BLIND_BOTTOM) / 2, R.d - 0.005], fpGroup, { outline: 0, shadow: false });
    mk(new THREE.PlaneGeometry(winW, BLIND_BOTTOM - 0.12), clearGlass(), [(wx0 + wx1) / 2, (BLIND_BOTTOM + 0.12) / 2, R.d + 0.02], fpGroup, { outline: 0, shadow: false });
    addGlassRefl(fpGroup, winW, 2.75 - 0.12, [(wx0 + wx1) / 2, (2.75 + 0.12) / 2, R.d + 0.04], 0);
    for (const y of [0.14, 2.73]) mk(box(winW, 0.05, 0.12), "#f4f1ec", [(wx0 + wx1) / 2, y, R.d + 0.02], fpGroup, { outline: 0.008, shadow: false });
    inner.renderOrder = 3;
    { const face = blindFace("front"); face.mats.push(bm); // 입구 쪽 창 조절 줄 (문 쪽 끝)
      const cg = new THREE.Group(); cg.position.set(wx1 - 0.1, 0, R.d); cg.rotation.y = Math.PI; fpGroup.add(cg);
      addBlindCord(cg, 0, 2.75, face, 0.08); }
    {
      const sg = new THREE.Group();
      sg.position.set((wx0 + wx1) / 2, 0, R.d);
      sg.rotation.y = Math.PI; // 로컬 +z = 방 안쪽(-z)
      roomGroup.add(sg);
      addSunPatch(sg, winW, 2.6);
    }
    // 정면(입구 쪽) 바깥 골목: 유리 밖 멀리 세움 (창·유리문 너머로 보임, 걸으면 각도 따라 달라짐)
    // 가게 앞 골목은 buildStreets3D 에서 3D 로
    inner.rotation.y = Math.PI;
    // 유리문 한 짝: 왼쪽 경첩, 바깥쪽으로 열림, 오른쪽 가장자리에 긴 세로 나무 손잡이
    const glass = toon("#cfeaf5", { transparent: true, opacity: 0.45 });
    const dw = door.w;
    const pg = new THREE.Group();
    pg.position.set(door.x + dw / 2, 0, zF); // 경첩: 오른쪽 (문짝은 왼쪽으로 뻗음)
    fpGroup.add(pg);
    mk(box(dw - 0.04, dh - 0.04, 0.03), glass, [-dw / 2, dh / 2, 0], pg, { outline: 0, shadow: false });
    const fr = "#4a3a32";
    for (const fx of [-0.025, -dw + 0.025]) mk(box(0.05, dh, 0.06), fr, [fx, dh / 2, 0], pg, { outline: 0.006, shadow: false });
    for (const fy of [0.025, dh - 0.025]) mk(box(dw, 0.05, 0.06), fr, [-dw / 2, fy, 0], pg, { outline: 0.006, shadow: false });
    for (const side of [-1, 1]) { // 안·밖 양쪽 손잡이 (왼쪽 가장자리)
      mk(box(0.04, 0.8, 0.04), "#a8743f", [-dw + 0.12, 1.1, side * 0.08], pg, { outline: 0.006, shadow: false });
      for (const hy of [0.75, 1.45]) mk(box(0.02, 0.02, 0.06), "#a8743f", [-dw + 0.12, hy, side * 0.05], pg, { outline: 0, shadow: false });
    }
    addGlassRefl(pg, dw - 0.08, dh - 0.08, [-dw / 2, dh / 2, 0.025], 0);
    doorPanels.push({ g: pg, swing: true, w: dw });
    mk(box(door.w + 0.12, 0.08, 0.1), "#5a4a40", [door.x, dh, zF], fpGroup, { outline: 0, shadow: false });
    const was = tintCollect;
    tintCollect = true;
    buildStorefront(T, door, dh);
    tintCollect = was;
  } else front(FRONT_X0 - T / 2, FRONT_X1 + T / 2, 0, H);
  // 천장
  const cs = new THREE.Shape(OUTLINE.map(([x, z]) => new THREE.Vector2(x, z)));
  const cg = new THREE.ShapeGeometry(cs);
  cg.rotateX(Math.PI / 2);
  const ceilMat = new THREE.MeshBasicMaterial({ color: R.ceiling || "#f3eaee", side: THREE.DoubleSide });
  registerTint(ceilMat);
  ceilMat.userData.extraDark = 0.45; // 천장엔 조명이 없어 밤에 더 어둡게
  const ceil = new THREE.Mesh(cg, ceilMat);
  ceil.position.y = H + 0.001;
  fpGroup.add(ceil);
  // 노출된 들보 (방 안쪽에 들어가는 위치만)
  const beam = toon("#e6d6d2");
  for (const x of R.beams || []) mk(box(0.22, 0.16, R.d - 0.05), beam, [x, H - 0.08, R.d / 2], fpGroup, { outline: 0.015, shadow: false });
}

/** 정면이 아닌 유리면의 바깥쪽 (벽돌 위·아래, 보도) */
// ───────── 건물 외관 (사진 참고: 4층 코너 건물, 짙은 적갈색 세로 타일, 흰 창틀 창, 케이지 벽등) ─────────
const upperWindows = []; // 위층 창: 밤에 아주 은은한 호박색
const FLOOR_H = 2.7, UPPER_FLOORS = 3;
/** g 로컬 좌표: x = 벽 방향, +z = 바깥. 위층 창문 줄 */
function addUpperWindows(g, x0, x1, zOut, seed) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const H = R.wallH;
  for (let f = 0; f < UPPER_FLOORS; f++) {
    const y = H + 1.35 + f * FLOOR_H;
    for (let x = x0 + 0.9; x < x1 - 0.6; x += 2.1) {
      const w = rnd() < 0.3 ? 0.6 : 1.1, h = w < 1 ? 0.6 : 1.25;
      mk(box(w + 0.14, h + 0.14, 0.05), "#f2efe8", [x, y, zOut], g, { outline: 0.01, shadow: false });
      const glass = new THREE.MeshBasicMaterial({ color: "#2f3450" });
      registerTint(glass);
      mk(new THREE.PlaneGeometry(w, h), glass, [x, y, zOut + 0.03], g, { outline: 0, shadow: false });
      if (rnd() < 0.45) { // 커튼
        const cur = new THREE.MeshBasicMaterial({ color: "#b9ab98" });
        registerTint(cur);
        mk(new THREE.PlaneGeometry(w * 0.48, h * 0.92), cur, [x - w * 0.24, y, zOut + 0.032], g, { outline: 0, shadow: false });
      }
      mk(box(0.03, h, 0.03), "#f2efe8", [x, y, zOut + 0.04], g, { outline: 0, shadow: false });
      if (rnd() < 0.45) { // 밤에 켜지는 창 (아주 은은한 호박색)
        const lit = new THREE.MeshBasicMaterial({ color: "#d89a52", transparent: true, opacity: 0, depthWrite: false });
        mk(new THREE.PlaneGeometry(w, h), lit, [x, y, zOut + 0.035], g, { outline: 0, shadow: false });
        upperWindows.push(lit);
      }
    }
  }
}

/** 철망 씌운 빈티지 벽등 (밤에 벽돌을 주황빛으로) */
function cageLamp(g, x, y, z) {
  const ink = "#1f1f22";
  mk(box(0.1, 0.14, 0.04), ink, [x, y, z], g, { outline: 0.004, shadow: false });
  mk(cyl(0.012, 0.012, 0.12, 6), ink, [x, y - 0.02, z + 0.07], g, { outline: 0, shadow: false }).rotation.x = Math.PI / 2;
  mk(new THREE.SphereGeometry(0.06, 10, 8), new THREE.MeshBasicMaterial({ color: "#ffd08a" }), [x, y - 0.05, z + 0.14], g, { outline: 0, shadow: false });
  for (const dy of [-0.02, -0.08]) mk(new THREE.TorusGeometry(0.065, 0.006, 4, 14), ink, [x, y + dy, z + 0.14], g, { outline: 0, shadow: false }).rotation.x = Math.PI / 2;
  for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2; mk(box(0.006, 0.1, 0.006), ink, [x + Math.cos(a) * 0.064, y - 0.05, z + 0.14 + Math.sin(a) * 0.064], g, { outline: 0, shadow: false }); }
  addHalo(g, x, y - 0.05, z + 0.2, 1.1, "#ffb26a").userData.store = true; // 가게 조명 (문 잠긴 시간엔 꺼짐)
  addHalo(g, x, y - 0.3, z + 0.05, 2.4, "#ff8a4a").userData.store = true; // 벽돌에 번지는 주황빛
}

/** 대각선 면·왼쪽 면 바깥 꾸밈: 위층 창, 흰 창틀, 창 아래 술병 선반 + LED + 사선 패널, 계단, 벽등, 화분 */
function decorateGlassFacade(e, g, top, brickMat) {
  const H = R.wallH, L = e.len, zo = 0.02, no = { outline: 0, shadow: false };
  const diag = R.outside?.[e.i] === "alley";
  // 이 면에 있는 문 (layout door) → 로컬 x
  let doorX = null;
  for (const p of LAYOUT.props || []) {
    if (p.type !== "door") continue;
    const d = Math.abs((p.x - e.ax) * e.nx + (p.z - e.az) * e.nz);
    if (d > 0.6) continue;
    const t = (p.x - e.ax) * e.dx + (p.z - e.az) * e.dz;
    doorX = -(t - L / 2); // 로컬 x 는 변 방향의 반대
  }
  const skip = (x, half = 0) => doorX != null && Math.abs(x - doorX) < 0.55 + half;
  addUpperWindows(g, -L / 2, L / 2, zo + 0.01, 77 + e.i * 13);
  // 흰 창틀 (유리 구간만): 양 끝, 위 채광창 가로대, 중간 가로대 — 바깥 그룹은 로컬 x 가 반대
  const white = "#f2efe8";
  const [ga, gb] = glassSpan(e), G0 = -gb, G1 = -ga, GW = G1 - G0, GC = (G0 + G1) / 2;
  // 입구 쪽 쇼윈도와 같은 모양: 굵은 흰 테두리(액자) + 위쪽 벽돌 턱, 세로 창살만 (가로 창살 없음)
  const GO = 2.85, ol8 = { outline: 0.008, shadow: false };
  for (const mx of mullionXs(e)) {
    const x = -mx;
    if (x <= G0 + 0.06 || x >= G1 - 0.06) continue; // 양 끝은 굵은 테두리가 대신함
    mk(box(0.07, GO - 0.12, 0.06), white, [x, (GO + 0.12) / 2, zo + 0.03], g, ol8);
  }
  mk(box(GW + 0.2, 0.1, 0.16), white, [GC, GO + 0.05, zo + 0.06], g, ol8);                // 위 테두리
  for (const x of [G0 - 0.05, G1 + 0.05]) mk(box(0.1, GO, 0.16), white, [x, GO / 2, zo + 0.06], g, ol8); // 양옆 테두리
  mk(box(GW, 0.1, 0.06), white, [GC, 2.8, zo + 0.02], g, { outline: 0, shadow: false });   // 유리 위끝 ~ 테두리 사이
  if (brickMat) mk(box(GW + 0.5, 0.22, 0.22), brickMat(GW + 0.5, 0.22), [GC, GO + 0.21, zo + 0.11], g, { outline: 0.015, shadow: false }); // 벽돌 턱
  // (창 아래 술병·사선 무늬·LED 는 매장 안 장이 유리 너머로 비쳐 보이는 것 — buildBackbar)
  if (doorX != null) mk(box(1.25, 0.14, 0.5), "#b9b4ac", [doorX, 0.07 - 0.12, zo + 0.27], g, { outline: 0.01, shadow: false }); // 문 앞 돌계단
  // 대각선 면: 양옆 기둥 케이지 벽등, 흰 A형 입간판, 주차금지 원뿔
  if (diag) {
    const pls = (R.pillars || []).filter((q) => q.edge === e.i);
    const pa = pls.find((q) => q.end === "a"), pb = pls.find((q) => q.end === "b");
    const lampXs = [pa ? L / 2 - pa.w / 2 + 0.05 : L / 2 + 0.25, pb ? -L / 2 + pb.w / 2 - 0.05 : -L / 2 - 0.25];
    for (const x of lampXs) cageLamp(g, x, 2.45, zo + 0.04);
    if (doorX != null) { // A형 입간판 (흰색)
      const ab = new THREE.Group(); ab.position.set(doorX + 0.15, 0, zo + 0.95); g.add(ab);
      for (const s of [-1, 1]) { const pnl = mk(box(0.48, 0.7, 0.03), "#f4f1ea", [0, 0.36, s * 0.1], ab, { outline: 0.008 }); pnl.rotation.x = s * -0.15; }
      mk(box(0.34, 0.2, 0.005), "#d9d3c6", [0, 0.45, 0.13], ab, no);
    }
    for (const x of [-L / 2 - 0.6, L / 2 + 0.6]) {
      const cone = new THREE.Group(); cone.position.set(x, 0, zo + 0.7); g.add(cone);
      mk(new THREE.CylinderGeometry(0.06, 0.18, 0.75, 16), "#1f1f22", [0, 0.375, 0], cone, { outline: 0.01 });
      mk(cyl(0.2, 0.22, 0.05, 16), "#1f1f22", [0, 0.025, 0], cone, { outline: 0.008 });
    }
  }
  // 건물 둘레 화분 줄
  let sd = 5 + e.i;
  const rr = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
  for (let x = -L / 2 + 0.4; x < L / 2 - 0.3; x += 0.55 + rr() * 0.35) {
    if (skip(x, 0.2)) continue;
    const big = rr() < 0.35;
    if (rr() < 0.5) makeCypress(g, x, zo + 0.35, big ? 1.1 : 0.8);
    else makePlant(g, x, zo + 0.35, big ? 0.9 : 0.6);
  }
}

function buildSideFacades(T, top, brickMat) {
  for (const e of EDGES) {
    if (e.kind !== "glass") continue;
    const outward = -1;
    const g = new THREE.Group();
    g.position.set((e.ax + e.bx) / 2 - e.nx * (T + 0.015), 0, (e.az + e.bz) / 2 - e.nz * (T + 0.015));
    g.rotation.y = -Math.atan2(e.dz, e.dx) + Math.PI; // 바깥을 보도록
    fpGroup.add(g);
    const H = R.wallH;
    const part = (y0, y1) => mk(box(e.len + 0.3, y1 - y0, 0.03), brickMat(e.len + 0.3, y1 - y0), [0, (y0 + y1) / 2, 0], g, { outline: 0.015, shadow: false });
    const GO = 2.85; // 바깥 창 개구부 위끝 (입구 쪽과 같게)
    part(GO + 0.1, top);
    part(0, 0.12);
    // 모서리 기둥 바깥면: 안쪽 기둥 폭 + 벽 두께(모서리에서 바깥으로 늘어나는 만큼)
    for (const pl of R.pillars || []) {
      if (pl.edge !== e.i) continue;
      const w = pl.w + T + 0.03, x0 = pl.end === "a" ? e.len / 2 - pl.w : -e.len / 2 - (T + 0.03); // 바깥 그룹은 로컬 x 가 반대
      mk(box(w, H, 0.035), brickMat(w, H), [x0 + w / 2, H / 2, 0.003], g, { outline: 0.015, shadow: false });
    }
    // 길 (아스팔트, 인도 턱 없음)
    // (길은 주변 아스팔트 한 가지 색)
    decorateGlassFacade(e, g, top, brickMat);
  }
}

/** 캔버스로 그린 텍스처 */
function canvasTex(w, h, draw, repeat) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}
const flat = (map) => new THREE.MeshBasicMaterial({ map });
const toonMap = (map) => toon("#ffffff", { unique: true, map });

/** 가게 바깥 모습 (사진 참고: 적갈색 세로 벽돌, 흰 테두리 쇼윈도, 유리문, 고래꼬리 조명) */
function buildStorefront(T, door, dh) {
  const F = LAYOUT.front || {};
  const H = R.wallH, zO = R.d + T + 0.012, no = { outline: 0, shadow: false }, ol = { outline: 0.015, shadow: false };
  const top = H + 0.3 + UPPER_FLOORS * FLOOR_H; // 4층 코너 건물
  const upY = LINE ? H + 1.25 : H + 1.9, upH = LINE ? 1.2 : 1.5;
  const brickCol = F.color || "#6e3426";

  // ── 벽돌 외벽 (세로로 긴 타일)
  const brick = canvasTex(256, 256, (g, w, h) => {
    if (LINE) {
      g.fillStyle = "#8e3e31"; g.fillRect(0, 0, w, h); // 짙은 적갈색
      g.strokeStyle = "rgba(27,27,31,.75)"; g.lineWidth = 3; g.lineCap = "round";
      for (let row = 0; row < 8; row++) { // 세로로 긴 타일, 촘촘하게
        g.beginPath(); g.moveTo(0, row * 32 + 1); g.lineTo(w, row * 32 + 1); g.stroke();
        for (let col = 0; col < 16; col++) {
          if ((col * 3 + row) % 5 === 0) continue;
          const x = col * 16 + (row % 2) * 8;
          g.beginPath(); g.moveTo(x, row * 32 + 6); g.lineTo(x, row * 32 + 26); g.stroke();
        }
      }
      return;
    }
    g.fillStyle = "#3a1d16"; g.fillRect(0, 0, w, h);
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 16; col++) {
        const x = col * 16 + (row % 2) * 8, y = row * 64;
        const v = ((col * 7 + row * 13) % 5) * 6;
        g.fillStyle = `rgb(${110 + v},${50 + v / 2},${36 + v / 3})`;
        g.fillRect(x + 1.5, y + 2, 13, 60);
        g.fillStyle = "rgba(255,255,255,.07)"; g.fillRect(x + 1.5, y + 2, 3, 60);
      }
    }
  });
  const brickMat = (w, h) => { const t = brick.clone(); t.needsUpdate = true; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(w / 1.1, h / 1.1); return toonMap(t); };
  const wallPart = (x0, x1, y0, y1, d = 0.03, z = zO) => {
    if (x1 - x0 < 0.01 || y1 - y0 < 0.01) return;
    mk(box(x1 - x0, y1 - y0, d), brickMat(x1 - x0, y1 - y0), [(x0 + x1) / 2, (y0 + y1) / 2, z + d / 2], fpGroup, ol);
  };

  // 쇼윈도(문 왼쪽) + 문 = 흰 테두리 안쪽으로 들어간 입구
  const winW = F.windowW ?? 2.6;
  const opL = door.x - door.w / 2 - winW, opR = door.x + door.w / 2 + 0.05, opTop = 2.85;
  wallPart(FRONT_X0 - T, opL - 0.1, 0, top);
  wallPart(opR + 0.1, FRONT_X1 + T, 0, top);
  buildSideFacades(T, top, brickMat);
  wallPart(opL - 0.1, opR + 0.1, opTop + 0.1, top);
  // 입구 위 벽돌 처마 (살짝 튀어나옴)
  wallPart(opL - 0.25, opR + 0.25, opTop + 0.1, opTop + 0.32, 0.22);
  // 흰 테두리
  const white = "#f4f1ec";
  mk(box(opR - opL + 0.2, 0.1, 0.16), white, [(opL + opR) / 2, opTop + 0.05, zO + 0.04], fpGroup, ol);
  mk(box(0.1, opTop, 0.16), white, [opL - 0.05, opTop / 2, zO + 0.04], fpGroup, ol);
  mk(box(0.1, opTop, 0.16), white, [opR + 0.05, opTop / 2, zO + 0.04], fpGroup, ol);

  // ── 쇼윈도
  const wx = opL + winW / 2, wz = zO + 0.006; // 벽 바깥면 바로 앞
  // (쇼윈도는 진짜 유리: 매장 안 장·블라인드·조명이 비쳐 보임. 문 위 작은 창 그림만 남김)
  const blinds = (rows) => canvasTex(256, 256, (g, w, h) => {
    const grd = g.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, "#d9c7cf"); grd.addColorStop(1, "#b99aa8");
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
    g.fillStyle = "rgba(255,255,255,.38)";
    for (let y = 0; y < h; y += h / rows) g.fillRect(0, y, w, h / rows * 0.55);
  });
  // 창틀 (흰색)
  
  mk(box(winW, 0.07, 0.06), white, [wx, 2.3, zO + 0.03], fpGroup, ol);
  mk(box(0.07, opTop, 0.06), white, [opL + winW, opTop / 2, zO + 0.03], fpGroup, ol);
  // 유리 반사
  const shine = new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.1, depthWrite: false });
  mk(box(0.1, 0.9, 0.005), shine, [wx - winW * 0.25, 1.7, zO + 0.04], fpGroup, no).rotation.z = 0.5;

  // ── 문 위: 작은 창 + 환풍기
  mk(box(door.w + 0.1, 0.06, 0.06), white, [door.x, dh + 0.02, zO + 0.03], fpGroup, ol);
  nightGlow.windows.push(mk(new THREE.PlaneGeometry(door.w * 0.55, 0.42), flat(blinds(6)), [door.x - door.w * 0.2, dh + 0.33, wz], fpGroup, no).material);
  const fan = canvasTex(128, 128, (g) => {
    g.fillStyle = "#e9e6e1"; g.beginPath(); g.arc(64, 64, 60, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "#555"; g.lineWidth = 6; g.beginPath(); g.arc(64, 64, 48, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 4; for (let a = 0; a < 6; a++) { g.beginPath(); g.moveTo(64, 64); g.lineTo(64 + Math.cos(a) * 44, 64 + Math.sin(a) * 44); g.stroke(); }
  });
  mk(new THREE.PlaneGeometry(0.42, 0.42), toon("#e9e6e1"), [door.x + door.w * 0.3, dh + 0.33, wz], fpGroup, no);
  const fanMesh = mk(new THREE.PlaneGeometry(0.4, 0.4), new THREE.MeshBasicMaterial({ map: fan, transparent: true }), [door.x + door.w * 0.3, dh + 0.33, wz + 0.01], fpGroup, no);
  steamFan = fanMesh;
  { // 숨은 관리자 입구: 문 위 환풍기를 누르면 관리자 로그인
    const hb = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.7), hitMat);
    hb.position.set(door.x + door.w * 0.3, dh + 0.33, wz + 0.03);
    fpGroup.add(hb); adminFanHit = hb;
  }

  // ── 문에 거는 팻말
  const signTex = (top, big) => canvasTex(256, 160, (g, w, h) => {
    g.fillStyle = "#f7efe2"; g.fillRect(0, 0, w, h);
    g.strokeStyle = "#2b2522"; g.lineWidth = 6; g.strokeRect(3, 3, w - 6, h - 6);
    g.fillStyle = "#c8392b"; g.font = "800 30px sans-serif"; g.textAlign = "center"; g.fillText(top, w / 2, 50);
    g.fillStyle = "#2b2522"; g.font = "900 64px Georgia, serif"; g.fillText(big, w / 2, 122);
  });
  const openSign = signTex(F.doorSign?.[0] ?? "COME IN  we're", F.doorSign?.[1] ?? "OPEN");
  doorSignTex.open = openSign; doorSignTex.closed = signTex("SORRY  we're", "CLOSED");
  doorSign = mk(new THREE.PlaneGeometry(0.34, 0.21), flat(openSign), [-door.w * 0.45, 1.45, 0.035], doorPanels[0]?.g || fpGroup, no);

  // ── 오른쪽 기둥: 번지판 + 나무 명판
  const px = opR + 0.55;
  if (F.number) {
    const plate = canvasTex(256, 200, (g, w, h) => {
      g.fillStyle = "#1f4fa3"; g.beginPath(); g.roundRect(4, 4, w - 8, h - 8, 26); g.fill();
      g.strokeStyle = "#fff"; g.lineWidth = 5; g.beginPath(); g.roundRect(12, 12, w - 24, h - 24, 20); g.stroke();
      g.fillStyle = "#fff"; g.textAlign = "center";
      if (F.street) { // 도로명 주소판: 위 도로명, 아래 번호
        g.font = "800 31px sans-serif"; g.fillText(F.street, w / 2, 72);
        g.font = "800 70px sans-serif"; g.fillText(F.number, w / 2, 160);
      } else { g.font = "800 96px sans-serif"; g.fillText(F.number, w / 2, 160); }
    });
    mk(new THREE.PlaneGeometry(0.44, 0.34), flat(plate), [px, 2.25, zO + 0.04], fpGroup, no);
  }
  const wood = canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = "#c9a57c"; g.fillRect(0, 0, w, h);
    g.strokeStyle = "rgba(120,80,40,.25)"; g.lineWidth = 2;
    for (let y = 8; y < h; y += 11) { g.beginPath(); g.moveTo(0, y); g.bezierCurveTo(40, y + 4, 80, y - 4, w, y + 2); g.stroke(); }
    // 명판 글자: 폭에 맞춰 줄바꿈
    g.fillStyle = "#3b2b22"; g.textAlign = "center"; g.font = "800 22px Georgia, 'Times New Roman', serif";
    const lines = [];
    for (const word of String(F.sign || "").split(" ")) {
      const last = lines[lines.length - 1];
      if (last && g.measureText(last + " " + word).width < w - 24) lines[lines.length - 1] = last + " " + word;
      else lines.push(word);
    }
    lines.forEach((l, i) => g.fillText(l, w / 2, h / 2 + 8 + (i - (lines.length - 1) / 2) * 26));
  });
  mk(box(0.48, 0.42, 0.03), toonMap(wood), [px, 1.72, zO + 0.03], fpGroup, ol);

  // ── 바닥: 한 칸 올라간 입구 턱, 보도, 도로(노란 선)
  const ground = mk(new THREE.CircleGeometry(45, 48), LINE ? "#6f6c78" : "#3b3b3d", [R.w / 2, -0.125, R.d / 2], fpGroup, no);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  // (가게 앞 길도 주변 아스팔트 한 가지 색)


  // ── 2층 창문 (front.upperWindow: true 일 때만)
  if (F.upperWindow) {
    const upW = Math.min(4.2, (opR - opL) * 1.15);
    mk(box(upW + 0.16, upH, 0.08), white, [(opL + opR) / 2, upY, zO + 0.02], fpGroup, ol);
    mk(box(upW, upH - 0.16, 0.06), toon(LINE ? "#bfe0f2" : "#2a3550"), [(opL + opR) / 2, upY, zO + 0.05], fpGroup, no);
    mk(box(0.07, upH - 0.16, 0.08), white, [(opL + opR) / 2, upY, zO + 0.07], fpGroup, no);
    // 밤이 되면 2층 창에 따뜻한 불이 켜짐
    nightGlow.lit = mk(new THREE.PlaneGeometry(upW, upH - 0.16), new THREE.MeshBasicMaterial({ color: "#e9a35e", transparent: true, opacity: 0, depthWrite: false }), [(opL + opR) / 2, upY, zO + 0.085], fpGroup, no);
  }
  // 오른쪽 이웃 건물 (흰 셔터)
  const nx0 = R.w + T + 0.02;
  mk(box(4, H + 2.3, 3), "#cfc9bf", [nx0 + 2, (H + 2.3) / 2, R.d - 1.5 + T], fpGroup, ol);
  mk(box(2.6, 2.5, 0.05), "#ecebe6", [nx0 + 1.6, 1.25, R.d + T + 0.02], fpGroup, ol);
  for (let y = 0.15; y < 2.5; y += 0.18) mk(box(2.6, 0.012, 0.06), "#cfcdc6", [nx0 + 1.6, y, R.d + T + 0.03], fpGroup, no);
  mk(box(3.0, 0.08, 0.6), "#55595e", [nx0 + 1.6, 2.65, R.d + T + 0.3], fpGroup, ol);

  // ── 화분들 (고무나무 + 측백나무)
  makeRubberPlant(fpGroup, opL + 0.35, R.d + T + 0.35);
  const pcx = (opR + R.w + T) / 2; // 문 오른쪽 벽돌 기둥 가운데 (화분 + 사각 등)
  for (const [dx, dz, k] of [[0.95, 0.4, 0.9], [1.55, 0.95, 1.0], [2.15, 0.95, 0.95], [pcx - opL, 0.3, 0.95]]) makeCypress(fpGroup, opL + dx, R.d + T + dz, k);

  // ── 고래꼬리 조명 상자
  const lx = pcx, lz = R.d + T + 0.85;
  addObstacle(lx, lz, 0.2, 0.2);
  addObstacle(opL + 0.35, R.d + T + 0.35, 0.2, 0.2);
  for (const [dx, dz] of [[0.95, 0.4], [1.55, 0.95], [2.15, 0.95], [pcx - opL, 0.3]]) addObstacle(opL + dx, R.d + T + dz, 0.2, 0.2);
  addObstacle(opL - 0.2, R.d + T + 1.9, 0.2, 0.2);
  const lantern = new THREE.Group();
  lantern.position.set(lx, 0, lz);
  fpGroup.add(lantern);
  const logo = canvasTex(160, 320, (g, w, h) => {
    const grd = g.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, "#fff6f6"); grd.addColorStop(1, "#ffd9dc");
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
    g.strokeStyle = "#2b2522"; g.lineWidth = 5; g.lineCap = "round"; g.lineJoin = "round";
    const cx = w / 2, cy = h * 0.47;
    // 꼬리
    g.beginPath(); g.moveTo(cx, cy + 22); g.lineTo(cx, cy - 6);
    g.quadraticCurveTo(cx - 6, cy - 24, cx - 34, cy - 30); g.quadraticCurveTo(cx - 14, cy - 14, cx, cy - 6);
    g.moveTo(cx, cy - 6); g.quadraticCurveTo(cx + 6, cy - 24, cx + 34, cy - 30); g.quadraticCurveTo(cx + 14, cy - 14, cx, cy - 6);
    g.stroke();
    // 물결
    g.beginPath(); g.ellipse(cx, cy + 26, 40, 10, 0, Math.PI * 0.05, Math.PI * 1.1); g.stroke();
    g.beginPath(); g.ellipse(cx, cy + 30, 56, 15, 0, Math.PI * 0.95, Math.PI * 1.9, true); g.stroke();
  });
  const glow = new THREE.MeshBasicMaterial({ map: logo });
  nightGlow.lanternMat = glow; // 문 잠긴 시간엔 불 꺼진 사각 등
  for (const [rx, rz, ry] of [[0, 0.16, 0], [0.16, 0, Math.PI / 2], [-0.16, 0, -Math.PI / 2], [0, -0.16, Math.PI]]) {
    mk(new THREE.PlaneGeometry(0.3, 0.6), glow, [rx, 0.62, rz], lantern, no).rotation.y = ry;
  }
  const iron = "#1c1c1e";
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) mk(box(0.025, 1.0, 0.025), iron, [sx * 0.17, 0.5, sz * 0.17], lantern, { outline: 0, shadow: true });
  for (const y of [0.04, 0.3, 0.93, 1.0]) {
    mk(box(0.36, 0.02, 0.025), iron, [0, y, 0.17], lantern, no); mk(box(0.36, 0.02, 0.025), iron, [0, y, -0.17], lantern, no);
    mk(box(0.025, 0.02, 0.36), iron, [0.17, y, 0], lantern, no); mk(box(0.025, 0.02, 0.36), iron, [-0.17, y, 0], lantern, no);
  }
  // 바닥에 비치는 분홍빛
  // 가운데만 살짝 밝고 가장자리는 바닥에 스며드는 빛 (테두리 없음)
  const pool = nightGlow.pool = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.4), new THREE.MeshBasicMaterial({ map: poolTex, color: "#ffb08f", transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
  pool.position.set(0, 0.006, 0); pool.rotation.x = -Math.PI / 2; pool.renderOrder = 2; lantern.add(pool);
  addHalo(lantern, 0, 0.62, 0, 1.3, "#ffb98f").userData.store = true;
  addHalo(fpGroup, wx, 1.4, zO + 0.3, 2.6, "#ff9f5a").userData.store = true;
  const lampLight = new THREE.PointLight("#ffb3c0", 3, 4, 1.6);
  lampLight.position.set(0, 0.7, 0.2);
  lantern.add(lampLight);
  const winLight = new THREE.PointLight("#ff9a5c", 1.2, 3, 1.6);
  winLight.position.set(wx, 0.7, zO + 0.9);
  fpGroup.add(winLight);
  nightGlow.storeLights = [[lampLight, 3], [winLight, 1.2]];

  // ── 주차금지 표지 (검은 받침)
  const cone = new THREE.Group();
  cone.position.set(opL - 0.2, 0, R.d + T + 1.9);
  fpGroup.add(cone);
  mk(new THREE.CylinderGeometry(0.08, 0.2, 0.75, 20), "#232325", [0, 0.375, 0], cone, ol);
  mk(new THREE.CylinderGeometry(0.22, 0.24, 0.06, 20), "#232325", [0, 0.03, 0], cone, ol);
  mk(new THREE.CylinderGeometry(0.2, 0.2, 0.04, 24), "#232325", [0, 1.0, 0], cone, ol).rotation.x = Math.PI / 2;
  mk(cyl(0.03, 0.03, 0.25, 8), "#232325", [0, 0.82, 0], cone, no);
  const noPark = canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = "#fff"; g.fillRect(0, 0, w, h);
    g.fillStyle = "#d32f2f"; g.font = "800 30px sans-serif"; g.textAlign = "center"; g.fillText("주차금지", w / 2, 76);
  });
  mk(new THREE.PlaneGeometry(0.26, 0.26), flat(noPark), [0, 1.0, 0.025], cone, no);
  if (LINE) { buildSkyDoodles(top); buildNightSky(top); }
  // 정면 위층 창 + 길바닥 노면 표시 + 전깃줄·CCTV
  { const fg = new THREE.Group(); fg.position.set(0, 0, zO); fpGroup.add(fg); addUpperWindows(fg, FRONT_X0, FRONT_X1, 0.03, 31); }
  buildStreetDetails(T, top);
  buildStreets3D(T);
}

// ───────── 시간대 (낮 → 노을 → 밤 조명) ─────────
const nightGlow = { strip: null, pool: null, lit: null, halos: [], sky: [], windows: [] };
const WIN_NIGHT = new THREE.Color("#c98a62"); // 밤의 쇼윈도: 은은한 오렌지
const haloTex = canvasTex(128, 128, (g) => {
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, "rgba(255,255,255,.9)"); grd.addColorStop(0.35, "rgba(255,255,255,.35)"); grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
});
/** 밤에만 보이는 은은한 불빛 번짐 */
function addHalo(parent, x, y, z, size, color, inner = false) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, color, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
  sp.position.set(x, y, z);
  sp.scale.set(size, size, 1);
  sp.renderOrder = 3;
  sp.userData.inner = inner;
  if (inner) sp.material.color.lerp(new THREE.Color("#ffa65c"), 0.6); // 실내 조명은 오렌지빛
  parent.add(sp);
  nightGlow.halos.push(sp);
  return sp;
}
/** 밤하늘: 달 + 별 */
function buildNightSky(top) {
  const cx = LAYOUT.door.x - 0.8;
  const moon = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, opacity: 0, map: canvasTex(128, 128, (g) => {
    g.fillStyle = "#fff2b8"; g.strokeStyle = "#1b1b1f"; g.lineWidth = 8;
    g.beginPath(); g.arc(64, 64, 52, 0, Math.PI * 2); g.fill(); g.stroke();
    g.lineWidth = 5; g.beginPath(); g.arc(48, 52, 10, 0, Math.PI * 2); g.stroke(); g.beginPath(); g.arc(78, 80, 6, 0, Math.PI * 2); g.stroke();
  }) }));
  moon.position.set(cx + 0.9, top + 1.3, R.d + 0.6);
  moon.scale.set(0.9, 0.9, 1);
  fpGroup.add(moon);
  nightGlow.sky.push(moon);
  const star = canvasTex(64, 64, (g) => {
    g.fillStyle = "#fff6d0"; g.strokeStyle = "#1b1b1f"; g.lineWidth = 4;
    g.beginPath();
    for (let i = 0; i < 10; i++) { const r = i % 2 ? 11 : 26, a = (i / 10) * Math.PI * 2 - Math.PI / 2; g.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r); }
    g.closePath(); g.fill(); g.stroke();
  });
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 14; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: star, transparent: true, opacity: 0 }));
    sp.position.set(cx - 4 + rnd() * 8, top + 0.6 + rnd() * 3, R.d + 0.5 - rnd() * 2);
    const k = 0.12 + rnd() * 0.14;
    sp.scale.set(k, k, 1);
    sp.userData.tw = rnd() * 6;
    fpGroup.add(sp);
    nightGlow.sky.push(sp);
  }
}

/** 지금 시각 → 밤 정도 (0 낮 ~ 1 밤). 주소 ?time=21 로 시간 미리보기 */
function nightAmount() {
  const q = new URLSearchParams(location.search).get("time");
  const d = new Date();
  const h = q != null && q !== "" && !isNaN(+q) ? +q : d.getHours() + d.getMinutes() / 60;
  if (h >= 7 && h < 17) return 0;
  if (h >= 17 && h < 19) return ((h - 17) / 2) * 0.85;
  if (h >= 5 && h < 7) return 1 - (h - 5) / 2;
  return 1;
}
let timeK = nightAmount();
setInterval(() => { timeK = nightAmount(); }, 60000);
const NIGHT_TINT = new THREE.Color("#4b4f8f"), DUSK_TINT = new THREE.Color("#e0a3a0"), WHITE = new THREE.Color("#ffffff");
// 매장 안: 밤엔 은은한 분홍빛으로 어둡게 (사진 속 밤 분위기)
// 실제 매장처럼 낮에도 어스름하게 (조명 둘레만 밝음), 밤엔 조금 더
const IN_DAY = new THREE.Color("#7f6a5e"), IN_NIGHT = new THREE.Color("#6a5348"), IN_DUSK = new THREE.Color("#755e52");
const tmpIn = new THREE.Color();
const tmpC = new THREE.Color();
let lastTint = -1;
let lockState = null;
const IS_ADMIN_VIEW = () => document.body.classList.contains("admin"); // 관리자는 잠긴 시간에도 평소처럼
function applyTime(outside, time) {
  const k = timeK; // 바깥 하늘/건물 색은 시간 기준 (밖에 있을 때만 보임)
  const phase = k < 0.15 ? "day" : k < 0.75 ? "dusk" : "night";
  const root = document.documentElement.classList;
  for (const p of ["day", "dusk", "night"]) root.toggle(`sky-${p}`, p === phase);
  updateStreetViews(phase);
  // 문 잠긴 시간(새벽 4시~오전 10시): 가게 안팎 조명 끄기 + 블라인드 완전히 닫기 + 바텐더 퇴근
  const locked = isLockedNow() && !IS_ADMIN_VIEW(), on = locked ? 0 : 1;
  if (locked !== lockState) {
    lockState = locked;
    for (const f of blindFaces.values()) { if (locked) { f.saved = f.level; setBlindLevel(f, 2); } else setBlindLevel(f, f.saved ?? 0); }
    for (const b of bartenders) b.visible = !locked;
    for (const [l, i] of nightGlow.storeLights || []) l.intensity = locked ? 0 : i;
    if (nightGlow.lanternMat) nightGlow.lanternMat.color.set(locked ? "#5a5560" : "#ffffff");
  }
  const key = k + outside * 10 + (locked ? 100 : 0);
  if (Math.abs(key - lastTint) > 0.005) {
    lastTint = key;
    // 바깥: 낮 → 노을(분홍빛) → 밤(푸르고 어둡게) / 안: 밤에 은은한 분홍빛
    if (k < 0.5) tmpC.copy(WHITE).lerp(DUSK_TINT, k / 0.5);
    else tmpC.copy(DUSK_TINT).lerp(NIGHT_TINT, (k - 0.5) / 0.5);
    if (k < 0.5) tmpIn.copy(IN_DAY).lerp(IN_DUSK, k / 0.5);
    else tmpIn.copy(IN_DUSK).lerp(IN_NIGHT, (k - 0.5) / 0.5);
    // 매장 안 재질은 손님이 어디 있든 늘 실내 색, 바깥 재질은 늘 바깥 하늘 색
    const gk = Math.max(0.85, THREE.MathUtils.smoothstep(k, 0.3, 1)); // 안은 늘 조명 분위기
    // 블라인드를 닫을수록 바깥 빛이 덜 들어와 매장이 어두워짐 (낮에 크게, 밤엔 거의 차이 없음)
    const OPEN = [1, 0.35, 0];
    let openSum = 0, nFace = 0;
    for (const f of blindFaces.values()) { openSum += OPEN[f.level]; nFace++; }
    const openAvg = nFace ? openSum / nFace : 1, dayL = 1 - THREE.MathUtils.smoothstep(k, 0.2, 0.75);
    const inMul = 1 - 0.28 * dayL * (1 - openAvg);
    for (const m of tintables) {
      const inside = m.userData.inside ?? tintSplit === false;
      m.color.copy(m.userData.base).multiply(inside ? tmpIn : tmpC);
      if (m.userData.extraDark && inside) m.color.multiplyScalar(1 - m.userData.extraDark * gk);
      if (inside) m.color.multiplyScalar(inMul * (on ? 1 : 0.38)); // 조명이 꺼지면 매장 안이 어둡게
      if (m.userData.blindOpen != null) m.color.multiplyScalar(1 - (1 - m.userData.blindOpen) * (0.25 + 0.3 * dayL)); // 닫힌 블라인드는 뒤에서 비치는 빛이 줄어 어둡게
    }
  }
  const glow = THREE.MathUtils.smoothstep(k, 0.3, 1);
  const gIn = Math.max(0.85, glow); // 매장 안 조명은 낮에도 켜져 있음
  for (const h of nightGlow.halos) h.material.opacity = (h.userData.inner ? 0.08 + gIn * 0.48 : glow * 0.38) * (h.userData.inner || h.userData.store ? on : 1);
  for (const m of nightGlow.windows) m.color.copy(WHITE).lerp(WIN_NIGHT, glow * 0.85);
  for (const [m, lo, hi] of innerGlows) m.opacity = Math.min(1, (lo + (hi - lo) * gIn) * 1.4) * on; // 조명 둘레 빛을 조금 더 진하게
  const dayAmt = 1 - THREE.MathUtils.smoothstep(k, 0.2, 0.7);
  const duskAmt = Math.max(0, 1 - Math.abs(k - 0.45) / 0.3);
  for (const m of sunPatches) m.opacity = 0; // 매장 안은 늘 어스름한 조명 분위기: 바닥 햇살 줄무늬 없음
  for (const m of glassRefl) m.opacity = 0.04 + 0.42 * dayAmt + 0.22 * duskAmt; // 낮에도 안이 어렴풋이 보이는 정도 // 낮엔 비침이 진해 안이 잘 안 보임
  for (const s of nightGlow.sky) {
    const tw = s.userData.tw != null ? 0.6 + 0.4 * Math.sin(time * 2 + s.userData.tw) : 1;
    s.material.opacity = glow * tw;
  }
  if (nightGlow.strip) nightGlow.strip.material.opacity = (0.3 + glow * 0.25) * on;
  if (nightGlow.pool) nightGlow.pool.material.opacity = (0.08 + glow * 0.3) * on;
  if (nightGlow.lit) nightGlow.lit.material.opacity = glow * 0.55;
  for (const m of alleyWindows) m.opacity = glow * 0.9;
  for (const m of upperWindows) m.opacity = glow * 0.22; // 아주 은은한 호박색
}

/** 손그림 그림체: 하늘의 구름 + 이웃 건물 뒤 큰 나무 */
function buildSkyDoodles(top) {
  const cloud = canvasTex(512, 256, (g) => {
    g.fillStyle = "#f1b6e6"; g.strokeStyle = "#1b1b1f"; g.lineWidth = 12; g.lineJoin = "round";
    g.beginPath();
    g.moveTo(60, 200);
    g.bezierCurveTo(10, 200, 20, 130, 80, 140);
    g.bezierCurveTo(80, 70, 170, 60, 200, 110);
    g.bezierCurveTo(230, 30, 350, 40, 350, 120);
    g.bezierCurveTo(420, 90, 480, 150, 450, 200);
    g.closePath(); g.fill(); g.stroke();
    g.lineWidth = 9; g.lineCap = "round";
    for (const [x, y] of [[150, 150], [260, 120], [360, 165]]) { g.beginPath(); g.arc(x, y, 22, Math.PI * 1.05, Math.PI * 1.85); g.stroke(); }
  });
  const cx = LAYOUT.door.x - 0.8;
  const spots = [[cx - 2.0, top + 0.9, R.d + 0.8, 2.4], [cx + 2.2, top + 1.5, R.d + 0.4, 1.8], [cx + 0.4, top + 2.4, R.d - 1, 1.4]];
  for (const [x, y, z, w] of spots) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: cloud, transparent: true }));
    sp.position.set(x, y, z);
    sp.scale.set(w, w / 2, 1);
    fpGroup.add(sp);
    registerTint(sp.material);
  }
  // 이웃 건물 뒤로 보이는 동글동글한 나무
  const tree = new THREE.Group();
  tree.position.set(R.w + 3.2, 0, R.d - 2.5);
  fpGroup.add(tree);
  mk(cyl(0.18, 0.25, top - 0.5, 10), "#7a5236", [0, (top - 0.5) / 2, 0], tree);
  for (const [x, y, z, r, col] of [[0, top + 0.2, 0, 1.3, "#a9d65c"], [-0.9, top - 0.5, 0.3, 1.0, "#8fc25a"], [0.8, top - 0.3, 0.4, 0.95, "#c3e46e"]]) {
    mk(new THREE.SphereGeometry(r, 18, 14), leafMat(col), [x, y, z], tree, { outline: 0.03 });
  }
}

/** 고무나무 (흰 화분) */
function makeRubberPlant(parent, x, z) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  parent.add(g);
  mk(cyl(0.19, 0.15, 0.4, 18), "#f1efea", [0, 0.2, 0], g);
  mk(cyl(0.02, 0.025, 1.0, 6), "#6b4a2e", [0, 0.85, 0], g, { outline: 0, shadow: true });
  const leaf = new THREE.SphereGeometry(0.09, 10, 8);
  for (let i = 0; i < 11; i++) {
    const a = i * 2.3, y = 0.6 + i * 0.07;
    const m = mk(leaf, leafMat(i % 2 ? (LINE ? "#7fb24a" : "#4f7d3a") : (LINE ? "#a9d65c" : "#6a9a4a")), [Math.cos(a) * 0.16, y, Math.sin(a) * 0.16], g, { outline: 0.01 });
    m.scale.set(1, 0.35, 1.7);
    m.rotation.y = -a;
  }
}

/** 측백나무 (테라코타 화분) */
function makeCypress(parent, x, z, k = 1) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.scale.setScalar(k);
  parent.add(g);
  mk(cyl(0.2, 0.15, 0.36, 18), "#c49a86", [0, 0.18, 0], g);
  mk(cyl(0.18, 0.18, 0.02, 18), "#2e2a28", [0, 0.35, 0], g, { outline: 0, shadow: false });
  const cols = LINE ? ["#8fc25a", "#6fa848", "#a9d65c"] : ["#5d7d68", "#4f6e5b", "#6b8b74"];
  for (let i = 0; i < 4; i++) {
    mk(new THREE.ConeGeometry(0.24 - i * 0.045, 0.42, 10), leafMat(cols[i % 3]), [0, 0.55 + i * 0.25, 0], g, { outline: 0.012 });
  }
}
let steamFan = null;
let adminFanHit = null; // 환풍기 (누르면 관리자 로그인)
let doorSign = null;
const doorSignTex = {}; // 문 팻말: 영업 중 OPEN / 영업 끝 CLOSED

function makePlant(parent, x, z, k = 1) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.scale.setScalar(k);
  parent.add(g);
  mk(cyl(0.22, 0.17, 0.4, 16), "#d98b5f", [0, 0.2, 0], g);
  mk(new THREE.SphereGeometry(0.32, 16, 12), leafMat(LINE ? "#a9d65c" : "#6bbf7a"), [0, 0.72, 0], g, { outline: 0.02 });
  mk(new THREE.SphereGeometry(0.24, 16, 12), leafMat(LINE ? "#8fc25a" : "#58ad6a"), [0.18, 0.95, 0.05], g, { outline: 0.02 });
  mk(new THREE.SphereGeometry(0.2, 16, 12), leafMat(LINE ? "#c3e46e" : "#7fcc8a"), [-0.15, 1.05, -0.05], g, { outline: 0.02 });
  return g;
}

// ───────── 소품 ─────────
const doorPanels = [];
let doorOpen = 0;
const interactives = []; // 손님이 누를 수 있는 것 (소품·스크린)
const sayProps = []; // 말풍선이 있는 소품
const labelSprites = []; // 위에서 볼 때만 보이는 이름표
const steamSources = []; // 커피 김 나오는 곳 (월드 좌표)
const SAY_HEIGHT = { counter: 1.9, shelf: 2.25, plant: 1.55, lamp: 1.25, rug: 0.6 };
const HIT_SIZE = (p) => ({
  counter: [p.w, 1.5, p.d + 0.2, 0.75], shelf: [p.w, 0.9, 0.5, 1.75], plant: [0.7, 1.3, 0.7, 0.65],
  lamp: [0.6, 0.5, 0.6, R.wallH - 0.9], rug: [p.w, 0.05, p.d, 0.02],
}[p.type] || [0.6, 1, 0.6, 0.5]);

function buildProps() {
  for (const p of LAYOUT.props || []) {
    const g = new THREE.Group();
    g.position.set(p.x, 0, p.z);
    g.rotation.y = THREE.MathUtils.degToRad(-(p.rot || 0));
    (p.walkOnly ? fpGroup : roomGroup).add(g); // walkOnly: 낮은 벽에 붙은 것 → 1인칭에서만
    if (buildInteriorProp(p, g)) {
      if (p.say && g.userData.hit) addSayHit(p, g, g.userData.hit, g.userData.sayY);
      continue;
    } else if (p.type === "counter") {
      addObstacle(p.x, p.z, p.w / 2, p.d / 2, p.rot);
      mk(box(p.w, 1.0, p.d), "#f3e3cf", [0, 0.5, 0], g);
      mk(box(p.w + 0.1, 0.07, p.d + 0.1), COLOR.woodDark, [0, 1.03, 0], g);
      mk(box(p.w, 0.3, 0.04), R.accent, [0, 0.25, p.d / 2 + 0.01], g, { outline: 0 });
      // 커피머신 + 컵
      mk(box(0.6, 0.5, 0.45), "#5a5f66", [-p.w / 2 + 0.6, 1.32, 0], g);
      const [sx, sz] = rotXZ(-p.w / 2 + 0.6, 0.05, p.rot);
      steamSources.push(new THREE.Vector3(p.x + sx, 1.62, p.z + sz));
      mk(box(0.4, 0.06, 0.3), "#d0d4d8", [-p.w / 2 + 0.6, 1.1, 0.1], g, { outline: 0.01 });
      mk(box(0.5, 0.35, 0.4), "#e9edf1", [p.w / 2 - 0.5, 1.24, 0], g);
      for (let i = 0; i < 3; i++) mk(cyl(0.05, 0.04, 0.11, 12), "#ffffff", [0.2 * i - 0.2, 1.12, 0.15], g, { outline: 0.01 });
      if (p.label) {
        const s = textSprite(p.label, { size: 0.28 });
        s.position.set(0, 2.0, 0);
        g.add(s);
        labelSprites.push(s);
      }
    } else if (p.type === "shelf") {
      for (const y of [1.55, 2.0]) {
        mk(box(p.w, 0.05, 0.3), COLOR.wood, [0, y, 0], g);
        for (let i = 0; i < 6; i++) {
          const colors = ["#e8a87c", "#85c1a8", "#f3d27a", "#ffffff", "#c9a2d6", "#8ab6d6"];
          mk(cyl(0.07, 0.07, 0.2, 12), colors[(i + y * 3) % 6 | 0], [-p.w / 2 + 0.35 + i * (p.w - 0.7) / 5, y + 0.13, 0], g, { outline: 0.012 });
        }
      }
    } else if (p.type === "plant") {
      addObstacle(p.x, p.z, 0.3, 0.3);
      g.userData.wiggler = makePlant(g, 0, 0);
    } else if (p.type === "lamp") {
      const y = R.wallH;
      mk(cyl(0.008, 0.008, 0.8, 6), "#4a3a31", [0, y - 0.4, 0], g, { outline: 0, shadow: false });
      mk(new THREE.ConeGeometry(0.26, 0.24, 20, 1, true), toon("#f6c36a", { side: THREE.DoubleSide }), [0, y - 0.9, 0], g, { outline: 0, shadow: false });
      mk(new THREE.SphereGeometry(0.07, 12, 8), new THREE.MeshBasicMaterial({ color: "#fff7d6" }), [0, y - 0.98, 0], g, { outline: 0, shadow: false });
    } else if (p.type === "rug") {
      const r = mk(box(p.w, 0.015, p.d), p.color || "#d9b8a0", [0, 0.008, 0], g, { outline: 0, shadow: false });
      r.receiveShadow = true;
    }
    if (p.say) {
      const [w, h, d, y] = HIT_SIZE(p);
      const hb = new THREE.Mesh(box(w, h, d), hitMat);
      hb.position.y = y;
      const info = { kind: "prop", prop: p, group: g, idx: sayProps.length, wiggle: 0 };
      hb.userData = info;
      g.add(hb);
      interactives.push(hb);
      sayProps.push(info);
    }
  }
}

// ───────── 실내 가구/소품 (DIVE HIDE AWAY 사진 참고) ─────────
const glowMat = (color, opacity = 1) => new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
const innerGlows = []; // 밤에 더 밝아지는 실내 불빛 (재질, 기본 밝기)
const poolTex = canvasTex(128, 128, (g) => {
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, "rgba(255,255,255,1)"); grd.addColorStop(0.45, "rgba(255,255,255,.45)"); grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
});
const beamTex = canvasTex(32, 128, (g, w, h) => {
  const grd = g.createLinearGradient(0, 0, 0, h);
  grd.addColorStop(0, "rgba(255,255,255,1)"); grd.addColorStop(1, "rgba(255,255,255,.15)");
  g.fillStyle = grd; g.fillRect(0, 0, w, h);
});
/** 조명 아래 바닥/상판에 비치는 불빛 (parent 로컬 좌표) */
function lightPool(parent, x, y, z, w, d, color = "#ffad66", lo = 0.08, hi = 0.55) {
  const mat = new THREE.MeshBasicMaterial({ map: poolTex, color, transparent: true, opacity: lo, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, y, z);
  m.renderOrder = 2;
  parent.add(m);
  innerGlows.push([mat, lo, hi]);
  return m;
}

/** 모서리를 둥글린 경로 */
function roundedPath(pts, r) {
  const V = pts.map(([x, z]) => new THREE.Vector3(x, 0, z));
  const path = new THREE.CurvePath();
  let cur = V[0].clone();
  for (let i = 1; i < V.length; i++) {
    const p = V[i];
    if (i === V.length - 1) { path.add(new THREE.LineCurve3(cur, p.clone())); break; }
    const a0 = p.clone().sub(V[i - 1]), b0 = V[i + 1].clone().sub(p);
    const rr = Math.min(r, a0.length() / 2, b0.length() / 2);
    const a = p.clone().sub(a0.normalize().multiplyScalar(rr));
    const b = p.clone().add(b0.normalize().multiplyScalar(rr));
    path.add(new THREE.LineCurve3(cur, a));
    path.add(new THREE.QuadraticBezierCurve3(a, p.clone(), b));
    cur = b;
  }
  return path;
}
/** 경로를 따라 점 + 안쪽 방향 */
function pathSamples(curve, step = 0.2) {
  const n = Math.max(2, Math.ceil(curve.getLength() / step));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n, p = curve.getPointAt(u), t = curve.getTangentAt(u);
    out.push({ p, t, n: { x: t.z, z: -t.x }, u });
  }
  return out;
}
/** 경로를 따라 띠 모양 입체 (바 상판·몸통) */
function ribbonGeo(samples, half, h, y0 = 0, shift = 0) {
  const L = samples.map((s) => [s.p.x + s.n.x * (half + shift), s.p.z + s.n.z * (half + shift)]);
  const Rr = samples.map((s) => [s.p.x - s.n.x * (half - shift), s.p.z - s.n.z * (half - shift)]).reverse();
  return slabGeo([...L, ...Rr], h, y0);
}
function ribbon(samples, half, h, y0, mat, parent, ol = 0.02, shift = 0) {
  const m = new THREE.Mesh(ribbonGeo(samples, half, h, y0, shift), typeof mat === "string" ? toon(mat) : mat);
  parent.add(m);
  if (ol) {
    const k = ol * OL;
    const o = new THREE.Mesh(ribbonGeo(samples, half + k, h + k * 2, y0 - k, shift), outlineMat);
    o.userData.rebuild = (f) => ribbonGeo(samples, half + k * f, h + k * f * 2, y0 - k * f, shift);
    o.raycast = () => {};
    parent.add(o);
  }
  return m;
}
/** 경로 옆면을 따라 세운 띠 (LED 불빛) */
function stripAlong(samples, offset, y0, y1, mat, parent) {
  const pos = [], uv = [], idx = [];
  samples.forEach((s, i) => {
    const x = s.p.x + s.n.x * offset, z = s.p.z + s.n.z * offset;
    pos.push(x, y0, z, x, y1, z);
    uv.push(s.u, 0, s.u, 1);
    if (i) { const a = (i - 1) * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  const m = new THREE.Mesh(g, mat);
  m.renderOrder = 2;
  parent.add(m);
  return m;
}
const ledTex = canvasTex(4, 128, (g, w, h) => {
  // 사진처럼: 맨 위 밝은 띠 → 바 몸통 위쪽 주황 → 아래로 짙게 어두워짐
  const grd = g.createLinearGradient(0, 0, 0, h);
  grd.addColorStop(0, "rgba(255,190,120,1)"); grd.addColorStop(0.04, "rgba(255,150,80,.85)"); grd.addColorStop(0.3, "rgba(240,110,60,.45)");
  grd.addColorStop(0.65, "rgba(200,80,40,.12)"); grd.addColorStop(1, "rgba(160,60,30,0)");
  g.fillStyle = grd; g.fillRect(0, 0, w, h);
});
const ledFloorTex = canvasTex(4, 64, (g, w, h) => {
  const grd = g.createLinearGradient(0, 0, 0, h);
  grd.addColorStop(0, "rgba(255,140,70,.7)"); grd.addColorStop(1, "rgba(255,120,60,0)");
  g.fillStyle = grd; g.fillRect(0, 0, w, h);
});
/** 경로를 따라 바닥에 깐 띠 (바 앞 바닥 번짐) */
function floorStripAlong(samples, o0, o1, y, mat, parent) {
  const pos = [], uv = [], idx = [];
  samples.forEach((s, i) => {
    pos.push(s.p.x + s.n.x * o0, y, s.p.z + s.n.z * o0, s.p.x + s.n.x * o1, y, s.p.z + s.n.z * o1);
    uv.push(s.u, 1, s.u, 0);
    if (i) { const a = (i - 1) * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  const m = new THREE.Mesh(g, mat);
  m.renderOrder = 2;
  parent.add(m);
  return m;
}

/** 곡선 바 + 바 의자 */
function buildCurvedBar(b) {
  const curve = roundedPath(b.path, b.radius ?? 1.0);
  const S = pathSamples(curve, 0.15);
  // 몸통 (주황빛 원목) + 상판 (짙은 원목, 손님 쪽으로 튀어나옴)
  const bh = (b.depth ?? 0.44) / 2; // 몸통 두께의 절반
  // 몸통: 손님 쪽은 막힌 판, 바텐더 쪽(-n)은 움푹 들어간 2단 선반 (비워 둠: 제빙기·냉장고 자리)
  const body = b.body || "#8e4a2c", RD = 0.45, back = -bh + RD; // 선반 안쪽 깊이, 뒤판 위치
  aimBlockers.push(ribbon(S, (bh - back) / 2, 0.98, 0, body, roomGroup, 0.012, (bh + back) / 2));  // 손님 쪽 막힌 부분
  ribbon(S, RD / 2, 0.08, 0, body, roomGroup, 0.008, (-bh + back) / 2);       // 아래 받침
  ribbon(S, RD / 2, 0.05, 0.93, body, roomGroup, 0.006, (-bh + back) / 2);    // 상판 바로 아래 띠
  const inner = toon("#3b2418", { side: THREE.DoubleSide });
  stripAlong(S, back - 0.002, 0.08, 0.93, inner, roomGroup).renderOrder = 0;   // 안쪽 뒤판 (짙게)
  // 가운데 선반 (제빙기·냉장고가 들어간 자리는 비움)
  const apps = (LAYOUT.props || []).filter((q) => q.type === "icemaker" || q.type === "fridge");
  const freeAt = (sm) => { const c = (-bh + back) / 2, x = sm.p.x + sm.n.x * c, z = sm.p.z + sm.n.z * c;
    return !apps.some((a) => { const [lx, lz] = rotXZ(x - a.x, z - a.z, -(a.rot || 0)); return Math.abs(lx) < (a.w ?? 0.64) / 2 + 0.04 && Math.abs(lz) < 0.4; }); };
  const runs = (arr) => { const out = []; let cur = []; for (const sm of arr) { if (freeAt(sm)) cur.push(sm); else { if (cur.length > 1) out.push(cur); cur = []; } } if (cur.length > 1) out.push(cur); return out; };
  for (const run of runs(S)) ribbon(run, (RD - 0.04) / 2, 0.025, 0.49, "#6a3a22", roomGroup, 0.005, (-bh + back) / 2 + 0.02);
  // 3구역 칸막이: 양 끝 + 통창 모서리 두 곳 (경로 꺾이는 점에 가장 가까운 곳)
  const near = (pt) => S.reduce((bi, s, i) => (Math.hypot(s.p.x - pt[0], s.p.z - pt[1]) < Math.hypot(S[bi].p.x - pt[0], S[bi].p.z - pt[1]) ? i : bi), 0);
  const cuts = [0, ...b.path.slice(1, -1).map(near), S.length - 1];
  for (const ci of cuts) {
    const s0 = S[ci], c = (-bh + back) / 2;
    const m = mk(box(0.04, 0.85, RD), body, [s0.p.x + s0.n.x * c, 0.08 + 0.425, s0.p.z + s0.n.z * c], roomGroup, { outline: 0.006, shadow: false });
    m.rotation.y = Math.atan2(-s0.t.z, s0.t.x);
  }
  // 구역마다 상판 아래 은은한 선반 조명 (위가 밝고 아래로 사라짐)
  for (let k = 0; k < cuts.length - 1; k++) {
    const sub = S.slice(cuts[k] + 1, cuts[k + 1]);
    if (sub.length < 2) continue;
    const wash = new THREE.MeshBasicMaterial({ map: ledTex, color: "#ffd2a0", transparent: true, side: THREE.DoubleSide, depthWrite: false, opacity: 0.1, blending: THREE.AdditiveBlending });
    stripAlong(sub, back - 0.006, 0.09, 0.925, wash, roomGroup);
    innerGlows.push([wash, 0.3, 0.75]);
    // (polygonOffset 은 비스듬히 볼 때 바 몸통을 뚫고 보여서 쓰지 않고, 면 위로 살짝 띄움)
    for (const fy of [0.085, 0.52]) { // 선반 바닥에 고이는 불빛
      const fm = new THREE.MeshBasicMaterial({ map: ledFloorTex, color: "#ffc890", transparent: true, depthWrite: false, opacity: 0.3, blending: THREE.AdditiveBlending });
      for (const run of fy > 0.3 ? runs(sub) : [sub]) floorStripAlong(run, back - 0.01, -bh + 0.02, fy, fm, roomGroup);
      innerGlows.push([fm, fy > 0.3 ? 0.25 : 0.15, fy > 0.3 ? 0.6 : 0.4]);
    }
    { // 선반 불빛이 바텐더 쪽 바닥으로 살짝 새어 나옴
      const fl = new THREE.MeshBasicMaterial({ map: ledFloorTex, color: "#ffc890", transparent: true, depthWrite: false, opacity: 0.15, blending: THREE.AdditiveBlending });
      floorStripAlong(sub, -bh - 0.01, -bh - 0.55, 0.02, fl, roomGroup);
      innerGlows.push([fl, 0.08, 0.3]);
    }
    const line = new THREE.MeshBasicMaterial({ color: "#ffd9a8", transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false });
    stripAlong(sub, -bh + 0.06, 0.915, 0.928, line, roomGroup);
    innerGlows.push([line, 0.5, 1]);
  }
  // 상판: 손님 쪽 처마 그대로 + 바텐더 쪽도 처마처럼 늘림
  const topIn = bh + 0.15, topOut = bh + 0.18;
  ribbon(S, (topIn + topOut) / 2, 0.06, 0.98, b.top || "#6e4127", roomGroup, 0.018, (topOut - topIn) / 2);
  // LED: 상판 아래로 은은하게
  const led = new THREE.MeshBasicMaterial({ map: ledTex, transparent: true, side: THREE.DoubleSide, depthWrite: false, opacity: 0.1 });
  stripAlong(S, bh + 0.006, 0.02, 0.965, led, roomGroup);
  innerGlows.push([led, 0.06, 0.95]);
  const ledLine = new THREE.MeshBasicMaterial({ color: "#ffc58a", transparent: true, opacity: 0.2, depthWrite: false });
  stripAlong(S, bh + 0.008, 0.95, 0.968, ledLine, roomGroup); // 상판 바로 아래 가는 LED 띠
  innerGlows.push([ledLine, 0.1, 1]);
  const ledFloor = new THREE.MeshBasicMaterial({ map: ledFloorTex, transparent: true, depthWrite: false, opacity: 0, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  floorStripAlong(S, bh + 0.01, bh + 0.75, 0.014, ledFloor, roomGroup); // 바 앞 바닥 은은한 주황
  innerGlows.push([ledFloor, 0, 0.35]);
  // 부딪힘
  for (let i = 0; i < S.length - 1; i += 3) {
    const a = S[i], c = S[Math.min(i + 3, S.length - 1)];
    const len = a.p.distanceTo(c.p);
    addObstacle((a.p.x + c.p.x) / 2, (a.p.z + c.p.z) / 2, len / 2 + 0.05, bh + 0.12, THREE.MathUtils.radToDeg(Math.atan2(c.p.z - a.p.z, c.p.x - a.p.x)));
  }
  // 손님은 바 안쪽(바텐더 자리)으로 못 들어가게 양 끝을 막음
  for (const [x, z, hw, hd] of b.block || []) addObstacle(x, z, hw, hd);
  // 이름표
  const mid = curve.getPointAt(0.5);
  const label = textSprite(b.id, { size: 0.26 });
  label.position.set(mid.x, 2.0, mid.z);
  roomGroup.add(label);
  labelSprites.push(label);
  // 의자
  const ids = [];
  const margin = 0.35 / curve.getLength();
  for (let i = 0; i < b.seats; i++) {
    const u = margin + (1 - 2 * margin) * (b.seats === 1 ? 0.5 : i / (b.seats - 1));
    const p = curve.getPointAt(u), t = curve.getTangentAt(u);
    const n = { x: t.z, z: -t.x };
    const id = `${b.id}-${i + 1}`;
    const off = bh + 0.4; // 상판 바깥으로 의자
    addSeat(id, p.x + n.x * off, p.z + n.z * off, Math.atan2(-n.x, -n.z), b.chair || "barstool");
    ids.push(id);
  }
  // 따로 지정한 자리 (예: 바 안쪽에서 마주 보는 자리). face = 바라보는 방향 [x, z]
  for (const [x, z, fx, fz] of b.extraSeats || []) {
    const id = `${b.id}-${ids.length + 1}`;
    addSeat(id, x, z, Math.atan2(fx, fz), b.chair || "barstool");
    ids.push(id);
  }
  tableGroups.push({ id: b.id, seatIds: ids });
  if (b.say) addSayHit({ ...b, type: "bar", x: mid.x, z: mid.z }, null, [1.2, 1.1, 1.2, 0.6], 1.5, mid);
}

/** 뒷선반 (창 아래, 술병) */
const SPEAKERS = (LAYOUT.props || []).filter((p) => p.type === "speaker");
function buildBackbar(p) {
  const curve = roundedPath(p.path, 0.25);
  const S = pathSamples(curve, 0.15);
  ribbon(S, (p.d ?? 0.45) / 2, p.h ?? 0.95, 0, p.color || "#5a3a2b", roomGroup, 0.015);
  ribbon(S, (p.d ?? 0.45) / 2 + 0.02, 0.04, p.h ?? 0.95, "#3e2a20", roomGroup, 0.01);
  { // 창 쪽 면: 사선 무늬 나무 패널 + 위에서 비추는 은은한 주황 조명 (밖에서 유리 너머로 보임)
    const hh = p.h ?? 0.95, off = -((p.d ?? 0.45) / 2 + 0.006), Lc = curve.getLength();
    const stripes = canvasTex(128, 128, (c, w, h) => {
      c.fillStyle = "#a0603f"; c.fillRect(0, 0, w, h);
      c.strokeStyle = "rgba(70,35,20,.5)"; c.lineWidth = 4;
      for (let i = -h; i < w + h; i += 16) { c.beginPath(); c.moveTo(i, h); c.lineTo(i + h, 0); c.stroke(); }
    });
    stripes.wrapS = stripes.wrapT = THREE.RepeatWrapping; stripes.repeat.set(Lc / 0.45, 2);
    const pm = new THREE.MeshBasicMaterial({ map: stripes, side: THREE.DoubleSide });
    registerTint(pm);
    stripAlong(S, off, 0.02, hh - 0.01, pm, roomGroup);
    const wash = new THREE.MeshBasicMaterial({ map: ledTex, transparent: true, side: THREE.DoubleSide, depthWrite: false, opacity: 0.1, blending: THREE.AdditiveBlending });
    stripAlong(S, off - 0.004, 0.02, hh - 0.01, wash, roomGroup);
    innerGlows.push([wash, 0.08, 0.7]);
    const line = new THREE.MeshBasicMaterial({ color: "#ffc58a", transparent: true, opacity: 0.2, side: THREE.DoubleSide });
    stripAlong(S, off - 0.006, hh - 0.04, hh - 0.015, line, roomGroup);
    innerGlows.push([line, 0.15, 1]);
  }
  for (let i = 0; i < p.path.length - 1; i++) { // 사람이 통과하지 못하게
    const [ax, az] = p.path[i], [bx, bz] = p.path[i + 1];
    addObstacle((ax + bx) / 2, (az + bz) / 2, Math.hypot(bx - ax, bz - az) / 2 + 0.02, (p.d ?? 0.45) / 2 + 0.03, THREE.MathUtils.radToDeg(Math.atan2(bz - az, bx - ax)));
  }
  // 술병들 (군데군데 모아서)
  const cols = ["#7a3b2e", "#c9a54a", "#3f6b4a", "#e9e2c8", "#8a5a2b", "#2e3f5c", "#b8432f", "#d9c27a", "#f1efe4"];
  let seed = 5;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const L = curve.getLength(), y = (p.h ?? 0.95) + 0.04;
  for (let s = 0.2; s < L - 0.2; s += 0.13) {
    if (Math.floor(s / 1.1) % 3 === 2) continue; // 빈 칸
    const q = curve.getPointAt(s / L), t = curve.getTangentAt(s / L);
    if (SPEAKERS.some((sp) => Math.hypot(sp.x - q.x, sp.z - q.z) < 0.4)) continue; // 스피커 자리는 비움
    const off = (rnd() - 0.5) * 0.18;
    const x = q.x + t.z * off, z = q.z - t.x * off;
    const h = 0.22 + rnd() * 0.16, r = 0.035 + rnd() * 0.02;
    const c = cols[Math.floor(rnd() * cols.length)];
    mk(cyl(r, r, h, 10), c, [x, y + h / 2, z], roomGroup, { outline: 0.006, shadow: false });
    mk(cyl(r * 0.4, r * 0.5, 0.08, 8), c, [x, y + h + 0.04, z], roomGroup, { outline: 0.004, shadow: false });
  }
}

// 손으로 그린 라탄/등나무 무늬
const caneTex = canvasTex(128, 128, (g, w, h) => {
  g.fillStyle = "#d9b27c"; g.fillRect(0, 0, w, h);
  g.strokeStyle = "rgba(120,80,40,.55)"; g.lineWidth = 3;
  for (let i = 0; i < w; i += 16) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i + h, h); g.stroke();
    g.beginPath(); g.moveTo(i + 16, 0); g.lineTo(i + 16 - h, h); g.stroke();
  }
  g.fillStyle = "rgba(90,60,30,.6)";
  for (let y = 8; y < h; y += 16) for (let x = 8; x < w; x += 16) { g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill(); }
}, [2, 2]);
const pleatTex = canvasTex(256, 64, (g, w, h) => {
  g.fillStyle = "#ffe0bd"; g.fillRect(0, 0, w, h);
  g.strokeStyle = "rgba(200,130,80,.45)"; g.lineWidth = 2;
  for (let x = 0; x < w; x += 8) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
});
const weaveTex = canvasTex(128, 128, (g, w, h) => {
  g.fillStyle = "#e9b878"; g.fillRect(0, 0, w, h);
  g.fillStyle = "rgba(140,90,40,.55)";
  for (let y = 0; y < h; y += 10) for (let x = (y / 10) % 2 ? 5 : 0; x < w; x += 10) g.fillRect(x, y, 5, 5);
}, [4, 2]);

// 빛 기둥: 위(조명 쪽)가 조금 밝고 아래로 옅어짐, 좌우 가장자리 흐림
const beamFadeTex = canvasTex(64, 128, (c, w, h) => {
  for (let y = 0; y < h; y++) {
    const a = 0.35 + 0.65 * (1 - y / h);
    const grd = c.createLinearGradient(0, 0, w, 0);
    grd.addColorStop(0, "rgba(255,255,255,0)"); grd.addColorStop(0.2, `rgba(255,255,255,${a})`); grd.addColorStop(0.8, `rgba(255,255,255,${a})`); grd.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = grd; c.fillRect(0, h - 1 - y, w, 1);
  }
});
// 상판 위 띠: 길이 방향은 거의 고르게(끝만 흐림), 폭 방향은 가운데가 밝고 가장자리 부드럽게
const bandTex = canvasTex(256, 64, (c, w, h) => {
  const img = c.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (x - (w - 1) / 2) / ((w - 1) / 2), dy = (y - (h - 1) / 2) / ((h - 1) / 2);
    const a = Math.exp(-dx * dx * 1.6) * Math.exp(-dy * dy * 3.0) * (1 - Math.pow(Math.abs(dx), 6)); // 테두리 없이 사라짐
    const i = (y * w + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = 255; img.data[i + 3] = Math.round(a * 255);
  }
  c.putImageData(img, 0, 0);
});

const iceMakers = [];
const iceGeo = new THREE.BoxGeometry(0.045, 0.045, 0.045);
const iceMat = new THREE.MeshBasicMaterial({ color: "#d8f1fb", transparent: true, opacity: 0.8 });
/** 제빙기 3번 누르면: 문이 덜컥 열리고 네모 얼음이 드르륵 밀려 나와 쏟아짐 */
function spillIce(g) {
  const u = g.userData.ice;
  if (u.t >= 0) return;
  u.t = 0;
  const cubes = [];
  for (let i = 0; i < 26; i++) {
    const c = mk(iceGeo, iceMat, [0, 0, 0], g, { outline: 0.003, shadow: false });
    c.visible = false;
    cubes.push({ c, d: 0.25 + Math.random() * 0.8, x: (Math.random() - 0.5) * (u.W - 0.12), vy: 0, y: 0, z: 0, fall: Math.random() < 0.35, stop: 0.25 + Math.random() * 0.7, spin: (Math.random() - 0.5) * 6 });
  }
  u.cubes = cubes;
  if (!store.get("ice-spill")) { store.set("ice-spill", "1"); setTimeout(() => toast("숨은 재미 발견!\n얼음이 드르륵", 1600), 900); }
}
function updateIce(dt) {
  for (const g of iceMakers) {
    const u = g.userData.ice;
    if (u.t < 0) continue;
    u.t += dt;
    const t = u.t;
    const want = t < 4.6 ? 1 : 0;
    u.open += (want - u.open) * Math.min(1, dt * (want ? 9 : 4));
    const r = u.open * 1.45; u.door.rotation.x = r; // 아래 경첩으로 바텐더 쪽 아래로 열림
    const dz = Math.sin(r) * u.dh, dy = Math.cos(r) * u.dh;
    for (const k of u.cubes) {
      const s0 = t - k.d; // 얼음 더미 앞쪽에서 차례로 밀려 나옴
      if (s0 < 0) continue;
      k.c.visible = t < 5.2;
      if (!k.c.visible) continue;
      if (!k.fall || s0 < 0.45) { // 드르륵: 더미 앞 → 열린 문 위로 미끄러짐
        const q = Math.min(1, s0 / 0.45) * (k.fall ? 1 : k.stop);
        k.z = u.fz - 0.06 + 0.06 * Math.min(1, s0 / 0.15) + q * dz; k.y = u.dyb + 0.03 + q * dy * 0.98 + (1 - Math.min(1, s0 / 0.15)) * 0.06;
      } else { // 문 끝에서 바닥으로
        k.vy -= 9.8 * dt; k.y = Math.max(0.023, k.y + k.vy * dt); k.z += dt * 0.5;
        if (k.y <= 0.023) k.vy = 0;
      }
      k.c.position.set(k.x + Math.sin(s0 * 30) * 0.002 * (s0 < 0.45 ? 1 : 0), k.y, k.z);
      k.c.rotation.set(k.spin * Math.min(s0, 0.6), k.spin * 0.5 * Math.min(s0, 0.6), 0);
      if (t > 4.4) k.c.scale.setScalar(Math.max(0.001, 1 - (t - 4.4) / 0.8));
    }
    if (t > 6.2) { for (const k of u.cubes) g.remove(k.c); u.cubes = []; u.t = -1; u.door.rotation.x = 0; u.open = 0; }
  }
  for (const g of fridges) updateFridge(g, dt);
  updateAc(dt);
}
const fridges = [];
const airCons = [];
function updateAc(dt, time) {
  for (const g of airCons) {
    const u = g.userData.ac;
    if (u.t < 0 && storeInfo?.acOn && isOpenNow()) u.t = 0; // 실제 에어컨이 켜져 있으면 날개가 계속 천천히 움직임
    if (u.t < 0) continue; u.t += dt;
    const on = storeInfo?.acOn && isOpenNow();
    const a = Math.sin(u.t * 1.4) * 0.45 * (on ? Math.min(1, u.t) : Math.min(1, u.t, Math.max(0, 6 - (u.t % 1e6))));
    u.flaps.forEach((f) => (f.rotation.x = -0.35 + a));
    if (!on && u.t > 6) { u.t = -1; u.flaps.forEach((f) => (f.rotation.x = -0.35)); } }
}
function spillMilk(g) {
  const u = g.userData.fr;
  if (u.t >= 0) return;
  u.t = 0;
  if (!store.get("milk-spill")) { store.set("milk-spill", "1"); setTimeout(() => toast("숨은 재미 발견!\n앗, 우유가 쏟아졌어요", 1700), 1300); }
}
function freezerPuff(g) {
  const u = g.userData.fr;
  if (u.ft >= 0) return;
  u.ft = 0;
  for (let i = 0; i < 6; i++) { // 하얀 냉기가 흘러나와 아래로 퍼짐
    const m = new THREE.Mesh(steamGeo, new THREE.MeshBasicMaterial({ color: "#eef8ff", transparent: true, opacity: 0, depthWrite: false }));
    const x0 = -0.3 + (Math.random() - 0.5) * 0.4, y0 = u.cyb + 0.1 + Math.random() * 0.4;
    m.position.set(x0, y0, u.fz + 0.05); g.add(m);
    addEffect(m, g, 2.2, (e) => { const k = e.t / e.life; m.position.set(x0 + k * 0.1, Math.max(0.05, y0 - k * 0.45), u.fz + 0.05 + k * 0.4); m.scale.setScalar(0.6 + k * 1.6); m.material.opacity = 0.55 * Math.sin(Math.PI * Math.min(1, k + 0.05)); });
  }
}
function updateFridge(g, dt) {
  const u = g.userData.fr;
  if (u.ft >= 0) { u.ft += dt; const a = u.ft < 1.6 ? Math.min(1, u.ft / 0.3) : Math.max(0, 1 - (u.ft - 1.6) / 0.4); u.doors[0].rotation.y = -0.55 * a; if (u.ft > 2.1) { u.ft = -1; u.doors[0].rotation.y = 0; } }
  if (u.t < 0) return;
  u.t += dt;
  const t = u.t;
  const open = t < 5.3 ? Math.min(1, t / 0.3) : Math.max(0, 1 - (t - 5.3) / 0.5);
  u.doors[1].rotation.y = 1.7 * open; // 냉장 문 활짝
  // 우유: 기우뚱 → 앞으로 쓰러짐 → 흐름 → 우유팩·웅덩이가 그 자리에서 스르르 사라짐 → 문 닫힘 → 안쪽에 새 우유
  let tilt = 0;
  if (t > 0.4) tilt = t < 0.7 ? Math.sin((t - 0.4) * 40) * 0.12 : Math.min(Math.PI / 2, ((t - 0.7) / 0.35) ** 2 * (Math.PI / 2));
  if (t < 5.9) u.milkPivot.rotation.x = tilt;
  const fade = t < 3.9 ? 1 : Math.max(0, 1 - (t - 3.9) / 1.2);
  u.milk.traverse((o) => { if (!o.isMesh) return; if (o.material.transparent && o.material !== u.puddle.material) o.material.opacity = fade; else o.visible = fade > 0.95; });
  const leaking = t > 1.1 && t < 4.6;
  u.stream.visible = leaking;
  if (leaking) { const top = u.cyb + 0.03; u.stream.scale.y = top; u.stream.position.set(u.mx, top / 2, u.fz + 0.2); u.stream.material.opacity = Math.min(1, fade + 0.2); }
  u.puddle.scale.setScalar(t < 1.1 ? 0.001 : Math.max(0.001, Math.min(1, (t - 1.1) / 3)));
  u.puddle.material.opacity = 0.9 * fade;
  if (t > 5.9) { // 문이 닫힌 뒤: 새 우유팩이 원래 자리에
    u.milkPivot.rotation.x = 0; u.milk.traverse((o) => { if (!o.isMesh) return; o.visible = true; if (o.material.transparent) o.material.opacity = 1; });
    u.puddle.scale.setScalar(0.001); u.puddle.material.opacity = 0.9; u.stream.visible = false; u.doors[1].rotation.y = 0; u.t = -1;
  }
}
/** 실내 소품 만들기 (layout.props 의 새 종류들) */
function buildInteriorProp(p, g) {
  const H = R.wallH;
  const dark = "#2a2522";
  switch (p.type) {
    case "backbar": buildBackbar(p); return true;
    case "floorlamp": { // 주름 갓 스탠드
      const y0 = p.y0 ?? 0, h = p.h ?? 1.5;
      mk(cyl(0.13, 0.15, 0.03, 18), dark, [0, y0 + 0.015, 0], g, { outline: 0.008, shadow: false });
      mk(cyl(0.012, 0.012, h - 0.2, 6), "#b08a4a", [0, y0 + (h - 0.2) / 2, 0], g, { outline: 0.004, shadow: false });
      const shade = new THREE.MeshBasicMaterial({ map: pleatTex, side: THREE.DoubleSide });
      const big = h > 1.2; // 바닥에 세운 긴 스탠드는 갓도 크게
      mk(new THREE.CylinderGeometry(big ? 0.17 : 0.14, big ? 0.28 : 0.23, big ? 0.42 : 0.34, 28, 1, true), shade, [0, y0 + h - 0.05, 0], g, { outline: 0.012, shadow: false });
      addHalo(g, 0, y0 + h - 0.1, 0, 1.4, "#ffc2c8", true);
      lightPool(g, 0, y0 + 0.018, 0, 1.9, 1.9);
      g.userData.hit = [0.5, h, 0.5, y0 + h / 2]; g.userData.sayY = y0 + h + 0.3;
      return true;
    }
    case "pendant": {
      const y = p.y ?? H - 0.75;
      const cordTop = H;
      if (p.kind === "linear") { // 나무 막대 조명 (아래로 LED)
        const len = p.len ?? 1.8;
        for (const sx of [-1, 1]) mk(cyl(0.006, 0.006, cordTop - y, 4), dark, [sx * len * 0.4, (cordTop + y) / 2, 0], g, { outline: 0, shadow: false });
        mk(box(len, 0.12, 0.13), "#3b2a22", [0, y, 0], g, { outline: 0.012, shadow: false });
        const m = glowMat("#ffbf74");
        mk(new THREE.PlaneGeometry(len - 0.06, 0.05), m, [0, y - 0.061, 0], g, { outline: 0, shadow: false }).rotation.x = Math.PI / 2;
        addHalo(g, -len * 0.25, y - 0.2, 0, 1.0, "#ffd08a", true);
        addHalo(g, len * 0.25, y - 0.2, 0, 1.0, "#ffd08a", true);
        // 상판에 고이는 부드러운 빛 (조명 아래가 가장 밝고 둘레로 서서히 사라짐, 폭 ≈ 상판 1/3)
        {
          const L2 = p.glowLen ?? len + 1.2, off = p.glowOff ?? 0, w2 = 0.24;
          // (공중 빛 기둥 도형은 없앰: 판처럼 보여 부자연스러움)
          const band = new THREE.Mesh(new THREE.PlaneGeometry(L2, w2 * 2), new THREE.MeshBasicMaterial({ map: bandTex, color: "#ffb065", transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
          band.rotation.x = -Math.PI / 2; band.position.set(off, 1.046, 0); band.renderOrder = 2; g.add(band);
          innerGlows.push([band.material, 0.06, 0.22]);
        }
        // (예전: 바 상판 위 가늘고 긴 한 줄기 빛)
        lightPool(g, 0, 0.015, 0, len + 1.2, 1.6, "#ff9a55", 0.03, 0.22);

        g.userData.hit = [len, 0.3, 0.3, y]; g.userData.sayY = y + 0.15;
      } else if (p.kind === "beehive") { // 벌집 모양 원목 펜던트
        mk(cyl(0.006, 0.006, cordTop - y - 0.2, 4), dark, [0, (cordTop + y + 0.2) / 2, 0], g, { outline: 0, shadow: false });
        const m = glowMat("#f0b47a");
        [0.12, 0.2, 0.25, 0.27, 0.25, 0.2].forEach((r, i) => mk(new THREE.CylinderGeometry(r, r + 0.02, 0.05, 24, 1, true), m, [0, y + 0.18 - i * 0.07, 0], g, { outline: 0.008, shadow: false }));
        mk(new THREE.SphereGeometry(0.07, 10, 8), glowMat("#ffd49a"), [0, y - 0.15, 0], g, { outline: 0, shadow: false });
        addHalo(g, 0, y - 0.05, 0, 1.6, "#ffc98f", true);
        lightPool(g, 0, 0.016, 0, 2.2, 2.2);
        g.userData.hit = [0.6, 0.5, 0.6, y]; g.userData.sayY = y + 0.35;
      } else { // 라탄 펜던트
        mk(cyl(0.006, 0.006, cordTop - y - 0.25, 4), dark, [0, (cordTop + y + 0.25) / 2, 0], g, { outline: 0, shadow: false });
        const prof = [[0.08, 0.26], [0.2, 0.24], [0.27, 0.16], [0.22, 0.06], [0.29, -0.04], [0.31, -0.12], [0.24, -0.2], [0.14, -0.24]].map(([r, yy]) => new THREE.Vector2(r, yy));
        const m = new THREE.MeshBasicMaterial({ map: weaveTex, side: THREE.DoubleSide });
        mk(new THREE.LatheGeometry(prof, 24), m, [0, y, 0], g, { outline: 0, shadow: false });
        for (const [r, yy] of [[0.08, 0.26], [0.31, -0.12], [0.14, -0.24]]) mk(new THREE.TorusGeometry(r, 0.008 * OL, 5, 28), "#2b2522", [0, y + yy, 0], g, { outline: 0, shadow: false }).rotation.x = Math.PI / 2;
        mk(new THREE.SphereGeometry(0.06, 10, 8), glowMat("#ffd9a0"), [0, y - 0.02, 0], g, { outline: 0, shadow: false });
        addHalo(g, 0, y, 0, 1.8, "#ffcf96", true);
        lightPool(g, 0, 0.017, 0, 2.4, 2.4);
        g.userData.hit = [0.7, 0.6, 0.7, y]; g.userData.sayY = y + 0.35;
      }
      return true;
    }
    case "bigplant": {
      const k = p.h ?? 1.8;
      mk(cyl(0.24, 0.2, 0.5, 18), p.pot || "#eeeae4", [0, 0.25, 0], g, { outline: 0.015 });
      if (p.kind === "palm") {
        for (let s = 0; s < 3; s++) {
          const sx = (s - 1) * 0.07, h = k * (0.75 + s * 0.12);
          mk(cyl(0.015, 0.02, h - 0.5, 6), "#9aa86a", [sx, 0.5 + (h - 0.5) / 2, 0], g, { outline: 0.006 });
          const n = 8;
          for (let i = 0; i < n; i++) {
            // 방향(yaw)을 먼저 정하고 그 안에서 바깥으로 눕힘 → 잎이 사방으로 퍼짐
            const yaw = new THREE.Group();
            yaw.position.set(sx, h - (i % 3) * 0.08, 0);
            // front: 잎을 앞(테이블 쪽, 화분 로컬 +z) 반원으로만 → 뒤의 전자칠판과 안 겹침
            yaw.rotation.y = p.front ? -1.45 + (2.9 * i) / (n - 1) + (s - 1) * 0.2 : (i / n) * Math.PI * 2 + s * 0.8;
            g.add(yaw);
            const col = i % 2 ? "#3f8a4f" : "#5aa65a";
            const up = new THREE.Group(); up.rotation.x = (p.front ? 0.7 : 0.55) + (i % 3) * 0.15; yaw.add(up); // 위로 뻗다가
            const a = mk(new THREE.SphereGeometry(0.06, 8, 6), leafMat(col), [0, 0.2, 0], up, { outline: 0.006 });
            a.scale.set(1.3, 3.6, 0.16);
            const down = new THREE.Group(); down.position.y = 0.4; down.rotation.x = 0.75; up.add(down); // 끝은 아래로 늘어짐
            const b = mk(new THREE.SphereGeometry(0.06, 8, 6), leafMat(col), [0, 0.2, 0], down, { outline: 0.006 });
            b.scale.set(1.1, 3.6, 0.15);
          }
        }
      } else if (p.kind === "norfolk") {
        mk(cyl(0.025, 0.035, k - 0.4, 6), "#6b4a2e", [0, 0.5 + (k - 0.4) / 2, 0], g, { outline: 0.006 });
        for (let t = 0; t < 5; t++) {
          const y = 0.85 + t * (k - 0.6) / 5, len = 0.55 - t * 0.08;
          for (let i = 0; i < 5; i++) {
            const arm = new THREE.Group();
            arm.position.set(0, y, 0); arm.rotation.set(0, i * 1.26 + t * 0.5, 0);
            g.add(arm);
            const m = mk(new THREE.SphereGeometry(0.06, 8, 6), leafMat(t % 2 ? "#2f6e48" : "#3f8457"), [len / 2, -0.06, 0], arm, { outline: 0.006 });
            m.scale.set(len / 0.12, 0.35, 1.1);
            m.rotation.z = -0.25;
          }
        }
      } else if (p.kind === "umbrella") { // 키 큰 홍콩야자: 가는 줄기 + 손바닥 모양 잎 뭉치가 우산처럼
        mk(cyl(0.02, 0.035, k - 0.5, 6), "#9a8a6a", [0, 0.5 + (k - 0.5) / 2, 0], g, { outline: 0.006 });
        let sd = 13;
        const rr = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
        const leafG = new THREE.SphereGeometry(0.045, 6, 5);
        for (let c = 0; c < 16; c++) {
          const y = 1.0 + rr() * (k - 1.0), a = rr() * Math.PI * 2, r = 0.12 + rr() * (0.35 + (y - 1) * 0.25);
          const cl = new THREE.Group(); cl.position.set(Math.cos(a) * r, y, Math.sin(a) * r); cl.rotation.set(rr() * 0.5 - 0.25, rr() * 6, 0.35 + rr() * 0.3); g.add(cl);
          for (let l = 0; l < 7; l++) { // 손바닥 모양으로 7장
            const lg = new THREE.Group(); lg.rotation.y = (l / 7) * Math.PI * 2; cl.add(lg);
            const m = mk(leafG, leafMat(l % 2 ? "#2f5a33" : "#3d6e3f"), [0.11, 0, 0], lg, { outline: 0.004 });
            m.scale.set(2.6, 0.18, 0.9);
          }
        }
      } else { // 홍콩야자 (나무 모양)
        mk(cyl(0.03, 0.045, k - 0.5, 6), "#7a5a3a", [0, 0.5 + (k - 0.5) / 2, 0], g, { outline: 0.006 });
        for (const [x, y, z, r] of [[0, k, 0, 0.32], [0.25, k - 0.25, 0.05, 0.26], [-0.22, k - 0.35, -0.05, 0.27], [0.05, k - 0.55, 0.2, 0.22], [-0.05, k + 0.25, 0.05, 0.22]]) {
          mk(new THREE.SphereGeometry(r, 12, 10), leafMat(r > 0.25 ? "#3d7a45" : "#4f9150"), [x, y, z], g, { outline: 0.015 });
        }
      }
      addObstacle(p.x, p.z, p.r ?? 0.26, p.r ?? 0.26);
      g.userData.hit = [0.7, k + 0.3, 0.7, (k + 0.3) / 2]; g.userData.sayY = Math.min(k + 0.45, 1.75); // 키 큰 화분은 눈높이 근처에
      if (g.children.length) g.userData.wiggler = g;
      return true;
    }
    case "tvshelf": { // 안쪽 벽 TV 장식장 (짙은 원목, 칸칸이 소품)
      if (p.standOnly) { // 장식장 없이 스크린 크기에 맞는 스탠드만 (전자칠판 이동식 거치대)
        const tw = p.tvW ?? 2.35, ty = p.tvY ?? 1.55, th = p.tvH ?? 1.32, dark = "#2a2522";
        for (const sx of [-1, 1]) {
          const x = sx * (tw / 2 - 0.25);
          mk(box(0.06, ty - th / 2 + 0.1, 0.06), dark, [x, (ty - th / 2 + 0.1) / 2, 0.08], g, { outline: 0.006 });
          mk(box(0.08, 0.04, 0.42), dark, [x, 0.02, 0.04], g, { outline: 0.006 }); // 발
        }
        mk(box(tw - 0.4, 0.05, 0.05), dark, [0, 0.35, 0.08], g, { outline: 0.005 });
        addObstacle(p.x, (p.z || 0) + 0.05, tw / 2, 0.22);
        g.userData.hit = [tw, ty + th / 2, 0.4, (ty + th / 2) / 2]; g.userData.sayY = ty + th / 2 + 0.2;
        return true;
      }
      const w = p.w ?? 3.8, h = p.h ?? 2.6, d = 0.42, tw = p.tvW ?? 2.35;
      const wood = "#3b2a22", shelf = "#4c362b";
      const side = (w - tw) / 2;
      for (const sx of [-1, 1]) {
        const cx = sx * (tw / 2 + side / 2);
        mk(box(side, h, d), wood, [cx, h / 2, d / 2], g, { outline: 0.015 });
        for (let i = 1; i < 5; i++) {
          mk(box(side - 0.08, 0.03, d - 0.02), shelf, [cx, (h / 5) * i, d / 2 + 0.01], g, { outline: 0, shadow: false });
          const cols = ["#d8c9a8", "#8fa3b8", "#c97a5a", "#e9e4d8", "#6f8a6a"];
          mk(box(0.16, 0.18, 0.2), cols[(i + (sx > 0 ? 2 : 0)) % 5], [cx - 0.12, (h / 5) * i + 0.105, d / 2 + 0.03], g, { outline: 0.006, shadow: false });
          mk(cyl(0.05, 0.05, 0.14, 10), cols[(i + 3) % 5], [cx + 0.15, (h / 5) * i + 0.085, d / 2 + 0.03], g, { outline: 0.006, shadow: false });
        }
      }
      const tvTop = (p.tvY ?? 1.55) + (p.tvH ?? 1.32) / 2, tvBot = (p.tvY ?? 1.55) - (p.tvH ?? 1.32) / 2;
      mk(box(tw, h - tvTop - 0.05, d), wood, [0, (h + tvTop + 0.05) / 2, d / 2], g, { outline: 0.015 });
      mk(box(tw, tvBot - 0.05, d), wood, [0, (tvBot - 0.05) / 2, d / 2], g, { outline: 0.015 });
      addObstacle(p.x, (p.z || 0) + 0.21, w / 2, 0.25);
      g.userData.hit = [w, h, 0.6, h / 2]; g.userData.sayY = h + 0.1;
      return true;
    }
    case "curtain": { // 나뭇잎 그림 가림막
      const w = p.w ?? 1.1, h = p.h ?? 1.2;
      const t = canvasTex(256, 280, (c, W, Hh) => {
        c.fillStyle = "#f4f1e8"; c.fillRect(0, 0, W, Hh);
        c.strokeStyle = "#2f5a3a"; c.fillStyle = "#3f6e46"; c.lineWidth = 4;
        c.beginPath(); c.moveTo(70, Hh); c.quadraticCurveTo(140, 140, 220, 10); c.stroke();
        for (let i = 0; i < 9; i++) {
          const tt = i / 9, x = 70 + tt * 150 - tt * tt * 20, y = Hh - tt * 260;
          for (const s of [-1, 1]) { c.save(); c.translate(x, y); c.rotate(s * 0.9 - 0.6); c.beginPath(); c.ellipse(0, -28, 9, 30, 0, 0, Math.PI * 2); c.fill(); c.restore(); }
        }
      });
      mk(box(w + 0.1, h + 0.1, 0.04), "#f4f1ec", [0, p.y ?? 1.6, -0.01], g, { outline: 0.012, shadow: false });
      mk(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: t }), [0, p.y ?? 1.6, 0.015], g, { outline: 0, shadow: false });
      mk(cyl(0.01, 0.01, w + 0.2, 6), "#8a6a4a", [0, (p.y ?? 1.6) + h / 2 + 0.03, 0.03], g, { outline: 0, shadow: false }).rotation.z = Math.PI / 2;
      g.userData.hit = [w, h, 0.2, p.y ?? 1.6]; g.userData.sayY = (p.y ?? 1.6) + h / 2 + 0.1;
      return true;
    }
    case "coatrack": { // 원목 행거: 기둥 2개 + 가로 봉, 패딩·긴 코트·모자, 아래 검은 상자, 옆 작은 스툴
      const wood = "#4a2e22", W = 0.9, top = 1.6;
      for (const sx of [-1, 1]) {
        const post = mk(box(0.045, top + 0.05, 0.045), wood, [sx * W / 2, (top + 0.05) / 2, 0.05], g, { outline: 0.008 });
        post.rotation.x = -0.06; // 벽에 살짝 기대 섬
      }
      mk(cyl(0.018, 0.018, W + 0.3, 8), wood, [0.05, top, 0], g, { outline: 0.006 }).rotation.z = Math.PI / 2;
      mk(box(W - 0.05, 0.03, 0.3), wood, [0, 0.28, 0.08], g, { outline: 0.006 }); // 아래 선반
      // 옷걸이 3개 + 손님 수만큼 옷 (1명 코트, 2명 점퍼, 3명 패딩 — 최대 3벌)
      const garmentShape = (hem, w, sleeve) => {
        const sh = new THREE.Shape();
        sh.moveTo(-0.05, -0.07); sh.lineTo(-w + 0.02, -0.13); sh.lineTo(-w - 0.03, -sleeve); sh.lineTo(-w + 0.04, -sleeve);
        sh.lineTo(-w + 0.04, -0.3); sh.lineTo(-w + 0.02, -hem); sh.lineTo(w - 0.02, -hem); sh.lineTo(w - 0.04, -0.3);
        sh.lineTo(w - 0.04, -sleeve); sh.lineTo(w + 0.03, -sleeve); sh.lineTo(w - 0.02, -0.13); sh.lineTo(0.05, -0.07); sh.closePath();
        return sh;
      };
      const kinds = [
        { name: "코트", hem: 0.98, w: 0.19, sleeve: 0.62, depth: 0.05, color: "#b9b6ad", collar: "#e9e4d8" },
        { name: "점퍼", hem: 0.58, w: 0.21, sleeve: 0.55, depth: 0.07, color: "#3f5a4f", collar: "#2f453c" },
        { name: "패딩", hem: 0.62, w: 0.23, sleeve: 0.58, depth: 0.12, color: "#25262b", collar: "#1a1b1f", puffy: true },
      ];
      g.userData.garments = [];
      kinds.forEach((k, i) => {
        const hx = -0.28 + i * 0.3;
        const hg = new THREE.Group(); hg.position.set(hx, top - 0.02, 0.02 + i * 0.015); g.add(hg);
        // 나무 옷걸이 (갈고리 + 어깨 막대)
        mk(new THREE.TorusGeometry(0.025, 0.005, 4, 10, Math.PI * 1.3), "#cfcfd4", [0, 0.0, 0], hg, { outline: 0, shadow: false });
        for (const sx of [-1, 1]) {
          const arm = mk(box(0.2, 0.02, 0.02), "#d9b48a", [sx * 0.085, -0.075, 0], hg, { outline: 0.004 });
          arm.rotation.z = sx * -0.35;
        }
        mk(cyl(0.005, 0.005, 0.05, 4), "#cfcfd4", [0, -0.03, 0], hg, { outline: 0, shadow: false });
        // 옷
        const cg = new THREE.Group(); hg.add(cg);
        const geo = new THREE.ExtrudeGeometry(garmentShape(k.hem, k.w, k.sleeve), { depth: k.depth, bevelEnabled: false });
        geo.translate(0, 0, -k.depth / 2);
        mk(geo, k.color, [0, 0, 0], cg, { outline: 0.01 });
        const col = mk(box(0.14, 0.06, k.depth + 0.01), k.collar, [0, -0.1, 0], cg, { outline: 0.005 }); // 깃
        col.scale.x = 1;
        if (k.puffy) for (let y = 0.2; y < k.hem - 0.05; y += 0.11) mk(box(k.w * 2 - 0.06, 0.012, k.depth + 0.012), "#141518", [0, -y, 0], cg, { outline: 0, shadow: false });
        if (k.name === "코트") for (let y = 0.3; y < 0.8; y += 0.16) mk(new THREE.SphereGeometry(0.012, 6, 4), "#5a5650", [0.03, -y, k.depth / 2 + 0.003], cg, { outline: 0, shadow: false });
        cg.visible = false; cg.scale.setScalar(0.001);
        g.userData.garments.push({ g: cg, on: 0, target: 0 });
      });
      { // 내 옷 자리 (봉 오른쪽 끝): 앉으면 걸림. 종류 3가지 중 하나 (처음 앉을 때 무작위로 정해 유지)
        const hg = new THREE.Group(); hg.position.set(0.55, top - 0.02, 0.06); g.add(hg);
        mk(new THREE.TorusGeometry(0.025, 0.005, 4, 10, Math.PI * 1.3), "#cfcfd4", [0, 0, 0], hg, { outline: 0, shadow: false });
        const variants = kinds.map((k) => {
          const cg = new THREE.Group(); hg.add(cg);
          const geo = new THREE.ExtrudeGeometry(garmentShape(k.hem, k.w, k.sleeve), { depth: k.depth, bevelEnabled: false });
          geo.translate(0, 0, -k.depth / 2);
          const tone = { "코트": "#8f7a62", "점퍼": "#6b3f3a", "패딩": "#4b5a73" }[k.name]; // 다른 손님 옷과 다른 색
          mk(geo, tone, [0, 0, 0], cg, { outline: 0.01 });
          mk(box(0.14, 0.06, k.depth + 0.01), k.collar, [0, -0.1, 0], cg, { outline: 0.005 });
          if (k.puffy) for (let y = 0.2; y < k.hem - 0.05; y += 0.11) mk(box(k.w * 2 - 0.06, 0.012, k.depth + 0.012), "#2c3444", [0, -y, 0], cg, { outline: 0, shadow: false });
          cg.visible = false; cg.scale.setScalar(0.001);
          return cg;
        });
        g.userData.mine = { variants, on: 0 };
      }
      coatracks.push(g);
      // 봉 끝 검은 모자
      mk(new THREE.SphereGeometry(0.08, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), "#1f1f22", [-0.52, top - 0.03, 0.02], g, { outline: 0.006 }).rotation.z = Math.PI / 2;
      // 아래 검은 상자
      mk(box(0.5, 0.24, 0.32), "#1f1f22", [0.02, 0.12, 0.1], g, { outline: 0.01 });
      mk(box(0.2, 0.04, 0.005), "#e9e9ef", [0.02, 0.12, 0.262], g, { outline: 0, shadow: false });
      // 왼쪽 옆 작은 나무 스툴
      const sx0 = -W / 2 - 0.3;
      mk(box(0.34, 0.04, 0.28), "#a8784a", [sx0, 0.45, 0.12], g, { outline: 0.008 });
      for (const [lx, lz] of [[-0.13, 0.02], [0.13, 0.02], [-0.13, 0.22], [0.13, 0.22]]) mk(box(0.03, 0.45, 0.03), "#a8784a", [sx0 + lx, 0.225, lz], g, { outline: 0.005 });
      mk(box(0.26, 0.06, 0.2), "#9fb3a3", [sx0, 0.5, 0.12], g, { outline: 0.006 }); // 개어 둔 옷
      const [ox, oz] = rotXZ(-0.15, 0.12, p.rot);
      addObstacle(p.x + ox, p.z + oz, (W + 0.7) / 2, 0.22, p.rot);
      g.userData.hit = [W + 0.6, 1.7, 0.45, 0.85]; g.userData.sayY = 1.95;
      return true;
    }
    case "walldoor": { // 벽에 난 문 (화장실 가는 문)
      const w = p.w ?? 0.85, h = p.h ?? 2.05, frame = "#f4f1ec";
      mk(box(w, h, 0.04), p.color || "#7a5638", [0, h / 2, 0.03], g, { outline: 0.012 });
      for (const sx of [-1, 1]) mk(box(0.06, h + 0.04, 0.07), frame, [sx * (w / 2 + 0.03), (h + 0.04) / 2, 0.035], g, { outline: 0.008 });
      mk(box(w + 0.18, 0.06, 0.07), frame, [0, h + 0.05, 0.035], g, { outline: 0.008 });
      mk(new THREE.SphereGeometry(0.035, 10, 8), "#c9b27a", [w / 2 - 0.1, 1.0, 0.07], g, { outline: 0.005 });
      if (p.text) {
        const t = canvasTex(128, 64, (c, W2, H2) => {
          c.fillStyle = "#f4f1ec"; c.beginPath(); c.roundRect(2, 2, W2 - 4, H2 - 4, 12); c.fill();
          c.fillStyle = "#3b2f2a"; c.font = "800 30px 'Pretendard','Apple SD Gothic Neo',sans-serif"; c.textAlign = "center"; c.fillText(p.text, W2 / 2, 43);
        });
        mk(new THREE.PlaneGeometry(0.3, 0.15), new THREE.MeshBasicMaterial({ map: t }), [0, 1.6, 0.055], g, { outline: 0.004, shadow: false });
      }
      g.userData.hit = [w, h, 0.3, h / 2]; g.userData.sayY = h + 0.2;
      return true;
    }
    case "sign": { // WELCOME 팻말
      const t = canvasTex(256, 80, (c, W, Hh) => {
        c.fillStyle = "#1f3b34"; c.fillRect(0, 0, W, Hh);
        c.strokeStyle = "#e9e4d8"; c.lineWidth = 4; c.strokeRect(6, 6, W - 12, Hh - 12);
        c.fillStyle = "#f4efe2"; c.font = "800 40px Georgia, serif"; c.textAlign = "center"; c.fillText(p.text || "WELCOME", W / 2, 54);
      });
      mk(new THREE.PlaneGeometry(0.5, 0.16), new THREE.MeshBasicMaterial({ map: t }), [0, p.y ?? 2.05, 0.01], g, { outline: 0.006, shadow: false });
      g.userData.hit = [0.6, 0.3, 0.2, p.y ?? 2.05]; g.userData.sayY = (p.y ?? 2.05) + 0.2;
      return true;
    }
    case "coffee": { // 라마르조꼬 에스프레소 머신 (나무 받침 위) + 아이패드 + 그라인더 2대. 로컬 +z = 바텐더 쪽, -z = 손님 쪽, -x = 손님 기준 오른쪽
      const y0 = p.y0 ?? 0.99, black = "#232326", steel = "#b9bcc2";
      const frustum = (wTop, wBot, h, d) => { // 아래가 살짝 좁은 상자
        const geo = new THREE.CylinderGeometry(Math.SQRT1_2, Math.SQRT1_2 * wBot / wTop, h, 4, 1);
        geo.rotateY(Math.PI / 4); geo.scale(wTop, 1, d);
        return geo;
      };
      mk(box(0.48, 0.035, 0.5), "#9a6a42", [0, y0 + 0.0175, 0], g, { outline: 0.008 }); // 나무 받침판
      const by = y0 + 0.035, bh = 0.4, MW = 0.4; // 1구 머신
      mk(frustum(MW, 0.33, bh, 0.46), black, [0, by + bh / 2, 0], g, { outline: 0.012 });
      mk(box(MW + 0.02, 0.025, 0.48), "#2e2e32", [0, by + bh + 0.012, 0], g, { outline: 0.008 }); // 윗판 (컵 없음)
      mk(box(0.28, 0.03, 0.14), steel, [0, by + 0.04, 0.27], g, { outline: 0.006 }); // 물받이
      mk(cyl(0.05, 0.045, 0.05, 12), steel, [0, by + 0.25, 0.25], g, { outline: 0.005 }); // 그룹헤드 1개 (필터는 꽂지 않음)
      mk(box(0.02, 0.05, 0.02), "#111", [0, by + 0.31, 0.25], g, { outline: 0.003 });
      { // 스팀 노즐 1개 (바텐더 기준 오른쪽 = 로컬 +x), 비스듬히
        const wand = mk(cyl(0.009, 0.009, 0.24, 6), steel, [0.15, by + 0.18, 0.27], g, { outline: 0.003 });
        wand.rotation.x = 0.3; wand.rotation.z = -0.25;
        mk(new THREE.SphereGeometry(0.018, 8, 6), "#2a2a2e", [0.15, by + 0.31, 0.25], g, { outline: 0.003 }); // 노즐 손잡이
      }
      // 손님 쪽 위: 노란 LED 돌출 미니 간판 "LA MARZOCCO"
      const signTex = canvasTex(512, 96, (c, w, h) => {
        c.fillStyle = "#16120a"; c.fillRect(0, 0, w, h);
        c.font = "bold 60px Georgia, 'Times New Roman', serif"; c.textAlign = "center"; c.textBaseline = "middle";
        c.shadowColor = "#ffd54a"; c.shadowBlur = 18; c.fillStyle = "#ffe27a";
        c.fillText("LA MARZOCCO", w / 2, h / 2 + 3);
      });
      // 붙여 놓은 자석 간판 (약 15×5cm), 손님 쪽에서 봐서 앞면 왼쪽 위 (로컬 +x)
      const sx0 = MW / 2 - 0.1, sy = by + bh - 0.06, sz = -0.235;
      mk(box(0.155, 0.05, 0.022), "#1a1a1c", [sx0, sy, sz - 0.011], g, { outline: 0.003, shadow: false });
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.15, 0.042), new THREE.MeshBasicMaterial({ map: signTex }));
      sign.position.set(sx0, sy, sz - 0.023); sign.rotation.y = Math.PI; g.add(sign);
      const halo = new THREE.MeshBasicMaterial({ color: "#ffcf4a", map: poolTex, transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending });
      const hm = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.13), halo);
      hm.position.set(sx0, sy, sz - 0.03); hm.rotation.y = Math.PI; g.add(hm);
      innerGlows.push([halo, 0.05, 0.35]);
      // 위: 아이패드 거치대 + 아이패드 (화면은 window.__ipad 캔버스 → 나중에 기능 넣기)
      const ty = by + bh + 0.025;
      mk(box(0.16, 0.015, 0.12), "#8f9298", [0, ty + 0.008, -0.02], g, { outline: 0.004 });
      mk(cyl(0.012, 0.012, 0.08, 8), "#8f9298", [0, ty + 0.05, -0.02], g, { outline: 0.003 });
      const pad = new THREE.Group(); pad.position.set(0, ty + 0.17, -0.01); pad.rotation.x = -0.22; g.add(pad); // 바텐더가 보는 화면 (바텐더 쪽으로 살짝 기울임)
      mk(box(0.25, 0.18, 0.012), "#9a9da3", [0, 0, 0], pad, { outline: 0.005 }); // 손님 쪽에서는 은색 뒷면
      mk(box(0.24, 0.17, 0.002), "#111114", [0, 0, 0.0065], pad, { outline: 0, shadow: false });
      const ipadCanvas = document.createElement("canvas"); ipadCanvas.width = 256; ipadCanvas.height = 184;
      const ipadTex = new THREE.CanvasTexture(ipadCanvas); ipadTex.colorSpace = THREE.SRGBColorSpace;
      const drawIpad = () => {
        const c = ipadCanvas.getContext("2d"), w = 256, h = 184;
        const grd = c.createLinearGradient(0, 0, 0, h); grd.addColorStop(0, "#2a2238"); grd.addColorStop(1, "#141018");
        c.fillStyle = grd; c.fillRect(0, 0, w, h);
        c.fillStyle = "rgba(255,226,190,.75)"; c.textAlign = "center"; c.textBaseline = "middle";
        c.font = "bold 26px Georgia, serif"; c.fillText("DIVE", w / 2, h / 2 - 26);
        c.font = "bold 22px Georgia, serif"; c.fillText("HIDE AWAY", w / 2, h / 2 + 8);
        c.fillStyle = "rgba(255,200,140,.35)"; c.fillRect(w / 2 - 30, h / 2 + 34, 60, 2);
        ipadTex.needsUpdate = true;
      };
      drawIpad();
      const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.225, 0.158), new THREE.MeshBasicMaterial({ map: ipadTex }));
      scr.position.set(0, 0, 0.0085); pad.add(scr);
      window.__ipad = { canvas: ipadCanvas, texture: ipadTex, redraw: drawIpad };
      // 그라인더 2대 (손님 기준 머신 오른쪽 = 로컬 -x)
      const G1 = -0.355, G2 = -0.555, GZ = -0.05; // 그라인더는 바 상판 위, 바텐더 쪽 끝 가까이 (머신·큰 그라인더·작은 그라인더 3cm 간격)
      mk(box(0.17, 0.32, 0.22), black, [G1, y0 + 0.16, GZ], g, { outline: 0.008 }); // 키 큰 네모 그라인더
      mk(box(0.12, 0.04, 0.08), "#3a3a3e", [G1, y0 + 0.12, GZ + 0.13], g, { outline: 0.004 });
      mk(cyl(0.035, 0.05, 0.05, 10), "#2e2e32", [G1, y0 + 0.345, GZ], g, { outline: 0.004 });
      const glass = new THREE.MeshBasicMaterial({ color: "#eef6f8", transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }); // 투명 원두통 (테두리선 없이)
      mk(new THREE.CylinderGeometry(0.09, 0.04, 0.22, 16, 1, true), glass, [G1, y0 + 0.48, GZ], g, { outline: 0, shadow: false });
      mk(new THREE.TorusGeometry(0.09, 0.004, 4, 20), "#2a2a2e", [G1, y0 + 0.588, GZ], g, { outline: 0, shadow: false }).rotation.x = Math.PI / 2;
      mk(cyl(0.062, 0.04, 0.12, 12), "#4a2c1c", [G1, y0 + 0.43, GZ], g, { outline: 0, shadow: false }); // 원두 (통의 반쯤)
      mk(cyl(0.095, 0.095, 0.02, 14), "#1b1b1e", [G1, y0 + 0.6, GZ], g, { outline: 0.004 });
      mk(cyl(0.075, 0.085, 0.22, 16), black, [G2, y0 + 0.11, GZ], g, { outline: 0.008 }); // 작은 둥근 그라인더
      mk(box(0.06, 0.03, 0.06), "#3a3a3e", [G2, y0 + 0.08, GZ + 0.08], g, { outline: 0.004 });
      mk(new THREE.CylinderGeometry(0.065, 0.045, 0.12, 14, 1, true), glass, [G2, y0 + 0.28, GZ], g, { outline: 0, shadow: false }); // 투명 원두통 (빛 없음)
      mk(cyl(0.05, 0.04, 0.07, 12), "#4a2c1c", [G2, y0 + 0.255, GZ], g, { outline: 0, shadow: false });
      mk(cyl(0.07, 0.07, 0.02, 14), "#1b1b1e", [G2, y0 + 0.35, GZ], g, { outline: 0.004 }); // 뚜껑
      { const [sx, sz] = rotXZ(0.17, 0.3, p.rot); steamSources.push(new THREE.Vector3(p.x + sx, by + 0.2, p.z + sz)); } // 김은 스팀 노즐에서
      if (p.shelf) { // 바 상판에서 바텐더 쪽으로 이어져 나온 머신 크기 판 (다리 없음, 밑에 작은 받침쇠)
        mk(box(0.5, 0.04, 0.5), "#6e4127", [0, y0 - 0.02, 0], g, { outline: 0.008 });
        for (const lx of [-0.2, 0.2]) mk(box(0.03, 0.12, 0.2), "#2a2522", [lx, y0 - 0.1, 0.12], g, { outline: 0.004, shadow: false });
        const [ox, oz] = rotXZ(0, 0.1, p.rot);
        addObstacle(p.x + ox, p.z + oz, 0.25, 0.17, p.rot);
      }
      g.userData.hit = [0.9, 0.8, 0.6, y0 + 0.35]; g.userData.sayY = y0 + 0.85;
      return true;
    }
    case "icemaker": { // 바 몸통 안 언더카운터 제빙기 (로컬 +z = 바텐더 쪽 앞면): 위 = 문(안에 얼음 더미), 아래 = 환기 그릴
      const W = p.w ?? 0.64, D = 0.42, y0 = 0.02, Hh = 0.88, steel = "#b8bcc2", no = { outline: 0, shadow: false };
      const fz = D / 2, dyb = y0 + 0.3, dh = Hh - 0.36, cav = 0.3; // 문 아래끝, 문 높이, 안쪽 깊이
      mk(box(W, dyb - y0, D), steel, [0, (y0 + dyb) / 2, 0], g, { outline: 0.008, shadow: false });              // 아래 (그릴)
      mk(box(W, y0 + Hh - (dyb + dh), D), steel, [0, (dyb + dh + y0 + Hh) / 2, 0], g, { outline: 0.008, shadow: false }); // 위 띠
      mk(box(W, dh, D - cav), steel, [0, dyb + dh / 2, -fz + (D - cav) / 2], g, { outline: 0.008, shadow: false }); // 뒤
      for (const sx of [-1, 1]) mk(box(0.03, dh, cav), steel, [sx * (W / 2 - 0.015), dyb + dh / 2, fz - cav / 2], g, { outline: 0.006, shadow: false }); // 옆
      const inner = "#3a4148";
      mk(new THREE.PlaneGeometry(W - 0.06, dh), inner, [0, dyb + dh / 2, fz - cav + 0.001], g, no);
      mk(new THREE.PlaneGeometry(W - 0.06, cav), inner, [0, dyb + 0.001, fz - cav / 2], g, no).rotation.x = -Math.PI / 2;
      // 안에 수북이 쌓인 얼음
      let sd = 11; const rr = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < 70; i++) {
        const lx = (rr() - 0.5) * (W - 0.12), lz = fz - cav + 0.03 + rr() * (cav - 0.06);
        const hgt = 0.2 * (1 - (lz - (fz - cav)) / cav) * (0.6 + 0.4 * rr()); // 뒤가 높은 더미
        const c = mk(iceGeo, iceMat, [lx, dyb + 0.023 + hgt * rr(), lz], g, { outline: 0.002, shadow: false });
        c.rotation.set(rr() * 3, rr() * 3, rr() * 3);
      }
      // 문: 아래 경첩, 바텐더 쪽으로 아래로 열림
      const door = new THREE.Group(); door.position.set(0, dyb, fz + 0.006); g.add(door);
      mk(box(W - 0.04, dh, 0.012), "#c9cdd2", [0, dh / 2, 0], door, { outline: 0.004, shadow: false });
      mk(box(W - 0.16, 0.025, 0.03), "#8e939a", [0, dh - 0.04, 0.015], door, { outline: 0.003, shadow: false }); // 손잡이
      for (let i = 0; i < 5; i++) mk(box(W - 0.12, 0.008, 0.006), "#7d828a", [0, y0 + 0.07 + i * 0.03, fz + 0.002], g, no); // 아래 환기 그릴
      mk(new THREE.SphereGeometry(0.008, 8, 6), glowMat("#5dff9a"), [W / 2 - 0.05, y0 + Hh - 0.03, fz + 0.004], g, no); // 전원 불빛
      g.userData.ice = { door, dh, dyb, fz, W, open: 0, t: -1 };
      g.userData.hit = [W, Hh, D, y0 + Hh / 2]; g.userData.sayY = dyb + dh + 0.1; g.userData.sayScale = 0.5;
      const [ox, oz] = rotXZ(0, fz + 0.15, p.rot); g.userData.sayPos = [p.x + ox, p.z + oz];
      iceMakers.push(g);
      return true;
    }
    case "fridge": { // 언더카운터 냉장고: [조절부 | 냉동 | 냉장], 냉동·냉장 문은 가운데에서 양옆으로 열림 (로컬 +z = 바텐더 쪽)
      const W = p.w ?? 1.5, PW = 0.3, Wc = W - PW, ox = PW / 2; // 조절부 폭, 칸 부분 폭·가운데
      const D = 0.42, y0 = 0.02, Hh = 0.88, steel = "#b8bcc2", no = { outline: 0, shadow: false };
      const fz = D / 2, cyb = y0 + 0.14, ch = Hh - 0.2, cav = 0.32;
      mk(box(W, cyb - y0, D), steel, [0, (y0 + cyb) / 2, 0], g, { outline: 0.008, shadow: false });
      mk(box(W, y0 + Hh - (cyb + ch), D), steel, [0, (cyb + ch + y0 + Hh) / 2, 0], g, { outline: 0.008, shadow: false });
      mk(box(Wc, ch, D - cav), steel, [ox, cyb + ch / 2, -fz + (D - cav) / 2], g, { outline: 0.008, shadow: false });
      for (const sx of [-1, 0, 1]) mk(box(0.03, ch, cav), steel, [ox + sx * (Wc / 2 - 0.015), cyb + ch / 2, fz - cav / 2], g, { outline: 0.006, shadow: false });
      // 조절부 (냉동칸 왼쪽, 문짝 반 개 크기): 다이얼 + 표시창 + 그릴
      mk(box(PW, ch, D), "#a9adb3", [-W / 2 + PW / 2, cyb + ch / 2, 0], g, { outline: 0.008, shadow: false });
      const cpx = -W / 2 + PW / 2;
      const scr = canvasTex(96, 48, (c, w, h) => { c.fillStyle = "#14181c"; c.fillRect(0, 0, w, h); c.fillStyle = "#ff9a3c"; c.font = "bold 28px monospace"; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText("-18", w / 2, h / 2 + 2); });
      mk(new THREE.PlaneGeometry(0.1, 0.05), new THREE.MeshBasicMaterial({ map: scr }), [cpx, cyb + ch - 0.12, fz + 0.002], g, no);
      for (const [dy, r] of [[0.28, 0.035], [0.4, 0.028]]) { const d = mk(cyl(r, r, 0.025, 18), "#2b2e33", [cpx, cyb + ch - dy, fz + 0.012], g, { outline: 0.003, shadow: false }); d.rotation.x = Math.PI / 2;
        mk(box(0.006, r * 1.2, 0.006), "#e8e8e8", [cpx, cyb + ch - dy + r * 0.3, fz + 0.026], g, no); }
      for (let i = 0; i < 6; i++) mk(box(PW - 0.08, 0.008, 0.006), "#7d828a", [cpx, cyb + 0.06 + i * 0.03, fz + 0.002], g, no);
      for (const [sx, col] of [[-1, "#cfe2ec"], [1, "#e9eef0"]]) { // 안쪽 (냉동은 서리빛)
        mk(new THREE.PlaneGeometry(Wc / 2 - 0.05, ch), col, [ox + sx * Wc / 4, cyb + ch / 2, fz - cav + 0.001], g, no);
        mk(new THREE.PlaneGeometry(Wc / 2 - 0.05, cav), col, [ox + sx * Wc / 4, cyb + 0.002, fz - cav / 2], g, no).rotation.x = -Math.PI / 2;
        mk(box(Wc / 2 - 0.05, 0.01, cav - 0.02), "#d4d8dc", [ox + sx * Wc / 4, cyb + ch * 0.5, fz - cav / 2], g, { outline: 0.002, shadow: false });
      }
      for (let i = 0; i < 6; i++) mk(box(0.12, 0.07, 0.14), i % 2 ? "#f4f7f9" : "#bcd6e6", [ox - Wc / 2 + 0.12 + (i % 3) * 0.16, cyb + 0.04 + Math.floor(i / 3) * ch * 0.5, fz - cav + 0.1], g, { outline: 0.003, shadow: false });
      const milkGeo = box(0.075, 0.19, 0.075), milkTop = new THREE.ConeGeometry(0.055, 0.05, 4);
      const carton = (parent, x, y, z, own) => { const c = new THREE.Group(); c.position.set(x, y, z); parent.add(c);
        const M = (col) => (own ? new THREE.MeshBasicMaterial({ color: col, transparent: true }) : col);
        mk(milkGeo, M("#fbfbf8"), [0, 0.095, 0], c, { outline: 0.003, shadow: false });
        mk(box(0.077, 0.05, 0.077), M("#3d79c9"), [0, 0.11, 0], c, no);
        mk(milkTop, M("#fbfbf8"), [0, 0.215, 0], c, { outline: 0.002, shadow: false }).rotation.y = Math.PI / 4;
        return c; };
      for (const x of [0.12, 0.22, 0.4]) carton(g, ox + x, cyb + 0.002, fz - cav + 0.12);
      for (const x of [0.15, 0.25, 0.35, 0.45]) mk(cyl(0.022, 0.022, 0.13, 8), ["#7a3b2e", "#c9a54a", "#3f6b4a", "#e9e2c8"][Math.round(x * 10) % 4], [ox + x, cyb + ch * 0.5 + 0.07, fz - cav + 0.1], g, { outline: 0.003, shadow: false });
      // 쓰러질 맨 앞 우유: 앞쪽 아래 모서리가 회전축
      const mx = ox + 0.3;
      const milkPivot = new THREE.Group(); milkPivot.position.set(mx, cyb + 0.002, fz - 0.03); g.add(milkPivot);
      const milk = carton(milkPivot, 0, 0, -0.0375, true);
      const puddle = mk(new THREE.CircleGeometry(0.3, 28), new THREE.MeshBasicMaterial({ color: "#f8f7f2", transparent: true, opacity: 0.9, depthWrite: false }), [mx, 0.013, fz + 0.32], g, no);
      puddle.rotation.x = -Math.PI / 2; puddle.scale.setScalar(0.001); puddle.renderOrder = 2;
      const stream = mk(cyl(0.006, 0.01, 1, 6), new THREE.MeshBasicMaterial({ color: "#f8f7f2", transparent: true }), [mx, 0, fz + 0.2], g, no); stream.visible = false;
      const doors = [-1, 1].map((sx) => {
        const hg = new THREE.Group(); hg.position.set(ox + sx * Wc / 2, cyb, fz + 0.006); g.add(hg);
        mk(box(Wc / 2 - 0.01, ch, 0.014), "#c9cdd2", [-sx * (Wc / 4 - 0.005), ch / 2, 0], hg, { outline: 0.004, shadow: false });
        mk(box(0.022, ch * 0.5, 0.03), "#8e939a", [-sx * (Wc / 2 - 0.05), ch * 0.55, 0.018], hg, { outline: 0.003, shadow: false });
        const lab = canvasTex(128, 48, (c, w, h) => { c.fillStyle = "#1e2226"; c.fillRect(0, 0, w, h); c.font = "bold 26px sans-serif"; c.textAlign = "center"; c.textBaseline = "middle";
          c.fillStyle = sx < 0 ? "#8fd3ff" : "#7dffa6"; c.fillText(sx < 0 ? "냉동 -18°" : "냉장 3°", w / 2, h / 2 + 1); });
        mk(new THREE.PlaneGeometry(0.12, 0.045), new THREE.MeshBasicMaterial({ map: lab }), [-sx * (Wc / 4), ch - 0.08, 0.008], hg, no);
        return hg;
      });
      for (let i = 0; i < 4; i++) mk(box(Wc - 0.1, 0.008, 0.006), "#7d828a", [ox, y0 + 0.03 + i * 0.026, fz + 0.002], g, no);
      g.userData.fr = { doors, milkPivot, milk, puddle, stream, fz, cyb, mx, t: -1, ft: -1 };
      fridges.push(g);
      for (const sx of [-1, 1]) {
        const hg = new THREE.Group(); hg.position.set(ox + sx * Wc / 4, 0, 0); g.add(hg);
        const [px, pz] = rotXZ(ox + sx * Wc / 4, fz + 0.18, p.rot);
        hg.userData.sayPos = [p.x + px, p.z + pz]; hg.userData.sayScale = 0.5;
        addSayHit({ type: "fridge", x: p.x + px, z: p.z + pz, say: sx < 0 ? "냉동칸이에요\n으슬으슬 -18°" : "냉장칸이에요\n어? 우유가…" }, hg, [Wc / 2, Hh, D, y0 + Hh / 2], cyb + ch + 0.08);
        sayProps[sayProps.length - 1].onTap = () => (sx < 0 ? freezerPuff(g) : spillMilk(g));
      }
      return true;
    }
    case "aircon": { // 벽 뒤 공간의 스탠드 에어컨 + 벽에 붙은 나무 문(앞판)만 살짝 나옴 (로컬 +z = 홀 쪽)
      const W = p.w ?? 0.8, H = p.h ?? 2.0, D = 0.03, wood = "#a8743f", dark = "#5e3b22", no = { outline: 0, shadow: false };
      const fz = D / 2;
      mk(box(W, H, D), wood, [0, H / 2, 0], g, { outline: 0.01 });
      mk(box(W + 0.06, 0.04, D + 0.01), dark, [0, H + 0.02, 0], g, { outline: 0.004, shadow: false }); // 위 문틀
      // 위: 파낸 창 → 벽 뒤 에어컨이 안쪽 깊이 보이게 (어두운 안쪽 + 창 둘레 그림자 띠)
      const wy = H - 0.42, ww = W - 0.16, wh = 0.26;
      mk(new THREE.PlaneGeometry(ww, wh), "#1e1f22", [0, wy, fz + 0.001], g, no);
      mk(new THREE.PlaneGeometry(ww - 0.06, wh - 0.06), "#3a3c40", [0, wy, fz + 0.002], g, no); // 안쪽 에어컨 앞면 (어두운 바람구멍)
      for (const [x, y, w, h] of [[0, wy + wh / 2 - 0.015, ww, 0.03], [0, wy - wh / 2 + 0.015, ww, 0.03], [-ww / 2 + 0.015, wy, 0.03, wh], [ww / 2 - 0.015, wy, 0.03, wh]])
        mk(new THREE.PlaneGeometry(w, h), "#2a2b2e", [x, y, fz + 0.003], g, no); // 창 안쪽 그림자 (깊이감)
      mk(box(ww + 0.04, wh + 0.04, 0.012), dark, [0, wy, fz + 0.004], g, { outline: 0.004, shadow: false }).scale.set(1, 1, 0.3);
      const flaps = [];
      const silver = new THREE.MeshBasicMaterial({ color: "#d9dce0" }); // 실내 어둠에 묻히지 않는 밝은 은색 날개
      for (let i = 0; i < 3; i++) { const f = mk(box(ww - 0.08, 0.05, 0.02), silver, [0, wy - 0.075 + i * 0.075, fz + 0.008], g, { outline: 0.003, shadow: false }); f.rotation.x = -0.35; flaps.push(f); }
      mk(box(0.012, wh - 0.06, 0.02), silver, [0, wy, fz + 0.01], g, { outline: 0.002, shadow: false }); // 가운데 세로 살
      for (let i = 0; i < 4; i++) mk(box(W - 0.14, 0.025, 0.015), "#93622f", [0, wy - 0.22 - i * 0.045, fz + 0.008], g, { outline: 0.003, shadow: false }); // 가로 나무 루버
      mk(box(W - 0.12, 0.002, 0.004), dark, [0, H * 0.48, fz + 0.002], g, no);
      for (let i = 0; i < 16; i++) mk(box(W - 0.14, 0.022, 0.012), "#8c5d2e", [0, 0.12 + i * 0.045, fz + 0.007], g, { outline: 0.002, shadow: false }); // 아래 가로 살
      g.userData.ac = { flaps, t: -1 };
      airCons.push(g);
      addObstacle(p.x, p.z, W / 2, D / 2, p.rot);
      g.userData.hit = [W, H, D, H / 2]; g.userData.sayY = 1.75; // 눈높이
      return true;
    }
    case "speaker": { // JBL 4312A 우드 (호두나무 통 + 파란 앞판 + 흰 우퍼). 로컬 +z = 앞
      const y0 = p.y0 ?? 0.99, W = 0.56, H = 0.8, D = 0.4, walnut = "#7a4a2a";
      mk(box(W, H, D), walnut, [0, y0 + H / 2, 0], g, { outline: 0.01 });
      const fz = D / 2 + 0.004;
      mk(box(W - 0.04, H - 0.04, 0.01), "#2f5d9a", [0, y0 + H / 2, fz], g, { outline: 0.004, shadow: false });
      const ring = (r, y, x, col, cone) => {
        mk(cyl(r, r, 0.012, 24), "#1a1a1c", [x, y, fz + 0.008], g, { outline: 0.003, shadow: false }).rotation.x = Math.PI / 2;
        mk(cyl(r * 0.88, r * 0.88, 0.012, 24), col, [x, y, fz + 0.014], g, { outline: 0, shadow: false }).rotation.x = Math.PI / 2;
        if (cone) mk(new THREE.SphereGeometry(r * 0.25, 10, 6), "#e8e6e0", [x, y, fz + 0.02], g, { outline: 0, shadow: false }).scale.z = 0.4;
      };
      ring(0.2, y0 + 0.27, 0, "#f2f0ea", true);           // 12인치 흰 우퍼
      ring(0.068, y0 + 0.6, -0.11, "#f2f0ea", true);      // 미드
      ring(0.038, y0 + 0.6, 0.1, "#d9d6cf", false);       // 트위터
      for (const kx of [-0.05, 0.18]) mk(cyl(0.016, 0.016, 0.015, 10), "#d8d8d8", [kx, y0 + 0.71, fz + 0.012], g, { outline: 0.002, shadow: false }).rotation.x = Math.PI / 2; // 레벨 손잡이
      mk(box(0.09, 0.03, 0.006), "#d8d8d8", [0.18, y0 + 0.5, fz + 0.008], g, { outline: 0, shadow: false }); // JBL 배지
      addObstacle(p.x, p.z, W / 2, D / 2, p.rot);
      g.userData.hit = [W, H, D, y0 + H / 2]; g.userData.sayY = y0 + H + 0.25;
      return true;
    }
    case "door": { // 안 쓰는 출입문: 입구 문과 같은 크기·모양 (짙은 문틀 + 유리 + 긴 세로 나무 손잡이), 유리 바깥쪽(블라인드 뒤)
      const w = p.w ?? 1.1, h = p.h ?? 2.2, fr = "#4a3a32", oz = 0.12;
      // (문짝 유리는 따로 두지 않음: 창 유리 한 겹만 → 다른 칸과 같게 보임)
      for (const fx of [-w / 2 + 0.025, w / 2 - 0.025]) mk(box(0.05, h, 0.06), fr, [fx, h / 2, oz], g, { outline: 0.006, shadow: false });
      for (const fy of [0.025, h - 0.025]) mk(box(w, 0.05, 0.06), fr, [0, fy, oz], g, { outline: 0.006, shadow: false });
      mk(box(0.04, 0.8, 0.04), "#a8743f", [w / 2 - 0.12, 1.1, oz + 0.08], g, { outline: 0.006, shadow: false }); // 긴 나무 손잡이
      for (const hy of [0.75, 1.45]) mk(box(0.02, 0.02, 0.06), "#a8743f", [w / 2 - 0.12, hy, oz + 0.05], g, { outline: 0, shadow: false });
      g.userData.hit = [w, h, 0.3, h / 2]; g.userData.sayY = h + 0.15;
      return true;
    }
    case "sidetable": { // 나무 스툴 위 소품 (반죽기 / 가습기)
      const wood = "#a8784a", ty = 0.5;
      mk(box(0.42, 0.04, 0.4), wood, [0, ty, 0], g, { outline: 0.01 });
      for (const [lx, lz] of [[-0.17, -0.16], [0.17, -0.16], [-0.17, 0.16], [0.17, 0.16]]) mk(box(0.035, ty, 0.035), wood, [lx, ty / 2, lz], g, { outline: 0.006 });
      mk(box(0.36, 0.025, 0.025), wood, [0, 0.16, 0.16], g, { outline: 0.004 });
      const top = ty + 0.02, white = "#f1eeea";
      if (p.item === "mixer") { // 반죽기 (itemRot: 스툴 위에서 반죽기만 돌림, + = 위에서 봐서 시계 방향)
        const ig = new THREE.Group(); ig.rotation.y = THREE.MathUtils.degToRad(-(p.itemRot || 0)); g.add(ig);
        // 받침 → 뒤쪽 기둥 → 앞으로 나온 둥근 머리 → 그 아래 은색 그릇
        const base = mk(cyl(0.13, 0.15, 0.04, 20), white, [0, top + 0.02, 0.02], ig, { outline: 0.008 });
        base.scale.set(1, 1, 1.3);
        mk(cyl(0.055, 0.065, 0.3, 14), white, [0, top + 0.19, -0.13], ig, { outline: 0.008 });
        const head = mk(new THREE.CapsuleGeometry(0.075, 0.24, 6, 14), white, [0, top + 0.39, -0.02], ig, { outline: 0.01 });
        head.rotation.x = Math.PI / 2;
        mk(new THREE.SphereGeometry(0.02, 8, 6), "#c8392b", [0.075, top + 0.39, -0.12], ig, { outline: 0, shadow: false });
        const bowl = new THREE.LatheGeometry([[0.03, 0], [0.09, 0.02], [0.11, 0.08], [0.115, 0.15], [0.105, 0.15]].map(([r, y]) => new THREE.Vector2(r, y)), 20);
        mk(bowl, toon("#c3c7cd", { side: THREE.DoubleSide }), [0, top + 0.05, 0.05], ig, { outline: 0, shadow: false });
        mk(new THREE.TorusGeometry(0.112, 0.006, 5, 20), "#2b2522", [0, top + 0.2, 0.05], ig, { outline: 0, shadow: false }).rotation.x = Math.PI / 2;
        mk(cyl(0.01, 0.01, 0.1, 6), "#8a8f96", [0, top + 0.28, 0.05], ig, { outline: 0, shadow: false });
      } else { // 가습기 + 술병 3개 (김이 모락모락)
        mk(cyl(0.12, 0.12, 0.55, 20), white, [-0.06, top + 0.275, -0.04], g, { outline: 0.01 });
        mk(new THREE.TorusGeometry(0.09, 0.025, 8, 20), "#dedad5", [-0.06, top + 0.55, -0.04], g, { outline: 0 }).rotation.x = Math.PI / 2;
        mk(box(0.14, 0.04, 0.01), "#2a2d33", [-0.06, top + 0.47, 0.08], g, { outline: 0, shadow: false });
        mk(box(0.03, 0.02, 0.012), glowMat("#7fe0ff"), [-0.02, top + 0.47, 0.086], g, { outline: 0, shadow: false });
        mk(cyl(0.022, 0.022, 0.35, 8), white, [-0.06, top + 0.72, -0.04], g, { outline: 0.004 });
        for (const sx of [-1, 1]) mk(cyl(0.015, 0.015, 0.12, 6), white, [-0.06 + sx * 0.05, top + 0.85, -0.04], g, { outline: 0.003 }).rotation.z = sx * -0.6;
        const [wx, wz] = rotXZ(-0.06, -0.04, p.rot);
        const mist = new THREE.Vector3(p.x + wx, top + 0.95, p.z + wz);
        mist.userData = { k: 0.45, a: 0.3 }; // 가습기 김은 작고 옅게
        steamSources.push(mist);
        const bottles = [["#f4efe4", "#c8392b", 0.22], ["#eef2f2", "#d9d9d9", 0.26], ["#e9d9c0", "#2a2522", 0.18]];
        bottles.forEach(([c, cap, h], i) => {
          mk(cyl(0.035, 0.035, h, 10), c, [0.1 + (i - 1) * 0.08, top + h / 2, 0.12], g, { outline: 0.005 });
          mk(cyl(0.015, 0.018, 0.05, 8), cap, [0.1 + (i - 1) * 0.08, top + h + 0.025, 0.12], g, { outline: 0.003 });
        });
      }
      addObstacle(p.x, p.z, 0.24, 0.24, p.rot);
      g.userData.hit = [0.5, 1.1, 0.5, 0.55]; g.userData.sayY = 1.35;
      return true;
    }
    case "bartender": { // 바텐더 (50대, 날카로운 인상, 흰 셔츠 + 검정 나비넥타이, 파마 단발, 뿔테 안경)
      const skin = "#f0c9a6", hair = "#2a211d", jacket = "#fbfaf6", pants = "#1f1f22"; // jacket = 셔츠 소매 색
      const body = new THREE.Group(); g.add(body);
      g.userData.bt = body;
      // 다리 (검정 바지, 검정 구두)
      for (const sx of [-1, 1]) mk(new THREE.CapsuleGeometry(0.075, 0.62, 4, 10), pants, [sx * 0.1, 0.42, 0], body, { outline: 0.012 });
      for (const sx of [-1, 1]) mk(box(0.12, 0.06, 0.22), "#111113", [sx * 0.1, 0.03, 0.04], body, { outline: 0.006 });
      // 흰 셔츠 몸통
      const torso = mk(new THREE.CapsuleGeometry(0.18, 0.4, 6, 14), jacket, [0, 1.06, 0], body, { outline: 0.012 });
      torso.scale.set(1.08, 1, 0.82);
      mk(box(0.34, 0.05, 0.22), pants, [0, 0.78, 0], body, { outline: 0.008 }); // 허리 (바지 위)
      mk(box(0.06, 0.035, 0.015), "#c9a54a", [0, 0.78, 0.115], body, { outline: 0, shadow: false }); // 버클
      // 셔츠 단추 줄 + 깃
      for (let i = 0; i < 4; i++) mk(new THREE.SphereGeometry(0.008, 6, 4), "#d9d6cf", [0.035, 0.9 + i * 0.09, 0.15], body, { outline: 0, shadow: false });
      for (const sx of [-1, 1]) {
        const col = mk(box(0.09, 0.05, 0.02), jacket, [sx * 0.045, 1.33, 0.12], body, { outline: 0.006 });
        col.rotation.z = sx * -0.5;
      }
      // 검정 나비넥타이 (가운데 매듭 + 양쪽 날개)
      mk(box(0.03, 0.035, 0.03), "#111113", [0, 1.3, 0.145], body, { outline: 0.004 });
      for (const sx of [-1, 1]) {
        const wing = mk(new THREE.ConeGeometry(0.035, 0.07, 4), "#111113", [sx * 0.045, 1.3, 0.14], body, { outline: 0.004 });
        wing.rotation.z = sx * Math.PI / 2; // 뾰족한 쪽이 매듭을 향함
        wing.scale.set(1, 1, 0.5);
      }
      // 한 손은 옆으로 내리고, 다른 손은 앞으로 위스키 병을 들고 있음
      mk(new THREE.CapsuleGeometry(0.06, 0.36, 4, 10), jacket, [-0.25, 1.04, 0], body, { outline: 0.012 }).rotation.z = -0.08;
      mk(new THREE.SphereGeometry(0.045, 8, 6), skin, [-0.27, 0.8, 0.01], body, { outline: 0.006 });
      mk(new THREE.CapsuleGeometry(0.06, 0.2, 4, 10), jacket, [0.25, 1.15, 0], body, { outline: 0.012 }); // 위팔
      const fore = mk(new THREE.CapsuleGeometry(0.058, 0.2, 4, 10), jacket, [0.23, 1.13, 0.12], body, { outline: 0.012 }); // 아래팔 (앞으로, 위로)
      fore.rotation.x = Math.PI / 2 - 0.75;
      mk(new THREE.SphereGeometry(0.05, 8, 6), skin, [0.22, 1.24, 0.23], body, { outline: 0.006 }); // 손
      // 위스키 병 (호박색, 라벨, 목, 뚜껑)
      const bottle = new THREE.Group(); bottle.position.set(0.22, 1.33, 0.25); body.add(bottle);
      g.userData.bottle = bottle;
      { // 물 서비스용 투명 하이볼잔 (평소엔 숨김)
        const hg = new THREE.Group(); hg.position.copy(bottle.position); hg.visible = false; body.add(hg);
        mk(new THREE.CylinderGeometry(0.036, 0.032, 0.15, 16, 1, true), new THREE.MeshBasicMaterial({ color: "#e8f4f8", transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }), [0, 0, 0], hg, { outline: 0, shadow: false });
        mk(cyl(0.032, 0.03, 0.11, 14), new THREE.MeshBasicMaterial({ color: "#cfe9f2", transparent: true, opacity: 0.5 }), [0, -0.018, 0], hg, { outline: 0, shadow: false });
        g.userData.handGlass = hg;
      }
      mk(cyl(0.05, 0.052, 0.22, 14), new THREE.MeshBasicMaterial({ color: "#c7782c" }), [0, 0, 0], bottle, { outline: 0.008 });
      mk(cyl(0.0515, 0.0535, 0.09, 14), "#f2ead6", [0, 0.01, 0], bottle, { outline: 0 });
      mk(cyl(0.02, 0.04, 0.06, 10), new THREE.MeshBasicMaterial({ color: "#b0651f" }), [0, 0.14, 0], bottle, { outline: 0.005 });
      mk(cyl(0.018, 0.018, 0.06, 8), new THREE.MeshBasicMaterial({ color: "#b0651f" }), [0, 0.2, 0], bottle, { outline: 0.004 });
      mk(cyl(0.021, 0.021, 0.035, 8), "#2a2522", [0, 0.245, 0], bottle, { outline: 0.004 });
      // 머리
      const head = new THREE.Group(); head.position.set(0, 1.55, 0); body.add(head);
      g.userData.btHead = head;
      // 50대, 날카로운 인상: 갸름하고 긴 얼굴, 각진 턱, 찡그린 듯한 눈썹, 가는 눈, 팔자 주름, 수염 자국
      const face = mk(new THREE.SphereGeometry(0.16, 22, 18), "#e2b48e", [0, 0, 0], head, { outline: 0.02 });
      face.scale.set(0.88, 1.18, 0.95);
      const jaw = mk(box(0.17, 0.08, 0.16), "#e2b48e", [0, -0.14, 0.02], head, { outline: 0.012 }); // 각진 턱
      jaw.rotation.x = 0.15;
      mk(box(0.15, 0.07, 0.01), new THREE.MeshBasicMaterial({ color: "#7d6a5e", transparent: true, opacity: 0.35 }), [0, -0.13, 0.105], head, { outline: 0, shadow: false }); // 수염 자국
      // 정수리 머리 + 흰머리 섞임
      const cap = mk(new THREE.SphereGeometry(0.168, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.5), hair, [0, 0.05, -0.04], head, { outline: 0 });
      cap.rotation.x = -0.6; cap.scale.set(0.95, 1.1, 1);
      for (const sx of [-0.06, 0.04]) mk(box(0.012, 0.01, 0.16), "#8e8a86", [sx, 0.19, -0.04], head, { outline: 0, shadow: false }).rotation.x = -0.4;
      // 파마 단발: 매끈한 윤곽 + 크고 납작한 웨이브 몇 겹 (이마는 드러남, 턱선 길이)
      const shellGeo = new THREE.SphereGeometry(0.2, 24, 14, Math.PI * 0.5 + 1.05, Math.PI * 2 - 2.1, 0, Math.PI * 0.66);
      const shell = mk(shellGeo, toon(hair, { side: THREE.DoubleSide }), [0, 0.0, -0.01], head, { outline: 0.008, shadow: false });
      shell.scale.set(1.1, 1.12, 1.06); // 부피 있게
      const waveGeo = new THREE.SphereGeometry(0.085, 12, 8);
      let wi = 0;
      for (const [y, R, front, n] of [[0.09, 0.2, 64, 6], [-0.03, 0.225, 68, 6], [-0.14, 0.215, 72, 6]]) {
        for (let i = 0; i < n; i++) {
          const th = (i / n) * Math.PI * 2 + y * 3 + 0.2;
          const deg = Math.abs(THREE.MathUtils.radToDeg(Math.atan2(Math.sin(th), Math.cos(th))));
          if (deg < front) continue;
          const w = mk(waveGeo, wi++ % 7 === 3 ? "#6f6a66" : hair, [Math.sin(th) * R, y, Math.cos(th) * R - 0.01], head, { outline: 0.005, shadow: false });
          w.rotation.y = th; w.scale.set(1.25, 0.72, 0.55); // 굵고 두툼한 물결
        }
      }
      const ink = new THREE.MeshBasicMaterial({ color: "#1b1b1f" });
      // 날카로운 눈썹 (안쪽이 내려간 각)
      for (const sx of [-1, 1]) {
        const brow = mk(box(0.075, 0.016, 0.02), hair, [sx * 0.058, 0.07, 0.15], head, { outline: 0.004, shadow: false });
        brow.rotation.z = sx * 0.3;
      }
      // 가늘고 매서운 눈
      for (const sx of [-1, 1]) {
        const e = mk(new THREE.SphereGeometry(0.02, 10, 6), ink, [sx * 0.058, 0.018, 0.152], head, { outline: 0, shadow: false });
        e.scale.set(1.5, 0.55, 0.6);
      }
      // 콧대 + 팔자 주름 + 한쪽만 올라간 입꼬리
      mk(box(0.022, 0.09, 0.03), "#d7a47e", [0, -0.02, 0.16], head, { outline: 0.004, shadow: false });
      for (const sx of [-1, 1]) {
        const fold = mk(box(0.006, 0.07, 0.006), "#8c5e46", [sx * 0.045, -0.075, 0.145], head, { outline: 0, shadow: false });
        fold.rotation.z = sx * -0.35;
      }
      const mouth = mk(box(0.06, 0.008, 0.01), "#6e3e32", [0.005, -0.11, 0.142], head, { outline: 0, shadow: false });
      mouth.rotation.z = 0.12;
      // 동그란 갈색 뿔테 안경
      const frame = "#6b3f24";
      for (const sx of [-1, 1]) {
        mk(new THREE.TorusGeometry(0.043, 0.011, 6, 18), frame, [sx * 0.06, 0.015, 0.163], head, { outline: 0, shadow: false });
        mk(new THREE.CircleGeometry(0.038, 16), new THREE.MeshBasicMaterial({ color: "#cfe3ec", transparent: true, opacity: 0.3 }), [sx * 0.06, 0.015, 0.161], head, { outline: 0, shadow: false });
        mk(box(0.012, 0.012, 0.15), frame, [sx * 0.105, 0.02, 0.09], head, { outline: 0, shadow: false });
      }
      mk(box(0.03, 0.01, 0.01), frame, [0, 0.025, 0.168], head, { outline: 0, shadow: false });
      // 부딪힘은 몸통 크기만큼만 (collide 에서 따로 처리) + 바 안쪽 걷기 경로
      g.userData.prop = p;
      if (p.walkPath) {
        const P = p.walkPath, seg = [];
        let L = 0;
        for (let i = 0; i < P.length - 1; i++) { const l = Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]); seg.push(l); L += l; }
        Object.assign(g.userData, { path: P, seg, L, s: L * 0.4, target: L * 0.4, wait: 2, side: 0, yaw: g.rotation.y });
      }
      g.userData.hit = [0.5, 1.8, 0.5, 0.9]; g.userData.sayY = 2.0;
      bartenders.push(g);
      return true;
    }
    case "candles": { // 장 위 양초 (은은하게 빛남)
      const y0 = p.y0 ?? 0.99;
      [0.16, 0.22, 0.12, 0.18].forEach((h, i) => {
        const x = (i - 1.5) * 0.12;
        mk(cyl(0.045, 0.045, h, 14), "#f6e6c4", [x, y0 + h / 2, 0], g, { outline: 0.006, shadow: false });
        mk(new THREE.SphereGeometry(0.016, 8, 6), glowMat("#ffd27a"), [x, y0 + h + 0.025, 0], g, { outline: 0, shadow: false }).scale.y = 1.8;
      });
      addHalo(g, 0, y0 + 0.25, 0, 0.9, "#ffc27a", true);
      lightPool(g, 0, y0 + 0.005, 0, 0.9, 0.5, "#ffb065", 0.1, 0.5);
      g.userData.hit = [0.6, 0.4, 0.3, y0 + 0.15]; g.userData.sayY = y0 + 0.45;
      return true;
    }
    case "projector": {
      mk(box(0.6, 0.04, 0.5), "#8a6a4a", [0, H - 0.18, 0], g, { outline: 0.008, shadow: false });
      mk(box(0.34, 0.12, 0.28), "#f1f1f1", [0, H - 0.27, 0], g, { outline: 0.008, shadow: false });
      mk(cyl(0.04, 0.04, 0.03, 12), glowMat("#9fd0ff"), [0, H - 0.27, 0.15], g, { outline: 0, shadow: false }).rotation.x = Math.PI / 2;
      for (const sx of [-1, 1]) mk(cyl(0.008, 0.008, 0.18, 4), "#ddd", [sx * 0.25, H - 0.09, 0], g, { outline: 0, shadow: false });
      g.userData.hit = [0.6, 0.3, 0.5, H - 0.25]; g.userData.sayY = H - 0.5;
      return true;
    }
  }
  return false;
}

/** 말풍선용 누르는 영역 */
function addSayHit(p, g, hit, sayY, pos) {
  if (!g) { g = new THREE.Group(); g.position.set(pos.x, 0, pos.z); roomGroup.add(g); }
  const hb = new THREE.Mesh(box(hit[0], hit[1], hit[2]), hitMat);
  hb.position.set(0, hit[3], 0);
  const info = { kind: "prop", prop: p, group: g, idx: sayProps.length, wiggle: 0, sayY };
  hb.userData = info;
  g.add(hb);
  interactives.push(hb);
  if (!g.userData.path) aimBlockers.push(hb); // 바텐더는 막지 않음
  sayProps.push(info);
}

/** 숲 영상 느낌 슬라이드 (TV) */
function drawForest(ctx, W, H, t = 0) {
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, "#9cc8ef"); sky.addColorStop(1, "#d7e8f7");
  ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
  ctx.lineCap = "round";
  for (let i = 0; i < 14; i++) {
    const x = (i * 83 + 40) % W, w = 6 + (i % 4) * 4;
    ctx.strokeStyle = i % 2 ? "#4a6a9a" : "#5f80ad"; ctx.lineWidth = w;
    ctx.beginPath(); ctx.moveTo(x, H); ctx.lineTo(x + Math.sin(i) * 20, 0); ctx.stroke();
    ctx.lineWidth = 3;
    for (let b = 0; b < 3; b++) { const y = H * (0.2 + b * 0.22); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (b % 2 ? 40 : -40), y - 30); ctx.stroke(); }
  }
  // 주황 단풍 (살랑살랑)
  for (let i = 0; i < 70; i++) {
    const x = W * 0.45 + ((i * 53) % (W * 0.55)), y = H * 0.35 + ((i * 37) % (H * 0.65));
    ctx.fillStyle = i % 3 ? "#f08a2c" : "#f6b04a";
    ctx.save(); ctx.translate(x + Math.sin(t * 1.5 + i) * 3, y); ctx.rotate(i + Math.sin(t + i) * 0.3);
    ctx.beginPath(); ctx.ellipse(0, 0, 14, 7, 0, 0, Math.PI * 2); ctx.fill();
    if (LINE) { ctx.strokeStyle = "#1b1b1f"; ctx.lineWidth = 2; ctx.stroke(); }
    ctx.restore();
  }
}

// ───────── 자리(의자 + 손님) ─────────
const emptyTagTex = (() => {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 150;
  const g = c.getContext("2d");
  g.fillStyle = "#2fa877"; g.strokeStyle = "#ffffff"; g.lineWidth = 8;
  g.beginPath(); g.roundRect(8, 8, 240, 96, 48); g.fill(); g.stroke();
  g.beginPath(); g.moveTo(108, 100); g.lineTo(128, 140); g.lineTo(148, 100); g.closePath(); g.fill();
  g.fillStyle = "#ffffff"; g.font = "800 54px 'Pretendard','Apple SD Gothic Neo','Noto Sans KR',sans-serif";
  g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("빈자리", 128, 58);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
const gemMat = new THREE.MeshBasicMaterial({ color: "#2fc489" });
const gemShine = new THREE.MeshBasicMaterial({ color: "#bff5dc" });
const aimBoxes = [];
const aimBlockers = []; // 조준을 막는 것: 바 몸통·소품
/** @type {Map<string, any>} */
const seats = new Map();
const hitboxes = [];
const tableGroups = []; // { id, label, seatIds }
const hitMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });

const SHIRTS = ["#7fb3e8", "#f2a9a0", "#f5cf6b", "#a8d5a2", "#c3a6e0", "#f7b878", "#8fd3cf", "#e89ac0"];
const SKINS = ["#ffdcc0", "#f5cba7", "#e8b894", "#ffe4cf"];
const HAIR = ["#3b2f2a", "#5a3c2c", "#2a2430", "#7a5338", "#c58b4f"];
const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

function makeGuest(id, seatY) {
  const h = hash(id);
  const g = new THREE.Group();
  const shirt = SHIRTS[h % SHIRTS.length];
  const skin = SKINS[(h >> 3) % SKINS.length];
  const hair = HAIR[(h >> 6) % HAIR.length];
  mk(new THREE.CapsuleGeometry(0.15, 0.2, 6, 14), shirt, [0, seatY + 0.26, -0.03], g, { outline: 0.02 });
  const head = new THREE.Group();
  head.position.set(0, seatY + 0.66, -0.02);
  g.add(head);
  mk(new THREE.SphereGeometry(0.16, 20, 16), skin, [0, 0, 0], head, { outline: 0.02 });
  const hairM = mk(new THREE.SphereGeometry(0.17, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), hair, [0, 0.02, -0.015], head, { outline: 0 });
  hairM.rotation.x = -0.25;
  const eye = new THREE.MeshBasicMaterial({ color: "#1b1b1f" });
  if (LINE) {
    // 흰자 + 동그란 눈동자 + 눈썹 (손그림 캐릭터 느낌)
    const white = new THREE.MeshBasicMaterial({ color: "#eef3fb" });
    for (const sx of [-1, 1]) {
      const w = mk(new THREE.SphereGeometry(0.04, 12, 8), white, [sx * 0.058, 0.005, 0.135], head, { outline: 0.006, shadow: false });
      w.scale.set(1.15, 0.8, 0.6);
      mk(new THREE.SphereGeometry(0.016, 8, 6), eye, [sx * 0.058, 0.0, 0.162], head, { outline: 0, shadow: false });
      const brow = mk(box(0.07, 0.016, 0.02), hair, [sx * 0.06, 0.068, 0.142], head, { outline: 0.004, shadow: false });
      brow.rotation.z = sx * -0.12;
    }
    mk(new THREE.SphereGeometry(0.018, 8, 6), skin, [0, -0.035, 0.158], head, { outline: 0.005, shadow: false });
  } else {
    mk(new THREE.SphereGeometry(0.022, 8, 6), eye, [-0.055, 0.0, 0.148], head, { outline: 0, shadow: false });
    mk(new THREE.SphereGeometry(0.022, 8, 6), eye, [0.055, 0.0, 0.148], head, { outline: 0, shadow: false });
  }
  const cheek = new THREE.MeshBasicMaterial({ color: "#f59a8f", transparent: true, opacity: 0.7 });
  mk(new THREE.SphereGeometry(0.025, 8, 6), cheek, [-0.095, -0.045, 0.13], head, { outline: 0, shadow: false });
  mk(new THREE.SphereGeometry(0.025, 8, 6), cheek, [0.095, -0.045, 0.13], head, { outline: 0, shadow: false });
  // 팔 (테이블 쪽으로)
  const arms = [];
  for (const sx of [-1, 1]) {
    // 어깨를 중심으로 돌도록 피벗 그룹
    const pivot = new THREE.Group();
    pivot.position.set(sx * 0.16, seatY + 0.42, 0);
    pivot.rotation.x = -1.1; // 테이블 쪽으로 팔을 뻗음
    g.add(pivot);
    mk(new THREE.CapsuleGeometry(0.045, 0.2, 4, 8), shirt, [0, -0.12, 0], pivot, { outline: 0.015 });
    arms.push(pivot);
  }
  g.userData.arms = arms;
  g.userData.wave = 0;
  g.userData.lastWave = -99;
  g.userData.headY = seatY + 0.66;
  g.userData.head = head;
  g.userData.phase = (h % 100) / 16;
  g.visible = false;
  g.scale.setScalar(0.001);
  return g;
}

/** 자리 하나 만들기. angle: 손님이 바라보는 방향(라디안) */
function addSeat(id, x, z, angle, kind) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = angle;
  roomGroup.add(g);

  let seatY, cushion;
  const ink = "#232325";
  if (kind === "barstool") {
    // 검은 철제 다리 + 합판 좌석 + 흰 방석 + 둥근 등받이 (사진 속 바 의자)
    seatY = 0.72;
    mk(cyl(0.022, 0.022, seatY - 0.25, 8), ink, [0, 0.25 + (seatY - 0.25) / 2, 0], g, { outline: 0.006 });
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + Math.PI / 4, leg = new THREE.Group();
      leg.position.set(0, 0.26, 0); leg.rotation.y = a;
      g.add(leg);
      mk(cyl(0.012, 0.012, 0.42, 6), ink, [0.17, -0.12, 0], leg, { outline: 0.004 }).rotation.z = 0.95;
    }
    mk(new THREE.TorusGeometry(0.17, 0.01, 6, 24), ink, [0, 0.2, 0], g, { outline: 0 }).rotation.x = Math.PI / 2;
    mk(cyl(0.2, 0.2, 0.035, 22), "#d9b98f", [0, seatY - 0.02, 0], g, { outline: 0.01 });
    cushion = mk(cyl(0.18, 0.18, 0.05, 22), toon("#f3eeea", { unique: true }), [0, seatY + 0.02, 0.01], g, { outline: 0.01 });
    for (const sx of [-1, 1]) mk(cyl(0.01, 0.01, 0.42, 6), ink, [sx * 0.11, seatY + 0.2, -0.19], g, { outline: 0.004 });
    mk(new THREE.TorusGeometry(0.11, 0.01, 6, 16, Math.PI), ink, [0, seatY + 0.41, -0.19], g, { outline: 0 });
    const back = mk(box(0.34, 0.2, 0.03), "#e3c79e", [0, seatY + 0.33, -0.21], g, { outline: 0.008 });
    back.rotation.x = 0.12;
    seatY += 0.04;
  } else if (kind === "rattan") {
    // 원목 프레임 + 등나무(라탄) 등받이 팔걸이 의자
    seatY = 0.46;
    const wood = "#a8743f";
    for (const [lx, lz] of [[-0.2, -0.18], [0.2, -0.18], [-0.2, 0.18], [0.2, 0.18]]) mk(cyl(0.018, 0.02, seatY, 6), wood, [lx, seatY / 2, lz], g, { outline: 0.006 });
    mk(box(0.48, 0.04, 0.44), wood, [0, seatY, 0], g, { outline: 0.01 });
    cushion = mk(box(0.42, 0.05, 0.38), toon("#efe9e2", { unique: true }), [0, seatY + 0.045, 0.02], g, { outline: 0.008 });
    const cane = mk(box(0.44, 0.32, 0.025), toon("#ffffff", { map: caneTex }), [0, seatY + 0.3, -0.21], g, { outline: 0.008 });
    cane.rotation.x = 0.1;
    mk(box(0.5, 0.04, 0.05), wood, [0, seatY + 0.47, -0.22], g, { outline: 0.008 });
    for (const sx of [-1, 1]) {
      mk(box(0.04, 0.04, 0.4), wood, [sx * 0.24, seatY + 0.2, -0.02], g, { outline: 0.006 });
      mk(cyl(0.015, 0.015, 0.2, 6), wood, [sx * 0.24, seatY + 0.1, 0.16], g, { outline: 0.004 });
      mk(box(0.04, 0.5, 0.04), wood, [sx * 0.23, seatY + 0.24, -0.21], g, { outline: 0.006 });
    }
    seatY += 0.05;
  } else if (kind === "windsor") {
    // 살대 등받이 원목 의자
    seatY = 0.45;
    const wood = "#b98a58";
    for (const [lx, lz] of [[-0.17, -0.15], [0.17, -0.15], [-0.17, 0.17], [0.17, 0.17]]) mk(cyl(0.017, 0.02, seatY, 6), wood, [lx, seatY / 2, lz], g, { outline: 0.006 });
    cushion = mk(cyl(0.23, 0.23, 0.05, 20), toon(wood, { unique: true }), [0, seatY, 0], g, { outline: 0.01 });
    for (let i = -2; i <= 2; i++) mk(cyl(0.009, 0.009, 0.42, 5), wood, [i * 0.075, seatY + 0.23, -0.18], g, { outline: 0.004 });
    mk(new THREE.TorusGeometry(0.2, 0.018, 6, 18, Math.PI), wood, [0, seatY + 0.42, -0.18], g, { outline: 0.004 });
    seatY += 0.03;
  } else if (kind === "stool") {
    seatY = 0.78;
    mk(cyl(0.03, 0.03, seatY - 0.04, 8), "#6b6f75", [0, (seatY - 0.04) / 2, 0], g, { outline: 0.012 });
    mk(cyl(0.16, 0.18, 0.03, 16), "#6b6f75", [0, 0.015, 0], g, { outline: 0.012 });
    mk(new THREE.TorusGeometry(0.13, 0.012, 6, 20), "#6b6f75", [0, 0.3, 0], g, { outline: 0 }).rotation.x = Math.PI / 2;
    cushion = mk(cyl(0.19, 0.19, 0.07, 20), toon(COLOR.empty, { unique: true }), [0, seatY, 0], g, { outline: 0.02 });
  } else {
    seatY = 0.46;
    for (const [lx, lz] of [[-0.17, -0.17], [0.17, -0.17], [-0.17, 0.17], [0.17, 0.17]]) {
      mk(box(0.045, seatY, 0.045), COLOR.woodDark, [lx, seatY / 2, lz], g, { outline: 0.01 });
    }
    mk(box(0.44, 0.05, 0.44), COLOR.wood, [0, seatY, 0], g, { outline: 0.015 });
    cushion = mk(box(0.38, 0.05, 0.38), toon(COLOR.empty, { unique: true }), [0, seatY + 0.05, 0.01], g, { outline: 0.012 });
    mk(box(0.44, 0.42, 0.05), COLOR.wood, [0, seatY + 0.27, -0.2], g, { outline: 0.015 });
    seatY += 0.05;
  }

  const guest = makeGuest(id, seatY);
  g.add(guest);

  // 빈자리 위에 둥실둥실 빙글 도는 작은 초록 보석 (사람이 앉으면 사라짐)
  const tag = new THREE.Group();
  tag.position.y = kind === "stool" || kind === "barstool" ? 1.25 : 1.0;
  const gem = mk(new THREE.OctahedronGeometry(0.055, 0), gemMat, [0, 0, 0], tag, { outline: 0.004, shadow: false });
  gem.scale.set(1, 1.45, 1);
  mk(new THREE.OctahedronGeometry(0.03, 0), gemShine, [0.012, 0.025, 0.02], tag, { outline: 0, shadow: false }).scale.set(0.6, 1, 0.3);
  { const h = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, color: "#5fe0a8", transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending })); h.scale.set(0.3, 0.3, 1); h.renderOrder = 3; tag.add(h); }
  g.add(tag);

  // 조준 안내용 작은 판정 (의자 몸통 크기)
  const ab = new THREE.Mesh(box(0.42, seatY + 0.35, 0.42), hitMat);
  ab.position.y = (seatY + 0.35) / 2; ab.userData.seatId = id; ab.castShadow = false;
  g.add(ab); aimBoxes.push(ab);
  const hb = new THREE.Mesh(box(0.6, 1.4, 0.6), hitMat);
  hb.position.y = 0.7;
  hb.userData.seatId = id;
  hb.castShadow = false;
  g.add(hb);
  hitboxes.push(hb);

  seats.set(id, { id, group: g, cushion, guest, tag, tagY: tag.position.y, seatY, occupied: false, anim: 0, target: 0, bump: 0 });
}

function rotXZ(x, z, deg) {
  const a = THREE.MathUtils.degToRad(deg || 0);
  return [x * Math.cos(a) - z * Math.sin(a), x * Math.sin(a) + z * Math.cos(a)];
}

function buildTables() {
  for (const t of LAYOUT.tables || []) {
    const g = new THREE.Group();
    g.position.set(t.x, 0, t.z);
    g.rotation.y = THREE.MathUtils.degToRad(-(t.rot || 0));
    roomGroup.add(g);
    const H = 0.74;
    const local = []; // [x, z] 테이블 기준 의자 위치
    if (t.shape === "round") addObstacle(t.x, t.z, t.r, t.r, t.rot);
    else if (t.shape === "dropleaf") { const [ox, oz] = rotXZ(0, (t.r ?? t.w / 2) / 2, t.rot); addObstacle(t.x + ox, t.z + oz, t.w / 2, (t.d + (t.r ?? t.w / 2)) / 2, t.rot); }
    else if (t.shape === "half") { const [ox, oz] = rotXZ(0, t.r / 2, t.rot); addObstacle(t.x + ox, t.z + oz, t.r, t.r / 2, t.rot); }
    else addObstacle(t.x, t.z, t.w / 2, t.d / 2, t.rot);
    const topCol = t.color || "#f1dcc2", leg = t.leg || COLOR.woodDark;
    if (t.shape === "dropleaf") {
      // 사각 상판 + 접었다 펼 수 있는 반원 날개 (평평한 쪽이 테이블 기준 -z)
      const r = t.r ?? t.w / 2;
      mk(box(t.w, 0.05, t.d), topCol, [0, H, 0], g, { outline: 0.018 });
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) mk(box(0.05, H, 0.05), leg, [sx * (t.w / 2 - 0.07), H / 2, sz * (t.d / 2 - 0.07)], g, { outline: 0.008 });
      const pivot = new THREE.Group();
      pivot.position.set(0, H + 0.025, t.d / 2);
      g.add(pivot);
      const half = (rr, h) => new THREE.CylinderGeometry(rr, rr, h, 36, 1, false, -Math.PI / 2, Math.PI);
      const leaf = new THREE.Mesh(half(r, 0.045), typeof topCol === "string" ? toon(topCol) : topCol);
      leaf.position.set(0, -0.0225, 0.004);
      pivot.add(leaf);
      const k = 0.02 * OL;
      const lo = new THREE.Mesh(half(r + k, 0.045 + k * 2), outlineMat);
      lo.position.set(0, -0.0225, 0.004 - k / 2);
      lo.raycast = () => {};
      pivot.add(lo);
      // 접힌 날개를 받쳐 주는 경첩 선
      mk(box(t.w * 0.9, 0.012, 0.012), "#3a281f", [0, H - 0.01, t.d / 2], g, { outline: 0, shadow: false });
      leaves.push({ pivot, open: 1, target: 1 });
      const lf = leaves[leaves.length - 1];
      // 손님이 누르면 날개를 접었다 폈다
      addSayHit({ ...t, type: "dropleaf", say: t.say || "반원 날개를 접었다 펼 수 있는 테이블이에요" }, g, [t.w + 0.2, 0.3, t.d + r, H], H + 0.45);
      sayProps[sayProps.length - 1].onTap = () => { lf.target = lf.target ? 0 : 1; };
      if (!t.chairs) local.push([-(t.w / 2 + 0.4), 0.05], [0, t.d / 2 + r + 0.34], [t.w / 2 + 0.4, 0.05]);
    } else if (t.shape === "half") {
      // 반원 테이블: 평평한 쪽이 테이블 기준 -z (layout 에서 rot 로 방향), 둥근 쪽에 의자
      const half = (r, h) => new THREE.CylinderGeometry(r, r, h, 40, 1, false, -Math.PI / 2, Math.PI);
      mk(half(t.r, 0.05), topCol, [0, H, 0], g, { outline: 0 });
      const k = 0.022 * OL;
      const o = new THREE.Mesh(half(t.r + k, 0.05 + k * 2), outlineMat);
      o.position.set(0, H, -k / 2);
      g.add(o);
      mk(box(t.r * 2, 0.05, 0.01), topCol, [0, H, 0.005], g, { outline: 0 });
      mk(cyl(0.04, 0.04, H, 8), leg, [0, H / 2, t.r * 0.4], g, { outline: 0.008 });
      mk(cyl(0.22, 0.26, 0.04, 18), leg, [0, 0.02, t.r * 0.4], g, { outline: 0.008 });
      const n = t.seats, dist = t.r + 0.36;
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (Math.PI * (i + 0.5)) / n; // 둥근 쪽에 고르게
        local.push([Math.sin(a) * dist, Math.cos(a) * dist + 0.05]);
      }
    } else if (t.shape === "oval") {
      const m = mk(cyl(0.5, 0.5, 0.05, 40), topCol, [0, H, 0], g, { outline: 0 });
      m.scale.set(t.w, 1, t.d);
      const o = mk(cyl(0.5, 0.5, 0.05, 40), outlineMat, [0, H, 0], g, { outline: 0, shadow: false });
      o.scale.set(t.w + 0.05 * OL / 2, 1.5, t.d + 0.05 * OL / 2);
      for (const sx of [-1, 1]) {
        mk(cyl(0.035, 0.035, H, 8), leg, [sx * t.w * 0.3, H / 2, 0], g, { outline: 0.008 });
        mk(box(0.06, 0.04, t.d * 0.6), leg, [sx * t.w * 0.3, 0.03, 0], g, { outline: 0.008 });
      }
      const n = t.seats;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.PI / n;
        local.push([Math.sin(a) * (t.w / 2 + 0.38), Math.cos(a) * (t.d / 2 + 0.38)]);
      }
    } else if (t.shape === "round") {
      mk(cyl(t.r, t.r, 0.05, 32), topCol, [0, H, 0], g);
      mk(cyl(0.04, 0.04, H, 10), COLOR.woodDark, [0, H / 2, 0], g, { outline: 0.012 });
      mk(cyl(0.25, 0.28, 0.04, 20), COLOR.woodDark, [0, 0.02, 0], g);
      const dist = t.r + 0.32;
      for (let i = 0; i < t.seats; i++) {
        const a = (i / t.seats) * Math.PI * 2 + (t.seats === 2 ? 0 : Math.PI / t.seats);
        local.push([Math.sin(a) * dist, -Math.cos(a) * dist]);
      }
    } else {
      mk(box(t.w, 0.06, t.d), topCol, [0, H, 0], g);
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        mk(box(0.06, H, 0.06), leg, [sx * (t.w / 2 - 0.08), H / 2, sz * (t.d / 2 - 0.08)], g, { outline: 0.012 });
      }
      const top = Math.ceil(t.seats / 2), bottom = t.seats - top;
      const row = (n, z) => {
        for (let i = 0; i < n; i++) local.push([(-(n - 1) / 2 + i) * (t.w / Math.max(n, 1)), z]);
      };
      row(top, -(t.d / 2 + 0.32));
      row(bottom, t.d / 2 + 0.32);
    }
    if (t.chairs) { local.length = 0; local.push(...t.chairs); } // 의자 위치 직접 지정
    // 컵 / 테이블 램프 (분위기)
    mk(cyl(0.05, 0.04, 0.1, 12), "#ffffff", [0.08, H + 0.08, 0.02], g, { outline: 0.01 });
    if (t.lamp) {
      const lx = t.lamp[0], lz = t.lamp[1];
      mk(cyl(0.05, 0.06, 0.02, 12), "#1f1f22", [lx, H + 0.035, lz], g, { outline: 0.005, shadow: false });
      mk(cyl(0.012, 0.012, 0.2, 6), "#1f1f22", [lx, H + 0.13, lz], g, { outline: 0.004, shadow: false });
      mk(new THREE.CylinderGeometry(0.05, 0.08, 0.1, 16, 1, true), toon("#1f1f22", { side: THREE.DoubleSide }), [lx, H + 0.25, lz], g, { outline: 0.005, shadow: false });
      mk(new THREE.SphereGeometry(0.03, 8, 6), glowMat("#fff1c0"), [lx, H + 0.21, lz], g, { outline: 0, shadow: false });
      addHalo(g, lx, H + 0.2, lz, 0.9, "#ffcf8a", true);
      lightPool(g, lx * 0.5, H + 0.036, lz * 0.5, 1.2, 1.2, "#ffb065", 0.08, 0.42); // 상판에 은은하게 고이는 불빛
    }

    const label = textSprite(t.id, { size: 0.26 });
    label.position.set(t.x, H + 1.0, t.z);
    roomGroup.add(label);
    labelSprites.push(label);

    const ids = [];
    local.forEach(([lx, lz], i) => {
      const [rx, rz] = rotXZ(lx, lz, t.rot);
      const id = `${t.id}-${i + 1}`;
      addSeat(id, t.x + rx, t.z + rz, Math.atan2(-rx, -rz), t.chair || "chair");
      ids.push(id);
    });
    tableGroups.push({ id: t.id, seatIds: ids });
  }

  for (const b of LAYOUT.bars || []) {
    if (b.path) { buildCurvedBar(b); continue; }
    const g = new THREE.Group();
    g.position.set(b.x, 0, b.z);
    g.rotation.y = THREE.MathUtils.degToRad(-(b.rot || 0));
    roomGroup.add(g);
    addObstacle(b.x, b.z, b.length / 2, 0.3, b.rot);
    mk(box(b.length, 1.0, 0.45), "#f3e3cf", [0, 0.5, -0.05], g);
    mk(box(b.length + 0.1, 0.06, 0.6), COLOR.woodDark, [0, 1.03, 0], g);
    const label = textSprite(b.id, { size: 0.26 });
    label.position.set(b.x, 2.0, b.z);
    roomGroup.add(label);
    labelSprites.push(label);
    const ids = [];
    for (let i = 0; i < b.seats; i++) {
      const lx = (-(b.seats - 1) / 2 + i) * (b.length / b.seats);
      const [rx, rz] = rotXZ(lx, 0.62, b.rot);
      const [fx, fz] = rotXZ(0, 0.62, b.rot); // 바 쪽을 바라보도록
      const id = `${b.id}-${i + 1}`;
      addSeat(id, b.x + rx, b.z + rz, Math.atan2(-fx, -fz), "stool");
      ids.push(id);
    }
    tableGroups.push({ id: b.id, seatIds: ids });
  }
}

async function loadModel() {
  if (!LAYOUT.model) return false;
  try {
    const gltf = await new GLTFLoader().loadAsync(LAYOUT.model);
    gltf.scene.traverse((o) => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; } });
    scene.add(gltf.scene);
    return true;
  } catch (e) {
    console.warn("3D 모델을 불러오지 못해 기본 배치도로 표시합니다", e);
    return false;
  }
}

// ───────── 가상 스크린 (광고 자리) ─────────
const screens = [];
function buildScreens() {
  for (const cfg of LAYOUT.screens || []) {
    const W = 960, H = Math.round(960 * cfg.h / cfg.w);
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const g = new THREE.Group();
    const parent = cfg.wall === "right" ? fpGroup : roomGroup;
    if (cfg.wall === "back") g.position.set(cfg.x, cfg.y, (cfg.z ?? 0) + 0.06);
    else if (cfg.wall === "right") { g.position.set(R.w - (cfg.projected ? 0.01 : 0.06), cfg.y, cfg.z); g.rotation.y = -Math.PI / 2; }
    else { g.position.set(0.06, cfg.y, cfg.z); g.rotation.y = Math.PI / 2; }
    parent.add(g);
    let face;
    if (cfg.projected) { // 프로젝터가 벽에 비춘 화면: 테두리 없이 빛으로 (가장자리 살짝 흐림)
      face = mk(new THREE.PlaneGeometry(cfg.w, cfg.h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.86, depthWrite: false }), [0, 0, 0.005], g, { outline: 0, shadow: false });
      // 벽에 비친 빛이 화면 둘레로 은은하게 번짐
      const spill = new THREE.Mesh(new THREE.PlaneGeometry(cfg.w * 1.5, cfg.h * 1.7), new THREE.MeshBasicMaterial({ map: poolTex, color: "#d9d4ff", transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending }));
      spill.position.z = 0.003; spill.renderOrder = 1; g.add(spill);
      face.renderOrder = 2;
      if (cfg.from) { // 프로젝터에서 화면으로 은은한 빛줄기
        const lens = new THREE.Vector3(...cfg.from);
        g.updateMatrixWorld(true);
        const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => g.localToWorld(new THREE.Vector3(a * cfg.w / 2, b * cfg.h / 2, 0.01)));
        const pos = [], uv = [];
        for (let i = 0; i < 4; i++) { const c0 = corners[i], c1 = corners[(i + 1) % 4]; pos.push(lens.x, lens.y, lens.z, c0.x, c0.y, c0.z, c1.x, c1.y, c1.z); uv.push(0.5, 0, 0, 1, 1, 1); }
        const bg = new THREE.BufferGeometry();
        bg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        bg.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
        // 렌즈 쪽만 살짝 밝고, 가장자리·화면 쪽으로 갈수록 사라지는 빛
        const beamTex2 = canvasTex(64, 128, (c, w, h) => {
          for (let y = 0; y < h; y++) {
            const v = y / h, a = Math.pow(1 - v, 1.6) * 0.9 + 0.08;
            const grd = c.createLinearGradient(0, 0, w, 0);
            grd.addColorStop(0, "rgba(255,255,255,0)"); grd.addColorStop(0.5, `rgba(255,255,255,${a})`); grd.addColorStop(1, "rgba(255,255,255,0)");
            c.fillStyle = grd; c.fillRect(0, y, w, 1);
          }
        });
        const bm = new THREE.MeshBasicMaterial({ map: beamTex2, color: "#e6ecff", transparent: true, opacity: 0.035, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
        // 빛 속 떠다니는 먼지
        const dust = [], dp = [];
        for (let i = 0; i < 28; i++) {
          const t = 0.15 + Math.random() * 0.8, c = corners[Math.floor(Math.random() * 4)], c2 = corners[Math.floor(Math.random() * 4)], m = Math.random();
          const tx = c.x + (c2.x - c.x) * m, ty = c.y + (c2.y - c.y) * m, tz = c.z + (c2.z - c.z) * m;
          dp.push(lens.x + (tx - lens.x) * t, lens.y + (ty - lens.y) * t, lens.z + (tz - lens.z) * t);
          dust.push(Math.random() * 6);
        }
        const dg = new THREE.BufferGeometry();
        dg.setAttribute("position", new THREE.Float32BufferAttribute(dp, 3));
        const dotTex = canvasTex(32, 32, (c) => { const grd = c.createRadialGradient(16, 16, 0, 16, 16, 16); grd.addColorStop(0, "rgba(255,255,255,1)"); grd.addColorStop(0.4, "rgba(255,255,255,.4)"); grd.addColorStop(1, "rgba(255,255,255,0)"); c.fillStyle = grd; c.fillRect(0, 0, 32, 32); });
        const dmat = new THREE.PointsMaterial({ map: dotTex, color: "#fff6e6", size: 0.022, sizeAttenuation: true, transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending });
        const pts = new THREE.Points(dg, dmat);
        pts.userData = { base: dp.slice(), seed: dust };
        fpGroup.add(pts);
        dustClouds.push(pts);
        const beam = new THREE.Mesh(bg, bm);
        beam.renderOrder = 2;
        beam.raycast = () => {};
        fpGroup.add(beam);
      }
    } else {
      mk(box(cfg.w + 0.12, cfg.h + 0.12, 0.06), "#2b2b31", [0, 0, 0.03], g, { outline: 0.015, shadow: false });
      face = mk(new THREE.PlaneGeometry(cfg.w, cfg.h), new THREE.MeshBasicMaterial({ map: tex }), [0, 0, 0.062], g, { outline: 0, shadow: false });
    }
    const scr = { cfg, canvas, ctx: canvas.getContext("2d"), tex, face, idx: 0, prev: -1, t: 0, fade: 1, media: [] };
    face.userData = { kind: "screen", scr };
    interactives.push(face);
    cfg.slides.forEach((sl, i) => {
      if (sl.image) {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => { scr.dirty = true; };
        img.src = sl.image;
        scr.media[i] = img;
      } else if (sl.video) {
        const v = document.createElement("video");
        Object.assign(v, { src: sl.video, muted: true, loop: true, playsInline: true, crossOrigin: "anonymous", preload: "auto" });
        v.setAttribute("playsinline", "");
        scr.media[i] = v;
      }
    });
    scr.dirty = true;
    screens.push(scr);
  }
}

function drawSlide(scr, i, alpha) {
  const { ctx, canvas } = scr, W = canvas.width, H = canvas.height;
  const sl = scr.cfg.slides[i];
  const m = scr.media[i];
  ctx.globalAlpha = alpha;
  if (sl.scene === "forest") {
    drawForest(ctx, W, H, scr.t);
  } else if (m && (m.naturalWidth || m.videoWidth)) {
    const iw = m.naturalWidth || m.videoWidth, ih = m.naturalHeight || m.videoHeight;
    const k = Math.max(W / iw, H / ih);
    ctx.drawImage(m, (W - iw * k) / 2, (H - ih * k) / 2, iw * k, ih * k);
  } else {
    const bg = sl.bg || "#3d405b";
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "rgba(255,255,255,.12)";
    ctx.beginPath(); ctx.arc(W * 0.88, H * 0.18, H * 0.42, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(W * 0.08, H * 0.95, H * 0.3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = sl.fg || "#fff";
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    ctx.font = "800 96px 'Pretendard','Apple SD Gothic Neo','Noto Sans KR',sans-serif";
    ctx.fillText(sl.title || "", 64, H * 0.5);
    ctx.globalAlpha = alpha * 0.9;
    ctx.font = "600 46px 'Pretendard','Apple SD Gothic Neo','Noto Sans KR',sans-serif";
    ctx.fillText(sl.sub || "", 66, H * 0.5 + 80);
  }
  if (sl.link) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = "rgba(0,0,0,.45)";
    ctx.beginPath(); ctx.roundRect(W - 230, H - 84, 196, 56, 28); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.font = "700 30px 'Pretendard','Apple SD Gothic Neo',sans-serif"; ctx.textAlign = "center";
    ctx.fillText("눌러서 보기", W - 132, H - 45);
  }
  ctx.globalAlpha = 1;
}

function nextSlide(scr, step = 1) {
  const n = scr.cfg.slides.length;
  scr.prev = scr.idx;
  scr.idx = (scr.idx + step + n) % n;
  scr.t = 0;
  scr.fade = 0;
  scr.media.forEach((m, i) => { if (m?.tagName === "VIDEO") (i === scr.idx ? m.play().catch(() => {}) : m.pause()); });
}

function updateScreens(dt) {
  for (const scr of screens) {
    const sl = scr.cfg.slides[scr.idx];
    scr.t += dt;
    if (scr.cfg.slides.length > 1 && scr.t > (sl.duration || scr.cfg.interval || 6)) nextSlide(scr);
    const fading = scr.fade < 1;
    if (fading) scr.fade = Math.min(1, scr.fade + dt / 0.6);
    const isVideo = scr.media[scr.idx]?.tagName === "VIDEO" || sl.scene;
    if (!fading && !isVideo && !scr.dirty) continue;
    scr.dirty = false;
    if (fading && scr.prev >= 0) drawSlide(scr, scr.prev, 1);
    drawSlide(scr, scr.idx, fading ? scr.fade : 1);
    scr.tex.needsUpdate = true;
  }
}

// ───────── 카메라 / 조작 ─────────
let controls;
const OVERVIEW_FOV = 32;
camera.rotation.order = "YXZ";

/** 위에서 내려다보는 기본 시점 위치 */
function overviewPose() {
  const radius = Math.hypot(R.w, R.d) / 2;
  const vfov = THREE.MathUtils.degToRad(camera.fov);
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
  const dist = (radius / Math.sin(Math.min(vfov, hfov) / 2)) * (camera.aspect < 1 ? 1.05 : 0.9);
  const dir = new THREE.Vector3(0.38, 1.15, 1).normalize();
  const pos = center.clone().addScaledVector(dir, dist);
  const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(pos, center, camera.up));
  return { pos, quat, dist };
}

function fitCamera() {
  const w = host.clientWidth, h = host.clientHeight;
  camera.aspect = w / h;
  renderer.setSize(w, h);
  if (walk.on || walk.tween || walk.intro) {
    if (walk.on || walk.intro) camera.fov = walkFov();
    camera.updateProjectionMatrix();
    return;
  }
  camera.fov = OVERVIEW_FOV;
  camera.updateProjectionMatrix();
  const { pos, dist } = overviewPose();
  camera.position.copy(pos);
  controls.target.copy(center);
  controls.maxDistance = dist * 1.6;
  controls.minDistance = dist * 0.3;
  controls.update();
}

// ───────── 상태 표시 ─────────
let lastUpdatedAt = 0;
let lastFetchOk = 0;
let localSeq = 0;

function applyState(serverSeats) {
  for (const s of seats.values()) {
    const occ = Object.prototype.hasOwnProperty.call(serverSeats, s.id);
    if (occ) s.since = serverSeats[s.id];
    setOccupiedVisual(s, occ);
  }
  renderSummary();
}

function setOccupiedVisual(s, occ) {
  if (s.occupied === occ) return;
  s.occupied = occ;
  if (occ && !s.since) s.since = Date.now();
  if (!occ) s.since = 0;
  s.target = occ ? 1 : 0;
  s.bump = 1;
  if (!LINE) s.cushion.material.color.set(occ ? COLOR.busy : COLOR.empty);
  if (occ) s.guest.visible = true;
}

function renderSummary() {
  const total = seats.size;
  const empty = [...seats.values()].filter((s) => !s.occupied).length;
  // 행거: 손님 수만큼 옷 걸기 (최대 3벌)
  const guests = Math.min(3, total - empty);
  for (const r of coatracks) r.userData.garments.forEach((gm, i) => { gm.target = i < guests ? 1 : 0; });
  const n = $("nEmpty");
  n.textContent = empty;
  n.classList.toggle("zero", empty === 0);
  $("nTotal").textContent = `/ ${total} 석`;
  renderBoard();
  $("chips").innerHTML = tableGroups
    .map((t) => {
      const e = t.seatIds.filter((id) => !seats.get(id).occupied).length;
      return `<span class="chip ${e ? "" : "full"}">${t.id} <b>${e ? `${e}석 빔` : "만석"}</b></span>`;
    })
    .join("");
}

function renderUpdated() {
  const live = Date.now() - lastFetchOk < POLL_MS * 4;
  $("liveDot").classList.toggle("off", !live);
  if (!lastFetchOk) return;
  if (!live) { $("updated").textContent = "연결이 끊겼어요 · 다시 연결 중"; return; }
  const sec = Math.max(0, Math.round((Date.now() - lastUpdatedAt) / 1000));
  const ago = !lastUpdatedAt ? "아직 변경 없음" : sec < 60 ? `${sec}초 전 변경` : sec < 3600 ? `${Math.floor(sec / 60)}분 전 변경` : `${Math.floor(sec / 3600)}시간 전 변경`;
  $("updated").textContent = `실시간 · ${ago}`;
}

async function poll() {
  const seq = localSeq;
  try {
    const r = await fetch("/api/seats", { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    const data = await r.json();
    lastFetchOk = Date.now();
    if (seq !== localSeq || inflight > 0) return; // 그 사이 관리자가 바꿨으면 이번 응답은 버림
    lastUpdatedAt = data.updatedAt;
    applyState(data.seats);
  } catch {
    /* 다음 주기에 재시도 */
  } finally {
    renderUpdated();
  }
}

let pollTimer;
// ───────── 매장 정보 (에어컨 앱 연동: 영업시간·실내 온습도·에어컨 상태) ─────────
let storeInfo = null;
const hm = (s) => { const [a, b] = String(s).split(":").map(Number); return a * 60 + (b || 0); };
const kstNow = () => { const k = new Date(Date.now() + 9 * 3600e3); return { day: k.getUTCDay(), min: k.getUTCHours() * 60 + k.getUTCMinutes() }; };
/** 요일별 영업시간(0=일, 자정 넘김 처리)으로 지금 영업 중인지. 정보가 없으면 영업 중으로 봄 */
function isOpenNow() {
  const H = storeInfo?.hours;
  if (!Array.isArray(H) || H.length !== 7) return true;
  const { day, min } = kstNow();
  const t = H[day];
  if (t && !t.closed) { const o = hm(t.open), c = hm(t.close); if (c > o ? min >= o && min < c : min >= o) return true; }
  const p = H[(day + 6) % 7];
  if (p && !p.closed) { const o = hm(p.open), c = hm(p.close); if (c <= o && min < c) return true; }
  return false;
}
/** 새벽 4시 ~ 오전 10시(한국시간): 문이 잠긴 시간 */
const FORCE_LOCK = new URLSearchParams(location.search).has("locked"); // 확인용: ?locked
function isLockedNow() { if (FORCE_LOCK) return true; const { min } = kstNow(); return min >= 4 * 60 && min < 10 * 60; }
/** 영업시간이 아닐 때 바텐더 안내 멘트 */
function closedMessage() {
  const H = storeInfo?.hours; if (!Array.isArray(H) || H.length !== 7) return "아직 영업시간 전입니다";
  const { day, min } = kstNow(), t = H[day], p = H[(day + 6) % 7];
  if (t?.closed) return "오늘은 휴무일이에요";
  const prevEnded = p && !p.closed && hm(p.close) <= hm(p.open) && min >= hm(p.close) && min < hm(t.open); // 새벽에 영업이 끝난 뒤
  const todayEnded = t && hm(t.close) > hm(t.open) && min >= hm(t.close); // 같은 날 영업이 끝난 뒤
  return prevEnded || todayEnded ? "오늘 영업은 끝났습니다" : "아직 영업시간 전입니다";
}
/** 첫 화면 안내: "영업 중 · 02:00까지" / "오늘 18:00 오픈" / "오늘은 쉬어요" */
function openLabel() {
  const H = storeInfo?.hours;
  if (!Array.isArray(H) || H.length !== 7) return "";
  const { day, min } = kstNow(), t = H[day], p = H[(day + 6) % 7];
  if (isOpenNow()) {
    const close = p && !p.closed && hm(p.close) <= hm(p.open) && min < hm(p.close) ? p.close : t.close;
    return `영업 중 · ${close === "00:00" ? "자정" : close}까지`;
  }
  if (t && !t.closed && min < hm(t.open)) return `오늘 ${t.open} 오픈`;
  for (let k = 1; k <= 7; k++) { const d = H[(day + k) % 7]; if (d && !d.closed) return `${k === 1 ? "내일" : ["일", "월", "화", "수", "목", "금", "토"][(day + k) % 7] + "요일"} ${d.open} 오픈`; }
  return "오늘은 쉬어요";
}
async function loadStore() {
  try { const r = await fetch("/api/store", { cache: "no-store" }); if (r.ok) storeInfo = await r.json(); } catch { /* 그대로 */ }
  applyStore();
}
function applyStore() {
  const open = isOpenNow();
  if (doorSign) doorSign.material.map = open ? doorSignTex.open : doorSignTex.closed, doorSign.material.needsUpdate = true;
  const el = $("introOpen"); if (el) { el.textContent = isLockedNow() ? "문이 잠겼어요" : openLabel(); el.classList.toggle("closed", !open); }
}
setInterval(() => { if (!document.hidden) loadStore(); }, 120000);
// 빈자리 확인: 영업시간엔 화면을 보는 동안 5초마다, 영업시간이 아니면 화면을 열거나 다시 볼 때만 (서버 요청 아끼기)
function startPolling() {
  clearInterval(pollTimer);
  poll();
  pollTimer = setInterval(() => { if (!document.hidden && (IS_ADMIN || isOpenNow())) poll(); }, POLL_MS);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
setInterval(renderUpdated, 1000);

// ───────── 관리자 ─────────
let token = store.get("seat-admin-token");
let inflight = 0;

function toast(msg, ms = 1400) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("show"), ms);
}

async function api(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-token": token || "" },
    body: JSON.stringify(body || {}),
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) { logout(); throw new Error(data.error || "다시 로그인해 주세요"); }
  if (!r.ok) throw new Error(data.error || `오류 ${r.status}`);
  return data;
}

async function toggleSeat(id) {
  const s = seats.get(id);
  const next = !s.occupied;
  localSeq++;
  inflight++;
  setOccupiedVisual(s, next);
  renderSummary();
  if (navigator.vibrate) navigator.vibrate(15);
  toast(`${id} · ${next ? "손님 있음" : "빈자리"}`);
  try {
    const data = await api(`/api/seats/${encodeURIComponent(id)}`, { occupied: next });
    lastUpdatedAt = data.updatedAt;
    if (inflight === 1) applyState(data.seats);
  } catch (e) {
    setOccupiedVisual(s, !next);
    renderSummary();
    toast(`저장 실패: ${e.message}`);
  } finally {
    inflight--;
    localSeq++;
  }
}

function showLogin(msg = "") {
  $("loginErr").textContent = msg;
  $("login").classList.add("show");
  setTimeout(() => $("pw").focus(), 50);
}
function logout() {
  token = null;
  store.set("seat-admin-token", null);
  document.body.classList.remove("admin");
  if (IS_ADMIN) showLogin("다시 로그인해 주세요");
}
$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  token = $("pw").value;
  try {
    await api("/api/login");
    store.set("seat-admin-token", token);
    if (!IS_ADMIN) { location.href = "/admin"; return; } // 환풍기로 들어온 경우: 관리자 화면으로
    $("login").classList.remove("show");
    document.body.classList.add("admin");
    loadBoard().then(() => buildBoard(true));
    loadStats();
    $("pw").value = "";
  } catch (err) {
    token = null;
    $("loginErr").textContent = err.message;
  }
});
initBoardTools();
$("login").querySelector("a")?.addEventListener("click", (e) => { if (!IS_ADMIN) { e.preventDefault(); $("login").classList.remove("show"); } });
$("view3dBtn")?.addEventListener("click", () => { // 버튼판 ↔ 3D 화면
  const on = document.body.classList.toggle("view3d");
  $("view3dBtn").textContent = on ? "버튼판" : "3D 보기";
  if (on) fitCamera?.();
});
$("logoutBtn").addEventListener("click", () => {
  if (walk.on) { exitWalk(); return; } // 매장 안에서는 관리자 전체 화면으로 돌아가기
  logout(); location.href = "/";
});
$("resetBtn").addEventListener("click", async () => {
  if (!confirm("모든 자리를 빈자리로 바꿀까요?")) return;
  localSeq++;
  inflight++;
  try {
    const data = await api("/api/reset");
    lastUpdatedAt = data.updatedAt;
    applyState(data.seats);
    toast("모두 빈자리로 바꿨어요");
  } catch (e) {
    toast(`실패: ${e.message}`);
  } finally {
    inflight--;
    localSeq++;
  }
});

// ───────── 터치/클릭 (관리자만) ─────────
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let down = null;
function pick(ev, objects) {
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  return ray.intersectObjects(objects, false)[0] || null;
}
function seatAt(ev) {
  return pick(ev, hitboxes)?.object.userData.seatId || null;
}

// ───────── 손님 놀거리: 누르면 반응 ─────────
let found;
try { found = new Set(JSON.parse(store.get("seat-found") || "[]")); } catch { found = new Set(); }

function interact(ev) {
  // 가게 밖(첫 화면·골목)에서는 유리 너머 매장 안 소품·자리가 눌리지 않게
  if (fpGroup.visible && storeSD(camera.position.x, camera.position.z) < 0) return;
  let hit = pick(ev, [...interactives, ...hitboxes]);
  if (!hit) return;
  // 바텐더가 바 의자 뒤에 가려져 있어도, 손가락 방향에 바텐더가 있으면 바텐더를 누른 것으로
  const all = ray.intersectObjects([...interactives, ...hitboxes], false);
  const bt = all.find((h) => h.object.userData.kind === "prop" && h.object.userData.group?.userData.path);
  if (bt && hit.object.userData.seatId && bt.distance - hit.distance < 1.5) hit = bt; // 의자에 가려진 경우만
  const u = hit.object.userData;
  if (u.kind === "screen") tapScreen(u.scr);
  else if (u.kind === "prop") { // 걸어 다닐 땐 1.5m 안(가장 가까운 면 기준)의 소품만
    const reach = u.group?.userData.path ? 2.5 : 1.5; // 바텐더는 바 건너편에서도 닿게
    if (walk.on && Math.hypot(hit.point.x - walk.pos.x, hit.point.z - walk.pos.z) > reach) return;
    tapProp(u);
  }
  else if (u.kind === "water") sipWater(u);
  else if (u.seatId) tapSeat(seats.get(u.seatId));
}

// 바텐더를 연달아 누를 때 멘트 (10번째는 보틀 던지기)
const BT_LINES = [
  "어서 오세요!\n오늘은 어떤 한 잔 드릴까요?",
  "천천히 고르세요.\n메뉴는 도망 안 가요.",
  "술이 부담되시면\n커피도 내려 드려요.",
  "와이파이는 메뉴판 QR 찍으시면\n안내되어 있어요.",
  "화장실은 뒷문으로 나가셔서\n오른쪽 첫 번째입니다.",
  "잔 닦는 중입니다만.",
  "…아까부터 계속 누르시네요.",
  "한 번만 더 누르면\n진짜 화냅니다.",
  "경고했습니다. 😑",
];
function tapProp(u) {
  const bu = u.group.userData;
  let line = null;
  if (bu.ac) bu.ac.t = Math.max(0, bu.ac.t); // 에어컨: 날개가 천천히 움직임
  if (bu.ice) { // 제빙기: 3번 연달아 누르면 얼음
    const now = performance.now() / 1000;
    if (!bu.lastTap || now - bu.lastTap > 3) bu.tapN = 0;
    bu.lastTap = now; bu.tapN = (bu.tapN || 0) + 1;
    if (bu.tapN >= 3) { bu.tapN = 0; spillIce(u.group); }
  }
  if (bu.path && !isOpenNow() && storeInfo?.hours) { // 영업시간 밖: 평소 멘트 대신 안내와 ㅠㅜ 만
    bu.lookT = 3.6;
    const msg = closedMessage();
    bu.closedTap = (bu.closedTap || 0) + 1;
    line = bu.closedTap % 2 ? "ㅠㅜ" : msg;
  } else if (bu.path) { // 바텐더: 나를 쳐다보고, 누를 때마다 멘트가 바뀌다가 10번째엔 보틀을 던짐
    bu.lookT = 3.6;
    const now = performance.now() / 1000;
    if (!bu.lastTap || now - bu.lastTap > 8) bu.tapN = 0; // 잠시 안 누르면 처음부터
    bu.lastTap = now;
    bu.tapN = (bu.tapN || 0) + 1;
    if (bu.tapN >= 10 && !bu.thrown) {
      bu.tapN = 0;
      throwBottle(u.group);
      u.wiggle = 1;
      return;
    }
    line = BT_LINES[Math.min(bu.tapN, BT_LINES.length) - 1];
  }
  u.wiggle = 1;
  u.onTap?.();
  const p = u.prop;
  if (p.type === "aircon" && storeInfo?.temp != null) line = `에어컨이에요\n지금 매장 ${Math.round(storeInfo.temp * 10) / 10}℃${storeInfo.acOn ? " · 작동 중" : ""}`;
  if (p.type === "sidetable" && p.item === "humidifier" && storeInfo?.hum != null) line = `가습기예요\n지금 습도 ${Math.round(storeInfo.hum)}%`;
  const sp = bu.sayPos || [u.group.position.x, u.group.position.z];
  popBubble(line || p.say, sp[0], u.sayY ?? SAY_HEIGHT[p.type] ?? 1.5, sp[1], bu.path ? { follow: u.group, scale: 0.7 } : bu.sayScale ? { scale: bu.sayScale } : undefined);
  if (!found.has(u.idx)) {
    found.add(u.idx);
    store.set("seat-found", JSON.stringify([...found]));
    const n = [...found].filter((i) => i < sayProps.length).length, total = sayProps.length;
    setTimeout(() => toast(n >= total ? `구경 완료!\n숨은 이야기 ${total}개를 모두 찾았어요` : `새로운 발견 ${n} / ${total}`, 1800), 900);
  }
}

let shakeT = 0;
function throwBottle(b) {
  const u = b.userData, held = u.bottle;
  if (!held) return;
  u.thrown = true; u.lookT = 4;
  popBubble("그만 좀 눌러요! 😤", b.position.x, 2.05, b.position.z, { fg: "#c0533f", follow: b, scale: 0.7 });
  const p0 = new THREE.Vector3(); held.getWorldPosition(p0);
  held.visible = false;
  const fly = held.clone(); fly.visible = true;
  fly.position.copy(p0);
  // 내 발 앞 0.7m 쯤에 떨어지게
  const fx = -Math.sin(walk.yaw), fz = -Math.cos(walk.yaw);
  const tgt = walk.on ? new THREE.Vector3(camera.position.x + fx * 0.7, 0.05, camera.position.z + fz * 0.7) : new THREE.Vector3(camera.position.x * 0.5, 0.05, camera.position.z * 0.5);
  const roll = new THREE.Vector3(tgt.x - p0.x, 0, tgt.z - p0.z).normalize();
  const T1 = 0.9, peak = Math.max(p0.y, 1.3) + 0.8;
  let landed = false;
  addEffect(fly, scene, 5.5, (e) => {
    const t = e.t;
    if (t < T1) { // 포물선 + 빙글빙글
      const k = t / T1;
      fly.position.set(p0.x + (tgt.x - p0.x) * k, p0.y + (tgt.y - p0.y) * k + 4 * (peak - Math.max(p0.y, tgt.y)) * k * (1 - k), p0.z + (tgt.z - p0.z) * k);
      fly.rotation.x = t * 14; fly.rotation.z = t * 6;
    } else { // 바닥에 누워 데굴데굴 굴러가다 멈춤
      if (!landed) { landed = true; shakeT = 0.25; }
      const r = t - T1, d = 0.9 * (1 - Math.exp(-r * 2));
      fly.position.set(tgt.x + roll.x * d, 0.05, tgt.z + roll.z * d);
      fly.rotation.set(0, Math.atan2(roll.x, roll.z), Math.PI / 2);
      fly.rotateY(d / 0.05);
      if (r > 3.2) fly.scale.setScalar(Math.max(0.001, 1 - (r - 3.2) / 1.2)); // 스르륵 사라짐
    }
    if (t >= e.life - 0.05) { // 손에 새 보틀
      held.visible = true; held.scale.setScalar(0.01);
      addEffect(new THREE.Object3D(), scene, 0.6, (e2) => { held.scale.setScalar(Math.min(1, 0.01 + e2.t / 0.5)); if (e2.t >= 0.55) { held.scale.setScalar(1); u.thrown = false; } });
    }
  });
  if (!store.get("bt-bottle")) { store.set("bt-bottle", "1"); setTimeout(() => toast("숨은 재미 발견!\n바텐더를 너무 귀찮게 하면…", 1800), 1300); }
}

function tapSeat(s) {
  if (s.occupied) waveGuest(s, true);
  else {
    s.bump = 1;
    popBubble("여기 비었어요!", s.group.position.x, 1.15, s.group.position.z, { fg: "#1f8a5c" });
  }
}

function waveGuest(s, force) {
  const u = s.guest.userData, now = clock.elapsedTime;
  if (!force && now - u.lastWave < 25) return;
  if (now - u.lastWave < 1.2) return;
  u.lastWave = now;
  u.wave = 1.8;
  popHeart(s.group.localToWorld(new THREE.Vector3(0, u.headY + 0.28, 0)));
}

function tapScreen(scr) {
  const sl = scr.cfg.slides[scr.idx];
  if (sl.link) {
    visit.ad++;
    sendVisit(true);
    window.open(sl.link, "_blank", "noopener");
  } else nextSlide(scr);
}

// ───────── 방문 기록 (체류시간 → 관리자 화면) ─────────
const visit = { sid: (Math.random().toString(36).slice(2, 10) + Date.now().toString(36)).slice(0, 20), ms: 0, ad: 0, sent: "" };
function sendVisit(force) {
  if (IS_ADMIN || (visit.ms < 3000 && !force)) return;
  const body = JSON.stringify({ sid: visit.sid, ms: visit.ms, ad: visit.ad });
  if (body === visit.sent) return;
  visit.sent = body;
  try {
    if (!navigator.sendBeacon?.("/api/visit", body)) fetch("/api/visit", { method: "POST", body, keepalive: true }).catch(() => {});
  } catch {}
}
setInterval(() => {
  if (document.hidden) return;
  visit.ms += 1000;
  if (visit.ms % 15000 === 0) sendVisit();
}, 1000);
document.addEventListener("visibilitychange", () => { if (document.hidden) sendVisit(); });
addEventListener("pagehide", () => sendVisit());
function bindPointer() {
  const el = renderer.domElement;
  el.addEventListener("pointerdown", (e) => {
    down = { x: e.clientX, y: e.clientY, t: performance.now() };
    if (walk.on) { walk.look = { id: e.pointerId, x: e.clientX, y: e.clientY }; el.setPointerCapture?.(e.pointerId); }
  });
  el.addEventListener("pointermove", (e) => {
    const L = walk.look;
    if (!walk.on || !L || L.id !== e.pointerId) return;
    const k = e.pointerType === "touch" ? 0.0065 : 0.004;
    walk.yaw -= (e.clientX - L.x) * k;
    walk.pitch = THREE.MathUtils.clamp(walk.pitch - (e.clientY - L.y) * k, -1.1, 0.9);
    L.x = e.clientX; L.y = e.clientY;
  });
  const endLook = (e) => { if (walk.look?.id === e.pointerId) walk.look = null; };
  el.addEventListener("pointercancel", endLook);
  el.addEventListener("pointerup", (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const quick = performance.now() - down.t < 600;
    down = null;
    endLook(e);
    if (moved > 8 || !quick) return;
    if (!IS_ADMIN && adminFanHit && fpGroup.visible && pick(e, [adminFanHit])) { if (token) location.href = "/admin"; else showLogin(); return; }
    if (document.body.classList.contains("admin")) {
      const id = seatAt(e);
      if (id) toggleSeat(id);
      return;
    }
    interact(e); // 손님: 자리 상태는 못 바꾸고, 둘러보며 놀기만
  });
  el.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse" || !document.body.classList.contains("admin")) return;
    el.style.cursor = seatAt(e) ? "pointer" : "";
  });
}

// ───────── 1인칭 (매장 안 걸어 다니기) ─────────
const EYE = 1.55; // 눈높이(m)
const PR = 0.28; // 몸 반지름(m)
const IS_TOUCH = matchMedia("(pointer: coarse)").matches;
const walk = {
  on: false, tween: null, look: null,
  pos: new THREE.Vector3(), yaw: 0, pitch: -0.1,
  keys: new Set(), joy: { x: 0, y: 0 }, bob: 0, aimId: null, frame: 0, intro: false,
  sit: null, crouch: false, eye: 1.55, jumpY: 0, vy: 0, back: null, // 앉기 / 쪼그려 앉기 / 점프
};
const walkFov = () => (camera.aspect < 1 ? 78 : 64);

// ───────── 골목을 걷는 사람들 (삼거리: 정면 골목 / 왼쪽 골목 / 대각선 창 밖으로 뻗은 골목) ─────────
const walkers = [];
function makeWalker(seed, kind) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const coats = ["#6d7f9a", "#a5644a", "#3f5a4f", "#c9b27a", "#2e2f36", "#8c6a8a", "#d8d2c4"];
  const coat = coats[Math.floor(rnd() * coats.length)], pants = rnd() < 0.5 ? "#2a2b31" : "#4a5468";
  const skin = ["#f0c9a6", "#e2b48e", "#f5d6bb"][Math.floor(rnd() * 3)], hairC = ["#2a211d", "#4a3328", "#1b1b1f", "#8a6a4a"][Math.floor(rnd() * 4)];
  const g = new THREE.Group();
  const body = new THREE.Group(); g.add(body);
  const legs = [], arms = [];
  for (const sx of [-1, 1]) {
    const lp = new THREE.Group(); lp.position.set(sx * 0.08, 0.78, 0); body.add(lp);
    mk(new THREE.CapsuleGeometry(0.06, 0.6, 4, 8), pants, [0, -0.38, 0], lp, { outline: 0.01 });
    mk(box(0.1, 0.06, 0.2), "#1b1b1f", [0, -0.75, 0.04], lp, { outline: 0.005 });
    legs.push(lp);
  }
  const torso = mk(new THREE.CapsuleGeometry(0.16, 0.38, 6, 12), coat, [0, 1.08, 0], body, { outline: 0.012 });
  torso.scale.set(1, 1, 0.8);
  for (const sx of [-1, 1]) {
    const ap = new THREE.Group(); ap.position.set(sx * 0.2, 1.3, 0); body.add(ap);
    mk(new THREE.CapsuleGeometry(0.05, 0.42, 4, 8), coat, [0, -0.25, 0], ap, { outline: 0.01 });
    arms.push(ap);
  }
  mk(new THREE.SphereGeometry(0.15, 16, 12), skin, [0, 1.56, 0], body, { outline: 0.014 });
  const hair = mk(new THREE.SphereGeometry(0.158, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), hairC, [0, 1.58, -0.02], body, { outline: 0 });
  hair.rotation.x = -0.3;
  for (const sx of [-1, 1]) mk(new THREE.SphereGeometry(0.018, 6, 4), new THREE.MeshBasicMaterial({ color: "#1b1b1f" }), [sx * 0.05, 1.57, 0.14], body, { outline: 0, shadow: false });
  if (kind === "umbrella") {
    const ug = new THREE.Group(); ug.position.set(0.2, 1.3, 0.05); body.add(ug);
    mk(cyl(0.008, 0.008, 0.75, 4), "#2a2522", [0, 0.37, 0], ug, { outline: 0 });
    mk(new THREE.ConeGeometry(0.55, 0.25, 10, 1, true), toon(["#c8392b", "#3d6fa8", "#f2c94c"][Math.floor(rnd() * 3)], { side: THREE.DoubleSide }), [0, 0.8, 0], ug, { outline: 0.012 });
    arms[1].rotation.x = -0.9;
  }
  let dog = null;
  if (kind === "dog") {
    dog = new THREE.Group(); dog.position.set(0.5, 0, 0.35); g.add(dog);
    const fur = ["#e9c48e", "#8a5a3a", "#f4f1ea", "#3a2e28"][Math.floor(rnd() * 4)], ear = "#5a3a2a";
    // 몸통 (길쭉) + 가슴
    mk(new THREE.CapsuleGeometry(0.09, 0.3, 4, 10), fur, [0, 0.32, 0], dog, { outline: 0.01 }).rotation.x = Math.PI / 2;
    // 머리 + 길쭉한 주둥이 + 검은 코 + 늘어진 귀 + 눈
    const head = new THREE.Group(); head.position.set(0, 0.46, 0.25); dog.add(head);
    mk(new THREE.SphereGeometry(0.085, 12, 10), fur, [0, 0, 0], head, { outline: 0.01 });
    const snout = mk(new THREE.CapsuleGeometry(0.045, 0.08, 4, 8), fur, [0, -0.03, 0.09], head, { outline: 0.008 });
    snout.rotation.x = Math.PI / 2;
    mk(new THREE.SphereGeometry(0.022, 8, 6), new THREE.MeshBasicMaterial({ color: "#1b1b1f" }), [0, -0.02, 0.16], head, { outline: 0, shadow: false });
    for (const sx of [-1, 1]) {
      const e = mk(new THREE.CapsuleGeometry(0.03, 0.08, 4, 6), ear, [sx * 0.075, -0.02, -0.01], head, { outline: 0.006 }); // 축 늘어진 귀
      e.rotation.z = sx * 0.25;
      mk(new THREE.SphereGeometry(0.014, 6, 4), new THREE.MeshBasicMaterial({ color: "#1b1b1f" }), [sx * 0.035, 0.025, 0.07], head, { outline: 0, shadow: false });
    }
    mk(new THREE.TorusGeometry(0.06, 0.012, 5, 14), "#c8392b", [0, 0.39, 0.2], dog, { outline: 0 }).rotation.x = 1.2; // 목걸이
    // 위로 흔드는 꼬리
    const tail = new THREE.Group(); tail.position.set(0, 0.38, -0.22); dog.add(tail);
    mk(new THREE.CapsuleGeometry(0.018, 0.13, 4, 6), fur, [0, 0.07, -0.02], tail, { outline: 0.005 }).rotation.x = -0.6;
    dog.userData.tail = tail;
    dog.userData.legs = [];
    for (const [lx, lz] of [[-0.06, 0.15], [0.06, 0.15], [-0.06, -0.15], [0.06, -0.15]]) {
      const lp = new THREE.Group(); lp.position.set(lx, 0.27, lz); dog.add(lp);
      mk(cyl(0.022, 0.02, 0.27, 6), fur, [0, -0.135, 0], lp, { outline: 0.004 });
      dog.userData.legs.push(lp);
    }
    // 목줄
    const lg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0.2, 1.0, 0.05), new THREE.Vector3(0.5, 0.42, 0.55)]);
    g.add(new THREE.Line(lg, new THREE.LineBasicMaterial({ color: "#c8392b" })));
  }
  g.scale.setScalar(0.95);
  g.userData.outdoor = true; // 실내/바깥 색 나눌 때 늘 바깥
  return { g, body, legs, arms, dog };
}

function buildWalkers() {
  const T = 0.14;
  const front = R.d + T + 1.85;
  // 대각선 창 밖 골목: 창에서 d 미터, 옆으로 o 미터
  const A = ALLEY || { mx: 1.95, mz: 7.55, nx: -Math.SQRT1_2, nz: Math.SQRT1_2 };
  const px = A.nz, pz = -A.nx; // 골목 가로 방향
  const AL = (d, o = 0) => [A.mx + A.nx * d + px * o, A.mz + A.nz * d + pz * o];
  const I = AL(4.6); // 삼거리 한가운데
  const lanes = [
    // 모든 길은 골목 저 끝(멀리, 잘 안 보이는 곳)에서 시작하고 끝남 → 길 한가운데서 갑자기 나타나지 않음
    [[18, front - 0.35], [-2.0, front - 0.35], [-2.0, -7]],          // 가게 앞 골목 끝 → 모퉁이 → 왼쪽 골목 끝
    [[-3.4, -7], [-3.4, front + 0.45], [18, front + 0.45]],          // 왼쪽 골목 끝 → 모퉁이 → 가게 앞 골목 끝
    [AL(24, 0.8), AL(6, 0.8), I, [18, front - 0.35]],    // 대각선 골목 끝 → 삼거리 → 가게 앞 골목 끝
    [AL(24, -0.9), AL(6, -0.9), I, [-1.9, -7]],          // 대각선 골목 끝 → 삼거리 → 왼쪽 골목 끝
    [[18, front + 0.45], I, AL(6, -0.2), AL(24, -0.2)],  // 가게 앞 골목 끝 → 삼거리 → 대각선 골목 끝
    [[-3.6, -7], [-3.6, 9], I, AL(6, 1.4), AL(24, 1.4)], // 왼쪽 골목 끝 → 삼거리 → 대각선 골목 끝
  ].map((pts) => {
    const seg = [];
    let len = 0;
    for (let i = 0; i < pts.length - 1; i++) { const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); seg.push(l); len += l; }
    return { pts, seg, len };
  });
  const plan = [
    // 지나가는 사람 (예전의 반, 우산 없음)
    [0, "normal", true, 0.1], [1, "dog", true, 0.3], [3, "dog", false, 0.5],
    [2, "pair", false, 0.55], [4, "normal", true, 0.4], [5, "normal", false, 0.8],
  ];
  plan.forEach(([li, kind, nightOk, t0], i) => {
    const lane = lanes[li];
    const make = (k, off) => { const w = makeWalker(97 + i * 31 + off * 7, k); fpGroup.add(w.g); return { ...w, off }; };
    const group = kind === "pair" ? [make("normal", -0.28), make("normal", 0.28)] : [make(kind, 0)];
    walkers.push({ lane, len: lane.len, t: t0, speed: 0.55 + (i % 3) * 0.12, phase: i * 1.7, nightOk, group });
  });
}
function lanePoint(lane, t) {
  let d = t * lane.len;
  for (let i = 0; i < lane.seg.length; i++) {
    if (d <= lane.seg[i] || i === lane.seg.length - 1) {
      const [ax, az] = lane.pts[i], [bx, bz] = lane.pts[i + 1], k = Math.min(1, d / lane.seg[i]);
      return { x: ax + (bx - ax) * k, z: az + (bz - az) * k, dx: (bx - ax) / lane.seg[i], dz: (bz - az) / lane.seg[i] };
    }
    d -= lane.seg[i];
  }
}
function updateWalkers(dt, time) {
  if (!fpGroup.visible) return;
  const nightish = timeK > 0.6;
  for (const w of walkers) {
    const show = !nightish || w.nightOk;
    w.t += (w.speed * dt) / w.len;
    if (w.t > 1) w.t -= 1;
    const { x, z, dx, dz } = lanePoint(w.lane, w.t);
    const fade = Math.min(1, (w.t * w.len) / 0.4, ((1 - w.t) * w.len) / 0.4); // 길 끝(멀리)에서만 나타나고 사라짐
    const yaw = Math.atan2(dx, dz), sw = Math.sin(time * 6 * w.speed + w.phase);
    for (const p of w.group) {
      p.g.visible = show && fade > 0.02;
      p.g.position.set(x - dz * p.off, 0, z + dx * p.off);
      p.g.rotation.y = yaw;
      p.g.scale.setScalar(0.95 * Math.max(0.001, fade));
      p.body.position.y = Math.abs(sw) * 0.03;
      p.legs[0].rotation.x = sw * 0.5; p.legs[1].rotation.x = -sw * 0.5;
      if (p.arms[0]) p.arms[0].rotation.x = -sw * 0.4;
      if (p.arms[1] && !p.g.userData.umbrella) p.arms[1].rotation.x = p.arms[1].rotation.x < -0.5 ? p.arms[1].rotation.x : sw * 0.4;
      if (p.dog) {
        p.dog.userData.legs.forEach((l, k) => { l.rotation.x = Math.sin(time * 12 + (k % 2 ? Math.PI : 0) + (k > 1 ? Math.PI : 0)) * 0.5; });
        p.dog.position.y = Math.abs(Math.sin(time * 12)) * 0.03; // 통통 튀는 걸음
        p.dog.userData.tail.rotation.z = Math.sin(time * 14) * 0.6; // 꼬리 살랑
      }
    }
  }
}

/** 바텐더: 바 안쪽 길을 천천히 오가며, 가끔 멈춰 손님 쪽을 보고, 손님이 지나가면 옆으로 비켜 줌 */
function pathAt(u, s) {
  let d = Math.max(0, Math.min(u.L, s));
  for (let i = 0; i < u.seg.length; i++) {
    if (d <= u.seg[i] || i === u.seg.length - 1) {
      const [ax, az] = u.path[i], [bx, bz] = u.path[i + 1], t = Math.min(1, d / u.seg[i]);
      const tx = (bx - ax) / u.seg[i], tz = (bz - az) / u.seg[i];
      return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, tx, tz };
    }
    d -= u.seg[i];
  }
}
/** 영업시간이 아닐 때 들어오면: 바텐더가 입구 쪽으로 걸어와 안내 */
function closedGreeting() {
  if (isOpenNow() || !storeInfo?.hours) return;
  const msg = closedMessage();
  for (const b of bartenders) {
    const u = b.userData; if (!u.path) continue;
    u.greet = msg; u.target = u.L; u.wait = 0; u.sadNext = true; // 길 끝(입구 쪽)으로
  }
}
// ───────── 영업시간 외에 바 자리에 앉으면: 바텐더가 물 한 잔 (제빙기 → 자리 앞 바 위에 라탄 코스터 + 하이볼잔) ─────────
const served = []; // 바 위에 올린 코스터·잔
let waterVisits = 0; // 영업시간 외에 바 자리에 앉은 횟수 (1: 물, 2: 질긴 녀석이네 + 물, 3~: 술병)
function nearestS(u, x, z) { let best = 0, bd = 1e9; for (let s = 0; s <= u.L; s += 0.05) { const q = pathAt(u, s), d = Math.hypot(q.x - x, q.z - z); if (d < bd) { bd = d; best = s; } } return best; }
function barTopFor(seat) { // 자리 앞 바 상판 위 (손님 쪽 가장자리 근처)
  const p = seat.group.position;
  let best = null, bd = 1e9;
  for (const b of LAYOUT.bars || []) for (let i = 0; i < b.path.length - 1; i++) {
    const [ax, az] = b.path[i], [bx, bz] = b.path[i + 1], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
    const t = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.z - az) * dz) / L2)), x = ax + dx * t, z = az + dz * t, d = Math.hypot(p.x - x, p.z - z);
    if (d < bd) { bd = d; best = [x, z]; }
  }
  if (!best) return null;
  const k = 0.3 / bd; return [best[0] + (p.x - best[0]) * k, best[1] + (p.z - best[1]) * k];
}
function serveWater(seat) {
  if (!seat.id.startsWith("BAR")) return; // 바 자리에만
  const b = bartenders.find((g) => g.userData.path); if (!b) return;
  const u = b.userData, ice = iceMakers[0]?.position, top = barTopFor(seat);
  if (!top) return;
  waterVisits++;
  if (waterVisits >= 3) { setTimeout(() => throwBottle(b), 600); return; } // 3번째 앉으면 술병을 던짐
  popBubble(waterVisits === 2 ? "질긴 녀석이네" : "흐음..물이라도 드릴까요?", b.position.x, 2.0, b.position.z, { follow: b, scale: 0.7 });
  u.lookT = 2.5;
  u.job = [
    { s: ice ? nearestS(u, ice.x, ice.z) : 0, pause: 1.2, act: () => { u.bottle.visible = false; u.handGlass.visible = true; } },
    { s: nearestS(u, top[0], top[1]), pause: 0.8, act: () => {
      u.handGlass.visible = false; u.bottle.visible = true;
      const g = new THREE.Group(); g.position.set(top[0], 1.04, top[1]); roomGroup.add(g);
      mk(cyl(0.055, 0.055, 0.008, 20), "#c99a5b", [0, 0.004, 0], g, { outline: 0.003, shadow: false });
      mk(new THREE.TorusGeometry(0.045, 0.004, 4, 20), "#9a6a3a", [0, 0.009, 0], g, { outline: 0, shadow: false }).rotation.x = Math.PI / 2;
      mk(new THREE.CylinderGeometry(0.036, 0.032, 0.15, 16, 1, true), new THREE.MeshBasicMaterial({ color: "#e8f4f8", transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }), [0, 0.085, 0], g, { outline: 0, shadow: false });
      const water = mk(cyl(0.032, 0.03, 0.11, 14), new THREE.MeshBasicMaterial({ color: "#cfe9f2", transparent: true, opacity: 0.5 }), [0, 0.065, 0], g, { outline: 0, shadow: false });
      // 물잔을 누르면 한 모금씩 줄고, 다 마시면 바텐더가 한마디
      const hb = new THREE.Mesh(box(0.14, 0.2, 0.14), hitMat); hb.position.y = 0.09; g.add(hb);
      hb.userData = { kind: "water", water, level: 4, g };
      interactives.push(hb); g.userData.hit = hb;
      served.push(g); u.lookT = 3;
    } },
  ];
  u.jobDelay = 1.6; u.wait = 0;
}
function sipWater(u) {
  if (u.level <= 0) return;
  u.level--;
  const k = u.level / 4;
  u.water.scale.y = Math.max(0.001, k); u.water.position.y = 0.01 + 0.055 * k; u.water.visible = k > 0;
  if (navigator.vibrate) navigator.vibrate(8);
  if (u.level === 0) {
    const b = bartenders.find((g) => g.userData.path);
    if (b) setTimeout(() => { b.userData.lookT = 3; popBubble("다 마셨으면 가...", b.position.x, 2.0, b.position.z, { follow: b, scale: 0.7 }); }, 700);
  }
}
function clearWater() {
  for (const g of served) { const i = interactives.indexOf(g.userData.hit); if (i >= 0) interactives.splice(i, 1); roomGroup.remove(g); } served.length = 0;
  for (const b of bartenders) { const u = b.userData; if (u.job) { u.job = null; u.handGlass && (u.handGlass.visible = false); u.bottle && (u.bottle.visible = true); } }
}
function updateBartender(b, dt, time) {
  const u = b.userData;
  if (u.job?.length && u.path) { // 물 서비스: 목표 지점까지 걸어가서 할 일
    if (u.jobDelay > 0) { u.jobDelay -= dt; u.moving = false; }
    else {
      const j = u.job[0], d = j.s - u.s, step = 0.9 * dt;
      if (Math.abs(d) > step) { u.s += Math.sign(d) * step; u.moving = true; u.dir = Math.sign(d); }
      else { u.s = j.s; u.moving = false; j.pause -= dt; if (j.pause <= 0) { j.act(); u.job.shift(); if (!u.job.length) { u.job = null; u.target = u.s; u.wait = 4; } } }
    }
    const q = pathAt(u, u.s); b.position.set(q.x, 0, q.z); u.prop.x = q.x; u.prop.z = q.z;
    let fx = u.moving ? q.tx * (u.dir || 1) : camera.position.x - q.x, fz = u.moving ? q.tz * (u.dir || 1) : camera.position.z - q.z;
    const yaw = Math.atan2(fx, fz); let dy = yaw - u.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); u.yaw += dy * Math.min(1, dt * 5); b.rotation.y = u.yaw;
    u.bt.position.y = Math.abs(Math.sin(time * (u.moving ? 7 : 1.6))) * (u.moving ? 0.025 : 0.008);
    return;
  }
  u.bt.position.y = Math.abs(Math.sin(time * (u.moving ? 7 : 1.6))) * (u.moving ? 0.025 : 0.008);
  u.btHead.rotation.z = Math.sin(time * 0.8) * 0.04;
  if (!u.path) { u.btHead.rotation.y = Math.sin(time * 0.5) * 0.35; return; }
  // 손님(나)이 가까우면 멈추고 비켜 줌
  const here = pathAt(u, u.s);
  const near = walk.on && Math.hypot(walk.pos.x - here.x, walk.pos.z - here.z) < 1.1;
  if (near) u.wait = Math.max(u.wait, 1.2);
  const looking = (u.lookT || 0) > 0; // 눌렀을 때: 멈춰서 나를 쳐다봄
  if (looking) { u.lookT -= dt; u.wait = Math.max(u.wait, 0.3); }
  if (u.greet && Math.abs(u.target - u.s) < 0.01) { // 입구 쪽에 도착 → 나를 보며 안내
    popBubble(u.greet, b.position.x, 2.0, b.position.z, { follow: b, scale: 0.7 });
    u.greet = null; u.lookT = 4; u.wait = 6;
  }
  if (u.wait > 0 && !u.greet) { u.wait -= dt; u.moving = false; }
  else {
    const step = (u.greet ? 1.0 : 0.35) * dt, d = u.target - u.s;
    if (Math.abs(d) <= step) { u.s = u.target; u.wait = 2 + Math.random() * 4; if (!u.greet) u.target = Math.random() * u.L; u.moving = false; }
    else { u.s += Math.sign(d) * step; u.moving = true; u.dir = Math.sign(d); }
  }
  const q = pathAt(u, u.s);
  const px = -q.tz, pz = q.tx; // 길에 수직
  let want = 0;
  if (near) want = ((walk.pos.x - q.x) * px + (walk.pos.z - q.z) * pz) > 0 ? -0.32 : 0.32; // 손님 반대편으로 한 걸음
  u.side += (want - u.side) * Math.min(1, dt * 4);
  b.position.set(q.x + px * u.side, 0, q.z + pz * u.side);
  u.prop.x = b.position.x; u.prop.z = b.position.z;
  // 바라보는 방향: 걸을 땐 가는 방향, 멈추면 손님(나) 또는 홀 쪽
  let fx, fz;
  if (u.moving) { fx = q.tx * (u.dir || 1); fz = q.tz * (u.dir || 1); }
  else if (near || looking) { fx = camera.position.x - b.position.x; fz = camera.position.z - b.position.z; }
  else { fx = 5.2 - b.position.x; fz = 4.6 - b.position.z; }
  const yaw = Math.atan2(fx, fz);
  let dy = yaw - u.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  u.yaw += dy * Math.min(1, dt * 5);
  b.rotation.y = u.yaw;
  u.btHead.rotation.y = u.moving || looking ? 0 : Math.sin(time * 0.5) * 0.25;
}

let lastPos = null, wasOutdoor = false;
function pushObstacles(p) {
  for (const o of obstacles) {
    const [lx, lz] = rotXZ(p.x - o.x, p.z - o.z, -o.deg);
    const hw = o.hw + PR, hd = o.hd + PR;
    if (Math.abs(lx) >= hw || Math.abs(lz) >= hd) continue;
    let nx = lx, nz = lz;
    if (hw - Math.abs(lx) < hd - Math.abs(lz)) nx = Math.sign(lx || 1) * hw;
    else nz = Math.sign(lz || 1) * hd;
    const [wx, wz] = rotXZ(nx, nz, o.deg);
    p.x = o.x + wx;
    p.z = o.z + wz;
  }
}
function collide(p) {
  const res = collideInner(p);
  lastPos = { x: p.x, z: p.z };
  return res;
}
function collideInner(p) {
  const door = LAYOUT.door?.wall === "front" ? LAYOUT.door : null;
  const T = 0.14;
  const inDoor = door && Math.abs(p.x - door.x) < door.w / 2 - 0.05 && p.z > R.d - 1;
  // 문틀 통로: 문 폭 안에서만 안↔밖
  if (door && p.z > R.d - PR + 0.01 && p.z < R.d + T + PR - 0.005 && Math.abs(p.x - door.x) < door.w / 2 + 0.3) {
    p.x = THREE.MathUtils.clamp(p.x, door.x - (door.w / 2 - 0.16), door.x + (door.w / 2 - 0.16));
    wasOutdoor = false;
    return;
  }
  // 바깥 골목
  if (storeSD(p.x, p.z) < -T) {
    pushObstacles(p);
    const ok = (x, z) => inOutdoor(x, z, PR) && storeSD(x, z) < -(T + PR);
    wasOutdoor = true;
    if (ok(p.x, p.z)) return;
    const L = lastPos || { x: p.x, z: p.z };
    if (ok(p.x, L.z)) { p.z = L.z; return; } // 벽을 따라 미끄러지기
    if (ok(L.x, p.z)) { p.x = L.x; return; }
    p.x = L.x; p.z = L.z;
    return;
  }
  if (wasOutdoor && lastPos) { p.x = lastPos.x; p.z = lastPos.z; return; } // 벽을 뚫고 들어오지 않게
  // 벽 안쪽으로 (볼록한 방이라 각 벽에서 밀어내면 됨)
  for (const e of EDGES) {
    if (inDoor && e.kind === "front") continue; // 문은 지나갈 수 있음
    const d = (p.x - e.ax) * e.nx + (p.z - e.az) * e.nz;
    if (d < PR) { p.x += e.nx * (PR - d); p.z += e.nz * (PR - d); }
  }
  pushObstacles(p);
  // 장·가구에 밀려 유리창 밖으로 나가지 않게 벽을 마지막에 한 번 더
  for (const e of EDGES) {
    if (inDoor && e.kind === "front") continue;
    const d = (p.x - e.ax) * e.nx + (p.z - e.az) * e.nz;
    if (d < PR) { p.x += e.nx * (PR - d); p.z += e.nz * (PR - d); }
  }
  // 바텐더: 몸통만큼 작은 판정 (지나갈 때 걸리적거리지 않게)
  for (const b of bartenders) {
    const dx = p.x - b.position.x, dz = p.z - b.position.z, d = Math.hypot(dx, dz), r = PR + 0.12;
    if (d < r && d > 1e-4) { p.x = b.position.x + dx / d * r; p.z = b.position.z + dz / d * r; }
  }
}

const eulerQuat = (pitch, yaw) => new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, "YXZ"));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function flyTo(pos, quat, fov, dur, onDone, onProgress) {
  walk.tween = {
    t: 0, dur, onDone, onProgress,
    p0: camera.position.clone(), p1: pos,
    q0: camera.quaternion.clone(), q1: quat,
    f0: camera.fov, f1: fov,
  };
}

function enterWalk() {
  if (walk.on || walk.tween) return;
  const door = LAYOUT.door?.wall === "front" ? LAYOUT.door : null;
  walk.pos.set(door ? door.x : R.w / 2, 0, R.d - 0.75);
  collide(walk.pos);
  walk.yaw = Math.atan2(-(center.x - walk.pos.x), -(center.z - walk.pos.z));
  walk.pitch = -0.12;
  controls.enabled = false;
  document.body.classList.add("walking");
  if (IS_ADMIN) $("logoutBtn").textContent = "돌아가기";
  flyTo(new THREE.Vector3(walk.pos.x, EYE, walk.pos.z), eulerQuat(walk.pitch, walk.yaw), walkFov(), 1.6,
    () => { walk.on = true; showWalkHint(); },
    (t) => { fpGroup.visible = t > 0.82; });
}

// 첫 화면: 가게 앞에 서 있다가 [입장하기] → 자동문 열리며 들어감
const frontDoor = () => (LAYOUT.door?.wall === "front" ? LAYOUT.door : { x: R.w / 2, w: 1.4 });
function startIntro() {
  const door = frontDoor();
  walk.intro = true;
  fpGroup.visible = true;
  controls.enabled = false;
  document.body.classList.add("walking", "intro");
  camera.fov = walkFov();
  camera.updateProjectionMatrix();
  const midX = (door.x - door.w / 2 - (LAYOUT.front?.windowW ?? 2.6) + door.x + door.w / 2 + 0.6) / 2;
  camera.position.set(midX, EYE, R.d + 0.14 + FRONT_ACROSS - 0.7);
  camera.lookAt(midX, 1.45, R.d); // 가게가 화면 위쪽에 오도록 (아래는 입장 카드)
  $("introName").textContent = (LAYOUT.front && LAYOUT.front.sign) || LAYOUT.name;
}
function enterStore() {
  if (!walk.intro || walk.tween) return;
  document.body.classList.remove("intro");
  document.body.classList.add("entering");
  const door = frontDoor();
  walk.pos.set(door.x, 0, R.d - 0.9);
  collide(walk.pos);
  const tx = R.w * 0.3, tz = R.d * 0.62;
  walk.yaw = Math.atan2(-(tx - walk.pos.x), -(tz - walk.pos.z));
  walk.pitch = -0.1;
  flyTo(new THREE.Vector3(door.x, EYE, R.d + 1.4), eulerQuat(0, 0), walkFov(), 1.7, () => {
    flyTo(new THREE.Vector3(walk.pos.x, EYE, walk.pos.z), eulerQuat(walk.pitch, walk.yaw), walkFov(), 1.9, () => {
      walk.intro = false;
      walk.on = true;
      document.body.classList.remove("entering");
      closedGreeting();
      showWalkHint();
    });
  });
}

function exitWalk() {
  if (!walk.on) return;
  walk.on = false;
  if (walk.chair) { walk.chair.g.position.x = walk.chair.x; walk.chair.g.position.z = walk.chair.z; walk.chair.g.rotation.y = walk.chair.r; walk.chair = null; }
  walk.sit = null; walk.crouch = false; walk.back = null; walk.jumpY = walk.vy = 0; walk.eye = EYE; updateActBtns();
  if (myLegs) myLegs.g.visible = false;
  walk.look = null;
  walk.keys.clear();
  setAim(null);
  fpGroup.visible = false;
  document.body.classList.remove("walking");
  if (IS_ADMIN) $("logoutBtn").textContent = "나가기";
  const { pos, quat } = overviewPose();
  flyTo(pos, quat, OVERVIEW_FOV, 1.3, () => {
    controls.enabled = true;
    controls.target.copy(center);
    fitCamera();
  });
}

function showWalkHint() {
  if (store.get("seat-hint-shown") && !IS_ADMIN) return;
  store.set("seat-hint-shown", "1");
  toast(IS_TOUCH ? "동그라미로 걷고, 화면을 밀어 둘러보세요\n궁금한 곳을 눌러 보세요!" : "W A S D 로 걷고, 마우스로 둘러보세요\n궁금한 곳을 눌러 보세요!", 3600);
}

function updateWalk(dt, time) {
  const tw = walk.tween;
  if (tw) {
    tw.t = Math.min(1, tw.t + dt / tw.dur);
    const e = ease(tw.t);
    camera.position.lerpVectors(tw.p0, tw.p1, e);
    camera.quaternion.slerpQuaternions(tw.q0, tw.q1, e);
    camera.fov = THREE.MathUtils.lerp(tw.f0, tw.f1, e);
    camera.updateProjectionMatrix();
    tw.onProgress?.(tw.t);
    if (tw.t >= 1) { walk.tween = null; tw.onDone?.(); }
    return;
  }
  if (!walk.on) return;

  const k = walk.keys;
  if (k.has("arrowleft")) walk.yaw += dt * 1.8;
  if (k.has("arrowright")) walk.yaw -= dt * 1.8;
  let f = (k.has("w") || k.has("arrowup") ? 1 : 0) - (k.has("s") || k.has("arrowdown") ? 1 : 0) - walk.joy.y;
  let r = (k.has("d") ? 1 : 0) - (k.has("a") ? 1 : 0) + walk.joy.x;
  const mag = Math.hypot(f, r);
  if (mag > 1) { f /= mag; r /= mag; }
  if (walk.sit) {
    const s = seats.get(walk.sit);
    if (!s || s.occupied) standUp(); // 앉으면 잠금: [일어서기] 버튼으로만 일어섬 (그 자리에 손님이 오면 자동으로)
    f = r = 0;
  }
  const speed = (k.has("shift") ? 2.6 : 1.5) * (walk.crouch ? 0.5 : 1) * dt;
  const sy = Math.sin(walk.yaw), cy = Math.cos(walk.yaw);
  if (!walk.sit) {
    walk.pos.x += (-sy * f + cy * r) * speed;
    walk.pos.z += (-cy * f - sy * r) * speed;
    collide(walk.pos);
  }
  // 점프 (벽·바·테이블은 그대로 막힘)
  if (walk.vy || walk.jumpY > 0) {
    walk.vy -= 9.8 * dt; walk.jumpY += walk.vy * dt;
    if (walk.jumpY <= 0) { walk.jumpY = 0; walk.vy = 0; }
  }
  const eyeT = walk.sit ? (seats.get(walk.sit)?.seatY ?? 0.7) + 0.55 : walk.crouch ? 0.85 : EYE;
  walk.eye += (eyeT - walk.eye) * Math.min(1, dt * 8);

  const moving = Math.min(1, Math.hypot(f, r));
  walk.bob += dt * 9 * moving;
  camera.position.set(walk.pos.x, walk.eye + walk.jumpY + Math.sin(walk.bob) * 0.025 * moving * (walk.jumpY > 0 ? 0 : 1), walk.pos.z);
  updateMyLegs();
  camera.rotation.set(walk.pitch, walk.yaw, Math.sin(walk.bob * 0.5) * 0.004 * moving);
  if (shakeT > 0) { shakeT -= dt; camera.position.x += (Math.random() - 0.5) * 0.03; camera.position.y += (Math.random() - 0.5) * 0.03; } // 보틀 떨어질 때 살짝

  if (++walk.frame % 4 === 0) {
    ray.setFromCamera(ndc.set(0, 0), camera);
    ray.far = 2.5; // 가까이(약 2.5m)에서 의자를 똑바로 볼 때만 안내
    const hit = ray.intersectObjects([...aimBoxes, ...aimBlockers], false)[0]; // 앞에 물건이 있으면 그 뒤 의자는 조준 안 됨
    ray.far = Infinity;
    setAim(walk.sit ? null : hit?.object.userData.seatId || null); // 앉아 있을 땐 자리 안내 끄기
    updateActBtns();
    drawMinimap();
    // 가까이 가면 손님이 손 흔들어 줌
    if (walk.frame % 20 === 0) {
      for (const s of seats.values()) {
        if (s.occupied && Math.hypot(s.group.position.x - walk.pos.x, s.group.position.z - walk.pos.z) < 1.7) waveGuest(s, false);
      }
    }
  }
}

/** 의자 바로 앞(약 70cm 안)에서 그 의자를 바라보고 있을 때 그 의자 */
function seatCandidate() {
  let best = null, bd = 0.75;
  const fx = -Math.sin(walk.yaw), fz = -Math.cos(walk.yaw);
  for (const s of seats.values()) {
    if (!s.group?.position) continue;
    const dx = s.group.position.x - walk.pos.x, dz = s.group.position.z - walk.pos.z, d = Math.hypot(dx, dz);
    if (d >= bd) continue;
    if (d > 0.2 && (dx * fx + dz * fz) / d < 0.64) continue; // 앞쪽 약 50도 안
    bd = d; best = s;
  }
  return best;
}
/** 앉기: 빈자리 가까이면 의자에 앉고, 손님 있는 자리는 "사용 중"(쪼그려 앉기), 그 밖엔 쪼그려 앉기 */
function toggleSit() {
  if (!walk.on || walk.tween) return;
  if (walk.sit || walk.crouch) return standUp();
  const best = seatCandidate();
  if (best && !best.occupied) {
    walk.back = walk.pos.clone();
    walk.sit = best.id;
    walk.pos.set(best.group.position.x, 0, best.group.position.z);
    walk.yaw = best.group.rotation.y + Math.PI; // 바·테이블 쪽을 바라봄
    walk.pitch = -0.12;
    { // 의자를 사람 앉은 만큼 뒤로 빼고 그 위에 앉음 (일어서면 원래 자리로)
      const back = best.id.startsWith("BAR") ? 0.12 : 0.28, g = best.group; // 바 자리는 무릎이 상판 밑에 살짝 들어가게
      walk.chair = { g, x: g.position.x, z: g.position.z, r: g.rotation.y };
      g.position.x += Math.sin(walk.yaw) * back; g.position.z += Math.cos(walk.yaw) * back;
      walk.pos.set(g.position.x, 0, g.position.z);
    }
    if (storeInfo?.hours && !isOpenNow() && !isLockedNow()) serveWater(best); // 휴무일 + 영업시간 외 (문 잠긴 시간 제외)
  } else {
    if (best) popBubble("사용 중이에요", best.group.position.x, 1.5, best.group.position.z, { fg: "#c0533f" });
    walk.crouch = true;
  }
  updateActBtns();
}
// ───────── 앉았을 때 보이는 내 다리 (허벅지·무릎·정강이·신발) ─────────
let myLegs = null;
function buildMyLegs() {
  const g = new THREE.Group(); g.visible = false; scene.add(g);
  const pants = toon("#4a4f5e", { unique: true }), shoe = toon("#2a2522", { unique: true });
  const parts = [];
  for (const sx of [-0.12, 0.12]) {
    const thigh = mk(new THREE.CapsuleGeometry(0.055, 0.34, 6, 12), pants, [sx, 0, -0.24], g, { outline: 0.006, shadow: false });
    thigh.rotation.x = Math.PI / 2;
    const shin = mk(new THREE.CapsuleGeometry(0.048, 1, 6, 12), pants, [sx, 0, -0.44], g, { outline: 0.006, shadow: false });
    const foot = mk(box(0.1, 0.07, 0.23), shoe, [sx, 0, -0.5], g, { outline: 0.006, shadow: false });
    parts.push({ thigh, shin, foot });
  }
  // 몸통: 골반(바지) + 배·가슴(내 옷 색). 고개를 숙이면 무릎 사이로 보임
  const top = toon("#8f7a62", { unique: true });
  const pelvis = mk(box(0.34, 0.14, 0.24), pants, [0, 0, -0.05], g, { outline: 0.006, shadow: false });
  const torso = mk(new THREE.CapsuleGeometry(0.14, 0.08, 6, 14), top, [0, 0, 0.07], g, { outline: 0.006, shadow: false });
  torso.scale.set(1.15, 1, 0.8);
  myLegs = { g, parts, pants, top, pelvis, torso };
}
const PANTS_FOR_COAT = ["#5b4a3a", "#3c4350", "#2e3340"]; // 내 옷(코트/점퍼/패딩)에 어울리는 바지 색
function updateMyLegs() {
  if (!myLegs) buildMyLegs();
  const s = walk.sit && seats.get(walk.sit);
  myLegs.g.visible = !!s;
  if (!s) return;
  const seatY = s.seatY ?? 0.7, hip = seatY + 0.06, bar = s.id.startsWith("BAR") || seatY > 0.6;
  const footY = bar ? 0.3 : 0.04; // 바 의자는 발걸이, 테이블 의자는 바닥
  myLegs.g.position.set(walk.pos.x, 0, walk.pos.z);
  myLegs.g.rotation.y = walk.yaw;
  if (walk.chair) walk.chair.g.rotation.y = walk.yaw - Math.PI; // 둘러보면 의자도 같이 돎
  if (myCoat >= 0) { myLegs.pants.color.set(PANTS_FOR_COAT[myCoat % 3]); myLegs.top.color.set(["#8f7a62", "#6b3f3a", "#4b5a73"][myCoat % 3]); } // 옷걸이에 건 내 옷과 같은 색
  myLegs.pelvis.position.y = hip + 0.02;
  myLegs.torso.position.y = hip + 0.13; // 위끝이 눈보다 약 20cm 아래, 살짝 뒤
  for (const { thigh, shin, foot } of myLegs.parts) {
    thigh.position.y = hip;
    const len = hip - footY; shin.scale.set(1, Math.max(0.2, (len - 0.12) / 1.0), 1); shin.position.y = footY + len / 2 + 0.03; shin.position.z = bar ? -0.44 : -0.48;
    foot.position.y = footY + 0.035; foot.position.z = bar ? -0.5 : -0.56;
  }
}
function standUp() {
  clearWater();
  if (walk.chair) { walk.chair.g.position.x = walk.chair.x; walk.chair.g.position.z = walk.chair.z; walk.chair.g.rotation.y = walk.chair.r; walk.chair = null; } // 의자 제자리로
  if (walk.sit && walk.back) { walk.pos.copy(walk.back); collide(walk.pos); }
  walk.sit = null; walk.crouch = false; walk.back = null;
  updateActBtns();
}
function jump() {
  if (!walk.on || walk.tween) return;
  if (walk.sit) return; // 앉아 있을 땐 점프 안 됨
  if (walk.crouch) { standUp(); return; }
  if (walk.jumpY === 0) walk.vy = 3.1;
}
function updateActBtns() {
  const b = $("sitBtn");
  if (!b) return;
  const c = !walk.sit && !walk.crouch ? seatCandidate() : null;
  const label = walk.sit ? "의자에서<br>일어나기" : walk.crouch ? "일어서기" : c && !c.occupied ? "의자에<br>앉기" : "앉기";
  if (b.dataset.l !== label) { b.dataset.l = label; b.innerHTML = label; }
  b.classList.toggle("seatable", label.startsWith("의자에")); // 앉을 수 있을 때·앉아 있을 때 초록
}

function setAim(id) {
  const el = $("aim");
  walk.aimId = id;
  document.body.classList.toggle("aiming", !!id);
  if (!id) { el.className = "aim"; return; }
  const occ = seats.get(id).occupied;
  const admin = document.body.classList.contains("admin");
  el.className = `aim show ${occ ? "busy" : "free"}`;
  el.innerHTML = admin
    ? `<b>${id}</b> ${occ ? "사용 중" : "빈자리"}<small>${IS_TOUCH ? "자리를 눌러" : "E 키 / 클릭으로"} 바꾸기</small>`
    : `<b>${occ ? "사용 중이에요" : "빈자리예요"}</b>`;
}

// 미니맵 (오른쪽 아래)
function drawMinimap() {
  const c = $("minimap");
  const W = c.clientWidth;
  if (!W) return;
  const dpr = Math.min(devicePixelRatio, 2);
  const sc = W / (R.w + 0.6);
  const H = (R.d + 0.6) * sc;
  if (c.width !== Math.round(W * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); c.style.height = `${H}px`; }
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  g.translate(0.3 * sc, 0.3 * sc);
  g.fillStyle = "#f6e6cf";
  g.strokeStyle = "#4a3a31";
  g.lineWidth = 2;
  g.beginPath();
  OUTLINE.forEach(([x, z], i) => (i ? g.lineTo(x * sc, z * sc) : g.moveTo(x * sc, z * sc)));
  g.closePath(); g.fill(); g.stroke();
  g.fillStyle = "#c9a37e";
  for (const o of obstacles) {
    g.save();
    g.translate(o.x * sc, o.z * sc);
    g.rotate(THREE.MathUtils.degToRad(o.deg || 0));
    g.fillRect(-o.hw * sc, -o.hd * sc, o.hw * 2 * sc, o.hd * 2 * sc);
    g.restore();
  }
  for (const s of seats.values()) {
    g.fillStyle = s.occupied ? COLOR.busy : COLOR.empty;
    g.beginPath(); g.arc(s.group.position.x * sc, s.group.position.z * sc, Math.max(2.5, 0.2 * sc), 0, Math.PI * 2); g.fill();
  }
  // 나 (시야 부채꼴 + 점)
  const px = walk.pos.x * sc, pz = walk.pos.z * sc;
  const ang = Math.atan2(-Math.cos(walk.yaw), -Math.sin(walk.yaw));
  g.fillStyle = "rgba(80,140,230,.25)";
  g.beginPath(); g.moveTo(px, pz); g.arc(px, pz, 2.6 * sc, ang - 0.55, ang + 0.55); g.closePath(); g.fill();
  g.fillStyle = "#3d7fe0"; g.strokeStyle = "#fff"; g.lineWidth = 2;
  g.beginPath(); g.arc(px, pz, 5, 0, Math.PI * 2); g.fill(); g.stroke();
}

function initWalk() {
  if (new URLSearchParams(location.search).has("debug")) { window.__walk = walk; window.__cam = camera; window.__seats = seats; window.__bt = bartenders; window.__fx = { spillMilk, spillIce, freezerPuff, fridges, iceMakers, blindFaces, setBlindLevel, sayProps, served }; } // 확인용
  $("walkBtn").addEventListener("click", enterWalk);
  $("mapBtn").addEventListener("click", exitWalk);
  $("enterBtn").addEventListener("click", () => {
    if (isLockedNow() && !IS_ADMIN) { // 새벽 4시 ~ 오전 10시: 문이 잠겨 입장 불가
      toast("문이 잠겼어요", 1800);
      const d = doorPanels[0]?.g; if (d) { let k = 0; const iv = setInterval(() => { d.rotation.y = (k % 2 ? -1 : 1) * 0.03 * (k < 6 ? 1 : 0); if (++k > 6) clearInterval(iv); }, 70); } // 문 덜컹
      return;
    }
    enterStore();
    screens.forEach((scr) => scr.media[scr.idx]?.play?.().catch(() => {})); // 영상은 사용자 터치 후 재생 가능
  });

  addEventListener("keydown", (e) => {
    if (!walk.on || e.target.closest?.("input, textarea")) return;
    const key = e.key.toLowerCase();
    if (key === "escape") return exitWalk();
    if (key === " ") { e.preventDefault(); if (!e.repeat) jump(); return; }
    if (key === "c") { if (!e.repeat) toggleSit(); return; }
    if ((key === "e" || key === "enter") && walk.aimId && document.body.classList.contains("admin")) {
      e.preventDefault();
      toggleSeat(walk.aimId).then(() => setAim(walk.aimId));
      return;
    }
    walk.keys.add(key);
    if (key.startsWith("arrow") || key === " ") e.preventDefault();
  });
  addEventListener("keyup", (e) => walk.keys.delete(e.key.toLowerCase()));
  addEventListener("blur", () => walk.keys.clear());

  // 앉기 / 점프 버튼
  for (const [id, fn] of [["sitBtn", toggleSit], ["jumpBtn", jump]]) {
    const b = $(id);
    b?.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
    b?.addEventListener("click", (e) => e.stopPropagation());
  }
  // 가상 조이스틱 (휴대폰)
  const joy = $("joy"), knob = joy.querySelector("i");
  let jid = null, jc = null;
  const R0 = 44;
  const move = (e) => {
    let dx = e.clientX - jc.x, dy = e.clientY - jc.y;
    const m = Math.hypot(dx, dy);
    if (m > R0) { dx *= R0 / m; dy *= R0 / m; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    walk.joy.x = dx / R0;
    walk.joy.y = dy / R0;
  };
  joy.addEventListener("pointerdown", (e) => {
    jid = e.pointerId;
    const r = joy.getBoundingClientRect();
    jc = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    joy.setPointerCapture(e.pointerId);
    move(e);
  });
  joy.addEventListener("pointermove", (e) => { if (e.pointerId === jid) move(e); });
  const end = (e) => {
    if (e.pointerId !== jid) return;
    jid = null;
    walk.joy.x = walk.joy.y = 0;
    knob.style.transform = "";
  };
  joy.addEventListener("pointerup", end);
  joy.addEventListener("pointercancel", end);
}

// ───────── 애니메이션 ─────────
const clock = new THREE.Clock();
const elastic = (t) => (t === 0 || t === 1 ? t : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1);

function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const time = clock.elapsedTime;
  for (const s of seats.values()) {
    // 손님 등장/퇴장
    const speed = s.target > s.anim ? 2.2 : 4;
    s.anim += Math.sign(s.target - s.anim) * Math.min(Math.abs(s.target - s.anim), dt * speed);
    const k = s.target ? elastic(s.anim) : s.anim * s.anim;
    s.guest.scale.setScalar(Math.max(0.001, k));
    if (s.anim <= 0.001 && !s.target) s.guest.visible = false;
    if (s.guest.visible) {
      const ph = s.guest.userData.phase;
      s.guest.position.y = Math.sin(time * 2 + ph) * 0.012;
      s.guest.userData.head.rotation.z = Math.sin(time * 1.3 + ph) * 0.08;
      s.guest.userData.head.rotation.y = Math.sin(time * 0.7 + ph * 2) * 0.25;
    }
    // 손 흔들기
    const gu = s.guest.userData;
    if (gu.wave > 0) {
      gu.wave = Math.max(0, gu.wave - dt);
      const a = gu.arms[1];
      const w = Math.min(1, gu.wave * 4, (1.8 - gu.wave) * 5);
      a.rotation.x = THREE.MathUtils.lerp(-1.1, -2.9, w);
      a.rotation.z = Math.sin(time * 14) * 0.45 * w;
    }
    // 빈자리 표시 (둥실둥실)
    const show = (1 - Math.min(1, s.anim * 2)) * (walk.sit === s.id ? 0 : 1); // 내가 앉은 자리는 숨김
    s.tag.visible = show > 0.01;
    if (s.tag.visible) {
      s.tag.scale.setScalar(show);
      s.tag.rotation.y = time * 1.6 + s.group.position.x;
      s.tag.position.y = s.tagY + Math.sin(time * 2.4 + s.group.position.x * 1.7) * 0.035;
    }
    // 터치했을 때 의자 통통
    if (s.bump > 0) {
      s.bump = Math.max(0, s.bump - dt * 3);
      s.cushion.scale.y = 1 + Math.sin(s.bump * Math.PI) * 0.6;
    }
  }
  updateWalk(dt, time);
  updateWorld(dt, time);
  if (!walk.on && !walk.tween && !walk.intro) controls.update();
  renderer.render(scene, camera);
}

const leaves = []; // 접이식 테이블 날개
const bartenders = []; // 바 안쪽을 걸어 다니는 바텐더
const dustClouds = []; // 프로젝터 빛 속 먼지
const coatracks = []; // 손님 수만큼 옷이 걸리는 행거
let myCoat = -1; // 내 옷 종류 (처음 앉을 때 정하고, 다시 앉아도 같은 옷)
let steamT = 0;
const steamGeo = new THREE.SphereGeometry(0.05, 8, 6);
const DAY = { sky: new THREE.Color("#fff6ea"), ground: new THREE.Color("#c9a88a") };
const NIGHT = { sky: new THREE.Color("#7f8db5"), ground: new THREE.Color("#3a3140") };
function updateWorld(dt, time) {
  // 밖(가게 앞)은 밤, 안으로 들어가면 밝게
  const night = fpGroup.visible ? THREE.MathUtils.clamp((-storeSD(camera.position.x, camera.position.z) - 0.3) / 1.6, 0, 1) : 0;
  hemi.intensity = THREE.MathUtils.lerp(1.4, 0.55, night);
  hemi.color.copy(DAY.sky).lerp(NIGHT.sky, night);
  hemi.groundColor.copy(DAY.ground).lerp(NIGHT.ground, night);
  sun.intensity = THREE.MathUtils.lerp(2.2, 0.12, night);
  document.body.classList.toggle("night", night > 0.5);
  if (LINE) applyTime(night, time);
  if (steamFan) steamFan.rotation.z -= dt * 5;
  // 자동문
  if (doorPanels.length) {
    const d = frontDoor();
    const near = Math.hypot(camera.position.x - d.x, camera.position.z - R.d) < 2.7;
    doorOpen += ((fpGroup.visible && near ? 1 : 0) - doorOpen) * Math.min(1, dt * 4);
    for (const p of doorPanels) p.g.rotation.y = 1.35 * doorOpen; // 바깥쪽(+z)으로 열림 (경첩 오른쪽)
  }
  for (const l of labelSprites) l.visible = !fpGroup.visible; // 1인칭에선 번호표 숨김
  for (const b of bartenders) updateBartender(b, dt, time);
  updateIce(dt);
  updateWalkers(dt, time);
  for (const d of dustClouds) { // 먼지가 천천히 떠다님
    const a = d.geometry.attributes.position, b = d.userData.base, sd = d.userData.seed;
    for (let i = 0; i < sd.length; i++) {
      a.array[i * 3] = b[i * 3] + Math.sin(time * 0.3 + sd[i]) * 0.04;
      a.array[i * 3 + 1] = b[i * 3 + 1] + Math.sin(time * 0.2 + sd[i] * 2) * 0.05;
      a.array[i * 3 + 2] = b[i * 3 + 2] + Math.cos(time * 0.25 + sd[i]) * 0.04;
    }
    a.needsUpdate = true;
  }
  for (const r of coatracks) { // 내가 앉아 있으면 내 옷이 걸림
    const mine = r.userData.mine;
    if (!mine) continue;
    if (walk.sit && myCoat < 0) myCoat = Math.floor(Math.random() * mine.variants.length);
    mine.on += ((walk.sit ? 1 : 0) - mine.on) * Math.min(1, dt * 5);
    mine.variants.forEach((v, i) => { const on = i === myCoat ? mine.on : 0; v.visible = on > 0.01; v.scale.set(1, Math.max(0.001, on), 1); });
  }
  for (const r of coatracks) for (const gm of r.userData.garments) {
    gm.on += (gm.target - gm.on) * Math.min(1, dt * 5);
    gm.g.visible = gm.on > 0.01;
    gm.g.scale.set(1, Math.max(0.001, gm.on), 1); // 위에서부터 스르륵 걸림
  }
  // 접이식 테이블 날개 (펴짐 0° ↔ 접힘 아래로 90°)
  for (const lf of leaves) {
    lf.open += (lf.target - lf.open) * Math.min(1, dt * 5);
    lf.pivot.rotation.x = (1 - lf.open) * Math.PI / 2;
  }
  // 누른 소품 흔들기
  for (const u of sayProps) {
    if (u.wiggle <= 0) continue;
    u.wiggle = Math.max(0, u.wiggle - dt * 1.3);
    const w = u.group.userData.wiggler;
    if (w) w.rotation.z = Math.sin(time * 18) * 0.14 * u.wiggle;
    else u.group.scale.y = 1 + Math.sin(u.wiggle * Math.PI * 4) * 0.025 * u.wiggle;
  }
  // 커피 김
  steamT += dt;
  if (steamT > 0.3) {
    steamT = 0;
    for (const src of steamSources) {
      const m = new THREE.Mesh(steamGeo, new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.6, depthWrite: false }));
      const dx = (Math.random() - 0.5) * 0.1;
      addEffect(m, scene, 2.2, (e) => {
        const t = e.t / e.life;
        const k = src.userData?.k ?? 1, a = src.userData?.a ?? 0.55;
        m.position.set(src.x + dx * k + Math.sin(e.t * 3) * 0.04 * k, src.y + t * 0.7 * k, src.z);
        m.scale.setScalar((1 + t * 2) * k);
        m.material.opacity = a * (1 - t);
      });
    }
  }
  // 효과(말풍선·하트·김) 진행/정리
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i];
    e.t += dt;
    e.update(e);
    if (e.t >= e.life) {
      e.parent.remove(e.obj);
      if (e.obj.material.map && e.obj.material.map !== heartTex) e.obj.material.map.dispose();
      e.obj.material.dispose();
      effects.splice(i, 1);
    }
  }
  updateScreens(dt);
}

// ───────── 관리자: 방문 통계 ─────────
const fmtDur = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`;
};
let statsDays = [];
async function loadStats() {
  try {
    const { days } = await api("/api/stats");
    statsDays = days;
    const t = days[0];
    $("stats").textContent = `오늘 ${t.visits}명 · 평균 ${fmtDur(t.avgMs)}`;
  } catch {}
}

// ───────── 시작 ─────────
async function main() {
  $("brand").textContent = `빈자리찾기 · ${LAYOUT.name}`;
  if ($("boot")) $("boot").querySelector(".boot-name").textContent = (LAYOUT.front && LAYOUT.front.sign) || LAYOUT.name;
  document.title = `빈자리찾기 · ${LAYOUT.name}`;
  if (IS_ADMIN) $("hint").textContent = "자리를 누르면 손님 있음 ↔ 빈자리";

  if (renderer) {
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = !LINE; // 손그림 그림체는 그림자 없이 평면으로
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);

    const hasModel = await loadModel();
    tintCollect = true; // 손그림 그림체: 시간대 색 변화를 받을 재질 모으기 (빛나는 것 제외)
    if (!hasModel) { buildRoom(); buildProps(); }
    buildTables();
    buildScreens();
    buildWalkers();
    tintCollect = false;
    if (LINE) softenInteriorOutlines(roomGroup);
    if (LINE) splitInteriorTints();

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minPolarAngle = 0.15;
    controls.maxPolarAngle = 1.2;
    controls.minAzimuthAngle = -0.35;
    controls.maxAzimuthAngle = 1.1;
    controls.screenSpacePanning = false;
    controls.addEventListener("change", () => {
      controls.target.x = THREE.MathUtils.clamp(controls.target.x, 0, R.w);
      controls.target.z = THREE.MathUtils.clamp(controls.target.z, 0, R.d);
      controls.target.y = center.y;
    });
    fitCamera();
    addEventListener("resize", fitCamera);
    bindPointer();
    initWalk();
    $("walkBtn").hidden = false;
    const q = new URLSearchParams(location.search);
    if (!IS_ADMIN && !q.has("map")) startIntro(); // 손님: 가게 앞에서 시작
    else if (q.has("walk") && (IS_ADMIN || !isLockedNow())) setTimeout(enterWalk, 400);
    renderer.setAnimationLoop(tick);
  } else {
    buildTablesHeadless();
  }

  renderSummary();
  if (IS_ADMIN) {
    if (token) {
      try { await api("/api/login"); document.body.classList.add("admin"); loadStats(); await loadBoard(); buildBoard(); }
      catch (e) { showLogin(e.message); }
    } else showLogin();
  }
  loadStore();
  startPolling();
  // 첫 화면이 그려지면 로딩 화면 걷기
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove("booting")));
  setTimeout(() => $("boot")?.remove(), 1500);
  if (IS_ADMIN) {
    setInterval(() => { if (document.body.classList.contains("admin")) loadStats(); }, 60000);
    $("stats").addEventListener("click", () => {
      if (statsDays.length) toast(statsDays.map((d) => `${d.day.slice(5)}  ${d.visits}명 · 평균 ${fmtDur(d.avgMs)}${d.adTaps ? ` · 광고 ${d.adTaps}` : ""}`).join("\n"), 5000);
    });
  }
}

// ───────── 관리자 자리 버튼판: 매장 배치 평면 + 큰 버튼, 누르고 3초 뒤 반영 (3초 안에 다시 누르면 취소) ─────────
const pending = new Map(); // 자리 id → { target, timer }
const boardEls = new Map();
/** 꺾인 선을 옆으로 d 만큼 평행 이동 (+ = 손님 쪽) */
function offsetPath(pts, d) {
  const nrm = (a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz); return [dz / l, -dx / l]; };
  return pts.map((p, i) => {
    const n0 = i > 0 ? nrm(pts[i - 1], p) : null, n1 = i < pts.length - 1 ? nrm(p, pts[i + 1]) : null;
    let nx = (n0?.[0] ?? 0) + (n1?.[0] ?? 0), nz = (n0?.[1] ?? 0) + (n1?.[1] ?? 0);
    const l = Math.hypot(nx, nz); nx /= l; nz /= l;
    const k = n0 && n1 ? 1 / Math.max(0.5, nx * n0[0] + nz * n0[1]) : 1; // 모서리 길이 보정
    return [p[0] + nx * d * k, p[1] + nz * d * k];
  });
}
function along(pts, t) { // 선 위 t(0~1) 위치
  const seg = []; let L = 0;
  for (let i = 0; i < pts.length - 1; i++) { const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); seg.push(l); L += l; }
  let d = t * L;
  for (let i = 0; i < seg.length; i++) { if (d <= seg[i] || i === seg.length - 1) { const k = Math.min(1, d / seg[i]); return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k, Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0])]; } d -= seg[i]; }
}
// 버튼판 배치 (관리자가 [배치 편집]으로 조정, 서버에 저장): 바 칸 크기, 테이블별 위치(m)·크기 배율
const BOARD_DEFAULT = { barQ: 1.12, bar: { dx: 0, dz: 0 }, seats: {}, tables: { T1: { dx: 0, dz: -1.25, s: 1 }, T2: { dx: -0.55, dz: 0, s: 1 } } };
let boardCfg = JSON.parse(JSON.stringify(BOARD_DEFAULT));
let boardDef = null; // 서버에 저장된 기본값 ([기본값] 버튼이 돌아가는 배치)
const tcfg = (id) => { const c = (boardCfg.tables[id] ||= { dx: 0, dz: 0, s: 1, r: 0 }); c.r ??= 0; return c; };
const BOARD_BAR_SEATS = -0.25; // 바 자리 칸이 놓이는 선 (바 손님 쪽 가장자리 기준)
function seatBoardPos() {
  const out = new Map(), S = 10;
  const tables = LAYOUT.tables || [];
  for (const b of LAYOUT.bars || []) {
    const line = offsetPath(b.path, BOARD_BAR_SEATS);
    const groups = b.boardGroups || [2, 4, 2]; // 실제 의자 위치대로: 세로 2 / 대각선 4 / 가로 2
    const Qm = boardCfg.barQ;
    const corners = (cx, cz, a) => { const c = Math.cos(a), s2 = Math.sin(a), h = Qm / 2; return [[-h, -h], [h, -h], [h, h], [-h, h]].map(([x, z]) => [cx + x * c - z * s2, cz + x * s2 + z * c]); };
    const overlap = (A, B) => { for (const P of [A, B]) for (let i = 0; i < 4; i++) { const [x1, z1] = P[i], [x2, z2] = P[(i + 1) % 4], nx = z2 - z1, nz = x1 - x2;
      const pa = A.map(([x, z]) => x * nx + z * nz), pb = B.map(([x, z]) => x * nx + z * nz);
      if (Math.max(...pa) <= Math.min(...pb) + 1e-4 || Math.max(...pb) <= Math.min(...pa) + 1e-4) return false; } return true; };
    let n = 0, pc = null; const placed = [];
    groups.forEach((cnt, gi) => {
      const A = line[gi], B = line[gi + 1]; if (!B) return;
      const L = Math.hypot(B[0] - A[0], B[1] - A[1]), ux = (B[0] - A[0]) / L, uz = (B[1] - A[1]) / L, ang = Math.atan2(uz, ux);
      let t0;
      if (gi === 0) t0 = L - Qm * (cnt - 0.5); // 첫 구간: 모서리에서 거꾸로
      else { // 다음 구간: 앞 칸과 모서리가 맞닿는(겹치지 않는) 첫 자리
        t0 = (pc[0] - A[0]) * ux + (pc[1] - A[1]) * uz;
        while (t0 < L + 4 && placed.some((P) => overlap(P, corners(A[0] + ux * t0, A[1] + uz * t0, ang)))) t0 += 0.01;
      }
      for (let k = 0; k < cnt && n < b.seats; k++, n++) {
        const d = t0 + Qm * k, x = A[0] + ux * d, z = A[1] + uz * d;
        out.set(`${b.id}-${n + 1}`, [x * S, z * S, THREE.MathUtils.radToDeg(ang), Qm * S]);
        pc = [x, z]; placed.push(corners(x, z, ang));
      }
    });
    // 바 너머 자리: 마지막 칸들 아래로, 겹치지 않게
    (b.extraSeats || []).forEach(([x], k) => {
      let z = pc[1] + Qm;
      while (z < R.d + 2 && placed.some((P) => overlap(P, corners(x, z, 0)))) z += 0.01;
      out.set(`${b.id}-${b.seats + k + 1}`, [x * S, (z + 0.06) * S, 0, Qm * S]);
    });
    // 바 의자 칸 하나하나 옮기기·회전 + 바 전체 옮기기 (편집에서 조정)
    const bg = boardCfg.bar || {};
    for (const [id, v] of out) {
      if (!id.startsWith(b.id + "-")) continue;
      const c = boardCfg.seats?.[id] || {};
      out.set(id, [v[0] + ((c.dx || 0) + (bg.dx || 0)) * S, v[1] + ((c.dz || 0) + (bg.dz || 0)) * S, v[2] + (c.r || 0), v[3]]);
    }
  }
  for (const s of seats.values()) {
    const p = s.group?.position;
    if (!p || out.has(s.id)) continue;
    let x = p.x, z = p.z, Q = 12;
    const t = tables.find((t) => s.id.startsWith(t.id + "-"));
    if (t) { // 테이블 의자: 테이블 가장자리 둘레에 (테이블 크기 배율·위치 반영)
      const c = tcfg(t.id), k = c.s, dx = x - t.x, dz = z - t.z, l = Math.hypot(dx, dz) || 1;
      const ex = (t.w * k / 2) * Math.abs(dx / l), ez = (t.d * k / 2) * Math.abs(dz / l);
      Q = 12 * k;
      const r = Math.hypot(ex, ez) + Q / 20 + 0.12;
      const [ox, oz] = [(dx / l) * r, (dz / l) * r];
      x = t.x + c.dx + ox; z = t.z + c.dz + oz;
      const sc = boardCfg.seats?.[s.id]; // 의자 하나하나 옮기기·회전
      out.set(s.id, [(x + (sc?.dx || 0)) * S, (z + (sc?.dz || 0)) * S, sc?.r || 0, Q]);
      continue;
    }
    out.set(s.id, [x * S, z * S, 0, Q]);
  }
  return out;
}
let boardEdit = false, boardSel = null, boardBackup = null;
const isBarSeat = (id) => (LAYOUT.bars || []).some((b) => id.startsWith(b.id + "-"));
const isSeatId = (id) => seats.has(id);
const cfgOf = (id) => (id === "BAR" ? (boardCfg.bar ||= { dx: 0, dz: 0 }) : isSeatId(id) ? ((boardCfg.seats ||= {})[id] ||= { dx: 0, dz: 0, r: 0 }) : tcfg(id));
/** 편집 중 끌어서 옮기기 (테이블 / 바 의자 칸) */
function makeDraggable(handle, id, moveEl) {
  const g2 = moveEl || handle;
  handle.addEventListener("pointerdown", (e) => {
    if (!boardEdit) return;
    e.preventDefault(); e.stopPropagation(); // 의자 칸을 끌 때 테이블까지 끌리지 않게
    boardSel = id; $("bdSel").textContent = id === "BAR" ? "바 의자 전체 · 끌어서 옮기기, −+ 바 칸 크기" : isSeatId(id) ? `${isBarSeat(id) ? "바" : id.replace(/-\d+$/, "")} ${id.replace(/^.*-/, "")}번 의자 · 끌어서 옮기기, ⟲⟳ 회전, −+ ${isBarSeat(id) ? "바 칸" : "테이블"} 크기` : `${id} · 끌어서 옮기기, −+ 크기`;
    for (const g of document.querySelectorAll("#boardSvg .sel")) g.classList.remove("sel"); g2.classList.add("sel");
    const svg = $("boardSvg"), S = 10, inv = svg.getScreenCTM().inverse(), pt = svg.createSVGPoint();
    const toSvg = (ev) => { pt.x = ev.clientX; pt.y = ev.clientY; return pt.matrixTransform(inv); };
    const p0 = toSvg(e); let dx = 0, dy = 0;
    const mv = (ev) => { const p1 = toSvg(ev); dx = p1.x - p0.x; dy = p1.y - p0.y; g2.setAttribute("transform", `translate(${dx},${dy}) ${g2.dataset.base || ""}`); };
    const up = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); removeEventListener("pointercancel", up);
      if (Math.hypot(dx, dy) > 0.5) { const c = cfgOf(id); c.dx = (c.dx || 0) + dx / S; c.dz = (c.dz || 0) + dy / S; }
      buildBoard(true); };
    addEventListener("pointermove", mv); addEventListener("pointerup", up); addEventListener("pointercancel", up);
  });
}
function buildBoard(force) {
  const svg = $("boardSvg");
  if (!svg || (svg.dataset.built && !force)) return;
  const first = !svg.dataset.built;
  svg.dataset.built = "1";
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  boardEls.clear();
  const S = 10, NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs, parent = svg, text) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; parent.appendChild(e); return e; };
  el("polygon", { class: "room", points: R.outline.map(([x, z]) => `${x * S},${z * S}`).join(" ") });
  const d = LAYOUT.door; if (d) { el("line", { class: "door", x1: (d.x - d.w / 2) * S, y1: R.d * S, x2: (d.x + d.w / 2) * S, y2: R.d * S }); el("text", { class: "doorlabel", x: d.x * S, y: R.d * S + 4 }, svg, "입구"); }
  const groupTap = (ids) => {
    if (boardEdit) return;
    const eff = (id) => (pending.has(id) ? pending.get(id).target : seats.get(id).occupied);
    const target = ids.some((id) => !eff(id));
    for (const id of ids) if (eff(id) !== target) boardTap(id);
  };
  const tgroups = new Map();
  for (const b of LAYOUT.bars || []) {
    const bc = boardCfg.bar || {};
    const m = offsetPath(b.path, BOARD_BAR_SEATS - 1.0)[1];
    void bc;
    const bgp = el("g", { class: "tg bar" + (boardSel === "BAR" ? " sel" : "") });
    tgroups.set(b.id, bgp);
    const t = el("text", { class: "tlabel dark barlabel", x: m[0] * S + 1 + ((boardCfg.bar?.dx) || 0) * S, y: m[1] * S + 35 + ((boardCfg.bar?.dz) || 0) * S }, bgp, b.id);
    makeDraggable(t, "BAR", bgp); // BAR 글자를 끌면 바 의자 전체가 함께 움직임
    t.addEventListener("click", () => (boardEdit ? selectBoard("BAR") : groupTap(tableGroups.find((g) => g.id === b.id)?.seatIds || [])));
  }
  for (const t0 of LAYOUT.tables || []) {
    const c = tcfg(t0.id), t = { ...t0, x: t0.x + c.dx, z: t0.z + c.dz, w: t0.w * c.s, d: t0.d * c.s };
    const tg = el("g", { class: "tg" + (boardSel === t0.id ? " sel" : "") });
    tgroups.set(t0.id, tg);
    const rotA = "";
    if (t.shape === "rect" || t.type === "rect") el("rect", { class: "tbl", x: (t.x - t.w / 2) * S, y: (t.z - t.d / 2) * S, width: t.w * S, height: t.d * S, rx: 1, transform: rotA }, tg);
    else el("ellipse", { class: "tbl", cx: t.x * S, cy: t.z * S, rx: (t.w / 2) * S, ry: (t.d / 2) * S, transform: rotA }, tg);
    const lb = el("text", { class: "tlabel", x: t.x * S, y: t.z * S }, tg, t0.id);
    lb.addEventListener("click", () => groupTap(tableGroups.find((g) => g.id === t0.id)?.seatIds || []));
    makeDraggable(tg, t0.id);
  }
  for (const [id, [x, y, rot = 0, Q = 12]] of seatBoardPos()) {
    const tid = id.replace(/-\d+$/, "");
    const g = el("g", { class: "bs", transform: `translate(${x},${y})` }, tgroups.get(tid) || svg);
    el("rect", { class: "ring", x: -Q / 2, y: -Q / 2, width: Q, height: Q, rx: 1.8, transform: `rotate(${rot})` }, g);
    el("rect", { class: "timer", x: -Q / 2 - 0.5, y: -Q / 2 - 0.5, width: Q + 1, height: Q + 1, rx: 2.2, pathLength: 32, transform: `rotate(${rot})` }, g);
    const ico = el("text", { class: "ico", y: 0 }, g, "");
    const mins = el("text", { class: "mins", y: 3 }, g, "");
    g.addEventListener("click", () => { if (!boardEdit) boardTap(id); });
    { makeDraggable(g, id); g.dataset.base = `translate(${x},${y})`; if (boardSel === id) g.classList.add("sel"); }
    boardEls.set(id, { g, ico, mins });
  }
  renderBoard();
  if (first) setInterval(renderBoard, 30000); // 앉은 시간 갱신
}
function selectBoard(id) {
  boardSel = id;
  $("bdSel").textContent = id === "BAR" ? "바 칸 크기" : `${id} 크기`;
  for (const g of document.querySelectorAll("#boardSvg .tg")) g.classList.remove("sel");
  buildBoard(true);
}
function resizeBoard(dir) {
  if (!boardSel) return toast("크기를 바꿀 테이블이나 바를 먼저 눌러 주세요");
  if (boardSel && isSeatId(boardSel) && !isBarSeat(boardSel)) boardSel = boardSel.replace(/-\d+$/, ""); // 테이블 의자 → 그 테이블 크기
  if (boardSel === "BAR" || isBarSeat(boardSel)) boardCfg.barQ = THREE.MathUtils.clamp(+(boardCfg.barQ + dir * 0.06).toFixed(2), 0.7, 1.8);
  else { const c = tcfg(boardSel); c.s = THREE.MathUtils.clamp(+(c.s + dir * 0.08).toFixed(2), 0.6, 2); }
  buildBoard(true);
}
function rotateBoard(dir) {
  if (!boardSel || !isSeatId(boardSel)) return toast("돌릴 의자 칸을 먼저 눌러 주세요");
  const c = cfgOf(boardSel);
  c.r = (((c.r || 0) + dir * 15) % 360 + 360) % 360;
  buildBoard(true);
}
function setBoardEdit(on) {
  boardEdit = on;
  document.body.classList.toggle("boardedit", on);
  $("boardEditBtn").textContent = on ? "편집 중" : "배치 편집";
  if (on) { boardBackup = JSON.stringify(boardCfg); boardSel = null; $("bdSel").textContent = "테이블·의자 칸을 끌어서 옮기기 · 의자 칸은 눌러서 ⟲⟳ 회전"; }
  buildBoard(true);
}
async function loadBoard() {
  try {
    const r = await fetch("/api/board", { cache: "no-store" });
    const j = r.ok ? await r.json() : null;
    if (j?.def) boardDef = j.def;
    if (j?.board) boardCfg = { ...JSON.parse(JSON.stringify(BOARD_DEFAULT)), ...j.board, tables: { ...BOARD_DEFAULT.tables, ...(j.board.tables || {}) } };
  } catch { /* 기본값 */ }
}
function initBoardTools() {
  $("boardEditBtn")?.addEventListener("click", () => setBoardEdit(!boardEdit));
  $("bdMinus")?.addEventListener("click", () => resizeBoard(-1));
  $("bdPlus")?.addEventListener("click", () => resizeBoard(1));
  $("bdRotL")?.addEventListener("click", () => rotateBoard(-1));
  $("bdRotR")?.addEventListener("click", () => rotateBoard(1));
  $("bdReset")?.addEventListener("click", () => { boardCfg = JSON.parse(JSON.stringify(boardDef || BOARD_DEFAULT)); buildBoard(true); });
  $("bdSetDef")?.addEventListener("click", async () => {
    if (!confirm("지금 배치를 [기본값]으로 저장할까요?")) return;
    try { await api("/api/board", { board: boardCfg, asDefault: true }); boardDef = JSON.parse(JSON.stringify(boardCfg)); toast("지금 배치를 기본값으로 저장했어요"); setBoardEdit(false); }
    catch (e) { toast(`저장 실패: ${e.message}`); }
  });
  $("bdCancel")?.addEventListener("click", () => { boardCfg = JSON.parse(boardBackup); setBoardEdit(false); });
  $("bdSave")?.addEventListener("click", async () => {
    try { await api("/api/board", { board: boardCfg }); toast("배치를 저장했어요"); setBoardEdit(false); }
    catch (e) { toast(`저장 실패: ${e.message}`); }
  });
}
function boardTap(id) {
  if (boardEdit) return;
  const s = seats.get(id);
  if (!s) return;
  const pnd = pending.get(id);
  if (pnd) { clearTimeout(pnd.timer); pending.delete(id); renderBoard(); toast(`${id} · 취소`); return; } // 3초 안에 다시 누르면 취소
  const target = !s.occupied;
  if (navigator.vibrate) navigator.vibrate(10);
  pending.set(id, { target, timer: setTimeout(() => {
    pending.delete(id);
    if (seats.get(id).occupied !== target) toggleSeat(id); else renderBoard();
    const e = boardEls.get(id); if (e) { e.g.classList.remove("pop"); void e.g.getBBox(); e.g.classList.add("pop"); }
  }, 3000) });
  renderBoard();
}
function renderBoard() {
  if (!boardEls.size) return;
  const now = Date.now();
  for (const [id, e] of boardEls) {
    const s = seats.get(id), p = pending.get(id);
    const occ = s.occupied;
    e.g.classList.toggle("occ", occ && !p);
    const wasPend = e.g.classList.contains("pend");
    e.g.classList.toggle("pend", !!p);
    e.g.classList.toggle("toocc", !!p && p.target);
    e.g.classList.toggle("toempty", !!p && !p.target);
    if (p && !wasPend) { const t = e.g.querySelector(".timer"); t.style.animation = "none"; void t.getBBox(); t.style.animation = ""; } // 타이머 처음부터
    e.ico.textContent = p ? (p.target ? "손님" : "비움") : occ ? "손님" : id.replace(/^.*-/, "");
    const m = occ && !p && s.since ? Math.max(0, Math.floor((now - s.since) / 60000)) : -1;
    e.mins.textContent = m < 0 ? "" : m >= 60 ? `${Math.floor(m / 60)}시간+` : `${m}분`;
    e.ico.setAttribute("y", m >= 0 ? -1.2 : 0);
  }
}

/** WebGL 이 없을 때: 자리 목록만 만들어 숫자/목록 표시 */
function buildTablesHeadless() {
  const fake = () => ({ material: { color: { set() {} } }, visible: true });
  const add = (gid, n) => {
    const ids = [];
    for (let i = 1; i <= n; i++) {
      const id = `${gid}-${i}`;
      seats.set(id, { id, occupied: false, cushion: fake(), guest: fake() });
      ids.push(id);
    }
    tableGroups.push({ id: gid, seatIds: ids });
  };
  for (const t of LAYOUT.tables || []) add(t.id, t.seats);
  for (const b of LAYOUT.bars || []) add(b.id, b.seats);
}

main();
