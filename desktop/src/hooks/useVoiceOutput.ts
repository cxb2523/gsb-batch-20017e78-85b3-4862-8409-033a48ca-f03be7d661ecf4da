import { useState, useRef, useCallback, useEffect } from 'react'

export type VoiceOutputStatus = 'idle' | 'speaking' | 'paused'

export interface SpeakOptions {
  rate?: number
  pitch?: number
}

interface UseVoiceOutputReturn {
  isSupported: boolean
  enabled: boolean
  setEnabled: (v: boolean) => void
  status: VoiceOutputStatus
  speak: (text: string, options?: SpeakOptions) => void
  stop: () => void
  pause: () => void
  resume: () => void
  replayLast: () => void
  voices: SpeechSynthesisVoice[]
  selectedVoice: SpeechSynthesisVoice | null
  setVoice: (voice: SpeechSynthesisVoice) => void
}

const VOICE_STORAGE_KEY = 'friday_tts_voice_uri'

export function useVoiceOutput(): UseVoiceOutputReturn {
  const [enabled, setEnabled] = useState(() => {
    const saved = localStorage.getItem('friday_voice_output_enabled')
    return saved ? saved === 'true' : false
  })
  const [status, setStatus] = useState<VoiceOutputStatus>('idle')
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [selectedVoice, setSelectedVoiceState] = useState<SpeechSynthesisVoice | null>(null)
  const selectedVoiceRef = useRef<SpeechSynthesisVoice | null>(null)
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null)
  const speakQueueRef = useRef<{ text: string; options?: SpeakOptions }[]>([])
  const speakingRef = useRef(false)
  const synthRef = useRef<SpeechSynthesis | null>(null)
  // Bumped on every stop()/disable. Utterance callbacks capture the current
  // generation and ignore themselves if it has moved on — this neutralizes
  // late onend/onerror/onstart events that browsers fire after cancel().
  const generationRef = useRef(0)
  // The most recent single item that actually started (or was interrupted
  // mid-play). replayLast() replays only this, never the whole queue.
  const lastPlayedRef = useRef<{ text: string; options?: SpeakOptions } | null>(null)
  const enabledRef = useRef(enabled)

  const isSupported =
    typeof window !== 'undefined' && 'speechSynthesis' in window

  const processQueue = useCallback(() => {
    if (speakingRef.current || speakQueueRef.current.length === 0) return
    const synth = synthRef.current
    if (!synth) return

    const item = speakQueueRef.current.shift()!
    speakingRef.current = true
    lastPlayedRef.current = item
    const generation = generationRef.current

    const utterance = new SpeechSynthesisUtterance(item.text)
    if (selectedVoiceRef.current) utterance.voice = selectedVoiceRef.current
    utterance.rate = item.options?.rate ?? 1
    utterance.pitch = item.options?.pitch ?? 1
    utterance.volume = 1

    utterance.onstart = () => {
      if (generation !== generationRef.current) return
      setStatus('speaking')
    }
    utterance.onend = () => {
      if (generation !== generationRef.current) return
      speakingRef.current = false
      if (speakQueueRef.current.length > 0) {
        processQueue()
      } else {
        setStatus('idle')
      }
    }
    utterance.onerror = () => {
      if (generation !== generationRef.current) return
      speakingRef.current = false
      setStatus('idle')
    }
    utterance.onpause = () => {
      if (generation !== generationRef.current) return
      setStatus('paused')
    }
    utterance.onresume = () => {
      if (generation !== generationRef.current) return
      setStatus('speaking')
    }

    utteranceRef.current = utterance
    synth.speak(utterance)
  }, [])

  const speak = useCallback((text: string, options?: SpeakOptions) => {
    if (!isSupported || !enabledRef.current || !text.trim()) return
    speakQueueRef.current.push({ text, options })
    processQueue()
  }, [isSupported, processQueue])

  const stop = useCallback(() => {
    // Invalidate callbacks of any in-flight utterance BEFORE cancel(), so the
    // asynchronous onend/onerror the browser still delivers are ignored.
    generationRef.current += 1
    const synth = synthRef.current
    if (synth) synth.cancel()
    speakQueueRef.current = []
    speakingRef.current = false
    utteranceRef.current = null
    setStatus('idle')
  }, [])

  const pause = useCallback(() => {
    const synth = synthRef.current
    if (synth) synth.pause()
  }, [])

  const resume = useCallback(() => {
    const synth = synthRef.current
    if (synth) synth.resume()
  }, [])

  const replayLast = useCallback(() => {
    if (!isSupported || !enabledRef.current) return
    const last = lastPlayedRef.current
    if (!last || !last.text.trim()) return
    // Interrupt whatever is playing, then replay only this single item —
    // the rest of the old queue stays cleared.
    stop()
    speakQueueRef.current.push({ text: last.text, options: last.options })
    processQueue()
  }, [isSupported, stop, processQueue])

  const setVoice = useCallback((voice: SpeechSynthesisVoice) => {
    // Only affects utterances created after this call; the currently
    // speaking utterance keeps its original voice.
    selectedVoiceRef.current = voice
    setSelectedVoiceState(voice)
    try { localStorage.setItem(VOICE_STORAGE_KEY, voice.voiceURI) } catch {}
  }, [])

  const setEnabledWrapped = useCallback((v: boolean) => {
    enabledRef.current = v
    setEnabled(v)
    try { localStorage.setItem('friday_voice_output_enabled', String(v)) } catch {}
    if (!v) {
      // Disabling is an immediate interrupt: cancel current utterance and
      // drop everything queued. Re-enabling never auto-replays.
      stop()
    }
  }, [stop])

  useEffect(() => {
    if (!isSupported) return
    const synth = window.speechSynthesis
    synthRef.current = synth

    const loadVoices = () => {
      const v = synth.getVoices()
      if (v.length > 0) {
        setVoices(v)
        const savedURI = localStorage.getItem(VOICE_STORAGE_KEY)
        if (savedURI) {
          const match = v.find(vo => vo.voiceURI === savedURI)
          if (match) {
            selectedVoiceRef.current = match
            setSelectedVoiceState(match)
            return
          }
        }
        if (!selectedVoiceRef.current) {
          const en = v.find(vo => vo.lang.startsWith('en'))
          const fallback = en || v[0]
          selectedVoiceRef.current = fallback
          setSelectedVoiceState(fallback)
        }
      }
    }

    loadVoices()
    synth.addEventListener('voiceschanged', loadVoices)
    return () => synth.removeEventListener('voiceschanged', loadVoices)
  }, [isSupported])

  return {
    isSupported, enabled, setEnabled: setEnabledWrapped,
    status, speak, stop, pause, resume, replayLast,
    voices, selectedVoice, setVoice,
  }
}
