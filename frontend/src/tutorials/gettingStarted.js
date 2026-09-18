import { DEMO_SCIENTIFIC_NAME, DEMO_SPECIES_KEY } from './demoGenome.js'

// The first tutorial: the four apps a new user needs, in the order they need them.
//
// It runs in a sandbox — a scratch directory inside the user's output directory, and its
// own set of active genomes — so nothing here touches what they already have. The genome
// is Ensemblus welcomus, twenty-two kilobases whose genes are called Welcome, To, Ensembl
// and Go, bundled rather than downloaded so the tutorial needs no network.
//
// Steps that only point something out set `interactive: false`, so a stray click cannot
// derail the run. Steps that depend on earlier ones declare it with `ensure`, so skipping
// ahead still works. See docs/TUTORIALS.md.

const SECTION = Object.freeze({
  setup: 'Intro',
  download: 'Download a genome',
  activate: 'Activate a genome',
  browser: 'The Genome Browser',
  gene: 'Find and inspect a gene',
})

export default {
  id: 'getting-started',
  title: 'Getting Started',
  blurb: 'This teaches you the basics of downloading and activating genomes, including '
    + 'how to view them in the genome browser. This is the best place to start in terms of '
    + 'learning to use Ensembl Go, the other tutorials then give more detailed insights '
    + 'into particular views or features.',
  estimatedMinutes: 5,
  usesDemoGenome: true,
  completionBody: 'You have seen the whole loop: configure, download, activate, browse. '
    + 'Real genomes work exactly the same way; they just take longer to arrive. Your own '
    + 'settings and genomes were never changed, and the tutorial’s temporary data has been '
    + 'cleared away.',

  steps: [
    {
      id: 'welcome',
      section: SECTION.setup,
      placement: 'center',
      title: 'Welcome to Ensembl Go',
      body: 'This tutorial covers downloading a genome, selecting it and viewing in the '
        + 'browser. By the end of this tutorial you\'ll understand the basics of fetching and '
        + 'viewing genomes and annotation data in Ensembl Go.  The Next button will advance to '
        + 'the next step if you are doing the tutorial interactively. Enable Autoplay to run a '
        + 'non-interactive version of the tutorial. You can switch Autoplay on/off at any '
        + 'point.',
    },

    // ── Configuration ──────────────────────────────────────────────────────
    {
      id: 'open-config',
      section: SECTION.setup,
      view: 'configuration',
      anchor: 'app-button-configuration',
      placement: 'bottom',
      title: 'Open Configuration',
      body: 'Before we download some example data, let\'s look at the Configuration view. '
        + 'Click on the highlighted Configuration button above to open the view.',
      advanceOn: { type: 'view', view: 'configuration' },
    },
    {
      id: 'output-dir',
      section: SECTION.setup,
      view: 'configuration',
      anchor: 'config-output-dir',
      openSection: 'config-section-outputs',
      placement: 'bottom',
      interactive: false,
      title: 'Where your data lives',
      body: 'Genomes you download, the indexes built from them, and anything you export all go '
        + 'under this directory. As the output directory is a requirement for the tutorial, '
        + 'you\'ve already set it. For the tutorial itself, we\'re doing to use a temporary '
        + 'directory above. It will revert back to your output dir once you complete or exit '
        + 'the tutorial.',
    },
    // ── Download ───────────────────────────────────────────────────────────
    {
      id: 'open-download',
      section: SECTION.download,
      view: 'download',
      anchor: 'app-button-download',
      placement: 'bottom',
      title: 'Open the Download view',
      body: 'Ensembl Go can automatically fetch genomes and annotations from Ensembl and '
        + 'RefSeq. Click the Download button to move to the Download view.',
      advanceOn: { type: 'view', view: 'download' },
    },
    {
      id: 'download-file-types',
      section: SECTION.download,
      view: 'download',
      anchor: 'download-file-types',
      placement: 'bottom',
      interactive: false,
      title: 'Choose what to fetch',
      body: 'For fetching data from Ensembl there are several types of file that can be '
        + 'downloaded for each genome.  By default the Genome (FASTA) and Genes (GFF3) files '
        + 'are selected (and coloured blue as a result). In this example we\'re doing to '
        + 'download a tiny demo genome from Ensembl.',
    },
    {
      id: 'download-search',
      section: SECTION.download,
      view: 'download',
      anchor: 'download-search',
      // Above the box, so the list underneath — which is the thing being filtered — is
      // not sitting behind the card while it happens.
      placement: 'top',
      title: 'The search bar',
      // Kept short on purpose: the card has to fit between the top of the window and the
      // search box to sit above it, and there is not much room up there.
      body: 'Search by species, assembly or accession. For this demo type ‘Ensemblus welcomus’ '
        + 'and watch the list below narrow to our demo genome.',
      prefill: { anchor: 'download-search', value: DEMO_SCIENTIFIC_NAME },
      // Undimmed as soon as there is anything in the box, so the filtering is visible
      // rather than something you are told about.
      reveal: { anchor: 'download-species-list', whenTyped: 'download-search' },
      // Typing the name is the whole task, so finishing it finishes the step — waiting
      // for a click afterwards would leave the user wondering what else was wanted.
      advanceOn: { type: 'input', anchor: 'download-search', value: DEMO_SCIENTIFIC_NAME },
    },
    {
      id: 'download-demo',
      section: SECTION.download,
      view: 'download',
      anchor: `download-species-${DEMO_SPECIES_KEY}`,
      placement: 'bottom',
      interactive: false,
      title: 'The demo genome',
      body: 'You should now see the demo genome as the only result in the list. As you\'re '
        + 'likely aware from the name, this is not a real genome, just an artificially '
        + 'constructed one for the tutorial.',
    },
    {
      id: 'download-start',
      section: SECTION.download,
      view: 'download',
      anchor: `download-start-${DEMO_SPECIES_KEY}`,
      placement: 'left',
      title: 'Download the data locally',
      body: 'This is the download button. Click it and watch the icon: it fills as the files '
        + 'arrive, exactly as a real genome does. As this is a demo genome and annotation, it '
        + 'is very small, large genomes and annotations will take a little while to download.',
      // A signal-advanced step infers nothing, so the click is spelled out: without it
      // Next moves on without ever pressing the button the step is about.
      action: { type: 'click', anchor: `download-start-${DEMO_SPECIES_KEY}` },
      advanceOn: { type: 'signal', name: 'demoGenome.installed' },
      // Long enough for the paced download to finish before autoplay would move on, and
      // for Next to wait it out rather than skipping ahead of it.
      autoplayMs: 9000,
      settleMs: 8000,
    },
    {
      id: 'download-complete',
      section: SECTION.download,
      view: 'download',
      anchor: `download-start-${DEMO_SPECIES_KEY}`,
      placement: 'left',
      interactive: false,
      title: 'Download complete',
      body: 'The icon has turned into a green tick, which is how a row tells you its files are '
        + 'available locally. This also means the genome will appear in the Genome Selector '
        + 'view, which is the view for managing all the locally downloaded genomes. It is also '
        + 'where you can add your own custom genomes and annotations.',
      ensure: ['demo-genome-installed'],
    },

    // ── Genome Selector ────────────────────────────────────────────────────
    {
      id: 'open-selector',
      section: SECTION.activate,
      view: 'genome_selector',
      anchor: 'app-button-genome_selector',
      placement: 'bottom',
      title: 'Open Genome Selector',
      body: 'Downloading a genome gets the data into your output director. The Genome Selector '
        + 'view is where you go to add/remove from your current session and provides a lot of '
        + 'options for managing the local genome data. Click on the Genome Selector button to '
        + 'go there.',
      ensure: ['demo-genome-installed'],
      advanceOn: { type: 'view', view: 'genome_selector' },
    },
    {
      id: 'activate-demo',
      section: SECTION.activate,
      view: 'genome_selector',
      anchor: `selector-genome-${DEMO_SPECIES_KEY}`,
      placement: 'bottom',
      title: 'Select the demo genome',
      body: 'Tick the box to activate the demo genome.  Once active it becomes available in '
        + 'many other views, including the Genome Browser. We won\'t cover the Genome Selector '
        + 'view in detail, this is a separate tutorial, but it allows you to view/delete all '
        + 'the files, set all the genomes you want in a session, add custom genomes and '
        + 'annotations and even create genome playlists, which allow you to save a set of '
        + 'genomes and easily flick between sets.',
      ensure: ['demo-genome-installed'],
      // The checkbox rather than the row: the row works too, but the box is the control
      // the step is describing, and watching a click land on it is the point.
      action: { type: 'click', anchor: `selector-checkbox-${DEMO_SPECIES_KEY}` },
      // And the reader has to be able to press it themselves. The spotlight is the row,
      // which carries no capability, so the document form otherwise makes the whole step
      // look-only — leaving the tutorial able to tick the box and the reader not.
      allow: [{ anchor: `selector-checkbox-${DEMO_SPECIES_KEY}`, capability: 'activate' }],
      advanceOn: { type: 'signal', name: 'genome.activated', match: { speciesKey: DEMO_SPECIES_KEY } },
    },

    {
      id: 'genome-pill',
      section: SECTION.activate,
      view: 'genome_selector',
      anchor: `genome-pill-${DEMO_SPECIES_KEY}`,
      placement: 'bottom',
      interactive: false,
      title: 'Genome pills',
      body: 'Every selected genome gets a pill style button (such as the one highlighted '
        + 'above) that is then persistently available across all views. These pills can be '
        + 'activated (blue) or deactivated (grey) by clicking on them. Some views like the '
        + 'Genome Browser allow several genomes to be active simultaneously and allow for '
        + 'dynamic activation/deactivation of pills.  Each pill also has an \'X\' on the left '
        + 'hand side, which will remove them from the pill bar. This is the same as '
        + 'deselecting them in Genome Selector (where they can also be re-added to the pill '
        + 'bar).',
      ensure: ['demo-genome-installed', 'demo-genome-active'],
      // Going back from here un-ticks the box, so the previous step is something to watch
      // again rather than a checkbox that is already ticked and would now untick.
      undo: 'deactivate-demo-genome',
    },

    // ── Genome Browser ─────────────────────────────────────────────────────
    {
      id: 'open-browser',
      section: SECTION.browser,
      view: 'genome_browser',
      anchor: 'app-button-genome_browser',
      placement: 'bottom',
      title: 'Viewing the data',
      body: 'The Genome Browser view is the main view for general browsing the genomes and '
        + 'their annotations. It has a dedicated tutorial that covers more advanced features, '
        + 'we\'ll just look at the basics. The first time a genome is opened here its '
        + 'annotation is indexed, you may see a spinner while that happens. It is done once '
        + 'per genome, so the genomes and their annotation should load significantly faster '
        + 'after the initial load.',
      // Whether or not the last two steps were done, there must be a genome to look at.
      ensure: ['demo-genome-installed', 'demo-genome-active'],
      advanceOn: { type: 'view', view: 'genome_browser' },
    },
    {
      id: 'browser-track',
      section: SECTION.browser,
      view: 'genome_browser',
      anchor: { selector: '[data-browser-canvas-surface]' },
      placement: 'top',
      cardPosition: { x: 0.015, y: 0.0229 },
      cardSize: { width: 453 },
      interactive: false,
      ensure: ['demo-genome-installed', 'demo-genome-active'],
      title: 'The browser window',
      body: 'This is the genome itself, drawn along its coordinates. Both the genome, the '
        + 'genes and their identifiers are made up for this demo. The browser window is '
        + 'highlighted below, it has three default subtracks: GF, GR and SL representing genes '
        + 'on the forward and reverse strand and the sequence level track respectively. The '
        + 'genome coordinates ruler in on top.',
    },
    {
      id: 'browser-global-controls',
      section: SECTION.browser,
      view: 'genome_browser',
      anchor: 'browser-global-controls',
      placement: 'bottom',
      interactive: false,
      ensure: ['demo-genome-installed', 'demo-genome-active'],
      title: 'The general controls',
      body: 'The top bar sets how the browser behaves overall: which tracks are shown, how '
        + 'transcripts are laid out, and what dragging does. These settings apply to every '
        + 'active genome at once.',
    },
    {
      id: 'browser-genome-controls',
      section: SECTION.browser,
      view: 'genome_browser',
      anchor: { selector: '[data-browser-toolbar]' },
      placement: 'bottom',
      interactive: false,
      ensure: ['demo-genome-installed', 'demo-genome-active'],
      title: 'The controls for this genome',
      body: 'Below it, each genome gets a bar of its own: which contig you are on, where in it, '
        + 'and the search box. Activate several genomes and you get one of these bars each, '
        + 'stacked down the window — the general controls above still apply to all of them.',
    },
    {
      id: 'browser-search',
      section: SECTION.gene,
      view: 'genome_browser',
      anchor: 'browser-location-search',
      placement: 'bottom',
      title: 'Find a gene',
      body: 'Type ‘Welcome’ and press Return — or press Next and the tutorial will do it. The '
        + 'same box takes a region as chr:start-end. This demo genome only knows six gene '
        + 'names, so ‘Welcome’ is the one to use here.',
      ensure: ['demo-genome-installed', 'demo-genome-active'],
      // Overwrites deliberately: a search for a gene this genome does not contain simply
      // fails, and the step would sit there looking broken.
      action: { type: 'type', anchor: 'browser-location-search', value: 'Welcome', overwrite: true },
      advanceOn: { type: 'signal', name: 'browser.geneFocused' },
    },
    {
      id: 'browser-focused-gene',
      section: SECTION.gene,
      view: 'genome_browser',
      anchor: { selector: '[data-browser-canvas-surface]' },
      placement: 'top',
      interactive: false,
      ensure: ['demo-genome-installed', 'demo-genome-active'],
      // Going back from here clears the focus, so the search step is something to watch
      // again rather than a search box whose gene is already in focus.
      undo: 'unfocus-gene',
      title: 'Welcome, in the track',
      body: 'The made-up symbol ‘Welcome’: one transcript, three exons, on the forward strand '
        + 'of welcome1. The thick blocks are exons and the thin line between them is intron; '
        + 'the red dashed lines mark where the gene starts and ends.',
    },
    {
      id: 'browser-focus-bar',
      section: SECTION.gene,
      view: 'genome_browser',
      anchor: { selector: '[data-focus-bar]' },
      placement: 'bottom',
      interactive: false,
      ensure: ['demo-genome-installed', 'demo-genome-active'],
      title: 'The gene in focus',
      body: 'Focusing a gene pins it to this bar: its symbol, biotype, strand and coordinates, '
        + 'and a button to bring the view back to it if you have panned away. It stays there '
        + 'until you focus something else or unfocus it.',
    },
    {
      id: 'browser-drawer',
      section: SECTION.gene,
      view: 'genome_browser',
      // Reusing an attribute the drawer already carries, rather than adding another.
      anchor: { selector: '[data-focus-drawer]' },
      placement: 'left',
      interactive: false,
      ensure: ['demo-genome-installed', 'demo-genome-active'],
      title: 'The focus drawer',
      body: 'The drawer goes deeper: every transcript of the focused gene, their exons, the '
        + 'sequence underneath, and any notes you have taken. To, Ensembl and Go are on the '
        + 'same contig — try those once the tutorial is done.',
    },
  ],
}

// Editing a step's wording from the card rewrites this file, and a plain module change
// makes Vite reload the whole page — which ends the tutorial you were reading. Accepting
// the update keeps the session alive; the runtime already applied the edit in memory.
if (import.meta.hot) import.meta.hot.accept()
