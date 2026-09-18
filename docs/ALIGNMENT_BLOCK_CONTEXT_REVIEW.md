# Block context review — 14 September 2026

Reviewed the initial implementation and the running 44-mammal EPO alignment, including block 3 and its human, mouse and rat rows. The changes below are a corrective pass over the existing implementation, not a claim that the full earlier proposal has been delivered.

## Main design finding: shared gaps dominate the selected comparison

Block 3 contains 449,948 columns. In the human (`homo_sapiens.1`), mouse (`mus_musculus.4`) and rat (`rattus_norvegicus.5`) rows, 339,963 columns (75.6%) are gaps in all three. The longest shared run is 11,331 columns, at zero-based half-open interval [384353,395684). These counts were read from the existing local alignment index without changing it.

Recommend a **Collapse shared gaps** display option, enabled by default when inspecting a subset, with **Original columns** available alongside it. Collapse only columns explicitly gapped in every included row. Unknown bases, absent coverage and bases in any included row prevent collapsing. A reference gap opposite mouse or rat sequence must remain visible: there are 40,412 such human gap columns in this example.

This requires an explicit source-column to display-column mapping shared by sequence painting, gene projection, comparison bands, rulers, hit testing, selections and camera anchors. A short seam should identify each omitted run, show its original range and length, and offer expansion. Adding/removing rows recomputes the mapping while preserving the source position under the viewport centre; changing reference alone does not. Exports and API coordinates continue to use original alignment columns. Test missing coverage, reverse rows, a completely gapped cohort, selections crossing seams, and restoration after changing the included rows.

**Gap folding is not implemented in this corrective pass.** Removing reference gaps directly from sequence strings would misregister the annotation tracks and lose real comparison information.

## Corrected implementation issues

- **Oversized requests:** annotation padding could turn a supported visible interval into the 65,536-column rejection seen in the running app. Padding now respects the limit. Wider views explicitly ask the user to zoom for annotation and comparison detail rather than sending an invalid or unbounded detailed request.
- **Invisible later rows:** the eight-row API limit was applied to the entire visible row set. Visible rows are now batched, so rows after the eighth are not silently excluded.
- **Pinned reference:** sequence request planners still subtracted vertical scroll from the reference, even though the painter did not. Requests now honour pinning; scrolling content and hits are clipped below the pinned group.
- **Gene placement:** all transcripts occupied one track position. Models now pack into separate lanes when their extents overlap, with room reserved for labels. Transcript extents use all feature boundaries; feature arrays are grouped by type, so their first/last elements are not reliable extents, particularly after reverse projection.
- **Exon selection:** broad transcript hit rectangles were appended after their exon hits and intercepted clicks. Feature hits now have priority. Adjacent-mode guides also use the active pair's upper row instead of the retained global reference.
- **Comparison placement:** base-level views reused a large padded window with too few bins, making broad summaries look precisely placed. Comparison windows now have smaller padding and up to 4,096 bins, resolving individual columns at base zoom. Bin ink cannot extend beyond its bin; double gaps occupy display space without inflating other categories.
- **Feature measurements:** requests now use the feature owner's row and its projected extent, independently of the viewport and global reference. Cache keys include the complete feature ranges. Clipped-feature measurements are explicitly labelled partial.
- **Genomic context:** unstable array dependencies repeatedly re-fetched models. Requests now use stable identities and old responses are not drawn under new windows. Feature clicks map the active pair through the block-context endpoint; an all-gap mapping remains unmapped. Models pack by overlap, requests clamp to available source bounds, and rulers display one-based base labels.
- **Controls:** comparison choices are shorter, the active pair is explicit, and **Show only this pair** gives a direct way to reduce clutter. Transcript choices and bounded isoform expansion are accessible in **Genes and transcripts**. Underlying block navigation, auto-arrangement, filter/hide and cycle controls are hidden inside context. **Fit selected transcripts** was renamed **Fit block**, which is the behaviour it actually implements.

## Remaining work

- Shared-gap folding is the highest-value next improvement for the rat/mouse/human use case.
- Whole-block annotation overview is not implemented: detailed annotation loads after zooming to at most 65,536 columns. A bounded coarse gene summary would make discovery easier without requiring the reader to know where a gene is.
- Genomic-track clicks currently recenter that track. Bidirectional genomic-to-alignment selection, genomic sequence letters, and fitting explicitly selected transcript pairs remain separate work.
- Isoforms are available only within the server's existing page limits. Complete gene/isoform pagination and a clearer route to omitted entries remain necessary; a truncation notice is not a replacement for pagination.
- Splice-base inspection, start/stop annotations and boundary-offset comparisons from the proposal are not complete. The current display should be described as annotation and observed alignment context.

## Verification

The complete frontend suite passed: 1,193 passed and one existing skip. All 102 alignment backend tests passed using the available local test dependencies. Targeted tests cover request bounds, batching, pinned-reference requests, transcript packing/extents, feature hit precedence, bin widths, and genomic selection mapping on both strands, including all-gap selections. Scoped ESLint has no errors; the production Vite build passes with its existing large-chunk warning.

Browser checks used the real EPO file: block 3, entry into context, reference/pair controls, focusing human–mouse, zooming to supported detail, and loading a human transcript through the new transcript controls. The original Electron window could be read but its click interface failed, so browser testing used a separate localhost tab. This is not a complete visual acceptance test of every pan/zoom, gene-selection and genomic-panel interaction.
