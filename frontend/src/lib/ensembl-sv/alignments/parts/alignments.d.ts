import { ScaleLinear } from 'd3';
import { Alignment } from '../types/alignment';
export declare const renderAlignments: ({ alignments, referenceScale, altScale }: {
    alignments: Alignment[];
    referenceScale: ScaleLinear<number, number>;
    altScale: ScaleLinear<number, number>;
}) => import('lit-html').TemplateResult<2>;
