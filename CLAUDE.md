# 작업 안내 (Claude 용)

사장님(매장 DIVE HIDE AWAY 운영)과 함께 만드는 앱이에요. 대화는 **한국어**, 쉬운 말로. 작업 중 진행 안내도 한국어로.

## 저장소
- `seat-finder/` — **빈자리찾기** 웹앱 (Cloudflare Worker + Durable Object). 3D 매장 빈자리 보기 + 1인칭 걷기.
  - 주소: https://빈자리찾기.com · https://빈자리찾기.kr (www 포함), seat-finder.hanguk-soek.workers.dev
  - `public/app.js` 3D 화면 전체 (큼 — 필요한 부분만 grep 으로 찾아 읽기), `public/layout.js` 매장 배치 숫자, `public/index.html`, `src/index.ts` Worker
- `smart-ac/` — 매장 에어컨 앱. **절대 재배포하지 말 것** (배포된 버전이 저장소보다 새것). 빈자리찾기는 그 KV(`AC`)를 **읽기만** 함.

## 사장님과의 약속 (중요)
- **"기다려"** = 코드는 건드리지 말고 말씀하신 수정사항을 **번호 목록으로만** 정리해 보여드리기. "이제 해줘"라고 하면 한꺼번에 수정.
- **배포는 따로**: 사장님이 "배포해줘"라고 할 때만 배포. **"배포할까요?"라고 묻지 않기** (보고 끝에 배포 전이라는 사실만 짧게). 배포 지시 없이 배포하면 자동 승인에서 막힘
- **확인 후 배포**: 화면을 바꾸면 반드시 실제로 열어서 확인한 다음 보고. 확인 사진은 꼭 필요한 1장만.
- **전체 점검(`tools/check.cjs`)은 배포 직전에 한 번만.** 고칠 때는 고친 부분만 사진으로 확인. 보고할 때 점검 결과를 매번 말하지 않기 (문제가 있을 때만).
- 이상하게 보인다고 하시면 **짐작하지 말고** 그 물체를 색칠하거나 좌표로 찍어서 정체를 확인한 뒤 고치기.
- 관리자 버튼판의 자리 배치(끌어서 옮기기)는 **3D 매장과 연결하면 안 됨** (누르기 편하게 하려는 용도). 앉음 여부만 연결.
- 관리자 비밀번호는 파일·채팅에 절대 쓰지 않기. `.dev.vars`(gitignore) 내용도 출력하지 않기. 비밀번호 변경은 사장님이 Cloudflare 대시보드 Settings → Variables and Secrets → ADMIN_TOKEN 에서 함.

## 명령
```bash
cd seat-finder
npm run build                                  # public → src/assets.generated.ts
npx wrangler dev --port 8787 &                 # 로컬 실행 (끝나면 pkill -f "wrangler dev")
node tools/check.cjs                           # 전체 점검: 낮·밤·문 잠김·매장 안 앉기/일어서기
node tools/shot.cjs out.png x z 보는곳x 보는곳z [pitch] [time] [tap=x,y,z] [taps]   # 1인칭 사진 한 장
node tools/topview.cjs out.png                 # 위에서 내려다본 사진
# 배포 (속도 제한 code 971 이 나면 30초 쉬고 다시)
for i in 1 2 3 4 5 6; do CLOUDFLARE_ACCOUNT_ID=9ecdd9e050cc043f4c41cbef5f0b9853 CLOUDFLARE_API_TOKEN=dummy npm run deploy > /tmp/dep.log 2>&1 && { grep -iE "Current Version|custom domain" /tmp/dep.log; break; }; tail -2 /tmp/dep.log; sleep 30; done
```
- 테스트 URL 옵션: `?debug` (window.__walk/__cam/__seats/__bt/__fx 노출), `?time=HH`, `?locked`
- 1인칭 이동은 벽을 뚫고 순간이동하면 막힘 → 입구 앞(8.49, 10.6)에서 출발해 경로로 옮겨야 함 (shot.cjs 가 처리)
- 커밋은 브랜치 `claude/jolly-planck-rj3wef` 에.

## 좌표 (m, 위에서 볼 때 x 오른쪽, z 아래 = 입구 쪽)
- 매장 안쪽 윤곽 `[[0,0],[9.5,0],[9.5,9.5],[3.9,9.5],[0,5.6]]`, 벽 두께 0.14, 천장 2.9
- 입구 문 x 8.49 (폭 1.1, 입구 구석 기둥과 20cm 간격), 입구 구석 기둥 x 9.3~9.5 z 9.3~9.5, 화장실 문 x 8.815 z 0 (폭 0.85, 오른쪽 기둥에 붙음), 화장실 옆 기둥 x 9.3~9.5 z 0~0.4 (왼편 면에 거울 촛대), 안쪽 벽 들보 깊이 40cm, 에어컨 장 x 3.3 z 0 (폭 0.8, 깊이 0.75)
- 2층은 유리 3면 쪽으로 OVER 0.7 넓음, 모서리 기둥 4개, 처마 밑 SOFFIT_Y 2.95
- 매장 뒤 공간 깊이 BACK_D 2.15: 칸막이 x 4.1(BACK_PART_X), x 7.55(WC_ROOM_X0). 화장실 통로 공간 = x 7.55~9.5, 뒷벽에 바깥문(아직 안 열림)
- 같은 자리에 면 두 개가 겹치면 지글거림 → 몇 mm 띄우기

## 다음에 할 일 (사장님이 기억해 두라고 하신 것)
- (완료) 관리자가 3D 매장에 들어가면 사장님 캐릭터(앞치마 + 주황 이름표)로 보임. 모습은 관리자 바 [내 캐릭터]에서 꾸밈 (서버 `bossLook`)

## 실시간 접속 (손님 캐릭터 · 채팅)
- 서버: `src/index.ts` SeatStore 의 웹소켓(`/api/live`), 회원 `/api/account/*`, 도구 `src/live.ts` (욕설 목록·이름 규칙·비밀번호 해시)
- 화면: `public/app.js` 맨 아래 "실시간" 블록 (맨 위 변수는 var — 시작 중 await 때문에 const 쓰면 초기화 전 오류)
- 채팅은 저장 안 함. 내보내기는 휴대폰별 번호(`live-dev`)로 1시간 (매장 와이파이는 IP 가 같아서 IP 로 막으면 안 됨)

## 매장 불 스위치
- 달력 바로 위 벽의 작은 스위치(`lightswitch`). 손님이 누르면 "숨겨진 스위치 발견! 사장님만 켜고 끌 수 있어요", 관리자가 누르면 모든 화면의 불을 켜고 끔 (`POST /api/lights`, 서버 `lights`)
- 스위치 값은 다음 새벽 4시·오전 10시가 되면 시간대 기본값으로 돌아감. 관리자 화면도 손님과 똑같이 잠긴 시간엔 블라인드 닫힘·바텐더 없음
