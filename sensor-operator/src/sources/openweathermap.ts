import axios from 'axios';

// OWM data type → field mapping
const OWM_FIELDS: Record<string, (data: OWMResponse) => number> = {
  'weather.temperature_c':       (d) => d.main.temp,
  'weather.humidity_pct':        (d) => d.main.humidity,
  'weather.precipitation_mm_h':  (d) => d.rain?.['1h'] ?? 0,
  'weather.wind_ms':             (d) => d.wind.speed,
};

interface OWMResponse {
  main:  { temp: number; humidity: number };
  wind:  { speed: number };
  rain?: { '1h'?: number };
}

interface CachedReading {
  raw:       OWMResponse;
  fetchedAt: number;
}

export class OpenWeatherMapSource {
  private cache: CachedReading | null = null;
  private biasOffset = 0;
  private noiseStddev: number;
  private lat: number;
  private lon: number;
  private apiKey: string;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(lat: number, lon: number, noiseStddev: number) {
    this.lat        = lat;
    this.lon        = lon;
    this.noiseStddev = noiseStddev;
    this.apiKey     = requireEnv('OPENWEATHERMAP_API_KEY');
  }

  /** Fetch once immediately, then refresh every 60s. */
  start(): void {
    this.fetch().catch(console.error);
    this.intervalHandle = setInterval(() => this.fetch().catch(console.error), 60_000);
  }

  stop(): void {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
  }

  setBiasOffset(offset: number): void {
    this.biasOffset = offset;
  }

  supports(dataType: string): boolean {
    return dataType in OWM_FIELDS;
  }

  getValue(dataType: string): number | null {
    if (!this.cache) return null;
    const extractor = OWM_FIELDS[dataType];
    if (!extractor) return null;

    const raw   = extractor(this.cache.raw);
    const noise = gaussianNoise(this.noiseStddev);
    return raw + noise + this.biasOffset;
  }

  private async fetch(): Promise<void> {
    const url = `https://api.openweathermap.org/data/2.5/weather` +
      `?lat=${this.lat}&lon=${this.lon}&units=metric&appid=${this.apiKey}`;
    const res = await axios.get<OWMResponse>(url, { timeout: 10_000 });
    this.cache = { raw: res.data, fetchedAt: Date.now() };
  }
}

// Box-Muller transform for Gaussian noise
function gaussianNoise(stddev: number): number {
  if (stddev === 0) return 0;
  const u1 = Math.random();
  const u2 = Math.random();
  const z  = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return z * stddev;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}
