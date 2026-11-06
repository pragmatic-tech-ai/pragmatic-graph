import assert from 'node:assert/strict';

/**
 * Load-tolerant performance check: times the same work at size n and 10n and asserts the time ratio
 * stays well under the quadratic ~100 (MaxRatio), plus a generous absolute ceiling for the large run.
 * Robust to a slow machine, because both runs slow down together.
 */
export class Linearity
{
    public static readonly Factor = 10;
    public static readonly MaxRatio = 25;
    public static readonly CeilingMs = 20000;
    /** Small-run times below this are floored, so timer granularity cannot inflate the ratio. */
    public static readonly FloorMs = 5;
    private static readonly Prefix = '[linearity] ';
    private static readonly Superlinear = 'superlinear: ';
    private static readonly TooSlow = 'too slow: ';
    private static readonly AtSmall = ' ms at n=';
    private static readonly AtLarge = ' ms at ';
    private static readonly RatioText = 'n, ratio ';
    private static readonly Ms = ' ms';

    /**
     * Runs work(small) then work(small * Factor), each `repeats` times keeping the fastest (so a GC pause
     * or a busy machine in one run cannot fake superlinearity); `work` must tolerate repeating. Returns
     * both durations in ms after asserting the bounds.
     */
    public static async Check(label: string, small: number, work: (n: number) => Promise<void> | void, repeats = 1): Promise<[number, number]>
    {
        const smallMs = await Linearity.Fastest(() => work(small), repeats);
        const largeMs = await Linearity.Fastest(() => work(small * Linearity.Factor), repeats);
        const ratio = largeMs / Math.max(smallMs, Linearity.FloorMs);
        const detail = label + ': ' + smallMs.toFixed(1) + Linearity.AtSmall + small + ', ' + largeMs.toFixed(1) + Linearity.AtLarge + Linearity.Factor + Linearity.RatioText + ratio.toFixed(1);
        console.log(Linearity.Prefix + detail);
        assert.ok(ratio < Linearity.MaxRatio, Linearity.Superlinear + detail);
        assert.ok(largeMs < Linearity.CeilingMs, Linearity.TooSlow + detail + Linearity.Ms);
        return [smallMs, largeMs];
    }

    private static async Fastest(work: () => Promise<void> | void, repeats: number): Promise<number>
    {
        let best = Number.POSITIVE_INFINITY;
        for (let i = 0; i < repeats; i++)
        {
            const started = performance.now();
            await work();
            best = Math.min(best, performance.now() - started);
        }
        return best;
    }
}
