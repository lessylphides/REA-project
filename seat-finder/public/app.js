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

function buildRoom() {
  const floorMat = toon("#ffffff", { unique: true, map: plankTexture() });
  const floor = mk(box(R.w, 0.12, R.d), floorMat, [R.w / 2, -0.06, R.d / 2], roomGroup, { outline: 0.04, shadow: false });
  floor.receiveShadow = true;

  const T = 0.14; // 벽 두께
  const wallMat = R.wall;
  // 안쪽 벽(back, z=0) / 왼쪽 벽(left, x=0) 은 높게, 앞/오른쪽은 낮게 (인형집처럼 잘라서 보기)
  const wallSeg = (axis, from, to, h, fixed) => {
    const len = to - from;
    if (len <= 0.01) return;
    if (axis === "x") mk(box(len, h, T), wallMat, [from + len / 2, h / 2, fixed], roomGroup, { outline: 0.02 });
    else mk(box(T, h, len), wallMat, [fixed, h / 2, from + len / 2], roomGroup, { outline: 0.02 });
  };
  const accent = (axis, len, fixed) => {
    if (axis === "x") mk(box(len, 0.9, T + 0.02), R.accent, [len / 2, 0.45, fixed], roomGroup, { outline: 0 });
    else mk(box(T + 0.02, 0.9, len), R.accent, [fixed, 0.45, len / 2], roomGroup, { outline: 0 });
  };

  wallSeg("x", -T / 2, R.w + T / 2, R.wallH, -T / 2);
  wallSeg("z", 0, R.d + T / 2, R.wallH, -T / 2);
  accent("x", R.w, -T / 2 + 0.01);
  accent("z", R.d, -T / 2 + 0.01);

  // 창문
  const glass = toon("#bfe3f2", { transparent: true, opacity: 0.85 });
  for (const w of LAYOUT.windows || []) {
    const y = 1.6, h = 1.2;
    if (w.wall === "back") {
      mk(box(w.w + 0.16, h + 0.16, 0.06), "#ffffff", [w.x, y, 0.02], roomGroup);
      mk(box(w.w, h, 0.03), glass, [w.x, y, 0.06], roomGroup, { outline: 0, shadow: false });
      mk(box(0.05, h, 0.04), "#ffffff", [w.x, y, 0.08], roomGroup, { outline: 0 });
      mk(box(w.w + 0.3, 0.06, 0.18), "#ffffff", [w.x, y - h / 2 - 0.05, 0.1], roomGroup);
    } else if (w.wall === "left") {
      mk(box(0.06, h + 0.16, w.w + 0.16), "#ffffff", [0.02, y, w.z], roomGroup);
      mk(box(0.03, h, w.w), glass, [0.06, y, w.z], roomGroup, { outline: 0, shadow: false });
      mk(box(0.04, h, 0.05), "#ffffff", [0.08, y, w.z], roomGroup, { outline: 0 });
      mk(box(0.18, 0.06, w.w + 0.3), "#ffffff", [0.1, y - h / 2 - 0.05, w.z], roomGroup);
    }
  }

  // 앞/오른쪽 낮은 벽 (문 자리는 비움)
  const low = 0.35;
  const door = LAYOUT.door;
  if (door?.wall === "front") {
    wallSeg("x", -T / 2, door.x - door.w / 2, low, R.d + T / 2);
    wallSeg("x", door.x + door.w / 2, R.w + T / 2, low, R.d + T / 2);
    mk(box(door.w * 0.9, 0.02, 0.6), "#7a6152", [door.x, 0.01, R.d - 0.35], roomGroup, { outline: 0 });
    const s = textSprite("입구", { size: 0.3, bg: "rgba(59,47,42,.85)", fg: "#fff" });
    s.position.set(door.x, 0.55, R.d + 0.2);
    roomGroup.add(s);
    labelSprites.push(s);
  } else {
    wallSeg("x", -T / 2, R.w + T / 2, low, R.d + T / 2);
  }
  wallSeg("z", -T / 2, R.d + T / 2, low, R.w + T / 2);
  buildInsideShell(T);
}

/** 1인칭용: 앞/오른쪽 벽을 천장까지 + 천장 + 유리문 (위에서 볼 땐 숨김) */
function buildInsideShell(T) {
  const H = R.wallH, o = { outline: 0.02, shadow: false };
  const zF = R.d + T / 2, xR = R.w + T / 2;
  const door = LAYOUT.door?.wall === "front" ? LAYOUT.door : null;
  const front = (x0, x1, y0, y1) => {
    if (x1 - x0 > 0.01) mk(box(x1 - x0, y1 - y0, T), R.wall, [(x0 + x1) / 2, (y0 + y1) / 2, zF], fpGroup, o);
  };
  if (door) {
    const dh = 2.2;
    front(-T / 2, door.x - door.w / 2, 0, H);
    front(door.x + door.w / 2, R.w + T / 2, 0, H);
    front(door.x - door.w / 2, door.x + door.w / 2, dh, H);
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
    tintCollect = true;
    buildStorefront(T, door, dh);
    tintCollect = false;
  } else front(-T / 2, R.w + T / 2, 0, H);
  mk(box(T, H, R.d + T), R.wall, [xR, H / 2, R.d / 2], fpGroup, o);
  mk(box(R.w, 0.9, 0.02), R.accent, [R.w / 2, 0.45, R.d + 0.01], fpGroup, { outline: 0, shadow: false });
  mk(box(0.02, 0.9, R.d), R.accent, [R.w - 0.01, 0.45, R.d / 2], fpGroup, { outline: 0, shadow: false });
  // 천장(조명 영향 없이 밝게) + 나무 들보
  mk(box(R.w + T * 2, 0.08, R.d + T * 2), new THREE.MeshBasicMaterial({ color: "#f8efe2" }), [R.w / 2, H + 0.04, R.d / 2], fpGroup, { outline: 0, shadow: false });
  const beam = new THREE.MeshBasicMaterial({ color: "#d8b48e" });
  for (let x = 2; x < R.w; x += 3) mk(box(0.18, 0.14, R.d), beam, [x, H - 0.07, R.d / 2], fpGroup, { outline: 0.015, shadow: false });
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
  wallPart(-T, opL - 0.1, 0, top);
  wallPart(opR + 0.1, R.w + T, 0, top);
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
  mk(new THREE.PlaneGeometry(winW - 0.08, 0.92), flat(panel), [wx, 0.12 + 0.46, wz], fpGroup, no);
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
  mk(new THREE.PlaneGeometry(winW - 0.1, 1.15), flat(blinds(26)), [wx, 1.72, wz], fpGroup, no);
  mk(new THREE.PlaneGeometry(winW - 0.1, 0.5), flat(blinds(12)), [wx, 2.55, wz], fpGroup, no);
  // 창틀 (흰색)
  
  mk(box(winW, 0.07, 0.06), white, [wx, 2.3, zO + 0.03], fpGroup, ol);
  mk(box(0.07, opTop, 0.06), white, [opL + winW, opTop / 2, zO + 0.03], fpGroup, ol);
  // 유리 반사
  const shine = new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.22, depthWrite: false });
  mk(box(0.12, 1.0, 0.005), shine, [wx - winW * 0.25, 1.72, zO + 0.04], fpGroup, no).rotation.z = 0.5;

  // ── 문 위: 작은 창 + 환풍기
  mk(box(door.w + 0.1, 0.06, 0.06), white, [door.x, dh + 0.02, zO + 0.03], fpGroup, ol);
  mk(new THREE.PlaneGeometry(door.w * 0.55, 0.42), flat(blinds(6)), [door.x - door.w * 0.2, dh + 0.33, wz], fpGroup, no);
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
  mk(box(R.w + 8, 0.12, 1.3), LINE ? "#d6d0de" : "#8e8a85", [R.w / 2, -0.07, R.d + T + 0.65], fpGroup, ol).receiveShadow = true;
  mk(box(R.w + 8, 0.05, 1.0), LINE ? "#b8b2c4" : "#6b5a58", [R.w / 2, -0.1, R.d + T + 1.8], fpGroup, no).receiveShadow = true;
  mk(box(R.w + 8, 0.01, 0.12), "#d9b84a", [R.w / 2, -0.07, R.d + T + 2.6], fpGroup, no);

  // ── 2층 창문 (흰 창틀, 어두운 유리)
  const upW = Math.min(4.2, (opR - opL) * 1.15);
  mk(box(upW + 0.16, upH, 0.08), white, [(opL + opR) / 2, upY, zO + 0.02], fpGroup, ol);
  mk(box(upW, upH - 0.16, 0.06), toon(LINE ? "#bfe0f2" : "#2a3550"), [(opL + opR) / 2, upY, zO + 0.05], fpGroup, no);
  mk(box(0.07, upH - 0.16, 0.08), white, [(opL + opR) / 2, upY, zO + 0.07], fpGroup, no);
  // 밤이 되면 2층 창에 따뜻한 불이 켜짐
  nightGlow.lit = mk(new THREE.PlaneGeometry(upW, upH - 0.16), new THREE.MeshBasicMaterial({ color: "#ffd98a", transparent: true, opacity: 0, depthWrite: false }), [(opL + opR) / 2, upY, zO + 0.085], fpGroup, no);
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
  addHalo(lantern, 0, 0.62, 0, 1.6, "#ffc4d6");
  addHalo(fpGroup, wx, 1.6, zO + 0.3, 3.2, "#ffcf9a");
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
const nightGlow = { strip: null, pool: null, lit: null, halos: [], sky: [] };
const haloTex = canvasTex(128, 128, (g) => {
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, "rgba(255,255,255,.9)"); grd.addColorStop(0.35, "rgba(255,255,255,.35)"); grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
});
/** 밤에만 보이는 은은한 불빛 번짐 */
function addHalo(parent, x, y, z, size, color) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, color, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
  sp.position.set(x, y, z);
  sp.scale.set(size, size, 1);
  sp.renderOrder = 3;
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
const tmpC = new THREE.Color();
let lastTint = -1;
function applyTime(outside, time) {
  const k = timeK; // 바깥 하늘/건물 색은 시간 기준 (밖에 있을 때만 보임)
  const phase = k < 0.15 ? "day" : k < 0.75 ? "dusk" : "night";
  const root = document.documentElement.classList;
  for (const p of ["day", "dusk", "night"]) root.toggle(`sky-${p}`, p === phase);
  if (Math.abs(k - lastTint) > 0.005) {
    lastTint = k;
    // 낮 → 노을(분홍빛) → 밤(푸르고 어둡게)
    if (k < 0.5) tmpC.copy(WHITE).lerp(DUSK_TINT, k / 0.5);
    else tmpC.copy(DUSK_TINT).lerp(NIGHT_TINT, (k - 0.5) / 0.5);
    for (const m of tintables) m.color.copy(m.userData.base).multiply(tmpC);
  }
  const glow = THREE.MathUtils.smoothstep(k, 0.3, 1);
  for (const h of nightGlow.halos) h.material.opacity = glow * 0.85;
  for (const s of nightGlow.sky) {
    const tw = s.userData.tw != null ? 0.6 + 0.4 * Math.sin(time * 2 + s.userData.tw) : 1;
    s.material.opacity = glow * tw;
  }
  if (nightGlow.strip) nightGlow.strip.material.opacity = 0.35 + glow * 0.45;
  if (nightGlow.pool) nightGlow.pool.material.opacity = 0.22 + glow * 0.4;
  if (nightGlow.lit) nightGlow.lit.material.opacity = glow * 0.85;
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
    roomGroup.add(g);
    if (p.type === "counter") {
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
  if (kind === "stool") {
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
  tag.position.y = kind === "stool" ? 1.15 : 0.95;
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
    else addObstacle(t.x, t.z, t.w / 2, t.d / 2, t.rot);
    if (t.shape === "round") {
      mk(cyl(t.r, t.r, 0.05, 32), "#f1dcc2", [0, H, 0], g);
      mk(cyl(0.04, 0.04, H, 10), COLOR.woodDark, [0, H / 2, 0], g, { outline: 0.012 });
      mk(cyl(0.25, 0.28, 0.04, 20), COLOR.woodDark, [0, 0.02, 0], g);
      const dist = t.r + 0.32;
      for (let i = 0; i < t.seats; i++) {
        const a = (i / t.seats) * Math.PI * 2 + (t.seats === 2 ? 0 : Math.PI / t.seats);
        local.push([Math.sin(a) * dist, -Math.cos(a) * dist]);
      }
    } else {
      mk(box(t.w, 0.06, t.d), "#f1dcc2", [0, H, 0], g);
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        mk(box(0.06, H, 0.06), COLOR.woodDark, [sx * (t.w / 2 - 0.08), H / 2, sz * (t.d / 2 - 0.08)], g, { outline: 0.012 });
      }
      const top = Math.ceil(t.seats / 2), bottom = t.seats - top;
      const row = (n, z) => {
        for (let i = 0; i < n; i++) local.push([(-(n - 1) / 2 + i) * (t.w / Math.max(n, 1)), z]);
      };
      row(top, -(t.d / 2 + 0.32));
      row(bottom, t.d / 2 + 0.32);
    }
    // 컵 하나 (분위기)
    mk(cyl(0.05, 0.04, 0.1, 12), "#ffffff", [0.08, H + 0.08, 0.02], g, { outline: 0.01 });

    const label = textSprite(t.id, { size: 0.26 });
    label.position.set(t.x, H + 1.0, t.z);
    roomGroup.add(label);
    labelSprites.push(label);

    const ids = [];
    local.forEach(([lx, lz], i) => {
      const [rx, rz] = rotXZ(lx, lz, t.rot);
      const id = `${t.id}-${i + 1}`;
      addSeat(id, t.x + rx, t.z + rz, Math.atan2(-rx, -rz), "chair");
      ids.push(id);
    });
    tableGroups.push({ id: t.id, seatIds: ids });
  }

  for (const b of LAYOUT.bars || []) {
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
    if (cfg.wall === "back") g.position.set(cfg.x, cfg.y, 0.06);
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
  if (m && (m.naturalWidth || m.videoWidth)) {
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
    const isVideo = scr.media[scr.idx]?.tagName === "VIDEO";
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
  s.cushion.material.color.set(occ ? COLOR.busy : COLOR.empty);
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
  const p = u.prop;
  popBubble(p.say, p.x, SAY_HEIGHT[p.type] ?? 1.5, p.z);
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
  p.x = THREE.MathUtils.clamp(p.x, PR, R.w - PR);
  p.z = THREE.MathUtils.clamp(p.z, PR, R.d - PR);
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
  g.beginPath(); g.roundRect(0, 0, R.w * sc, R.d * sc, 4); g.fill(); g.stroke();
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
        m.position.set(src.x + dx + Math.sin(e.t * 3) * 0.04, src.y + t * 0.7, src.z);
        m.scale.setScalar(1 + t * 2);
        m.material.opacity = 0.55 * (1 - t);
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
    if (!hasModel) { buildRoom(); buildProps(); }
    buildTables();
    buildScreens();

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
