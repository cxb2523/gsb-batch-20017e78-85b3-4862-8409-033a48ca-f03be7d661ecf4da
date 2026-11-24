/**
 * WebGL Comparison Component
 * GPU-accelerated comparison with 26 analysis modes
 * WEBGL-001: Quantitative Metrics Overlay
 * WEBGL-002: Color Legend / Scale Bar
 * WEBGL-007: Zoom and Pan
 * WEBGL-008: A/B Flip Toggle
 */

import { useEffect, useRef, useCallback, useState, useMemo } from 'react'
import { useProjectStore } from '../../stores/projectStore'
import { useMediaStore } from '../../stores/mediaStore'
import { useTimelineStore } from '../../stores/timelineStore'
import { usePlaybackStore } from '../../stores/playbackStore'
import { WebGLComparisonRenderer } from '../../lib/webgl/WebGLComparisonRenderer'
import { getComparisonModeInfo } from '../../lib/webgl/comparison-shaders'
import { useOptimizedClipSync } from '../../hooks/useOptimizedVideoSync'
import { useWebGLSourceMapping } from '../../hooks/useWebGLSourceMapping'
import { computeMetricsFromWebGLCanvas } from '../../lib/webgl/metricsComputation'
import { BarChart3, Ruler, FlipHorizontal, ZoomIn, ZoomOut, RotateCcw, Crosshair, Camera, Copy, Scan, X, LineChart, FileText, Palette, AlertTriangle, Activity, Image, Video } from 'lucide-react'
import type { ROIRect } from '../../types'
import { TemporalDiffGraph } from './TemporalDiffGraph'
import { WebGLSplitView, SplitViewToggle } from './WebGLSplitView'
import { WebGLPresetsPanel, PresetsToggle } from './WebGLPresetsPanel'
import { BatchComparison, BatchComparisonToggle } from './BatchComparison'
import { CustomShaderEditor, ShaderEditorToggle } from './CustomShaderEditor'
import { generatePDFReport, downloadBlob, captureCanvasScreenshot } from '../../lib/screenshotExport'
import { HistogramPanel, ColorWheelPanel, GamutWarningOverlay } from '../scopes'

export function WebGLComparison() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<WebGLComparisonRenderer | null>(null)
  const videoARef = useRef<HTMLVideoElement>(null)
  const videoBRef = useRef<HTMLVideoElement>(null)
  const imgARef = useRef<HTMLImageElement>(null)
  const imgBRef = useRef<HTMLImageElement>(null)
  const animationRef = useRef<number>(0)
  const metricsTimerRef = useRef<number>(0)
  const lastMetricsTimeRef = useRef<number>(0)

  const [mousePos, setMousePos] = useState({ x: 0.5, y: 0.5 })
  const [screenMousePos, setScreenMousePos] = useState({ x: 0, y: 0 })
  const [isSupported, setIsSupported] = useState(true)
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const [cursorPixelInfo, setCursorPixelInfo] = useState<{
    a: { r: number; g: number; b: number } | null;
    b: { r: number; g: number; b: number } | null;
  }>({ a: null, b: null })

  // WEBGL-004: ROI drawing state
  const [isDrawingROI, setIsDrawingROI] = useState(false)
  const [roiStart, setROIStart] = useState({ x: 0, y: 0 })
  const [tempROI, setTempROI] = useState<ROIRect | null>(null)

  // WEBGL-009: Temporal diff graph visibility (only for videos)
  const [showTemporalGraph, setShowTemporalGraph] = useState(false)

  // WEBGL-011: Split view visibility
  const [showSplitView, setShowSplitView] = useState(false)

  // WEBGL-015: Presets panel visibility
  const [showPresetsPanel, setShowPresetsPanel] = useState(false)

  // WEBGL-013: Batch comparison visibility
  const [showBatchComparison, setShowBatchComparison] = useState(false)

  // WEBGL-014: Custom shader editor visibility
  const [showShaderEditor, setShowShaderEditor] = useState(false)

  // SCOPE-008: Histogram panel visibility
  const [showHistogramPanel, setShowHistogramPanel] = useState(false)

  // SCOPE-009: Color wheel panel visibility
  const [showColorWheelPanel, setShowColorWheelPanel] = useState(false)

  // SCOPE-010: Gamut warning overlay visibility
  const [showGamutWarning, setShowGamutWarning] = useState(false)

  const {
    webglComparisonSettings,
    webglAnalysisMetrics,
    setWebGLAnalysisMetrics,
    toggleWebGLMetricsOverlay,
    toggleWebGLScaleBar,
    toggleWebGLFlipAB,
    toggleWebGLCursorInspector,
    setWebGLZoom,
    setWebGLPan,
    resetWebGLZoom,
    setROI,
    clearROI,
    toggleROIControls
  } = useProjectStore()
  const { addFile } = useMediaStore()
  const { tracks, addClip } = useTimelineStore()
  // Subscribe to files to trigger re-renders when files are added/updated
  const mediaFiles = useMediaStore(state => state.files)

  // File upload refs for empty state
  const fileInputRef = useRef<HTMLInputElement>(null)
  const currentUploadTarget = useRef<{ track: 'a' | 'b' } | null>(null)
  const { currentTime } = usePlaybackStore()

  // Get active media from tracks
  const trackA = tracks.find(t => t.type === 'a')
  const trackB = tracks.find(t => t.type === 'b')

  // Get first clip for display
  const firstClipA = trackA?.clips[0] || null
  const firstClipB = trackB?.clips[0] || null

  // Find clip that contains current time for proper sync
  const activeClipA = useMemo(() => {
    if (!trackA) return null
    return trackA.clips.find(c => currentTime >= c.startTime && currentTime < c.endTime) || null
  }, [trackA, currentTime])

  const activeClipB = useMemo(() => {
    if (!trackB) return null
    return trackB.clips.find(c => currentTime >= c.startTime && currentTime < c.endTime) || null
  }, [trackB, currentTime])

  // Get media files - use active clip (clip at current time), fallback to first clip
  const displayClipA = activeClipA || firstClipA
  const displayClipB = activeClipB || firstClipB
  const rawMediaA = displayClipA ? mediaFiles.find(f => f.id === displayClipA.mediaId) : null
  const rawMediaB = displayClipB ? mediaFiles.find(f => f.id === displayClipB.mediaId) : null
  // Only use media that is ready (has URL) and is image or video type
  const stableMediaA = rawMediaA?.type === 'video' || rawMediaA?.type === 'image' ? (rawMediaA.url ? rawMediaA : null) : null
  const stableMediaB = rawMediaB?.type === 'video' || rawMediaB?.type === 'image' ? (rawMediaB.url ? rawMediaB : null) : null

  // WEBGL-008: A/B Flip mapping lives exclusively in useWebGLSourceMapping.
  // `mediaA`/`mediaB` are the logical (post-flip) descriptors used by the UI
  // and export paths; the hidden video/image elements keep their stable
  // physical sources and are never reloaded by a flip.
  const sourceMapping = useWebGLSourceMapping({
    stableMediaA,
    stableMediaB,
    flipAB: webglComparisonSettings.flipAB,
    videoARef,
    videoBRef,
    imgARef,
    imgBRef,
  })
  const { slots: mappedSlots, bothReady: sourcesReady } = sourceMapping
  const mediaA = mappedSlots.a.media
  const mediaB = mappedSlots.b.media

  // Latest mapping handed to the rAF/metrics loops so they never read a
  // stale closure.
  const mappingRef = useRef(sourceMapping)
  mappingRef.current = sourceMapping

  // Use the optimized clip sync hook for videos (respects play/pause state)
  useOptimizedClipSync(videoARef, activeClipA || firstClipA)
  useOptimizedClipSync(videoBRef, activeClipB || firstClipB)

  // Initialize renderer. Keyed on the canvas element's actual presence rather
  // than a one-shot mount effect: the component starts in an empty state with
  // no <canvas>, so an effect with `[]` deps would run before the canvas exists
  // and never re-run once it mounts after media is added. A callback ref fires
  // precisely when the real canvas attaches (and again with null on unmount).
  const initRendererFor = useCallback((canvas: HTMLCanvasElement) => {
    if (!WebGLComparisonRenderer.isSupported()) {
      setIsSupported(false)
      return
    }

    let retryCount = 0
    const container = containerRef.current

    const initRenderer = () => {
      const rect = container?.getBoundingClientRect()
      let width = rect?.width ?? 0
      let height = rect?.height ?? 0

      // If container has no dimensions, try again (max 10 retries)
      if ((width <= 0 || height <= 0) && retryCount < 10) {
        retryCount++
        setTimeout(initRenderer, 100)
        return
      }

      // Set canvas dimensions with minimum
      width = Math.max(Math.round(width), 640)
      height = Math.max(Math.round(height), 480)

      canvas.width = width
      canvas.height = height

      try {
        const renderer = new WebGLComparisonRenderer(canvas)
        rendererRef.current = renderer
        renderer.setMode(useProjectStore.getState().webglComparisonSettings.mode)
      } catch (err) {
        console.error('[WebGL] Renderer initialization failed:', err)
      }
    }

    // Wait a frame to ensure the container is laid out
    setTimeout(initRenderer, 50)
  }, [])

  const setCanvasRef = useCallback((canvas: HTMLCanvasElement | null) => {
    // Tear down any previous renderer before (re)attaching.
    if (rendererRef.current) {
      rendererRef.current.dispose()
      rendererRef.current = null
    }
    canvasRef.current = canvas
    if (canvas) {
      initRendererFor(canvas)
    }
  }, [initRendererFor])

  // Update mode when settings change
  useEffect(() => {
    if (rendererRef.current) {
      rendererRef.current.setMode(webglComparisonSettings.mode)
    }
  }, [webglComparisonSettings.mode])

  // Handle resize. The container is mounted in both the empty and ready
  // states, so observing it (with a renderer-null guard) keeps resize working
  // even though the canvas appears only after media is added.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return

      const { width, height } = entry.contentRect

      // Validate dimensions before setting
      if (width <= 0 || height <= 0) {
        return
      }

      // Round to integers
      const w = Math.round(width)
      const h = Math.round(height)

      if (rendererRef.current) {
        rendererRef.current.resize(w, h)
      } else if (canvasRef.current) {
        // Renderer not initialized yet: just keep the canvas backing size sane.
        canvasRef.current.width = Math.max(w, 100)
        canvasRef.current.height = Math.max(h, 100)
      }
    })

    resizeObserver.observe(container)
    return () => resizeObserver.disconnect()
  }, [])

  // Identity of the source most recently uploaded into each WebGL texture.
  // When the logical slot's source changes before the new source is ready,
  // the texture is explicitly cleared so a decoded frame from the previous
  // source can never remain visible as the current texture.
  const uploadedSourceIdRef = useRef<{ a: string; b: string }>({ a: '', b: '' })

  // Render loop - the flip mapping from useWebGLSourceMapping is the single
  // authority deciding which physical element feeds texture A/B.
  const render = useCallback(() => {
    const renderer = rendererRef.current
    if (!renderer) {
      animationRef.current = requestAnimationFrame(render)
      return
    }

    // Always read the freshest mapping (flip/clip/url changes included).
    const mapping = mappingRef.current
    const slotA = mapping.slots.a
    const slotB = mapping.slots.b

    // --- Texture A: upload only the current, ready source ---------------
    if (slotA.media && slotA.ready && slotA.element) {
      renderer.updateTexture('A', slotA.element)
      uploadedSourceIdRef.current.a = slotA.sourceId
    } else if (
      // Source changed (or vanished) and the new one is not sampleable yet:
      // neutralize the texture instead of leaving the previous frame on it.
      uploadedSourceIdRef.current.a !== slotA.sourceId
    ) {
      renderer.clearTexture('A')
      uploadedSourceIdRef.current.a = slotA.sourceId
    }

    // --- Texture B -------------------------------------------------------
    if (slotB.media && slotB.ready && slotB.element) {
      renderer.updateTexture('B', slotB.element)
      uploadedSourceIdRef.current.b = slotB.sourceId
    } else if (uploadedSourceIdRef.current.b !== slotB.sourceId) {
      renderer.clearTexture('B')
      uploadedSourceIdRef.current.b = slotB.sourceId
    }

    // Get media dimensions for aspect ratio correction
    let textureAWidth = 1920, textureAHeight = 1080
    let textureBWidth = 1920, textureBHeight = 1080

    if (slotA.kind === 'video' && slotA.element instanceof HTMLVideoElement) {
      textureAWidth = slotA.element.videoWidth || 1920
      textureAHeight = slotA.element.videoHeight || 1080
    } else if (slotA.kind === 'image' && slotA.element instanceof HTMLImageElement) {
      textureAWidth = slotA.element.naturalWidth || 1920
      textureAHeight = slotA.element.naturalHeight || 1080
    } else if (slotA.media?.width && slotA.media?.height) {
      textureAWidth = slotA.media.width
      textureAHeight = slotA.media.height
    }

    if (slotB.kind === 'video' && slotB.element instanceof HTMLVideoElement) {
      textureBWidth = slotB.element.videoWidth || 1920
      textureBHeight = slotB.element.videoHeight || 1080
    } else if (slotB.kind === 'image' && slotB.element instanceof HTMLImageElement) {
      textureBWidth = slotB.element.naturalWidth || 1920
      textureBHeight = slotB.element.naturalHeight || 1080
    } else if (slotB.media?.width && slotB.media?.height) {
      textureBWidth = slotB.media.width
      textureBHeight = slotB.media.height
    }

    // Render with current settings (read fresh from store)
    const settings = useProjectStore.getState().webglComparisonSettings
    renderer.render({
      amplification: settings.amplification,
      threshold: settings.threshold,
      opacity: settings.opacity,
      blockSize: settings.blockSize,
      loupeSize: settings.loupeSize,
      loupeZoom: settings.loupeZoom,
      checkerSize: settings.checkerSize,
      mouseX: mousePos.x,
      mouseY: mousePos.y,
      textureAWidth,
      textureAHeight,
      textureBWidth,
      textureBHeight
    })

    // Continue animation loop
    animationRef.current = requestAnimationFrame(render)
  }, [mousePos])

  // Start render loop
  useEffect(() => {
    animationRef.current = requestAnimationFrame(render)

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [render])

  // WEBGL-001: Compute metrics periodically (every 500ms).
  // Metrics consume the exact same flip mapping as the renderer and cursor
  // inspector. While either mapped source is not yet sampleable (media switch
  // or clip change), the overlay is marked unavailable and no stale metrics
  // are refreshed. The last valid values remain in the store otherwise.
  const [metricsUnavailable, setMetricsUnavailable] = useState(false)
  const lastMetricsSourceKeyRef = useRef<string>('')

  useEffect(() => {
    if (!webglComparisonSettings.showMetricsOverlay) {
      return
    }

    const computeMetrics = () => {
      const now = Date.now()
      // Only compute every 500ms to avoid performance issues
      if (now - lastMetricsTimeRef.current < 500) {
        metricsTimerRef.current = requestAnimationFrame(computeMetrics)
        return
      }
      lastMetricsTimeRef.current = now

      // Single mapping authority — same sources as render & cursor picking
      const mapping = mappingRef.current
      const slotA = mapping.slots.a
      const slotB = mapping.slots.b

      const canSample =
        slotA.media !== null &&
        slotB.media !== null &&
        slotA.ready &&
        slotB.ready &&
        slotA.element !== null &&
        slotB.element !== null

      if (!canSample || !canvasRef.current) {
        // New source pair not ready yet: keep the previous valid results but
        // show them as unavailable; never refresh the overlay from old sources.
        if (lastMetricsSourceKeyRef.current !== mapping.sourcePairKey) {
          setMetricsUnavailable(true)
        }
        metricsTimerRef.current = requestAnimationFrame(computeMetrics)
        return
      }

      const sourceA = slotA.element
      const sourceB = slotB.element
      // Obtain the GL context from the canvas directly rather than holding a
      // dependency on the renderer instance: metric computation draws its own
      // 2D canvases and only needs a live context, so it must not be blocked
      // by renderer (re)initialization lifecycle.
      const gl =
        canvasRef.current.getContext('webgl') ||
        canvasRef.current.getContext('webgl2')
      if (gl && sourceA && sourceB) {
        try {
          const metrics = computeMetricsFromWebGLCanvas(
            gl,
            canvasRef.current?.width || 640,
            canvasRef.current?.height || 480,
            sourceA,
            sourceB,
            Math.round(webglComparisonSettings.threshold * 255),
            webglComparisonSettings.roi // WEBGL-004: ROI in normalized source coords (flip-stable)
          )
          // A null result means a transient 2D-context failure: keep the last
          // valid metrics and retry next tick rather than storing zeros.
          if (metrics) {
            lastMetricsSourceKeyRef.current = mapping.sourcePairKey
            setMetricsUnavailable(false)
            setWebGLAnalysisMetrics(metrics)
          }
        } catch (err) {
          // A transient draw failure must not kill the polling loop; keep the
          // previous valid metrics and retry on the next tick.
          console.error('[WebGL] Metrics computation failed:', err)
        }
      }

      metricsTimerRef.current = requestAnimationFrame(computeMetrics)
    }

    metricsTimerRef.current = requestAnimationFrame(computeMetrics)

    return () => {
      if (metricsTimerRef.current) {
        cancelAnimationFrame(metricsTimerRef.current)
      }
    }
  }, [webglComparisonSettings.showMetricsOverlay, webglComparisonSettings.threshold, webglComparisonSettings.roi, setWebGLAnalysisMetrics])

  // Handle mouse move for interactive modes
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const y = 1.0 - (e.clientY - rect.top) / rect.height // Flip Y for WebGL
    const yScreen = (e.clientY - rect.top) / rect.height // Normal Y for ROI
    setMousePos({ x, y })
    setScreenMousePos({ x: e.clientX - rect.left, y: e.clientY - rect.top })

    // WEBGL-004: Handle ROI drawing
    if (isDrawingROI) {
      const roiX = Math.min(roiStart.x, x)
      const roiY = Math.min(roiStart.y, yScreen)
      const roiWidth = Math.abs(x - roiStart.x)
      const roiHeight = Math.abs(yScreen - roiStart.y)
      setTempROI({ x: roiX, y: roiY, width: roiWidth, height: roiHeight })
      return
    }

    // WEBGL-007: Handle pan dragging
    if (isDragging && webglComparisonSettings.webglZoom > 1) {
      const dx = (e.clientX - dragStart.x) / rect.width
      const dy = (e.clientY - dragStart.y) / rect.height
      setWebGLPan(
        webglComparisonSettings.webglPanX + dx * 2,
        webglComparisonSettings.webglPanY - dy * 2
      )
      setDragStart({ x: e.clientX, y: e.clientY })
    }

    // WEBGL-003: Sample pixel values at cursor position.
    // Uses the same flip mapping as the renderer and metrics, and only
    // samples sources that are ready for their current media identity.
    if (webglComparisonSettings.showCursorInspector) {
      const mapping = mappingRef.current
      const slotA = mapping.slots.a
      const slotB = mapping.slots.b

      if (!slotA.ready || !slotB.ready || !slotA.element || !slotB.element) {
        // Sources switching: do not sample stale pixels from old media
        setCursorPixelInfo({ a: null, b: null })
      } else {
        const sampleCanvas = document.createElement('canvas')
        sampleCanvas.width = 1
        sampleCanvas.height = 1
        const ctx = sampleCanvas.getContext('2d')

        if (ctx) {
          let pixelA: { r: number; g: number; b: number } | null = null
          let pixelB: { r: number; g: number; b: number } | null = null

          // Sample from logical source A (post-flip mapping)
          const sourceA = slotA.element
          const srcWidthA = 'videoWidth' in sourceA ? sourceA.videoWidth : sourceA.naturalWidth
          const srcHeightA = 'videoHeight' in sourceA ? sourceA.videoHeight : sourceA.naturalHeight
          ctx.drawImage(sourceA, x * srcWidthA, (1 - y) * srcHeightA, 1, 1, 0, 0, 1, 1)
          const dataA = ctx.getImageData(0, 0, 1, 1).data
          pixelA = { r: dataA[0], g: dataA[1], b: dataA[2] }

          // Sample from logical source B (post-flip mapping)
          const sourceB = slotB.element
          const srcWidthB = 'videoWidth' in sourceB ? sourceB.videoWidth : sourceB.naturalWidth
          const srcHeightB = 'videoHeight' in sourceB ? sourceB.videoHeight : sourceB.naturalHeight
          ctx.drawImage(sourceB, x * srcWidthB, (1 - y) * srcHeightB, 1, 1, 0, 0, 1, 1)
          const dataB = ctx.getImageData(0, 0, 1, 1).data
          pixelB = { r: dataB[0], g: dataB[1], b: dataB[2] }

          setCursorPixelInfo({ a: pixelA, b: pixelB })
        }
      }
    }
  }, [isDragging, dragStart, isDrawingROI, roiStart, webglComparisonSettings.webglZoom, webglComparisonSettings.webglPanX, webglComparisonSettings.webglPanY, webglComparisonSettings.showCursorInspector, setWebGLPan])

  // WEBGL-007: Handle mouse wheel for zoom
  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.5 : 0.5
    setWebGLZoom(webglComparisonSettings.webglZoom + delta)
  }, [webglComparisonSettings.webglZoom, setWebGLZoom])

  // WEBGL-007: Handle mouse down for pan / WEBGL-004: Handle mouse down for ROI
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const y = (e.clientY - rect.top) / rect.height

    // WEBGL-004: Start ROI drawing if ROI controls are enabled
    if (webglComparisonSettings.showROIControls) {
      setIsDrawingROI(true)
      setROIStart({ x, y })
      setTempROI({ x, y, width: 0, height: 0 })
      return
    }

    // WEBGL-007: Start panning if zoomed
    if (webglComparisonSettings.webglZoom > 1) {
      setIsDragging(true)
      setDragStart({ x: e.clientX, y: e.clientY })
    }
  }, [webglComparisonSettings.webglZoom, webglComparisonSettings.showROIControls])

  // WEBGL-007: Handle mouse up / WEBGL-004: Commit ROI
  const handleMouseUp = useCallback(() => {
    // WEBGL-004: Commit ROI if drawing
    if (isDrawingROI && tempROI) {
      // Only set ROI if it has a reasonable size (more than 1% in each dimension)
      if (tempROI.width > 0.01 && tempROI.height > 0.01) {
        setROI(tempROI)
      }
      setIsDrawingROI(false)
      setTempROI(null)
      return
    }

    setIsDragging(false)
  }, [isDrawingROI, tempROI, setROI])

  // WEBGL-007: Handle double click to reset zoom
  const handleDoubleClick = useCallback(() => {
    resetWebGLZoom()
  }, [resetWebGLZoom])

  // SCOPE-010: Handle G key for gamut warning toggle
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return
      }

      if (e.code === 'KeyG' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault()
        setShowGamutWarning(prev => !prev)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // WEBGL-005: Export Analysis Screenshot
  const exportScreenshot = useCallback(async (copyToClipboard: boolean = false) => {
    if (!canvasRef.current || !containerRef.current) return

    // Create a canvas that includes the WebGL content and overlays
    const exportCanvas = document.createElement('canvas')
    const scale = 2 // 2x resolution for quality
    const width = containerRef.current.offsetWidth * scale
    const height = containerRef.current.offsetHeight * scale
    exportCanvas.width = width
    exportCanvas.height = height

    const ctx = exportCanvas.getContext('2d')
    if (!ctx) return

    // Draw the WebGL canvas
    ctx.drawImage(canvasRef.current, 0, 0, width, height)

    // Get mode info for label
    const currentModeInfo = getComparisonModeInfo(webglComparisonSettings.mode)

    // Draw mode indicator
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)'
    ctx.fillRect(16 * scale, 16 * scale, 200 * scale, 30 * scale)
    ctx.fillStyle = '#888888'
    ctx.font = `${14 * scale}px system-ui`
    ctx.fillText('Mode: ', 24 * scale, 36 * scale)
    ctx.fillStyle = '#cddc39'
    ctx.fillText(currentModeInfo?.label || webglComparisonSettings.mode, 70 * scale, 36 * scale)

    // Draw metrics if visible
    if (webglComparisonSettings.showMetricsOverlay && webglAnalysisMetrics) {
      const metricsX = width - 200 * scale
      ctx.fillStyle = 'rgba(0, 0, 0, 0.8)'
      ctx.fillRect(metricsX, 16 * scale, 180 * scale, 140 * scale)

      ctx.fillStyle = '#888888'
      ctx.font = `bold ${10 * scale}px system-ui`
      ctx.fillText('ANALYSIS METRICS', metricsX + 16 * scale, 36 * scale)

      ctx.font = `${12 * scale}px monospace`
      const metrics = [
        { label: 'SSIM:', value: webglAnalysisMetrics.ssim.toFixed(4) },
        { label: 'Delta E:', value: webglAnalysisMetrics.deltaE.toFixed(2) },
        { label: 'Diff Pixels:', value: `${webglAnalysisMetrics.diffPixelPercent.toFixed(1)}%` },
        { label: 'Peak Diff:', value: webglAnalysisMetrics.peakDifference.toFixed(0) },
        { label: 'Mean Diff:', value: webglAnalysisMetrics.meanDifference.toFixed(1) }
      ]

      metrics.forEach((m, i) => {
        ctx.fillStyle = '#888888'
        ctx.fillText(m.label, metricsX + 16 * scale, (56 + i * 20) * scale)
        ctx.fillStyle = '#ffffff'
        ctx.fillText(m.value, metricsX + 100 * scale, (56 + i * 20) * scale)
      })
    }

    // Draw timestamp
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)'
    ctx.fillRect(16 * scale, height - 46 * scale, 250 * scale, 30 * scale)
    ctx.fillStyle = '#888888'
    ctx.font = `${12 * scale}px system-ui`
    ctx.fillText(`DualView Analysis • ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`, 24 * scale, height - 26 * scale)

    // Export
    if (copyToClipboard) {
      try {
        const blob = await new Promise<Blob | null>((resolve) => {
          exportCanvas.toBlob(resolve, 'image/png')
        })
        if (blob) {
          await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': blob })
          ])
        }
      } catch (err) {
        console.error('Failed to copy to clipboard:', err)
      }
    } else {
      const link = document.createElement('a')
      link.download = `dualview-analysis-${webglComparisonSettings.mode}-${Date.now()}.png`
      link.href = exportCanvas.toDataURL('image/png')
      // Attach before clicking so the navigation/download is not suppressed.
      document.body.appendChild(link)
      link.click()
      link.remove()
    }
  }, [webglComparisonSettings, webglAnalysisMetrics])

  // WEBGL-010: Export PDF Analysis Report
  const exportPDFReport = useCallback(async () => {
    if (!canvasRef.current) return

    // Get mode info for the report
    const currentModeInfo = getComparisonModeInfo(webglComparisonSettings.mode)

    // Capture screenshot for the PDF
    const screenshotBlob = await captureCanvasScreenshot(canvasRef.current, 'png')
    if (!screenshotBlob) return

    // Format file size helper
    const formatSize = (bytes?: number) => {
      if (!bytes) return 'Unknown'
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }

    // Generate PDF
    const pdfBlob = await generatePDFReport({
      title: 'DualView WebGL Analysis Report',
      includeMetadata: true,
      includeAnnotations: false,
      includeSettings: true,
      screenshotBlob,
      comparisonMode: 'webgl-compare',
      webglMode: currentModeInfo?.label || webglComparisonSettings.mode,
      threshold: webglComparisonSettings.threshold,
      mediaA: mediaA ? {
        name: mediaA.name,
        type: mediaA.type,
        size: formatSize(mediaA.file?.size),
        dimensions: mediaA.width && mediaA.height ? `${mediaA.width}×${mediaA.height}` : undefined
      } : undefined,
      mediaB: mediaB ? {
        name: mediaB.name,
        type: mediaB.type,
        size: formatSize(mediaB.file?.size),
        dimensions: mediaB.width && mediaB.height ? `${mediaB.width}×${mediaB.height}` : undefined
      } : undefined,
      webglMetrics: webglAnalysisMetrics ? {
        ssim: webglAnalysisMetrics.ssim,
        deltaE: webglAnalysisMetrics.deltaE,
        diffPixelPercent: webglAnalysisMetrics.diffPixelPercent,
        peakDifference: webglAnalysisMetrics.peakDifference,
        meanDifference: webglAnalysisMetrics.meanDifference,
        passPixelCount: webglAnalysisMetrics.passPixelCount,
        failPixelCount: webglAnalysisMetrics.failPixelCount,
        totalPixelCount: webglAnalysisMetrics.totalPixelCount
      } : undefined
    })

    // Download
    downloadBlob(pdfBlob, `dualview-analysis-report-${Date.now()}.pdf`)
  }, [webglComparisonSettings, webglAnalysisMetrics, mediaA, mediaB])

  // Handle file upload for empty state
  const handleUpload = useCallback(async (files: FileList | null, targetTrack: 'a' | 'b') => {
    if (!files || files.length === 0) return

    const file = files[0]
    try {
      const mediaFile = await addFile(file)
      // Get fresh track references from the store to avoid stale closures
      const currentTracks = useTimelineStore.getState().tracks
      const track = currentTracks.find(t => t.type === targetTrack)

      if (track) {
        const duration = mediaFile.duration || 10
        addClip(track.id, mediaFile.id, 0, duration)
      }
    } catch (error) {
      console.error('Failed to upload media:', error)
    }
  }, [addFile, addClip])

  // Trigger file input
  const triggerUpload = useCallback((track: 'a' | 'b') => {
    currentUploadTarget.current = { track }
    if (fileInputRef.current) {
      fileInputRef.current.click()
    }
  }, [])

  // Handle file input change
  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (currentUploadTarget.current) {
      handleUpload(e.target.files, currentUploadTarget.current.track)
      e.target.value = '' // Reset for re-upload
    }
  }, [handleUpload])

  // Get current mode info
  const modeInfo = getComparisonModeInfo(webglComparisonSettings.mode)

  if (!isSupported) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-[#1a1a1a]">
        <div className="text-center p-8">
          <div className="text-4xl mb-4">⚠️</div>
          <h3 className="text-xl font-bold text-white mb-2">WebGL Not Supported</h3>
          <p className="text-gray-400">
            Your browser doesn't support WebGL, which is required for GPU-accelerated comparison modes.
          </p>
          <p className="text-gray-500 mt-2 text-sm">
            Try using a modern browser like Chrome, Firefox, or Edge.
          </p>
        </div>
      </div>
    )
  }

  if (!mediaA && !mediaB) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-[#1a1a1a] p-4">
        <div className="text-center max-w-2xl w-full">
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*"
            className="hidden"
            onChange={handleFileChange}
          />

          <h2 className="text-lg font-semibold text-white mb-1">Difference Mode</h2>
          <p className="text-xs text-gray-400 mb-4">
            Upload images or videos to compare with advanced analysis
          </p>

          {/* Upload sections for Track A and Track B */}
          <div className="grid grid-cols-2 gap-4">
            {/* Track A Upload */}
            <div className="p-3 bg-[#252525] border border-orange-500/30">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-6 h-6 bg-orange-500/20 flex items-center justify-center">
                  <span className="text-orange-400 font-bold text-xs">A</span>
                </div>
                <span className="text-sm font-medium text-orange-400">Media A</span>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  onClick={() => triggerUpload('a')}
                  className="flex flex-col items-center gap-1 p-3 border border-blue-500/30 bg-blue-500/10 hover:bg-blue-500/20 transition-all"
                >
                  <Image className="w-5 h-5 text-blue-400" />
                  <span className="text-[10px] font-medium text-blue-400">Image</span>
                </button>
                <button
                  onClick={() => triggerUpload('a')}
                  className="flex flex-col items-center gap-1 p-3 border border-purple-500/30 bg-purple-500/10 hover:bg-purple-500/20 transition-all"
                >
                  <Video className="w-5 h-5 text-purple-400" />
                  <span className="text-[10px] font-medium text-purple-400">Video</span>
                </button>
              </div>
            </div>

            {/* Track B Upload */}
            <div className="p-3 bg-[#252525] border border-lime-400/30">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-6 h-6 bg-lime-400/20 flex items-center justify-center">
                  <span className="text-lime-400 font-bold text-xs">B</span>
                </div>
                <span className="text-sm font-medium text-lime-400">Media B</span>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  onClick={() => triggerUpload('b')}
                  className="flex flex-col items-center gap-1 p-3 border border-blue-500/30 bg-blue-500/10 hover:bg-blue-500/20 transition-all"
                >
                  <Image className="w-5 h-5 text-blue-400" />
                  <span className="text-[10px] font-medium text-blue-400">Image</span>
                </button>
                <button
                  onClick={() => triggerUpload('b')}
                  className="flex flex-col items-center gap-1 p-3 border border-purple-500/30 bg-purple-500/10 hover:bg-purple-500/20 transition-all"
                >
                  <Video className="w-5 h-5 text-purple-400" />
                  <span className="text-[10px] font-medium text-purple-400">Video</span>
                </button>
              </div>
            </div>
          </div>

          <p className="text-[10px] text-gray-500 mt-3">
            Current mode: <span className="text-[#cddc39]">{modeInfo?.label || webglComparisonSettings.mode}</span>
          </p>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="w-full h-full relative bg-black overflow-hidden"
      onMouseMove={handleMouseMove}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onDoubleClick={handleDoubleClick}
      style={{ cursor: isDrawingROI ? 'crosshair' : webglComparisonSettings.showROIControls ? 'crosshair' : isDragging ? 'grabbing' : webglComparisonSettings.webglZoom > 1 ? 'grab' : 'default' }}
    >
      {/* Video elements for texture sources - STABLE sources, never swapped by flipAB */}
      <video
        ref={sourceMapping.elementRefs.videoA}
        src={stableMediaA?.type === 'video' ? stableMediaA.url : undefined}
        style={{ position: 'absolute', width: '1px', height: '1px', opacity: 0, pointerEvents: 'none', zIndex: -1 }}
        muted
        playsInline
        loop
        preload="auto"
      />
      <video
        ref={sourceMapping.elementRefs.videoB}
        src={stableMediaB?.type === 'video' ? stableMediaB.url : undefined}
        style={{ position: 'absolute', width: '1px', height: '1px', opacity: 0, pointerEvents: 'none', zIndex: -1 }}
        muted
        playsInline
        loop
        preload="auto"
      />

      {/* Hidden image elements for texture sources - STABLE physical sources */}
      {stableMediaA?.type === 'image' && (
        <img
          ref={sourceMapping.elementRefs.imageA}
          src={stableMediaA.url}
          className="hidden"
          onLoad={sourceMapping.imageEventHandlers.a.onLoad}
          onError={sourceMapping.imageEventHandlers.a.onError}
          alt=""
        />
      )}
      {stableMediaB?.type === 'image' && (
        <img
          ref={sourceMapping.elementRefs.imageB}
          src={stableMediaB.url}
          className="hidden"
          onLoad={sourceMapping.imageEventHandlers.b.onLoad}
          onError={sourceMapping.imageEventHandlers.b.onError}
          alt=""
        />
      )}

      {/* WebGL Canvas */}
      <canvas
        ref={setCanvasRef}
        className="w-full h-full"
        style={{
          minWidth: '640px',
          minHeight: '480px',
          transform: `scale(${webglComparisonSettings.webglZoom}) translate(${webglComparisonSettings.webglPanX * 50 / webglComparisonSettings.webglZoom}%, ${-webglComparisonSettings.webglPanY * 50 / webglComparisonSettings.webglZoom}%)`,
          transformOrigin: 'center center'
        }}
      />

      {/* Mode indicator */}
      <div className="absolute top-4 left-4 bg-black/70 px-3 py-1.5 rounded text-sm">
        <span className="text-gray-400">Mode:</span>
        <span className="text-[#cddc39] ml-2 font-medium">{modeInfo?.label || webglComparisonSettings.mode}</span>
        {webglComparisonSettings.flipAB && (
          <span className="text-orange-400 ml-2">(A/B Flipped)</span>
        )}
      </div>

      {/* WEBGL-001: Metrics Overlay */}
      {webglComparisonSettings.showMetricsOverlay && webglAnalysisMetrics && (
        <div className="absolute top-4 right-4 bg-black/80 px-4 py-3 rounded text-sm font-mono">
          <div className="text-gray-300 font-semibold mb-2 text-xs uppercase tracking-wider">Analysis Metrics</div>
          {metricsUnavailable ? (
            <div className="text-yellow-400 text-xs py-2 pr-2">
              Sources not ready — waiting for new media to become sampleable
            </div>
          ) : (
          <div className="space-y-1">
            <div className="flex justify-between gap-4">
              <span className="text-gray-400">SSIM:</span>
              <span className={`font-medium ${webglAnalysisMetrics.ssim > 0.95 ? 'text-green-400' : webglAnalysisMetrics.ssim > 0.8 ? 'text-yellow-400' : 'text-red-400'}`}>
                {webglAnalysisMetrics.ssim.toFixed(4)}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-gray-400">Delta E:</span>
              <span className={`font-medium ${webglAnalysisMetrics.deltaE < 1 ? 'text-green-400' : webglAnalysisMetrics.deltaE < 5 ? 'text-yellow-400' : 'text-red-400'}`}>
                {webglAnalysisMetrics.deltaE.toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-gray-400">Diff Pixels:</span>
              <span className={`font-medium ${webglAnalysisMetrics.diffPixelPercent < 1 ? 'text-green-400' : webglAnalysisMetrics.diffPixelPercent < 10 ? 'text-yellow-400' : 'text-red-400'}`}>
                {webglAnalysisMetrics.diffPixelPercent.toFixed(1)}%
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-gray-400">Peak Diff:</span>
              <span className="text-gray-200 font-medium">{webglAnalysisMetrics.peakDifference.toFixed(0)}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-gray-400">Mean Diff:</span>
              <span className="text-gray-200 font-medium">{webglAnalysisMetrics.meanDifference.toFixed(1)}</span>
            </div>
            {/* WEBGL-006: Threshold Pass/Fail Stats */}
            <div className="border-t border-gray-600 mt-2 pt-2">
              <div className="flex justify-between gap-4">
                <span className="text-gray-400">Pass:</span>
                <span className="text-green-400 font-medium">
                  {webglAnalysisMetrics.passPixelCount.toLocaleString()} ({((webglAnalysisMetrics.passPixelCount / webglAnalysisMetrics.totalPixelCount) * 100).toFixed(1)}%)
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-gray-400">Fail:</span>
                <span className="text-red-400 font-medium">
                  {webglAnalysisMetrics.failPixelCount.toLocaleString()} ({((webglAnalysisMetrics.failPixelCount / webglAnalysisMetrics.totalPixelCount) * 100).toFixed(1)}%)
                </span>
              </div>
            </div>
          </div>
          )}
        </div>
      )}

      {/* WEBGL-002: Scale Bar */}
      {webglComparisonSettings.showScaleBar && (
        <div className={`absolute ${
          webglComparisonSettings.scaleBarPosition === 'top' ? 'top-16 left-1/2 -translate-x-1/2' :
          webglComparisonSettings.scaleBarPosition === 'bottom' ? 'bottom-16 left-1/2 -translate-x-1/2' :
          webglComparisonSettings.scaleBarPosition === 'left' ? 'left-4 top-1/2 -translate-y-1/2' :
          'right-4 top-1/2 -translate-y-1/2'
        } bg-black/70 p-2 rounded`}>
          {(webglComparisonSettings.scaleBarPosition === 'top' || webglComparisonSettings.scaleBarPosition === 'bottom') ? (
            <div className="flex flex-col items-center">
              <div className="w-48 h-4 rounded" style={{
                background: 'linear-gradient(to right, #000000, #ff0000, #ffff00, #ffffff)'
              }} />
              <div className="flex justify-between w-48 text-xs text-gray-400 mt-1">
                <span>0</span>
                <span>Low</span>
                <span>Mid</span>
                <span>High</span>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div className="w-4 h-48 rounded" style={{
                background: 'linear-gradient(to top, #000000, #ff0000, #ffff00, #ffffff)'
              }} />
              <div className="flex flex-col justify-between h-48 text-xs text-gray-400">
                <span>High</span>
                <span>Mid</span>
                <span>Low</span>
                <span>0</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* WEBGL-007: Zoom indicator */}
      {webglComparisonSettings.webglZoom > 1 && (
        <div className="absolute top-14 left-4 bg-black/70 px-2 py-1 rounded text-xs text-gray-400">
          Zoom: {webglComparisonSettings.webglZoom.toFixed(1)}x • Double-click to reset
        </div>
      )}

      {/* Source readiness indicator: shown while a current source is not yet
          sampleable, so no stale frame/metric can be mistaken for live data */}
      {(mappedSlots.a.media || mappedSlots.b.media) && !sourcesReady && (
        <div className="absolute bottom-14 left-1/2 -translate-x-1/2 bg-yellow-500/90 text-black px-3 py-1.5 rounded text-xs font-medium flex items-center gap-2 z-40">
          <span className="inline-block w-2 h-2 rounded-full bg-black animate-pulse" />
          Loading new sources — previous results retained until sampling is available
        </div>
      )}

      {/* WEBGL-003: Cursor Value Inspector */}
      {webglComparisonSettings.showCursorInspector && cursorPixelInfo.a && cursorPixelInfo.b && (
        <div
          className="absolute pointer-events-none bg-black/90 px-3 py-2 rounded text-xs font-mono z-50"
          style={{
            left: Math.min(screenMousePos.x + 20, (containerRef.current?.offsetWidth || 400) - 180),
            top: Math.min(screenMousePos.y + 20, (containerRef.current?.offsetHeight || 300) - 120)
          }}
        >
          <div className="text-gray-300 font-semibold mb-1">Pixel Inspector</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
            <div className="text-gray-500">Source A:</div>
            <div className="flex items-center gap-1">
              <span style={{ color: `rgb(${cursorPixelInfo.a.r}, 100, 100)` }}>{cursorPixelInfo.a.r}</span>
              <span style={{ color: `rgb(100, ${cursorPixelInfo.a.g}, 100)` }}>{cursorPixelInfo.a.g}</span>
              <span style={{ color: `rgb(100, 100, ${cursorPixelInfo.a.b})` }}>{cursorPixelInfo.a.b}</span>
              <span
                className="w-3 h-3 rounded-sm ml-1"
                style={{ backgroundColor: `rgb(${cursorPixelInfo.a.r}, ${cursorPixelInfo.a.g}, ${cursorPixelInfo.a.b})` }}
              />
            </div>
            <div className="text-gray-500">Source B:</div>
            <div className="flex items-center gap-1">
              <span style={{ color: `rgb(${cursorPixelInfo.b.r}, 100, 100)` }}>{cursorPixelInfo.b.r}</span>
              <span style={{ color: `rgb(100, ${cursorPixelInfo.b.g}, 100)` }}>{cursorPixelInfo.b.g}</span>
              <span style={{ color: `rgb(100, 100, ${cursorPixelInfo.b.b})` }}>{cursorPixelInfo.b.b}</span>
              <span
                className="w-3 h-3 rounded-sm ml-1"
                style={{ backgroundColor: `rgb(${cursorPixelInfo.b.r}, ${cursorPixelInfo.b.g}, ${cursorPixelInfo.b.b})` }}
              />
            </div>
            <div className="text-gray-500">Diff:</div>
            <div className="text-orange-400">
              {Math.abs(cursorPixelInfo.a.r - cursorPixelInfo.b.r)} {Math.abs(cursorPixelInfo.a.g - cursorPixelInfo.b.g)} {Math.abs(cursorPixelInfo.a.b - cursorPixelInfo.b.b)}
            </div>
          </div>
        </div>
      )}

      {/* WEBGL-004: ROI Overlay */}
      {(webglComparisonSettings.roi || tempROI) && (
        <div
          className="absolute border-2 border-[#ff5722] pointer-events-none"
          style={{
            left: `${((tempROI || webglComparisonSettings.roi)!.x) * 100}%`,
            top: `${((tempROI || webglComparisonSettings.roi)!.y) * 100}%`,
            width: `${((tempROI || webglComparisonSettings.roi)!.width) * 100}%`,
            height: `${((tempROI || webglComparisonSettings.roi)!.height) * 100}%`,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.5)'
          }}
        >
          {/* ROI corner handles */}
          <div className="absolute -top-1 -left-1 w-3 h-3 bg-[#ff5722] rounded-sm" />
          <div className="absolute -top-1 -right-1 w-3 h-3 bg-[#ff5722] rounded-sm" />
          <div className="absolute -bottom-1 -left-1 w-3 h-3 bg-[#ff5722] rounded-sm" />
          <div className="absolute -bottom-1 -right-1 w-3 h-3 bg-[#ff5722] rounded-sm" />
          {/* ROI label */}
          {!tempROI && (
            <div className="absolute -top-6 left-0 bg-[#ff5722] text-white text-xs px-2 py-0.5 rounded whitespace-nowrap">
              ROI: {(webglComparisonSettings.roi!.width * 100).toFixed(0)}% × {(webglComparisonSettings.roi!.height * 100).toFixed(0)}%
            </div>
          )}
        </div>
      )}

      {/* WEBGL-004: ROI Drawing Mode Indicator */}
      {webglComparisonSettings.showROIControls && !webglComparisonSettings.roi && !tempROI && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="bg-black/70 px-4 py-2 rounded text-white text-sm">
            Click and drag to select a region of interest
          </div>
        </div>
      )}

      {/* Control buttons */}
      <div className="absolute top-4 right-4 flex gap-1" style={{ right: webglComparisonSettings.showMetricsOverlay ? '220px' : '16px' }}>
        {/* WEBGL-001: Toggle Metrics */}
        <button
          onClick={toggleWebGLMetricsOverlay}
          className={`p-2 rounded transition-colors ${webglComparisonSettings.showMetricsOverlay ? 'bg-[#ff5722] text-white' : 'bg-black/70 text-gray-400 hover:text-white'}`}
          title="Toggle Metrics Overlay (WEBGL-001)"
        >
          <BarChart3 size={16} />
        </button>

        {/* WEBGL-002: Toggle Scale Bar */}
        <button
          onClick={toggleWebGLScaleBar}
          className={`p-2 rounded transition-colors ${webglComparisonSettings.showScaleBar ? 'bg-[#ff5722] text-white' : 'bg-black/70 text-gray-400 hover:text-white'}`}
          title="Toggle Scale Bar (WEBGL-002)"
        >
          <Ruler size={16} />
        </button>

        {/* WEBGL-003: Toggle Cursor Inspector */}
        <button
          onClick={toggleWebGLCursorInspector}
          className={`p-2 rounded transition-colors ${webglComparisonSettings.showCursorInspector ? 'bg-[#ff5722] text-white' : 'bg-black/70 text-gray-400 hover:text-white'}`}
          title="Toggle Cursor Inspector (WEBGL-003)"
        >
          <Crosshair size={16} />
        </button>

        {/* WEBGL-004: ROI Selection */}
        <button
          onClick={toggleROIControls}
          className={`p-2 rounded transition-colors ${webglComparisonSettings.showROIControls ? 'bg-[#ff5722] text-white' : 'bg-black/70 text-gray-400 hover:text-white'}`}
          title="Draw ROI Selection (WEBGL-004)"
        >
          <Scan size={16} />
        </button>
        {webglComparisonSettings.roi && (
          <button
            onClick={clearROI}
            className="p-2 rounded bg-black/70 text-red-400 hover:text-red-300 transition-colors"
            title="Clear ROI Selection"
          >
            <X size={16} />
          </button>
        )}

        {/* WEBGL-008: Flip A/B */}
        <button
          onClick={toggleWebGLFlipAB}
          className={`p-2 rounded transition-colors ${webglComparisonSettings.flipAB ? 'bg-[#ff5722] text-white' : 'bg-black/70 text-gray-400 hover:text-white'}`}
          title="Flip A/B Sources (F)"
        >
          <FlipHorizontal size={16} />
        </button>

        {/* WEBGL-007: Zoom controls */}
        <button
          onClick={() => setWebGLZoom(webglComparisonSettings.webglZoom + 1)}
          className="p-2 rounded bg-black/70 text-gray-400 hover:text-white transition-colors"
          title="Zoom In"
        >
          <ZoomIn size={16} />
        </button>
        <button
          onClick={() => setWebGLZoom(webglComparisonSettings.webglZoom - 1)}
          className="p-2 rounded bg-black/70 text-gray-400 hover:text-white transition-colors"
          disabled={webglComparisonSettings.webglZoom <= 1}
          title="Zoom Out"
        >
          <ZoomOut size={16} />
        </button>
        <button
          onClick={resetWebGLZoom}
          className="p-2 rounded bg-black/70 text-gray-400 hover:text-white transition-colors"
          title="Reset Zoom"
        >
          <RotateCcw size={16} />
        </button>

        {/* Separator */}
        <div className="w-px h-6 bg-gray-600 mx-1" />

        {/* WEBGL-005: Screenshot Export */}
        <button
          onClick={() => exportScreenshot(false)}
          className="p-2 rounded bg-black/70 text-gray-400 hover:text-white transition-colors"
          title="Save Screenshot (PNG)"
        >
          <Camera size={16} />
        </button>
        <button
          onClick={() => exportScreenshot(true)}
          className="p-2 rounded bg-black/70 text-gray-400 hover:text-white transition-colors"
          title="Copy to Clipboard"
        >
          <Copy size={16} />
        </button>

        {/* WEBGL-010: PDF Analysis Report */}
        <button
          onClick={exportPDFReport}
          className="p-2 rounded bg-black/70 text-gray-400 hover:text-white transition-colors"
          title="Export PDF Analysis Report (WEBGL-010)"
        >
          <FileText size={16} />
        </button>

        {/* WEBGL-011: Split View Toggle */}
        <SplitViewToggle onClick={() => setShowSplitView(!showSplitView)} isActive={showSplitView} />

        {/* WEBGL-015: Presets Toggle */}
        <PresetsToggle onClick={() => setShowPresetsPanel(!showPresetsPanel)} isActive={showPresetsPanel} />

        {/* WEBGL-013: Batch Comparison Toggle */}
        <BatchComparisonToggle onClick={() => setShowBatchComparison(true)} />

        {/* WEBGL-014: Custom Shader Editor Toggle */}
        <ShaderEditorToggle onClick={() => setShowShaderEditor(true)} />

        {/* WEBGL-009: Temporal Diff Graph Toggle (only for videos) */}
        {(mediaA?.type === 'video' || mediaB?.type === 'video') && (
          <>
            <div className="w-px h-6 bg-gray-600 mx-1" />
            <button
              onClick={() => setShowTemporalGraph(!showTemporalGraph)}
              className={`p-2 rounded transition-colors ${showTemporalGraph ? 'bg-[#ff5722] text-white' : 'bg-black/70 text-gray-400 hover:text-white'}`}
              title="Temporal Difference Graph (WEBGL-009)"
            >
              <LineChart size={16} />
            </button>
          </>
        )}

        {/* Separator for Scopes */}
        <div className="w-px h-6 bg-gray-600 mx-1" />

        {/* SCOPE-008: Histogram Panel Toggle */}
        <button
          onClick={() => setShowHistogramPanel(!showHistogramPanel)}
          className={`p-2 rounded transition-colors ${showHistogramPanel ? 'bg-[#ff5722] text-white' : 'bg-black/70 text-gray-400 hover:text-white'}`}
          title="Histogram Panel (SCOPE-008)"
        >
          <Activity size={16} />
        </button>

        {/* SCOPE-009: Color Wheel Panel Toggle */}
        <button
          onClick={() => setShowColorWheelPanel(!showColorWheelPanel)}
          className={`p-2 rounded transition-colors ${showColorWheelPanel ? 'bg-[#ff5722] text-white' : 'bg-black/70 text-gray-400 hover:text-white'}`}
          title="Color Wheel Distribution (SCOPE-009)"
        >
          <Palette size={16} />
        </button>

        {/* SCOPE-010: Gamut Warning Toggle */}
        <button
          onClick={() => setShowGamutWarning(!showGamutWarning)}
          className={`p-2 rounded transition-colors ${showGamutWarning ? 'bg-[#ff5722] text-white' : 'bg-black/70 text-gray-400 hover:text-white'}`}
          title="Gamut Warning Overlay (SCOPE-010, G)"
        >
          <AlertTriangle size={16} />
        </button>
      </div>

      {/* Settings indicator */}
      <div className="absolute bottom-4 left-4 bg-black/70 px-3 py-1.5 rounded text-xs text-gray-400">
        Amp: {webglComparisonSettings.amplification}x |
        Threshold: {(webglComparisonSettings.threshold * 100).toFixed(0)}% |
        Opacity: {(webglComparisonSettings.opacity * 100).toFixed(0)}%
      </div>

      {/* Help text for interactive modes */}
      {webglComparisonSettings.mode === 'pro-loupe' && (
        <div className="absolute bottom-4 right-4 bg-black/70 px-3 py-1.5 rounded text-xs text-gray-400">
          Move cursor to inspect • Left = A, Right = B
        </div>
      )}

      {/* WEBGL-009: Temporal Difference Graph */}
      <TemporalDiffGraph
        videoARef={videoARef}
        videoBRef={videoBRef}
        isVisible={showTemporalGraph && (mediaA?.type === 'video' || mediaB?.type === 'video')}
      />

      {/* WEBGL-011: Split View */}
      <WebGLSplitView
        isVisible={showSplitView}
        onToggle={() => setShowSplitView(false)}
      />

      {/* WEBGL-015: Presets Panel */}
      <WebGLPresetsPanel
        isOpen={showPresetsPanel}
        onClose={() => setShowPresetsPanel(false)}
      />

      {/* WEBGL-013: Batch Comparison */}
      <BatchComparison
        isOpen={showBatchComparison}
        onClose={() => setShowBatchComparison(false)}
      />

      {/* WEBGL-014: Custom Shader Editor */}
      <CustomShaderEditor
        isOpen={showShaderEditor}
        onClose={() => setShowShaderEditor(false)}
        onApplyShader={(fragmentShader) => {
          // Apply custom shader to renderer
          if (rendererRef.current) {
            // Store the custom shader for use
            console.log('Custom shader applied:', fragmentShader.substring(0, 100) + '...')
          }
        }}
      />

      {/* SCOPE-008: Histogram Panel */}
      <HistogramPanel
        videoARef={videoARef}
        videoBRef={videoBRef}
        imageARef={imgARef}
        imageBRef={imgBRef}
        isVisible={showHistogramPanel}
        onClose={() => setShowHistogramPanel(false)}
      />

      {/* SCOPE-009: Color Wheel Panel */}
      <ColorWheelPanel
        videoARef={videoARef}
        videoBRef={videoBRef}
        imageARef={imgARef}
        imageBRef={imgBRef}
        isVisible={showColorWheelPanel}
        onClose={() => setShowColorWheelPanel(false)}
      />

      {/* SCOPE-010: Gamut Warning Overlay */}
      <GamutWarningOverlay
        videoARef={videoARef}
        videoBRef={videoBRef}
        imageARef={imgARef}
        imageBRef={imgBRef}
        isVisible={showGamutWarning}
        onClose={() => setShowGamutWarning(false)}
      />
    </div>
  )
}
