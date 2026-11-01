export interface MethodStat {
  latencyMs: number;
  tailMs: number;
  errorRate: number;
  samples: number;
}

export function emptyStat(): MethodStat {
  return { latencyMs: 0, tailMs: 0, errorRate: 0, samples: 0 };
}

export function observe(stat: MethodStat, latencyMs: number, ok: boolean): void {
  const latency = Math.max(0, latencyMs);
  if (stat.samples === 0) {
    stat.latencyMs = ok ? latency : 0;
    stat.tailMs = latency;
    stat.errorRate = ok ? 0 : 1;
    stat.samples = 1;
    return;
  }

  if (ok) {
    const alpha = latency > stat.latencyMs ? 0.4 : 0.2;
    stat.latencyMs += alpha * (latency - stat.latencyMs);
  }
  const tailAlpha = latency > stat.tailMs ? 0.5 : 0.05;
  stat.tailMs += tailAlpha * (latency - stat.tailMs);
  stat.errorRate += 0.3 * ((ok ? 0 : 1) - stat.errorRate);
  stat.samples += 1;
}

export function serviceMs(stat: MethodStat, priorMs = 250): number {
  if (stat.samples === 0) return priorMs;
  const measured = stat.latencyMs > 0 ? 0.6 * stat.latencyMs + 0.4 * stat.tailMs : stat.tailMs;
  const confidence = Math.min(1, stat.samples / 5);
  return confidence * measured + (1 - confidence) * priorMs;
}

export interface ScoreInput {
  global: MethodStat;
  method?: MethodStat;
  slotLag?: number;
  maxSlotLag: number;
  weight: number;
}

export function endpointScore(input: ScoreInput): number {
  let service = serviceMs(input.global);
  let errorRate = input.global.errorRate;
  if (input.method && input.method.samples > 0) {
    const blend = Math.min(1, input.method.samples / 3);
    service = blend * serviceMs(input.method) + (1 - blend) * service;
    errorRate = blend * input.method.errorRate + (1 - blend) * errorRate;
  }
  const lag = Math.max(0, (input.slotLag ?? 0) - input.maxSlotLag);
  const lagPenalty = 1 + lag / 100;
  return (service * (1 + 8 * errorRate) * lagPenalty) / Math.max(0.01, input.weight);
}
