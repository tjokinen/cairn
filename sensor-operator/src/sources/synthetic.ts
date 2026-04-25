/**
 * Plausible synthetic readings for non-weather sensor types.
 * Values drift slowly within the registered range to look realistic.
 */

interface SyntheticProfile {
  min: number;
  max: number;
  typical: number;  // starting value
  drift: number;    // max step size per reading
}

const PROFILES: Record<string, SyntheticProfile> = {
  'air.pm25_ugm3':       { min: 0,  max: 500, typical: 12,  drift: 2   },
  'air.pm10_ugm3':       { min: 0,  max: 600, typical: 20,  drift: 3   },
  'seismic.velocity_mms':{ min: 0,  max: 100, typical: 0.2, drift: 0.1 },
  'radiation.dose_usvh': { min: 0,  max: 10,  typical: 0.1, drift: 0.02 },
};

export class SyntheticSource {
  private current: Map<string, number> = new Map();

  supports(dataType: string): boolean {
    return dataType in PROFILES;
  }

  getValue(dataType: string): number | null {
    const profile = PROFILES[dataType];
    if (!profile) return null;

    let value = this.current.get(dataType) ?? profile.typical;

    // Random walk within range
    const step = (Math.random() * 2 - 1) * profile.drift;
    value = Math.max(profile.min, Math.min(profile.max, value + step));
    this.current.set(dataType, value);

    return value;
  }
}
