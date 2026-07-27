use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

const MIN_VIEW_SPAN: f64 = 50.0;
const MAX_VIEW_SPAN: f64 = 1_000_000_000.0;
const CACHE_LIMIT_BYTES: usize = 256 * 1024 * 1024;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(default)]
pub struct GenomeWindow {
    pub slot: String,
    pub chrom: String,
    pub start: f64,
    pub end: f64,
    pub chrom_length: f64,
    pub label: String,
    pub color: String,
}

impl GenomeWindow {
    pub fn span(&self) -> f64 {
        (self.end - self.start).max(1.0)
    }

    pub fn clamp(&mut self) {
        let max_span = if self.chrom_length > 1.0 {
            MAX_VIEW_SPAN
                .min(self.chrom_length - 1.0)
                .max(MIN_VIEW_SPAN)
        } else {
            MAX_VIEW_SPAN
        };
        let span = self.span().clamp(MIN_VIEW_SPAN, max_span);
        let mut start = self.start.max(1.0);
        let mut end = start + span;
        if self.chrom_length > 1.0 && end > self.chrom_length {
            end = self.chrom_length;
            start = (end - span).max(1.0);
        }
        self.start = start.round();
        self.end = end.max(self.start + 1.0).round();
    }

    pub fn pan_fraction(&mut self, fraction: f64) {
        let span = self.span();
        self.start += span * fraction;
        self.end = self.start + span;
        self.clamp();
    }

    pub fn zoom(&mut self, factor: f64, anchor: f64) {
        let anchor = anchor.clamp(0.0, 1.0);
        let span = self.span();
        let anchor_bp = self.start + span * anchor;
        let max_span = if self.chrom_length > 1.0 {
            MAX_VIEW_SPAN
                .min(self.chrom_length - 1.0)
                .max(MIN_VIEW_SPAN)
        } else {
            MAX_VIEW_SPAN
        };
        let next_span = (span * factor).clamp(MIN_VIEW_SPAN, max_span);
        self.start = anchor_bp - next_span * anchor;
        self.end = self.start + next_span;
        self.clamp();
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct AlignmentBlock {
    pub panel: String,
    pub id: String,
    pub ref_start: f64,
    pub ref_end: f64,
    pub tgt_start: f64,
    pub tgt_end: f64,
    pub strand: String,
    pub kind: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Variant {
    pub panel: String,
    pub name: String,
    pub kind: String,
    pub chrom: String,
    pub start: f64,
    pub end: f64,
    pub target_start: f64,
    pub target_end: f64,
    pub ref_length: f64,
    pub alt_length: f64,
    pub metadata: serde_json::Value,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Exon {
    pub start: f64,
    pub end: f64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Transcript {
    pub slot: String,
    pub id: String,
    pub label: String,
    pub start: f64,
    pub end: f64,
    pub strand: String,
    pub biotype: String,
    pub exons: Vec<Exon>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct SequenceLane {
    pub slot: String,
    pub start: f64,
    pub sequence: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct SignalBin {
    pub start: f64,
    pub end: f64,
    pub value: Option<f64>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct SignalTrack {
    pub slot: String,
    pub id: String,
    pub label: String,
    pub bins: Vec<SignalBin>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct IntervalFeature {
    pub id: String,
    pub start: f64,
    pub end: f64,
    pub label: String,
    pub metadata: serde_json::Value,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct IntervalTrack {
    pub slot: String,
    pub id: String,
    pub label: String,
    pub features: Vec<IntervalFeature>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default)]
pub struct Scene {
    pub version: u32,
    pub theme: String,
    pub compact: bool,
    pub show_bigwig: bool,
    pub show_bigbed: bool,
    pub hide_inactive: bool,
    pub hidden_tracks: Vec<String>,
    pub windows: Vec<GenomeWindow>,
    pub alignments: Vec<AlignmentBlock>,
    pub variants: Vec<Variant>,
    pub transcripts: Vec<Transcript>,
    pub sequences: Vec<SequenceLane>,
    pub signal_tracks: Vec<SignalTrack>,
    pub interval_tracks: Vec<IntervalTrack>,
}

impl Default for Scene {
    fn default() -> Self {
        Self {
            version: 1,
            theme: "dark".to_string(),
            compact: false,
            show_bigwig: false,
            show_bigbed: false,
            hide_inactive: false,
            hidden_tracks: Vec::new(),
            windows: Vec::new(),
            alignments: Vec::new(),
            variants: Vec::new(),
            transcripts: Vec::new(),
            sequences: Vec::new(),
            signal_tracks: Vec::new(),
            interval_tracks: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct RowLayout {
    pub kind: String,
    pub slot: String,
    pub panel: String,
    pub y: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Layout {
    pub width: f64,
    pub height: f64,
    pub rows: Vec<RowLayout>,
}

pub fn build_layout(scene: &Scene, width: f64) -> Layout {
    let feature_h = if scene.compact { 64.0 } else { 112.0 };
    let panel_h = if scene.compact { 132.0 } else { 168.0 };
    let signal_h = 38.0;
    let interval_h = 24.0;
    let has_bottom = scene.windows.iter().any(|window| window.slot == "bottom");
    let mut rows = Vec::new();
    let mut y = 0.0;

    let mut push_row = |kind: &str, slot: &str, panel: &str, height: f64| {
        if height <= 0.0 {
            return;
        }
        rows.push(RowLayout {
            kind: kind.to_string(),
            slot: slot.to_string(),
            panel: panel.to_string(),
            y,
            height,
        });
        y += height;
    };

    let signal_count = |slot: &str| {
        scene
            .signal_tracks
            .iter()
            .filter(|track| {
                track.slot == slot
                    && (!scene.hide_inactive
                        || !scene
                            .hidden_tracks
                            .contains(&track_key("signal", slot, &track.id)))
            })
            .count() as f64
    };
    let interval_count = |slot: &str| {
        scene
            .interval_tracks
            .iter()
            .filter(|track| {
                track.slot == slot
                    && (!scene.hide_inactive
                        || !scene
                            .hidden_tracks
                            .contains(&track_key("interval", slot, &track.id)))
            })
            .count() as f64
    };

    push_row("feature", "top", "", feature_h);
    if scene.show_bigwig {
        push_row("signal", "top", "", signal_count("top") * signal_h);
    }
    if scene.show_bigbed {
        push_row("interval", "top", "", interval_count("top") * interval_h);
    }
    push_row("alignment", "", "upper", panel_h);
    push_row("feature", "reference", "", feature_h);
    if scene.show_bigwig {
        push_row(
            "signal",
            "reference",
            "",
            signal_count("reference") * signal_h,
        );
    }
    if scene.show_bigbed {
        push_row(
            "interval",
            "reference",
            "",
            interval_count("reference") * interval_h,
        );
    }
    if has_bottom {
        push_row("alignment", "", "lower", panel_h);
        if scene.show_bigwig {
            push_row("signal", "bottom", "", signal_count("bottom") * signal_h);
        }
        if scene.show_bigbed {
            push_row(
                "interval",
                "bottom",
                "",
                interval_count("bottom") * interval_h,
            );
        }
        push_row("feature", "bottom", "", feature_h);
    }

    Layout {
        width,
        height: y.max(1.0),
        rows,
    }
}

fn track_key(kind: &str, slot: &str, id: &str) -> String {
    format!("{kind}|{slot}|{id}")
}

pub fn visible_alignment_indices(
    blocks: &[AlignmentBlock],
    windows: &[GenomeWindow],
    panel: &str,
) -> Vec<usize> {
    let reference = windows.iter().find(|window| window.slot == "reference");
    let target_slot = if panel == "lower" { "bottom" } else { "top" };
    let target = windows.iter().find(|window| window.slot == target_slot);
    let (Some(reference), Some(target)) = (reference, target) else {
        return Vec::new();
    };
    blocks
        .iter()
        .enumerate()
        .filter_map(|(index, block)| {
            if block.panel != panel {
                return None;
            }
            let ref_min = block.ref_start.min(block.ref_end);
            let ref_max = block.ref_start.max(block.ref_end);
            let tgt_min = block.tgt_start.min(block.tgt_end);
            let tgt_max = block.tgt_start.max(block.tgt_end);
            // The visible object is the whole trapezoid, not two independent
            // intervals. Opposite offscreen endpoints can still form a polygon
            // that crosses the complete canvas.
            ((ref_max >= reference.start || tgt_max >= target.start)
                && (ref_min <= reference.end || tgt_min <= target.end))
                .then_some(index)
        })
        .collect()
}

#[derive(Clone, Debug, Default)]
pub struct AlignmentIndex {
    by_reference_start: Vec<usize>,
    by_target_start: Vec<usize>,
}

impl AlignmentIndex {
    pub fn new(blocks: &[AlignmentBlock], panel: &str) -> Self {
        let mut indexes: Vec<usize> = blocks
            .iter()
            .enumerate()
            .filter_map(|(index, block)| (block.panel == panel).then_some(index))
            .collect();
        let mut by_reference_start = indexes.clone();
        by_reference_start.sort_by(|left, right| {
            blocks[*left]
                .ref_start
                .min(blocks[*left].ref_end)
                .total_cmp(&blocks[*right].ref_start.min(blocks[*right].ref_end))
        });
        indexes.sort_by(|left, right| {
            blocks[*left]
                .tgt_start
                .min(blocks[*left].tgt_end)
                .total_cmp(&blocks[*right].tgt_start.min(blocks[*right].tgt_end))
        });
        Self {
            by_reference_start,
            by_target_start: indexes,
        }
    }

    pub fn query(
        &self,
        blocks: &[AlignmentBlock],
        reference: &GenomeWindow,
        target: &GenomeWindow,
    ) -> Vec<usize> {
        let mut candidates = Vec::new();
        for index in self.by_reference_start.iter().copied().take_while(|index| {
            blocks[*index].ref_start.min(blocks[*index].ref_end) <= reference.end
        }) {
            candidates.push(index);
        }
        for index in
            self.by_target_start.iter().copied().take_while(|index| {
                blocks[*index].tgt_start.min(blocks[*index].tgt_end) <= target.end
            })
        {
            candidates.push(index);
        }
        candidates.sort_unstable();
        candidates.dedup();
        candidates
            .into_iter()
            .filter(|index| {
                let block = &blocks[*index];
                block.ref_start.max(block.ref_end) >= reference.start
                    || block.tgt_start.max(block.tgt_end) >= target.start
            })
            .collect()
    }
}

pub fn alignment_lod_stride(visible_count: usize) -> usize {
    let _ = visible_count;
    // Never sample alignment blocks: regular gaps in genomic order become
    // visible holes. Dense scenes are reduced only by coverage-preserving merge.
    1
}

fn alignment_is_inverted(block: &AlignmentBlock) -> bool {
    block.strand == "-" || block.strand == "reverse" || block.kind.contains("invert")
}

pub fn aggregate_alignment_blocks(
    blocks: &[AlignmentBlock],
    indexes: &[usize],
    reference: &GenomeWindow,
    target: &GenomeWindow,
    width: f64,
) -> Vec<AlignmentBlock> {
    let mut ordered = indexes.to_vec();
    ordered.sort_by(|left, right| {
        blocks[*left]
            .ref_start
            .min(blocks[*left].ref_end)
            .total_cmp(&blocks[*right].ref_start.min(blocks[*right].ref_end))
    });
    let ref_tolerance = (reference.span() / width.max(1.0) * 1.5).max(1.0);
    let target_tolerance = (target.span() / width.max(1.0) * 1.5).max(1.0);
    let mut aggregated: Vec<AlignmentBlock> = Vec::new();

    for index in ordered {
        let next = &blocks[index];
        let Some(current) = aggregated.last_mut() else {
            aggregated.push(next.clone());
            continue;
        };
        let inverted = alignment_is_inverted(current);
        if inverted || alignment_is_inverted(next) {
            aggregated.push(next.clone());
            continue;
        }

        let current_ref_min = current.ref_start.min(current.ref_end);
        let current_ref_max = current.ref_start.max(current.ref_end);
        let next_ref_min = next.ref_start.min(next.ref_end);
        let next_ref_max = next.ref_start.max(next.ref_end);
        let current_tgt_min = current.tgt_start.min(current.tgt_end);
        let current_tgt_max = current.tgt_start.max(current.tgt_end);
        let next_tgt_min = next.tgt_start.min(next.tgt_end);
        let next_tgt_max = next.tgt_start.max(next.tgt_end);
        let ref_gap = next_ref_min - current_ref_max;
        let target_gap = next_tgt_min - current_tgt_max;
        let ref_contiguous = ref_gap < ref_tolerance;
        let target_contiguous = target_gap < target_tolerance;
        if !ref_contiguous || !target_contiguous {
            aggregated.push(next.clone());
            continue;
        }

        current.ref_start = current_ref_min.min(next_ref_min);
        current.ref_end = current_ref_max.max(next_ref_max);
        current.tgt_start = current_tgt_min.min(next_tgt_min);
        current.tgt_end = current_tgt_max.max(next_tgt_max);
    }
    aggregated
}

pub fn selected_window(
    window: &GenomeWindow,
    left_fraction: f64,
    right_fraction: f64,
) -> GenomeWindow {
    let mut selected = window.clone();
    let left = left_fraction.clamp(0.0, 1.0);
    let right = right_fraction.clamp(left, 1.0);
    selected.start = window.start + window.span() * left;
    selected.end = window.start + window.span() * right;
    selected.clamp();
    selected
}

pub fn slots_for_row(kind: &str, slot: &str, panel: &str) -> Vec<String> {
    if kind == "alignment" {
        if panel == "lower" {
            vec!["reference".to_string(), "bottom".to_string()]
        } else {
            vec!["reference".to_string(), "top".to_string()]
        }
    } else {
        vec![slot.to_string()]
    }
}

pub fn visible_interval_indices(features: &[IntervalFeature], window: &GenomeWindow) -> Vec<usize> {
    IntervalIndex::new(features).query(features, window)
}

#[derive(Clone, Debug, Default)]
pub struct IntervalIndex {
    by_start: Vec<usize>,
}

impl IntervalIndex {
    pub fn new(features: &[IntervalFeature]) -> Self {
        let mut by_start: Vec<usize> = (0..features.len()).collect();
        by_start.sort_by(|left, right| features[*left].start.total_cmp(&features[*right].start));
        Self { by_start }
    }

    pub fn query(&self, features: &[IntervalFeature], window: &GenomeWindow) -> Vec<usize> {
        self.by_start
            .iter()
            .copied()
            .take_while(|index| features[*index].start <= window.end)
            .filter(|index| features[*index].end >= window.start)
            .collect()
    }
}

pub fn hit_rectangle(x: f64, y: f64, left: f64, top: f64, width: f64, height: f64) -> bool {
    x >= left && x <= left + width && y >= top && y <= top + height
}

pub fn is_current_epoch(candidate: u64, current: u64) -> bool {
    candidate == current
}

pub fn derive_gap_variants(blocks: &[AlignmentBlock], panel: &str, chrom: &str) -> Vec<Variant> {
    let mut ordered: Vec<&AlignmentBlock> =
        blocks.iter().filter(|block| block.panel == panel).collect();
    ordered.sort_by(|left, right| left.ref_start.total_cmp(&right.ref_start));
    let mut variants = Vec::new();
    for pair in ordered.windows(2) {
        let previous = pair[0];
        let next = pair[1];
        let ref_gap = (next.ref_start - previous.ref_end).max(0.0);
        let target_gap = if previous.strand == "-" || next.strand == "-" {
            (previous.tgt_start.max(previous.tgt_end) - next.tgt_start.min(next.tgt_end)).abs()
        } else {
            (next.tgt_start.min(next.tgt_end) - previous.tgt_start.max(previous.tgt_end)).max(0.0)
        };
        if (ref_gap - target_gap).abs() < 50.0 {
            continue;
        }
        let kind = if ref_gap > target_gap {
            "deletion"
        } else {
            "insertion"
        };
        variants.push(Variant {
            panel: panel.to_string(),
            name: format!("gap:{}:{}", previous.id, next.id),
            kind: kind.to_string(),
            chrom: chrom.to_string(),
            start: previous.ref_end,
            end: next.ref_start.max(previous.ref_end + 1.0),
            target_start: previous.tgt_start.max(previous.tgt_end),
            target_end: next.tgt_start.min(next.tgt_end),
            ref_length: ref_gap,
            alt_length: target_gap,
            metadata: serde_json::json!({"source":"alignment-gap"}),
        });
    }
    variants
}

pub fn centered_target_windows(scene: &Scene) -> Vec<GenomeWindow> {
    let mut windows = scene.windows.clone();
    let Some(reference) = windows
        .iter()
        .find(|window| window.slot == "reference")
        .cloned()
    else {
        return windows;
    };
    for (panel, slot) in [("upper", "top"), ("lower", "bottom")] {
        let visible: Vec<&AlignmentBlock> = scene
            .alignments
            .iter()
            .filter(|block| {
                block.panel == panel
                    && block.ref_end >= reference.start
                    && block.ref_start <= reference.end
            })
            .collect();
        if visible.is_empty() {
            continue;
        }
        let min_target = visible
            .iter()
            .map(|block| block.tgt_start.min(block.tgt_end))
            .fold(f64::INFINITY, f64::min);
        let max_target = visible
            .iter()
            .map(|block| block.tgt_start.max(block.tgt_end))
            .fold(f64::NEG_INFINITY, f64::max);
        if let Some(target) = windows.iter_mut().find(|window| window.slot == slot) {
            let center = (min_target + max_target) / 2.0;
            target.start = center - reference.span() / 2.0;
            target.end = target.start + reference.span();
            target.clamp();
        }
    }
    windows
}

#[derive(Clone, Debug)]
struct CacheEntry {
    key: String,
    bytes: usize,
}

#[derive(Clone, Debug)]
pub struct CacheBudget {
    limit: usize,
    used: usize,
    order: VecDeque<CacheEntry>,
}

impl Default for CacheBudget {
    fn default() -> Self {
        Self::new(CACHE_LIMIT_BYTES)
    }
}

impl CacheBudget {
    pub fn new(limit: usize) -> Self {
        Self {
            limit,
            used: 0,
            order: VecDeque::new(),
        }
    }

    pub fn insert(&mut self, key: String, bytes: usize) -> Vec<String> {
        if let Some(position) = self.order.iter().position(|entry| entry.key == key) {
            if let Some(previous) = self.order.remove(position) {
                self.used = self.used.saturating_sub(previous.bytes);
            }
        }
        self.used = self.used.saturating_add(bytes);
        self.order.push_back(CacheEntry { key, bytes });
        let mut evicted = Vec::new();
        while self.used > self.limit {
            let Some(entry) = self.order.pop_front() else {
                break;
            };
            self.used = self.used.saturating_sub(entry.bytes);
            evicted.push(entry.key);
        }
        evicted
    }

    pub fn used(&self) -> usize {
        self.used
    }
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::*;
    use js_sys::{Float32Array, Uint8ClampedArray};
    use std::collections::HashMap;
    use wasm_bindgen::{prelude::*, JsCast};
    use web_sys::{
        OffscreenCanvas, OffscreenCanvasRenderingContext2d, WebGl2RenderingContext as Gl,
        WebGlBuffer, WebGlProgram, WebGlShader,
    };

    #[derive(Clone, Debug, Serialize)]
    struct HitBox {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        kind: String,
        slot: String,
        payload: serde_json::Value,
    }

    #[derive(Clone, Debug)]
    struct DragState {
        start_x: f64,
        start_y: f64,
        current_x: f64,
        current_y: f64,
        box_select: bool,
        original_windows: Vec<GenomeWindow>,
        slots: Vec<String>,
    }

    #[wasm_bindgen]
    pub struct WasmRenderer {
        geometry_canvas: OffscreenCanvas,
        overlay_canvas: OffscreenCanvas,
        gl: Gl,
        overlay: OffscreenCanvasRenderingContext2d,
        program: WebGlProgram,
        buffer: WebGlBuffer,
        scene: Scene,
        layout: Layout,
        width: f64,
        height: f64,
        dpr: f64,
        hit_boxes: Vec<HitBox>,
        drag: Option<DragState>,
        render_count: u64,
        last_primitive_count: usize,
        alignment_indexes: HashMap<String, AlignmentIndex>,
        interval_indexes: HashMap<String, IntervalIndex>,
    }

    #[wasm_bindgen]
    impl WasmRenderer {
        #[wasm_bindgen(constructor)]
        pub fn new(
            geometry_canvas: OffscreenCanvas,
            overlay_canvas: OffscreenCanvas,
        ) -> Result<WasmRenderer, JsValue> {
            console_error_panic_hook::set_once();
            let gl = geometry_canvas
                .get_context("webgl2")?
                .ok_or_else(|| JsValue::from_str("WebGL2 is unavailable"))?
                .dyn_into::<Gl>()?;
            let overlay = overlay_canvas
                .get_context("2d")?
                .ok_or_else(|| JsValue::from_str("Offscreen Canvas 2D is unavailable"))?
                .dyn_into::<OffscreenCanvasRenderingContext2d>()?;
            let vertex = compile_shader(
                &gl,
                Gl::VERTEX_SHADER,
                r#"#version 300 es
                precision highp float;
                in vec4 a_points_01;
                in vec4 a_points_23;
                in vec4 a_color;
                uniform vec2 u_viewport;
                out vec4 v_color;
                void main() {
                    int corner = gl_VertexID == 0 || gl_VertexID == 3 ? 0
                        : (gl_VertexID == 1 ? 1 : (gl_VertexID == 2 || gl_VertexID == 4 ? 2 : 3));
                    vec2 point = corner == 0 ? a_points_01.xy
                        : (corner == 1 ? a_points_01.zw
                        : (corner == 2 ? a_points_23.xy : a_points_23.zw));
                    vec2 clip = vec2((point.x / u_viewport.x) * 2.0 - 1.0,
                                     1.0 - (point.y / u_viewport.y) * 2.0);
                    gl_Position = vec4(clip, 0.0, 1.0);
                    v_color = a_color;
                }
            "#,
            )?;
            let fragment = compile_shader(
                &gl,
                Gl::FRAGMENT_SHADER,
                r#"#version 300 es
                precision mediump float;
                in vec4 v_color;
                out vec4 out_color;
                void main() { out_color = v_color; }
            "#,
            )?;
            let program = link_program(&gl, &vertex, &fragment)?;
            let buffer = gl
                .create_buffer()
                .ok_or_else(|| JsValue::from_str("Failed to create WebGL buffer"))?;
            gl.enable(Gl::BLEND);
            gl.blend_func(Gl::SRC_ALPHA, Gl::ONE_MINUS_SRC_ALPHA);
            Ok(Self {
                geometry_canvas,
                overlay_canvas,
                gl,
                overlay,
                program,
                buffer,
                scene: Scene::default(),
                layout: Layout::default(),
                width: 1.0,
                height: 1.0,
                dpr: 1.0,
                hit_boxes: Vec::new(),
                drag: None,
                render_count: 0,
                last_primitive_count: 0,
                alignment_indexes: HashMap::new(),
                interval_indexes: HashMap::new(),
            })
        }

        pub fn set_scene(&mut self, json: &str) -> Result<(), JsValue> {
            let mut scene: Scene = serde_json::from_str(json)
                .map_err(|error| JsValue::from_str(&format!("Invalid SV scene: {error}")))?;
            for window in &mut scene.windows {
                window.clamp();
            }
            let reference_chrom = scene
                .windows
                .iter()
                .find(|window| window.slot == "reference")
                .map(|window| window.chrom.clone())
                .unwrap_or_default();
            for panel in ["upper", "lower"] {
                if !scene.variants.iter().any(|variant| variant.panel == panel) {
                    scene.variants.extend(derive_gap_variants(
                        &scene.alignments,
                        panel,
                        &reference_chrom,
                    ));
                }
            }
            self.scene = scene;
            self.alignment_indexes.clear();
            for panel in ["upper", "lower"] {
                self.alignment_indexes.insert(
                    panel.to_string(),
                    AlignmentIndex::new(&self.scene.alignments, panel),
                );
            }
            self.interval_indexes.clear();
            for track in &self.scene.interval_tracks {
                self.interval_indexes.insert(
                    track_key("interval", &track.slot, &track.id),
                    IntervalIndex::new(&track.features),
                );
            }
            self.layout = build_layout(&self.scene, self.width);
            self.resize(self.width, self.layout.height, self.dpr)?;
            Ok(())
        }

        pub fn set_windows(&mut self, json: &str) -> Result<(), JsValue> {
            let mut windows: Vec<GenomeWindow> = serde_json::from_str(json)
                .map_err(|error| JsValue::from_str(&format!("Invalid viewport: {error}")))?;
            for window in &mut windows {
                window.clamp();
            }
            self.scene.windows = windows;
            Ok(())
        }

        pub fn windows_json(&self) -> String {
            serde_json::to_string(&self.scene.windows).unwrap_or_else(|_| "[]".to_string())
        }

        pub fn layout_json(&self) -> String {
            serde_json::to_string(&self.layout).unwrap_or_else(|_| "{}".to_string())
        }

        pub fn resize(&mut self, width: f64, height: f64, dpr: f64) -> Result<(), JsValue> {
            self.width = width.max(1.0);
            self.height = height.max(1.0);
            self.dpr = dpr.clamp(1.0, 4.0);
            let physical_width = (self.width * self.dpr).round().max(1.0) as u32;
            let physical_height = (self.height * self.dpr).round().max(1.0) as u32;
            self.geometry_canvas.set_width(physical_width);
            self.geometry_canvas.set_height(physical_height);
            self.overlay_canvas.set_width(physical_width);
            self.overlay_canvas.set_height(physical_height);
            self.gl
                .viewport(0, 0, physical_width as i32, physical_height as i32);
            self.overlay
                .set_transform(self.dpr, 0.0, 0.0, self.dpr, 0.0, 0.0)?;
            self.layout = build_layout(&self.scene, self.width);
            Ok(())
        }

        pub fn required_height(&self) -> f64 {
            self.layout.height
        }
        pub fn physical_width(&self) -> u32 {
            self.geometry_canvas.width()
        }
        pub fn physical_height(&self) -> u32 {
            self.geometry_canvas.height()
        }

        pub fn render(&mut self) -> Result<String, JsValue> {
            let started = js_sys::Date::now();
            self.layout = build_layout(&self.scene, self.width);
            if self.height != self.layout.height {
                self.resize(self.width, self.layout.height, self.dpr)?;
            }
            self.hit_boxes.clear();
            let mut vertices = Vec::<f32>::new();
            self.build_backgrounds(&mut vertices);
            self.build_transcripts(&mut vertices);
            self.build_signals(&mut vertices);
            self.build_intervals(&mut vertices);
            self.build_alignments(&mut vertices);
            self.build_variants(&mut vertices);
            self.draw_geometry(&vertices)?;
            self.draw_overlay()?;
            self.render_count += 1;
            self.last_primitive_count = vertices.len() / 12;
            let elapsed = js_sys::Date::now() - started;
            Ok(serde_json::json!({
                "render_count": self.render_count,
                "render_ms": elapsed,
                "primitive_count": self.last_primitive_count,
                "hit_target_count": self.hit_boxes.len(),
                "width": self.width,
                "height": self.height,
            })
            .to_string())
        }

        pub fn pointer_down(&mut self, x: f64, y: f64, box_select: bool) {
            let slots = self.slots_for_y(y);
            self.drag = Some(DragState {
                start_x: x,
                start_y: y,
                current_x: x,
                current_y: y,
                box_select,
                original_windows: self.scene.windows.clone(),
                slots,
            });
        }

        pub fn pointer_move(&mut self, x: f64, y: f64) -> bool {
            let Some(drag) = self.drag.as_mut() else {
                return false;
            };
            drag.current_x = x;
            drag.current_y = y;
            if drag.box_select {
                return true;
            }
            let fraction = -(x - drag.start_x) / self.width.max(1.0);
            for window in &mut self.scene.windows {
                if !drag.slots.contains(&window.slot) {
                    continue;
                }
                if let Some(original) = drag
                    .original_windows
                    .iter()
                    .find(|candidate| candidate.slot == window.slot)
                {
                    *window = original.clone();
                    window.pan_fraction(fraction);
                }
            }
            true
        }

        pub fn pointer_up(&mut self, x: f64, y: f64) -> String {
            let Some(mut drag) = self.drag.take() else {
                return self.hit_test(x, y);
            };
            drag.current_x = x;
            drag.current_y = y;
            let distance = ((x - drag.start_x).powi(2) + (y - drag.start_y).powi(2)).sqrt();
            if drag.box_select && (x - drag.start_x).abs() > 2.0 {
                let left = drag.start_x.min(x).clamp(0.0, self.width);
                let right = drag.start_x.max(x).clamp(0.0, self.width);
                let start_fraction = left / self.width.max(1.0);
                let end_fraction = right / self.width.max(1.0);
                for window in &mut self.scene.windows {
                    let original = drag
                        .original_windows
                        .iter()
                        .find(|candidate| candidate.slot == window.slot)
                        .cloned()
                        .unwrap_or_else(|| window.clone());
                    *window = selected_window(&original, start_fraction, end_fraction);
                }
            }
            if distance <= 3.0 && !drag.box_select {
                self.hit_test(x, y)
            } else {
                serde_json::json!({"kind":"viewport", "windows":self.scene.windows}).to_string()
            }
        }

        pub fn cancel_pointer(&mut self) {
            self.drag = None;
        }

        pub fn wheel(&mut self, x: f64, y: f64, delta_x: f64, delta_y: f64, ctrl: bool) -> String {
            let slots = self.slots_for_y(y);
            let anchor = (x / self.width.max(1.0)).clamp(0.0, 1.0);
            let zooming = ctrl || delta_y.abs() >= delta_x.abs();
            for window in &mut self.scene.windows {
                if !slots.contains(&window.slot) {
                    continue;
                }
                if zooming {
                    let sensitivity = if ctrl { 0.0016 } else { 0.0012 };
                    window.zoom((delta_y * sensitivity).exp(), anchor);
                } else {
                    window.pan_fraction(delta_x / self.width.max(1.0));
                }
            }
            serde_json::json!({"kind":"viewport", "windows":self.scene.windows}).to_string()
        }

        pub fn zoom_all(&mut self, factor: f64) -> String {
            for window in &mut self.scene.windows {
                window.zoom(factor, 0.5);
            }
            self.windows_json()
        }

        pub fn center_targets(&mut self) -> String {
            self.scene.windows = centered_target_windows(&self.scene);
            self.windows_json()
        }

        pub fn hit_test(&self, x: f64, y: f64) -> String {
            let hit = self
                .hit_boxes
                .iter()
                .rev()
                .find(|hit| hit_rectangle(x, y, hit.x, hit.y, hit.width, hit.height));
            hit.map(|value| serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string()))
                .unwrap_or_else(|| "null".to_string())
        }

        pub fn snapshot_rgba(&self) -> Result<Uint8ClampedArray, JsValue> {
            let width = self.physical_width() as usize;
            let height = self.physical_height() as usize;
            let mut geometry = vec![0u8; width * height * 4];
            self.gl.read_pixels_with_opt_u8_array(
                0,
                0,
                width as i32,
                height as i32,
                Gl::RGBA,
                Gl::UNSIGNED_BYTE,
                Some(&mut geometry),
            )?;
            let overlay = self
                .overlay
                .get_image_data(0.0, 0.0, width as f64, height as f64)?
                .data();
            let overlay = overlay.0;
            let mut out = vec![0u8; geometry.len()];
            for y in 0..height {
                let source_y = height - y - 1;
                for x in 0..width {
                    let dst = (y * width + x) * 4;
                    let geo = (source_y * width + x) * 4;
                    let alpha = overlay[dst + 3] as f32 / 255.0;
                    for channel in 0..3 {
                        out[dst + channel] = ((overlay[dst + channel] as f32 * alpha)
                            + (geometry[geo + channel] as f32 * (1.0 - alpha)))
                            .round() as u8;
                    }
                    out[dst + 3] = 255;
                }
            }
            Ok(Uint8ClampedArray::from(out.as_slice()))
        }

        pub fn dispose(&self) {
            self.gl.delete_buffer(Some(&self.buffer));
            self.gl.delete_program(Some(&self.program));
            self.geometry_canvas.set_width(1);
            self.geometry_canvas.set_height(1);
            self.overlay_canvas.set_width(1);
            self.overlay_canvas.set_height(1);
        }
    }

    impl WasmRenderer {
        fn slots_for_y(&self, y: f64) -> Vec<String> {
            let Some(row) = self
                .layout
                .rows
                .iter()
                .find(|row| y >= row.y && y <= row.y + row.height)
            else {
                return self
                    .scene
                    .windows
                    .iter()
                    .map(|window| window.slot.clone())
                    .collect();
            };
            slots_for_row(&row.kind, &row.slot, &row.panel)
        }

        fn window(&self, slot: &str) -> Option<&GenomeWindow> {
            self.scene.windows.iter().find(|window| window.slot == slot)
        }

        fn x_for(window: &GenomeWindow, position: f64, width: f64) -> f64 {
            ((position - window.start) / window.span()) * width
        }

        fn push_rect(
            &self,
            vertices: &mut Vec<f32>,
            x: f64,
            y: f64,
            width: f64,
            height: f64,
            color: [f32; 4],
        ) {
            self.push_quad(
                vertices,
                [
                    (x, y),
                    (x + width, y),
                    (x + width, y + height),
                    (x, y + height),
                ],
                color,
            );
        }

        fn push_quad(&self, vertices: &mut Vec<f32>, points: [(f64, f64); 4], color: [f32; 4]) {
            vertices.extend_from_slice(&[
                points[0].0 as f32,
                points[0].1 as f32,
                points[1].0 as f32,
                points[1].1 as f32,
                points[2].0 as f32,
                points[2].1 as f32,
                points[3].0 as f32,
                points[3].1 as f32,
                color[0],
                color[1],
                color[2],
                color[3],
            ]);
        }

        fn build_backgrounds(&self, vertices: &mut Vec<f32>) {
            let light = self.scene.theme == "light";
            for row in &self.layout.rows {
                let color = match row.kind.as_str() {
                    "alignment" => {
                        if light {
                            [0.929, 0.961, 1.0, 1.0]
                        } else {
                            [0.051, 0.094, 0.188, 1.0]
                        }
                    }
                    "signal" | "interval" => {
                        if light {
                            [0.973, 0.984, 1.0, 1.0]
                        } else {
                            [0.063, 0.106, 0.176, 1.0]
                        }
                    }
                    _ => {
                        if light {
                            [0.969, 0.976, 0.984, 1.0]
                        } else {
                            [0.129, 0.133, 0.149, 1.0]
                        }
                    }
                };
                self.push_rect(vertices, 0.0, row.y, self.width, row.height, color);
            }
        }

        fn build_transcripts(&mut self, vertices: &mut Vec<f32>) {
            let rows = self.layout.rows.clone();
            for row in rows.iter().filter(|row| row.kind == "feature") {
                let Some(window) = self.window(&row.slot).cloned() else {
                    continue;
                };
                let mut transcripts: Vec<Transcript> = self
                    .scene
                    .transcripts
                    .iter()
                    .filter(|item| {
                        item.slot == row.slot
                            && item.end >= window.start
                            && item.start <= window.end
                    })
                    .cloned()
                    .collect();
                transcripts.sort_by(|left, right| {
                    left.start
                        .total_cmp(&right.start)
                        .then_with(|| left.end.total_cmp(&right.end))
                        .then_with(|| left.id.cmp(&right.id))
                });
                let color = parse_color(&window.color, [0.31, 0.65, 0.95, 0.85]);
                let bp_per_pixel = window.span() / self.width.max(1.0);

                if bp_per_pixel >= 1_000.0 {
                    // Chromosome/region overview: preserve every gene as pixel
                    // coverage, then merge overlapping pixels. This is an LOD,
                    // not a record cap, so no feature silently disappears.
                    let mut spans: Vec<(f64, f64)> = transcripts
                        .iter()
                        .map(|transcript| {
                            (
                                Self::x_for(&window, transcript.start, self.width)
                                    .clamp(0.0, self.width),
                                Self::x_for(&window, transcript.end, self.width)
                                    .clamp(0.0, self.width),
                            )
                        })
                        .filter(|(start, end)| end >= start)
                        .collect();
                    spans.sort_by(|left, right| left.0.total_cmp(&right.0));
                    let mut merged: Vec<(f64, f64)> = Vec::new();
                    for (start, end) in spans {
                        if let Some(previous) = merged.last_mut() {
                            if start <= previous.1 + 1.0 {
                                previous.1 = previous.1.max(end);
                                continue;
                            }
                        }
                        merged.push((start, end));
                    }
                    for (start, end) in merged {
                        self.push_rect(
                            vertices,
                            start,
                            row.y + 35.0,
                            (end - start).max(1.5),
                            8.0,
                            color,
                        );
                    }
                    continue;
                }

                let lane_count = if self.scene.compact { 2usize } else { 6usize };
                let mut lane_ends = vec![f64::NEG_INFINITY; lane_count];
                for transcript in transcripts {
                    let x0 =
                        Self::x_for(&window, transcript.start, self.width).clamp(0.0, self.width);
                    let x1 =
                        Self::x_for(&window, transcript.end, self.width).clamp(0.0, self.width);
                    let lane = lane_ends
                        .iter()
                        .position(|end| x0 >= *end + 4.0)
                        .unwrap_or_else(|| {
                            lane_ends
                                .iter()
                                .enumerate()
                                .min_by(|left, right| left.1.total_cmp(right.1))
                                .map(|(index, _)| index)
                                .unwrap_or(0)
                        });
                    lane_ends[lane] = lane_ends[lane].max(x1);
                    let y = row.y + 32.0 + (lane as f64 * 12.0);
                    self.push_rect(vertices, x0, y + 3.0, (x1 - x0).max(1.0), 2.0, color);
                    if transcript.exons.is_empty() {
                        self.push_rect(vertices, x0, y, (x1 - x0).max(1.5), 8.0, color);
                    } else {
                        for exon in &transcript.exons {
                            let exon_x0 =
                                Self::x_for(&window, exon.start, self.width).clamp(0.0, self.width);
                            let exon_x1 =
                                Self::x_for(&window, exon.end, self.width).clamp(0.0, self.width);
                            self.push_rect(
                                vertices,
                                exon_x0,
                                y,
                                (exon_x1 - exon_x0).max(1.5),
                                8.0,
                                color,
                            );
                        }
                    }
                    self.hit_boxes.push(HitBox {
                        x: x0,
                        y,
                        width: (x1 - x0).max(3.0),
                        height: 9.0,
                        kind: "transcript".to_string(),
                        slot: row.slot.clone(),
                        payload: serde_json::json!({"transcript": transcript}),
                    });
                }
            }
        }

        fn build_signals(&mut self, vertices: &mut Vec<f32>) {
            if !self.scene.show_bigwig {
                return;
            }
            let rows = self.layout.rows.clone();
            for row in rows.iter().filter(|row| row.kind == "signal") {
                let Some(window) = self.window(&row.slot).cloned() else {
                    continue;
                };
                let tracks: Vec<SignalTrack> = self
                    .scene
                    .signal_tracks
                    .iter()
                    .filter(|track| {
                        track.slot == row.slot
                            && (!self.scene.hide_inactive
                                || !self
                                    .scene
                                    .hidden_tracks
                                    .contains(&track_key("signal", &row.slot, &track.id)))
                    })
                    .cloned()
                    .collect();
                for (track_index, track) in tracks.iter().enumerate() {
                    let y = row.y + track_index as f64 * 38.0;
                    let key = track_key("signal", &row.slot, &track.id);
                    let hidden = self.scene.hidden_tracks.contains(&key);
                    self.hit_boxes.push(HitBox {
                        x: 0.0,
                        y,
                        width: 180.0,
                        height: 38.0,
                        kind: "track-toggle".to_string(),
                        slot: row.slot.clone(),
                        payload: serde_json::json!({"track_id":key,"label":track.label,"hidden":hidden}),
                    });
                    if hidden {
                        continue;
                    }
                    let max_value = track
                        .bins
                        .iter()
                        .filter_map(|bin| bin.value)
                        .fold(0.0f64, f64::max)
                        .max(0.0001);
                    for bin in &track.bins {
                        let Some(value) = bin.value else { continue };
                        if bin.end < window.start || bin.start > window.end {
                            continue;
                        }
                        let x0 = Self::x_for(&window, bin.start, self.width).clamp(0.0, self.width);
                        let x1 = Self::x_for(&window, bin.end, self.width).clamp(0.0, self.width);
                        let h = ((value / max_value).max(0.0) * 29.0).min(29.0);
                        self.push_rect(
                            vertices,
                            x0,
                            y + 33.0 - h,
                            (x1 - x0).max(1.0),
                            h,
                            [0.38, 0.65, 0.98, 0.65],
                        );
                    }
                }
            }
        }

        fn build_intervals(&mut self, vertices: &mut Vec<f32>) {
            if !self.scene.show_bigbed {
                return;
            }
            let rows = self.layout.rows.clone();
            for row in rows.iter().filter(|row| row.kind == "interval") {
                let Some(window) = self.window(&row.slot).cloned() else {
                    continue;
                };
                let tracks: Vec<IntervalTrack> = self
                    .scene
                    .interval_tracks
                    .iter()
                    .filter(|track| {
                        track.slot == row.slot
                            && (!self.scene.hide_inactive
                                || !self
                                    .scene
                                    .hidden_tracks
                                    .contains(&track_key("interval", &row.slot, &track.id)))
                    })
                    .cloned()
                    .collect();
                for (track_index, track) in tracks.iter().enumerate() {
                    let y = row.y + track_index as f64 * 24.0 + 7.0;
                    let key = track_key("interval", &row.slot, &track.id);
                    let hidden = self.scene.hidden_tracks.contains(&key);
                    self.hit_boxes.push(HitBox {
                        x: 0.0,
                        y: row.y + track_index as f64 * 24.0,
                        width: 180.0,
                        height: 24.0,
                        kind: "track-toggle".to_string(),
                        slot: row.slot.clone(),
                        payload: serde_json::json!({"track_id":key,"label":track.label,"hidden":hidden}),
                    });
                    if hidden {
                        continue;
                    }
                    let visible_features = self
                        .interval_indexes
                        .get(&key)
                        .map(|index| index.query(&track.features, &window))
                        .unwrap_or_else(|| visible_interval_indices(&track.features, &window));
                    for feature_index in visible_features {
                        let feature = &track.features[feature_index];
                        let x0 =
                            Self::x_for(&window, feature.start, self.width).clamp(0.0, self.width);
                        let x1 =
                            Self::x_for(&window, feature.end, self.width).clamp(0.0, self.width);
                        let w = (x1 - x0).max(2.0);
                        self.push_rect(vertices, x0, y, w, 10.0, [0.13, 0.78, 0.70, 0.78]);
                        self.hit_boxes.push(HitBox {
                            x: x0,
                            y,
                            width: w,
                            height: 12.0,
                            kind: "interval".to_string(),
                            slot: row.slot.clone(),
                            payload: serde_json::json!({"track":track.label,"feature":feature}),
                        });
                    }
                }
            }
        }

        fn build_alignments(&self, vertices: &mut Vec<f32>) {
            for row in self
                .layout
                .rows
                .iter()
                .filter(|row| row.kind == "alignment")
            {
                let Some(reference) = self.window("reference") else {
                    continue;
                };
                let target_slot = if row.panel == "lower" {
                    "bottom"
                } else {
                    "top"
                };
                let Some(target) = self.window(target_slot) else {
                    continue;
                };
                let indexes = self
                    .alignment_indexes
                    .get(&row.panel)
                    .map(|index| index.query(&self.scene.alignments, reference, target))
                    .unwrap_or_else(|| {
                        visible_alignment_indices(
                            &self.scene.alignments,
                            &self.scene.windows,
                            &row.panel,
                        )
                    });
                let blocks = aggregate_alignment_blocks(
                    &self.scene.alignments,
                    &indexes,
                    reference,
                    target,
                    self.width,
                );
                let merge_stride = alignment_lod_stride(blocks.len());
                for block in blocks.iter().step_by(merge_stride) {
                    let ref_x0 = Self::x_for(reference, block.ref_start, self.width);
                    let ref_x1 = Self::x_for(reference, block.ref_end, self.width);
                    let tgt_x0 = Self::x_for(target, block.tgt_start, self.width);
                    let tgt_x1 = Self::x_for(target, block.tgt_end, self.width);
                    let inverted = alignment_is_inverted(block);
                    let color = if inverted {
                        [0.973, 0.753, 0.255, 0.42]
                    } else {
                        [0.286, 0.722, 1.0, 0.16]
                    };
                    let points = if row.panel == "lower" {
                        if inverted {
                            [
                                (ref_x0, row.y),
                                (ref_x1, row.y),
                                (tgt_x0, row.y + row.height),
                                (tgt_x1, row.y + row.height),
                            ]
                        } else {
                            [
                                (ref_x0, row.y),
                                (ref_x1, row.y),
                                (tgt_x1, row.y + row.height),
                                (tgt_x0, row.y + row.height),
                            ]
                        }
                    } else if inverted {
                        [
                            (tgt_x0, row.y),
                            (tgt_x1, row.y),
                            (ref_x0, row.y + row.height),
                            (ref_x1, row.y + row.height),
                        ]
                    } else {
                        [
                            (tgt_x0, row.y),
                            (tgt_x1, row.y),
                            (ref_x1, row.y + row.height),
                            (ref_x0, row.y + row.height),
                        ]
                    };
                    self.push_quad(vertices, points, color);
                }
            }
        }

        fn build_variants(&mut self, vertices: &mut Vec<f32>) {
            let rows = self.layout.rows.clone();
            let variants = self.scene.variants.clone();
            for variant in variants {
                let panel = if variant.panel.is_empty() {
                    "upper"
                } else {
                    &variant.panel
                };
                let Some(row) = rows
                    .iter()
                    .find(|row| row.kind == "alignment" && row.panel == panel)
                else {
                    continue;
                };
                let target_slot = if panel == "lower" { "bottom" } else { "top" };
                let on_target = variant.kind == "insertion" || variant.kind == "gain_or_insertion";
                let slot = if on_target { target_slot } else { "reference" };
                let Some(window) = self.window(slot).cloned() else {
                    continue;
                };
                let (start, end) = if on_target && variant.target_end > variant.target_start {
                    (variant.target_start, variant.target_end)
                } else {
                    (variant.start, variant.end.max(variant.start + 1.0))
                };
                if end < window.start || start > window.end {
                    continue;
                }
                let x0 = Self::x_for(&window, start, self.width);
                let x1 = Self::x_for(&window, end, self.width);
                let w = (x1 - x0).abs().max(5.0);
                let x = x0.min(x1) - ((w - (x1 - x0).abs()) / 2.0);
                let y = match (panel, on_target) {
                    ("upper", true) => row.y,
                    ("upper", false) => row.y + row.height - 10.0,
                    ("lower", true) => row.y + row.height - 10.0,
                    _ => row.y,
                };
                let color = match variant.kind.as_str() {
                    "deletion" | "deletion_or_loss" => [1.0, 0.35, 0.36, 0.95],
                    "snv" => [0.957, 0.447, 0.714, 0.95],
                    _ => [0.373, 0.451, 0.902, 0.95],
                };
                self.push_rect(vertices, x, y, w, 10.0, color);
                self.hit_boxes.push(HitBox {
                    x,
                    y,
                    width: w,
                    height: 12.0,
                    kind: "variant".to_string(),
                    slot: slot.to_string(),
                    payload: serde_json::to_value(&variant).unwrap_or(serde_json::Value::Null),
                });
            }
        }

        fn draw_geometry(&self, vertices: &[f32]) -> Result<(), JsValue> {
            let light = self.scene.theme == "light";
            let clear = if light {
                [0.98, 0.985, 0.99, 1.0]
            } else {
                [0.04, 0.06, 0.10, 1.0]
            };
            self.gl.clear_color(clear[0], clear[1], clear[2], clear[3]);
            self.gl.clear(Gl::COLOR_BUFFER_BIT);
            if vertices.is_empty() {
                return Ok(());
            }
            self.gl.use_program(Some(&self.program));
            self.gl.bind_buffer(Gl::ARRAY_BUFFER, Some(&self.buffer));
            let data = Float32Array::from(vertices);
            self.gl
                .buffer_data_with_array_buffer_view(Gl::ARRAY_BUFFER, &data, Gl::DYNAMIC_DRAW);
            let stride = (12 * std::mem::size_of::<f32>()) as i32;
            let points_01 = self.gl.get_attrib_location(&self.program, "a_points_01") as u32;
            let points_23 = self.gl.get_attrib_location(&self.program, "a_points_23") as u32;
            let color = self.gl.get_attrib_location(&self.program, "a_color") as u32;
            self.gl.enable_vertex_attrib_array(points_01);
            self.gl
                .vertex_attrib_pointer_with_i32(points_01, 4, Gl::FLOAT, false, stride, 0);
            self.gl.vertex_attrib_divisor(points_01, 1);
            self.gl.enable_vertex_attrib_array(points_23);
            self.gl
                .vertex_attrib_pointer_with_i32(points_23, 4, Gl::FLOAT, false, stride, 16);
            self.gl.vertex_attrib_divisor(points_23, 1);
            self.gl.enable_vertex_attrib_array(color);
            self.gl
                .vertex_attrib_pointer_with_i32(color, 4, Gl::FLOAT, false, stride, 32);
            self.gl.vertex_attrib_divisor(color, 1);
            let viewport = self
                .gl
                .get_uniform_location(&self.program, "u_viewport")
                .ok_or_else(|| JsValue::from_str("Missing viewport shader uniform"))?;
            self.gl
                .uniform2f(Some(&viewport), self.width as f32, self.height as f32);
            self.gl
                .draw_arrays_instanced(Gl::TRIANGLES, 0, 6, (vertices.len() / 12) as i32);
            Ok(())
        }

        fn draw_overlay(&self) -> Result<(), JsValue> {
            self.overlay
                .set_transform(self.dpr, 0.0, 0.0, self.dpr, 0.0, 0.0)?;
            self.overlay.clear_rect(0.0, 0.0, self.width, self.height);
            let light = self.scene.theme == "light";
            self.overlay.set_font("500 10px 'IBM Plex Mono', monospace");
            self.overlay.set_text_baseline("middle");
            for row in &self.layout.rows {
                if row.kind == "feature" {
                    if let Some(window) = self.window(&row.slot) {
                        self.overlay
                            .set_fill_style_str(if light { "#4a6a8a" } else { "#9eb8d6" });
                        let label = format!(
                            "{}  {}:{:.0}-{:.0}",
                            window.label, window.chrom, window.start, window.end
                        );
                        self.overlay.fill_text(&label, 8.0, row.y + 13.0)?;
                        let step = nice_tick_step(window.span() / 6.0);
                        let mut tick = (window.start / step).ceil() * step;
                        while tick <= window.end {
                            let x = Self::x_for(window, tick, self.width);
                            self.overlay.set_fill_style_str(if light {
                                "#4a6a8a"
                            } else {
                                "#64748b"
                            });
                            self.overlay
                                .fill_text(&format_coord(tick), x + 2.0, row.y + 27.0)?;
                            tick += step;
                        }
                        if window.span() <= 2_000.0 {
                            if let Some(sequence) = self
                                .scene
                                .sequences
                                .iter()
                                .find(|sequence| sequence.slot == row.slot)
                            {
                                let base_width = self.width / window.span();
                                if base_width >= 1.0 {
                                    let baseline = row.y + row.height - 8.0;
                                    if base_width >= 5.0 {
                                        self.overlay.set_font("600 9px 'IBM Plex Mono', monospace");
                                    }
                                    for (index, base) in sequence.sequence.chars().enumerate() {
                                        let position = sequence.start + index as f64;
                                        if position < window.start || position > window.end {
                                            continue;
                                        }
                                        let x = Self::x_for(window, position, self.width);
                                        let color = match base.to_ascii_uppercase() {
                                            'A' => "#22c55e",
                                            'C' => "#3b82f6",
                                            'G' => "#f59e0b",
                                            'T' => "#ef4444",
                                            _ => {
                                                if light {
                                                    "#64748b"
                                                } else {
                                                    "#94a3b8"
                                                }
                                            }
                                        };
                                        self.overlay.set_fill_style_str(color);
                                        if base_width >= 5.0 {
                                            self.overlay.fill_text(
                                                &base.to_ascii_uppercase().to_string(),
                                                x + 1.0,
                                                baseline,
                                            )?;
                                        } else {
                                            self.overlay.fill_rect(
                                                x,
                                                baseline - 4.0,
                                                base_width.max(1.0),
                                                4.0,
                                            );
                                        }
                                    }
                                    self.overlay.set_font("500 10px 'IBM Plex Mono', monospace");
                                }
                            }
                        }
                    }
                } else if row.kind == "signal" || row.kind == "interval" {
                    let labels: Vec<(String, bool)> =
                        if row.kind == "signal" {
                            self.scene
                                .signal_tracks
                                .iter()
                                .filter(|track| {
                                    track.slot == row.slot
                                        && (!self.scene.hide_inactive
                                            || !self.scene.hidden_tracks.contains(&track_key(
                                                "signal", &row.slot, &track.id,
                                            )))
                                })
                                .map(|track| {
                                    let hidden = self
                                        .scene
                                        .hidden_tracks
                                        .contains(&track_key("signal", &row.slot, &track.id));
                                    (track.label.clone(), hidden)
                                })
                                .collect()
                        } else {
                            self.scene
                                .interval_tracks
                                .iter()
                                .filter(|track| {
                                    track.slot == row.slot
                                        && (!self.scene.hide_inactive
                                            || !self.scene.hidden_tracks.contains(&track_key(
                                                "interval", &row.slot, &track.id,
                                            )))
                                })
                                .map(|track| {
                                    let hidden = self
                                        .scene
                                        .hidden_tracks
                                        .contains(&track_key("interval", &row.slot, &track.id));
                                    (track.label.clone(), hidden)
                                })
                                .collect()
                        };
                    let pitch = if row.kind == "signal" { 38.0 } else { 24.0 };
                    self.overlay
                        .set_fill_style_str(if light { "#53759a" } else { "#9eb8d6" });
                    for (index, (label, hidden)) in labels.iter().enumerate() {
                        self.overlay.fill_text(
                            &format!("{} {label}", if *hidden { "○" } else { "●" }),
                            8.0,
                            row.y + index as f64 * pitch + pitch / 2.0,
                        )?;
                    }
                }
            }
            if let Some(drag) = &self.drag {
                if drag.box_select {
                    let left = drag.start_x.min(drag.current_x);
                    let top = drag.start_y.min(drag.current_y);
                    let width = (drag.current_x - drag.start_x).abs();
                    let height = (drag.current_y - drag.start_y).abs();
                    self.overlay.set_fill_style_str("rgba(14,165,233,0.13)");
                    self.overlay.fill_rect(left, top, width, height);
                    self.overlay.set_stroke_style_str("#38bdf8");
                    self.overlay.set_line_width(1.5);
                    self.overlay.stroke_rect(left, top, width, height);
                }
            }
            Ok(())
        }
    }

    fn compile_shader(gl: &Gl, shader_type: u32, source: &str) -> Result<WebGlShader, JsValue> {
        let shader = gl
            .create_shader(shader_type)
            .ok_or_else(|| JsValue::from_str("Unable to create shader"))?;
        gl.shader_source(&shader, source);
        gl.compile_shader(&shader);
        if gl
            .get_shader_parameter(&shader, Gl::COMPILE_STATUS)
            .as_bool()
            .unwrap_or(false)
        {
            Ok(shader)
        } else {
            Err(JsValue::from_str(
                &gl.get_shader_info_log(&shader)
                    .unwrap_or_else(|| "Shader compilation failed".to_string()),
            ))
        }
    }

    fn link_program(
        gl: &Gl,
        vertex: &WebGlShader,
        fragment: &WebGlShader,
    ) -> Result<WebGlProgram, JsValue> {
        let program = gl
            .create_program()
            .ok_or_else(|| JsValue::from_str("Unable to create WebGL program"))?;
        gl.attach_shader(&program, vertex);
        gl.attach_shader(&program, fragment);
        gl.link_program(&program);
        if gl
            .get_program_parameter(&program, Gl::LINK_STATUS)
            .as_bool()
            .unwrap_or(false)
        {
            Ok(program)
        } else {
            Err(JsValue::from_str(
                &gl.get_program_info_log(&program)
                    .unwrap_or_else(|| "Program linking failed".to_string()),
            ))
        }
    }

    fn parse_color(raw: &str, fallback: [f32; 4]) -> [f32; 4] {
        let value = raw.trim().trim_start_matches('#');
        if value.len() != 6 {
            return fallback;
        }
        let Ok(red) = u8::from_str_radix(&value[0..2], 16) else {
            return fallback;
        };
        let Ok(green) = u8::from_str_radix(&value[2..4], 16) else {
            return fallback;
        };
        let Ok(blue) = u8::from_str_radix(&value[4..6], 16) else {
            return fallback;
        };
        [
            red as f32 / 255.0,
            green as f32 / 255.0,
            blue as f32 / 255.0,
            fallback[3],
        ]
    }
}

#[cfg(any(target_arch = "wasm32", test))]
fn nice_tick_step(raw: f64) -> f64 {
    if !raw.is_finite() || raw <= 0.0 {
        return 1.0;
    }
    let magnitude = 10f64.powf(raw.log10().floor());
    (raw / magnitude).ceil() * magnitude
}

#[cfg(any(target_arch = "wasm32", test))]
fn format_coord(value: f64) -> String {
    let raw = value.round() as i64;
    let digits = raw.abs().to_string();
    let mut out = String::new();
    for (index, character) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            out.push(',');
        }
        out.push(character);
    }
    if raw < 0 {
        format!("-{out}")
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(slot: &str, start: f64, end: f64, length: f64) -> GenomeWindow {
        GenomeWindow {
            slot: slot.to_string(),
            chrom: "chr1".to_string(),
            start,
            end,
            chrom_length: length,
            ..Default::default()
        }
    }

    #[test]
    fn viewport_clamps_at_both_chromosome_edges() {
        let mut view = window("reference", -50.0, 950.0, 10_000.0);
        view.clamp();
        assert_eq!(view.start, 1.0);
        assert_eq!(view.end, 1001.0);
        view.start = 9_900.0;
        view.end = 10_900.0;
        view.clamp();
        assert_eq!(view.start, 9_000.0);
        assert_eq!(view.end, 10_000.0);
    }

    #[test]
    fn zoom_preserves_the_requested_anchor() {
        let mut view = window("reference", 1_000.0, 2_000.0, 10_000.0);
        let anchor_before = view.start + view.span() * 0.25;
        view.zoom(0.5, 0.25);
        let anchor_after = view.start + view.span() * 0.25;
        assert!((anchor_before - anchor_after).abs() <= 1.0);
        assert_eq!(view.span(), 500.0);
    }

    #[test]
    fn layout_supports_pair_and_trio_scenes() {
        let mut pair = Scene::default();
        pair.windows = vec![
            window("top", 1.0, 1000.0, 10000.0),
            window("reference", 1.0, 1000.0, 10000.0),
        ];
        let pair_layout = build_layout(&pair, 1200.0);
        assert_eq!(
            pair_layout
                .rows
                .iter()
                .filter(|row| row.kind == "alignment")
                .count(),
            1
        );
        pair.windows.push(window("bottom", 1.0, 1000.0, 10000.0));
        let trio_layout = build_layout(&pair, 1200.0);
        assert_eq!(
            trio_layout
                .rows
                .iter()
                .filter(|row| row.kind == "alignment")
                .count(),
            2
        );
        assert!(trio_layout.height > pair_layout.height);
    }

    #[test]
    fn culling_matches_either_visible_side() {
        let windows = vec![
            window("reference", 100.0, 200.0, 1000.0),
            window("top", 500.0, 600.0, 1000.0),
        ];
        let blocks = vec![
            AlignmentBlock {
                panel: "upper".into(),
                ref_start: 120.0,
                ref_end: 130.0,
                tgt_start: 50.0,
                tgt_end: 60.0,
                ..Default::default()
            },
            AlignmentBlock {
                panel: "upper".into(),
                ref_start: 10.0,
                ref_end: 20.0,
                tgt_start: 520.0,
                tgt_end: 530.0,
                ..Default::default()
            },
            AlignmentBlock {
                panel: "upper".into(),
                ref_start: 10.0,
                ref_end: 20.0,
                tgt_start: 50.0,
                tgt_end: 60.0,
                ..Default::default()
            },
            AlignmentBlock {
                panel: "upper".into(),
                ref_start: 10.0,
                ref_end: 20.0,
                tgt_start: 700.0,
                tgt_end: 710.0,
                ..Default::default()
            },
        ];
        assert_eq!(
            visible_alignment_indices(&blocks, &windows, "upper"),
            vec![0, 1, 3]
        );
        let index = AlignmentIndex::new(&blocks, "upper");
        assert_eq!(
            index.query(&blocks, &windows[0], &windows[1]),
            vec![0, 1, 3]
        );
    }

    #[test]
    fn pair_and_trio_rows_preserve_linked_and_independent_movement() {
        assert_eq!(
            slots_for_row("alignment", "", "upper"),
            vec!["reference", "top"]
        );
        assert_eq!(
            slots_for_row("alignment", "", "lower"),
            vec!["reference", "bottom"]
        );
        assert_eq!(slots_for_row("feature", "reference", ""), vec!["reference"]);
    }

    #[test]
    fn box_selection_transforms_the_committed_window() {
        let original = window("reference", 1_000.0, 2_000.0, 10_000.0);
        let selected = selected_window(&original, 0.25, 0.75);
        assert_eq!(selected.start, 1_250.0);
        assert_eq!(selected.end, 1_750.0);
    }

    #[test]
    fn interval_culling_and_alignment_lod_are_stable() {
        let view = window("reference", 100.0, 200.0, 1_000.0);
        let features = vec![
            IntervalFeature {
                start: 10.0,
                end: 99.0,
                ..Default::default()
            },
            IntervalFeature {
                start: 100.0,
                end: 120.0,
                ..Default::default()
            },
            IntervalFeature {
                start: 190.0,
                end: 250.0,
                ..Default::default()
            },
        ];
        assert_eq!(visible_interval_indices(&features, &view), vec![1, 2]);
        assert_eq!(alignment_lod_stride(20_000), 1);
        assert_eq!(alignment_lod_stride(24_000), 1);
    }

    #[test]
    fn inverted_alignment_fragments_are_never_merged() {
        let blocks = vec![
            AlignmentBlock {
                ref_start: 100.0,
                ref_end: 150.0,
                tgt_start: 500.0,
                tgt_end: 550.0,
                strand: "-".into(),
                ..Default::default()
            },
            AlignmentBlock {
                ref_start: 151.0,
                ref_end: 200.0,
                tgt_start: 450.0,
                tgt_end: 499.0,
                strand: "-".into(),
                ..Default::default()
            },
            AlignmentBlock {
                ref_start: 201.0,
                ref_end: 250.0,
                tgt_start: 551.0,
                tgt_end: 600.0,
                strand: "+".into(),
                ..Default::default()
            },
        ];
        let reference = window("reference", 0.0, 1_000.0, 10_000.0);
        let target = window("top", 0.0, 1_000.0, 10_000.0);
        let aggregated =
            aggregate_alignment_blocks(&blocks, &[0, 1, 2], &reference, &target, 1_000.0);
        assert_eq!(aggregated.len(), 3);
    }

    #[test]
    fn subpixel_forward_fragments_merge_without_dropping_coverage() {
        let blocks = vec![
            AlignmentBlock {
                ref_start: 100.0,
                ref_end: 150.0,
                tgt_start: 500.0,
                tgt_end: 550.0,
                strand: "+".into(),
                ..Default::default()
            },
            AlignmentBlock {
                ref_start: 150.5,
                ref_end: 200.0,
                tgt_start: 550.5,
                tgt_end: 600.0,
                strand: "+".into(),
                ..Default::default()
            },
        ];
        let reference = window("reference", 0.0, 1_000.0, 10_000.0);
        let target = window("top", 0.0, 1_000.0, 10_000.0);
        let aggregated = aggregate_alignment_blocks(&blocks, &[0, 1], &reference, &target, 1_000.0);
        assert_eq!(aggregated.len(), 1);
        assert_eq!(aggregated[0].ref_end, 200.0);
        assert_eq!(aggregated[0].tgt_end, 600.0);
    }

    #[test]
    fn gap_derived_variants_preserve_missing_callsets() {
        let blocks = vec![
            AlignmentBlock {
                panel: "upper".into(),
                id: "left".into(),
                ref_start: 100.0,
                ref_end: 200.0,
                tgt_start: 500.0,
                tgt_end: 600.0,
                strand: "+".into(),
                ..Default::default()
            },
            AlignmentBlock {
                panel: "upper".into(),
                id: "right".into(),
                ref_start: 320.0,
                ref_end: 420.0,
                tgt_start: 610.0,
                tgt_end: 710.0,
                strand: "+".into(),
                ..Default::default()
            },
        ];
        let variants = derive_gap_variants(&blocks, "upper", "chr1");
        assert_eq!(variants.len(), 1);
        assert_eq!(variants[0].kind, "deletion");
        assert_eq!(variants[0].ref_length, 120.0);
        assert_eq!(variants[0].alt_length, 10.0);
    }

    #[test]
    fn centering_uses_visible_alignment_extents() {
        let mut scene = Scene::default();
        scene.windows = vec![
            window("top", 1.0, 101.0, 10_000.0),
            window("reference", 100.0, 200.0, 10_000.0),
        ];
        scene.alignments = vec![AlignmentBlock {
            panel: "upper".into(),
            ref_start: 110.0,
            ref_end: 190.0,
            tgt_start: 500.0,
            tgt_end: 600.0,
            ..Default::default()
        }];
        let centered = centered_target_windows(&scene);
        let target = centered
            .iter()
            .find(|candidate| candidate.slot == "top")
            .unwrap();
        assert_eq!(target.start, 500.0);
        assert_eq!(target.end, 600.0);
    }

    #[test]
    fn hit_testing_and_epoch_rejection_are_inclusive() {
        assert!(hit_rectangle(10.0, 20.0, 10.0, 20.0, 30.0, 40.0));
        assert!(hit_rectangle(40.0, 60.0, 10.0, 20.0, 30.0, 40.0));
        assert!(!hit_rectangle(40.1, 60.0, 10.0, 20.0, 30.0, 40.0));
        assert!(is_current_epoch(12, 12));
        assert!(!is_current_epoch(11, 12));
    }

    #[test]
    fn cache_budget_evicts_oldest_entries() {
        let mut cache = CacheBudget::new(100);
        assert!(cache.insert("a".into(), 60).is_empty());
        assert_eq!(cache.insert("b".into(), 60), vec!["a"]);
        assert_eq!(cache.used(), 60);
        assert_eq!(cache.insert("c".into(), 50), vec!["b"]);
    }

    #[test]
    fn tick_step_and_coordinate_format_are_stable() {
        assert_eq!(nice_tick_step(167.0), 200.0);
        assert_eq!(format_coord(1_234_567.0), "1,234,567");
    }
}
