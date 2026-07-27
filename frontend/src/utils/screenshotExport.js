const SVG_NS = 'http://www.w3.org/2000/svg'
const XHTML_NS = 'http://www.w3.org/1999/xhtml'

export const SCREENSHOT_SCALE_OPTIONS = [1, 2, 4]
export const SCREENSHOT_FORMATS = ['svg', 'png', 'jpeg']

export function buildScreenshotTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

export function buildDefaultScreenshotName(prefix = 'ens_screenshot', date = new Date()) {
  return `${prefix}_${buildScreenshotTimestamp(date)}`
}

export function normalizeScreenshotFormat(format) {
  const normalized = String(format || 'svg').trim().toLowerCase()
  if (normalized === 'jpg') return 'jpeg'
  return SCREENSHOT_FORMATS.includes(normalized) ? normalized : 'svg'
}

export function getScreenshotExtension(format) {
  const normalized = normalizeScreenshotFormat(format)
  if (normalized === 'jpeg') return 'jpg'
  return normalized
}

export function ensureScreenshotFilename(name, format) {
  const trimmed = String(name || '').trim()
  const fallback = buildDefaultScreenshotName()
  const base = trimmed || fallback
  const ext = getScreenshotExtension(format)
  const lower = base.toLowerCase()
  const validExts = SCREENSHOT_FORMATS.flatMap((item) => {
    const derived = getScreenshotExtension(item)
    return item === 'jpeg' ? [`.${derived}`, '.jpeg'] : [`.${derived}`]
  })
  const existingExt = validExts.find((candidate) => lower.endsWith(candidate))
  if (!existingExt) return `${base}.${ext}`
  if (existingExt === `.${ext}`) return base
  return `${base.slice(0, -existingExt.length)}.${ext}`
}

export function normalizeAllowedScreenshotFormats(formats) {
  const raw = Array.isArray(formats) && formats.length > 0 ? formats : SCREENSHOT_FORMATS
  const normalized = []
  const seen = new Set()
  for (const candidate of raw) {
    const next = normalizeScreenshotFormat(candidate)
    if (seen.has(next)) continue
    seen.add(next)
    normalized.push(next)
  }
  return normalized.length > 0 ? normalized : [...SCREENSHOT_FORMATS]
}

export function resolveDefaultScreenshotFormat(target) {
  const allowed = normalizeAllowedScreenshotFormats(target?.allowedFormats)
  const preferred = normalizeScreenshotFormat(target?.defaultFormat || allowed[0] || 'svg')
  return allowed.includes(preferred) ? preferred : allowed[0]
}

export function subtreeContainsCanvas(node) {
  if (!node || typeof node.querySelector !== 'function') return false
  return Boolean(node.querySelector('canvas'))
}

export function resolveScreenshotCaptureNode(node) {
  if (!node || typeof node.querySelectorAll !== 'function') return node

  const preferred = node.matches?.('[data-screenshot-capture="view"]')
    ? node
    : node.querySelector?.('[data-screenshot-capture="view"]')
  if (preferred) return preferred

  const candidates = [node, ...Array.from(node.querySelectorAll('*'))]
  let bestNode = node
  let bestScore = -1

  for (const candidate of candidates) {
    const scrollWidth = Number(candidate?.scrollWidth || 0)
    const scrollHeight = Number(candidate?.scrollHeight || 0)
    const clientWidth = Number(candidate?.clientWidth || 0)
    const clientHeight = Number(candidate?.clientHeight || 0)
    const overflowWidth = Math.max(0, scrollWidth - clientWidth)
    const overflowHeight = Math.max(0, scrollHeight - clientHeight)
    if (!(overflowWidth > 16 || overflowHeight > 16)) continue

    const area = Math.max(scrollWidth, clientWidth, 1) * Math.max(scrollHeight, clientHeight, 1)
    const score = (overflowHeight * 1000000) + (overflowWidth * 1000) + area
    if (score > bestScore) {
      bestScore = score
      bestNode = candidate
    }
  }

  return bestNode
}

export function measureScreenshotNode(node, { preferScrollSize = true } = {}) {
  const rect = typeof node?.getBoundingClientRect === 'function'
    ? node.getBoundingClientRect()
    : { width: 0, height: 0 }
  const width = Math.max(
    1,
    Math.round(
      (preferScrollSize ? node?.scrollWidth : 0)
      || node?.clientWidth
      || rect.width
      || node?.width?.baseVal?.value
      || node?.width
      || 1
    )
  )
  const height = Math.max(
    1,
    Math.round(
      (preferScrollSize ? node?.scrollHeight : 0)
      || node?.clientHeight
      || rect.height
      || node?.height?.baseVal?.value
      || node?.height
      || 1
    )
  )
  return { width, height }
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function cssStyleTextFromComputed(computedStyle) {
  const rules = []
  for (const propertyName of computedStyle) {
    const propertyValue = computedStyle.getPropertyValue(propertyName)
    if (!propertyValue) continue
    rules.push(`${propertyName}:${propertyValue};`)
  }
  return rules.join('')
}

function sanitizeStyleText(styleText) {
  const base = String(styleText || '')
    .replace(/(?:^|;)\s*cursor\s*:[^;]*;?/gi, ';')
    .replace(/(?:^|;)\s*pointer-events\s*:[^;]*;?/gi, ';')
  return `${base}${base && !base.endsWith(';') ? ';' : ''}cursor:default !important;pointer-events:none !important;user-select:none !important;-webkit-user-select:none !important;`
}

function appendStyleText(existingStyle, extraStyle) {
  const base = String(existingStyle || '').trim()
  const extra = String(extraStyle || '').trim()
  if (!base) return extra
  if (!extra) return base
  return `${base}${base.endsWith(';') ? '' : ';'}${extra}`
}

function buildExportPlaceholder(ownerDocument, width, height, label) {
  const placeholder = ownerDocument.createElementNS(XHTML_NS, 'div')
  placeholder.setAttribute(
    'style',
    sanitizeStyleText(
      `display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:${width}px;height:${height}px;`
      + 'border:1px dashed rgba(100,116,139,0.45);background:rgba(148,163,184,0.08);'
      + 'color:#64748b;font:12px system-ui,sans-serif;text-align:center;padding:6px;'
    )
  )
  placeholder.textContent = label
  return placeholder
}

function rasterizeLoadedImage(source, width, height) {
  if (!source?.complete || !(source.naturalWidth > 0) || !(source.naturalHeight > 0)) return null
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width || 1))
  canvas.height = Math.max(1, Math.round(height || 1))
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}

function cloneNodeWithInlineStyles(node, ownerDocument) {
  if (!node) return null
  if (node.nodeType === Node.TEXT_NODE) {
    return ownerDocument.createTextNode(node.textContent || '')
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return null
  }

  const source = /** @type {HTMLElement} */ (node)
  const rasterProxySelector = source.getAttribute?.('data-screenshot-raster-proxy')
  if (rasterProxySelector) {
    const proxy = source.querySelector?.(rasterProxySelector)
    const { width, height } = measureScreenshotNode(source, { preferScrollSize: false })
    if (proxy?.tagName?.toLowerCase() === 'img') {
      try {
        const dataUrl = rasterizeLoadedImage(proxy, width, height)
        if (dataUrl) {
          const image = ownerDocument.createElementNS(XHTML_NS, 'img')
          image.setAttribute('src', dataUrl)
          image.setAttribute('alt', proxy.getAttribute('alt') || 'Rendered viewport')
          image.setAttribute('style', sanitizeStyleText(`display:block;width:${width}px;height:${height}px;max-width:none;`))
          return image
        }
      } catch {
        // Fall through to the normal DOM clone until the first worker snapshot is available.
      }
    }
  }
  const tagName = source.tagName.toLowerCase()
  if (tagName === 'title') return null
  const namespace = source.namespaceURI === SVG_NS ? SVG_NS : XHTML_NS
  const clone = ownerDocument.createElementNS(namespace, tagName)
  if (namespace === SVG_NS && tagName === 'svg') {
    clone.setAttribute('xmlns', SVG_NS)
  }
  const computed = window.getComputedStyle(source)
  const styleText = sanitizeStyleText(cssStyleTextFromComputed(computed))
  if (styleText) clone.setAttribute('style', styleText)
  const scrollWidth = Math.max(0, Math.round(Number(source.scrollWidth) || 0))
  const scrollHeight = Math.max(0, Math.round(Number(source.scrollHeight) || 0))
  const clientWidth = Math.max(0, Math.round(Number(source.clientWidth) || 0))
  const clientHeight = Math.max(0, Math.round(Number(source.clientHeight) || 0))
  if (scrollWidth > clientWidth + 1) clone.setAttribute('data-export-scroll-width', String(scrollWidth))
  if (scrollHeight > clientHeight + 1) clone.setAttribute('data-export-scroll-height', String(scrollHeight))

  for (const attr of Array.from(source.attributes || [])) {
    const attrName = attr.name.toLowerCase()
    if (attrName === 'style' || attrName.startsWith('on')) continue
    if (attrName === 'title' || attrName === 'tabindex') continue
    if (attrName === 'value' || attrName === 'checked' || attrName === 'selected') continue
    if (attr.namespaceURI) {
      clone.setAttributeNS(attr.namespaceURI, attr.name, attr.value)
    } else {
      clone.setAttribute(attr.name, attr.value)
    }
  }

  if (tagName === 'input') {
    const type = source.getAttribute('type') || 'text'
    clone.setAttribute('type', type)
    clone.setAttribute('value', source.value || '')
    if (source.checked) clone.setAttribute('checked', 'checked')
  } else if (tagName === 'textarea') {
    clone.textContent = source.value || ''
  } else if (tagName === 'option') {
    if (source.selected) clone.setAttribute('selected', 'selected')
  }

  if (tagName === 'img') {
    const { width, height } = measureScreenshotNode(source, { preferScrollSize: false })
    try {
      const dataUrl = rasterizeLoadedImage(source, width, height)
      if (!dataUrl) {
        return buildExportPlaceholder(ownerDocument, width, height, source.getAttribute('alt') || 'Image unavailable in export')
      }
      clone.setAttribute('src', dataUrl)
      clone.setAttribute(
        'style',
        sanitizeStyleText(
          `${clone.getAttribute('style') || ''}${clone.getAttribute('style') ? ';' : ''}`
          + `display:block;width:${width}px;height:${height}px;max-width:none;`
        )
      )
    } catch {
      return buildExportPlaceholder(ownerDocument, width, height, source.getAttribute('alt') || 'Image unavailable in export')
    }
  }

  for (const child of Array.from(source.childNodes || [])) {
    const clonedChild = cloneNodeWithInlineStyles(child, ownerDocument)
    if (clonedChild) clone.appendChild(clonedChild)
  }

  if (tagName === 'canvas') {
    const { width, height } = measureScreenshotNode(source, { preferScrollSize: false })
    try {
      const dataUrl = source.toDataURL('image/png')
      const image = ownerDocument.createElementNS(XHTML_NS, 'img')
      image.setAttribute('src', dataUrl)
      image.setAttribute('style', sanitizeStyleText(`display:block;width:${width}px;height:${height}px;`))
      return image
    } catch {
      return buildExportPlaceholder(ownerDocument, width, height, 'Canvas unavailable in export')
    }
  }

  return clone
}

function expandCloneScrollableContent(cloneRoot, { width, height } = {}) {
  if (!cloneRoot || typeof cloneRoot.querySelectorAll !== 'function') return

  cloneRoot.setAttribute(
    'style',
    sanitizeStyleText(
      appendStyleText(
        cloneRoot.getAttribute('style') || '',
        `width:${Math.max(1, Math.round(width || 1))}px;min-width:${Math.max(1, Math.round(width || 1))}px;`
        + `height:${Math.max(1, Math.round(height || 1))}px;min-height:${Math.max(1, Math.round(height || 1))}px;`
        + 'max-width:none;max-height:none;overflow:visible !important;'
      )
    )
  )

  const candidates = [cloneRoot, ...Array.from(cloneRoot.querySelectorAll('[data-export-scroll-width], [data-export-scroll-height]'))]
  for (const node of candidates) {
    const scrollWidth = Math.max(0, Math.round(Number(node.getAttribute('data-export-scroll-width')) || 0))
    const scrollHeight = Math.max(0, Math.round(Number(node.getAttribute('data-export-scroll-height')) || 0))
    if (!(scrollWidth > 0 || scrollHeight > 0)) continue

    const extraStyle = [
      scrollWidth > 0 ? `width:${scrollWidth}px;min-width:${scrollWidth}px;max-width:none;` : '',
      scrollHeight > 0 ? `height:${scrollHeight}px;min-height:${scrollHeight}px;max-height:none;` : '',
      'overflow:visible !important;',
    ].join('')
    node.setAttribute('style', sanitizeStyleText(appendStyleText(node.getAttribute('style') || '', extraStyle)))
  }
}

export function buildForeignObjectMarkup(node, { width, height, mutateClone, overflow = 'hidden' } = {}) {
  if (!node) return ''
  const { width: measuredWidth, height: measuredHeight } = measureScreenshotNode(node)
  const markupWidth = Math.max(1, Math.round(width || measuredWidth || 1))
  const markupHeight = Math.max(1, Math.round(height || measuredHeight || 1))
  const doc = document.implementation.createDocument(XHTML_NS, 'div', null)
  const root = doc.documentElement
  root.setAttribute('xmlns', XHTML_NS)
  root.setAttribute('style', `width:${markupWidth}px;height:${markupHeight}px;box-sizing:border-box;overflow:${overflow};cursor:default !important;pointer-events:none !important;user-select:none !important;-webkit-user-select:none !important;`)
  const clonedNode = cloneNodeWithInlineStyles(node, doc)
  if (clonedNode && typeof mutateClone === 'function') {
    mutateClone(clonedNode, {
      ownerDocument: doc,
      width: markupWidth,
      height: markupHeight,
    })
  }
  if (clonedNode) root.appendChild(clonedNode)
  return new XMLSerializer().serializeToString(root)
}

export function buildHtmlDocumentMarkup({ width, height, bodyMarkup, backgroundColor = '#ffffff' }) {
  const safeWidth = Math.max(1, Math.round(width || 1))
  const safeHeight = Math.max(1, Math.round(height || 1))
  const safeBackground = escapeXml(backgroundColor)
  return [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '<meta charset="UTF-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    '<style>',
    `html, body { margin: 0; padding: 0; width: ${safeWidth}px; min-height: ${safeHeight}px; overflow: visible; background: ${safeBackground}; }`,
    `body { width: ${safeWidth}px; min-height: ${safeHeight}px; background: ${safeBackground}; }`,
    '</style>',
    '</head>',
    '<body>',
    bodyMarkup,
    '</body>',
    '</html>',
  ].join('')
}

export function buildDomNodeScreenshotSnapshot(node, {
  width,
  height,
  backgroundColor = '#ffffff',
  mutateClone,
} = {}) {
  if (!node) throw new Error('Screenshot target is no longer available.')
  const { width: measuredWidth, height: measuredHeight } = measureScreenshotNode(node)
  const exportWidth = Math.max(1, Math.round(width || measuredWidth || 1))
  const exportHeight = Math.max(1, Math.round(height || measuredHeight || 1))
  const markup = buildForeignObjectMarkup(node, {
    width: exportWidth,
    height: exportHeight,
    overflow: 'visible',
    mutateClone: (clonedNode, context) => {
      expandCloneScrollableContent(clonedNode, {
        width: exportWidth,
        height: exportHeight,
      })
      mutateClone?.(clonedNode, context)
    },
  })

  return {
    width: exportWidth,
    height: exportHeight,
    backgroundColor,
    bodyMarkup: markup,
    htmlMarkup: buildHtmlDocumentMarkup({
      width: exportWidth,
      height: exportHeight,
      bodyMarkup: markup,
      backgroundColor,
    }),
    svgMarkup: buildSvgDocument({
      width: exportWidth,
      height: exportHeight,
      body: `<foreignObject x="0" y="0" width="${exportWidth}" height="${exportHeight}">${markup}</foreignObject>`,
      backgroundColor,
    }),
  }
}

function createSvgBlobUrl(svgMarkup) {
  const blob = new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' })
  return URL.createObjectURL(blob)
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = (error) => reject(error)
    image.src = src
  })
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const result = String(reader.result || '')
      const commaIndex = result.indexOf(',')
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result)
    }
    reader.onerror = () => reject(reader.error || new Error('Failed to read blob'))
    reader.readAsDataURL(blob)
  })
}

export async function rasterizeSvgMarkup({ svgMarkup, width, height, format = 'png', scale = 1, quality = 0.92, backgroundColor = '#ffffff' }) {
  const normalizedFormat = normalizeScreenshotFormat(format)
  const safeWidth = Math.max(1, Math.round(width || 1))
  const safeHeight = Math.max(1, Math.round(height || 1))
  const safeScale = Math.max(1, Number(scale) || 1)
  const blobUrl = createSvgBlobUrl(svgMarkup)

  try {
    const image = await loadImage(blobUrl)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(safeWidth * safeScale))
    canvas.height = Math.max(1, Math.round(safeHeight * safeScale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Failed to create export canvas context')

    if (normalizedFormat === 'jpeg') {
      ctx.fillStyle = backgroundColor
      ctx.fillRect(0, 0, canvas.width, canvas.height)
    }

    ctx.setTransform(safeScale, 0, 0, safeScale, 0, 0)
    ctx.drawImage(image, 0, 0, safeWidth, safeHeight)

    const mimeType = normalizedFormat === 'jpeg' ? 'image/jpeg' : 'image/png'
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((nextBlob) => {
        if (nextBlob) resolve(nextBlob)
        else reject(new Error('Failed to rasterize screenshot'))
      }, mimeType, normalizedFormat === 'jpeg' ? quality : undefined)
    })
    const base64 = await blobToBase64(blob)
    return {
      base64,
      mimeType,
      width: canvas.width,
      height: canvas.height,
    }
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
}

export function buildSvgDocument({ width, height, body, backgroundColor = '#ffffff' }) {
  const safeWidth = Math.max(1, Math.round(width || 1))
  const safeHeight = Math.max(1, Math.round(height || 1))
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="${SVG_NS}" xmlns:xlink="http://www.w3.org/1999/xlink" width="${safeWidth}" height="${safeHeight}" viewBox="0 0 ${safeWidth} ${safeHeight}" fill="none">`,
    `<style><![CDATA[
      svg * { cursor: default !important; }
      svg g, svg path, svg rect, svg circle, svg ellipse, svg line, svg polyline, svg polygon, svg text, svg image, svg foreignObject, svg use { pointer-events: none !important; }
    ]]></style>`,
    `<rect width="${safeWidth}" height="${safeHeight}" fill="${escapeXml(backgroundColor)}" />`,
    `<g pointer-events="none" style="cursor:default">${body}</g>`,
    `</svg>`,
  ].join('')
}

export { escapeXml }
