/**
 * useWebGLSourceMapping
 *
 * Single source of truth for the A/B mapping inside the WebGL comparison view.
 *
 * Contract:
 * - `flipAB` ONLY reorders which physical source (video A/B or image A/B) is
 *   exposed as logical slot A or slot B. It never reloads media and never
 *   resets the readiness state of a track.
 * - A track is "ready" only when its CURRENT source has produced at least one
 *   sampleable frame (video `loadeddata` / image `load`). When a track's URL
 *   changes, readiness is forced back to false until the new source fires its
 *   own ready event, so stale frames from the previous source can never be
 *   sampled.
 * - Rendering, cursor color picking and metric computation must all consume
 *   the `slots` returned here, guaranteeing they describe the same pair of
 *   sources for any given render/metrics tick.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MediaFile } from '../types'

export type MappedSourceKind = 'video' | 'image'

export interface MappedSourceSlot {
  /** Media descriptor currently assigned to this logical slot (post-flip) */
  media: MediaFile | null
  /**
   * Element that actually holds the pixels for this slot, or null when no
   * matching element exists yet. The element identity is track-based and
   * therefore flip-stable; only its logical assignment changes.
   */
  element: HTMLVideoElement | HTMLImageElement | null
  kind: MappedSourceKind | null
  /**
   * True only when the CURRENT source behind this slot is sampleable.
   * A video needs readyState >= 2 plus a decoded-frame event; an image needs
   * its load event to have completed.
   */
  ready: boolean
  /** Stable identity string used to key cached results per source pair */
  sourceId: string
}

export interface WebGLSourceMapping {
  slots: {
    a: MappedSourceSlot
    b: MappedSourceSlot
  }
  /** Ready flags keyed by physical track — flip must never reset these */
  trackReady: { a: boolean; b: boolean }
  /** Both logical slots are sampleable (required for metrics & A/B inspection) */
  bothReady: boolean
  /** Identity of the currently mapped (post-flip) source pair */
  sourcePairKey: string
  /** Attach these to the hidden <img> elements' onLoad / onError props */
  imageEventHandlers: {
    a: { onLoad: () => void; onError: () => void }
    b: { onLoad: () => void; onError: () => void }
  }
  /**
   * Callback refs that both populate the externally owned object refs (so
   * other hooks keep working) and store the element in state for render-time
   * consumption. Attach to the hidden video/img elements.
   */
  elementRefs: {
    videoA: (el: HTMLVideoElement | null) => void
    videoB: (el: HTMLVideoElement | null) => void
    imageA: (el: HTMLImageElement | null) => void
    imageB: (el: HTMLImageElement | null) => void
  }
}

interface UseWebGLSourceMappingArgs {
  stableMediaA: MediaFile | null
  stableMediaB: MediaFile | null
  flipAB: boolean
  videoARef: React.RefObject<HTMLVideoElement | null>
  videoBRef: React.RefObject<HTMLVideoElement | null>
  imgARef: React.RefObject<HTMLImageElement | null>
  imgBRef: React.RefObject<HTMLImageElement | null>
}

/**
 * Readiness of one physical video track. Readiness is keyed by the current
 * source URL: the state stores the URL whose `loadeddata` last fired, so the
 * value is derived during render and resets itself on a source change without
 * needing a synchronous setState inside an effect. flipAB is deliberately not
 * part of the identity — flipping must never reset video readiness.
 */
function useVideoTrackReady(
  media: MediaFile | null,
  videoElement: HTMLVideoElement | null,
): boolean {
  const mediaUrl = media?.type === 'video' ? media.url : null
  const [readyUrl, setReadyUrl] = useState<string | null>(null)

  useEffect(() => {
    const video = videoElement
    if (!video || !mediaUrl) {
      return
    }

    let cancelled = false

    const markReady = () => {
      if (!cancelled) setReadyUrl(mediaUrl)
    }
    const markNotReady = () => {
      // 'emptied' fires when the src attribute changes: the previous frame
      // is no longer valid and must not be uploaded/sampled.
      if (!cancelled) setReadyUrl(null)
    }

    video.addEventListener('loadeddata', markReady)
    video.addEventListener('emptied', markNotReady)

    // If a frame for this src was already decoded before the listeners were
    // attached (element mounted after src), pick that up on the next frame
    // rather than setting state synchronously inside the effect.
    const rafId = requestAnimationFrame(() => {
      if (!cancelled && video.readyState >= 2 && video.src) {
        setReadyUrl(mediaUrl)
      }
    })

    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
      video.removeEventListener('loadeddata', markReady)
      video.removeEventListener('emptied', markNotReady)
    }
  }, [videoElement, mediaUrl])

  return mediaUrl !== null && readyUrl === mediaUrl
}

export function useWebGLSourceMapping(args: UseWebGLSourceMappingArgs): WebGLSourceMapping {
  const {
    stableMediaA,
    stableMediaB,
    flipAB,
    videoARef,
    videoBRef,
    imgARef,
    imgBRef,
  } = args

  // Elements in state (populated via callback refs) so they can participate
  // in render-time memoization without reading object refs during render.
  const [videoAElement, setVideoAElement] = useState<HTMLVideoElement | null>(null)
  const [videoBElement, setVideoBElement] = useState<HTMLVideoElement | null>(null)
  const [imgAElement, setImgAElement] = useState<HTMLImageElement | null>(null)
  const [imgBElement, setImgBElement] = useState<HTMLImageElement | null>(null)

  // Callback refs keep the externally owned refs in sync for other hooks
  // (video sync, scopes, temporal graph) while feeding local state.
  const videoARefCb = useCallback((el: HTMLVideoElement | null) => {
    videoARef.current = el
    setVideoAElement(el)
  }, [videoARef])
  const videoBRefCb = useCallback((el: HTMLVideoElement | null) => {
    videoBRef.current = el
    setVideoBElement(el)
  }, [videoBRef])
  const imgARefCb = useCallback((el: HTMLImageElement | null) => {
    imgARef.current = el
    setImgAElement(el)
  }, [imgARef])
  const imgBRefCb = useCallback((el: HTMLImageElement | null) => {
    imgBRef.current = el
    setImgBElement(el)
  }, [imgBRef])

  // Video readiness is tracked per physical track (A/B), independent of flip.
  const videoReadyA = useVideoTrackReady(stableMediaA, videoAElement)
  const videoReadyB = useVideoTrackReady(stableMediaB, videoBElement)

  // Image readiness: store the URL whose load/error event last fired. A
  // different URL means the previous load state is stale until the new source
  // fires its own event — no setState-in-effect needed.
  const [loadedImageUrl, setLoadedImageUrl] = useState<{
    a: string | null
    b: string | null
  }>({ a: null, b: null })

  const onImageLoadA = useCallback(
    () => setLoadedImageUrl(prev => ({ ...prev, a: stableMediaA?.url ?? null })),
    [stableMediaA?.url],
  )
  const onImageLoadB = useCallback(
    () => setLoadedImageUrl(prev => ({ ...prev, b: stableMediaB?.url ?? null })),
    [stableMediaB?.url],
  )
  const onImageErrorA = useCallback(
    () => setLoadedImageUrl(prev => ({ ...prev, a: null })),
    [],
  )
  const onImageErrorB = useCallback(
    () => setLoadedImageUrl(prev => ({ ...prev, b: null })),
    [],
  )

  return useMemo(() => {
    const imageReadyA =
      stableMediaA?.type === 'image' &&
      !!stableMediaA.url &&
      loadedImageUrl.a === stableMediaA.url
    const imageReadyB =
      stableMediaB?.type === 'image' &&
      !!stableMediaB.url &&
      loadedImageUrl.b === stableMediaB.url

    const trackReadyA =
      stableMediaA?.type === 'video' ? videoReadyA : imageReadyA
    const trackReadyB =
      stableMediaB?.type === 'video' ? videoReadyB : imageReadyB

    // Physical tracks with their stable DOM elements.
    const physicalA = {
      media: stableMediaA,
      video: videoAElement,
      image: imgAElement,
      ready: trackReadyA,
    }
    const physicalB = {
      media: stableMediaB,
      video: videoBElement,
      image: imgBElement,
      ready: trackReadyB,
    }

    const slotFor = (
      track: typeof physicalA,
    ): MappedSourceSlot => {
      const kind: MappedSourceKind | null =
        track.media?.type === 'video'
          ? 'video'
          : track.media?.type === 'image'
            ? 'image'
            : null

      const element =
        kind === 'video' ? track.video : kind === 'image' ? track.image : null

      return {
        media: track.media,
        element,
        kind,
        ready: track.ready,
        sourceId: track.media ? `${track.media.id}:${track.media.url}` : 'none',
      }
    }

    // flipAB is the ONLY place where the physical track -> logical slot
    // mapping is decided.
    const logicalA = flipAB ? physicalB : physicalA
    const logicalB = flipAB ? physicalA : physicalB
    const slotA = slotFor(logicalA)
    const slotB = slotFor(logicalB)

    return {
      slots: { a: slotA, b: slotB },
      trackReady: { a: trackReadyA, b: trackReadyB },
      bothReady: slotA.ready && slotB.ready,
      sourcePairKey: `${slotA.sourceId}||${slotB.sourceId}`,
      imageEventHandlers: {
        a: { onLoad: onImageLoadA, onError: onImageErrorA },
        b: { onLoad: onImageLoadB, onError: onImageErrorB },
      },
      elementRefs: {
        videoA: videoARefCb,
        videoB: videoBRefCb,
        imageA: imgARefCb,
        imageB: imgBRefCb,
      },
    }
  }, [
    stableMediaA,
    stableMediaB,
    flipAB,
    videoReadyA,
    videoReadyB,
    loadedImageUrl,
    videoAElement,
    videoBElement,
    imgAElement,
    imgBElement,
    onImageLoadA,
    onImageLoadB,
    onImageErrorA,
    onImageErrorB,
    videoARefCb,
    videoBRefCb,
    imgARefCb,
    imgBRefCb,
  ])
}
