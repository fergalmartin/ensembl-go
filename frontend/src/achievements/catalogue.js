// Every achievement, in the order they are numbered.
//
// This file is data. What an achievement *means* is its `rule`, evaluated by
// ./rules.js against the facts the tracker collects; what the user *did* is recorded by
// `trackAchievement(...)` calls in the views, each one a single line beside code that
// already runs.
//
// Two things here are promises to every user who has ever unlocked anything, and are
// enforced by tests/achievements.test.js against ./achievements.lock.json:
//
// * `id` is the key progress is stored under. It never changes and is never reused.
//   Rename the `name` as often as you like; never the id.
// * `number` is what the view shows, and people use it to spot what they are missing.
//   New achievements take the next number; numbers are never reshuffled. A retired
//   achievement keeps its entry with `retired: true`, so its number is never reused.
//
// Rule types (see ./rules.js):
//   event     — `event` has happened at least once
//   count     — `event` has happened `target` times
//   distinct  — `target` different keys seen for `set` (only `keys`, when given)
//   taxon     — a downloaded genome's lineage includes any of `taxa`
//   allOf     — every rule in `rules`
//   meta      — `target` other achievements unlocked
//   duration  — `metric` has accumulated `targetMs` of active use

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

// Categories, in the order the view lists them. `icon` is an app button id, so each
// badge wears the same icon as the view it belongs to.
export const ACHIEVEMENT_CATEGORIES = [
  { id: 'app', label: 'App & top bar', icon: 'home' },
  { id: 'exploring', label: 'Exploring', icon: 'help' },
  { id: 'genome_selector', label: 'Genome Selector', icon: 'genome_selector' },
  { id: 'genome_browser', label: 'Genome Browser', icon: 'genome_browser' },
  { id: 'download', label: 'Download', icon: 'download' },
  { id: 'sequence', label: 'Sequence', icon: 'sequence' },
  { id: 'feature_explorer', label: 'Feature Explorer', icon: 'feature_explorer' },
  { id: 'alignment_explorer', label: 'Alignment Explorer', icon: 'alignment_explorer' },
  { id: 'neighbourhood', label: 'Neighbourhood', icon: 'neighbourhood' },
  { id: 'notes', label: 'Notes', icon: 'notes' },
  { id: 'stats', label: 'Statistics', icon: 'stats' },
  { id: 'tutorials', label: 'Tutorials', icon: 'tutorials' },
  { id: 'achievements', label: 'Achievements', icon: 'achievements' },
]

// The views with a "visited" achievement of their own, #54–#70. Achievements itself is
// not here: finding it is #1.
const VIEW_VISITS = [
  ['visit_home', 54, 'home', "There's no place like home", 'Home'],
  ['visit_genome_selector', 55, 'genome_selector', 'Spoilt for choice', 'Genome Selector'],
  ['visit_genome_browser', 56, 'genome_browser', 'Just browsing', 'Genome Browser'],
  ['visit_download', 57, 'download', 'Special delivery', 'Download'],
  ['visit_sequence', 58, 'sequence', 'Read the fine print', 'Sequence'],
  ['visit_feature_explorer', 59, 'feature_explorer', 'Under the microscope', 'Feature Explorer'],
  ['visit_track_manager', 60, 'track_manager', 'On the right track', 'Track Manager'],
  ['visit_alignment', 61, 'alignment', 'Falling into line', 'Feature Alignment'],
  ['visit_alignment_explorer', 62, 'alignment_explorer', 'Layer cake', 'Alignment Explorer'],
  ['visit_neighbourhood', 63, 'neighbourhood', 'Block party', 'Neighbourhood'],
  ['visit_stats', 64, 'stats', 'By the numbers', 'Statistics'],
  ['visit_notes', 65, 'notes', 'Dear diary', 'Notes'],
  ['visit_tutorials', 66, 'tutorials', 'Class is in session', 'Tutorials'],
  ['visit_help', 67, 'help', 'Read the manual', 'Help'],
  ['visit_configuration', 68, 'configuration', 'Under the hood', 'Configuration'],
  ['visit_structural_variation', 69, 'structural_variation', 'Shake things up', 'Structural Variation'],
  ['visit_homology', 70, 'homology', 'Long lost relatives', 'Homology'],
]

// Download-view clades. Each is a set of NCBI taxids; a genome whose lineage contains
// any of them counts. The same anchors backend/taxonomy_classifier.py uses for the
// Download view's categories, so the achievement and the category always agree.
const TAXON = {
  rodent: [9989],
  felis: [9681],
  canis: [9611],
  bat: [9397],
  marsupial: [9263],
  fish: [7898, 7777, 7762, 118072, 7878, 1476529], // 1476529: Cyclostomata, for lampreys
  bird: [8782],
  reptile: [8504, 8459, 1294634],
  amphibian: [8292],
  lepidoptera: [7088],
  fly: [7147],
  beetle: [7041],
  hymenoptera: [7399],
  plant: [33090],
  grass: [4479],
  mollusc: [6447],
  arachnid: [6854],
  cnidarian: [6073],
  fungus: [4751],
  bacterium: [2],
  archaeon: [2157],
  eukaryote: [2759],
  protist: [33630, 33634, 554915, 33682, 207245, 5752, 543769, 33083, 28009, 2763, 2830, 192874, 3027],
  wheat: [4564],
}

const taxonRule = (key) => ({ type: 'taxon', taxa: TAXON[key] })

export const ACHIEVEMENTS = [
  // ── App & views ───────────────────────────────────────────────────────────
  { id: 'achievements_unlocked', number: 1, name: 'Achievements unlocked', description: 'You found the Achievements view and switched achievements on', category: 'achievements', rule: { type: 'event', event: 'achievements.enabled' } },
  { id: 'time_to_move_on', number: 2, name: "It's time to move on...", description: 'Downloaded GRCh37, despite the existence of GRCh38, CHM13 T2T and the human pangenome haplotypes. No judgement here though', category: 'download', rule: { type: 'distinct', set: 'genome.grch37', target: 1, source: 'backend' } },
  { id: 'one_hit_wonder', number: 3, name: 'One hit wonder', description: 'Created your first playlist', icon: 'genome_playlist', category: 'genome_selector', rule: { type: 'event', event: 'playlist.created' } },
  { id: 'welcome_to_the_multiverse', number: 4, name: 'Welcome to the multiverse', description: 'Activated two or more genomes simultaneously in the Genome Browser', category: 'genome_browser', rule: { type: 'event', event: 'browser.multiverse' } },
  { id: 'control_freak', number: 5, name: 'Control freak', description: 'Used five different Genome Browser controls, on the main control bar or a genome’s own toolbar', category: 'genome_browser', rule: { type: 'distinct', set: 'browser.control', target: 5 } },
  { id: 'nothing_left', number: 6, name: "There's nothing left", description: 'Turned off all four classes of genes simultaneously in the Genome Browser', category: 'genome_browser', rule: { type: 'event', event: 'browser.allClassesOff' } },
  { id: 'off_on_a_cycle', number: 7, name: 'Off on a cycle', description: 'Used the cycle button in the Genome Browser to cycle through genomes', category: 'genome_browser', rule: { type: 'event', event: 'browser.cycle' } },
  { id: 'tandem_browsing', number: 8, name: 'Tandem browsing', description: 'Linked panning and zooming for two or more genomes in the Genome Browser', category: 'genome_browser', rule: { type: 'event', event: 'browser.tandem' } },
  { id: 'locus_focus', number: 9, name: 'Locus focus', description: 'Used the location focus button in the Genome Browser', category: 'genome_browser', rule: { type: 'event', event: 'browser.locationFocus' } },
  { id: 'one_gene_to_rule_them_all', number: 10, name: 'One gene to rule them all', description: 'Activated gene focus in the Genome Browser', category: 'genome_browser', rule: { type: 'event', event: 'browser.geneFocus' } },
  { id: 'transcriptional_noise', number: 11, name: 'Transcriptional noise', description: 'Hid a transcript using the gene drawer in the Genome Browser', category: 'genome_browser', rule: { type: 'event', event: 'browser.hideTranscript' } },
  { id: 'take_me_home', number: 12, name: 'Take me home', description: 'Used the re-centre button for a gene or region of focus', category: 'genome_browser', rule: { type: 'event', event: 'browser.recenter' } },
  { id: 'context_switcher', number: 13, name: 'Context switcher', description: 'Focused on a gene in the Genome Browser and then switched to viewing it in the Feature Explorer', category: 'genome_browser', rule: { type: 'event', event: 'browser.toFeatureExplorer' } },
  { id: 'scribe', number: 14, name: 'Scribe', description: 'Wrote a note for a gene, location or genome', category: 'notes', rule: { type: 'count', event: 'notes.written', target: 1 } },
  { id: 'taskmaster', number: 15, name: 'Taskmaster', description: 'Created a task in the Notes view', category: 'notes', rule: { type: 'count', event: 'notes.tasks', target: 1 } },
  { id: 'noteworthy', number: 16, name: 'Noteworthy', description: 'Wrote five notes', category: 'notes', rule: { type: 'count', event: 'notes.written', target: 5 } },
  { id: 'tag', number: 17, name: 'Tag!', description: 'Attached a tag to a note', category: 'notes', rule: { type: 'count', event: 'notes.tagged', target: 1 } },
  { id: 'wiggle_it', number: 18, name: 'Wiggle it', description: 'Clicked and dragged an exon or intron in the transcript splicing graph in the Feature Explorer', category: 'feature_explorer', rule: { type: 'event', event: 'fe.dragGraph' } },
  { id: 'a_long_way_down', number: 19, name: 'A long way down', description: 'Scrolled down to the Export section in the Feature Explorer', category: 'feature_explorer', rule: { type: 'event', event: 'fe.exportReached' } },
  { id: 'more_transcripts', number: 20, name: 'We need more transcripts', description: 'Activated one or more inactive transcripts in the Feature Explorer', category: 'feature_explorer', rule: { type: 'event', event: 'fe.activateInactive' } },
  { id: 'flip_it', number: 21, name: 'Flip it', description: 'Reordered two genomes in the Neighbourhood view', category: 'neighbourhood', rule: { type: 'event', event: 'neighbourhood.swap' } },
  { id: 'twisted', number: 22, name: 'Twisted', description: 'Used the invert control to invert (or maybe uninvert) a neighbourhood between two genomes', category: 'neighbourhood', rule: { type: 'event', event: 'neighbourhood.invert' } },
  { id: 'oh_snap', number: 23, name: 'Oh snap!', description: 'Took a screenshot using the screenshot action button', icon: 'screenshot_toggle', category: 'app', rule: { type: 'event', event: 'screenshot.taken' } },
  { id: 'night_to_day', number: 24, name: 'From night to day', description: 'Switched from dark to light mode', icon: 'theme_toggle', category: 'app', rule: { type: 'event', event: 'theme.toLight' } },
  { id: 'a_place_for_everything', number: 25, name: 'A place for everything...', description: '...and everything in its place. You rearranged the view buttons from the default layout', category: 'app', rule: { type: 'event', event: 'appButtons.rearranged' } },
  { id: 'hey_dj', number: 26, name: 'Hey DJ', description: 'Changed playlists using the playlist button', icon: 'genome_playlist', category: 'app', rule: { type: 'event', event: 'playlist.switched' } },
  { id: 'give_me_some_space_1', number: 27, name: 'Give me some space I', description: 'Used the collapse arrow on the top bar to free up some space', category: 'app', rule: { type: 'event', event: 'topbar.collapse' } },
  { id: 'so_many_arrows', number: 28, name: 'So many arrows', description: 'Found the button organiser tray in the top bar', category: 'app', rule: { type: 'event', event: 'organiser.opened' } },
  { id: 'give_me_some_space_2', number: 29, name: 'Give me some space II', description: 'Used the Flatten button in the Genome Browser', category: 'genome_browser', rule: { type: 'event', event: 'browser.flatten' } },
  { id: 'give_me_some_space_3', number: 30, name: 'Give me some space III', description: 'Turned tracks off, or hid the inactive tracks, in the Genome Browser', category: 'genome_browser', rule: { type: 'event', event: 'browser.tracksAway' } },
  { id: 'informed', number: 31, name: 'Informed', description: 'Clicked the info icon on a genome pill in the Genome Browser', category: 'genome_browser', rule: { type: 'event', event: 'browser.pillInfo' } },
  { id: 'customised', number: 32, name: 'Customised', description: 'Manually added a custom genome', category: 'genome_selector', rule: { type: 'event', event: 'genome.manualAdded' } },
  { id: 'painter', number: 33, name: 'Painter', description: 'Selected a custom colour for a genome', category: 'genome_selector', rule: { type: 'distinct', set: 'genome.colour', target: 1 } },
  { id: 'artist', number: 34, name: 'Artist', description: 'Selected custom colours for five or more genomes', category: 'genome_selector', rule: { type: 'distinct', set: 'genome.colour', target: 5 } },
  { id: 'statistician', number: 35, name: 'Statistician', description: 'Used the Statistics view to generate some annotation stats', category: 'stats', rule: { type: 'event', event: 'stats.summary' } },
  { id: 'analyse_this', number: 36, name: 'Analyse this', description: 'Analysed a genome in the Statistics view', category: 'stats', rule: { type: 'event', event: 'stats.analysed' } },
  { id: 'genome_initiate', number: 37, name: 'Genome initiate', description: 'Downloaded your first genome', category: 'download', rule: { type: 'distinct', set: 'genome.downloaded', target: 1, source: 'backend' } },
  { id: 'genome_padawan', number: 38, name: 'Genome padawan', description: 'Downloaded five genomes', category: 'download', hidden: true, rule: { type: 'distinct', set: 'genome.downloaded', target: 5, source: 'backend' } },
  { id: 'genome_jedi_knight', number: 39, name: 'Genome Jedi knight', description: 'Downloaded ten genomes', category: 'download', hidden: true, rule: { type: 'distinct', set: 'genome.downloaded', target: 10, source: 'backend' } },
  { id: 'genome_jedi_master', number: 40, name: 'Genome Jedi master', description: 'Downloaded twenty-five genomes', category: 'download', hidden: true, rule: { type: 'distinct', set: 'genome.downloaded', target: 25, source: 'backend' } },
  { id: 'genome_yoda', number: 41, name: 'Genome Yoda', description: 'Downloaded one hundred genomes', category: 'download', hidden: true, rule: { type: 'distinct', set: 'genome.downloaded', target: 100, source: 'backend' } },
  { id: 'genome_sith_lord', number: 42, name: 'Genome Sith Lord', description: 'Deleted ten genomes', category: 'download', hidden: true, rule: { type: 'distinct', set: 'genome.deleted', target: 10, source: 'backend' } },
  { id: 'hey_there_neighbour', number: 43, name: 'Hey there neighbour', description: 'Used the Neighbourhood view to look at the neighbourhood of a gene', category: 'neighbourhood', rule: { type: 'event', event: 'neighbourhood.loaded' } },
  { id: 'path_of_the_scholar', number: 44, name: 'Path of the scholar', description: 'Completed a tutorial', category: 'tutorials', rule: { type: 'distinct', set: 'tutorial.completed', target: 1 } },
  { id: 'well_versed', number: 45, name: 'Well versed', description: 'Completed five tutorials', category: 'tutorials', rule: { type: 'distinct', set: 'tutorial.completed', target: 5 } },
  { id: 'sit_back_and_relax', number: 46, name: 'Sit back and relax', description: 'Used autoplay on a tutorial', category: 'tutorials', hidden: true, rule: { type: 'event', event: 'tutorial.autoplay' } },
  { id: 'jumping_back_in', number: 47, name: 'Jumping back in', description: 'Used step selection in a tutorial to jump straight to a particular step', category: 'tutorials', rule: { type: 'event', event: 'tutorial.jump' } },
  { id: 'achievement_novice', number: 48, name: 'Achievement novice', description: 'Unlocked five achievements', category: 'achievements', rule: { type: 'meta', target: 5 } },
  { id: 'achievement_intermediate', number: 49, name: 'Achievement intermediate', description: 'Unlocked ten achievements', category: 'achievements', hidden: true, rule: { type: 'meta', target: 10 } },
  { id: 'achievement_elite', number: 50, name: 'Achievement elite', description: 'Unlocked twenty-five achievements', category: 'achievements', hidden: true, rule: { type: 'meta', target: 25 } },
  { id: 'achievement_master', number: 51, name: 'Achievement master', description: 'Unlocked fifty achievements', category: 'achievements', hidden: true, rule: { type: 'meta', target: 50 } },
  { id: 'achievement_grandmaster', number: 52, name: 'Achievement grandmaster', description: 'Unlocked one hundred achievements. A huge achievement', category: 'achievements', hidden: true, rule: { type: 'meta', target: 100 } },
  { id: 'bask_in_your_achievements', number: 53, name: 'Bask in your achievements', description: 'Spent ten minutes or more in the Achievements view', category: 'achievements', hidden: true, rule: { type: 'duration', metric: 'view.achievements', targetMs: 10 * MINUTE } },

  ...VIEW_VISITS.map(([id, number, viewId, name, label]) => ({
    id, number, name, description: `Visited the ${label} view`, category: 'exploring', icon: viewId,
    rule: { type: 'distinct', set: 'view.visit', keys: [viewId], target: 1 },
  })),

  { id: 'view_enthusiast', number: 71, name: 'View enthusiast', description: 'Visited five different views', category: 'exploring', hidden: true, rule: { type: 'distinct', set: 'view.visit', target: 5 } },
  { id: 'view_explorer', number: 72, name: 'View explorer', description: 'Visited fifteen different views', category: 'exploring', hidden: true, rule: { type: 'distinct', set: 'view.visit', target: 15 } },
  { id: 'going', number: 73, name: "Go'ing", description: 'Used Ensembl Go for an hour or more', category: 'exploring', hidden: true, rule: { type: 'duration', metric: 'app.active', targetMs: HOUR } },
  { id: 'going_strong', number: 74, name: "Go'ing strong", description: 'Used Ensembl Go for five hours or more', category: 'exploring', hidden: true, rule: { type: 'duration', metric: 'app.active', targetMs: 5 * HOUR } },
  { id: 'going_wild', number: 75, name: "Go'ing wild", description: 'Used Ensembl Go for ten hours or more', category: 'exploring', hidden: true, rule: { type: 'duration', metric: 'app.active', targetMs: 10 * HOUR } },

  // ── Sequence and Alignment Explorer ───────────────────────────────────────
  { id: 'transcript_inspector', number: 76, name: 'Transcript inspector', description: 'Switched between the Genomic, Transcript, CDS and Protein contexts for a protein-coding transcript in the Sequence view', category: 'sequence', rule: { type: 'distinct', set: 'seq.context', keys: ['genomic', 'transcript', 'cds', 'protein'], target: 4 } },
  { id: 'needle_in_a_haystack', number: 77, name: 'Needle in a haystack', description: 'Used Find in the Sequence view to search for a subsequence', category: 'sequence', rule: { type: 'event', event: 'seq.find' } },
  { id: 'sequence_for_ants', number: 78, name: 'Sequence for ants', description: 'Zoomed out in the Sequence view', category: 'sequence', rule: { type: 'event', event: 'seq.zoomOut' } },
  { id: 'save_it_for_later', number: 79, name: 'Save it for later', description: 'Downloaded a sequence from the Sequence view', category: 'sequence', rule: { type: 'event', event: 'seq.download' } },
  { id: 'old_school', number: 80, name: 'Old school', description: 'Switched to the plain text display in the Sequence view', category: 'sequence', rule: { type: 'event', event: 'seq.plain' } },
  { id: 'in_the_spotlight_1', number: 81, name: 'In the spotlight I', description: 'Highlighted a region in the Sequence view', category: 'sequence', rule: { type: 'event', event: 'seq.highlight' } },
  { id: 'in_the_spotlight_2', number: 82, name: 'In the spotlight II', description: 'Highlighted a region in the Alignment Explorer', category: 'alignment_explorer', rule: { type: 'event', event: 'ae.highlight' } },
  { id: 'mind_the_gap', number: 83, name: 'Mind the gap', description: 'Hid alignment gaps with the gap controls in the Alignment Explorer', category: 'alignment_explorer', rule: { type: 'event', event: 'ae.gapsHidden' } },
  { id: 'layer_hopper', number: 84, name: 'Layer hopper', description: 'Cycled layers using the cycle button in the Alignment Explorer', category: 'alignment_explorer', rule: { type: 'event', event: 'ae.cycleLayer' } },
  { id: 'more_sequence', number: 85, name: 'We need more sequence', description: 'Increased a flanking region past its default in the Sequence view', category: 'sequence', rule: { type: 'event', event: 'seq.flankUp' } },
  { id: 'big_data', number: 86, name: 'Big data', description: 'Loaded a region of a megabase or more in the Sequence view', category: 'sequence', rule: { type: 'event', event: 'seq.bigRegion' } },
  { id: 'record_maker', number: 87, name: 'Record maker', description: 'Ticked features in the Sequence view panel to display their sequences as records', category: 'sequence', rule: { type: 'event', event: 'seq.records' } },
  { id: 'can_i_see_your_id', number: 88, name: 'Can I see your ID please?', description: 'Searched for a gene ID or symbol in the Genome Browser', category: 'genome_browser', rule: { type: 'event', event: 'browser.idSearch' } },
  { id: 'click_click', number: 89, name: 'Click click', description: 'Used two-click select in the Sequence view', category: 'sequence', rule: { type: 'event', event: 'seq.twoClick' } },
  { id: 'teenie_tiny_genome', number: 90, name: 'Teenie tiny genome', description: 'Looked at a genome of less than 5 megabases in the Genome Browser', category: 'genome_browser', hidden: true, rule: { type: 'event', event: 'browser.tinyGenome' } },
  { id: 'huge', number: 91, name: 'Huge', description: 'Looked at a genome of more than 5 gigabases in the Genome Browser', category: 'genome_browser', hidden: true, rule: { type: 'event', event: 'browser.hugeGenome' } },

  // ── Download: the tree of life ────────────────────────────────────────────
  { id: 'rodent_catcher', number: 92, name: 'Rodent catcher', description: 'Downloaded a rodent genome', category: 'download', hidden: true, rule: taxonRule('rodent') },
  { id: 'catty', number: 93, name: 'Catty', description: 'Downloaded a genome from the genus Felis', category: 'download', hidden: true, rule: taxonRule('felis') },
  { id: 'good_boy', number: 94, name: 'Good boy', description: 'Downloaded a genome from the genus Canis', category: 'download', hidden: true, rule: taxonRule('canis') },
  { id: 'the_bat_signal', number: 95, name: 'The bat signal', description: 'Downloaded a bat genome', category: 'download', hidden: true, rule: taxonRule('bat') },
  { id: 'marsupial_mapper', number: 96, name: 'Marsupial mapper', description: 'Downloaded a marsupial genome', category: 'download', hidden: true, rule: taxonRule('marsupial') },
  { id: 'fish_lover', number: 97, name: 'Fish lover', description: 'Downloaded a fish genome', category: 'download', hidden: true, rule: taxonRule('fish') },
  { id: 'birder', number: 98, name: 'Birder', description: 'Downloaded a bird genome', category: 'download', hidden: true, rule: taxonRule('bird') },
  { id: 'reptilian', number: 99, name: 'Reptilian', description: 'Downloaded a reptile genome', category: 'download', hidden: true, rule: taxonRule('reptile') },
  { id: 'amphibious', number: 100, name: 'Amphibious', description: 'Downloaded an amphibian genome', category: 'download', hidden: true, rule: taxonRule('amphibian') },
  { id: 'lepidopterist', number: 101, name: 'Lepidopterist', description: 'Downloaded a moth or butterfly genome', category: 'download', hidden: true, rule: taxonRule('lepidoptera') },
  { id: 'fly_spotter', number: 102, name: 'Fly spotter', description: 'Downloaded a fly genome', category: 'download', hidden: true, rule: taxonRule('fly') },
  { id: 'beetle_collector', number: 103, name: 'Beetle collector', description: 'Downloaded a beetle genome', category: 'download', hidden: true, rule: taxonRule('beetle') },
  { id: 'hymenopterist', number: 104, name: 'Hymenopterist', description: 'Downloaded a bee, wasp, ant or sawfly genome', category: 'download', hidden: true, rule: taxonRule('hymenoptera') },
  { id: 'green_thumb', number: 105, name: 'Green thumb', description: 'Downloaded a plant genome', category: 'download', hidden: true, rule: taxonRule('plant') },
  { id: 'grass_roots', number: 106, name: 'Grass roots', description: 'Downloaded a genome from the grass family', category: 'download', hidden: true, rule: taxonRule('grass') },
  { id: 'mollusc_maven', number: 107, name: 'Mollusc maven', description: 'Downloaded a mollusc genome', category: 'download', hidden: true, rule: taxonRule('mollusc') },
  { id: 'arachnid_archivist', number: 108, name: 'Arachnid archivist', description: 'Downloaded an arachnid genome', category: 'download', hidden: true, rule: taxonRule('arachnid') },
  { id: 'cnidarian_collector', number: 109, name: 'Cnidarian collector', description: 'Downloaded a cnidarian genome', category: 'download', hidden: true, rule: taxonRule('cnidarian') },
  { id: 'forager', number: 110, name: 'Forager', description: 'Downloaded a fungal genome', category: 'download', hidden: true, rule: taxonRule('fungus') },
  { id: 'bacterial_buff', number: 111, name: 'Bacterial buff', description: 'Downloaded a bacterial genome', category: 'download', hidden: true, rule: taxonRule('bacterium') },
  { id: 'archaeal_explorer', number: 112, name: 'Archaeal explorer', description: 'Downloaded an archaeal genome', category: 'download', hidden: true, rule: taxonRule('archaeon') },
  { id: 'protist_pioneer', number: 113, name: 'Protist pioneer', description: 'Downloaded a protist genome', category: 'download', hidden: true, rule: taxonRule('protist') },
  { id: 'tree_of_life', number: 114, name: 'Tree of life', description: 'Downloaded a bacterial, an archaeal and a eukaryotic genome', category: 'download', hidden: true, rule: { type: 'allOf', rules: [taxonRule('bacterium'), taxonRule('archaeon'), taxonRule('eukaryote')] } },
  { id: 'wheatabix', number: 115, name: 'Wheatabix', description: 'Downloaded a wheat genome', category: 'download', hidden: true, rule: taxonRule('wheat') },
]

export const ACHIEVEMENTS_BY_ID = new Map(ACHIEVEMENTS.map((achievement) => [achievement.id, achievement]))

/** What counts towards the totals: everything that has not been retired. */
export const ACTIVE_ACHIEVEMENTS = ACHIEVEMENTS.filter((achievement) => !achievement.retired)

// Events a running tutorial is allowed to record. Everything else a tutorial does —
// including autoplay clicking through the browser on the reader's behalf — is ignored,
// so the only achievements a tutorial can award are the ones about tutorials.
export const TUTORIAL_ALLOWED_EVENTS = new Set(['tutorial.completed', 'tutorial.autoplay', 'tutorial.jump'])
