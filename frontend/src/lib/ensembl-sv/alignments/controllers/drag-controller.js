import { RULER_HEIGHT } from "../constants/constants.js";

const MIN_VIEW_SPAN = 50;
const MAX_VIEW_SPAN = 50000000;

class DragController {
  constructor(host) {
    this.host = host;
    this.pointerId = null;
    this.wheelCommitTimeout = null;
    this.dragMode = null;
    this.dragStartX = null;
    this.dragStarted = false;
    this.referenceStart = null;
    this.referenceEnd = null;
    this.altStart = null;
    this.altEnd = null;
    this.referenceScale = null;
    this.altScale = null;
    this.referenceRegionLength = null;
    this.altRegionLength = null;

    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    this.onPointerCancel = this.onPointerCancel.bind(this);
    this.onWheel = this.onWheel.bind(this);

    host.addController(this);
  }

  hostConnected() {
    this.host.addEventListener("pointerdown", this.onPointerDown);
    this.host.addEventListener("wheel", this.onWheel, { passive: false });
  }

  hostDisconnected() {
    this.host.removeEventListener("pointerdown", this.onPointerDown);
    this.host.removeEventListener("wheel", this.onWheel);
    this.removePointerListeners();
    if (this.wheelCommitTimeout) {
      clearTimeout(this.wheelCommitTimeout);
      this.wheelCommitTimeout = null;
    }
  }

  onPointerDown(event) {
    if (event.button !== 0 || this.pointerId !== null) {
      return;
    }

    if (this.isInteractiveTarget(event)) {
      return;
    }

    this.pointerId = event.pointerId;
    this.dragStartX = event.clientX;
    this.dragStarted = false;
    this.cacheViewport();
    this.dragMode = this.getDragMode(event);

    event.preventDefault();
    this.host.setPointerCapture?.(event.pointerId);
    this.addPointerListeners();
  }

  onPointerMove(event) {
    if (event.pointerId !== this.pointerId || this.dragStartX === null) {
      return;
    }

    const deltaX = event.clientX - this.dragStartX;
    if (!deltaX) {
      return;
    }

    this.dragStarted = true;
    event.preventDefault();

    const directionCoefficient = deltaX >= 0 ? 1 : -1;
    const detail = {
      reference: this.getReferenceViewport({ deltaX, directionCoefficient }),
      alt: this.getAltViewport({ deltaX, directionCoefficient })
    };

    this.host.start = detail.reference.start;
    this.host.end = detail.reference.end;
    this.host.altStart = detail.alt.start;
    this.host.altEnd = detail.alt.end;

    this.host.dispatchEvent(new CustomEvent("viewport-change", {
      bubbles: true,
      composed: true,
      detail
    }));
  }

  onPointerUp(event) {
    if (event.pointerId !== this.pointerId) {
      return;
    }

    event.preventDefault();
    this.finishDrag();
  }

  onPointerCancel(event) {
    if (event.pointerId !== this.pointerId) {
      return;
    }

    this.finishDrag();
  }

  onWheel(event) {
    const absDeltaX = Math.abs(event.deltaX);
    const absDeltaY = Math.abs(event.deltaY);
    const isPinch = event.ctrlKey;
    const isVertical = absDeltaY > absDeltaX;
    const isHorizontal = absDeltaX > absDeltaY;
    const isZoomGesture = isPinch || (isVertical && absDeltaY > 0.5);

    if (!isPinch && !isVertical && !isHorizontal) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();

    const mode = this.getDragMode(event);
    const nextReference = isZoomGesture
      ? this.zoomViewport({
          start: this.host.start,
          end: this.host.end,
          regionLength: this.host.regionLength,
          minStart: 1,
          clientX: event.clientX,
          deltaY: event.deltaY
        })
      : (mode === "alt")
        ? { start: this.host.start, end: this.host.end }
        : this.panViewport({
          start: this.host.start,
          end: this.host.end,
          regionLength: this.host.regionLength,
          scale: this.host.scale,
          deltaX: event.deltaX,
          minStart: 1
        });
    const nextAlt = isZoomGesture
      ? this.zoomViewport({
          start: this.host.altStart,
          end: this.host.altEnd,
          regionLength: this.host.altRegionLength,
          minStart: 1,
          clientX: event.clientX,
          deltaY: event.deltaY
        })
      : (mode === "reference")
        ? { start: this.host.altStart, end: this.host.altEnd }
        : this.panViewport({
          start: this.host.altStart,
          end: this.host.altEnd,
          regionLength: this.host.altRegionLength,
          scale: this.host.altSequenceScale,
          deltaX: event.deltaX,
          minStart: 1
        });

    this.host.start = nextReference.start;
    this.host.end = nextReference.end;
    this.host.altStart = nextAlt.start;
    this.host.altEnd = nextAlt.end;

    this.host.dispatchEvent(new CustomEvent("viewport-change", {
      bubbles: true,
      composed: true,
      detail: {
        reference: nextReference,
        alt: nextAlt
      }
    }));

    if (this.wheelCommitTimeout) {
      clearTimeout(this.wheelCommitTimeout);
    }
    this.wheelCommitTimeout = setTimeout(() => {
      this.wheelCommitTimeout = null;
      this.dispatchViewportCommit();
    }, 120);
  }

  finishDrag() {
    if (this.dragStarted) {
      this.dispatchViewportCommit();
    }

    if (this.pointerId !== null) {
      try {
        this.host.releasePointerCapture?.(this.pointerId);
      } catch {
      }
    }

    this.pointerId = null;
    this.dragMode = null;
    this.dragStartX = null;
    this.dragStarted = false;
    this.removePointerListeners();
  }

  addPointerListeners() {
    this.host.addEventListener("pointermove", this.onPointerMove);
    this.host.addEventListener("pointerup", this.onPointerUp);
    this.host.addEventListener("pointercancel", this.onPointerCancel);
    this.host.addEventListener("lostpointercapture", this.onPointerCancel);
  }

  removePointerListeners() {
    this.host.removeEventListener("pointermove", this.onPointerMove);
    this.host.removeEventListener("pointerup", this.onPointerUp);
    this.host.removeEventListener("pointercancel", this.onPointerCancel);
    this.host.removeEventListener("lostpointercapture", this.onPointerCancel);
  }

  isInteractiveTarget(event) {
    if (typeof this.host.isVariantAtPoint === "function") {
      // offsetX/offsetY are relative to the event target — no getBoundingClientRect needed
      return this.host.isVariantAtPoint(event.offsetX, event.offsetY);
    }
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    return path.some((node) => node?.dataset?.featureType === "variant");
  }

  cacheViewport() {
    this.referenceStart = this.host.start;
    this.referenceEnd = this.host.end;
    this.altStart = this.host.altStart;
    this.altEnd = this.host.altEnd;
    this.referenceScale = this.host.scale;
    this.altScale = this.host.altSequenceScale;
    this.referenceRegionLength = this.host.regionLength;
    this.altRegionLength = this.host.altRegionLength;
  }

  getDragMode(event) {
    if (this.host.linkedViewports) {
      return "both";
    }
    const rect = this.host.getBoundingClientRect();
    const offsetY = event.clientY - rect.top;
    const referenceOnTop = this.host.displayOrder !== "alt-top";

    if (offsetY <= RULER_HEIGHT) {
      return referenceOnTop ? "reference" : "alt";
    }
    if (rect.height - offsetY <= RULER_HEIGHT) {
      return referenceOnTop ? "alt" : "reference";
    }
    return "both";
  }

  getReferenceViewport({ deltaX, directionCoefficient }) {
    if (this.dragMode === "alt") {
      return {
        start: this.referenceStart,
        end: this.referenceEnd
      };
    }

    const deltaBp = this.deltaPixelsToBp(this.referenceScale, deltaX, this.referenceStart);
    return this.shiftViewport({
      start: this.referenceStart,
      end: this.referenceEnd,
      regionLength: this.referenceRegionLength,
      deltaBp,
      directionCoefficient,
      minStart: 1
    });
  }

  getAltViewport({ deltaX, directionCoefficient }) {
    if (this.dragMode === "reference") {
      return {
        start: this.altStart,
        end: this.altEnd
      };
    }

    const deltaBp = this.deltaPixelsToBp(this.altScale, deltaX, this.altStart);
    return this.shiftViewport({
      start: this.altStart,
      end: this.altEnd,
      regionLength: this.altRegionLength,
      deltaBp,
      directionCoefficient,
      minStart: 1
    });
  }

  deltaPixelsToBp(scale, deltaX, viewportStart) {
    if (!scale || !Number.isFinite(deltaX) || !Number.isFinite(viewportStart)) {
      return 0;
    }

    return Math.round(scale.invert(Math.abs(deltaX))) - viewportStart;
  }

  shiftViewport({ start, end, regionLength, deltaBp, directionCoefficient, minStart }) {
    const signedDelta = deltaBp * directionCoefficient;
    const span = Math.max(1, end - start);
    let nextStart = Math.max(minStart, start - signedDelta);
    let nextEnd = nextStart + span;

    if (Number.isFinite(regionLength) && regionLength > minStart && nextEnd > regionLength) {
      nextEnd = regionLength;
      nextStart = Math.max(minStart, nextEnd - span);
    }

    return {
      start: nextStart,
      end: nextEnd
    };
  }

  panViewport({ start, end, regionLength, scale, deltaX, minStart }) {
    if (!scale || !Number.isFinite(start) || !Number.isFinite(end)) {
      return { start, end };
    }

    const range = typeof scale.range === "function" ? scale.range() : null;
    const width = Array.isArray(range) ? Math.abs(range[1] - range[0]) : 0;
    const span = Math.max(1, end - start);
    const bpPerPx = width > 0 ? span / width : 0;
    const deltaBp = deltaX * bpPerPx;

    let nextStart = Math.round(start + deltaBp);
    let nextEnd = Math.round(end + deltaBp);

    if (nextStart < minStart) {
      nextStart = minStart;
      nextEnd = nextStart + span;
    }
    if (Number.isFinite(regionLength) && regionLength > minStart && nextEnd > regionLength) {
      nextEnd = Math.round(regionLength);
      nextStart = Math.max(minStart, nextEnd - span);
    }

    return {
      start: nextStart,
      end: nextEnd
    };
  }

  zoomViewport({ start, end, regionLength, minStart, clientX, deltaY }) {
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return { start, end };
    }

    const rect = this.host.getBoundingClientRect();
    const anchorFraction = rect.width > 0
      ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      : 0.5;
    const span = Math.max(1, end - start);
    const sensitivity = 0.005;
    const zoomFactor = Math.max(0.05, 1 + deltaY * sensitivity);
    const maxSpan = Number.isFinite(regionLength) && regionLength > minStart
      ? Math.min(MAX_VIEW_SPAN, Math.max(MIN_VIEW_SPAN, Math.round(regionLength) - minStart))
      : MAX_VIEW_SPAN;
    const nextSpan = Math.round(Math.max(MIN_VIEW_SPAN, Math.min(maxSpan, span * zoomFactor)));
    const anchorBp = start + (span * anchorFraction);

    let nextStart = Math.round(anchorBp - (nextSpan * anchorFraction));
    let nextEnd = nextStart + nextSpan;

    if (nextStart < minStart) {
      nextStart = minStart;
      nextEnd = nextStart + nextSpan;
    }
    if (Number.isFinite(regionLength) && regionLength > minStart && nextEnd > regionLength) {
      nextEnd = Math.round(regionLength);
      nextStart = Math.max(minStart, nextEnd - nextSpan);
    }

    return {
      start: nextStart,
      end: nextEnd
    };
  }

  dispatchViewportCommit() {
    this.host.dispatchEvent(new CustomEvent("viewport-change-end", {
      bubbles: true,
      composed: true,
      detail: {
        reference: {
          start: this.host.start,
          end: this.host.end
        },
        alt: {
          start: this.host.altStart,
          end: this.host.altEnd
        }
      }
    }));
  }
}

export {
  DragController as default
};
