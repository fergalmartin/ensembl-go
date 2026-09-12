# The info box — how the cards are written

The card is 380px wide, sits beside the thing it describes, and is read while the reader is
trying to do something. Everything below follows from that. All examples are real, quoted
from the shipped tutorials; read more of them in the documents themselves before drafting.

## Voice

**Second person, present tense, British spelling, no exclamation marks.** Match the app,
which is written the same way.

**The author's "we" is part of the voice and is kept.** The tutorials speak as the people
who loaded the data — *"We've loaded a megabase of chromosome 1"*, *"Here we've centered on
TBX15"*, *"We'll be looking at a small region of chromosome 1"* — and then switch to "you"
for anything the reader does. Do not mechanically convert one into the other; write the
setup as "we" and the instruction as "you", which is what the existing cards do.

**Where the app and British spelling disagree, the app wins.** In practice this is one
word: every user-visible *centre* in the app is spelled *center*, so the cards are too
(*"centered on HAO2"*, *"re-center"*). Do not "correct" it.

## What a card says

**Say what a thing is, then what it is for. Not what it is called and where it sits** — the
reader can see that, it is spotlit.

> The general control bar applies to every active genome at once. Here there is only
> GRCh38, but several genomes can be active together, and some of these controls only
> appear when more than one is.

That earns its space. "This is the general control bar" does not.

**Every step has two audiences at once** — someone reading and pressing Next, and someone
doing it themselves. The shape that works is **the action first, the shortcut second**:

> Tick the box to activate the genome — or press Next and the tutorial will tick it for you.

> Type ‘Welcome’ and press Return — or press Next and the tutorial will do it.

Never write what the button will do instead of what the reader could do. "Next will type
Ensemblus welcomus" was rewritten for exactly this.

**Quote anything the reader is meant to type**, with typographic quotes: ‘Welcome’,
‘Ensemblus welcomus’. It separates the value from the sentence and makes it findable.

**Mention what is about to happen that they could not predict.** The first open of a genome
indexes its annotation and shows a spinner; a step that does not warn produces a bug report.

**Say the true thing about what is on screen now.** A card describing a state is read after
that state has been established by the step's `arrive`, so the sentence must be true at the
moment it is read — and must stay true when the step is reached backwards.

## A result card

The result card is the one people leave out, and it has a recognisable shape: it names what
changed and where, without re-explaining the control that caused it.

> The browser has moved to the region copied into the search box, centered on HAO2. A
> region search frames those coordinates exactly in the browser track.

> All three TBX15 transcripts are drawn now, one under the other. The reverse track has
> grown taller to display them.

When the result is a whole new region, the first result card names the region and says what
it is for; the detail belongs to the steps after it.

## Titles

**Short and concrete.** "Find a gene", "The track", "It has landed", "Put it to work",
"HAO2 region", "The expanded transcript set", "Flatten to compact". Not "Step 4:
Downloading", and not a sentence.

## Sections

`section` is the chapter heading, rendered as the card's heading with the step's `title`
beneath it, and used to group the jump links. Choose boundaries by **idea, not by size** —
"General controls", "Moving through the genome", "Displaying transcripts" may hold quite
different numbers of steps. Sections must be contiguous, and once one step names a section
every step must.

## Length

**Three or four lines** — roughly 48 characters a line at 380px, so about 170–220
characters. This is not only taste:

- A `placement: 'top'` card near the top of the window will not fit above its target if the
  body runs long.
- Autoplay's dwell is derived from word count, so padding a step makes everyone wait longer
  for no more information.

The browser tutorial's card-text pass took the longest body from 404 characters to 216 and
the mean from 218 to 176. Bodies over ~220 characters are acceptable only where the card is
placed left or right, where headroom is not the constraint.

## The intro and the outro

**Intro** — what the tutorial covers, honestly scoped, plus a word about Next:

> This tutorial covers the genome browser in more detail. It doesn't cover every possible
> feature or control, but is designed to help you get proficient in the basics of browsing.

> This tutorial covers downloading a genome, selecting it and viewing in the browser. By the
> end of this tutorial you'll understand the basics of fetching and viewing genomes and
> annotation data in Ensembl Go. The Next button will advance to the next step if you are
> doing the tutorial interactively.

**Outro** — a review card naming what was taught, in the order taught:

> We've compared two annotations on GRCh38, linked their regions by coordinates, and used
> Pan and Zoom together and separately. We've also linked SAMD11 across human, mouse and rat
> by its symbol, made space by switching off unused strands, and cleared every focused gene
> with Unfocus.

**`completionBody`** is a different thing again — one or two sentences on the catalogue card
after the tutorial ends, and the right place to reassure about the sandbox:

> You have seen the whole loop: configure, download, activate, browse. Real genomes work
> exactly the same way; they just take longer to arrive. Your own settings and genomes were
> never changed, and the tutorial's temporary data has been cleared away.

## Accuracy

Every factual claim a card makes is checkable, and all of them were checked: PHGDH's
thirty-eight transcripts, HMGCS2's twenty-two, TBX15's three, "a megabase of chromosome 1"
being exactly the opening window, and the gene-class window holding three protein-coding and
three lncRNA genes and nothing else. Run a script over the bundled annotation rather than
trusting the brief. A card that is confidently wrong about what is on screen is worse than
no card.

## Editing wording later

The card carries a pencil in its top right in a source checkout. It edits `section`, `title`,
`body` and `copy` in place, at the real width, next to the thing described — which is how
awkward sentences actually get found. Saves go to the document (and, for the two original
built-ins, to the JavaScript rollback as well). Renaming a section from any card renames it
across the section. Use it for the prose pass; it is far better than reading bodies in JSON.
