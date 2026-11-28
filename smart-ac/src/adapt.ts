// 목표 온도 자동 조정 (사람이 느끼는 방식에 맞춰 천천히)
// 1) 계절감: 최근 이틀가량의 바깥 온도 흐름(가중 평균)을 보고, 포근한 날이 이어지면 겨울 목표를
//    조금 낮추고, 선선한 여름 날이 이어지면 여름 목표를 조금 올린다 (적응형 쾌적 개념).
// 2) 매장이 스스로 내는 열: 에어컨이 세게 데우지 않는데도 최근 40분간 온도가 오르면
//    (손님·조명·주방 열) 겨울 목표를 그만큼 살짝 낮춘다.
// 목표는 30분에 0.5℃씩만 움직여 손님이 변화를 느끼지 않게 한다.
import type { Config } from './config';

export interface AdaptState { w: number; s: number; ts: number; c?: number; v?: number }  // 지금 쓰는 겨울/여름 목표, c=매장 열 효과(기억)
export interface AdaptInfo {
  baseW: number; baseS: number; w: number; s: number;
  climate: number;   // 계절감으로 인한 겨울 목표 변화(℃, 음수=낮춤)
  climateS: number;  // 계절감으로 인한 여름 목표 변화(℃, 양수=올림)
  crowd: number;     // 매장 열로 인한 겨울 목표 변화(℃)
  trm: number | null; // 최근 바깥 온도 흐름(가중 평균)
  day: number | null; // 오늘의 체감 기준(오늘 지난 시간 실제 + 남은 시간 예보의 평균)
  feel: number | null; // 둘을 섞은 값(오늘 60% + 최근 흐름 40%)
  note: string;
}
interface Pt { t: number; temp: number; out: number | null; cmd?: string }

const H = 3600 * 1000;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const r1 = (v: number) => Math.round(v * 10) / 10;

/** 최근 바깥 온도의 가중 평균(가까울수록 크게, 반감 약 17시간). 기록이 없으면 지금 값 */
export function outdoorTrend(hist: Pt[], outNow: number | null, now: number): number | null {
  let sw = 0, sv = 0;
  for (const p of hist) {
    if (typeof p.out !== 'number' || now - p.t > 72 * H) continue;
    const w = Math.exp(-(now - p.t) / (24 * H));
    sw += w; sv += w * p.out;
  }
  if (typeof outNow === 'number') { sw += 1; sv += outNow; }
  return sw > 0 ? sv / sw : null;
}

/** 에어컨이 세게 데우지 않는 동안 최근 40분 온도 상승(℃). 매장이 스스로 데워지는 정도 */
export function selfHeating(hist: Pt[], tempNow: number, now: number): number {
  const win = hist.filter((p) => now - p.t <= 45 * 60000 && now - p.t >= 25 * 60000);
  if (!win.length) return 0;
  const recent = hist.filter((p) => now - p.t <= 45 * 60000);
  // 에어컨이 데우는 중(세게 'heat' 또는 완만 유지 'soft')이면 오른 온도가 에어컨 몫이라 판단 안 함 → 쉬기·꺼짐일 때만
  if (recent.some((p) => p.cmd === 'heat' || p.cmd === 'cool' || p.cmd === 'soft')) return 0;
  return Math.max(0, tempNow - win[0].temp);
}

/** 오늘의 체감 기준: 한국시간 오늘 9~24시 중 지난 시간은 실제 바깥 기온, 남은 시간은 예보 — 사람들은 아침 예보를 보고 옷을 고른다 */
export function todayFeel(hist: Pt[], fc: { t: number; temp: number }[] | null | undefined, outNow: number | null, now: number): number | null {
  // 영업일 기준: 새벽 6시 전은 전날로 (새벽 손님은 전날 날씨에 맞춰 입고 온 사람들)
  const k = (t: number) => new Date(t + 9 * H - 6 * H);
  const today = k(now).toISOString().slice(0, 10);
  const inDay = (t: number) => { const d = k(t); return d.toISOString().slice(0, 10) === today && d.getUTCHours() >= 3; }; // 9시~다음날 6시
  const vals: number[] = [];
  for (const p of hist) if (typeof p.out === 'number' && p.t <= now && inDay(p.t)) vals.push(p.out);
  if (typeof outNow === 'number' && inDay(now)) vals.push(outNow);
  for (const f of fc ?? []) if (f.t > now && inDay(f.t)) { vals.push(f.temp); vals.push(f.temp); vals.push(f.temp); } // 3시간 간격 → 10분 기록과 비중 맞춤(대략)
  if (!vals.length) { // 새벽(9시 전): 오늘 낮~밤 예보로
    for (const f of fc ?? []) if (inDay(f.t)) vals.push(f.temp);
  }
  if (!vals.length) return null;
  const dayMean = vals.reduce((a, v) => a + v, 0) / vals.length;
  // 지금~3시간 뒤: 손님이 실제로 맞고 들어오는 바깥 공기 (저녁에 추워지면 바로 반영)
  const near: number[] = [];
  if (typeof outNow === 'number') near.push(outNow);
  for (const f of fc ?? []) if (f.t > now && f.t <= now + 3 * H) near.push(f.temp);
  if (!near.length) return dayMean;
  return 0.5 * dayMean + 0.5 * (near.reduce((a, v) => a + v, 0) / near.length);
}

export function computeAdapt(cfg: Config, hist: Pt[], outNow: number | null, tempNow: number,
  prev: AdaptState | null | undefined, now: number, fc?: { t: number; temp: number }[] | null): { state: AdaptState; info: AdaptInfo } {
  const baseW = cfg.winterTarget, baseS = cfg.summerTarget;
  const maxDown = cfg.adaptMaxDown ?? 3, maxUp = 2;
  const trm = outdoorTrend(hist, outNow, now);
  const day = todayFeel(hist, fc, outNow, now);
  // 체감 기준 = 오늘(예보 포함) 60% + 최근 2~3일 흐름 40% → 예보가 포근하면 오픈 전부터 미리 반영
  const feel = day == null ? trm : (trm == null ? day : 0.6 * day + 0.4 * trm);
  // 1) 계절감: 체감 기준 7℃부터 1℃ 오를 때마다 겨울 목표 0.4℃ 낮춤 (7℃ 이하 추운 날은 그대로)
  //    / 26℃부터 1℃ 내릴 때마다 여름 목표 0.3℃ 올림
  const climate = feel == null ? 0 : -0.4 * clamp(feel - 7, 0, 20);
  const climateS = feel == null ? 0 : 0.3 * clamp(26 - feel, 0, 15);
  // 2) 매장 열: 40분 사이 0.5℃ 이상 스스로 오르면 그만큼(최대 1.5℃) 겨울 목표를 낮춤
  const rise = selfHeating(hist, tempNow, now);
  const crowdNow = rise >= 0.5 ? -Math.min(1.5, rise) : 0;
  // 매장 열은 빨리 반영하고 천천히 풀림: 손님이 있는 동안 유지, 빠지면 30분에 0.25℃씩 원래대로
  const recover = prev ? 0.25 * Math.min(4, Math.max(0, now - prev.ts) / (30 * 60000)) : 0;
  // v2 이전의 손님 열 기억은 완만 유지 난방을 손님 열로 잘못 읽은 값이라 버림
  const prevC = prev && prev.v === 2 ? (prev.c ?? 0) : 0;
  const crowd = Math.min(crowdNow, Math.min(0, prevC + recover));
  const rawW = clamp(baseW + climate + crowd, baseW - maxDown, baseW);
  const rawS = clamp(baseS + climateS, baseS, baseS + maxUp);
  // 부드럽게: 30분에 0.5℃까지만 이동 (처음이거나 설정이 바뀌어 범위를 벗어나면 바로 맞춤)
  const fresh = !prev || prev.w > baseW || prev.w < baseW - maxDown || prev.s < baseS || prev.s > baseS + maxUp;
  // 부드럽게: 내릴 땐 30분에 0.5℃, 추워져 올릴 땐 30분에 1.5℃ (쌀쌀함은 빨리 풀어줌)
  const k30 = fresh ? Infinity : Math.min(2, (now - prev!.ts) / (30 * 60000));
  const move = (cur: number, to: number) => cur + clamp(to - cur, -0.5 * k30, 1.5 * k30);
  const w = r1(fresh ? rawW : move(prev!.w, rawW));
  const s = r1(fresh ? rawS : move(prev!.s, rawS));
  const parts: string[] = [];
  if (feel != null) {
    const src = day != null ? `오늘 날씨·예보 ${r1(day)}℃와 최근 며칠 ${r1(trm ?? day)}℃ → 체감 ${r1(feel)}℃` : `최근 바깥 흐름 ${r1(feel)}℃`;
    parts.push(Math.abs(climate) >= 0.1 ? `${src}로 포근해서 ${r1(climate)}℃` : `${src}로 쌀쌀해서 날씨 조정 없음`);
  }
  if (crowd < 0) parts.push(crowdNow < 0 ? `매장이 스스로 데워지는 중(40분 +${r1(rise)}℃)이라 ${r1(crowd)}℃` : `손님 열 효과가 천천히 풀리는 중 ${r1(crowd)}℃`);
  const note = `겨울 목표 설정 ${baseW}℃ → 지금 ${w}℃` + (parts.length ? '\n· ' + parts.join('\n· ') : '\n· 조정 없음')
    + (Math.abs(w - rawW) >= 0.1 ? `\n(${r1(rawW)}℃를 향해 ${rawW > w ? '30분에 1.5℃씩 올리는' : '30분에 0.5℃씩 천천히 낮추는'} 중)` : '');
  return { state: { w, s, ts: now, c: r1(crowd), v: 2 }, info: { baseW, baseS, w, s, climate: r1(climate), climateS: r1(climateS), crowd: r1(crowd), trm: trm == null ? null : r1(trm), day: day == null ? null : r1(day), feel: feel == null ? null : r1(feel), note } };
}
