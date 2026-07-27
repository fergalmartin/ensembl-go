export function datasetReleaseDownloadMetadata(file, fallback = null) {
  const source = file || {}
  const backup = fallback || {}
  return {
    dataset_release_key: String(
      source.dataset_release_key
      || backup.dataset_release_key
      || backup.active_dataset_release_key
      || backup.default_dataset_release_key
      || '',
    ).trim(),
    dataset_release_source: String(
      source.dataset_release_source || backup.dataset_release_source || '',
    ).trim(),
    dataset_release_date: String(
      source.dataset_release_date || backup.dataset_release_date || '',
    ).trim(),
    dataset_release_label: String(
      source.dataset_release_label || backup.dataset_release_label || '',
    ).trim(),
  }
}
