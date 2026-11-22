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
  // 그림체: "line" = 굵은 선 + 파스텔 손그림 (시간대별 낮/노을/밤 조명), "toon" = 예전 입체 만화
  style: "line",

  name: "DIVE HIDE AWAY",
  model: null, // 예: "/models/store.glb"

  // 가게 앞 모습 (첫 화면) — 입구 사진 참고
  front: {
    color: "#6e3426", // 벽돌 색
    sign: "DIVE HIDE AWAY", // 입구 옆 나무 명판 + 첫 화면 이름
    number: "44", // 파란 번지판 숫자 (없애려면 null)
    street: "", // 번지판 위 작은 글씨 (예: 도로명)
    windowW: 2.8, // 문 왼쪽 쇼윈도 폭(m)
    doorSign: ["COME IN  we're", "OPEN"], // 문에 걸린 팻말
  },

  // 부채꼴 매장: 안쪽 벽 + 오른쪽 벽은 막혀 있고, 앞쪽 3면이 통유리(블라인드)
  room: {
    w: 9.5, // 가로
    d: 9.5, // 세로
    wallH: 2.9,
    // 바닥 외곽선 꼭짓점 (위에서 본 모양, 순서대로 이어서 벽이 됨)
    outline: [[0, 0], [9.5, 0], [9.5, 9.5], [3.9, 9.5], [0, 5.6]],
    // 각 변의 종류: wall = 벽, front = 입구 있는 정면 유리, glass = 통유리(블라인드)
    edges: ["wall", "wall", "front", "glass", "glass"],
    // 창밖 풍경: 매장은 골목 삼거리 코너. street = 창과 나란히 지나가는 골목, alley = 창에서 똑바로 뻗어 나가는 골목
    //   대각선 창(안 쓰는 문 쪽)이 삼거리 골목 중 하나를 바라봄
    outside: ["", "", "street", "alley", "street"],
    floor: "#b9aaa6", // 콘크리트 바닥
    floorStyle: "concrete",
    wall: "#f2e6ec", // 은은한 분홍빛 흰 벽
    ceiling: "#ddd0d3", // 천장은 조명이 없어 벽보다 어둡게
    beams: [4.6, 6.6, 8.6],
  },

  door: { wall: "front", x: 8.1, w: 1.1 },

  // 꾸밈 소품. say 를 적으면 손님이 눌렀을 때 말풍선으로 보여 주고 '발견'으로 셉니다.
  //   → 매장 이야기, 메뉴 자랑, 숨은 포인트를 적어 두면 손님이 둘러보는 재미가 생겨요. (문구는 예시예요)
  props: [
    // 창 아래 뒷선반 (술병) — 유리를 따라
    // 창 아래 뒷장 3개 (모서리에서 끊김): 왼쪽 창 / 대각선 창 / 정면 창
    { type: "backbar", path: [[0.3, 1.0], [0.3, 4.85]] }, // 안쪽 벽과 사이에 틈 (스탠드 자리)
    { type: "backbar", path: [[1.75, 6.93], [3.4, 8.58]] }, // 안 쓰는 문 때문에 짧음
    { type: "backbar", path: [[4.6, 9.2], [7.0, 9.2]] },
    // 대각선 창 쪽 안 쓰는 출입문 + 문 앞 나무 스툴 (반죽기 / 가습기)
    { type: "door", x: 0.66, z: 6.26, rot: 45, w: 1.0, say: "지금은 안 쓰는 문이에요\n대신 창밖 골목이 예뻐요" },
    { type: "sidetable", item: "mixer", x: 0.78, z: 5.88, rot: 45, say: "반죽기예요\n직접 만드는 안주가 있어요" },
    { type: "sidetable", item: "humidifier", x: 1.25, z: 6.35, rot: 45, say: "가습기가 촉촉하게\n공기를 지켜 줘요" },
    { type: "floorlamp", x: 0.38, z: 0.45, h: 1.75, say: "주름 갓 스탠드\n은은한 분홍빛이 포인트예요" },
    { type: "floorlamp", x: 0.4, z: 5.3, h: 1.75 }, // 왼쪽 장 ↔ 대각선 장 사이 틈
    { type: "floorlamp", x: 4.02, z: 9.0, h: 1.75 }, // 대각선 장 ↔ 정면 장 사이 틈
    { type: "floorlamp", x: 9.15, z: 9.1, h: 1.75 },
    { type: "coffee", x: 6.4, z: 9.2, rot: 180, say: "커피도 내려 드려요\n원두 향이 솔솔" },
    // 조명
    { type: "pendant", kind: "linear", x: 2.1, z: 2.8, rot: 90, len: 1.8, y: 2.2 },
    { type: "pendant", kind: "linear", x: 3.43, z: 6.06, rot: 45, len: 1.8, y: 2.2 },
    { type: "pendant", kind: "linear", x: 5.75, z: 7.4, rot: 0, len: 1.6, y: 2.2, say: "바 위 나무 조명\n잔이 반짝이게 비춰 줘요" },
    { type: "pendant", kind: "rattan", x: 5.2, z: 3.2, y: 2.15, say: "라탄 조명\n직접 골라 단 등이에요" },
    { type: "pendant", kind: "rattan", x: 7.6, z: 6.7, y: 2.15 },
    { type: "pendant", kind: "beehive", x: 8.75, z: 5.4, y: 2.1, say: "벌집 모양 원목 조명" },
    { type: "projector", x: 5.3, z: 5.4 },
    // 안쪽 벽 TV 장식장 (TV 는 아래 screens)
    { type: "tvshelf", x: 5.2, z: 1.13, w: 3.8, h: 2.6, tvW: 2.35, tvY: 1.55, tvH: 1.32, say: "전자칠판 영상\n화분 사이로 숲을 보며 쉬어 가세요" },
    // 식물
    // 반원 테이블 바로 뒤 화분 3개 → 전자칠판 영상을 은은히 가림
    { type: "bigplant", kind: "palm", x: 4.35, z: 2.13, h: 1.95, say: "야자 화분이에요\n잎 사이로 영상이 살짝" },
    { type: "bigplant", kind: "palm", x: 5.2, z: 2.03, h: 2.1 },
    { type: "bigplant", kind: "palm", x: 6.05, z: 2.13, h: 1.85 },
    { type: "bigplant", kind: "norfolk", x: 8.95, z: 1.1, h: 1.7, say: "노퍽 소나무예요\n겨울엔 트리가 돼요" },
    { type: "bigplant", kind: "tree", x: 8.95, z: 8.0, h: 2.0, say: "홍콩야자 나무\n매장의 터줏대감이에요" },
    // 오른쪽 벽
    // 오른쪽 벽: 노퍽 소나무 옆 원목 행거
    { type: "coatrack", x: 9.25, z: 2.35, rot: 90, say: "외투는 여기에\n걸어 주세요" },
    // 안쪽 벽: 화장실 가는 문 (TV 장식장과 노퍽 소나무 사이)
    { type: "walldoor", x: 7.9, z: 0.0, w: 0.85, text: "WC", say: "화장실은\n이 문으로 나가요" },
    { type: "sign", walkOnly: true, x: 9.46, z: 7.3, rot: 90, y: 2.1, text: "WELCOME", say: "WELCOME!\n오늘도 와 주셔서 고마워요" },
  ],

  // 테이블: shape = "oval" | "round" | "rect", chair = "rattan" | "windsor" | "chair"
  //   chairs: [[x, z], ...] 로 의자 위치를 직접 정할 수 있어요 (테이블 기준)
  tables: [
    // 반원 테이블: 사각 상판 + 접었다 펴는 반원 날개(홀 쪽). 평평한 쪽이 전자칠판을 봄, 의자 3개는 TV 쪽 빼고
    //   손님이 테이블을 누르면 반원 날개가 접혔다 펴져요
    { id: "T1", shape: "dropleaf", x: 5.2, z: 2.75, w: 1.2, d: 0.75, r: 0.6, seats: 3, chair: "rattan", color: "#b8743f", leg: "#7a4a2a" },
    // 벽 테이블: 입구에서 봤을 때 오른쪽 벽에 붙음, 의자 3개 (벽 쪽 빼고)
    { id: "T2", shape: "rect", x: 9.08, z: 5.4, w: 0.8, d: 0.9, seats: 3, chair: "windsor", color: "#4a3328", leg: "#3a281f",
      chairs: [[-0.66, 0], [0, -0.68], [0, 0.68]], lamp: [0.22, -0.25] },
  ],

  // 가상 스크린 (나중에 광고 자리). wall: "left" | "back" | "right"
  //   슬라이드 종류: { scene: "forest" } 숲 영상 / { title, sub, bg, fg } 글자 / { image: "/ads/a.jpg" } 이미지 / { video: "https://.../a.mp4" } 영상
  //   link 를 넣으면 손님이 화면을 눌렀을 때 그 주소로 이동 (광고 클릭)
  screens: [
    {
      wall: "back", x: 5.2, z: 1.13, y: 1.55, w: 2.25, h: 1.27, interval: 7,
      slides: [
        { scene: "forest", duration: 14 },
        { title: "오늘의 위스키", sub: "바텐더에게 추천을 받아 보세요", bg: "#7a3b2e", fg: "#ffffff" },
        { title: "숨은 이야기 찾기", sub: "매장 곳곳을 눌러 보세요", bg: "#5b8e7d", fg: "#ffffff" },
        { title: "이 화면에 광고하세요", sub: "우리 동네 가게를 소개해 드려요", bg: "#3d405b", fg: "#ffffff" },
      ],
    },
  ],

  // 바: path 를 주면 그 길을 따라 휘어진 바 (창을 따라 곡선), seats = 바 의자 수
  bars: [
    // 창에서 2.1m 안쪽 (바텐더 공간 넓게), depth = 바 몸통 두께
    { id: "BAR", path: [[2.1, 0.9], [2.1, 4.73], [4.77, 7.4], [6.7, 7.4]], radius: 1.2, depth: 0.66, seats: 8, chair: "barstool",
      // 바 끝 창 쪽(커피머신 앞)에서 바를 사이에 두고 마주 보는 자리 → BAR-9
      extraSeats: [[6.3, 8.32, 0, -1]],
      // 바 안쪽으로 못 들어가게 막는 곳 [x, z, 반폭, 반깊이]: 안쪽 벽 쪽 끝 / 입구 쪽 끝
      block: [[2.1, 0.45, 0.4, 0.45], [7.05, 8.35, 0.25, 0.85]],
      say: "곡선 바 9석\n바텐더와 이야기 나누기 좋은 자리" },
  ],
};
