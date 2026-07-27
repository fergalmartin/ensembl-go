export type Variant = {
    name: string;
    type: string;
    consequence: string;
    extent: number;
    location: {
        region_name: string;
        start: number;
        end: number;
    };
};
export type VariantClickEventDetail = Variant & {
    x: number;
    y: number;
};
export type VariantClickEvent = CustomEvent<VariantClickEventDetail>;
