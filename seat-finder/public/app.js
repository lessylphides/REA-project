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
const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
const R = LAYOUT.room;
const center = new THREE.Vector3(R.w / 2, 0.4, R.d / 2);

// 만화 느낌: 3단계 음영(툰 셰이딩) + 외곽선
const gradientMap = (() => {
  const t = new THREE.DataTexture(new Uint8Array([90, 175, 255]), 3, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
})();
const matCache = new Map();
const toon = (color, { unique = false, ...extra } = {}) => {
  const key = color + JSON.stringify(extra);
  if (!unique && matCache.has(key)) return matCache.get(key);
  const m = new THREE.MeshToonMaterial({ color, gradientMap, ...extra });
  if (!unique) matCache.set(key, m);
  return m;
};
const outlineMat = new THREE.MeshBasicMaterial({ color: COLOR.outline, side: THREE.BackSide });

/** 메쉬 하나 만들기 (외곽선 포함) */
function mk(geo, mat, pos, parent, { outline = 0.018, shadow = true } = {}) {
  const m = new THREE.Mesh(geo, typeof mat === "string" ? toon(mat) : mat);
  if (pos) m.position.set(pos[0], pos[1], pos[2]);
  m.castShadow = shadow;
  m.receiveShadow = true;
  if (outline) {
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

// ───────── 조명 ─────────
scene.add(new THREE.HemisphereLight("#fff6ea", "#c9a88a", 1.4));
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

function plankTexture() {
  const c = document.createElement("canvas");
  c.width = 512; c.height = 512;
  const ctx = c.getContext("2d");
  ctx.fillStyle = R.floor; ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 8; i++) {
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
  const floorMat = new THREE.MeshToonMaterial({ color: "#ffffff", map: plankTexture(), gradientMap });
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
  } else {
    wallSeg("x", -T / 2, R.w + T / 2, low, R.d + T / 2);
  }
  wallSeg("z", -T / 2, R.d + T / 2, low, R.w + T / 2);
}

// ───────── 소품 ─────────
function buildProps() {
  for (const p of LAYOUT.props || []) {
    const g = new THREE.Group();
    g.position.set(p.x, 0, p.z);
    g.rotation.y = THREE.MathUtils.degToRad(-(p.rot || 0));
    roomGroup.add(g);
    if (p.type === "counter") {
      mk(box(p.w, 1.0, p.d), "#f3e3cf", [0, 0.5, 0], g);
      mk(box(p.w + 0.1, 0.07, p.d + 0.1), COLOR.woodDark, [0, 1.03, 0], g);
      mk(box(p.w, 0.3, 0.04), R.accent, [0, 0.25, p.d / 2 + 0.01], g, { outline: 0 });
      // 커피머신 + 컵
      mk(box(0.6, 0.5, 0.45), "#5a5f66", [-p.w / 2 + 0.6, 1.32, 0], g);
      mk(box(0.4, 0.06, 0.3), "#d0d4d8", [-p.w / 2 + 0.6, 1.1, 0.1], g, { outline: 0.01 });
      mk(box(0.5, 0.35, 0.4), "#e9edf1", [p.w / 2 - 0.5, 1.24, 0], g);
      for (let i = 0; i < 3; i++) mk(cyl(0.05, 0.04, 0.11, 12), "#ffffff", [0.2 * i - 0.2, 1.12, 0.15], g, { outline: 0.01 });
      if (p.label) {
        const s = textSprite(p.label, { size: 0.28 });
        s.position.set(0, 2.0, 0);
        g.add(s);
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
      mk(cyl(0.22, 0.17, 0.4, 16), "#d98b5f", [0, 0.2, 0], g);
      const leaf = "#6bbf7a";
      mk(new THREE.SphereGeometry(0.32, 16, 12), leaf, [0, 0.72, 0], g, { outline: 0.02 });
      mk(new THREE.SphereGeometry(0.24, 16, 12), "#58ad6a", [0.18, 0.95, 0.05], g, { outline: 0.02 });
      mk(new THREE.SphereGeometry(0.2, 16, 12), "#7fcc8a", [-0.15, 1.05, -0.05], g, { outline: 0.02 });
    } else if (p.type === "lamp") {
      const y = R.wallH;
      mk(cyl(0.008, 0.008, 0.8, 6), "#4a3a31", [0, y - 0.4, 0], g, { outline: 0, shadow: false });
      mk(new THREE.ConeGeometry(0.26, 0.24, 20, 1, true), toon("#f6c36a", { side: THREE.DoubleSide }), [0, y - 0.9, 0], g, { outline: 0, shadow: false });
      mk(new THREE.SphereGeometry(0.07, 12, 8), new THREE.MeshBasicMaterial({ color: "#fff7d6" }), [0, y - 0.98, 0], g, { outline: 0, shadow: false });
    } else if (p.type === "rug") {
      const r = mk(box(p.w, 0.015, p.d), p.color || "#d9b8a0", [0, 0.008, 0], g, { outline: 0, shadow: false });
      r.receiveShadow = true;
    }
  }
}

// ───────── 자리(의자 + 손님) ─────────
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
  const eye = new THREE.MeshBasicMaterial({ color: "#2a211d" });
  mk(new THREE.SphereGeometry(0.022, 8, 6), eye, [-0.055, 0.0, 0.148], head, { outline: 0, shadow: false });
  mk(new THREE.SphereGeometry(0.022, 8, 6), eye, [0.055, 0.0, 0.148], head, { outline: 0, shadow: false });
  const cheek = new THREE.MeshBasicMaterial({ color: "#f59a8f", transparent: true, opacity: 0.7 });
  mk(new THREE.SphereGeometry(0.025, 8, 6), cheek, [-0.095, -0.045, 0.13], head, { outline: 0, shadow: false });
  mk(new THREE.SphereGeometry(0.025, 8, 6), cheek, [0.095, -0.045, 0.13], head, { outline: 0, shadow: false });
  // 팔 (테이블 쪽으로)
  for (const sx of [-1, 1]) {
    const arm = mk(new THREE.CapsuleGeometry(0.045, 0.2, 4, 8), shirt, [sx * 0.15, seatY + 0.33, 0.1], g, { outline: 0.015 });
    arm.rotation.x = 1.1;
  }
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

  // 바닥 표시등 (빈자리 = 초록 원, 반짝임)
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.3, 0.4, 40),
    new THREE.MeshBasicMaterial({ color: COLOR.empty, transparent: true, opacity: 0.75, depthWrite: false })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  g.add(ring);
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(0.3, 40),
    new THREE.MeshBasicMaterial({ color: COLOR.empty, transparent: true, opacity: 0.25, depthWrite: false })
  );
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.018;
  g.add(disc);

  const guest = makeGuest(id, seatY);
  g.add(guest);

  const hb = new THREE.Mesh(box(0.6, 1.4, 0.6), hitMat);
  hb.position.y = 0.7;
  hb.userData.seatId = id;
  hb.castShadow = false;
  g.add(hb);
  hitboxes.push(hb);

  seats.set(id, { id, group: g, cushion, ring, disc, guest, occupied: false, anim: 0, target: 0, bump: 0 });
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
    mk(box(b.length, 1.0, 0.45), "#f3e3cf", [0, 0.5, -0.05], g);
    mk(box(b.length + 0.1, 0.06, 0.6), COLOR.woodDark, [0, 1.03, 0], g);
    const label = textSprite(b.id, { size: 0.26 });
    label.position.set(b.x, 2.0, b.z);
    roomGroup.add(label);
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

// ───────── 카메라 / 조작 ─────────
let controls;
function fitCamera() {
  const w = host.clientWidth, h = host.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  const radius = Math.hypot(R.w, R.d) / 2;
  const vfov = THREE.MathUtils.degToRad(camera.fov);
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
  const dist = (radius / Math.sin(Math.min(vfov, hfov) / 2)) * (camera.aspect < 1 ? 1.05 : 0.9);
  const dir = new THREE.Vector3(0.38, 1.15, 1).normalize();
  camera.position.copy(center).addScaledVector(dir, dist);
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

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("show"), 1400);
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
function seatAt(ev) {
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(hitboxes, false)[0];
  return hit?.object.userData.seatId || null;
}
function bindPointer() {
  const el = renderer.domElement;
  el.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  el.addEventListener("pointerup", (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const quick = performance.now() - down.t < 600;
    down = null;
    if (moved > 8 || !quick) return;
    if (!document.body.classList.contains("admin")) return; // 손님은 자리를 바꿀 수 없음
    const id = seatAt(e);
    if (id) toggleSeat(id);
  });
  el.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse" || !document.body.classList.contains("admin")) return;
    el.style.cursor = seatAt(e) ? "pointer" : "";
  });
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
    // 빈자리 표시등 반짝임
    const glow = 1 - Math.min(1, s.anim * 1.5);
    const pulse = 0.5 + 0.5 * Math.sin(time * 3 + s.group.position.x);
    s.ring.material.opacity = glow * (0.45 + 0.4 * pulse);
    s.disc.material.opacity = glow * (0.15 + 0.15 * pulse);
    s.ring.scale.setScalar(1 + pulse * 0.08);
    s.ring.visible = s.disc.visible = glow > 0.01;
    // 터치했을 때 의자 통통
    if (s.bump > 0) {
      s.bump = Math.max(0, s.bump - dt * 3);
      s.cushion.scale.y = 1 + Math.sin(s.bump * Math.PI) * 0.6;
    }
  }
  controls.update();
  renderer.render(scene, camera);
}

// ───────── 시작 ─────────
async function main() {
  $("brand").textContent = `빈자리찾기 · ${LAYOUT.name}`;
  document.title = `빈자리찾기 · ${LAYOUT.name}`;
  if (IS_ADMIN) $("hint").textContent = "자리를 누르면 손님 있음 ↔ 빈자리";

  if (renderer) {
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);

    const hasModel = await loadModel();
    if (!hasModel) { buildRoom(); buildProps(); }
    buildTables();

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
    renderer.setAnimationLoop(tick);
  } else {
    buildTablesHeadless();
  }

  renderSummary();
  if (IS_ADMIN) {
    if (token) {
      try { await api("/api/login"); document.body.classList.add("admin"); }
      catch (e) { showLogin(e.message); }
    } else showLogin();
  }
  startPolling();
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
