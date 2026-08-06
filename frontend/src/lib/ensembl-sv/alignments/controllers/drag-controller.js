import { RULER_HEIGHT } from "../constants/constants.js";
import {
  DEFAULT_BROWSING_CONTROLS,
  beginWheelGesture,
  findNearestScrollable,
  markWheelHandled,
  readWheelEvent,
  resolveDragAxis,
  resolveWheelAction
} from "../../../../utils/browsingControls.js";

const MIN_VIEW_SPAN = 50;
const MAX_VIEW_SPAN = 50000000;

class DragController {
  constructor(host) {
    this.host = host;
    this.pointerId = null;
    this.wheelCommitTimeout = null;
    this.wheelGesture = null;
    this.dragMode = null;
    this.dragStartX = null;
    this.dragStartY = null;
    this.dragAxis = null;
    this.scroller = null;
    this.startScrollTop = 0;
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
    this.dragStartY = event.clientY;
    this.dragAxis = null;
    // Resolved once per drag: crossing the shadow boundary on every pointermove
    // would mean a getComputedStyle walk per frame.
    this.scroller = findNearestScrollable(this.host);
    this.startScrollTop = this.scroller ? this.scroller.scrollTop : 0;
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
    const deltaY = event.clientY - this.dragStartY;

    // Axis-locked, matching the Genome Browser: sideways pans the alignment,
    // up/down scrolls the page.
    if (!this.dragAxis) {
      const axis = resolveDragAxis({
        dx: deltaX,
        dy: deltaY,
        canScrollPage: Boolean(this.scroller),
        currentAxis: null
      });
      if (!axis) {
        return;
      }
      this.dragAxis = axis;
    }

    if (this.dragAxis === "y") {
      if (!this.scroller) {
        return;
      }
      event.preventDefault();
      // 1:1 grab-and-drag, so dragging down reveals what is above.
      this.scroller.scrollTop = this.startScrollTop - deltaY;
      return;
    }

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
    // Same resolution the React surfaces use, so the identical gesture does the
    // identical thing whether the cursor is over this web component or the
    // panel around it. It used to zoom about 4x faster here.
    const controls = this.host.browsingControls || DEFAULT_BROWSING_CONTROLS;
    const wheel = readWheelEvent(event, { pageHeight: window.innerHeight });
    const gesture = beginWheelGesture(this.wheelGesture, wheel, wheel.ts || performance.now());
    const intent = resolveWheelAction(wheel, controls, { canScrollPage: false, gesture });
    markWheelHandled(event);
    this.wheelGesture = { ...gesture, mode: intent.nextGestureMode || gesture.mode };

    if (intent.preventDefault) {
      event.preventDefault();
    }
    if (intent.stopPropagation) {
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    }

    const isZoomGesture = intent.type === "zoom";
    if (!isZoomGesture && intent.type !== "pan") {
      return;
    }

    const mode = this.getDragMode(event);
    const nextReference = isZoomGesture
      ? this.zoomViewport({
          start: this.host.start,
          end: this.host.end,
          regionLength: this.host.regionLength,
          minStart: 1,
          clientX: event.clientX,
          factor: intent.factor,
          anchor: intent.anchor
        })
      : (mode === "alt")
        ? { start: this.host.start, end: this.host.end }
        : this.panViewport({
          start: this.host.start,
          end: this.host.end,
          regionLength: this.host.regionLength,
          scale: this.host.scale,
          deltaX: intent.dxPx,
          minStart: 1
        });
    const nextAlt = isZoomGesture
      ? this.zoomViewport({
          start: this.host.altStart,
          end: this.host.altEnd,
          regionLength: this.host.altRegionLength,
          minStart: 1,
          clientX: event.clientX,
          factor: intent.factor,
          anchor: intent.anchor
        })
      : (mode === "reference")
        ? { start: this.host.altStart, end: this.host.altEnd }
        : this.panViewport({
          start: this.host.altStart,
          end: this.host.altEnd,
          regionLength: this.host.altRegionLength,
          scale: this.host.altSequenceScale,
          deltaX: intent.dxPx,
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
    this.dragStartY = null;
    this.dragAxis = null;
    this.scroller = null;
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

  zoomViewport({ start, end, regionLength, minStart, clientX, factor, anchor }) {
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return { start, end };
    }

    const rect = this.host.getBoundingClientRect();
    const anchorFraction = anchor === "center" || rect.width <= 0
      ? 0.5
      : Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const span = Math.max(1, end - start);
    const zoomFactor = Number.isFinite(factor) && factor > 0 ? factor : 1;
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
