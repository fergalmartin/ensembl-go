export function shouldStartSvRequest({
  fetchKey,
  lastFetchKey = '',
  inFlightFetchKey = '',
  retryScheduled = false,
}) {
  return Boolean(
    fetchKey
    && fetchKey !== lastFetchKey
    && fetchKey !== inFlightFetchKey
    && !retryScheduled
  )
}

export function createSvRequestError(message, { status = null, retryable = false } = {}) {
  const error = new Error(message)
  if (Number.isFinite(Number(status))) error.status = Number(status)
  if (retryable) error.retryable = true
  return error
}

export function isRetryableSvRequestError(error) {
  if (error?.retryable === true) return true

  const status = Number(error?.status)
  if (status === 408 || status === 425 || status === 429 || status >= 500) return true

  const message = String(error?.message || error || '').toLowerCase()
  return message.includes('failed to fetch') || message.includes('networkerror')
}
