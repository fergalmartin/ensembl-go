// Generated tutorial registry. Rebuilt by the internal promotion command.
//
// Promotion regenerates this file with `generatedTutorial1`, `generatedTutorial2`… names.
// They are renamed back by hand each time: the list is read by people far more often than
// it is rewritten, and a registry that does not say which tutorial is which is no use to
// either. Check this file's diff after every promotion.
import customGenome from './generated/custom-genome.tutorial.json' with { type: 'json' }
import multiGenome from './generated/multi-genome-browsing.tutorial.json' with { type: 'json' }
import playlists from './generated/tutorial-mt8m7a4h.tutorial.json' with { type: 'json' }

export const GENERATED_TUTORIALS = Object.freeze([customGenome, multiGenome, playlists])
