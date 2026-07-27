/**
 * Helper functions to create region intervals that should be requested.
 * The purpose of such helpers is to avoid requesting multiple intervals
 * that mostly overlap.
 *
 * One can think of various strategies for requesting features:
 * - Use a constant step - e.g. 1 megabase -
 *   and round up the input interval to the nearest step
 *
 *
 */
export declare const getStepBasedInterval: ({ start, end, step }: {
    start: number;
    end: number;
    step: number;
}) => {
    start: number;
    end: number;
};
