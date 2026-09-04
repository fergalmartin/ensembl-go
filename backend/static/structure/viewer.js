/*
 * Sandboxed Mol* host for the Feature Explorer's structure panel.
 *
 * Mol* needs 'unsafe-eval' and is six megabytes of third-party code, so it is
 * kept out of the app's renderer entirely and run here instead: a separate
 * origin, a separate Content-Security-Policy, and no access to the Electron
 * bridge or the API token the renderer holds. The React panel drives it over
 * postMessage; everything this file knows how to do is in COMMANDS below.
 */
(function () {
  'use strict'

  var PARENT_SOURCE = 'ensembl-structure'
  var VIEWER_SOURCE = 'ensembl-structure-viewer'

  var THEME_BACKGROUNDS = {
    light: { r: 255, g: 255, b: 255 },
    dark: { r: 31, g: 41, b: 55 },
  }

  /* A quarter turn a second: fast enough to read the fold's depth from, slow
     enough to follow one exon around the back. Mol*'s own default (0.1) takes
     ten seconds a revolution, pdbe's (1) is too fast to track anything. The axis
     is Mol*'s default, in camera space — vertical, turning left to right. */
  var SPIN_ROTATIONS_PER_SECOND = 0.25
  var SPIN_AXIS = [0, -1, 0]

  /* How close framing an exon is allowed to take the camera, as a fraction of
     the whole structure's radius, and how long the move takes. See `focus`. */
  var MIN_FOCUS_SCENE_FRACTION = 0.7
  var FOCUS_DURATION_MS = 250

  var viewerInstance = null
  var currentTheme = 'light'
  var statusEl = document.getElementById('status')
  var viewportEl = document.getElementById('viewport')

  /* The parent may be a file:// page, whose origin serialises as "null" and
     cannot be named as a targetOrigin. Everything sent upwards is UI state the
     parent already knows, so a wildcard target leaks nothing. Inbound messages
     are still shape-checked below. */
  function emit(type, payload) {
    try {
      window.parent.postMessage({ source: VIEWER_SOURCE, type: type, payload: payload || {} }, '*')
    } catch (err) {
      /* A closed or detached parent is not worth reporting. */
    }
  }

  function reply(id, ok, payload, error) {
    if (!id) return
    try {
      window.parent.postMessage({
        source: VIEWER_SOURCE,
        type: 'result',
        id: id,
        ok: !!ok,
        payload: payload || {},
        error: error ? String(error) : '',
      }, '*')
    } catch (err) {
      /* as above */
    }
  }

  function setStatus(message, isError) {
    if (!statusEl) return
    if (!message) {
      statusEl.hidden = true
      statusEl.textContent = ''
      statusEl.classList.remove('is-error')
      return
    }
    statusEl.hidden = false
    statusEl.textContent = message
    statusEl.classList.toggle('is-error', !!isError)
  }

  function applyTheme(theme) {
    currentTheme = theme === 'dark' ? 'dark' : 'light'
    document.body.classList.toggle('theme-dark', currentTheme === 'dark')
    if (viewerInstance && viewerInstance.canvas && viewerInstance.canvas.setBgColor) {
      return viewerInstance.canvas.setBgColor(THEME_BACKGROUNDS[currentTheme])
    }
    return Promise.resolve()
  }

  /* Residue identity differs by file format: AlphaFold mmCIF numbers residues by
     UniProt position in auth_seq_id, but a click payload may only carry one of
     several aliases depending on the Mol* version. */
  function residueNumberFrom(data) {
    if (!data) return 0
    var candidates = [data.auth_seq_id, data.residue_number, data.seq_id, data.label_seq_id]
    for (var i = 0; i < candidates.length; i += 1) {
      var value = Number(candidates[i])
      if (Number.isFinite(value) && value > 0) return value
    }
    return 0
  }

  function subscribeInteraction() {
    var handle = function (type) {
      return function (event) {
        var data = (event && (event.eventData || event.detail)) || null
        var residue = residueNumberFrom(data)
        if (!residue) return
        emit(type, {
          residue: residue,
          chain: (data && (data.auth_asym_id || data.label_asym_id)) || '',
          residueName: (data && data.comp_id) || '',
        })
      }
    }
    var onClick = handle('residueClick')
    var onHover = handle('residueHover')
    /* pdbe-molstar has dispatched these on the container in some versions and on
       document in others; listening to both is cheaper than version-sniffing,
       and a duplicate event is harmless because the payload is idempotent. */
    var targets = [document, viewportEl]
    targets.forEach(function (target) {
      if (!target) return
      target.addEventListener('PDB.molstar.click', onClick)
      target.addEventListener('PDB.molstar.mouseover', onHover)
    })
  }

  function ensureViewer() {
    if (viewerInstance) return viewerInstance
    if (typeof window.PDBeMolstarPlugin !== 'function') {
      throw new Error('The Mol* viewer bundle failed to load.')
    }
    viewerInstance = new window.PDBeMolstarPlugin()
    return viewerInstance
  }

  function initOptions(options) {
    return {
      customData: { url: options.modelUrl, format: 'cif', binary: false },
      /* The AlphaFold preset supplies the pLDDT confidence colouring, which is
         what a viewer of a predicted model expects to see first. */
      alphafoldView: options.alphafoldView !== false,
      bgColor: THEME_BACKGROUNDS[options.theme === 'dark' ? 'dark' : 'light'],
      hideControls: true,
      sequencePanel: false,
      pdbeLink: false,
      landscape: true,
      /* Every canvas button is off, and the panel supplies its own instead. The
         four that used to survive were each wrong here for their own reason:
         Reset Zoom and Screenshot duplicate controls the panel already has,
         Toggle Expanded Viewport sets a `position: fixed` layout that cannot
         escape a fixed-height iframe and so does nothing at all, and Toggle
         Selection Mode feeds a selection into structure panels that hideControls
         has already removed. Mol*'s own chrome is also unthemeable without a
         per-class override sheet — its compiled CSS carries no custom properties
         — so replacing it beats restyling it. */
      hideCanvasControls: ['all'],
      subscribeEvents: true,
    }
  }

  var COMMANDS = {
    load: function (payload) {
      var modelUrl = String((payload && payload.modelUrl) || '')
      if (!modelUrl) throw new Error('load requires a modelUrl')

      setStatus('Loading structure…', false)
      applyTheme(payload.theme)

      var options = initOptions({
        modelUrl: modelUrl,
        theme: payload.theme,
        alphafoldView: payload.alphafoldView,
      })

      var viewer = ensureViewer()
      var started

      if (viewer.__rendered) {
        /* Switching transcripts must not rebuild the canvas: update() swaps the
           structure in place, keeping the camera and the WebGL context. */
        started = Promise.resolve(viewer.visual.update(options, true))
      } else if (typeof viewer.render !== 'function') {
        started = Promise.reject(new Error('The Mol* viewer could not be initialised.'))
      } else {
        started = Promise.resolve(viewer.render(viewportEl, options)).then(function () {
          viewer.__rendered = true
          subscribeInteraction()
        })
      }

      return started.then(function () {
        setStatus('', false)
        emit('loadComplete', { modelUrl: modelUrl })
        return { loaded: true }
      })
    },

    /* One select() call carries both layers, and order is what stacks them:
       pdbe-molstar applies the overpaint layers in array order, so `overlays`
       are appended after `segments` and win wherever the two meet. That is how
       a variant mark sits on top of the exon colouring rather than beside it.

       pdbe-molstar can also add a separate representation per entry
       (`representation: 'spacefill'`), which would give variants their own
       geometry. It is not used: the component is created — 307 atoms, no error
       — but contributes no pixels to the render, so the marks would silently
       not appear. Overpaint is the mechanism that demonstrably draws. */
    colorSegments: function (payload) {
      var segments = (payload && payload.segments) || []
      var overlays = (payload && payload.overlays) || []
      var viewer = ensureViewer()
      if (!segments.length && !overlays.length) return viewer.visual.clearSelection()

      var data = segments.map(function (segment) {
        var entry = {
          start_residue_number: Number(segment.start),
          end_residue_number: Number(segment.end),
          color: segment.color,
        }
        if (segment.tooltip) entry.tooltip = String(segment.tooltip)
        return entry
      })

      overlays.forEach(function (overlay) {
        var entry = {
          start_residue_number: Number(overlay.start),
          end_residue_number: Number(overlay.end || overlay.start),
          color: overlay.color,
        }
        if (overlay.tooltip) entry.tooltip = String(overlay.tooltip)
        data.push(entry)
      })

      data = data.filter(function (entry) {
        return entry.start_residue_number > 0 && entry.end_residue_number >= entry.start_residue_number
      })

      return viewer.visual.select({
        data: data,
        nonSelectedColor: (payload && payload.nonSelectedColor) || null,
      }).then(function () {
        return { colored: data.length }
      })
    },

    clearColors: function () {
      return ensureViewer().visual.clearSelection()
    },

    highlight: function (payload) {
      var viewer = ensureViewer()
      var ranges = (payload && payload.ranges) || [payload]
      return viewer.visual.highlight({
        data: ranges.map(function (range) {
          return {
            start_residue_number: Number(range.start),
            end_residue_number: Number(range.end || range.start),
          }
        }),
        color: payload.color || undefined,
        focus: !!payload.focus,
      })
    },

    clearHighlight: function () {
      return ensureViewer().visual.clearHighlight()
    },

    /* Framing an exon must not slice the model.
       
       Mol* derives the near and far clipping planes from `camera.state.radius`
       (near = distance - radius, far = distance + radius), and focusing sets
       that radius to the framed sphere. Frame one 79-residue exon of a 118 Å
       protein and the camera keeps a 61 Å slab: the rest of the fold is cut
       away, and what survives in front of and behind the cut reads as loose
       fragments floating in space — the structure looks like it lost geometry.
       Measured on PHGDH: radius 59 → 31, near 95.8 → 49.3, far 215 → 110.

       The planes should always describe the whole scene; only where the camera
       looks should change. Mol* offers no option for that, so the snapshot it
       builds is intercepted on its way to requestCameraReset and its radius put
       back before the transition starts. Correcting it afterwards would work
       too, but the camera would visibly slice and then heal over the animation.

       `minRadius` is the other half: without a floor the camera dives until one
       exon fills the viewport and the fold leaves the frame entirely, which
       reads as disappearance for the same reason even with the planes fixed.
       The panel's viewport is much wider than it is tall and Mol* fits to the
       shorter side, so it crops hard. At 0.7 of the scene radius the framing is
       still a real move — the exon is unmistakably the subject — and the rest of
       the fold stays in frame to place it against. Checked at the panel's own
       1126×418 on PHGDH's largest coding exon (79 aa) and its smallest (22). */
    focus: function (payload) {
      var ranges = (payload && payload.ranges) || [payload]
      var viewer = ensureViewer()
      var canvas3d = viewer.plugin && viewer.plugin.canvas3d
      if (!canvas3d) throw new Error('The viewer is not ready to move the camera.')

      var loci = viewer.getLociForParams(ranges.map(function (range) {
        return {
          start_residue_number: Number(range.start),
          end_residue_number: Number(range.end || range.start),
        }
      }))

      var sceneRadius = canvas3d.boundingSphereVisible.radius
      var captured = null
      var request = canvas3d.requestCameraReset
      canvas3d.requestCameraReset = function (options) { captured = options }
      try {
        viewer.plugin.managers.camera.focusLoci(loci, {
          durationMs: FOCUS_DURATION_MS,
          minRadius: sceneRadius * MIN_FOCUS_SCENE_FRACTION,
        })
      } finally {
        canvas3d.requestCameraReset = request
      }

      if (!captured || !captured.snapshot) return { focused: false }
      captured.snapshot.radius = sceneRadius
      canvas3d.requestCameraReset(captured)
      return { focused: true }
    },

    setTheme: function (payload) {
      return applyTheme(payload && payload.theme)
    },

    /* Not viewer.visual.toggleSpin(). That helper sets the trackball to
       `animate: { name: 'spin', params: { speed: 1 } }` and omits `axis`, which
       Mol*'s trackball dereferences as `axis[0]` on the first animated frame.
       The TypeError is raised inside the animation loop, so the command still
       resolves, no error reaches the parent, and the model simply never moves —
       verified against pdbe-molstar 3.12.0. Setting the trackball directly with
       a complete params object is the whole fix. */
    spin: function (payload) {
      var canvas3d = ensureViewer().plugin && ensureViewer().plugin.canvas3d
      if (!canvas3d) throw new Error('The viewer is not ready to animate.')
      var on = !!(payload && payload.on)
      canvas3d.setProps({
        trackball: {
          animate: on
            ? { name: 'spin', params: { speed: SPIN_ROTATIONS_PER_SECOND, axis: SPIN_AXIS } }
            : { name: 'off', params: {} },
        },
      })
      return { spinning: on }
    },

    /* Not visual.reset({ camera: true }). Mol*'s Camera.Reset re-fits the
       bounding sphere along whichever direction the camera already points —
       getFocus() derives its direction from the current position — so it is a
       re-zoom, not a re-orientation, and after the model has been spun or
       dragged it changes nothing the viewer can see. setViewDirection('front')
       restores the orientation the model loaded in and re-fits at the same
       time; the theme reset still goes through the library helper. */
    reset: function () {
      var viewer = ensureViewer()
      return Promise.resolve(viewer.visual.setViewDirection('front', { durationMs: 250 }))
        .then(function () {
          return viewer.visual.reset({ theme: true })
        })
    },

    /* The app screenshots panels by serialising the DOM into an SVG
       foreignObject, which captures a WebGL canvas as an empty rectangle. The
       parent asks for a raster here instead and composites it. */
    screenshot: function () {
      var viewer = ensureViewer()
      var helpers = viewer.plugin && viewer.plugin.helpers
      var shot = helpers && helpers.viewportScreenshot
      if (shot && typeof shot.getImageDataUri === 'function') {
        return Promise.resolve(shot.getImageDataUri()).then(function (dataUri) {
          return { dataUri: dataUri }
        })
      }
      var canvas = viewportEl && viewportEl.querySelector('canvas')
      if (!canvas) throw new Error('No rendered canvas to capture.')
      return Promise.resolve({ dataUri: canvas.toDataURL('image/png') })
    },
  }

  window.addEventListener('message', function (event) {
    var message = event && event.data
    if (!message || typeof message !== 'object') return
    if (message.source !== PARENT_SOURCE) return

    var handler = COMMANDS[message.type]
    if (!handler) {
      reply(message.id, false, null, 'Unknown command: ' + message.type)
      return
    }

    var run
    try {
      run = Promise.resolve(handler(message.payload || {}))
    } catch (err) {
      run = Promise.reject(err)
    }

    run.then(function (result) {
      reply(message.id, true, result || {})
    }, function (err) {
      var detail = (err && err.message) || String(err)
      if (message.type === 'load') {
        setStatus(detail, true)
        emit('loadError', { message: detail })
      }
      reply(message.id, false, null, detail)
    })
  })

  emit('ready', { version: '1' })
})()
