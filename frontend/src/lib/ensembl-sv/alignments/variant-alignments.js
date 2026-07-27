import { css, LitElement, html } from "lit";
import { DataService } from "../alignments-data/data-service.js";
import "./variant-alignments-image.js";

const expandRequestInterval = ({ start, end, minStart = 1 }) => {
  const span = Math.max(1, end - start);
  const pad = Math.max(200000, Math.round(span * 0.5));
  return {
    start: Math.max(minStart, start - pad),
    end: end + pad
  };
};

export class VariantAlignments extends LitElement {
  static properties = {
    referenceGenomeId: { type: String },
    altGenomeId: { type: String },
    start: { type: Number },
    end: { type: Number },
    regionName: { type: String },
    altRegionName: { type: String },
    regionLength: { type: Number },
    altStart: { type: Number },
    altEnd: { type: Number },
    altRegionLength: { type: Number },
    loadingStrategy: { type: String },
    displayOrder: { type: String },
    linkedViewports: { type: Boolean },
    imageHeight: { type: Number },
    endpoints: { type: Object },
    data: { state: true }
  };

  static styles = css`
    :host {
      display: block;
    }
  `;

  constructor() {
    super();
    this.referenceGenomeId = null;
    this.altGenomeId = null;
    this.start = 0;
    this.end = 0;
    this.regionName = "";
    this.altRegionName = "";
    this.regionLength = 0;
    this.altStart = 0;
    this.altEnd = 0;
    this.altRegionLength = 0;
    this.loadingStrategy = "eager";
    this.displayOrder = "reference-top";
    this.linkedViewports = false;
    this.imageHeight = 159;
    this.endpoints = null;
    this.data = null;

    this.referenceService = null;
    this.altService = null;
    this.variantService = null;

    this.forwardVariantEvent = (event) => {
      const forwarded = new CustomEvent(event.type, { detail: event.detail });
      this.dispatchEvent(forwarded);
    };
  }

  willUpdate(changed) {
    const serviceChanged =
      changed.has("referenceGenomeId")
      || changed.has("altGenomeId")
      || changed.has("regionName")
      || changed.has("altRegionName")
      || changed.has("endpoints")
      || changed.has("loadingStrategy");

    if (
      serviceChanged
    ) {
      this.buildServices();
    }

    const viewportChanged = (
      changed.has("start")
      || changed.has("end")
      || changed.has("altStart")
      || changed.has("altEnd")
      || changed.has("altRegionName")
      || changed.has("regionLength")
      || changed.has("altRegionLength")
      || changed.has("loadingStrategy")
    );

    const eagerViewportOnlyChange = (
      this.loadingStrategy === "eager"
      && !serviceChanged
      && Boolean(this.data)
    );

    if (viewportChanged && !eagerViewportOnlyChange) {
      this.loadData();
    }
  }

  render() {
    return html`
      <ens-sv-alignments-image
        .start=${this.start}
        .end=${this.end}
        .altStart=${this.altStart}
        .altEnd=${this.altEnd}
        .regionLength=${this.regionLength}
        .regionName=${this.regionName}
        .data=${this.data}
        .altRegionLength=${this.altRegionLength}
        .displayOrder=${this.displayOrder}
        .imageHeight=${this.imageHeight}
        @variant-click=${this.forwardVariantEvent}
      ></ens-sv-alignments-image>
    `;
  }

  async loadData() {
    this.dispatchLoadingChange(true);
    try {
      const alignments = await this.loadAlignments();
      const variants = await this.loadVariants();
      this.data = {
        alignments,
        variants
      };

      if (!this.altStart && !this.altEnd) {
        this.inferAltViewport();
      }
    } finally {
      this.dispatchLoadingChange(false);
    }
  }

  dispatchLoadingChange(loading) {
    this.dispatchEvent(new CustomEvent("loading-change", {
      bubbles: true,
      composed: true,
      detail: { loading: Boolean(loading) }
    }));
  }

  resolveReferenceRequestInterval() {
    if (this.loadingStrategy === "eager" && Number.isFinite(this.regionLength) && this.regionLength > 1) {
      return { start: 1, end: Math.round(this.regionLength) };
    }
    return expandRequestInterval({
      start: this.start,
      end: this.end,
      minStart: 1
    });
  }

  resolveAltRequestInterval() {
    if (this.loadingStrategy === "eager" && Number.isFinite(this.altRegionLength) && this.altRegionLength > 1) {
      return { start: 1, end: Math.round(this.altRegionLength) };
    }
    if (!this.altStart || !this.altEnd) {
      return null;
    }
    return expandRequestInterval({
      start: this.altStart,
      end: this.altEnd,
      minStart: 1
    });
  }

  getReferenceViewportForFetch() {
    if (this.loadingStrategy === "eager" && Number.isFinite(this.regionLength) && this.regionLength > 1) {
      return {
        regionName: this.regionName,
        start: 1,
        end: Math.round(this.regionLength)
      };
    }
    return {
      regionName: this.regionName,
      start: this.start,
      end: this.end
    };
  }

  getAltViewportForFetch() {
    if (this.loadingStrategy === "eager" && Number.isFinite(this.altRegionLength) && this.altRegionLength > 1) {
      return {
        regionName: this.altRegionName || this.regionName,
        start: 1,
        end: Math.round(this.altRegionLength)
      };
    }
    return this.altStart && this.altEnd ? {
      regionName: this.altRegionName || this.regionName,
      start: this.altStart,
      end: this.altEnd
    } : null;
  }

  async loadVariants() {
    if (!this.variantService) {
      return [];
    }

    const interval = this.resolveReferenceRequestInterval();

    return await this.variantService.get(interval);
  }

  async loadAlignments() {
    if (!this.referenceService || !this.altService) {
      return [];
    }

    const refInterval = this.resolveReferenceRequestInterval();

    const referenceAlignments = await this.referenceService.get(refInterval);
    let altAlignments = [];

    const altInterval = this.resolveAltRequestInterval();
    if (altInterval) {
      altAlignments = await this.altService.get(altInterval);
    }

    const seenIds = new Set(referenceAlignments.map((alignment) => alignment.id));
    const merged = [...referenceAlignments];
    for (const alignment of altAlignments) {
      if (seenIds.has(alignment.id)) continue;
      merged.push(alignment);
    }

    merged.sort((a, b) => a.reference.start - b.reference.start);
    return merged;
  }

  buildServices() {
    if (!this.referenceGenomeId || !this.altGenomeId || !this.regionName || !this.endpoints) {
      return;
    }

    this.referenceService = createAlignmentService({
      referenceGenomeId: this.referenceGenomeId,
      altGenomeId: this.altGenomeId,
      regionName: this.regionName,
      altRegionName: this.altRegionName,
      endpoint: this.endpoints.alignments,
      isReference: true,
      getReferenceWindow: () => this.getReferenceViewportForFetch(),
      getAltWindow: () => this.getAltViewportForFetch()
    });

    this.altService = createAlignmentService({
      referenceGenomeId: this.referenceGenomeId,
      altGenomeId: this.altGenomeId,
      regionName: this.regionName,
      altRegionName: this.altRegionName,
      endpoint: this.endpoints.alignments,
      isReference: false,
      getReferenceWindow: () => this.getReferenceViewportForFetch(),
      getAltWindow: () => this.getAltViewportForFetch()
    });

    this.variantService = createVariantService({
      referenceGenomeId: this.referenceGenomeId,
      altGenomeId: this.altGenomeId,
      regionName: this.regionName,
      endpoint: this.endpoints.variants,
      getReferenceWindow: () => this.getReferenceViewportForFetch()
    });
  }

  inferAltViewport() {
    const data = this.data;
    if (!data?.alignments?.length) {
      return;
    }

    let bestAlignment = null;
    for (const alignment of data.alignments) {
      const refStart = alignment.reference.start;
      const refEnd = alignment.reference.start + alignment.reference.length - 1;
      if (!bestAlignment || (refStart <= this.start && refEnd > this.start)) {
        bestAlignment = alignment;
      }
    }

    if (!bestAlignment) {
      return;
    }

    const span = this.end - this.start + 1;
    const offset = bestAlignment.reference.start + bestAlignment.reference.length - 1 - this.start;
    const altStart = bestAlignment.alt.start + bestAlignment.alt.length - 1 - offset;
    const altEnd = altStart + span;
    const detail = {
      reference: {
        start: this.start,
        end: this.end
      },
      alt: {
        start: altStart,
        end: altEnd
      }
    };

    this.dispatchEvent(new CustomEvent("viewport-change-end", {
      bubbles: true,
      composed: true,
      detail
    }));

    this.altStart = altStart;
    this.altEnd = altEnd;
  }
}

const createVariantService = ({
  referenceGenomeId,
  altGenomeId,
  regionName,
  altRegionName,
  endpoint,
  getReferenceWindow
}) => {
  return new DataService({
    loader: async (interval) => {
      const params = new URLSearchParams();
      params.append("reference_genome_id", referenceGenomeId);
      params.append("alt_genome_id", altGenomeId);
      params.append("viewport", `${regionName}:${interval.start}-${interval.end}`);

      const referenceWindow = typeof getReferenceWindow === "function" ? getReferenceWindow() : null;
      if (referenceWindow && Number.isFinite(referenceWindow.start) && Number.isFinite(referenceWindow.end)) {
        params.set("reference_viewport", `${referenceWindow.regionName}:${referenceWindow.start}-${referenceWindow.end}`);
      }

      const url = appendEndpointParams(endpoint, params);
      return await fetch(url).then((response) => response.json());
    },
    getFeatureId: (variant) => variant.name,
    getFeatureStart: (variant) => variant.location.start,
    getFeatureEnd: (variant) => variant.location.end
  });
};

const createAlignmentService = ({
  referenceGenomeId,
  altGenomeId,
  regionName,
  altRegionName,
  endpoint,
  isReference,
  getReferenceWindow,
  getAltWindow
}) => {
  const getFeatureStart = isReference
    ? (alignment) => alignment.reference.start
    : (alignment) => alignment.alt.start;
  const getFeatureEnd = isReference
    ? (alignment) => alignment.reference.start + alignment.reference.length - 1
    : (alignment) => alignment.alt.start + alignment.alt.length - 1;

  return new DataService({
    loader: async (interval) => {
      const params = new URLSearchParams();
      const queriedViewportKey = isReference ? "reference_viewport" : "alt_viewport";
      params.append("reference_genome_id", referenceGenomeId);
      params.append("alt_genome_id", altGenomeId);
      params.append("query_side", isReference ? "reference" : "alt");
      params.append(queriedViewportKey, `${isReference ? regionName : (altRegionName || regionName)}:${interval.start}-${interval.end}`);

      const referenceWindow = typeof getReferenceWindow === "function" ? getReferenceWindow() : null;
      const altWindow = typeof getAltWindow === "function" ? getAltWindow() : null;
      if (referenceWindow && Number.isFinite(referenceWindow.start) && Number.isFinite(referenceWindow.end)) {
        const expanded = expandRequestInterval({
          start: referenceWindow.start,
          end: referenceWindow.end,
          minStart: 1
        });
        params.set("reference_viewport", `${referenceWindow.regionName}:${expanded.start}-${expanded.end}`);
      }
      if (altWindow && Number.isFinite(altWindow.start) && Number.isFinite(altWindow.end)) {
        const expanded = expandRequestInterval({
          start: altWindow.start,
          end: altWindow.end,
          minStart: 1
        });
        params.set("alt_viewport", `${altWindow.regionName}:${expanded.start}-${expanded.end}`);
      }

      if (isReference) {
        params.set("reference_viewport", `${regionName}:${interval.start}-${interval.end}`);
      } else {
        params.set("alt_viewport", `${altRegionName || regionName}:${interval.start}-${interval.end}`);
      }

      const url = appendEndpointParams(endpoint, params);
      return await fetch(url).then((response) => response.json());
    },
    getFeatureStart,
    getFeatureEnd,
    cache: void 0
  });
};

const appendEndpointParams = (endpoint, params) => {
  const query = decodeURIComponent(params.toString());
  if (!query) return endpoint;
  return `${endpoint}${endpoint.includes("?") ? "&" : "?"}${query}`;
};

if (!customElements.get("ens-sv-alignments")) {
  customElements.define("ens-sv-alignments", VariantAlignments);
}
