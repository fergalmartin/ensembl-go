import { useMemo, useState } from 'react'
import AppButtonIcon from './AppButtonIcon'

function IconTile({ buttonId, label, theme }) {
  const isLight = theme === 'light'
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className={`inline-flex h-7 w-7 items-center justify-center rounded-md ${isLight ? 'bg-[#0099ff] text-white' : 'bg-blue-600 text-white'
          }`}
        title={label}
      >
        <AppButtonIcon buttonId={buttonId} isLight={isLight} compact />
      </span>
      <span className={isLight ? 'text-gray-700' : 'text-gray-300'}>{label}</span>
    </span>
  )
}

function SectionCard({ id, title, icon, openSections, setOpenSections, theme, children }) {
  const isLight = theme === 'light'
  const open = openSections.includes(id)
  return (
    <section
      className={`rounded-xl border overflow-hidden ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800 border-gray-700'
        }`}
    >
      <button
        type="button"
        onClick={() => {
          setOpenSections((prev) => (
            prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
          ))
        }}
        className={`w-full flex items-center justify-between px-5 py-4 text-left ${isLight ? 'hover:bg-gray-50' : 'hover:bg-gray-750'
          }`}
      >
        <div className="flex items-center gap-3">
          <span
            className={`inline-flex h-8 w-8 items-center justify-center rounded-md ${isLight ? 'bg-[#0099ff] text-white' : 'bg-blue-600 text-white'
              }`}
          >
            {icon}
          </span>
          <span className={`text-sm font-semibold ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>{title}</span>
        </div>
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`transition-transform ${open ? 'rotate-180' : ''} ${isLight ? 'text-gray-500' : 'text-gray-400'}`}
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div className={`px-5 pb-5 border-t text-sm leading-relaxed ${isLight ? 'border-gray-100 text-gray-700' : 'border-gray-700 text-gray-300'}`}>
          <div className="pt-4 space-y-3 [&_p]:my-0 [&_p]:leading-relaxed [&_p+p]:mt-2.5 [&_li]:leading-relaxed [&_li+li]:mt-1.5">
            {children}
          </div>
        </div>
      )}
    </section>
  )
}

function HelpGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 32 32" fill="currentColor" stroke="none" aria-hidden="true">
      <path d="M19.6348,26.8946991C19.6348,29.2632008,17.7399998,31,15.5295,31s-4.1052999-1.8946991-4.1052999-4.1053009s1.8947001-4.1053009,4.1052999-4.1053009S19.6348,24.5263004,19.6348,26.8946991z M25.9505997,9.6842003c0,6.6315994-7.1053009,6.6315994-7.1053009,9.1578999v0.6315994c0,0.6315994-0.4736996,1.2632008-1.2632008,1.2632008h-4.5788994c-0.6316004,0-1.2631998-0.4736996-1.2631998-1.2632008v-0.7894993c0-3.4736996,2.6842003-4.8947001,4.7368002-6c1.7367992-0.9474001,2.8421001-1.5789003,2.8421001-2.8421001C19.3190002,8.1052999,17.1084995,7,15.3716002,7C13.0032005,7,12.0558004,8.1052999,10.6348,9.8421001C10.1611004,10.3157997,9.5295,10.4736996,9.0558004,10L6.5295,7.9474001c-0.4737-0.4737-0.6315999-1.1052999-0.3158002-1.579C8.5820999,2.8947001,11.5820999,1,16.1611004,1C20.8978996,1,25.9505997,4.7895002,25.9505997,9.6842003z" />
    </svg>
  )
}

export default function HelpView({ theme = 'dark' }) {
  const isLight = theme === 'light'
  const [openSections, setOpenSections] = useState(['summary', 'getting_started'])

  const panelClass = useMemo(
    () => (isLight ? 'bg-gray-50 border border-gray-200' : 'bg-gray-900/40 border border-gray-700'),
    [isLight]
  )

  return (
    <div className="h-full overflow-y-auto pr-1">
      <div className={`${panelClass} rounded-xl p-4 md:p-5 space-y-3`}>
        <SectionCard
          id="summary"
          title="Summary"
          icon={<HelpGlyph />}
          openSections={openSections}
          setOpenSections={setOpenSections}
          theme={theme}
        >
          <p>
            Ensembl Go is a desktop application for downloading Ensembl genomes and exploring annotation, homology, gene neighbourhoods,
            structural variation, and multiple sequence alignments on your own machine.
          </p>
          <p>
            The workflow is designed to be continuous: you select genomes once, keep them in the top genome list, and then move between
            views while keeping as much context as possible.
          </p>
          <p>
            In practice, this means you can identify a gene in the Genome Browser, follow it into alignment or neighbourhood analyses,
            and then move to homology queries without having to rebuild your setup each time.
          </p>
        </SectionCard>

        <SectionCard
          id="getting_started"
          title="Getting started"
          icon={<AppButtonIcon buttonId="home" isLight={isLight} compact />}
          openSections={openSections}
          setOpenSections={setOpenSections}
          theme={theme}
        >
          <ol className="space-y-4">
            <li className="flex gap-3">
              <span className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${isLight ? 'bg-blue-100 text-blue-700' : 'bg-blue-900/50 text-blue-200'}`}>1</span>
              <div className="space-y-2">
                <div><IconTile buttonId="configuration" label="Configuration" theme={theme} /></div>
                <p>
                  Open Configuration, expand <span className="font-semibold">Outputs</span>, and choose an
                  <span className="font-semibold"> Output Directory</span>. Downloaded data, generated indices, and caches are stored there.
                </p>
                <p>
                  If you already have an Ensembl Go data directory, select that directory instead.
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${isLight ? 'bg-blue-100 text-blue-700' : 'bg-blue-900/50 text-blue-200'}`}>2</span>
              <div className="space-y-2">
                <div><IconTile buttonId="download" label="Download" theme={theme} /></div>
                <p>
                  Open Download and choose one species and assembly. Keep <span className="font-semibold">Genome</span> and
                  <span className="font-semibold"> Genes</span> selected, then use the download button for that assembly.
                </p>
                <p>
                  Wait until both files are shown as downloaded. Homology data is optional and is not needed for this first browser view.
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${isLight ? 'bg-blue-100 text-blue-700' : 'bg-blue-900/50 text-blue-200'}`}>3</span>
              <div className="space-y-2">
                <div><IconTile buttonId="genome_selector" label="Genome Selector" theme={theme} /></div>
                <p>
                  Find the downloaded assembly in Genome Selector and tick its checkbox. The genome is added to the genome bar at the top
                  of the app and made active.
                </p>
                <p>
                  An index is required for browsing. If the <span className="font-semibold">Index</span> column shows that one is missing,
                  you can build it here or continue to Genome Browser, which starts the build when the genome is opened.
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${isLight ? 'bg-blue-100 text-blue-700' : 'bg-blue-900/50 text-blue-200'}`}>4</span>
              <div className="space-y-2">
                <div><IconTile buttonId="genome_browser" label="Genome Browser" theme={theme} /></div>
                <p>
                  Switch to Genome Browser. The active genome opens at its initial region; if indexing is still finishing, the browser shows
                  a preparation message and refreshes automatically when the data is ready.
                </p>
                <p>
                  Once the region ruler and gene annotations are visible, the initial setup is complete. Use the search box to open a gene,
                  stable ID, or genomic region when you are ready to explore further.
                </p>
              </div>
            </li>
          </ol>
        </SectionCard>

        <SectionCard id="home" title="Home view" icon={<AppButtonIcon buttonId="home" isLight={isLight} compact />} openSections={openSections} setOpenSections={setOpenSections} theme={theme}>
          <p>
            Home is the central launcher for the application. Each card opens one part of the workflow, so it is useful as a quick reset point
            when switching tasks.
          </p>
          <p>
            The card layout is especially handy when onboarding new users, as it provides a visual map of the app’s capabilities.
          </p>
        </SectionCard>

        <SectionCard id="configuration" title="Configuration view" icon={<AppButtonIcon buttonId="configuration" isLight={isLight} compact />} openSections={openSections} setOpenSections={setOpenSections} theme={theme}>
          <p>
            Configuration controls global setup: output directories, path management, and persistent app-level options.
            It is also where you can organise which app buttons appear in the top navigation bar.
          </p>
          <p>
            If you are moving between machines or sharing a standard setup within a team, this is also the best place to save
            and reload a consistent configuration.
          </p>
        </SectionCard>

        <SectionCard id="download" title="Download view" icon={<AppButtonIcon buttonId="download" isLight={isLight} compact />} openSections={openSections} setOpenSections={setOpenSections} theme={theme}>
          <p>
            Download lets you browse species groups, select assemblies, and queue required files for local work.
            Progress is tracked in-app, so you can continue using other views while downloads complete.
          </p>
          <p>
            Once finished, downloaded genomes appear in the local selection flow and can be activated from Genome Selector.
          </p>
        </SectionCard>

        <SectionCard id="genome_selector" title="Genome Selector view" icon={<AppButtonIcon buttonId="genome_selector" isLight={isLight} compact />} openSections={openSections} setOpenSections={setOpenSections} theme={theme}>
          <p>
            Genome Selector is where downloaded species become active for analysis. Ticking a species adds it to the top list shared by the app.
          </p>
          <p>
            The active pill state controls what downstream views load, and index generation is handled here when required.
          </p>
        </SectionCard>

        <SectionCard id="genome_browser" title="Genome Browser view" icon={<AppButtonIcon buttonId="genome_browser" isLight={isLight} compact />} openSections={openSections} setOpenSections={setOpenSections} theme={theme}>
          <p>
            Genome Browser is the main exploratory interface. You can search by symbol/ID/region, pan and zoom continuously,
            and inspect genes at both summary and transcript-detail levels.
          </p>
          <p>
            It also includes linked multi-genome controls, focus-gene tools, and custom track loading, making it the main entry point
            for most comparative workflows.
          </p>
        </SectionCard>

        <SectionCard id="track_manager" title="Track Manager view" icon={<AppButtonIcon buttonId="track_manager" isLight={isLight} compact />} openSections={openSections} setOpenSections={setOpenSections} theme={theme}>
          <p>
            Track Manager registers custom BigWig, BigBed, VCF, and splice-junction files for display in Genome Browser.
            Tracks can be assigned to a genome, searched, filtered, edited, and removed from the registry.
          </p>
          <p>
            Registered tracks become available from the matching genome panel in Genome Browser, where their visibility can be controlled
            alongside the built-in annotation tracks.
          </p>
        </SectionCard>

        <SectionCard id="feature_explorer" title="Feature Explorer view" icon={<AppButtonIcon buttonId="feature_explorer" isLight={isLight} compact />} openSections={openSections} setOpenSections={setOpenSections} theme={theme}>
          <p>
            Feature Explorer is a single-genome transcript inspection view centered on one gene at a time.
            It uses the primary genome context and supports symbol/ID search with automatic focus propagation from other views.
          </p>
          <p>
            A dual ruler shows genomic coordinates and transcript-offset positions, while the right-side transcript list lets you
            switch active/inactive transcript tracks for focused structure comparisons.
          </p>
          <p>
            The <span className="font-semibold">Structure</span> section shows a predicted three-dimensional model of the selected
            transcript's protein, coloured either by AlphaFold's per-residue confidence or by which coding exon contributes each
            part of the fold. Exons alternate between two colours; the list beside the viewer names them, hovering an entry
            highlights that exon in the model, and clicking one locks it. Several exons can be locked at once — the locked ones
            keep their full colour while the rest mute, so the emphasis is visible without hiding the rest of the fold.
          </p>
          <p>
            The transcript menu only offers transcripts that actually have a model. When there are too many coding transcripts to
            check, or the lookups cannot be reached, it falls back to the canonical transcript and says so rather than listing
            options that lead nowhere.
          </p>
          <p>
            If you have VCF files registered in the Track Manager against the assembly you are viewing, the
            <span className="font-semibold"> Variants</span> section projects any that fall in the transcript's coding exons onto
            the model, drawn over the exon colouring. Each variant's consequence is worked out from the codon itself rather than
            read from a CSQ or ANN field, so an unannotated VCF works just as well; variants are grouped as truncating, missense or
            synonymous, and clicking a class in the legend hides it, which is how you get from a dense population file down to the
            handful worth looking at. If a VCF's reference alleles disagree with the loaded genome, the panel says so — that
            usually means the file is on a different assembly.
          </p>
          <p>
            Models are found by matching the transcript's protein ID to a UniProt accession — from an imported mapping file first,
            then a cross-reference file shipped with the genome, then UniProt itself. You can also type an accession directly.
            AlphaFold models the canonical UniProt sequence, so when a transcript translates to something else the panel aligns the
            two and states the identity rather than colouring as though they matched. Structure predictions come from the
            <span className="font-semibold"> AlphaFold Protein Structure Database</span> (CC BY 4.0, EMBL-EBI and Google DeepMind)
            and are rendered with Mol* / PDBe Mol*.
          </p>
        </SectionCard>

        <SectionCard id="alignment" title="Alignment view" icon={<AppButtonIcon buttonId="alignment" isLight={isLight} compact />} openSections={openSections} setOpenSections={setOpenSections} theme={theme}>
          <p>
            Alignment runs a multiple sequence alignment of genic regions from two or more active genomes. Genes selected in Genome Browser
            are carried into the alignment inputs, and each genome can also be searched independently in the controls.
          </p>
          <p>
            Adjust flanking sequence and alignment settings, collapse introns for a clearer structural comparison, or save and reload an
            alignment. The viewer supports zooming, panning, overview navigation, and annotation-aware feature colouring.
          </p>
        </SectionCard>

        <SectionCard id="neighbourhood" title="Neighbourhood view" icon={<AppButtonIcon buttonId="neighbourhood" isLight={isLight} compact />} openSections={openSections} setOpenSections={setOpenSections} theme={theme}>
          <p>
            Neighbourhood compares local gene order and orientation around selected genes. It helps answer whether surrounding context
            is conserved or rearranged.
          </p>
          <p>
            Interactive panning, independent dragging, and orientation flipping make it easier to inspect inversions and local structure.
          </p>
        </SectionCard>

        <SectionCard id="structural_variation" title="Structural Variation view" icon={<AppButtonIcon buttonId="structural_variation" isLight={isLight} compact />} openSections={openSections} setOpenSections={setOpenSections} theme={theme}>
          <p>
            Structural Variation displays local variation records and chain-based syntenic mappings from an anchor genome to as many as
            two other active genomes. Select an anchor region to inspect overlapping events and mapped blocks.
          </p>
          <p>
            The view uses available structural-variation datasets and registered BigChain alignments. Compatible BigWig and BigBed tracks
            from Track Manager can be overlaid while you move between mapped regions.
          </p>
        </SectionCard>

        <SectionCard id="homology" title="Homology view" icon={<AppButtonIcon buttonId="homology" isLight={isLight} compact />} openSections={openSections} setOpenSections={setOpenSections} theme={theme}>
          <p>
            Homology can query local TSV homology data for one or two active genomes, aligned with the same primary/secondary model
            used in Genome Browser and other comparative views.
          </p>
          <p>
            Each loaded table includes score-based sorting, filter controls, and visual identity/coverage summaries, and a comparison
            section reports shared hits plus entries unique to either primary or secondary.
          </p>
        </SectionCard>

        <SectionCard id="stats" title="Statistics view" icon={<AppButtonIcon buttonId="stats" isLight={isLight} compact />} openSections={openSections} setOpenSections={setOpenSections} theme={theme}>
          <p>
            Statistics provides cross-genome summaries in three switchable modes: annotation composition, structural feature metrics,
            and homology quality summaries.
          </p>
          <p>
            Structural metrics are generated on demand and cached with each genome so repeated sessions load quickly.
            Assembly cards combine local FASTA-derived values with ENA metadata when an assembly accession is available.
          </p>
        </SectionCard>

        <SectionCard id="notes" title="Notes view" icon={<AppButtonIcon buttonId="notes" isLight={isLight} compact />} openSections={openSections} setOpenSections={setOpenSections} theme={theme}>
          <p>
            Notes are free text you attach to a gene. Write them in the Genome Browser — the focus drawer has a Notes section
            under its transcript list — and read them all back here, grouped by genome and by the gene they belong to.
          </p>
          <p>
            A region can carry notes too. Search a coordinate range or drag a selection zoom in the browser to make it the
            location of focus, and its drawer has the same Notes section under the sequence and the genes it contains. Location
            notes are listed here beside the gene notes for that genome, headed by the region they are about, and the browser
            button on the row takes you straight back to it.
          </p>
          <p>
            A gene that carries notes is marked in the browser with a speech bubble at its left edge, once you are zoomed in far
            enough to see transcripts. Clicking that bubble focuses the gene and opens its notes.
          </p>
          <p>
            Notes are filed per assembly rather than per download, so updating a genome to a newer annotation release keeps them.
            The same gene in a different genome has its own notes. Everything is saved as you type, into a
            <span className="font-mono"> user_notes.json </span> file beside your other local data.
          </p>
          <p>
            Notes and Todo tasks can carry reusable tags. The tag editor suggests popular, recently used, and alphabetical choices;
            choose <span className="font-semibold">Tags</span> from the right-panel title to see active and archived usage by genome
            or Todo list. That same title switches between Recent activity, Last viewed, Last edited, and Tags. Select one or more
            tags to filter both notes and tasks, choosing whether results must match all selected tags or any of them.
          </p>
        </SectionCard>

        <SectionCard id="tips" title="Tips and notes" icon={<HelpGlyph />} openSections={openSections} setOpenSections={setOpenSections} theme={theme}>
          <ul className="list-disc pl-5 space-y-1.5">
            <li>Index building can take time for large annotations; browser panels will refresh automatically once indices are ready.</li>
            <li>A filled blue pill indicates an active genome for the current view; outlined pills remain selected and available to activate.</li>
            <li>For homology matching, assembly names are used, including automatic alias handling for GRCh38 and GRCh38.p14.</li>
            <li>If a view appears empty after changing active genomes, check how many active genomes and which local data files that view requires.</li>
            <li>Use configuration save/load controls to keep reproducible project setups across machines or collaborators.</li>
          </ul>
        </SectionCard>
      </div>
    </div>
  )
}
