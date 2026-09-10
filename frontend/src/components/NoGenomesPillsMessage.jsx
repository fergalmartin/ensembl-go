import AppButtonIcon from './AppButtonIcon'
import { APP_BUTTON_META } from '../appButtonConfig'

/** The header button in miniature: the same square, the same icon, at the size the
 *  pills row has room for.
 *
 *  Scaled rather than re-drawn. The header buttons are 44px square and each icon is sized
 *  against that, so shrinking the box alone would leave the icons at the wrong weight
 *  inside it. Scaling the whole thing keeps the proportions the reader has to recognise
 *  it by — this has to look like the button above, or naming it here helps nobody. */
const HEADER_BUTTON_SIZE = 44
const INLINE_BUTTON_SIZE = 28
const INLINE_SCALE = INLINE_BUTTON_SIZE / HEADER_BUTTON_SIZE

const InlineAppButton = ({ buttonId, isLight, onClick }) => {
    const label = APP_BUTTON_META[buttonId]?.label || buttonId
    return (
        <button
            type="button"
            onClick={onClick}
            className="inline-flex flex-none items-center justify-center align-middle transition-colors bg-[#0099ff] text-white/90 hover:text-white hover:bg-[#0088ee]"
            style={{
                width: INLINE_BUTTON_SIZE,
                height: INLINE_BUTTON_SIZE,
                // `rounded-lg` is 8px on the full-size button; scaled with everything else.
                borderRadius: Math.round(8 * INLINE_SCALE),
            }}
            title={`Open ${label}`}
            aria-label={`Open ${label}`}
        >
            <span className="inline-flex" style={{ transform: `scale(${INLINE_SCALE})` }}>
                <AppButtonIcon buttonId={buttonId} isLight={isLight} />
            </span>
        </button>
    )
}

/**
 * What the pills strip says when there is nothing in it.
 *
 * The strip used to disappear entirely with no genomes, which left the emptiest possible
 * app with no hint of what to do about it — and made the header change height the moment
 * a first genome arrived. It now keeps its place and names the two routes to a genome.
 */
export default function NoGenomesPillsMessage({ isLight, onOpenView }) {
    return (
        <span className={`flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs leading-5 ${isLight ? 'text-gray-600' : 'text-gray-300'}`}>
            <span className="font-semibold">No genomes selected.</span>
            <span>Use</span>
            <InlineAppButton buttonId="download" isLight={isLight} onClick={() => onOpenView('download')} />
            {/* The name sits beside the button rather than inside it: the button is the
                thing to recognise and press, and the words are the sentence around it. */}
            <span className="font-semibold">Download</span>
            <span>to fetch data and</span>
            <InlineAppButton buttonId="genome_selector" isLight={isLight} onClick={() => onOpenView('genome_selector')} />
            <span className="font-semibold">Genome Selector</span>
            <span>to add local genomes to the current session.</span>
        </span>
    )
}
