# Homology searches and comparison

The Homology view accepts any number of active genomes. Enter a shared gene
symbol or ID and choose **Search all**, or enter a query override for a particular
genome and choose **Search genome**. **Use shared query** clears that override.
Missing homology files and failed or empty searches stay visible in the controls.
Up to three searches run concurrently.

Both ends of each homology relationship are searched, case-insensitively. Exact
matches on either end take precedence over substring matches. Matching hit-side
identifiers resolve to the TSV's local query genes, whose full hit lists are then
loaded. This is a single relationship step, not transitive family inference.
Multiple local genes remain separate and carry their match provenance.

The **Summary matrix** groups target genes by species and assembly. Columns are
searched genomes, with separate columns for multiple resolved local genes. Cells
show homology types, identity, coverage, evidence counts, and ranked best hits.
Result tabs and matrix headers use compact genome pills with dataset badges.
The tab strip has shaped tabs and an active underline. Arrow keys, Home, and End
switch tabs and reveal overflowing tabs without moving the page vertically.
The hit viewport fills the available height below the app toolbar, reserving
space for pagination. Loading, failed, and filtered-empty pages keep that same
row height. Scrolling down over partially visible rows first moves the outer
page until the table's column headers reach the top of the workspace. Result
tabs and summary metadata move above the viewport during this step. Further
scrolling moves the hits underneath the sticky column headers. Scrolling up returns through the rows
before moving back toward search controls. Page Up/Down and arrow keys work when
the hit region has keyboard focus. Horizontal scrolling remains independent.
Scrollbars follow the selected light/dark theme.
Matrix headers put each query gene's symbol and stable ID on separate lines.
Cells use the same compact hit types as individual tables, with a preferred-hit
star and `XX% id · YY% cov`. Type explanations and ranking details are tooltips.
Click a cell to open its genome's full table on the page containing supporting
evidence, with the first supporting row positioned below the column headings.
Navigation preserves the active display filters and full result count; it does
not filter the table to one gene or target. If those filters hide the evidence,
the table opens with its normal filtered results. Each successful genome also
has a separate table tab with sorting, column selection, and 100-row pages.
Individual tables use compact headings, abbreviated species names, identity bars,
and coverage circles. Query context is shown once per gene group and hidden from
the default columns; **All columns** restores every original TSV column. Match
provenance is available in each query-group label's tooltip. Individual tabs
lead directly into table headings, without a repeated query/assembly bar.
Gene links use the shared Genome Browser icon where a local annotation is
available; query-group links open the source gene and hit links open the target.

A ranked best hit is computed separately for each local gene and target genome:
RBBH outranks BBH, which outranks other types; within a tier the score is
`0.6 × identity + 0.4 × coverage`. If one score is missing, the available score is
used; if both are missing, it ranks below scored rows in the same tier. Equal
ranks are retained. TSV best-hit labels and score-ranked hits are distinguished.
Filters never promote a lower-ranked hit to best.

Support counts distinct genome selections, not gene copies or duplicate rows.
Best-hit differences compare the best-hit sets across genomes, including all
resolved local genes in each genome's set. Unavailable, failed, pending, and
unresolved genomes are excluded from the comparison denominator. A filtered cell
is different from **No hit reported**; neither proves biological absence.
Incomplete target identities are kept separate rather than merged by symbol.

All TSV targets are included by default. Target filters can restrict results to
active genomes, locally available genomes, or an individual target assembly.
Browser links select the target genome's annotation; if several datasets match,
the user chooses one. Targets without a local annotation can still be compared.

Queries, filters, tables, and selections survive view changes and genome toggles
within the app session. Removing a genome from the active set cancels its pending
work; completed results can be reused on reactivation. Results are invalidated
when a configured path changes or an availability check detects a changed source
fingerprint. Availability is checked on opening the view and every 30 seconds
while it is open. Restarting the app starts a fresh search workspace.

Completed downloads are also discovered in the selected dataset's local folder,
even if the genome was selected before its homology file was downloaded. Discovery
keeps releases separate and does not require reselecting the genome. The download
selector checks the release's live FTP `homology/` directory for dated exports
omitted from the species catalogue, retaining the annotation release as the
download's dataset identity.

## Backend interface

The original `GET /api/homology/query` retains its existing behavior and response.
The workspace uses `POST /api/homology/search`, with an exact, release-aware
`genome_key` and `gene_query`. Optional request fields are `min_identity`,
`min_coverage`, `types` (`null` means all; `[]` means none), `target_assemblies`
(JSON strings containing normalized species/assembly pairs), `offset`, `limit`,
`query_gene_id`, `target_key`, `sort_key`, `direction`, and `include_evidence`.
`focus_query_gene_id` and `focus_target_key` locate the first supporting row in
the complete filtered/sorted result set, select its normal page, and return its
`focus_row_id`. They do not constrain which rows are included. The returned
`offset` identifies the selected page, and `filtered_rows` remains the full count.

The response includes `resolved_genes` with provenance, `matched_by`, the source
fingerprint token, original/canonical column mappings, `total_rows`,
`filtered_rows`, and paginated original `rows`. Each row includes its original
`values`, row ordinal, local gene, target key, and best-hit flag. `evidence`
contains complete, unfiltered source-gene/target groups with type/score variants
and duplicate counts. Pagination and detail drilling never reduce this evidence.
Set `include_evidence` to false for subsequent detail pages. Limit defaults to
100 and is capped at 500.

`GET /api/homology/sources` reports configured session sources and fingerprint
tokens without building indexes. File access goes through the existing configured
path validation. Missing files, unknown genome keys, unsupported headers, and
invalid percentage thresholds produce explicit errors.

SQLite indexes under the backend cache retain both endpoints' searchable IDs and
names and each original row. Cold builds are serialized, streamed, and atomically
published. The schema version, file size, and nanosecond modification time determine
reuse; these indexes can be discarded and rebuilt without affecting source TSVs.

## Verification

Run `python3 -m unittest discover -s backend/tests -p 'test_homology_search.py'`
and `node --test frontend/tests/homologyWorkspace.test.js frontend/tests/homologyScroll.test.js`. The full frontend test
suite and production build also cover application integration.

With the frontend dev server running, open
`/tests/fixtures/homology/workspace.html` for an isolated browser fixture. It uses
the real controller and components with synthetic API responses and does not
write user configuration. It covers three successful genomes, duplicate evidence,
pagination, target navigation, theme changes, reordering, adding twelve genomes,
view switching, and source invalidation. The queries `fail` and `none` exercise
failed and empty searches.
The fixture includes 225 rows per source. Clicking the Human/D2 summary cell
should select the second 100-row page, retain other hits and the 225-row count,
and position the first D2 row directly below the table header. Previous/Next
should continue navigating the full table.

For the scroll regression, search at least three genomes, scroll the outer view
until the tab strip is fully visible, and switch between the summary and genome
tabs with mouse clicks and arrow keys. The strip should stay at the same vertical
position while detail rows load and after they arrive. Repeat with a filter that
hides all rows and with fifteen genomes; Home/End should reveal the first/last
tab horizontally while preserving the outer scroll position.
Also start with the hit region partially on screen and scroll down over its
rows: only the outer view should move until the table's column headers reach
the top of the workspace, including after the results tabs have passed that edge.
Continue scrolling and check that rows move while the outer view stays still.
Reverse through the first row to return to search controls. Repeat for an
individual table and with the hit region focused using Page Down/Up.
