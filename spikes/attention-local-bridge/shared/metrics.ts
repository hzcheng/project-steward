export interface LatencySummary {
    samples: number;
    p95Ms: number | null;
    maxMs: number | null;
}

export function percentile(values: readonly number[], percentileValue: number): number | null {
    if (values.length === 0) {
        return null;
    }
    const sorted = values.slice().sort((left, right) => left - right);
    const index = Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1);
    return sorted[index];
}

export function summarizeLatencies(values: readonly number[]): LatencySummary {
    return {
        samples: values.length,
        p95Ms: percentile(values, 95),
        maxMs: values.length === 0 ? null : Math.max(...values),
    };
}
