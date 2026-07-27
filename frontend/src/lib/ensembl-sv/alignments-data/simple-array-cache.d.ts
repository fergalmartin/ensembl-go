type Interval = {
    start: number;
    end: number;
};
export type FeatureCache<Feature> = {
    add: (params: {
        interval: Interval;
        features: Feature[];
    }) => void;
    get: (params: {
        start: number;
        end: number;
    }) => Feature[];
    getCachedIntervals: () => Interval[];
};
/**
 * This is an extremely naive caching implementation,
 * in which all features are stored in a single array.
 *
 * Features are sorted by their start coordinate.
 */
export declare class SimpleArrayCache<Feature extends object> implements FeatureCache<Feature> {
    #private;
    constructor(params?: {
        getFeatureId?: (feature: Feature) => string | number;
        getFeatureStart?: (feature: Feature) => number;
        getFeatureEnd?: (feature: Feature) => number;
    });
    /**
     * Part of the public api; serves to add features to the cache.
     * The cache receives an array of features, and an interval that these features were requested from.
     * Q: Why is the interval necessary? Why can't it be inferred from start and end coordinates of features?
     * A: Because a feature can be only partly included in the requested interval
     *    (e.g. feature's start is outside) the interval. Thus, if you infer the interval
     *    from the smallest start and the largest end coordinates of all features,
     *    you may wrongly extend the interval beyond the one that was requested,
     *    and may miss small features that are just outside the requested interval.
     * Because a feature may be only partially included in an interval,
     * it is possible to receive the same feature in two (or more) requested intervals.
     * Therefore, storing features in the cache should be accompanied by checking
     * whether a feature with the same id has already been stored.
     */
    add({ interval, features }: {
        interval: Interval;
        features: Feature[];
    }): void;
    /**
     * Part of the public api; serves to retrieve features from the cache
     */
    get({ start, end }: {
        start: number;
        end: number;
    }): Feature[];
    getCachedIntervals(): {
        start: number;
        end: number;
    }[];
}
export {};
