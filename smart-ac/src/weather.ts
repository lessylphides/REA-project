// 바깥 날씨 (OpenWeatherMap 현재 날씨)
// 무료 API 키 필요: https://openweathermap.org/api  →  OWM_API_KEY 시크릿으로 저장

export interface Weather {
  outdoorTemp: number;   // ℃
  description: string;
}

export async function getWeather(lat: number, lon: number, apiKey: string): Promise<Weather | null> {
  if (!apiKey) return null;
  const url = `https://api.openweathermap.org/data/2.5/weather?`
    + new URLSearchParams({ lat: String(lat), lon: String(lon), units: 'metric', appid: apiKey });
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const j = await res.json<{ main?: { temp?: number }; weather?: { description?: string }[] }>();
    const t = j.main?.temp;
    if (typeof t !== 'number') return null;
    return { outdoorTemp: t, description: j.weather?.[0]?.description ?? '' };
  } catch {
    return null;
  }
}
