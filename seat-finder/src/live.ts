// 실시간 접속(매장 안 손님 캐릭터) · 채팅 · 간단 회원가입에 쓰는 도구 모음

/** 캐릭터 모양: b 옷 색, h 머리 색, s 피부 색, a 모자 (번호) */
export type Look = { b: number; h: number; s: number; a: number };
export const LOOK_MAX = { b: 8, h: 6, s: 4, a: 5 };

export function cleanLook(v: unknown): Look | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>, out = {} as Look;
  for (const k of Object.keys(LOOK_MAX) as (keyof Look)[]) {
    const n = o[k];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n >= LOOK_MAX[k]) return null;
    out[k] = n;
  }
  return out;
}

// 욕설: 글자 사이에 띄어쓰기·점 등을 넣어도 잡히게
const BAD = [
  "시발", "씨발", "씨빨", "시빨", "쉬발", "씨바", "시바", "ㅅㅂ", "ㅆㅂ", "ㅅ발", "병신", "븅신", "ㅂㅅ", "개새끼", "개새기", "개색기", "개색히", "개세끼", "새끼", "ㅅㄲ",
  "좆", "존나", "졸라", "ㅈㄴ", "지랄", "ㅈㄹ", "염병", "썅", "미친놈", "미친년", "미친새", "닥쳐", "꺼져", "엿먹", "니미", "느금", "애미", "애비", "창녀", "걸레", "보지", "자지",
  "fuck", "shit", "bitch", "asshole", "dick", "pussy", "cunt", "bastard", "motherfucker", "fck", "fuk",
];
const GAP = "[\\s.,!?~\\-_*·'\"^`|/\\\\0-9]*";
const BAD_RE = new RegExp(BAD.map((w) => [...w].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(GAP)).join("|"), "gi");
export const maskBad = (s: string) => s.replace(BAD_RE, (m) => "*".repeat([...m.replace(/\s/g, "")].length));
export const hasBad = (s: string) => { BAD_RE.lastIndex = 0; const r = BAD_RE.test(s); BAD_RE.lastIndex = 0; return r; };

/** 이름: 한글·영문·숫자·띄어쓰기 1~10자, 욕설 금지 */
export function cleanName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.normalize("NFC").replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
  const n = [...s].length;
  if (n < 1 || n > 10 || hasBad(s)) return null;
  return s;
}

/** 채팅 글: 한 줄, 120자까지, 욕설은 *** 로 */
export function cleanChat(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = [...v.normalize("NFC").replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim()].slice(0, 120).join("");
  return s ? maskBad(s) : null;
}

export const EMOJIS = ["😀", "😂", "😍", "🥰", "😮", "😢", "👍", "👏", "🙌", "❤️", "🍷", "🍺", "☕", "🎉", "👋", "😴"];

export const randId = (bytes = 9) => {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/[+/=]/g, (c) => (c === "+" ? "-" : c === "/" ? "_" : ""));
};

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** 비밀번호 → PBKDF2-SHA256 (원문은 저장하지 않음) */
export async function hashPw(pw: string, saltB64?: string) {
  const salt = saltB64 ? unb64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256);
  return { salt: b64(salt), hash: b64(new Uint8Array(bits)) };
}

export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
