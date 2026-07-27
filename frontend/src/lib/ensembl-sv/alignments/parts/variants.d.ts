import { ScaleLinear } from 'd3';
import { Variant } from '../types/variant';
export declare const renderVariants: ({ variants, scale }: {
    variants: Variant[];
    scale: ScaleLinear<number, number>;
}) => import('lit-html').TemplateResult<2>;
