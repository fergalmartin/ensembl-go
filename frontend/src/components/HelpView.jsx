import { useMemo, useState } from 'react'
import AppButtonIcon from './AppButtonIcon'

const SECTION_ORDER = [
  'summary',
  'getting_started',
  'home',
  'configuration',
  'download',
  'species_selector',
  'genome_browser',
  'feature_explorer',
  'alignment',
  'neighbourhood',
  'homology',
  'stats',
  'tips',
]

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
            and pairwise alignments entirely on your own machine.
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
                  Open Configuration and set an output directory where genomes, annotations, caches, and indices can be written.
                  If you already have a prepared data directory, point the app there instead.
                </p>
                <p>
                  This is the foundation for the rest of the workflow, so it is worth confirming the path first before downloading anything.
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${isLight ? 'bg-blue-100 text-blue-700' : 'bg-blue-900/50 text-blue-200'}`}>2</span>
              <div className="space-y-2">
                <div><IconTile buttonId="download" label="Download" theme={theme} /></div>
                <p>
                  Move to Download and choose species plus file types. For most analysis workflows you will want genome FASTA, GFF3 annotation,
                  and homology tables.
                </p>
                <p>
                  To get started quickly, download Human and Mouse with all three file types. That gives you everything needed for browsing,
                  neighbourhood comparisons, pairwise alignment, and homology lookups.
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${isLight ? 'bg-blue-100 text-blue-700' : 'bg-blue-900/50 text-blue-200'}`}>3</span>
              <div className="space-y-2">
                <div><IconTile buttonId="species_selector" label="Genome Selector" theme={theme} /></div>
                <p>
                  In Genome Selector, tick Human and Mouse. If indices are missing, the app will start building them automatically.
                  Once selected, genomes are added to the top list so they are available across views.
                </p>
                <p>
                  The first selected genome becomes the active primary genome (blue pill). Some views support a secondary active genome,
                  while others (such as Homology) use a single active source at a time.
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${isLight ? 'bg-blue-100 text-blue-700' : 'bg-blue-900/50 text-blue-200'}`}>4</span>
              <div className="space-y-2">
                <div><IconTile buttonId="genome_browser" label="Genome Browser" theme={theme} /></div>
                <p>
                  Switch to Genome Browser. You will normally begin on Human chromosome 1. Try the core controls first: region search,
                  panning, zooming, transcript expansion, focus-gene selection, and recentering on the gene of interest.
                </p>
                <p>
                  Next, activate Mouse from the top list and observe the blue active pill. Deactivate and reactivate it once so the
                  primary/secondary behaviour is clear.
                </p>
                <p>
                  When you set a focus gene (for example HSD3B1), gene-link controls become available. Links are created by symbol automatically
                  where possible, and you can manually choose genes in either genome when needed.
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${isLight ? 'bg-blue-100 text-blue-700' : 'bg-blue-900/50 text-blue-200'}`}>5</span>
              <div className="space-y-2">
                <div><IconTile buttonId="alignment" label="Pairwise Alignment" theme={theme} /></div>
                <p>
                  Move to Pairwise Alignment. Genes selected in Genome Browser are propagated so you can run or load an alignment immediately.
                </p>
                <p>
                  Explore alignment controls such as zoom, pan, minimap navigation, feature colouring (CDS/UTR and related states),
                  and intron collapse/expansion options for clearer structural comparison.
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${isLight ? 'bg-blue-100 text-blue-700' : 'bg-blue-900/50 text-blue-200'}`}>6</span>
              <div className="space-y-2">
                <div><IconTile buttonId="neighbourhood" label="Neighbourhood" theme={theme} /></div>
                <p>
                  Then open Neighbourhood. Selected genes propagate here as well, allowing you to compare local gene context around each locus.
                </p>
                <p>
                  Pan both neighbourhoods together, drag one independently, flip orientation, and use region focus tools to dim unrelated genes
                  while you inspect a local block in detail.
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${isLight ? 'bg-blue-100 text-blue-700' : 'bg-blue-900/50 text-blue-200'}`}>7</span>
              <div className="space-y-2">
                <div><IconTile buttonId="homology" label="Homology" theme={theme} /></div>
                <p>
                  Finally, open Homology. This view works with one active source genome at a time. Enter a gene symbol or stable ID to query
                  the local TSV homology table.
                </p>
                <p>
                  Use filters and sort controls to rank likely matches, and use the identity/coverage visual cues to scan quickly.
                  Rows corresponding to assemblies in your top list are highlighted for easy prioritisation.
                </p>
                <p>
                  Click a different genome in the top list to swap the active source, then rerun the query for that genome.
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

        <SectionCard id="species_selector" title="Genome Selector view" icon={<AppButtonIcon buttonId="species_selector" isLight={isLight} compact />} openSections={openSections} setOpenSections={setOpenSections} theme={theme}>
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

        <SectionCard id="feature_explorer" title="Feature Explorer view" icon={<AppButtonIcon buttonId="feature_explorer" isLight={isLight} compact />} openSections={openSections} setOpenSections={setOpenSections} theme={theme}>
          <p>
            Feature Explorer is a single-genome transcript inspection view centered on one gene at a time.
            It uses the primary genome context and supports symbol/ID search with automatic focus propagation from other views.
          </p>
          <p>
            A dual ruler shows genomic coordinates and transcript-offset positions, while the right-side transcript list lets you
            switch active/inactive transcript tracks for focused structure comparisons.
          </p>
        </SectionCard>

        <SectionCard id="alignment" title="Pairwise Alignment view" icon={<AppButtonIcon buttonId="alignment" isLight={isLight} compact />} openSections={openSections} setOpenSections={setOpenSections} theme={theme}>
          <p>
            Pairwise Alignment provides transcript-to-transcript sequence comparison between selected genomes.
            It is designed for quickly checking conservation, gaps, and feature-level differences.
          </p>
          <p>
            You can move between this view and Genome Browser context, so alignment findings can be interpreted alongside surrounding
            genomic annotation.
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

        <SectionCard id="homology" title="Homology view" icon={<AppButtonIcon buttonId="homology" isLight={isLight} compact />} openSections={openSections} setOpenSections={setOpenSections} theme={theme}>
          <p>
            Homology can query local TSV homology data for one or two active genomes, aligned with the same primary/secondary model
            used in Genome Browser and Pairwise views.
          </p>
          <p>
            Each loaded table includes score-based sorting, filter controls, and visual identity/coverage summaries, and a comparison
            section reports shared hits plus entries unique to either primary or secondary.
          </p>
        </SectionCard>

        <SectionCard id="stats" title="Stats view" icon={<AppButtonIcon buttonId="stats" isLight={isLight} compact />} openSections={openSections} setOpenSections={setOpenSections} theme={theme}>
          <p>
            Stats provides cross-genome summaries in three switchable modes: annotation composition, structural feature metrics,
            and homology quality summaries.
          </p>
          <p>
            Structural metrics are generated on demand and cached with each genome so repeated sessions load quickly.
            Assembly cards combine local FASTA-derived values with ENA metadata when an assembly accession is available.
          </p>
        </SectionCard>

        <SectionCard id="tips" title="Tips and notes" icon={<HelpGlyph />} openSections={openSections} setOpenSections={setOpenSections} theme={theme}>
          <ul className="list-disc pl-5 space-y-1.5">
            <li>Index building can take time for large annotations; browser panels will refresh automatically once indices are ready.</li>
            <li>A blue pill indicates the active genome for the current view context; inactive genomes remain available in the top list.</li>
            <li>For homology matching, assembly names are used, including automatic alias handling for GRCh38 and GRCh38.p14.</li>
            <li>If a view appears empty after changing active genomes, check whether that view expects one or two active genomes.</li>
            <li>Use configuration save/load controls to keep reproducible project setups across machines or collaborators.</li>
          </ul>
        </SectionCard>
      </div>
    </div>
  )
}
