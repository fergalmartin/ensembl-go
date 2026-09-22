import { useState } from 'react'
import AppButtonIcon from './AppButtonIcon'

function ActionButtonRow({ buttonId, label, theme, children }) {
  const isLight = theme === 'light'
  return (
    <li className="grid grid-cols-[2rem_minmax(0,1fr)] items-start gap-3">
      <span className={`inline-flex h-8 w-8 items-center justify-center rounded-md ${isLight ? 'bg-[#0099ff] text-white' : 'bg-blue-600 text-white'}`} aria-hidden="true">
        <AppButtonIcon buttonId={buttonId} isLight={isLight} compact />
      </span>
      <div className="min-w-0 pt-1">
        <strong>{label}:</strong> {children}
      </div>
    </li>
  )
}

function GettingStartedStep({ number, buttonId, label, theme, children }) {
  const isLight = theme === 'light'
  return (
    <li className="grid grid-cols-[1.5rem_2rem_minmax(0,1fr)] items-start gap-3">
      <span className="pt-1 text-right tabular-nums" aria-hidden="true">{number}.</span>
      <span className={`inline-flex h-8 w-8 items-center justify-center rounded-md ${isLight ? 'bg-[#0099ff] text-white' : 'bg-blue-600 text-white'}`} aria-hidden="true">
        <AppButtonIcon buttonId={buttonId} isLight={isLight} compact />
      </span>
      <div className="min-w-0 pt-1">
        <strong>{label}:</strong> {children}
      </div>
    </li>
  )
}

function SectionCard({ id, title, icon, openSections, setOpenSections, theme, children }) {
  const isLight = theme === 'light'
  const open = openSections.includes(id)
  return (
    <section className={`rounded-xl border overflow-hidden ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800 border-gray-700'}`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpenSections((prev) => (
          prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
        ))}
        className={`w-full flex items-center justify-between px-5 py-4 text-left ${isLight ? 'hover:bg-gray-50' : 'hover:bg-gray-750'}`}
      >
        <div className="flex items-center gap-3">
          <span className={`inline-flex h-8 w-8 items-center justify-center rounded-md ${isLight ? 'bg-[#0099ff] text-white' : 'bg-blue-600 text-white'}`}>
            {icon}
          </span>
          <span className={`text-sm font-semibold ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>{title}</span>
        </div>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${open ? 'rotate-180' : ''} ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
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
  const cardProps = { openSections, setOpenSections, theme }

  return (
    <div className="h-full overflow-y-auto pr-1">
      <div className={`${isLight ? 'bg-gray-50 border border-gray-200' : 'bg-gray-900/40 border border-gray-700'} rounded-xl p-4 md:p-5 space-y-3`}>
        <SectionCard id="summary" title="What you can do in Ensembl Go" icon={<HelpGlyph />} {...cardProps}>
          <p>
            Ensembl Go lets you download genomes and annotations and work with them on your own computer. You can browse a region, read its sequence, inspect transcripts, compare genes across genomes and add your own data tracks.
          </p>
          <p>
            Genomes selected in Genome Selector appear as buttons at the top of every view. Click a genome button to activate or deactivate it, or use its cross to remove it from the list. Several views can show more than one active genome at once.
          </p>
          <p>
            Most app buttons open a view. Genome Playlist, Theme Toggle and Screenshot act on the current session. You can change which buttons appear, and their order, under <strong>Organise Apps</strong> in Configuration. Structural Variation and Homology are available there and are not on the default button bar.
          </p>
        </SectionCard>

        <SectionCard id="getting_started" title="Getting started" icon={<AppButtonIcon buttonId="home" isLight={isLight} compact />} {...cardProps}>
          <p>If you are new to Ensembl Go, this is a good place to start:</p>
          <ol className="space-y-3">
            <GettingStartedStep number={1} buttonId="configuration" label="Configuration" theme={theme}>
              Set an <strong>Output Directory</strong> under <strong>Outputs</strong>. This is where downloads, indices and other local files are written.
            </GettingStartedStep>
            <GettingStartedStep number={2} buttonId="download" label="Download" theme={theme}>
              Find a species and assembly, leave <strong>Genome</strong> and <strong>Genes</strong> selected, and download them. You can search by species, assembly or accession.
            </GettingStartedStep>
            <GettingStartedStep number={3} buttonId="genome_selector" label="Genome Selector" theme={theme}>
              Tick the downloaded genome to add it to the buttons at the top of the app.
            </GettingStartedStep>
            <GettingStartedStep number={4} buttonId="genome_browser" label="Genome Browser" theme={theme}>
              Open the genome. Its annotation is indexed the first time you use it, so a large genome may take a little while to appear. Search for a gene or region once the browser is ready.
            </GettingStartedStep>
            <GettingStartedStep number={5} buttonId="tutorials" label="Tutorials" theme={theme}>
              The Tutorials view has a growing collection of interactive tutorials covering different parts of Ensembl Go. Start with <strong>Getting Started</strong> for this workflow, then try the more detailed tutorials as you explore other views.
            </GettingStartedStep>
          </ol>
        </SectionCard>

        <SectionCard id="home" title="Home" icon={<AppButtonIcon buttonId="home" isLight={isLight} compact />} {...cardProps}>
          <p>Home shows the views as cards. Click one to open it. It is also a useful place to see what is available if you have removed a view from the button bar.</p>
        </SectionCard>

        <SectionCard id="genome_selector" title="Genome Selector" icon={<AppButtonIcon buttonId="genome_selector" isLight={isLight} compact />} {...cardProps}>
          <p>This is where you manage locally available genomes. Tick a genome to add it to the current session, inspect its files and index status, or add your own genome and annotation. Removing a genome from the top bar deselects it here too.</p>
          <p>You can also make <strong>Genome Playlists</strong>, which are saved sets of genomes. Add genomes individually from their rows or add several selected genomes at once. Choosing a playlist replaces the selected genomes in the top bar with that set and filters the list in Genome Selector. The first available genome is activated.</p>
        </SectionCard>

        <SectionCard id="genome_browser" title="Genome Browser" icon={<AppButtonIcon buttonId="genome_browser" isLight={isLight} compact />} {...cardProps}>
          <p>The Genome Browser is the main view for moving around a genome and its annotation. Search for a gene symbol, stable ID or region, then pan and zoom to look at the surrounding sequence and genes. Each active genome has its own panel and search controls; the general controls above the panels apply to all of them.</p>
          <p>Use the track controls to show or hide genes on either strand, sequence and any custom tracks you have added. You can change how transcripts are laid out, flip the display and drag a selection to zoom in. Click a gene or select a region to open a drawer with more detail, sequence and a place to write notes.</p>
          <p>The <strong>Genome Browser</strong> tutorial goes through these controls step by step. <strong>Multi-genome browsing</strong> covers the controls that become useful when several genomes are active.</p>
        </SectionCard>

        <SectionCard id="download" title="Download" icon={<AppButtonIcon buttonId="download" isLight={isLight} compact />} {...cardProps}>
          <p>Search the Ensembl and RefSeq catalogues for a species or assembly and choose which files to fetch. Genome sequence and gene annotation are the usual starting point. Homology files are only needed if you want to use the Homology view or homology statistics.</p>
          <p>The download icon on each assembly shows its progress and becomes a tick when the selected files are available locally. Downloads continue while you use other views. Once they finish, the genome appears in Genome Selector.</p>
        </SectionCard>

        <SectionCard id="sequence" title="Sequence" icon={<AppButtonIcon buttonId="sequence" isLight={isLight} compact />} {...cardProps}>
          <p>Sequence displays sixty bases per row, with coordinates at both ends. Hover over a base to see its position and annotation. The panel on the right lets you move from a location to a gene, then a transcript, then an exon or intron. Moving back up keeps your choices, so you can return to the same feature.</p>
          <p>The colours change with the level you are reading. At gene level they show where transcripts agree or differ; at transcript level they show UTRs, coding sequence, codons and splice sites. Use the cog to choose highlights and flanking sequence, copy the current sequence as FASTA, or open the region in Genome Browser. You can also drag across the bases to select a shorter stretch.</p>
        </SectionCard>

        <SectionCard id="feature_explorer" title="Feature Explorer" icon={<AppButtonIcon buttonId="feature_explorer" isLight={isLight} compact />} {...cardProps}>
          <p>Feature Explorer takes a closer look at one gene in an active genome. Search for a symbol or stable ID, or arrive from another view with a gene already selected. The transcript display and its two rulers let you compare genomic coordinates with positions along a transcript. Use the transcript list to choose which isoforms to show.</p>
          <p>The sequence and protein panels provide more detail for the selected transcript. Where a matching AlphaFold model is available, <strong>Structure</strong> shows the predicted protein fold. You can colour it by confidence or coding exon, and highlight exons in the model. Registered VCF variants that fall in coding exons can also be projected onto the structure. The panel reports when the protein sequence or VCF reference does not match the genome being viewed.</p>
        </SectionCard>

        <SectionCard id="track_manager" title="Track Manager" icon={<AppButtonIcon buttonId="track_manager" isLight={isLight} compact />} {...cardProps}>
          <p>Track Manager registers your own files against a genome so they can be shown in Genome Browser. Supported types include BigWig signal, BED and BigBed intervals, indexed VCF variants, STAR splice junctions, short-read BAM and long-read BAM. The registration form asks for the file, genome, track type and display settings.</p>
          <p>You can search, edit and remove registrations here. The <strong>Track Hub Registry</strong> lets you add and browse track hubs. In Genome Browser, use <strong>Add Custom Track</strong> on the matching genome panel to add registered tracks, then switch individual tracks on or off.</p>
        </SectionCard>

        <SectionCard id="alignment" title="Feature Alignment" icon={<AppButtonIcon buttonId="alignment" isLight={isLight} compact />} {...cardProps}>
          <p>Feature Alignment compares genic sequence from two or more active genomes. Genes selected in Genome Browser can be used as inputs, and you can search for a different gene in each genome. Choose how much flanking sequence to include, run the alignment and inspect it alongside the annotation.</p>
          <p>Zoom and pan through the result, or collapse introns to make exon structure easier to compare. Alignments can be saved and loaded again later. Use <strong>Open in Alignment Explorer</strong> if you want to work with the aligned sequences in layers.</p>
        </SectionCard>

        <SectionCard id="alignment_explorer" title="Alignment Explorer" icon={<AppButtonIcon buttonId="alignment_explorer" isLight={isLight} compact />} {...cardProps}>
          <p>Alignment Explorer starts from an existing alignment file. Open a MAF, aligned FASTA, XMFA, Stockholm, Clustal or PHYLIP file, or try the example. The original alignment remains available while you select regions and move them into named layers to follow connections between sequences and blocks.</p>
          <p>Use the sidebar to filter sequences and blocks, link sequence rows to local genomes, and save or load a workspace. You can export the selected region or the current layer as sequence data.</p>
        </SectionCard>

        <SectionCard id="neighbourhood" title="Neighbourhood" icon={<AppButtonIcon buttonId="neighbourhood" isLight={isLight} compact />} {...cardProps}>
          <p>Neighbourhood shows the genes around a chosen gene in each active genome. Search for a gene in each row, then compare the order and direction of its neighbours. You can move rows independently, flip their orientation, swap adjacent genomes and bring the chosen genes back to the centre.</p>
          <p>Homology links and filters help you follow related genes between rows. The selection control can dim genes outside a region you want to concentrate on.</p>
        </SectionCard>

        <SectionCard id="stats" title="Statistics" icon={<AppButtonIcon buttonId="stats" isLight={isLight} compact />} {...cardProps}>
          <p>Statistics compares the active genomes in three modes: <strong>Annotation</strong>, <strong>Structural</strong> and <strong>Homology</strong>. Use them to look at gene and transcript composition, structural measurements, or the quality of available homology data. The assembly cards also show local sequence statistics and any available assembly metadata.</p>
          <p>Some structural values are calculated the first time they are requested and then cached, so the first visit can take longer than later ones.</p>
        </SectionCard>

        <SectionCard id="notes" title="Notes" icon={<AppButtonIcon buttonId="notes" isLight={isLight} compact />} {...cardProps}>
          <p>Write notes on a gene or focused region in the Genome Browser drawer. Notes brings them together across genomes, with search, tags and a button to return to the place you wrote about. Genes with notes have a speech bubble in the browser when you are close enough to see their transcripts.</p>
          <p>Notes are saved as you type and belong to the assembly, so updating its annotation does not discard them. You can also use tags on notes and Todo tasks, then filter by one or more tags.</p>
        </SectionCard>

        <SectionCard id="tutorials" title="Tutorials" icon={<AppButtonIcon buttonId="tutorials" isLight={isLight} compact />} {...cardProps}>
          <p>Tutorials take you through a view or task one step at a time. Start with <strong>Getting Started</strong> if you have not downloaded a genome before. You can perform the highlighted actions yourself or turn on Autoplay and watch the tutorial complete them.</p>
          <p>Tutorials use their own temporary session, often with demo data. Finishing or exiting returns you to your previous session and configuration. The Tutorials view also lets you create or import tutorials and keep drafts in your output directory.</p>
        </SectionCard>

        <SectionCard id="help" title="Help" icon={<AppButtonIcon buttonId="help" isLight={isLight} compact />} {...cardProps}>
          <p>Help describes each view and the buttons at the top of the app. Open a section for a short explanation of its controls. For a guided example, go to Tutorials.</p>
        </SectionCard>

        <SectionCard id="configuration" title="Configuration" icon={<AppButtonIcon buttonId="configuration" isLight={isLight} compact />} {...cardProps}>
          <p>Use <strong>Outputs</strong> to set the directory for downloads, generated indices and exports. Under <strong>Configuration</strong>, you can save your settings to a file, load them again or reset them to their defaults.</p>
          <p><strong>Organise Apps</strong> controls which view and action buttons appear at the top and lets you change their order. The other sections contain colour schemes and general browsing settings.</p>
        </SectionCard>

        <SectionCard id="structural_variation" title="Structural Variation" icon={<AppButtonIcon buttonId="structural_variation" isLight={isLight} compact />} {...cardProps}>
          <p>Structural Variation shows variation records around a region in an anchor genome. Where a compatible chain alignment is available, it also maps that region to one or two other genomes so you can inspect corresponding blocks and features side by side.</p>
          <p>Choose the anchor, region and target genomes in the controls. The view can also show registered BigWig and BigBed tracks. Chain alignments and local data must be available for the corresponding comparison panels to appear.</p>
        </SectionCard>

        <SectionCard id="homology" title="Homology" icon={<AppButtonIcon buttonId="homology" isLight={isLight} compact />} {...cardProps}>
          <p>Homology searches downloaded homology tables for a gene symbol or stable ID. Choose one or two active genomes to see their matches, with identity, coverage and scores in sortable, filterable tables.</p>
          <p>With two genomes, the comparison table shows matches shared between them and matches found in only one. This view needs local homology files for the genomes you want to query.</p>
        </SectionCard>

        <SectionCard id="actions" title="Action buttons" icon={<HelpGlyph />} {...cardProps}>
          <ul className="space-y-3">
            <ActionButtonRow buttonId="genome_playlist" label="Genome Playlist" theme={theme}>
              Opens your saved playlists from anywhere in the app. Choose one to load its genomes into the top bar. Create and edit playlists in Genome Selector. <strong>Previous session</strong> is available when there is a previous selection to restore.
            </ActionButtonRow>
            <ActionButtonRow buttonId="theme_toggle" label="Theme Toggle" theme={theme}>
              Switches between light and dark themes.
            </ActionButtonRow>
            <ActionButtonRow buttonId="screenshot_toggle" label="Screenshot" theme={theme}>
              Starts capture mode in views with an exportable panel. Choose the part of the view to export, then set the file name, format and directory. Set an Output Directory in Configuration before exporting.
            </ActionButtonRow>
          </ul>
        </SectionCard>
      </div>
    </div>
  )
}
