import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useVoiceOutput } from '../hooks/useVoiceOutput'

// --- Mock speechSynthesis ---------------------------------------------------

class MockUtterance {
  text: string
  voice: unknown = null
  rate = 1
  pitch = 1
  volume = 1
  onstart: (() => void) | null = null
  onend: (() => void) | null = null
  onerror: (() => void) | null = null
  onpause: (() => void) | null = null
  onresume: (() => void) | null = null
  constructor(text: string) { this.text = text }
}

const FAKE_VOICES = [
  { voiceURI: 'voice-en', name: 'English', lang: 'en-US', default: true, localService: true },
  { voiceURI: 'voice-zh', name: 'Chinese', lang: 'zh-CN', default: false, localService: true },
] as SpeechSynthesisVoice[]

class MockSpeechSynthesis extends EventTarget {
  spoken: MockUtterance[] = []
  current: MockUtterance | null = null
  speaking = false
  paused = false
  cancelCount = 0

  speak(u: MockUtterance) {
    this.spoken.push(u)
    this.current = u
    this.speaking = true
    // Browsers fire onstart asynchronously
    queueMicrotask(() => u.onstart?.())
  }

  cancel() {
    this.cancelCount += 1
    this.speaking = false
    this.paused = false
    const u = this.current
    this.current = null
    // Real browsers still deliver a late onerror/onend for the cancelled
    // utterance — simulate that so tests cover the stale-callback path.
    if (u) queueMicrotask(() => u.onerror?.())
  }

  pause() {
    this.paused = true
    this.current?.onpause?.()
  }

  resume() {
    this.paused = false
    this.current?.onresume?.()
  }

  getVoices() { return FAKE_VOICES }

  /** Test helper: the current utterance finishes naturally. */
  finishCurrent() {
    const u = this.current
    this.current = null
    this.speaking = false
    u?.onend?.()
  }
}

let synth: MockSpeechSynthesis

const flush = () => act(async () => { await Promise.resolve() })

async function setup() {
  const hook = renderHook(() => useVoiceOutput())
  await act(async () => { hook.result.current.setEnabled(true) })
  return hook
}

beforeEach(() => {
  localStorage.clear()
  synth = new MockSpeechSynthesis()
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true })
  ;(globalThis as Record<string, unknown>).SpeechSynthesisUtterance = MockUtterance
})

afterEach(() => {
  // @ts-expect-error cleanup
  delete window.speechSynthesis
  delete (globalThis as Record<string, unknown>).SpeechSynthesisUtterance
})

describe('useVoiceOutput', () => {
  it('speaks queued text and reports speaking status', async () => {
    const { result } = await setup()
    act(() => result.current.speak('hello world'))
    expect(synth.spoken.map(u => u.text)).toEqual(['hello world'])
    await flush()
    expect(result.current.status).toBe('speaking')
    act(() => synth.finishCurrent())
    expect(result.current.status).toBe('idle')
  })

  it('ignores speak() when disabled or text is blank', async () => {
    const { result } = await setup()
    act(() => result.current.setEnabled(false))
    act(() => result.current.speak('nope'))
    act(() => result.current.setEnabled(true))
    act(() => { result.current.speak('   '); result.current.speak('') })
    expect(synth.spoken).toHaveLength(0)
  })

  it('stop() cancels the current utterance, clears the queue and goes idle', async () => {
    const { result } = await setup()
    act(() => {
      result.current.speak('first')
      result.current.speak('second')
      result.current.speak('third')
    })
    await flush()
    expect(result.current.status).toBe('speaking')

    act(() => result.current.stop())
    expect(result.current.status).toBe('idle')
    expect(synth.cancelCount).toBe(1)

    // Late onerror from the cancelled utterance must not revive anything
    await flush()
    expect(result.current.status).toBe('idle')
    expect(synth.spoken).toHaveLength(1) // queued items never played
  })

  it('late onend after stop() does not continue the queue or change status', async () => {
    const { result } = await setup()
    act(() => {
      result.current.speak('one')
      result.current.speak('two')
    })
    await flush()
    const stale = synth.current!
    act(() => result.current.stop())
    // Simulate a browser delivering onend (not onerror) after cancel
    act(() => stale.onend?.())
    await flush()
    expect(result.current.status).toBe('idle')
    expect(synth.spoken).toHaveLength(1)
  })

  it('setEnabled(false) interrupts immediately and clears the queue', async () => {
    const { result } = await setup()
    act(() => {
      result.current.speak('a')
      result.current.speak('b')
    })
    await flush()
    expect(result.current.status).toBe('speaking')

    act(() => result.current.setEnabled(false))
    expect(result.current.status).toBe('idle')
    expect(synth.cancelCount).toBe(1)
    await flush()
    expect(result.current.status).toBe('idle')
    expect(synth.spoken).toHaveLength(1)
  })

  it('setEnabled(true) does not auto-replay anything', async () => {
    const { result } = await setup()
    act(() => result.current.speak('interrupted'))
    await flush()
    act(() => result.current.setEnabled(false))
    act(() => result.current.setEnabled(true))
    await flush()
    expect(synth.spoken).toHaveLength(1)
    expect(result.current.status).toBe('idle')
  })

  it('replayLast() replays only the last interrupted item', async () => {
    const { result } = await setup()
    act(() => {
      result.current.speak('first')
      result.current.speak('second')
    })
    await flush()
    act(() => result.current.stop())
    await flush()

    act(() => result.current.replayLast())
    await flush()
    // Only the interrupted single item replays — not the queued 'second'
    expect(synth.spoken.map(u => u.text)).toEqual(['first', 'first'])
    expect(result.current.status).toBe('speaking')
  })

  it('replayLast() replays a fully completed item', async () => {
    const { result } = await setup()
    act(() => result.current.speak('done'))
    await flush()
    act(() => synth.finishCurrent())
    expect(result.current.status).toBe('idle')

    act(() => result.current.replayLast())
    await flush()
    expect(synth.spoken.map(u => u.text)).toEqual(['done', 'done'])
    expect(result.current.status).toBe('speaking')
  })

  it('replayLast() is a no-op when nothing has played or when disabled', async () => {
    const { result } = await setup()
    act(() => result.current.replayLast())
    expect(synth.spoken).toHaveLength(0)

    act(() => result.current.speak('x'))
    await flush()
    act(() => result.current.setEnabled(false))
    act(() => result.current.replayLast())
    await flush()
    expect(synth.spoken).toHaveLength(1) // no replay while disabled
  })

  it('rapid speak/stop/speak ends in a state consistent with the last call', async () => {
    const { result } = await setup()
    act(() => {
      result.current.speak('old')
      result.current.stop()
      result.current.speak('new')
    })
    await flush()
    expect(synth.spoken.map(u => u.text)).toEqual(['old', 'new'])
    expect(result.current.status).toBe('speaking')

    // Late callback from the cancelled 'old' utterance must not clobber state
    await flush()
    expect(result.current.status).toBe('speaking')
    act(() => synth.finishCurrent())
    expect(result.current.status).toBe('idle')
  })

  it('rapid stop as the last call wins', async () => {
    const { result } = await setup()
    act(() => {
      result.current.speak('one')
      result.current.stop()
      result.current.speak('two')
      result.current.stop()
    })
    await flush()
    expect(result.current.status).toBe('idle')
    // 'two' was cancelled before/while starting; nothing further plays
    const count = synth.spoken.length
    await flush()
    expect(synth.spoken.length).toBe(count)
  })

  it('setVoice only affects utterances started after the change', async () => {
    const { result } = await setup()
    act(() => result.current.speak('before'))
    await flush()
    expect((synth.spoken[0].voice as SpeechSynthesisVoice).voiceURI).toBe('voice-en')

    act(() => result.current.setVoice(FAKE_VOICES[1]))
    // Currently speaking utterance is untouched
    expect((synth.current!.voice as SpeechSynthesisVoice).voiceURI).toBe('voice-en')

    act(() => synth.finishCurrent())
    act(() => result.current.speak('after'))
    await flush()
    expect((synth.spoken[1].voice as SpeechSynthesisVoice).voiceURI).toBe('voice-zh')
  })

  it('pause/resume still work', async () => {
    const { result } = await setup()
    act(() => result.current.speak('pausable'))
    await flush()
    act(() => result.current.pause())
    expect(result.current.status).toBe('paused')
    act(() => result.current.resume())
    expect(result.current.status).toBe('speaking')
  })
})
