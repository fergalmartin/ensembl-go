export type Interval = {
    start: number;
    end: number;
};
/**
 * Given a set of intervals, and another interval (a query interval),
 * find which parts of the query interval overlap the intervals in the set,
 * and which parts don't.
 * Returns an object with two fields:
 * - overlappingIntervals: array of intervals
 *   that are parts of the query interval that overlap the intervals in the set
 * - nonOverlappingIntervals: array of intervals within the query interval
 *   that do not overlap with the intervals in the set
 */
export declare const checkIntervalOverlap: ({ intervals, queryInterval }: {
    intervals: Interval[];
    queryInterval: Interval;
}) => {
    overlappingIntervals: Interval[];
    nonOverlappingIntervals: Interval[];
};
export declare const compareIntervals: ({ referenceInterval, queryInterval }: {
    referenceInterval: Interval;
    queryInterval: Interval;
}) => {
    intersecting: Interval | null;
    nonIntersecting: Interval[];
};
