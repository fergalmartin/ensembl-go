// The request queues, one pair per genome and chromosome, held outside React so
// that they survive the view being unmounted and remounted.
//
// Two queues rather than one, with separate budgets, so that annotation reads
// can never occupy the worker that sequence needs. That matters most while a
// genome's annotation index is being built: class requests are meeting 425 and
// backing off, and sequence carries on rendering beside them.

import { TileScheduler } from '../alignment-explorer/tileScheduler'

// One worker for sequence, because every read of a genome's FASTA is serialised
// behind a lock on the backend (see ThreadSafeFasta in main.py). A second worker
// would not read in parallel; it would only let a request the reader has already
// scrolled past sit in front of the one they are waiting for. At one, the queue
// is ours to order, and abandoning a stale request actually brings the wanted
// one forward.
const SEQUENCE_CONCURRENCY = 1
const SEQUENCE_ENTRIES = 512
const SEQUENCE_BYTES = 24 * 1024 * 1024

const CLASS_CONCURRENCY = 2
const CLASS_ENTRIES = 128
const CLASS_BYTES = 16 * 1024 * 1024

const services = new Map()

export function sequenceTiles(key) {
    const id = String(key || 'empty')
    if (!services.has(id)) {
        services.set(id, {
            sequence: new TileScheduler({
                concurrency: SEQUENCE_CONCURRENCY,
                maxEntries: SEQUENCE_ENTRIES,
                maxBytes: SEQUENCE_BYTES,
            }),
            classes: new TileScheduler({
                concurrency: CLASS_CONCURRENCY,
                maxEntries: CLASS_ENTRIES,
                maxBytes: CLASS_BYTES,
            }),
            users: 0,
        })
    }
    return services.get(id)
}

/** For tests and for switching genomes in a long session. */
export function releaseSequenceTiles(key) {
    services.delete(String(key || 'empty'))
}
