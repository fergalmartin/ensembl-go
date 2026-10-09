// Saving a screenshot of a view that has no screenshot targets of its own.
import { API_BASE } from '../backendRuntime.js'
import { rasterizeSvgMarkup } from '../utils/screenshotExport.js'

export async function saveFallbackScreenshot(ctx, { filename, directory, format, scale, quality, target }) {
    const {
        isLight,
    } = ctx
    if (!target?.buildExportSnapshot) {
      return { ok: false, error: 'Screenshot target is no longer available.' }
    }

    try {
      const snapshot = await target.buildExportSnapshot()
      if (!snapshot?.svgMarkup) {
        return { ok: false, error: 'Failed to build screenshot export.' }
      }

      let payload
      if (format === 'svg') {
        payload = {
          directory,
          filename,
          format,
          mime_type: 'image/svg+xml',
          encoding: 'utf8',
          data: snapshot.svgMarkup,
        }
      } else {
        const electronBridge = typeof window !== 'undefined' ? window.electronAPI : null
        let raster = null

        if (snapshot.htmlMarkup && typeof electronBridge?.captureHtmlSnapshot === 'function') {
          try {
            raster = await electronBridge.captureHtmlSnapshot({
              htmlMarkup: snapshot.htmlMarkup,
              width: snapshot.width,
              height: snapshot.height,
              format,
              scale,
              quality,
              backgroundColor: snapshot.backgroundColor || (isLight ? '#ffffff' : '#111827'),
            })
          } catch {
            raster = null
          }
        }

        if (!raster) {
          raster = await rasterizeSvgMarkup({
            svgMarkup: snapshot.svgMarkup,
            width: snapshot.width,
            height: snapshot.height,
            format,
            scale,
            quality: format === 'jpeg' ? Math.max(0.7, Math.min(1, quality / 100)) : undefined,
            backgroundColor: snapshot.backgroundColor || (isLight ? '#ffffff' : '#111827'),
          })
        }
        payload = {
          directory,
          filename,
          format,
          mime_type: raster.mimeType,
          encoding: 'base64',
          data: raster.base64,
        }
      }

      const response = await fetch(`${API_BASE}/api/exports/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data?.ok) {
        return { ok: false, error: data?.detail || 'Failed to save screenshot.' }
      }
      return { ok: true, path: data.path, filename: data.filename }
    } catch (error) {
      return { ok: false, error: error?.message || 'Failed to export screenshot.' }
    }
  }
