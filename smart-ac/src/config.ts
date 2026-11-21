// 공용 타입 + 기본 설정값
// 헤이홈 온습도계 + IR 에어컨 자동제어 (여름=냉방 / 겨울=난방)

/** 하루 영업시간. close "HH:MM"가 open보다 작거나 같으면 자정을 넘겨 다음날 close까지 */
export interface DayHours { closed: boolean; open: string; close: string; }

/** 기본 영업시간: 화~금 17:00~익일02:00 / 토·일 13:00~자정 / 월 휴무 */
export const DEFAULT_HOURS: DayHours[] = [
  { closed: false, open: '13:00', close: '00:00' }, // 0 일
  { closed: true,  open: '17:00', close: '02:00' }, // 1 월 (휴무)
  { closed: false, open: '17:00', close: '02:00' }, // 2 화
  { closed: false, open: '17:00', close: '02:00' }, // 3 수
  { closed: false, open: '17:00', close: '02:00' }, // 4 목
  { closed: false, open: '17:00', close: '02:00' }, // 5 금
  { closed: false, open: '13:00', close: '00:00' }, // 6 토
];

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
  /** 에어컨 설정 보정(℃): 에어컨 센서가 빨리 도달해 송풍 전환되는 것 방지.
   *  난방은 목표+보정, 냉방은 목표−보정으로 '강하게' 틀고 끄는 건 우리 센서로 판단 */
  acBias?: number;
  /** 바람세기 고정값. 영업 중엔 모드/풍향을 안 건드리고 설정온도만 조절하므로
   *  바람세기도 한 값으로 고정(매번 바꾸면 풍향 리셋 위험). 기본 '중' */
  fanSpeed?: HvacFanSpeed;
  /** 완만 유지 단계에서 온도 추이를 지켜볼 시간(분). 이 시간 뒤에도 계속 넘치면 '쉬기'로 */
  observeMinutes?: number;
  /** 목표를 이만큼(℃) 넘어 계속 오르면(냉방은 내려가면) '쉬기'로 전환 */
  restAbove?: number;
  /** 자동 가습 on/off (가습기 = 헤이홈 레시피 토글) */
  humAuto?: boolean;
  /** 이 습도(%) 아래면 가습기 켜기 */
  humLow?: number;
  /** 이 습도(%) 이상이면 가습기 끄기 */
  humHigh?: number;
  /** 영업시간에만 가습 (비영업엔 끔) */
  humBizOnly?: boolean;
  /** 여름 경고: 실내가 이 온도 이상이면 '너무 더움' 경고 */
  alertHot: number;
  /** 겨울 최저기준: 실내가 이 온도 이하면 '너무 추움' 경고 + 비영업 세트백 바닥 */
  alertCold: number;
  /** 영업시간 자동 적용 (비영업엔 최저기준으로 세트백해 절전) */
  useSchedule?: boolean;
  /** 영업 시작 몇 분 전부터 미리 데울지(예열) */
  preheatMinutes?: number;
  /** 요일별 영업시간 (index 0=일 … 6=토). close가 open보다 작으면 자정 넘김 */
  hours?: DayHours[];
  /** 온습도계(센서) 기기 ID */
  sensorDeviceId: string;
  /** 두 번째 온습도계 기기 ID (선택, 예: 입구 쪽) */
  sensor2DeviceId?: string;
  /** 제어 기준: 두 센서 평균 / 첫 번째만 / 두 번째만. 한쪽이 안 되면 남은 쪽 사용 */
  sensorMode?: 'avg' | 's1' | 's2';
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
  acBias: 5,
  fanSpeed: 'medium',
  observeMinutes: 30,
  restAbove: 1,
  humAuto: false,
  humLow: 40,
  humHigh: 55,
  humBizOnly: true,
  alertHot: 30,
  alertCold: 15,
  useSchedule: true,
  preheatMinutes: 60,
  hours: DEFAULT_HOURS,
  sensorDeviceId: '',
  acDeviceId: '',
  lat: 37.5665, // 기본값: 서울 (배포 후 매장 위치로 변경)
  lon: 126.978,
};

// 에어컨 설정 허용 범위 (homebridge-hejhome 소스에서 확인된 벤더 제약)
export const AC_TEMP_MIN = 16;
export const AC_TEMP_MAX = 30;

export type HvacMode = 'cool' | 'heat' | 'auto' | 'fan' | 'dry';
/** 헤이홈 약·중·강 = 실제 에어컨 1·2·3단 (헤이홈 '자동'은 이 에어컨에 맞는 기능이 없어 제외) */
export type HvacFanSpeed = 'low' | 'medium' | 'high';

// 벤더 코드 매핑 (POST dashboard/control/{id} 의 requirments 값)
export const MODE_CODES: Record<HvacMode, string> = {
  cool: '0', heat: '1', auto: '2', fan: '3', dry: '4',
};
export const FAN_CODES: Record<HvacFanSpeed, string> = {
  low: '1', medium: '2', high: '3',
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
