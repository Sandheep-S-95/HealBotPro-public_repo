/**
 * CallInterface.jsx  –  HealBot Pro  (Voice Call Mode)
 *
 * Architecture (100% free-forever):
 *  • STT  : Web Speech API (browser-native, continuous, free)
 *  • AI   : /intake/turn  →  same Groq/LLaMA pipeline as text chat,
 *            asking clarifying questions until intake_complete = true,
 *            then triggers full /consult pipeline
 *  • TTS  : /tts  endpoint on your own FastAPI backend (gTTS – free)
 *            with browser SpeechSynthesis as instant fallback
 *
 * Bug fixes vs old version:
 *  • No-response-after-a-while: recognition is restarted on every
 *    `onend` while in 'listening' state via a robust guard
 *  • Silence timer uses a ref so it survives re-renders
 *  • Call state is ref-tracked so async callbacks see current value
 *  • Speaking blocks recognition until audio fully ends
 *  • Pipeline triggered only after intake_complete, just like text chat
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Phone, PhoneOff, Mic, MicOff,
  Search, BrainCircuit, Database, FileText, CheckCircle,
} from 'lucide-react'
import axios from 'axios'

const API = import.meta.env.VITE_API_BASE || 'http://localhost:8002'

// ─── Pipeline steps (matches IntakeChat) ──────────────────────────────────────
const PIPELINE_STEPS = [
  { id: 1, icon: Search, label: 'Symptom extraction', sub: 'Groq · LLaMA-3', key: 'extract' },
  { id: 2, icon: BrainCircuit, label: 'Graph traversal', sub: 'Neo4j KG', key: 'graph' },
  { id: 3, icon: Database, label: 'Vector RAG', sub: 'Pinecone', key: 'pinecone' },
  { id: 4, icon: FileText, label: 'Report synthesis', sub: 'LLaMA-3 70B', key: 'report' },
]

const WELCOME_MSG = {
  role: 'assistant',
  content:
    "Hello! I'm MediAssist, your AI medical intake assistant. " +
    "I'll ask you a few questions to understand your symptoms before preparing a consultation report for your doctor. " +
    "To get started — what brings you in today? Please describe what you're experiencing.",
}

// ─── TTS: backend edge-tts → fallback browser SpeechSynthesis ─────────────────────
async function speakViaTTS(text, onEnd, onStart, signal) {
  try {
    const res = await fetch(`${API}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal
    })
    if (!res.ok) throw new Error('TTS endpoint error')
    const blob = await res.blob()
    if (signal?.aborted) return { pause: () => { } }

    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)

    if (signal) {
      signal.addEventListener('abort', () => audio.pause())
    }

    audio.onended = () => { URL.revokeObjectURL(url); onEnd() }
    await audio.play()
    if (onStart) onStart()
    return audio               // caller can call audio.pause() to cancel
  } catch (err) {
    console.warn("TTS fetch failed, falling back to browser TTS", err);
    if (err.name === 'AbortError' || signal?.aborted) return { pause: () => { } }
    return speakViaBrowser(text, onEnd, onStart, signal)
  }
}

function speakViaBrowser(text, onEnd, onStart, signal) {
  if (signal?.aborted) return { pause: () => { } }
  const synth = window.speechSynthesis
  synth.cancel()
  const utter = new SpeechSynthesisUtterance(text)

  // Best free feminine voice selection strategy (Favor US English for energetic tone)
  const voices = synth.getVoices()
  const preferred = [
    'Google US English',
    'Microsoft Zira Desktop',
    'Samantha',
    'Karen',
    'Tessa',
    'Google UK English Female',
  ]
  let picked = null
  for (const name of preferred) {
    picked = voices.find(v => v.name.includes(name))
    if (picked) break
  }
  if (!picked) {
    // fallback: any English female
    picked = voices.find(v => v.lang.startsWith('en') && (v.name.toLowerCase().includes('female') || v.name.toLowerCase().includes('woman')))
  }
  if (!picked) {
    picked = voices.find(v => v.lang.startsWith('en'))
  }
  if (picked) utter.voice = picked

  // Increase pitch and rate slightly for a more energetic feel
  utter.pitch = 1.1;
  utter.rate = 1.05;
  utter.volume = 1

  utter.onstart = () => { if (onStart) onStart() }
  utter.onend = onEnd
  utter.onerror = onEnd   // don't hang if browser TTS errors
  synth.speak(utter)

  // Chrome has a bug where synthesis stalls if page is in background for ~15s.
  // Nudge it every 10s.
  const nudge = setInterval(() => {
    if (!synth.speaking) { clearInterval(nudge); return }
    synth.pause(); synth.resume()
  }, 10000)
  utter.onend = () => { clearInterval(nudge); onEnd() }

  return { pause: () => synth.cancel() }  // mimic Audio interface
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function CallInterface({ user, authToken, onReportReady, onEndCall }) {
  const [messages, setMessages] = useState([WELCOME_MSG])
  const [callState, setCallState] = useState('initializing')
  // 'initializing' | 'listening' | 'thinking' | 'speaking' | 'pipeline'
  const [transcript, setTranscript] = useState('')
  const [muted, setMuted] = useState(false)
  const [pipelineStep, setPipelineStep] = useState(0)
  const [stepsDone, setStepsDone] = useState([])
  const [displayText, setDisplayText] = useState('')  // what's showing in transcript area
  const [errorBanner, setErrorBanner] = useState('')

  // Stable refs for async callbacks
  const callStateRef = useRef('initializing')
  const mutedRef = useRef(false)
  const messagesRef = useRef([WELCOME_MSG])
  const recognitionRef = useRef(null)
  const silenceRef = useRef(null)
  const currentAudioRef = useRef(null)   // current TTS audio handle
  const processingRef = useRef(false)  // guard against duplicate sends
  const abortControllerRef = useRef(null)

  const setState = (s) => { callStateRef.current = s; setCallState(s) }

  useEffect(() => { mutedRef.current = muted }, [muted])
  useEffect(() => { messagesRef.current = messages }, [messages])

  // Initialize abort controller
  useEffect(() => {
    abortControllerRef.current = new AbortController()
    return () => abortControllerRef.current.abort()
  }, [])

  // ── Recognition setup ──────────────────────────────────────────────────────
  // Strategy: NEVER stop/abort recognition manually.
  // Chrome's webkitSpeechRecognition dies permanently after abort().
  // Instead we keep it always running and gate processing with a flag ref.
  const recListeningRef = useRef(false)  // true = process mic input
  const echoSuppressRef = useRef(false)  // true = ignore results (echo window)

  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) {
      alert('Your browser does not support voice input. Please use Chrome or Edge.')
      onEndCall()
      return
    }

    let isActive = true

    function makeRecognition() {
      const rec = new SR()
      rec.continuous = true
      rec.interimResults = true
      rec.lang = 'en-US'
      rec.maxAlternatives = 1

      rec.onresult = (e) => {
        // Gate: only process when we're actively listening AND not in echo window
        if (!recListeningRef.current || echoSuppressRef.current) return
        if (mutedRef.current) return

        let interim = ''
        let finalText = ''
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) {
            finalText += e.results[i][0].transcript
          } else {
            interim += e.results[i][0].transcript
          }
        }

        const combined = (finalText || interim).trim()
        setTranscript(combined)
        setDisplayText(combined)

        if (silenceRef.current) clearTimeout(silenceRef.current)

        if (finalText.trim()) {
          silenceRef.current = setTimeout(() => handleUserSpeech(finalText.trim()), 800)
        } else if (combined) {
          silenceRef.current = setTimeout(() => {
            if (combined.trim()) handleUserSpeech(combined.trim())
          }, 2200)
        }
      }

      rec.onerror = (e) => {
        console.error("Speech recognition error:", e.error, e.message);
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          alert('Microphone permission denied. Please allow microphone access and try again.')
          onEndCall()
        }
        // no-speech, aborted, network: onend will restart
      }

      rec.onend = () => {
        if (!isActive) return
        // Always restart - recognition naturally ends on silence in some browsers
        setTimeout(() => {
          if (!isActive) return
          recognitionRef.current = makeRecognition()
          try { recognitionRef.current.start() } catch { }
        }, 200)
      }

      return rec
    }

    recognitionRef.current = makeRecognition()
    // Start recognition immediately (needed so Chrome allocates mic in user gesture context)
    try { recognitionRef.current.start() } catch { }

    // Start the greeting (preserves user-gesture token for audio autoplay)
    greet()

    return () => {
      isActive = false
      recListeningRef.current = false
      if (silenceRef.current) clearTimeout(silenceRef.current)
      try { recognitionRef.current?.stop() } catch { }
      if (currentAudioRef.current?.pause) currentAudioRef.current.pause()
      window.speechSynthesis?.cancel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Mute toggle ──────────────────────────────────────────────────────────
  // Mute just gates the flag, recognition keeps running
  useEffect(() => {
    if (callState === 'listening') {
      recListeningRef.current = !muted
    }
  }, [muted, callState])


  // ── TTS helpers ────────────────────────────────────────────────────────────
  const speak = useCallback(async (text) => {
    processingRef.current = false

    // Stop any existing audio
    if (currentAudioRef.current?.pause) currentAudioRef.current.pause()
    window.speechSynthesis?.cancel()

    const handle = await speakViaTTS(
      text,
      () => {
        // Audio just ended. Suppress echo for 1000ms (reverb/tail in the mic).
        console.log("TTS ended: triggering echo suppression")
        echoSuppressRef.current = true
        setTimeout(() => {
          echoSuppressRef.current = false
          recListeningRef.current = true
          setState('listening')
          setDisplayText('')
        }, 1000)
      },
      () => {
        // Audio just started playing — disable input processing immediately.
        recListeningRef.current = false
        echoSuppressRef.current = false
        setState('speaking')
        setDisplayText(text)
      },
      abortControllerRef.current?.signal
    )
    currentAudioRef.current = handle
  }, [])

  const greet = useCallback(() => {
    setTimeout(() => speak(WELCOME_MSG.content), 300)
  }, [speak])

  // ── Handle what user said ──────────────────────────────────────────────────
  const handleUserSpeech = useCallback(async (text) => {
    if (!text.trim()) return
    if (processingRef.current) return   // already handling a turn
    if (callStateRef.current !== 'listening') return

    processingRef.current = true

    // Clear silence timer
    if (silenceRef.current) { clearTimeout(silenceRef.current); silenceRef.current = null }

    setState('thinking')
    setTranscript('')
    setDisplayText('')

    const userMsg = { role: 'user', content: text }
    const updatedMsgs = [...messagesRef.current, userMsg]
    setMessages(updatedMsgs)

    try {
      const res = await axios.post(`${API}/intake/turn`, {
        conversation: updatedMsgs,
        doc_path: null,
      })

      const { message, intake_complete, summary } = res.data
      const assistantMsg = { role: 'assistant', content: message }
      const finalMsgs = [...updatedMsgs, assistantMsg]
      setMessages(finalMsgs)

      if (intake_complete) {
        // Speak the completion message, then start pipeline
        setState('pipeline')
        await speak("I have all the information I need. Let me analyse your symptoms and generate your medical report now. Please hold on for a moment.")
        setTimeout(() => runPipeline(summary, finalMsgs), 500)
      } else {
        await speak(message)
      }
    } catch (err) {
      console.error('Intake turn error:', err)
      processingRef.current = false
      const fallback = getErrorFallback(err)
      await speak(fallback)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speak])

  // ── Pipeline ───────────────────────────────────────────────────────────────
  const runPipeline = useCallback(async (summary, allMessages) => {
    const transcriptText = allMessages
      .map(m => `${m.role === 'user' ? 'Patient' : 'MediAssist'}: ${m.content}`)
      .join('\n')

    const delay = ms => new Promise(r => setTimeout(r, ms))
    const stepTimes = [1200, 2000, 2500, 3000]

    try {
      const consultPromise = axios.post(
        `${API}/consult`,
        {
          patient_summary: summary,
          user_id: user?.username || user?.user_id || null,
          doc_path: null,
          conversation_transcript: transcriptText,
        },
        { headers: authToken ? { Authorization: `Bearer ${authToken}` } : {} }
      )

      for (let i = 1; i <= 4; i++) {
        setPipelineStep(i)
        await delay(stepTimes[i - 1])
        setStepsDone(prev => [...prev, i])
      }

      const res = await consultPromise
      onReportReady(res.data)
    } catch (err) {
      console.error('Pipeline error:', err)
      await speak("I'm sorry, something went wrong while generating your report. Please try again.")
      onEndCall()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, authToken, onReportReady, onEndCall, speak])

  // ── Error fallback messages ────────────────────────────────────────────────
  const getErrorFallback = (err) => {
    if (!navigator.onLine) return "It seems you're offline. Please check your connection and try again."
    if (err?.response?.status >= 500) return "I'm having trouble reaching the server right now. Could you please repeat what you said?"
    if (err?.code === 'ECONNABORTED' || err?.message?.includes('timeout'))
      return "That took a bit longer than expected. Let's try again — could you repeat your last answer?"
    return "I'm sorry, I had a small hiccup. Could you say that again?"
  }

  // ── Toggle mute ────────────────────────────────────────────────────────────
  const handleMute = () => {
    setMuted(m => {
      const next = !m
      mutedRef.current = next
      if (next) {
        // Muting — stop recognition
        try { recognitionRef.current?.stop() } catch { }
        if (silenceRef.current) clearTimeout(silenceRef.current)
      }
      return next
    })
  }

  // ── End call ──────────────────────────────────────────────────────────────
  const handleEndCall = () => {
    if (silenceRef.current) clearTimeout(silenceRef.current)
    try { recognitionRef.current?.abort() } catch { }
    if (currentAudioRef.current?.pause) currentAudioRef.current.pause()
    if (abortControllerRef.current) abortControllerRef.current.abort()
    window.speechSynthesis?.cancel()
    onEndCall()
  }

  // ── Conversation turns shown in the call overlay ───────────────────────────
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
  const lastUser = [...messages].reverse().find(m => m.role === 'user')
  const turnCount = messages.filter(m => m.role === 'user').length

  const isPipeline = callState === 'pipeline'

  // ── Status label ──────────────────────────────────────────────────────────
  const statusLabel = {
    initializing: 'Connecting…',
    listening: muted ? '🔇 Muted' : '🎙 Listening…',
    thinking: '🧠 Thinking…',
    speaking: '💬 Speaking…',
    pipeline: '⚙️ Generating report…',
  }[callState] || ''

  return (
    <div className="call-overlay">
      <div className="call-container">

        {/* Header */}
        <div className="call-header">
          <div className="call-title">MediAssist Voice Consultation</div>
          <div className="call-status">{statusLabel}</div>
          {turnCount > 0 && !isPipeline && (
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
              Question {turnCount} of ~6
            </div>
          )}
        </div>

        {/* Error banner */}
        <AnimatePresence>
          {errorBanner && (
            <motion.div
              initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              style={{
                background: 'rgba(251,100,80,0.15)',
                border: '1px solid rgba(251,100,80,0.3)',
                borderRadius: 8, padding: '8px 14px',
                fontSize: 13, color: '#fb6450', textAlign: 'center', marginBottom: 8,
              }}
            >
              {errorBanner}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Avatar orb */}
        <div className="call-avatar-wrapper">
          <motion.div
            className={`orb-ring ring-1 ${callState}`}
            animate={{ scale: callState === 'speaking' ? [1, 1.45, 1] : callState === 'listening' ? [1, 1.12, 1] : 1 }}
            transition={{ repeat: Infinity, duration: callState === 'speaking' ? 1.2 : 3 }}
          />
          <motion.div
            className={`orb-ring ring-2 ${callState}`}
            animate={{ scale: callState === 'speaking' ? [1, 1.85, 1] : callState === 'listening' ? [1, 1.22, 1] : 1 }}
            transition={{ repeat: Infinity, duration: callState === 'speaking' ? 1.2 : 3, delay: 0.18 }}
          />
          <div className={`call-avatar ${callState}`}>
            <Phone size={40} />
          </div>
        </div>

        {/* Transcript / speech display */}
        <div className="call-transcript">
          <AnimatePresence mode="wait">
            {callState === 'listening' && displayText && (
              <motion.p key="user-live"
                initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                style={{ color: 'var(--text-2)', fontStyle: 'italic' }}
              >
                "{displayText}"
              </motion.p>
            )}
            {callState === 'speaking' && displayText && (
              <motion.p key="assistant-speaking"
                initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                style={{ color: 'var(--teal)', fontSize: 15 }}
              >
                {displayText}
              </motion.p>
            )}
            {callState === 'thinking' && (
              <motion.p key="thinking"
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                style={{ color: 'var(--text-3)', fontSize: 14 }}
              >
                Analysing your response…
              </motion.p>
            )}
          </AnimatePresence>
        </div>

        {/* Conversation log (last exchange) */}
        {!isPipeline && (lastUser || lastAssistant) && (
          <div style={{
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 12, padding: '12px 16px',
            maxWidth: 440, width: '100%',
            fontSize: 13, lineHeight: 1.6,
            maxHeight: 130, overflowY: 'auto',
          }}>
            {lastUser && (
              <div style={{ marginBottom: 6 }}>
                <span style={{ color: 'var(--text-3)', fontSize: 11 }}>YOU  </span>
                <span style={{ color: 'var(--text-1)' }}>{lastUser.content}</span>
              </div>
            )}
            {lastAssistant && callState !== 'listening' && (
              <div>
                <span style={{ color: 'var(--text-3)', fontSize: 11 }}>MEDIASSIST  </span>
                <span style={{ color: 'var(--teal)' }}>{lastAssistant.content}</span>
              </div>
            )}
          </div>
        )}

        {/* Pipeline progress */}
        {isPipeline && (
          <div className="call-pipeline">
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              {PIPELINE_STEPS.map(s => (
                <div key={s.id} style={{
                  width: 36, height: 5, borderRadius: 99,
                  background: stepsDone.includes(s.id)
                    ? 'var(--green)'
                    : pipelineStep === s.id
                      ? 'var(--teal)'
                      : 'rgba(255,255,255,0.15)',
                  transition: 'background 0.4s',
                }} />
              ))}
            </div>
            {/* Step rows */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12, width: '100%', maxWidth: 380 }}>
              {PIPELINE_STEPS.map(s => {
                const Icon = s.icon
                const isDone = stepsDone.includes(s.id)
                const isNow = pipelineStep === s.id && !isDone
                return (
                  <div key={s.id} style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    opacity: isDone || isNow ? 1 : 0.35,
                    transition: 'opacity 0.4s',
                  }}>
                    <div style={{
                      width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: isDone ? 'var(--green)' : isNow ? 'var(--teal)' : 'rgba(255,255,255,0.1)',
                      transition: 'background 0.4s',
                    }}>
                      {isDone ? <CheckCircle size={14} /> : <Icon size={14} />}
                    </div>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-1)' }}>{s.label}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{s.sub}</div>
                    </div>
                    <div style={{
                      marginLeft: 'auto', fontSize: 10, fontWeight: 700,
                      color: isDone ? 'var(--green)' : isNow ? 'var(--teal)' : 'var(--text-3)',
                      letterSpacing: 1,
                    }}>
                      {isDone ? 'DONE' : isNow ? 'RUN' : 'WAIT'}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Controls */}
        <div className="call-controls">
          <button
            className={`control-btn ${muted ? 'muted' : ''}`}
            onClick={handleMute}
            disabled={isPipeline}
            title={muted ? 'Unmute' : 'Mute'}
          >
            {muted ? <MicOff size={24} /> : <Mic size={24} />}
          </button>
          <button className="control-btn end-call" onClick={handleEndCall} title="End call">
            <PhoneOff size={24} />
          </button>
        </div>

        {/* Listening hint */}
        {callState === 'listening' && !muted && !displayText && (
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: -8 }}>
            Speak now — I'm listening…
          </div>
        )}

      </div>
    </div>
  )
}