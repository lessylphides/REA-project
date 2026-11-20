// 바깥 날씨 (OpenWeatherMap 현재 날씨, 한국어)
// 무료 API 키 필요: https://openweathermap.org/api  →  OWM_API_KEY

export interface Weather {
  outdoorTemp: number;      // ℃
  feelsLike: number | null; // 체감 ℃
  tempMin: number | null;
  tempMax: number | null;
  humidity: number | null;  // %
  windSpeed: number | null; // m/s
  description: string;      // 예: "맑음", "구름조금"
  emoji: string;
}

function emojiFor(id: number, icon: string): string {
  const night = typeof icon === 'string' && icon.endsWith('n');
  if (id === 800) return night ? '🌙' : '☀️';
  if (id === 801 || id === 802) return night ? '☁️' : '🌤️';
  if (id >= 803) return '☁️';
  if (id >= 200 && id < 300) return '⛈️';
  if (id >= 300 && id < 400) return '🌦️';
  if (id >= 500 && id < 600) return '🌧️';
  if (id >= 600 && id < 700) return '🌨️';
  if (id >= 700 && id < 800) return '🌫️';
  return '🌡️';
}

export async function getWeather(lat: number, lon: number, apiKey: string): Promise<Weather | null> {
  if (!apiKey) return null;
  const url = 'https://api.openweathermap.org/data/2.5/weather?'
    + new URLSearchParams({ lat: String(lat), lon: String(lon), units: 'metric', lang: 'kr', appid: apiKey });
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const j = await res.json<{
      main?: { temp?: number; feels_like?: number; temp_min?: number; temp_max?: number; humidity?: number };
      wind?: { speed?: number };
      weather?: { id?: number; description?: string; icon?: string }[];
    }>();
    const t = j.main?.temp;
    if (typeof t !== 'number') return null;
    const w = j.weather?.[0];
    return {
      outdoorTemp: t,
      feelsLike: j.main?.feels_like ?? null,
      tempMin: j.main?.temp_min ?? null,
      tempMax: j.main?.temp_max ?? null,
      humidity: j.main?.humidity ?? null,
      windSpeed: j.wind?.speed ?? null,
      description: w?.description ?? '',
      emoji: emojiFor(w?.id ?? 0, w?.icon ?? ''),
    };
  } catch {
    return null;
  }
}
