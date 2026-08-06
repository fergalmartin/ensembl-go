import { css, LitElement, html } from "lit";
import { DataService } from "../alignments-data/data-service.js";
import { isRetryableSvRequestError } from "../../../utils/svRequestRetry.js";
import "./variant-alignments-image.js";

const LOAD_RETRY_LIMIT = 4;
const LOAD_RETRY_BASE_MS = 250;

const expandRequestInterval = ({ start, end, minStart = 1 }) => {
  const span = Math.max(1, end - start);
  const pad = Math.max(200000, Math.round(span * 0.5));
  return {
    start: Math.max(minStart, start - pad),
    end: end + pad
  };
};

const getLoadRetryDelay = (attempt) => {
  return Math.min(4000, LOAD_RETRY_BASE_MS * (2 ** Math.max(0, attempt - 1)));
};

const fetchJson = async (url, signal) => {
  const response = await fetch(url, { signal });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.detail || `SV alignment request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  if (!Array.isArray(data)) {
    throw new Error("SV alignment request returned an invalid response.");
  }
  return data;
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
    browsingControls: { attribute: false },
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
    this.loadGeneration = 0;
    this.loadRetryAttempt = 0;
    this.loadRetryTimer = null;
    this.loadAbortController = null;

    this.forwardVariantEvent = (event) => {
      const forwarded = new CustomEvent(event.type, { detail: event.detail });
      this.dispatchEvent(forwarded);
    };
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.loadGeneration += 1;
    this.loadAbortController?.abort();
    this.loadAbortController = null;
    if (this.loadRetryTimer) {
      clearTimeout(this.loadRetryTimer);
      this.loadRetryTimer = null;
    }
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
        .browsingControls=${this.browsingControls}
        @variant-click=${this.forwardVariantEvent}
      ></ens-sv-alignments-image>
    `;
  }

  async loadData({ retry = false } = {}) {
    if (!retry) {
      this.loadRetryAttempt = 0;
      if (this.loadRetryTimer) {
        clearTimeout(this.loadRetryTimer);
        this.loadRetryTimer = null;
      }
    }

    const generation = ++this.loadGeneration;
    this.loadAbortController?.abort();
    this.loadAbortController = new AbortController();
    this.dispatchLoadingChange(true);
    try {
      const alignments = await this.loadAlignments();
      if (generation !== this.loadGeneration || !this.isConnected) {
        return;
      }
      const variants = await this.loadVariants();
      if (generation !== this.loadGeneration || !this.isConnected) {
        return;
      }
      this.data = {
        alignments,
        variants
      };
      this.loadRetryAttempt = 0;

      if (!this.altStart && !this.altEnd) {
        this.inferAltViewport();
      }
    } catch (error) {
      if (generation !== this.loadGeneration || !this.isConnected) {
        return;
      }
      // A new viewport can inherit an in-flight DataService promise which the
      // previous viewport just aborted. That AbortError belongs to the current
      // load too, so retry it once the old pending request has been released.
      const retryable = error?.name === "AbortError" || isRetryableSvRequestError(error);
      if (retryable && this.loadRetryAttempt < LOAD_RETRY_LIMIT) {
        this.loadRetryAttempt += 1;
        const delay = getLoadRetryDelay(this.loadRetryAttempt);
        this.loadRetryTimer = setTimeout(() => {
          this.loadRetryTimer = null;
          if (generation === this.loadGeneration && this.isConnected) {
            this.loadData({ retry: true });
          }
        }, delay);
        return;
      }
      this.dispatchEvent(new CustomEvent("loading-error", {
        bubbles: true,
        composed: true,
        detail: { message: error?.message || "Failed to load SV alignment data." }
      }));
    } finally {
      if (generation === this.loadGeneration && !this.loadRetryTimer) {
        this.dispatchLoadingChange(false);
      }
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
      getAltWindow: () => this.getAltViewportForFetch(),
      getSignal: () => this.loadAbortController?.signal
    });

    this.altService = createAlignmentService({
      referenceGenomeId: this.referenceGenomeId,
      altGenomeId: this.altGenomeId,
      regionName: this.regionName,
      altRegionName: this.altRegionName,
      endpoint: this.endpoints.alignments,
      isReference: false,
      getReferenceWindow: () => this.getReferenceViewportForFetch(),
      getAltWindow: () => this.getAltViewportForFetch(),
      getSignal: () => this.loadAbortController?.signal
    });

    this.variantService = createVariantService({
      referenceGenomeId: this.referenceGenomeId,
      altGenomeId: this.altGenomeId,
      regionName: this.regionName,
      endpoint: this.endpoints.variants,
      getReferenceWindow: () => this.getReferenceViewportForFetch(),
      getSignal: () => this.loadAbortController?.signal
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
  getReferenceWindow,
  getSignal
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
      return await fetchJson(url, getSignal?.());
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
  getAltWindow,
  getSignal
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
      return await fetchJson(url, getSignal?.());
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
