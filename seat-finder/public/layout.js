// ─────────────────────────────────────────────────────────────
// 매장 배치도 (단위: 미터)  ← 실제 매장 사진/치수를 보고 이 파일만 고치면 됩니다.
//
//  좌표: x = 가로(왼쪽 → 오른쪽), z = 세로(안쪽 벽 → 입구 쪽)
//        매장 왼쪽 안쪽 구석이 (0, 0)
//  rot : 회전 각도(도). 90 = 시계 방향 90도
//  자리 번호: 테이블 id + "-" + 번호  (예: A1-1, A1-2 ...)
//
//  실제 3D 모델(.glb, 블렌더/폴리캠 등)을 쓰려면 model 에 파일 경로를 넣으세요.
//  그러면 아래 벽/가구 대신 그 모델이 표시되고, 자리(의자·손님)만 위에 올려집니다.
// ─────────────────────────────────────────────────────────────
export default {
  name: "우리 카페",
  model: null, // 예: "/models/store.glb"

  room: {
    w: 14, // 가로
    d: 9, // 세로
    wallH: 2.8,
    floor: "#e9cfa7", // 바닥(원목)
    wall: "#fbf3e6",
    accent: "#7fb6a4", // 벽 아랫단 포인트 색
  },

  // 창문/문 (back = 안쪽 벽, left = 왼쪽 벽)
  windows: [
    { wall: "back", x: 2.5, w: 2.4 },
    { wall: "back", x: 6.2, w: 2.4 },
    { wall: "left", z: 3.5, w: 3 },
  ],
  door: { wall: "front", x: 12.2, w: 1.4 },

  // 꾸밈 소품 (클릭 안 됨)
  props: [
    { type: "counter", x: 11.2, z: 1.0, w: 4.6, d: 1.0, label: "주문 · 픽업" },
    { type: "shelf", x: 11.2, z: 0.25, w: 4.0 },
    { type: "plant", x: 0.6, z: 8.3 },
    { type: "plant", x: 9.2, z: 0.6 },
    { type: "plant", x: 0.6, z: 0.6 },
    { type: "lamp", x: 2.5, z: 1.6 },
    { type: "lamp", x: 6.2, z: 1.6 },
    { type: "rug", x: 4.9, z: 6.4, w: 5.6, d: 3.6, color: "#d9b8a0" },
  ],

  // 테이블: shape = "rect" | "round", seats = 의자 수
  tables: [
    { id: "A1", shape: "rect", x: 2.5, z: 1.6, w: 1.4, d: 0.8, seats: 4 },
    { id: "A2", shape: "rect", x: 6.2, z: 1.6, w: 1.4, d: 0.8, seats: 4 },
    { id: "B1", shape: "round", x: 2.6, z: 4.6, r: 0.5, seats: 2 },
    { id: "B2", shape: "round", x: 5.0, z: 4.6, r: 0.5, seats: 2 },
    { id: "B3", shape: "round", x: 7.4, z: 4.6, r: 0.5, seats: 2 },
    { id: "C1", shape: "rect", x: 3.4, z: 6.9, w: 2.0, d: 0.9, seats: 6 },
    { id: "C2", shape: "rect", x: 6.6, z: 6.9, w: 2.0, d: 0.9, seats: 6 },
    { id: "W1", shape: "round", x: 0.9, z: 5.9, r: 0.42, seats: 2, rot: 90 },
  ],

  // 바 좌석(일자형 테이블 + 스툴)
  bars: [{ id: "BAR", x: 11.2, z: 5.0, length: 4.0, seats: 5, rot: 0 }],
};
