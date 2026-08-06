import { LitElement, html, css } from "lit";
import { scaleLinear } from "d3";
import {
  IMAGE_HEIGHT,
  RULER_HEIGHT,
  ALIGNMENT_AREA_HEIGHT,
  COLORS,
  VARIANT_HEIGHT,
  STRUCTURAL_VARIANT_LENGTH_CUTOFF,
} from "./constants/constants.js";
import DragController from "./controllers/drag-controller.js";
import { addAlignmentRangeMatches, buildAlignmentRangeIndex } from "./alignment-range-index.js";

const formatter = new Intl.NumberFormat("en-US");

function deriveVariantDisplaySpans(alignments) {
  const safeAlignments = Array.isArray(alignments) ? [...alignments] : [];
  safeAlignments.sort((a, b) => {
    const aStart = Number(a?.reference?.start ?? 0);
    const bStart = Number(b?.reference?.start ?? 0);
    if (aStart !== bStart) return aStart - bStart;
    return Number(a?.alt?.start ?? 0) - Number(b?.alt?.start ?? 0);
  });

  const spans = [];
  for (let i = 0; i < safeAlignments.length - 1; i += 1) {
    const previous = safeAlignments[i];
    const current = safeAlignments[i + 1];
    const prevReverse = previous.reference.strand !== previous.alt.strand;
    const currReverse = current.reference.strand !== current.alt.strand;
    if (prevReverse !== currReverse) continue;

    const prevRefEnd = Number(previous.reference.start) + Number(previous.reference.length);
    const currRefStart = Number(current.reference.start);
    const refGap = Math.max(0, currRefStart - prevRefEnd);

    const prevAltEnd = Number(previous.alt.start) + Number(previous.alt.length);
    const currAltStart = Number(current.alt.start);
    const currAltEnd = Number(current.alt.start) + Number(current.alt.length);
    const prevAltStart = Number(previous.alt.start);

    const altGapStart = prevReverse ? currAltEnd : prevAltEnd;
    const altGapEnd = prevReverse ? prevAltStart : currAltStart;
    const altGap = Math.max(0, altGapEnd - altGapStart);

    let type = "";
    if (refGap === 1 && altGap === 1) {
      type = "snv";
    } else if ((altGap - refGap) >= 1) {
      type = "insertion";
    } else if ((altGap - refGap) <= -1) {
      type = "deletion";
    } else {
      continue;
    }

    spans.push({
      type,
      referenceStart: prevRefEnd,
      referenceEnd: Math.max(prevRefEnd, currRefStart),
      altStart: Math.min(altGapStart, altGapEnd),
      altEnd: Math.max(altGapStart, altGapEnd),
    });
  }
  return spans;
}

function getVariantDisplaySpan(variant, displaySpans) {
  if (!Array.isArray(displaySpans) || !displaySpans.length) return null;
  const variantType = String(variant?.type || "");
  const variantStart = Number(variant?.location?.start ?? NaN);
  const variantEndExclusive = Number(variant?.location?.end ?? NaN) + 1;
  if (!Number.isFinite(variantStart) || !Number.isFinite(variantEndExclusive)) return null;

  let best = null;
  let bestScore = Infinity;
  for (const span of displaySpans) {
    if (span.type !== variantType) continue;
    let score = Math.abs(span.referenceStart - variantStart);
    if (variantType === "deletion" || variantType === "snv") {
      score += Math.abs(span.referenceEnd - variantEndExclusive);
    } else if (variantType === "insertion") {
      score += Math.abs(span.referenceStart - (variantStart + 1));
    }
    if (score < bestScore) {
      best = span;
      bestScore = score;
    }
  }
  return best;
}

function spanHasMatchingVariant(span, variants) {
  const safeVariants = Array.isArray(variants) ? variants : [];
  for (const variant of safeVariants) {
    if (String(variant?.type || "") !== span.type) continue;
    const start = Number(variant?.location?.start ?? NaN);
    const endExclusive = Number(variant?.location?.end ?? NaN) + 1;
    if (!Number.isFinite(start) || !Number.isFinite(endExclusive)) continue;

    if (span.type === "deletion" || span.type === "snv") {
      if (Math.abs(start - span.referenceStart) <= 1 && Math.abs(endExclusive - span.referenceEnd) <= 1) {
        return true;
      }
    } else if (span.type === "insertion") {
      if (Math.abs(start - Math.max(1, span.referenceStart - 1)) <= 1) {
        return true;
      }
    }
  }
  return false;
}

function buildFallbackVariantsFromDisplaySpans(displaySpans, regionName = "") {
  const safeSpans = Array.isArray(displaySpans) ? displaySpans : [];
  return safeSpans.map((span, index) => {
    const refLength = Math.max(0, span.referenceEnd - span.referenceStart);
    const altLength = Math.max(0, span.altEnd - span.altStart);
    const anchorStart = span.type === "insertion"
      ? Math.max(1, span.referenceStart - 1)
      : span.referenceStart;
    const anchorEnd = span.type === "insertion"
      ? anchorStart
      : Math.max(anchorStart, span.referenceEnd - 1);

    return {
      name: `derived-gap-${span.type}-${anchorStart}-${index}`,
      type: span.type,
      consequence: span.type === "deletion"
        ? "Deletion or loss"
        : span.type === "insertion"
          ? "Gain or insertion"
          : "SNV",
      extent: Math.max(1, refLength, altLength),
      ref_length: refLength,
      alt_length: altLength,
      location: {
        region_name: regionName,
        start: anchorStart,
        end: anchorEnd,
      },
      _derivedDisplaySpan: span,
    };
  });
}

function buildRenderableVariants(variants, displaySpans) {
  const safeVariants = Array.isArray(variants) ? variants : [];
  return safeVariants.map((variant) => {
    const markerOnBottom = variant.type === "insertion";
    const displaySpan = variant._derivedDisplaySpan || getVariantDisplaySpan(variant, displaySpans);
    const spanStart = displaySpan
      ? (markerOnBottom ? displaySpan.altStart : displaySpan.referenceStart)
      : Number(variant?.location?.start ?? 0);
    const spanEnd = displaySpan
      ? (markerOnBottom ? displaySpan.altEnd : displaySpan.referenceEnd)
      : (Number(variant?.location?.end ?? 0) + 1);

    return {
      ...variant,
      _markerOnBottom: markerOnBottom,
      _renderSpanStart: spanStart,
      _renderSpanEnd: spanEnd,
    };
  });
}

function mergeAlignments(alignments, referenceScale, altScale) {
  const out = [];
  for (const a of alignments) {
    if (!out.length) { out.push({ ...a, reference: { ...a.reference }, alt: { ...a.alt } }); continue; }
    const prev = out.at(-1);
    const isInvPrev = prev.reference.strand !== prev.alt.strand;
    const isInvCurr = a.reference.strand !== a.alt.strand;
    if (isInvPrev || isInvCurr) { out.push({ ...a, reference: { ...a.reference }, alt: { ...a.alt } }); continue; }
    const pRefEndPx = referenceScale(prev.reference.start + prev.reference.length);
    const cRefStartPx = referenceScale(a.reference.start);
    const pAltEndPx = altScale(prev.alt.start + prev.alt.length);
    const cAltStartPx = altScale(a.alt.start);
    if (cRefStartPx - pRefEndPx >= 1 || cAltStartPx - pAltEndPx >= 1) {
      out.push({ ...a, reference: { ...a.reference }, alt: { ...a.alt } });
      continue;
    }
    const newRefLen = a.reference.start + a.reference.length - prev.reference.start;
    const newAltLen = a.alt.start + a.alt.length - prev.alt.start;
    if (newRefLen < 0 || newAltLen < 0) continue;
    prev.reference.length = newRefLen;
    prev.alt.length = newAltLen;
  }
  return out;
}

class VariantAlignmentsImage extends LitElement {
  static properties = {
    start: { type: Number },
    end: { type: Number },
    regionName: { type: String },
    regionLength: { type: Number },
    altStart: { type: Number },
    altEnd: { type: Number },
    altRegionLength: { type: Number },
    displayOrder: { type: String },
    imageHeight: { type: Number },
    data: { type: Object },
    // Resolved browsing-control scheme, set as a property by the React host.
    // Never an attribute — it is a plain object.
    browsingControls: { attribute: false },
    imageWidth: { state: true },
  };

  static styles = css`
    :host {
      display: block;
      touch-action: none;
    }
    canvas {
      display: block;
      user-select: none;
      touch-action: none;
    }
  `;

  constructor() {
    super();
    this.start = 0;
    this.end = 0;
    this.regionName = "";
    this.regionLength = 0;
    this.altStart = 0;
    this.altEnd = 0;
    this.altRegionLength = 0;
    this.displayOrder = "reference-top";
    this.imageHeight = IMAGE_HEIGHT;
    this.data = null;
    this.browsingControls = null;
    this.imageWidth = 0;
    this.scale = null;
    this.altSequenceScale = null;
    this._variantRects = [];
    this._hoveredVariant = null;
    this._cachedDisplaySpans = [];
    this._cachedVariants = [];
    this._cachedRenderableVariants = [];
    this._cachedAlignmentGeometry = null;
    new DragController(this);
  }

  connectedCallback() {
    super.connectedCallback();
    new ResizeObserver((entries) => {
      const [e] = entries;
      this.imageWidth = e.contentRect.width;
    }).observe(this);
  }

  willUpdate(changedProperties) {
    if (this.imageWidth) {
      this.scale = scaleLinear()
        .domain([this.start, this.end])
        .rangeRound([0, this.imageWidth]);
      this.altSequenceScale = scaleLinear()
        .domain([this.altStart, this.altEnd])
        .rangeRound([0, this.imageWidth]);
    }

    if (changedProperties.has("data")) {
      const alignments = Array.isArray(this.data?.alignments) ? this.data.alignments : [];
      const count = alignments.length;
      const refStarts = new Float64Array(count);
      const refEnds = new Float64Array(count);
      const altStarts = new Float64Array(count);
      const altEnds = new Float64Array(count);
      for (let index = 0; index < count; index += 1) {
        const alignment = alignments[index];
        const refStart = Number(alignment?.reference?.start) || 0;
        const altStart = Number(alignment?.alt?.start) || 0;
        refStarts[index] = refStart;
        refEnds[index] = refStart + (Number(alignment?.reference?.length) || 0);
        altStarts[index] = altStart;
        altEnds[index] = altStart + (Number(alignment?.alt?.length) || 0);
      }
      this._cachedAlignmentGeometry = {
        alignments,
        refStarts,
        refEnds,
        altStarts,
        altEnds,
        rangeIndexes: {
          refOverlap: buildAlignmentRangeIndex(refStarts, refEnds),
          altOverlap: buildAlignmentRangeIndex(altStarts, altEnds),
          altStartRefEnd: buildAlignmentRangeIndex(altStarts, refEnds),
          refStartAltEnd: buildAlignmentRangeIndex(refStarts, altEnds),
        },
      };
      this._cachedDisplaySpans = deriveVariantDisplaySpans(alignments);
      const backendVariants = Array.isArray(this.data?.variants) ? this.data.variants : [];
      const fallbackVariants = buildFallbackVariantsFromDisplaySpans(
        this._cachedDisplaySpans.filter((span) => !spanHasMatchingVariant(span, backendVariants)),
        this.regionName
      );
      this._cachedVariants = [...backendVariants, ...fallbackVariants];
      this._cachedRenderableVariants = buildRenderableVariants(this._cachedVariants, this._cachedDisplaySpans);
    }
  }

  render() {
    const imageHeight = this._imageHeight();
    return html`
      <canvas
        style="width: 100%; height: ${imageHeight}px;"
        @click=${this._handleClick}
        @mousemove=${this._handleMouseMove}
        @mouseleave=${this._handleMouseLeave}
      ></canvas>
    `;
  }

  updated() {
    this._draw();
  }

  // Called by drag controller on pointerdown with coords already relative to this element
  isVariantAtPoint(offsetX, offsetY) {
    return this._variantRects.some(
      (r) => offsetX >= r.x && offsetX <= r.x + r.w && offsetY >= r.y && offsetY <= r.y + r.h
    );
  }

  _draw() {
    const canvas = this.renderRoot?.querySelector("canvas");
    if (!canvas || !this.scale || !this.data || !this.imageWidth) return;

    const dpr = window.devicePixelRatio || 1;
    const w = this.imageWidth;
    const h = this._imageHeight();
    const physW = Math.round(w * dpr);
    const physH = Math.round(h * dpr);
    if (canvas.width !== physW || canvas.height !== physH) {
      canvas.width = physW;
      canvas.height = physH;
    }

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const sequenceThresholdSpan = 1000;
    const drawAlignmentsOnTop = (this.end - this.start) <= sequenceThresholdSpan;

    const topScale = this.displayOrder === "alt-top" ? this.altSequenceScale : this.scale;
    const bottomScale = this.displayOrder === "alt-top" ? this.scale : this.altSequenceScale;

    const rulerHeight = this._rulerHeight();
    const alignmentAreaHeight = this._alignmentAreaHeight();
    this._drawRuler(ctx, topScale, 0);
    if (drawAlignmentsOnTop) {
      this._drawVariants(ctx);
      this._drawAlignments(ctx);
    } else {
      this._drawAlignments(ctx);
      this._drawVariants(ctx);
    }
    this._drawRuler(ctx, bottomScale, rulerHeight + alignmentAreaHeight);
  }

  _imageHeight() {
    const height = Number(this.imageHeight);
    return Number.isFinite(height) && height > 0 ? Math.max(72, Math.round(height)) : IMAGE_HEIGHT;
  }

  _rulerHeight() {
    const height = this._imageHeight();
    return Math.max(10, Math.min(RULER_HEIGHT, Math.round(height * RULER_HEIGHT / IMAGE_HEIGHT)));
  }

  _alignmentAreaHeight() {
    return Math.max(44, this._imageHeight() - (this._rulerHeight() * 2));
  }

  _variantHeight() {
    return Math.max(4, Math.min(VARIANT_HEIGHT, Math.round(this._imageHeight() * VARIANT_HEIGHT / IMAGE_HEIGHT)));
  }

  _drawRuler(ctx, scale, offsetTop) {
    if (!scale) return;
    const rulerHeight = this._rulerHeight();
    const ticks = scale.ticks(5);
    ctx.strokeStyle = "#7ea6cf";
    ctx.lineWidth = 1;
    ctx.fillStyle = "#d8e6f7";
    ctx.font = `500 ${Math.max(9, rulerHeight - 1)}px 'IBM Plex Mono', sans-serif`;
    ctx.textBaseline = "alphabetic";
    for (const tick of ticks) {
      const x = scale(tick);
      ctx.beginPath();
      ctx.moveTo(x, offsetTop);
      ctx.lineTo(x, offsetTop + rulerHeight);
      ctx.stroke();
      ctx.fillText(formatter.format(tick), x + 2, offsetTop + rulerHeight - 3);
    }
  }

  _drawAlignments(ctx) {
    const geometry = this._cachedAlignmentGeometry;
    if (!geometry?.alignments?.length) return;

    // Cull to canvas-visible polygons: the trapezoid's x-range must overlap [0, imageWidth].
    // In genome coords: some corner must be right of the left edge AND some corner left of the right edge.
    const viewStart = this.start;
    const viewEnd = this.end;
    const altViewStart = this.altStart;
    const altViewEnd = this.altEnd;
    let alignments = [];
    const { alignments: allAlignments, rangeIndexes } = geometry;
    const candidateIndexes = new Set();
    // Exact expansion of the original polygon overlap test:
    // (refEnd >= viewStart || altEnd >= altViewStart) &&
    // (refStart <= viewEnd || altStart <= altViewEnd).
    addAlignmentRangeMatches(rangeIndexes.refOverlap, viewEnd, viewStart, candidateIndexes);
    addAlignmentRangeMatches(rangeIndexes.altOverlap, altViewEnd, altViewStart, candidateIndexes);
    addAlignmentRangeMatches(rangeIndexes.altStartRefEnd, altViewEnd, viewStart, candidateIndexes);
    addAlignmentRangeMatches(rangeIndexes.refStartAltEnd, viewEnd, altViewStart, candidateIndexes);
    const orderedIndexes = Array.from(candidateIndexes).sort((a, b) => a - b);
    alignments = orderedIndexes.map((index) => allAlignments[index]);
    if (!alignments.length) return;

    if (alignments.length > 3000) {
      alignments = mergeAlignments(alignments, this.scale, this.altSequenceScale);
    }

    const rulerHeight = this._rulerHeight();
    const alignmentAreaHeight = this._alignmentAreaHeight();
    const topY = rulerHeight;
    const bottomY = rulerHeight + alignmentAreaHeight;
    const altOnTop = this.displayOrder === "alt-top";

    // Pass 1: regular alignments
    ctx.fillStyle = COLORS.alignment;
    ctx.globalAlpha = 0.28;
    ctx.beginPath();
    for (const a of alignments) {
      if (a.reference.strand !== a.alt.strand) continue;
      const topStart = altOnTop ? a.alt.start : a.reference.start;
      const topEnd = altOnTop
        ? a.alt.start + a.alt.length
        : a.reference.start + a.reference.length;
      const bottomStart = altOnTop ? a.reference.start : a.alt.start;
      const bottomEnd = altOnTop
        ? a.reference.start + a.reference.length
        : a.alt.start + a.alt.length;
      const topScale = altOnTop ? this.altSequenceScale : this.scale;
      const bottomScale = altOnTop ? this.scale : this.altSequenceScale;
      const x1 = topScale(topStart);
      const x2 = topScale(topEnd);
      const x3 = bottomScale(bottomEnd);
      const x4 = bottomScale(bottomStart);
      ctx.moveTo(x1, topY);
      ctx.lineTo(x2, topY);
      ctx.lineTo(x3, bottomY);
      ctx.lineTo(x4, bottomY);
      ctx.closePath();
    }
    ctx.fill();

    // Pass 2: inversions
    ctx.fillStyle = COLORS.inversion;
    ctx.globalAlpha = 0.52;
    ctx.beginPath();
    for (const a of alignments) {
      if (a.reference.strand === a.alt.strand) continue;
      const topStart = altOnTop ? a.alt.start : a.reference.start;
      const topEnd = altOnTop
        ? a.alt.start + a.alt.length
        : a.reference.start + a.reference.length;
      const bottomStart = altOnTop ? a.reference.start : a.alt.start;
      const bottomEnd = altOnTop
        ? a.reference.start + a.reference.length
        : a.alt.start + a.alt.length;
      const topScale = altOnTop ? this.altSequenceScale : this.scale;
      const bottomScale = altOnTop ? this.scale : this.altSequenceScale;
      const x1 = topScale(topStart);
      const x2 = topScale(topEnd);
      const x3 = bottomScale(bottomStart);
      const x4 = bottomScale(bottomEnd);
      ctx.moveTo(x1, topY);
      ctx.lineTo(x2, topY);
      ctx.lineTo(x3, bottomY);
      ctx.lineTo(x4, bottomY);
      ctx.closePath();
    }
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  _drawVariants(ctx) {
    const variants = this._cachedRenderableVariants;
    if (!variants.length) return;

    const domainSpan = this.end - this.start;
    const isZoomedIn = domainSpan <= 250000;
    const sequenceThresholdSpan = 1000;
    const useExactWidth = domainSpan <= sequenceThresholdSpan;
    const sequenceFloorWidth = Math.max(1, this.imageWidth / sequenceThresholdSpan);

    this._variantRects = [];

    // Collect rects grouped by color for batched drawing
    const byColor = new Map();
    const hoveredColor = "pink";

    for (const v of variants) {
      if (v.type === "snv") continue;
      const isLarge = v.extent >= STRUCTURAL_VARIANT_LENGTH_CUTOFF;
      if (!isLarge && !isZoomedIn) continue;

      const markerOnAlt = Boolean(v._markerOnBottom);
      const markerScale = markerOnAlt ? this.altSequenceScale : this.scale;
      const viewWindowStart = markerOnAlt ? this.altStart : this.start;
      const viewWindowEnd = markerOnAlt ? this.altEnd : this.end;
      const spanStart = v._renderSpanStart;
      const spanEnd = v._renderSpanEnd;
      if (spanEnd < viewWindowStart || spanStart > viewWindowEnd) continue;

      const vx = markerScale(spanStart);
      let vw = markerScale(spanEnd) - vx;
      let minW = 1;
      if (!useExactWidth) {
        const widthBoost = v.type === "snv" ? 1 : 0;
        if (domainSpan <= 25000) {
          minW = Math.max(sequenceFloorWidth + widthBoost, v.type === "snv" ? 8 : 7);
        } else if (domainSpan <= 100000) {
          minW = Math.max(sequenceFloorWidth + widthBoost, v.type === "snv" ? 7 : 6);
        } else if (domainSpan <= 500000) {
          minW = Math.max(sequenceFloorWidth + widthBoost, v.type === "snv" ? 6 : 5);
        } else {
          minW = Math.max(sequenceFloorWidth + widthBoost, v.type === "snv" ? 5 : 4);
        }
      }

      if (!vw) {
        if (isLarge || isZoomedIn) vw = 1;
        else continue;
      }

      const actualW = Math.max(vw, minW);
      const actualX = vx - (actualW - vw) / 2;
      const drawOnTop = this.displayOrder === "alt-top" ? markerOnAlt : !markerOnAlt
      const rulerHeight = this._rulerHeight();
      const alignmentAreaHeight = this._alignmentAreaHeight();
      const variantHeight = this._variantHeight();
      const vy = drawOnTop
        ? rulerHeight
        : rulerHeight + alignmentAreaHeight - variantHeight;
      const color = this._hoveredVariant === v ? hoveredColor : (COLORS[v.type] || "#000000");

      this._variantRects.push({ variant: v, x: actualX, y: vy, w: actualW, h: variantHeight });

      let rects = byColor.get(color);
      if (!rects) { rects = []; byColor.set(color, rects); }
      rects.push(actualX, vy, actualW, variantHeight);
    }

    // One beginPath/fill per color group
    for (const [color, rects] of byColor) {
      ctx.fillStyle = color;
      ctx.beginPath();
      for (let i = 0; i < rects.length; i += 4) {
        ctx.rect(rects[i], rects[i + 1], rects[i + 2], rects[i + 3]);
      }
      ctx.fill();
    }
  }

  _handleClick(event) {
    const hit = this._hitVariant(event.offsetX, event.offsetY);
    if (!hit) return;
    const v = hit.variant;
    this.dispatchEvent(
      new CustomEvent("variant-click", {
        bubbles: true,
        composed: true,
        detail: {
          name: v.name,
          type: v.type,
          consequence: v.consequence,
          extent: Number(v.extent),
          ref_length: Number(v.ref_length ?? 0),
          alt_length: Number(v.alt_length ?? 0),
          location: {
            region_name: v.location.region_name,
            start: v.location.start,
            end: v.location.end,
          },
          x: event.offsetX,
          y: event.offsetY,
        },
      })
    );
  }

  _handleMouseMove(event) {
    if (!this._variantRects.length) return;
    const hit = this._hitVariant(event.offsetX, event.offsetY);
    const found = hit ? hit.variant : null;
    if (found !== this._hoveredVariant) {
      this._hoveredVariant = found;
      const canvas = this.renderRoot?.querySelector("canvas");
      if (canvas) canvas.style.cursor = found ? "pointer" : "";
      this._draw();
    }
  }

  _handleMouseLeave() {
    if (this._hoveredVariant !== null) {
      this._hoveredVariant = null;
      const canvas = this.renderRoot?.querySelector("canvas");
      if (canvas) canvas.style.cursor = "";
      this._draw();
    }
  }

  _hitVariant(offsetX, offsetY) {
    return this._variantRects.find(
      (r) => offsetX >= r.x && offsetX <= r.x + r.w && offsetY >= r.y && offsetY <= r.y + r.h
    ) ?? null;
  }
}

if (!customElements.get("ens-sv-alignments-image")) {
  customElements.define("ens-sv-alignments-image", VariantAlignmentsImage);
}

export { VariantAlignmentsImage };
