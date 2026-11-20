# 헤이홈 에어컨 자동제어 (프로토타입)

온습도계(헤이홈 센서)의 실내 온도 + 바깥 날씨/계절을 보고, **IR 에어컨을 자동으로 냉방/난방·온도·바람세기 조정**하는 Cloudflare Worker.

- 여름(냉방철) → 실내가 더우면 냉방, 목표 **25℃**
- 겨울(난방철) → 실내가 추우면 난방, 목표 **22℃**
- 10분마다 자동 실행, 웹에서 **on/off** 가능
- 깜빡임 방지: 목표에서 **1.5℃** 벗어나야 작동

> ⚠️ IR은 단방향이라 에어컨 실제 상태를 되읽을 수 없습니다. "현재 실내온도(센서)"를 기준으로 반복 보정합니다. 누가 리모컨으로 바꾸면 다음 주기에 다시 맞춥니다.

## 구성
```
src/config.ts   설정/타입/벤더 코드
src/hej.ts      헤이홈 API (로그인·기기목록·제어)
src/weather.ts  OpenWeatherMap 바깥 날씨
src/engine.ts   냉난방 결정 로직
src/index.ts    Worker(스케줄+웹UI+API)
```

## 배포 (Cloudflare)
```bash
cd smart-ac
npm install

# 1) KV 네임스페이스 생성 → 나온 id 를 wrangler.toml 의 REPLACE_WITH_KV_ID 에 붙여넣기
npx wrangler kv namespace create KV

# 2) 시크릿 등록 (채팅/파일에 비번 넣지 말 것)
npx wrangler secret put HEJ_EMAIL        # 헤이홈 로그인 이메일
npx wrangler secret put HEJ_PASSWORD     # 헤이홈 비밀번호
npx wrangler secret put OWM_API_KEY       # openweathermap.org 무료 키
npx wrangler secret put ADMIN_TOKEN       # (선택) UI 보호용 아무 문자열

# 3) 배포
npx wrangler deploy
```

## 최초 설정 (배포 후)
1. 배포된 주소 열기 (`...workers.dev`). ADMIN_TOKEN 설정했으면 `?t=토큰` 붙이기.
2. **[기기 목록 보기]** 눌러 센서/에어컨의 `id` 확인 → 설정에 입력.
   - 온습도계: `deviceType`이 `SensorTh`류, 에어컨: `IrAirconditioner`.
3. 위도/경도를 매장 위치로 변경(바깥 날씨용), **설정 저장**.
4. **[지금 실행]**으로 1회 테스트 → "마지막 실행"에 판단/전송 내역 표시.

## 제어 스펙 (참고, homebridge-hejhome 확인)
```
POST dashboard/control/{id}  body {"requirments": { ... }}
 전원 {"power":true/false} · 온도 {"temperature":16~30}
 모드 {"mode":"0"} 냉0 난1 자2 송3 제4 · 바람 {"fanSpeed":"0"} 자0 약1 중2 강3
```

## 나중에 할 것 (같이 다듬기)
- 센서 `deviceState` 키 보정(실기기 응답 보고 `readSensor` 조정)
- 영업시간 제한, 습도 기반 제습, 씬 연동
- 정식 운영 시 goqual **공식 OpenAPI(goqual.io)** 자격증명으로 전환
