import { LitElement } from 'lit';
import { ScaleLinear } from 'd3';
import { Variant } from './types/variant';
import { Alignment } from './types/alignment';
export type InputData = {
    variants: Variant[];
    alignments: Alignment[];
};
export declare class VariantAlignmentsImage extends LitElement {
    #private;
    static styles: import('lit').CSSResult;
    start: number;
    end: number;
    regionName: string;
    regionLength: number;
    altStart: number;
    altEnd: number;
    altRegionLength: number;
    data: InputData | null;
    imageWidth: number;
    scale: ScaleLinear<number, number> | null;
    altSequenceScale: ScaleLinear<number, number> | null;
    constructor();
    connectedCallback(): void;
    willUpdate(): void;
    scheduleUpdate(): Promise<void>;
    observeHostSize: () => void;
    render(): import('lit-html').TemplateResult<1> | undefined;
    renderVariants(): import('lit-html').TemplateResult<2>;
    renderAlignments(): import('lit-html').TemplateResult<2>;
    renderTopRuler(): import('lit-html').TemplateResult<2>;
    renderBottomRuler(): import('lit-html').TemplateResult<2>;
}
declare global {
    interface HTMLElementTagNameMap {
        'ens-sv-alignments-image': VariantAlignmentsImage;
    }
}
