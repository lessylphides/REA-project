import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import LAYOUT from "./layout.js";

// ───────── 기본 설정 ─────────
const POLL_MS = 3000;
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
  const sp = bubbleSprite(text, { ...opts, size: 0.11 * Math.max(1, dist / 2.8) });
  sp.position.set(x, y, z);
  const base = sp.scale.clone();
  addEffect(sp, scene, 3.6, (e) => {
    const t = e.t;
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
    // 콘크리트 바닥: 얼룩 + 짧은 금
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 26; i++) {
      g.fillStyle = `rgba(${rnd() > 0.5 ? "255,255,255" : "60,50,60"},${0.03 + rnd() * 0.03})`;
      g.beginPath(); g.ellipse(rnd() * 512, rnd() * 512, 20 + rnd() * 60, 10 + rnd() * 30, rnd() * 3, 0, Math.PI * 2); g.fill();
    }
    g.strokeStyle = LINE ? "rgba(27,27,31,.55)" : "rgba(60,50,60,.25)"; g.lineWidth = LINE ? 3 : 2; g.lineCap = "round";
    for (let i = 0; i < 9; i++) {
      const x = rnd() * 512, y = rnd() * 512;
      g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + 10 + rnd() * 20, y + rnd() * 10, x + 25 + rnd() * 30, y - 5 + rnd() * 10); g.stroke();
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

/** 벽 한 면: wall(막힌 벽) / glass(블라인드 통유리) */
function buildEdge(e, group, h, T) {
  const g = new THREE.Group();
  g.position.set((e.ax + e.bx) / 2 - e.nx * T / 2, 0, (e.az + e.bz) / 2 - e.nz * T / 2);
  g.rotation.y = -Math.atan2(e.dz, e.dx); // 로컬 x = 벽 방향, 로컬 +z = 방 안쪽
  group.add(g);
  const wallBox = (y0, y1) => mk(box(e.len, y1 - y0, T), R.wall, [0, (y0 + y1) / 2, 0], g, { outline: 0.02, shadow: false });
  if (e.kind !== "glass" || h < 1) { wallBox(0, h); return; }
  const sill = 0.12, top = h - 0.32;
  wallBox(0, sill);
  wallBox(top, h);
  // 블라인드 유리
  const t = blindsTex.clone();
  t.needsUpdate = true;
  t.repeat.set(e.len / 0.5, (top - sill) / 1.1);
  const mat = new THREE.MeshBasicMaterial({ map: t, color: "#fff6f2", transparent: true, side: THREE.DoubleSide, depthWrite: false });
  registerTint(mat);
  mk(new THREE.PlaneGeometry(e.len, top - sill), mat, [0, (top + sill) / 2, 0], g, { outline: 0, shadow: false });
  // 흰 창틀
  const white = "#f4f1ec";
  const n = Math.max(1, Math.round(e.len / 1.6));
  for (let i = 0; i <= n; i++) mk(box(0.06, top - sill, T * 0.8), white, [-e.len / 2 + (e.len / n) * i, (top + sill) / 2, 0], g, { outline: 0.01, shadow: false });
  mk(box(e.len, 0.05, T * 0.9), white, [0, top - 0.02, 0], g, { outline: 0.01, shadow: false });
  mk(box(e.len, 0.05, T * 0.9), white, [0, sill + 0.02, 0], g, { outline: 0.01, shadow: false });
  // 햇살 줄무늬 (방 안쪽 바닥)
  if (group === roomGroup || !sunPatches.some((m) => m.userData.edge === e.i)) {
    addSunPatch(g, e.len * 0.95, 2.6, 0, T / 2);
    sunPatches[sunPatches.length - 1].userData.edge = e.i;
  }
  // 창밖 거리 (1인칭에서만, 블라인드 틈으로 보임)
  if (group === fpGroup || group === roomGroup) addStreetView((e.ax + e.bx) / 2, (e.az + e.bz) / 2, e.nx, e.nz, e.len + 6, 5, 3.5, 17 + e.i * 31, R.outside?.[e.i] || "street");
}

// ───────── 창밖 거리 풍경 (블라인드 틈으로 은은하게) ─────────
const streetViews = []; // { ctx, tex, seed }
let streetPhase = "";
function drawStreet(g, W, H, phase, seed) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const night = phase === "night", dusk = phase === "dusk";
  // 하늘
  const sky = g.createLinearGradient(0, 0, 0, H * 0.7);
  if (night) { sky.addColorStop(0, "#121833"); sky.addColorStop(1, "#2b2f55"); }
  else if (dusk) { sky.addColorStop(0, "#8f7fd0"); sky.addColorStop(0.6, "#f39fb0"); sky.addColorStop(1, "#ffb36b"); }
  else { sky.addColorStop(0, "#bfe0f6"); sky.addColorStop(1, "#f2eef6"); }
  g.fillStyle = sky; g.fillRect(0, 0, W, H);
  const roadY = H * 0.74;
  drawSun(g, W * 0.68, roadY - H * (dusk ? 0.16 : 0.5), H, phase);
  // 건물들
  const walls = night ? ["#3a2630", "#2e2b3f", "#3d3036", "#2a3040"] : dusk ? ["#9a5b4c", "#7d6f86", "#a06a58", "#6f7690"] : ["#b5583f", "#cfc9bf", "#a7b6c9", "#c98f6b"];
  let x = -20;
  while (x < W) {
    const w = 120 + rnd() * 160, h = H * (0.35 + rnd() * 0.4), y = roadY - h;
    g.fillStyle = walls[Math.floor(rnd() * walls.length)];
    g.fillRect(x, y, w, h);
    g.strokeStyle = "#1b1b1f"; g.lineWidth = 5; g.strokeRect(x, y, w, h);
    // 창문
    for (let wy = y + 18; wy < roadY - 40; wy += 46) {
      for (let wx = x + 16; wx < x + w - 30; wx += 40) {
        const lit = night ? rnd() < 0.45 : dusk ? rnd() < 0.3 : false;
        g.fillStyle = lit ? "#f3c27a" : night ? "#1d2138" : dusk ? "#5f5a80" : "#bfe0f2";
        g.fillRect(wx, wy, 22, 26);
        g.lineWidth = 3; g.strokeRect(wx, wy, 22, 26);
      }
    }
    x += w + 6 + rnd() * 20;
  }
  // 도로 + 노란 선
  g.fillStyle = night ? "#34343f" : dusk ? "#6d6577" : "#b9b3c4";
  g.fillRect(0, roadY, W, H - roadY);
  g.strokeStyle = "#1b1b1f"; g.lineWidth = 5; g.beginPath(); g.moveTo(0, roadY); g.lineTo(W, roadY); g.stroke();
  g.strokeStyle = night ? "#b59a3c" : "#d9b84a"; g.lineWidth = 6; g.setLineDash([40, 30]);
  g.beginPath(); g.moveTo(0, roadY + (H - roadY) * 0.6); g.lineTo(W, roadY + (H - roadY) * 0.6); g.stroke(); g.setLineDash([]);
  // 가로등 (밤엔 불빛 번짐)
  for (let i = 0; i < 3; i++) {
    const lx = W * (0.15 + i * 0.33 + rnd() * 0.08), ly = roadY - H * 0.42;
    g.strokeStyle = "#1b1b1f"; g.lineWidth = 6; g.beginPath(); g.moveTo(lx, roadY); g.lineTo(lx, ly); g.lineTo(lx + 28, ly); g.stroke();
    if (night || dusk) {
      const glow = g.createRadialGradient(lx + 30, ly + 8, 2, lx + 30, ly + 8, 120);
      glow.addColorStop(0, night ? "rgba(255,230,160,.95)" : "rgba(255,220,160,.6)"); glow.addColorStop(1, "rgba(255,220,150,0)");
      g.fillStyle = glow; g.beginPath(); g.arc(lx + 30, ly + 8, 120, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = night || dusk ? "#fff2c0" : "#e9e4d8"; g.beginPath(); g.arc(lx + 30, ly + 8, 9, 0, Math.PI * 2); g.fill(); g.lineWidth = 3; g.stroke();
  }
  // 주차된 차
  const cx = W * (0.25 + rnd() * 0.4), cy = roadY + 18;
  g.fillStyle = night ? "#3e4150" : "#e9e9ef"; g.strokeStyle = "#1b1b1f"; g.lineWidth = 5;
  g.beginPath(); g.roundRect(cx, cy, 170, 46, 14); g.fill(); g.stroke();
  g.beginPath(); g.roundRect(cx + 30, cy - 30, 100, 36, 12); g.fill(); g.stroke();
  g.fillStyle = night ? "#2a3050" : "#a7c4dc"; g.fillRect(cx + 40, cy - 22, 36, 20); g.fillRect(cx + 84, cy - 22, 36, 20);
  g.fillStyle = "#1b1b1f"; for (const wx of [cx + 32, cx + 138]) { g.beginPath(); g.arc(wx, cy + 46, 15, 0, Math.PI * 2); g.fill(); }
  g.fillStyle = "#e04a3a"; g.fillRect(cx + 162, cy + 10, 8, 10);
  // 노란 입간판
  const sx = cx + 230;
  g.fillStyle = "#f2c94c"; g.beginPath(); g.moveTo(sx, roadY + 70); g.lineTo(sx + 18, roadY + 10); g.lineTo(sx + 52, roadY + 10); g.lineTo(sx + 70, roadY + 70); g.closePath(); g.fill(); g.stroke();
  // 밤 공기 (살짝 뿌옇게)
  if (night) { g.fillStyle = "rgba(120,110,160,.12)"; g.fillRect(0, 0, W, H); }
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

/** 삼거리 골목: 창에서 똑바로 뻗어 나가는 길 (원근감) */
function drawAlley(g, W, H, phase, seed) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const night = phase === "night", dusk = phase === "dusk";
  const sky = g.createLinearGradient(0, 0, 0, H * 0.5);
  if (night) { sky.addColorStop(0, "#121833"); sky.addColorStop(1, "#2b2f55"); }
  else if (dusk) { sky.addColorStop(0, "#8f7fd0"); sky.addColorStop(0.6, "#f39fb0"); sky.addColorStop(1, "#ffb36b"); }
  else { sky.addColorStop(0, "#bfe0f6"); sky.addColorStop(1, "#f2eef6"); }
  g.fillStyle = sky; g.fillRect(0, 0, W, H);
  const vx = W * 0.5, vy = H * 0.46; // 소실점
  drawSun(g, vx, vy - H * (dusk ? 0.02 : 0.3), H, phase);
  const ink = "#1b1b1f";
  const poly = (pts, fill, lw = 5) => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fillStyle = fill; g.fill(); if (lw) { g.strokeStyle = ink; g.lineWidth = lw; g.stroke(); } };
  const lerp = (a, b, t) => a + (b - a) * t;
  // 길 양옆 건물 (멀어질수록 작게)
  const walls = night ? ["#3a2630", "#2e2b3f", "#3d3036", "#2a3040"] : dusk ? ["#9a5b4c", "#7d6f86", "#a06a58", "#6f7690"] : ["#b5583f", "#cfc9bf", "#a7b6c9", "#c98f6b"];
  for (const side of [-1, 1]) {
    let t0 = 0;
    while (t0 < 0.92) {
      const t1 = Math.min(0.95, t0 + 0.12 + rnd() * 0.18);
      const xA = side < 0 ? lerp(0, vx - 40, t0) : lerp(W, vx + 40, t0), xB = side < 0 ? lerp(0, vx - 40, t1) : lerp(W, vx + 40, t1);
      const hA = lerp(H * 0.95, 30, t0) * (0.75 + rnd() * 0.4), hB = hA * (1 - (t1 - t0) * 1.1);
      const bA = lerp(H * 0.95, vy + 8, t0), bB = lerp(H * 0.95, vy + 8, t1);
      poly([[xA, bA], [xB, bB], [xB, bB - hB], [xA, bA - hA]], walls[Math.floor(rnd() * walls.length)], 4);
      // 창문 불빛
      for (let r = 0.2; r < 0.9; r += 0.22) for (let c = 0.15; c < 0.85; c += 0.3) {
        const lit = night ? rnd() < 0.5 : dusk ? rnd() < 0.3 : false;
        const x = lerp(xA, xB, c), y = lerp(bA - hA * r, bB - hB * r, c), sz = Math.min(lerp(hA, hB, c) * 0.06, Math.abs(xB - xA) * 0.1);
        g.fillStyle = lit ? "#f3c27a" : night ? "#1d2138" : dusk ? "#5f5a80" : "#bfe0f2";
        g.fillRect(x - sz * 0.6, y - sz, sz * 1.2, sz * 1.3);
      }
      t0 = t1;
    }
  }
  // 길 (아래가 넓고 소실점으로 좁아짐)
  poly([[W * 0.08, H], [W * 0.92, H], [vx + 40, vy + 8], [vx - 40, vy + 8]], night ? "#34343f" : dusk ? "#6d6577" : "#b9b3c4", 5);
  // 흰 화살표 · 정지선 (삼거리 노면 표시)
  g.fillStyle = night ? "#cfcbd8" : "#ffffff";
  poly([[vx - 70, H * 0.9], [vx + 70, H * 0.9], [vx + 60, H * 0.86], [vx - 60, H * 0.86]], g.fillStyle, 0);
  poly([[vx - 8, H * 0.8], [vx + 8, H * 0.8], [vx + 6, H * 0.68], [vx + 22, H * 0.68], [vx, H * 0.6], [vx - 22, H * 0.68], [vx - 6, H * 0.68]], g.fillStyle, 0);
  // 가로등 (멀어질수록 작게)
  for (const t of [0.25, 0.55, 0.78]) {
    const x = lerp(W * 0.86, vx + 30, t), yb = lerp(H, vy + 8, t), h = lerp(H * 0.75, 40, t);
    g.strokeStyle = ink; g.lineWidth = lerp(6, 2, t);
    g.beginPath(); g.moveTo(x, yb); g.lineTo(x, yb - h); g.lineTo(x - h * 0.12, yb - h); g.stroke();
    if (night || dusk) {
      const r = lerp(150, 40, t), glow = g.createRadialGradient(x - h * 0.12, yb - h, 2, x - h * 0.12, yb - h, r);
      glow.addColorStop(0, night ? "rgba(255,230,160,.95)" : "rgba(255,220,160,.6)"); glow.addColorStop(1, "rgba(255,220,150,0)");
      g.fillStyle = glow; g.beginPath(); g.arc(x - h * 0.12, yb - h, r, 0, Math.PI * 2); g.fill();
    }
  }
  // 골목 안쪽 주차된 차 + 노란 입간판
  const cx = lerp(W * 0.2, vx - 30, 0.45), cy = lerp(H, vy + 8, 0.45), k = 0.55;
  g.fillStyle = night ? "#3e4150" : "#e9e9ef"; g.strokeStyle = ink; g.lineWidth = 3;
  g.beginPath(); g.roundRect(cx, cy - 46 * k, 170 * k, 40 * k, 8); g.fill(); g.stroke();
  g.beginPath(); g.roundRect(cx + 25 * k, cy - 74 * k, 100 * k, 32 * k, 8); g.fill(); g.stroke();
  const sx = lerp(W * 0.7, vx + 30, 0.35), sy = lerp(H, vy + 8, 0.35);
  poly([[sx, sy], [sx + 10, sy - 40], [sx + 30, sy - 40], [sx + 40, sy]], "#f2c94c", 3);
  if (night) { g.fillStyle = "rgba(120,110,160,.14)"; g.fillRect(0, 0, W, H); }
}

/** 창 바깥에 거리 풍경 판 세우기 (방 안을 향하게) */
function addStreetView(cx, cz, nx, nz, w, h, dist, seed, kind = "street") {
  const c = document.createElement("canvas");
  c.width = 1024; c.height = 512;
  const ctx = c.getContext("2d");
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex }));
  m.position.set(cx - nx * dist, h / 2 - 0.3, cz - nz * dist);
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
    const ox0 = door.x - door.w / 2 - 0.05 - winW0, ox1 = door.x - door.w / 2 - 0.05, oy0 = 0.55, oy1 = 2.45;
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
    t.repeat.set(winW / 0.5, 1.9 / 1.1);
    const bm = new THREE.MeshBasicMaterial({ map: t, color: "#fff6f2", transparent: true, depthWrite: false });
    registerTint(bm);
    const inner = mk(new THREE.PlaneGeometry(winW, 1.9), bm, [(wx0 + wx1) / 2, 1.5, R.d - 0.005], fpGroup, { outline: 0, shadow: false });
    inner.renderOrder = 3;
    {
      const sg = new THREE.Group();
      sg.position.set((wx0 + wx1) / 2, 0, R.d);
      sg.rotation.y = Math.PI; // 로컬 +z = 방 안쪽(-z)
      roomGroup.add(sg);
      addSunPatch(sg, winW, 2.6);
    }
    // 정면(입구 쪽) 바깥 골목: 유리 밖 멀리 세움 (창·유리문 너머로 보임, 걸으면 각도 따라 달라짐)
    addStreetView((FRONT_X0 + FRONT_X1) / 2 + 1.5, R.d, FRONT.nx, FRONT.nz, FRONT_X1 - FRONT_X0 + 10, 6, 4.2, 91, R.outside?.[FRONT.i] || "street");
    inner.rotation.y = Math.PI;
    // 자동 유리문 (가까이 가면 양쪽으로 열림)
    const glass = toon("#cfeaf5", { transparent: true, opacity: 0.45 });
    const half = door.w / 2;
    for (const dir of [-1, 1]) {
      const pg = new THREE.Group();
      pg.position.set(door.x + dir * half / 2, 0, zF);
      fpGroup.add(pg);
      mk(box(half - 0.02, dh - 0.02, 0.03), glass, [0, dh / 2, 0], pg, { outline: 0, shadow: false });
      mk(box(0.05, dh, 0.06), "#5a4a40", [-dir * (half / 2 - 0.02), dh / 2, 0], pg, { outline: 0, shadow: false });
      mk(box(0.12, 0.03, 0.04), "#d8d2c8", [-dir * (half / 2 - 0.12), 1.05, 0.04], pg, { outline: 0, shadow: false });
      doorPanels.push({ g: pg, x0: pg.position.x, dir, half });
    }
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
    part(H - 0.32, top);
    part(0, 0.12);
    // 보도
    mk(box(e.len + 1.4, 0.12, 1.3), LINE ? "#d6d0de" : "#8e8a85", [0, -0.07, 0.7 * outward * -1], g, { outline: 0.015, shadow: false });
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
  const top = H + (LINE ? 2.3 : 3.2); // 2층까지 (손그림 그림체는 하늘이 더 보이게 낮게)
  const upY = LINE ? H + 1.25 : H + 1.9, upH = LINE ? 1.2 : 1.5;
  const brickCol = F.color || "#6e3426";

  // ── 벽돌 외벽 (세로로 긴 타일)
  const brick = canvasTex(256, 256, (g, w, h) => {
    if (LINE) {
      g.fillStyle = "#b5583f"; g.fillRect(0, 0, w, h);
      g.strokeStyle = "#1b1b1f"; g.lineWidth = 4; g.lineCap = "round";
      for (let row = 0; row < 4; row++) {
        g.beginPath(); g.moveTo(0, row * 64 + 2); g.lineTo(w, row * 64 + 2); g.stroke();
        for (let col = 0; col < 8; col++) {
          if ((col + row) % 3 === 0) continue; // 손그림처럼 군데군데만
          const x = col * 32 + (row % 2) * 16;
          g.beginPath(); g.moveTo(x, row * 64 + 14); g.lineTo(x, row * 64 + 50); g.stroke();
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
  // 아래 패널 (분홍빛, 사선 무늬)
  const panel = canvasTex(256, 128, (g, w, h) => {
    g.fillStyle = "#f2d3cf"; g.fillRect(0, 0, w, h);
    g.strokeStyle = "rgba(170,110,110,.25)"; g.lineWidth = 3;
    for (let i = -h; i < w; i += 14) { g.beginPath(); g.moveTo(i, h); g.lineTo(i + h, 0); g.stroke(); }
  });
  nightGlow.windows.push(mk(new THREE.PlaneGeometry(winW - 0.08, 0.92), flat(panel), [wx, 0.12 + 0.46, wz], fpGroup, no).material);
  // 선반 + 주황 LED 줄조명 + 촛불
  mk(box(winW - 0.06, 0.05, 0.16), "#2b2522", [wx, 1.06, wz + 0.08], fpGroup, ol);
  mk(box(winW - 0.1, 0.03, 0.02), new THREE.MeshBasicMaterial({ color: "#ffad66" }), [wx, 1.02, wz + 0.15], fpGroup, no);
  const glowStrip = nightGlow.strip = mk(new THREE.PlaneGeometry(winW - 0.1, 0.35), new THREE.MeshBasicMaterial({ color: "#ff9a5c", transparent: true, opacity: 0.35, depthWrite: false }), [wx, 0.86, wz + 0.004], fpGroup, no);
  glowStrip.renderOrder = 2;
  for (let i = 0; i < 4; i++) {
    const h = [0.16, 0.22, 0.12, 0.18][i];
    mk(cyl(0.045, 0.045, h, 14), new THREE.MeshBasicMaterial({ color: "#ffd27a" }), [wx + 0.35 + i * 0.13, 1.09 + h / 2, wz + 0.08], fpGroup, { outline: 0.008, shadow: false });
  }
  // 유리 너머 따뜻한 실내 + 블라인드
  const blinds = (rows) => canvasTex(256, 256, (g, w, h) => {
    const grd = g.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, "#d9c7cf"); grd.addColorStop(1, "#b99aa8");
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
    // 안쪽 사람/조명 실루엣
    g.fillStyle = "rgba(60,40,60,.35)";
    g.beginPath(); g.ellipse(w * 0.62, h * 0.82, 26, 40, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(w * 0.62, h * 0.6, 16, 0, Math.PI * 2); g.fill();
    g.fillStyle = "rgba(80,150,200,.55)"; g.fillRect(w * 0.2, h * 0.45, 70, 40);
    g.fillStyle = "rgba(255,210,150,.8)"; g.beginPath(); g.arc(w * 0.82, h * 0.18, 12, 0, Math.PI * 2); g.fill();
    g.fillStyle = "rgba(255,255,255,.38)";
    for (let y = 0; y < h; y += h / rows) g.fillRect(0, y, w, h / rows * 0.55);
  });
  nightGlow.windows.push(mk(new THREE.PlaneGeometry(winW - 0.1, 1.15), flat(blinds(26)), [wx, 1.72, wz], fpGroup, no).material);
  nightGlow.windows.push(mk(new THREE.PlaneGeometry(winW - 0.1, 0.5), flat(blinds(12)), [wx, 2.55, wz], fpGroup, no).material);
  // 창틀 (흰색)
  
  mk(box(winW, 0.07, 0.06), white, [wx, 2.3, zO + 0.03], fpGroup, ol);
  mk(box(0.07, opTop, 0.06), white, [opL + winW, opTop / 2, zO + 0.03], fpGroup, ol);
  // 유리 반사
  const shine = new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.22, depthWrite: false });
  mk(box(0.12, 1.0, 0.005), shine, [wx - winW * 0.25, 1.72, zO + 0.04], fpGroup, no).rotation.z = 0.5;

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

  // ── 문에 거는 팻말
  const openSign = canvasTex(256, 160, (g, w, h) => {
    g.fillStyle = "#f7efe2"; g.fillRect(0, 0, w, h);
    g.strokeStyle = "#2b2522"; g.lineWidth = 6; g.strokeRect(3, 3, w - 6, h - 6);
    g.fillStyle = "#c8392b"; g.font = "800 30px sans-serif"; g.textAlign = "center"; g.fillText(F.doorSign?.[0] ?? "COME IN  we're", w / 2, 50);
    g.fillStyle = "#2b2522"; g.font = "900 64px Georgia, serif"; g.fillText(F.doorSign?.[1] ?? "OPEN", w / 2, 122);
  });
  doorSign = mk(new THREE.PlaneGeometry(0.34, 0.21), flat(openSign), [0, 1.45, 0.03], doorPanels[0]?.g || fpGroup, no);

  // ── 오른쪽 기둥: 번지판 + 나무 명판
  const px = opR + 0.55;
  if (F.number) {
    const plate = canvasTex(256, 200, (g, w, h) => {
      g.fillStyle = "#1f4fa3"; g.beginPath(); g.roundRect(4, 4, w - 8, h - 8, 26); g.fill();
      g.strokeStyle = "#fff"; g.lineWidth = 5; g.beginPath(); g.roundRect(12, 12, w - 24, h - 24, 20); g.stroke();
      g.fillStyle = "#fff"; g.textAlign = "center";
      g.font = "700 26px sans-serif"; g.fillText(F.street || "", w / 2, 58);
      g.font = "800 96px sans-serif"; g.fillText(F.number, w / 2, 160);
    });
    mk(new THREE.PlaneGeometry(0.42, 0.33), flat(plate), [px, 2.25, zO + 0.04], fpGroup, no);
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
  const ground = mk(new THREE.CircleGeometry(45, 48), LINE ? "#9a98ab" : "#3b3b3d", [R.w / 2, -0.125, R.d / 2], fpGroup, no);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  mk(box(FRONT_X1 - FRONT_X0 + 6, 0.12, 1.3), LINE ? "#d6d0de" : "#8e8a85", [(FRONT_X0 + FRONT_X1) / 2 + 2.5, -0.07, R.d + T + 0.65], fpGroup, ol).receiveShadow = true;
  mk(box(R.w + 8, 0.05, 1.0), LINE ? "#b8b2c4" : "#6b5a58", [R.w / 2, -0.1, R.d + T + 1.8], fpGroup, no).receiveShadow = true;
  mk(box(R.w + 8, 0.01, 0.12), "#d9b84a", [R.w / 2, -0.07, R.d + T + 2.6], fpGroup, no);

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
  mk(box(4, top - 0.4, 3), "#cfc9bf", [nx0 + 2, (top - 0.4) / 2, R.d - 1.5 + T], fpGroup, ol);
  mk(box(2.6, 2.5, 0.05), "#ecebe6", [nx0 + 1.6, 1.25, R.d + T + 0.02], fpGroup, ol);
  for (let y = 0.15; y < 2.5; y += 0.18) mk(box(2.6, 0.012, 0.06), "#cfcdc6", [nx0 + 1.6, y, R.d + T + 0.03], fpGroup, no);
  mk(box(3.0, 0.08, 0.6), "#55595e", [nx0 + 1.6, 2.65, R.d + T + 0.3], fpGroup, ol);

  // ── 화분들 (고무나무 + 측백나무)
  makeRubberPlant(fpGroup, opL + 0.35, R.d + T + 0.35);
  for (const [dx, dz, k] of [[0.95, 0.4, 0.9], [1.55, 0.95, 1.0], [2.15, 0.95, 0.95], [winW + door.w + 0.35, 0.45, 0.95]]) makeCypress(fpGroup, opL + dx, R.d + T + dz, k);

  // ── 고래꼬리 조명 상자
  const lx = opR + 0.15, lz = R.d + T + 1.15;
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
  const pool = nightGlow.pool = mk(new THREE.CircleGeometry(0.9, 32), new THREE.MeshBasicMaterial({ color: "#ff9fb0", transparent: true, opacity: 0.22, depthWrite: false }), [0, 0.005, 0], lantern, no);
  pool.rotation.x = -Math.PI / 2;
  addHalo(lantern, 0, 0.62, 0, 1.3, "#ffb98f");
  addHalo(fpGroup, wx, 1.4, zO + 0.3, 2.6, "#ff9f5a");
  const lampLight = new THREE.PointLight("#ffb3c0", 3, 4, 1.6);
  lampLight.position.set(0, 0.7, 0.2);
  lantern.add(lampLight);
  const winLight = new THREE.PointLight("#ff9a5c", 1.2, 3, 1.6);
  winLight.position.set(wx, 0.7, zO + 0.9);
  fpGroup.add(winLight);

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
const IN_NIGHT = new THREE.Color("#94705f"), IN_DUSK = new THREE.Color("#f6c2a4");
const tmpIn = new THREE.Color();
const tmpC = new THREE.Color();
let lastTint = -1;
function applyTime(outside, time) {
  const k = timeK; // 바깥 하늘/건물 색은 시간 기준 (밖에 있을 때만 보임)
  const phase = k < 0.15 ? "day" : k < 0.75 ? "dusk" : "night";
  const root = document.documentElement.classList;
  for (const p of ["day", "dusk", "night"]) root.toggle(`sky-${p}`, p === phase);
  updateStreetViews(phase);
  const key = k + outside * 10;
  if (Math.abs(key - lastTint) > 0.005) {
    lastTint = key;
    // 바깥: 낮 → 노을(분홍빛) → 밤(푸르고 어둡게) / 안: 밤에 은은한 분홍빛
    if (k < 0.5) tmpC.copy(WHITE).lerp(DUSK_TINT, k / 0.5);
    else tmpC.copy(DUSK_TINT).lerp(NIGHT_TINT, (k - 0.5) / 0.5);
    if (k < 0.5) tmpIn.copy(WHITE).lerp(IN_DUSK, k / 0.5);
    else tmpIn.copy(IN_DUSK).lerp(IN_NIGHT, (k - 0.5) / 0.5);
    tmpIn.lerp(tmpC, outside);
    const gk = THREE.MathUtils.smoothstep(k, 0.3, 1);
    for (const m of tintables) {
      m.color.copy(m.userData.base).multiply(tmpIn);
      if (m.userData.extraDark) m.color.multiplyScalar(1 - m.userData.extraDark * gk * (1 - outside));
    }
  }
  const glow = THREE.MathUtils.smoothstep(k, 0.3, 1);
  for (const h of nightGlow.halos) h.material.opacity = h.userData.inner ? 0.08 + glow * 0.42 : glow * 0.38;
  for (const m of nightGlow.windows) m.color.copy(WHITE).lerp(WIN_NIGHT, glow * 0.85);
  for (const [m, lo, hi] of innerGlows) m.opacity = lo + (hi - lo) * glow;
  const dayAmt = 1 - THREE.MathUtils.smoothstep(k, 0.2, 0.7);
  const duskAmt = Math.max(0, 1 - Math.abs(k - 0.45) / 0.3);
  for (const m of sunPatches) {
    m.color.copy(SUN_DAY).lerp(SUN_DUSK, duskAmt / (dayAmt + duskAmt + 1e-6));
    m.opacity = 0.22 * dayAmt + 0.42 * duskAmt;
  }
  for (const s of nightGlow.sky) {
    const tw = s.userData.tw != null ? 0.6 + 0.4 * Math.sin(time * 2 + s.userData.tw) : 1;
    s.material.opacity = glow * tw;
  }
  if (nightGlow.strip) nightGlow.strip.material.opacity = 0.3 + glow * 0.25;
  if (nightGlow.pool) nightGlow.pool.material.opacity = 0.15 + glow * 0.18;
  if (nightGlow.lit) nightGlow.lit.material.opacity = glow * 0.55;
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
let doorSign = null;

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
  const mat = new THREE.MeshBasicMaterial({ map: poolTex, color, transparent: true, opacity: lo, depthWrite: false, blending: THREE.AdditiveBlending });
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
const ledTex = canvasTex(4, 64, (g, w, h) => {
  const grd = g.createLinearGradient(0, 0, 0, h);
  grd.addColorStop(0, "rgba(255,170,100,1)"); grd.addColorStop(0.25, "rgba(255,140,80,.65)"); grd.addColorStop(1, "rgba(255,120,70,0)");
  g.fillStyle = grd; g.fillRect(0, 0, w, h);
});

/** 곡선 바 + 바 의자 */
function buildCurvedBar(b) {
  const curve = roundedPath(b.path, b.radius ?? 1.0);
  const S = pathSamples(curve, 0.15);
  // 몸통 (주황빛 원목) + 상판 (짙은 원목, 손님 쪽으로 튀어나옴)
  const bh = (b.depth ?? 0.44) / 2; // 몸통 두께의 절반
  ribbon(S, bh, 0.98, 0, b.body || "#b8693d", roomGroup, 0.012);
  ribbon(S, bh + 0.1, 0.06, 0.98, b.top || "#6e4127", roomGroup, 0.018, 0.08);
  // LED: 상판 아래로 은은하게
  const led = new THREE.MeshBasicMaterial({ map: ledTex, transparent: true, side: THREE.DoubleSide, depthWrite: false, opacity: 0.6 });
  stripAlong(S, bh + 0.006, 0.02, 0.96, led, roomGroup);
  innerGlows.push([led, 0.45, 0.95]);
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
function buildBackbar(p) {
  const curve = roundedPath(p.path, 0.25);
  const S = pathSamples(curve, 0.15);
  ribbon(S, (p.d ?? 0.45) / 2, p.h ?? 0.95, 0, p.color || "#5a3a2b", roomGroup, 0.015);
  ribbon(S, (p.d ?? 0.45) / 2 + 0.02, 0.04, p.h ?? 0.95, "#3e2a20", roomGroup, 0.01);
  // 술병들 (군데군데 모아서)
  const cols = ["#7a3b2e", "#c9a54a", "#3f6b4a", "#e9e2c8", "#8a5a2b", "#2e3f5c", "#b8432f", "#d9c27a", "#f1efe4"];
  let seed = 5;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const L = curve.getLength(), y = (p.h ?? 0.95) + 0.04;
  for (let s = 0.2; s < L - 0.2; s += 0.13) {
    if (Math.floor(s / 1.1) % 3 === 2) continue; // 빈 칸
    const q = curve.getPointAt(s / L), t = curve.getTangentAt(s / L);
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
        lightPool(g, 0, 1.047, 0, len + 0.5, 0.75, "#ffb065", 0.15, 0.75); // 바 상판 위 길쭉한 불빛
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
            yaw.rotation.y = (i / n) * Math.PI * 2 + s * 0.8;
            g.add(yaw);
            const col = i % 2 ? "#3f8a4f" : "#5aa65a";
            const up = new THREE.Group(); up.rotation.x = 0.55 + (i % 3) * 0.15; yaw.add(up); // 위로 뻗다가
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
      } else { // 홍콩야자 (나무 모양)
        mk(cyl(0.03, 0.045, k - 0.5, 6), "#7a5a3a", [0, 0.5 + (k - 0.5) / 2, 0], g, { outline: 0.006 });
        for (const [x, y, z, r] of [[0, k, 0, 0.32], [0.25, k - 0.25, 0.05, 0.26], [-0.22, k - 0.35, -0.05, 0.27], [0.05, k - 0.55, 0.2, 0.22], [-0.05, k + 0.25, 0.05, 0.22]]) {
          mk(new THREE.SphereGeometry(r, 12, 10), leafMat(r > 0.25 ? "#3d7a45" : "#4f9150"), [x, y, z], g, { outline: 0.015 });
        }
      }
      addObstacle(p.x, p.z, 0.28, 0.28);
      g.userData.hit = [0.7, k + 0.3, 0.7, (k + 0.3) / 2]; g.userData.sayY = k + 0.45;
      if (g.children.length) g.userData.wiggler = g;
      return true;
    }
    case "tvshelf": { // 안쪽 벽 TV 장식장 (짙은 원목, 칸칸이 소품)
      if (p.standOnly) { // 장식장 없이 스크린 크기에 맞는 스탠드만 (전자칠판 이동식 거치대)
        const tw = p.tvW ?? 2.35, ty = p.tvY ?? 1.55, th = p.tvH ?? 1.32, dark = "#2a2522";
        for (const sx of [-1, 1]) {
          const x = sx * (tw / 2 - 0.25);
          mk(box(0.06, ty - th / 2 + 0.1, 0.06), dark, [x, (ty - th / 2 + 0.1) / 2, 0.08], g, { outline: 0.006 });
          mk(box(0.08, 0.04, 0.6), dark, [x, 0.02, 0.12], g, { outline: 0.006 }); // 발
        }
        mk(box(tw - 0.4, 0.05, 0.05), dark, [0, 0.35, 0.08], g, { outline: 0.005 });
        addObstacle(p.x, (p.z || 0) + 0.12, tw / 2, 0.3);
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
      // 옷걸이 (빈 것 2개)
      for (const hx of [-0.3, -0.12]) {
        const hg = new THREE.Group(); hg.position.set(hx, top - 0.02, 0); g.add(hg);
        mk(cyl(0.006, 0.006, 0.06, 4), "#cfcfd4", [0, -0.03, 0], hg, { outline: 0, shadow: false });
        mk(box(0.32, 0.02, 0.02), "#d9b48a", [0, -0.12, 0], hg, { outline: 0.004 }).rotation.z = 0.0;
      }
      // 검은 패딩
      const pad = mk(new THREE.CapsuleGeometry(0.16, 0.32, 6, 12), "#2a2b30", [0.1, top - 0.36, 0.02], g, { outline: 0.012 });
      pad.scale.set(1.1, 1, 0.65);
      for (let i = 0; i < 3; i++) mk(new THREE.TorusGeometry(0.17, 0.012, 5, 20), "#1d1e22", [0.1, top - 0.22 - i * 0.12, 0.02], g, { outline: 0 }).rotation.x = Math.PI / 2;
      // 긴 회색 코트 (털 칼라)
      mk(box(0.32, 1.05, 0.14), "#bdbcb6", [0.33, top - 0.58, 0.04], g, { outline: 0.012 });
      mk(box(0.26, 0.12, 0.16), "#e4e0d6", [0.33, top - 0.1, 0.05], g, { outline: 0.008 });
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
    case "coffee": { // 에스프레소 머신 + 그라인더 (김)
      const y0 = p.y0 ?? 0.99;
      mk(box(0.55, 0.42, 0.42), "#2e2e33", [0, y0 + 0.21, 0], g, { outline: 0.012 });
      mk(box(0.5, 0.05, 0.12), "#c9c9cf", [0, y0 + 0.3, 0.24], g, { outline: 0.006 });
      mk(cyl(0.07, 0.09, 0.3, 12), "#1f1f22", [0.42, y0 + 0.15, 0], g, { outline: 0.008 });
      mk(cyl(0.09, 0.06, 0.16, 12), glowMat("#c9b8a0", 0.6), [0.42, y0 + 0.38, 0], g, { outline: 0.006 });
      steamSources.push(new THREE.Vector3(p.x, y0 + 0.5, p.z));
      g.userData.hit = [0.9, 0.7, 0.6, y0 + 0.3]; g.userData.sayY = y0 + 0.75;
      return true;
    }
    case "door": { // 안 쓰는 출입문 (유리 벽 안쪽에 문틀 + 손잡이)
      const w = p.w ?? 1.0, h = p.h ?? 2.2, frame = "#f4f1ec";
      // 문틀은 유리 바깥쪽(블라인드 뒤)에 → 안에서는 블라인드 틈으로 살짝만 보임
      const oz = 0.1;
      for (const sx of [-1, 1]) mk(box(0.05, h, 0.05), frame, [sx * w / 2, h / 2, oz], g, { outline: 0.006, shadow: false });
      mk(box(w + 0.05, 0.05, 0.05), frame, [0, h, oz], g, { outline: 0.006, shadow: false });
      mk(box(0.025, 0.3, 0.03), "#b9a26e", [w / 2 - 0.1, 1.05, oz + 0.04], g, { outline: 0.004, shadow: false }); // 바깥 손잡이
      g.userData.hit = [w, h, 0.3, h / 2]; g.userData.sayY = h + 0.15;
      return true;
    }
    case "sidetable": { // 나무 스툴 위 소품 (반죽기 / 가습기)
      const wood = "#a8784a", ty = 0.5;
      mk(box(0.42, 0.04, 0.4), wood, [0, ty, 0], g, { outline: 0.01 });
      for (const [lx, lz] of [[-0.17, -0.16], [0.17, -0.16], [-0.17, 0.16], [0.17, 0.16]]) mk(box(0.035, ty, 0.035), wood, [lx, ty / 2, lz], g, { outline: 0.006 });
      mk(box(0.36, 0.025, 0.025), wood, [0, 0.16, 0.16], g, { outline: 0.004 });
      const top = ty + 0.02, white = "#f1eeea";
      if (p.item === "mixer") { // 반죽기
        // 받침 → 뒤쪽 기둥 → 앞으로 나온 둥근 머리 → 그 아래 은색 그릇
        const base = mk(cyl(0.13, 0.15, 0.04, 20), white, [0, top + 0.02, 0.02], g, { outline: 0.008 });
        base.scale.set(1, 1, 1.3);
        mk(cyl(0.055, 0.065, 0.3, 14), white, [0, top + 0.19, -0.13], g, { outline: 0.008 });
        const head = mk(new THREE.CapsuleGeometry(0.075, 0.24, 6, 14), white, [0, top + 0.39, -0.02], g, { outline: 0.01 });
        head.rotation.x = Math.PI / 2;
        mk(new THREE.SphereGeometry(0.02, 8, 6), "#c8392b", [0.075, top + 0.39, -0.12], g, { outline: 0, shadow: false });
        const bowl = new THREE.LatheGeometry([[0.03, 0], [0.09, 0.02], [0.11, 0.08], [0.115, 0.15], [0.105, 0.15]].map(([r, y]) => new THREE.Vector2(r, y)), 20);
        mk(bowl, toon("#c3c7cd", { side: THREE.DoubleSide }), [0, top + 0.05, 0.05], g, { outline: 0, shadow: false });
        mk(new THREE.TorusGeometry(0.112, 0.006, 5, 20), "#2b2522", [0, top + 0.2, 0.05], g, { outline: 0, shadow: false }).rotation.x = Math.PI / 2;
        mk(cyl(0.01, 0.01, 0.1, 6), "#8a8f96", [0, top + 0.28, 0.05], g, { outline: 0, shadow: false });
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
    case "bartender": { // 바텐더 (50대, 날카로운 인상, 흰 셔츠 + 검정 나비넥타이, 넘긴 긴 머리, 뿔테 안경)
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
      // 넘긴 머리 (이마가 넓게 드러남) + 흰머리 섞임
      const cap = mk(new THREE.SphereGeometry(0.168, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.5), hair, [0, 0.05, -0.04], head, { outline: 0 });
      cap.rotation.x = -0.6; cap.scale.set(0.95, 1.1, 1);
      for (const sx of [-0.06, 0.04]) mk(box(0.012, 0.01, 0.16), "#8e8a86", [sx, 0.19, -0.04], head, { outline: 0, shadow: false }).rotation.x = -0.4;
      const tail = mk(new THREE.CapsuleGeometry(0.07, 0.3, 6, 10), hair, [0, -0.17, -0.15], head, { outline: 0.012 });
      tail.rotation.x = 0.25;
      for (const sx of [-1, 1]) {
        const side = mk(new THREE.CapsuleGeometry(0.03, 0.18, 4, 8), hair, [sx * 0.12, -0.06, -0.1], head, { outline: 0.008 }); // 귀 뒤로 넘긴 머리
        side.rotation.z = sx * 0.2;
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
      addObstacle(p.x, p.z, 0.22, 0.22);
      g.userData.hit = [0.6, 1.8, 0.6, 0.9]; g.userData.sayY = 2.0;
      bartenders.push(g);
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

  // 빈자리 위에 뜨는 "빈자리" 표시 (사람이 앉으면 사라짐)
  const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: emptyTagTex, transparent: true, depthWrite: false }));
  tag.center.set(0.5, 0);
  tag.position.y = kind === "stool" || kind === "barstool" ? 1.2 : 0.95;
  tag.renderOrder = 5;
  g.add(tag);

  const hb = new THREE.Mesh(box(0.6, 1.4, 0.6), hitMat);
  hb.position.y = 0.7;
  hb.userData.seatId = id;
  hb.castShadow = false;
  g.add(hb);
  hitboxes.push(hb);

  seats.set(id, { id, group: g, cushion, guest, tag, tagY: tag.position.y, occupied: false, anim: 0, target: 0, bump: 0 });
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
      lightPool(g, lx, H + 0.03, lz, 1.1, 1.1, "#ffb36b", 0.1, 0.6);
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
    else if (cfg.wall === "right") { g.position.set(R.w - 0.06, cfg.y, cfg.z); g.rotation.y = -Math.PI / 2; }
    else { g.position.set(0.06, cfg.y, cfg.z); g.rotation.y = Math.PI / 2; }
    parent.add(g);
    mk(box(cfg.w + 0.12, cfg.h + 0.12, 0.06), "#2b2b31", [0, 0, 0.03], g, { outline: 0.015, shadow: false });
    const face = mk(new THREE.PlaneGeometry(cfg.w, cfg.h), new THREE.MeshBasicMaterial({ map: tex }), [0, 0, 0.062], g, { outline: 0, shadow: false });
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
    setOccupiedVisual(s, occ);
  }
  renderSummary();
}

function setOccupiedVisual(s, occ) {
  if (s.occupied === occ) return;
  s.occupied = occ;
  s.target = occ ? 1 : 0;
  s.bump = 1;
  if (!LINE) s.cushion.material.color.set(occ ? COLOR.busy : COLOR.empty);
  if (occ) s.guest.visible = true;
}

function renderSummary() {
  const total = seats.size;
  const empty = [...seats.values()].filter((s) => !s.occupied).length;
  const n = $("nEmpty");
  n.textContent = empty;
  n.classList.toggle("zero", empty === 0);
  $("nTotal").textContent = `/ ${total} 석`;
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
function startPolling() {
  clearInterval(pollTimer);
  poll();
  pollTimer = setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
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
    $("login").classList.remove("show");
    document.body.classList.add("admin");
    loadStats();
    $("pw").value = "";
  } catch (err) {
    token = null;
    $("loginErr").textContent = err.message;
  }
});
$("logoutBtn").addEventListener("click", () => { logout(); location.href = "/"; });
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
  const hit = pick(ev, [...interactives, ...hitboxes]);
  if (!hit) return;
  const u = hit.object.userData;
  if (u.kind === "screen") tapScreen(u.scr);
  else if (u.kind === "prop") tapProp(u);
  else if (u.seatId) tapSeat(seats.get(u.seatId));
}

function tapProp(u) {
  u.wiggle = 1;
  u.onTap?.();
  const p = u.prop;
  popBubble(p.say, p.x, u.sayY ?? SAY_HEIGHT[p.type] ?? 1.5, p.z);
  if (!found.has(u.idx)) {
    found.add(u.idx);
    store.set("seat-found", JSON.stringify([...found]));
    const n = [...found].filter((i) => i < sayProps.length).length, total = sayProps.length;
    setTimeout(() => toast(n >= total ? `구경 완료!\n숨은 이야기 ${total}개를 모두 찾았어요` : `새로운 발견 ${n} / ${total}`, 1800), 900);
  }
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
};
const walkFov = () => (camera.aspect < 1 ? 78 : 64);

function collide(p) {
  // 벽 안쪽으로 (볼록한 방이라 각 벽에서 밀어내면 됨)
  for (const e of EDGES) {
    const d = (p.x - e.ax) * e.nx + (p.z - e.az) * e.nz;
    if (d < PR) { p.x += e.nx * (PR - d); p.z += e.nz * (PR - d); }
  }
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
  camera.position.set(midX, EYE, R.d + 7.2);
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
      showWalkHint();
    });
  });
}

function exitWalk() {
  if (!walk.on) return;
  walk.on = false;
  walk.look = null;
  walk.keys.clear();
  setAim(null);
  fpGroup.visible = false;
  document.body.classList.remove("walking");
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
  const speed = (k.has("shift") ? 2.6 : 1.5) * dt;
  const sy = Math.sin(walk.yaw), cy = Math.cos(walk.yaw);
  walk.pos.x += (-sy * f + cy * r) * speed;
  walk.pos.z += (-cy * f - sy * r) * speed;
  collide(walk.pos);

  const moving = Math.min(1, Math.hypot(f, r));
  walk.bob += dt * 9 * moving;
  camera.position.set(walk.pos.x, EYE + Math.sin(walk.bob) * 0.025 * moving, walk.pos.z);
  camera.rotation.set(walk.pitch, walk.yaw, Math.sin(walk.bob * 0.5) * 0.004 * moving);

  if (++walk.frame % 4 === 0) {
    ray.setFromCamera(ndc.set(0, 0), camera);
    ray.far = 4.5;
    const hit = ray.intersectObjects(hitboxes, false)[0];
    ray.far = Infinity;
    setAim(hit?.object.userData.seatId || null);
    drawMinimap();
    // 가까이 가면 손님이 손 흔들어 줌
    if (walk.frame % 20 === 0) {
      for (const s of seats.values()) {
        if (s.occupied && Math.hypot(s.group.position.x - walk.pos.x, s.group.position.z - walk.pos.z) < 1.7) waveGuest(s, false);
      }
    }
  }
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
  if (new URLSearchParams(location.search).has("debug")) window.__walk = walk; // 확인용
  $("walkBtn").addEventListener("click", enterWalk);
  $("mapBtn").addEventListener("click", exitWalk);
  $("enterBtn").addEventListener("click", () => {
    enterStore();
    screens.forEach((scr) => scr.media[scr.idx]?.play?.().catch(() => {})); // 영상은 사용자 터치 후 재생 가능
  });

  addEventListener("keydown", (e) => {
    if (!walk.on || e.target.closest?.("input, textarea")) return;
    const key = e.key.toLowerCase();
    if (key === "escape") return exitWalk();
    if ((key === "e" || key === "enter" || key === " ") && walk.aimId && document.body.classList.contains("admin")) {
      e.preventDefault();
      toggleSeat(walk.aimId).then(() => setAim(walk.aimId));
      return;
    }
    walk.keys.add(key);
    if (key.startsWith("arrow") || key === " ") e.preventDefault();
  });
  addEventListener("keyup", (e) => walk.keys.delete(e.key.toLowerCase()));
  addEventListener("blur", () => walk.keys.clear());

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
    const show = 1 - Math.min(1, s.anim * 2);
    s.tag.visible = show > 0.01;
    if (s.tag.visible) {
      const k = 0.34 * show;
      s.tag.scale.set(k, k * 150 / 256, 1);
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
const bartenders = []; // 숨 쉬듯 살짝 움직이는 바텐더
let steamT = 0;
const steamGeo = new THREE.SphereGeometry(0.05, 8, 6);
const DAY = { sky: new THREE.Color("#fff6ea"), ground: new THREE.Color("#c9a88a") };
const NIGHT = { sky: new THREE.Color("#7f8db5"), ground: new THREE.Color("#3a3140") };
function updateWorld(dt, time) {
  // 밖(가게 앞)은 밤, 안으로 들어가면 밝게
  const night = fpGroup.visible ? THREE.MathUtils.clamp((camera.position.z - (R.d + 0.4)) / 1.6, 0, 1) : 0;
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
    for (const p of doorPanels) p.g.position.x = p.x0 + p.dir * p.half * 0.92 * doorOpen;
  }
  for (const l of labelSprites) l.visible = !fpGroup.visible; // 1인칭에선 번호표 숨김
  for (const b of bartenders) {
    b.userData.bt.position.y = Math.sin(time * 1.6) * 0.008;
    b.userData.btHead.rotation.y = Math.sin(time * 0.5) * 0.35;
    b.userData.btHead.rotation.z = Math.sin(time * 0.8) * 0.04;
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
    tintCollect = false;

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
    else if (q.has("walk")) setTimeout(enterWalk, 400);
    renderer.setAnimationLoop(tick);
  } else {
    buildTablesHeadless();
  }

  renderSummary();
  if (IS_ADMIN) {
    if (token) {
      try { await api("/api/login"); document.body.classList.add("admin"); loadStats(); }
      catch (e) { showLogin(e.message); }
    } else showLogin();
  }
  startPolling();
  if (IS_ADMIN) {
    setInterval(() => { if (document.body.classList.contains("admin")) loadStats(); }, 60000);
    $("stats").addEventListener("click", () => {
      if (statsDays.length) toast(statsDays.map((d) => `${d.day.slice(5)}  ${d.visits}명 · 평균 ${fmtDur(d.avgMs)}${d.adTaps ? ` · 광고 ${d.adTaps}` : ""}`).join("\n"), 5000);
    });
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
