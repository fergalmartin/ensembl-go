import { LitElement, PropertyValues } from 'lit';
import { InputData as VariantAlignmentsData } from './variant-alignments-image';
export type Endpoints = {
    variants: string;
    alignments: string;
};
/**
 * The purpose of this component is to fetch and provide data to ens-sv-alignments
 */
export declare class VariantAlignments extends LitElement {
    #private;
    static styles: import('lit').CSSResult;
    referenceGenomeId: string | null;
    altGenomeId: string | null;
    start: number;
    end: number;
    regionName: string;
    altRegionName: string;
    regionLength: number;
    altStart: number;
    altEnd: number;
    altRegionLength: number;
    endpoints: Endpoints | null;
    data: VariantAlignmentsData;
    willUpdate(changedProperties: PropertyValues): void;
    render(): import('lit-html').TemplateResult<1>;
}
declare global {
    interface HTMLElementTagNameMap {
        'ens-sv-alignments': VariantAlignments;
    }
}
