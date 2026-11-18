// 공용 타입 + 기본 설정값
// 헤이홈 온습도계 + IR 에어컨 자동제어 (여름=냉방 / 겨울=난방)

export interface Config {
  /** 화면 상단에 표시할 매장 이름 */
  storeName?: string;
  /** 자동화 on/off. false면 cron이 아무것도 안 함 */
  enabled: boolean;
  /** 여름(냉방) 목표 실내온도 ℃ */
  summerTarget: number;
  /** 겨울(난방) 목표 실내온도 ℃ */
  winterTarget: number;
  /** 이력폭(℃). 목표에서 이만큼 벗어나야 작동 → 깜빡임 방지 */
  deadband: number;
  /** 여름 경고: 실내가 이 온도 이상이면 '너무 더움' 경고 */
  alertHot: number;
  /** 겨울 최저기준: 실내가 이 온도 이하면 '너무 추움' 경고 */
  alertCold: number;
  /** 온습도계(센서) 기기 ID */
  sensorDeviceId: string;
  /** IR 에어컨 기기 ID */
  acDeviceId: string;
  /** 매장 주소(표시용) */
  address?: string;
  /** 매장 위치(바깥 날씨용) */
  lat: number;
  lon: number;
  /** OpenWeatherMap API 키 (웹에서 입력, 없으면 바깥날씨 생략하고 계절로만 판단) */
  owmKey?: string;
}

export const DEFAULT_CONFIG: Config = {
  storeName: '우리 매장',
  enabled: true,
  summerTarget: 25,
  winterTarget: 22,
  deadband: 1.5,
  alertHot: 30,
  alertCold: 15,
  sensorDeviceId: '',
  acDeviceId: '',
  lat: 37.5665, // 기본값: 서울 (배포 후 매장 위치로 변경)
  lon: 126.978,
};

// 에어컨 설정 허용 범위 (homebridge-hejhome 소스에서 확인된 벤더 제약)
export const AC_TEMP_MIN = 16;
export const AC_TEMP_MAX = 30;

export type HvacMode = 'cool' | 'heat' | 'auto' | 'fan' | 'dry';
export type HvacFanSpeed = 'auto' | 'low' | 'medium' | 'high';

// 벤더 코드 매핑 (POST dashboard/control/{id} 의 requirments 값)
export const MODE_CODES: Record<HvacMode, string> = {
  cool: '0', heat: '1', auto: '2', fan: '3', dry: '4',
};
export const FAN_CODES: Record<HvacFanSpeed, string> = {
  auto: '0', low: '1', medium: '2', high: '3',
};

/** 에어컨에 보내려는 "원하는 상태" (한 번에 하나씩 전송됨) */
export interface DesiredAcState {
  power: boolean;
  mode: HvacMode;
  temperature: number;   // 16~30
  fanSpeed: HvacFanSpeed;
}

/** Cloudflare Worker 바인딩 (wrangler.toml 참고) */
export interface Env {
  KV: KVNamespace;
  HEJ_EMAIL: string;      // secret
  HEJ_PASSWORD: string;   // secret
  OWM_API_KEY: string;    // secret (OpenWeatherMap)
  ADMIN_TOKEN?: string;   // secret: UI 보호용 간단 토큰 (선택)
}
