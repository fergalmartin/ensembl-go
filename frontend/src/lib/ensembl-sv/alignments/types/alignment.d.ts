type Strand = 'forward' | 'reverse';
export type Alignment = {
    id: string;
    reference: {
        region_name: string;
        start: number;
        strand: Strand;
        length: number;
    };
    alt: {
        region_name: string;
        start: number;
        strand: Strand;
        length: number;
    };
};
export {};
