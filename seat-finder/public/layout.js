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
  name: "DIVE HIDE AWAY",
  model: null, // 예: "/models/store.glb"

  // 가게 앞 모습 (첫 화면) — 입구 사진 참고
  front: {
    color: "#6e3426", // 벽돌 색
    sign: "DIVE HIDE AWAY", // 입구 옆 나무 명판 + 첫 화면 이름
    number: "44", // 파란 번지판 숫자 (없애려면 null)
    street: "", // 번지판 위 작은 글씨 (예: 도로명)
    windowW: 2.6, // 문 왼쪽 쇼윈도 폭(m)
    doorSign: ["COME IN  we're", "OPEN"], // 문에 걸린 팻말
  },

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

  // 꾸밈 소품. say 를 적으면 손님이 눌렀을 때 말풍선으로 보여 주고 '발견'으로 셉니다.
  //   → 매장 이야기, 메뉴 자랑, 숨은 포인트를 적어 두면 손님이 둘러보는 재미가 생겨요.
  props: [
    { type: "counter", x: 11.2, z: 1.0, w: 4.6, d: 1.0, label: "주문 · 픽업", say: "주문은 여기서!\n원두는 매일 아침 직접 갈아요" },
    { type: "shelf", x: 11.2, z: 0.25, w: 4.0, say: "사장님이 모은 머그컵이에요.\n마음에 드는 컵을 골라 보세요" },
    { type: "plant", x: 0.6, z: 8.3, say: "몬스테라예요.\n매일 아침 물을 줘요" },
    { type: "plant", x: 9.2, z: 0.6, say: "숨은 포토존 발견!\n이 자리에서 사진이 잘 나와요" },
    { type: "plant", x: 0.6, z: 0.6, say: "창가 자리는\n오후 햇살이 제일 예뻐요" },
    { type: "lamp", x: 2.5, z: 1.6, say: "따뜻한 조명 아래\n제일 인기 있는 자리예요" },
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

  // 가상 스크린 (나중에 광고 자리). wall: "left" | "back" | "right"
  //   슬라이드 종류: { title, sub, bg, fg } 글자 / { image: "/ads/a.jpg" } 이미지 / { video: "https://.../a.mp4" } 영상
  //   link 를 넣으면 손님이 화면을 눌렀을 때 그 주소로 이동 (광고 클릭)
  screens: [
    {
      wall: "left", z: 6.9, y: 1.65, w: 2.0, h: 1.125, interval: 6,
      slides: [
        { title: "오늘의 추천", sub: "달콤 쌉싸름한 바닐라 라떼", bg: "#f4a259", fg: "#ffffff" },
        { title: "숨은 이야기 찾기", sub: "매장 곳곳을 눌러 보세요", bg: "#5b8e7d", fg: "#ffffff" },
        { title: "이 화면에 광고하세요", sub: "우리 동네 가게를 소개해 드려요", bg: "#3d405b", fg: "#ffffff" },
      ],
    },
  ],

  // 바 좌석(일자형 테이블 + 스툴)
  bars: [{ id: "BAR", x: 11.2, z: 5.0, length: 4.0, seats: 5, rot: 0 }],
};
