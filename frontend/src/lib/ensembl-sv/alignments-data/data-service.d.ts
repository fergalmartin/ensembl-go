import { FeatureCache } from './simple-array-cache';
type MinimalLoaderParams = {
    start: number;
    end: number;
};
export declare class DataService<Feature extends object, LoaderParams extends MinimalLoaderParams = MinimalLoaderParams> {
    #private;
    constructor({ loader, getFeatureId, getFeatureStart, getFeatureEnd, cache }: {
        loader: (params: LoaderParams) => Promise<Feature[]>;
        getFeatureId?: (feature: Feature) => string | number;
        getFeatureStart?: (feature: Feature) => number;
        getFeatureEnd?: (feature: Feature) => number;
        cache?: FeatureCache<Feature>;
    });
    get(params: LoaderParams): Promise<Feature[]>;
}
export {};
