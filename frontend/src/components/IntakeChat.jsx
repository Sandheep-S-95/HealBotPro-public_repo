/**
 * IntakeChat.jsx
 *
 * The conversational symptom-gathering interface.
 * Replaces the old static textarea with a back-and-forth
 * AI assistant that asks clarifying questions before
 * triggering the full diagnostic pipeline.
 *
 * Flow:
 *   1. Patient types their first message (or uploads a PDF)
 *   2. MediAssist asks clarifying questions (up to ~6 turns)
 *   3. When AI signals [INTAKE_COMPLETE], show "Generating report…" overlay
 *   4. POST /consult with the collected summary
 *   5. Navigate to report view
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Send, Paperclip, X, Search, BrainCircuit, Database, FileText, CheckCircle } from 'lucide-react'
import axios from 'axios'

const API = import.meta.env.VITE_API_BASE || 'http://localhost:8002'

const PIPELINE_STEPS = [
  { id: 1, icon: Search,       label: 'Symptom extraction', sub: 'Groq · LLaMA-3',    key: 'extract'  },
  { id: 2, icon: BrainCircuit, label: 'Graph traversal',    sub: 'Neo4j KG',           key: 'graph'    },
  { id: 3, icon: Database,     label: 'Vector RAG',         sub: 'Pinecone',           key: 'pinecone' },
  { id: 4, icon: FileText,     label: 'Report synthesis',   sub: 'LLaMA-3 70B',        key: 'report'   },
]

const WELCOME_MSG = {
  role: 'assistant',
  content:
    "Hello! I'm MediAssist, your AI medical intake assistant. " +
    "I'll ask you a few questions to understand your symptoms before preparing a consultation report for your doctor. " +
    "To get started — what brings you in today? Please describe what you're experiencing.",
}

export default function IntakeChat({ user, authToken, onReportReady }) {
  const [messages, setMessages] = useState([WELCOME_MSG])
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const [pipelineRunning, setPipelineRunning] = useState(false)
  const [pipelineStep, setPipelineStep] = useState(0)  // 0=not started, 1-4=active step
  const [stepsDone, setStepsDone] = useState([])
  const bottomRef = useRef(null)
  const textareaRef = useRef(null)

  // Auto-scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, thinking])

  // Auto-grow textarea
  const handleInput = (e) => {
    setInput(e.target.value)
    const el = textareaRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 140) + 'px'
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  /* ── Run full pipeline after intake ── */
  const runPipeline = useCallback(async (summary, allMessages) => {
    setPipelineRunning(true)

    // Build a readable transcript from the conversation
    const transcript = allMessages
      .map(m => `${m.role === 'user' ? 'Patient' : 'MediAssist'}: ${m.content}`)
      .join('\n')

    // Animate pipeline steps
    const delay = (ms) => new Promise(r => setTimeout(r, ms))

    const stepTimes = [1200, 2000, 2500, 3000] // rough timing for visual feedback

    try {
      // Kick off the actual API call immediately (don't await yet)
      const consultPromise = axios.post(
        `${API}/consult`,
        {
          patient_summary: summary,
          user_id: user?.username || user?.user_id || null,
          conversation_transcript: transcript,
        },
        {
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
        }
      )

      // Animate steps while API call runs
      for (let i = 1; i <= 4; i++) {
        setPipelineStep(i)
        await delay(stepTimes[i - 1])
        setStepsDone(prev => [...prev, i])
      }

      // Now await the result
      const res = await consultPromise
      onReportReady(res.data)
    } catch (err) {
      console.error('Pipeline error:', err)
      setPipelineRunning(false)
      setPipelineStep(0)
      setStepsDone([])
      alert('An error occurred while generating your report. Please try again.')
    }
  }, [user, authToken, onReportReady])

  /* ── Send a message ── */
  const send = async () => {
    const text = input.trim()
    if (!text || thinking || pipelineRunning) return

    const userMsg = { role: 'user', content: text }
    const updatedMsgs = [...messages, userMsg]
    setMessages(updatedMsgs)
    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    setThinking(true)

    try {
      const res = await axios.post(`${API}/intake/turn`, {
        conversation: updatedMsgs,
      })

      const { message, intake_complete, summary } = res.data
      setThinking(false)

      const assistantMsg = { role: 'assistant', content: message }
      const finalMsgs = [...updatedMsgs, assistantMsg]
      setMessages(finalMsgs)

      if (intake_complete) {
        // Brief pause before launching pipeline overlay
        setTimeout(() => runPipeline(summary, finalMsgs), 800)
      }
    } catch (err) {
      setThinking(false)
      console.error('Intake turn error:', err)
      setMessages(prev => [
        ...prev,
        {
          role: 'assistant',
          content:
            "I'm sorry, I encountered a technical issue. Could you please repeat what you just said?",
        },
      ])
    }
  }

  return (
    <>
      {/* ── Pipeline running overlay ── */}
      <AnimatePresence>
        {pipelineRunning && (
          <motion.div
            className="overlay-spinner"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div className="pulse-ring" />
            <div className="overlay-label">
              {pipelineStep === 0 && 'Initialising pipeline…'}
              {pipelineStep === 1 && 'Extracting symptoms with LLaMA-3…'}
              {pipelineStep === 2 && 'Traversing Neo4j knowledge graph…'}
              {pipelineStep === 3 && 'Searching Pinecone medical vectors…'}
              {pipelineStep === 4 && 'Synthesising consultation report…'}
            </div>

            {/* Mini step tracker */}
            <div style={{ display: 'flex', gap: 8 }}>
              {PIPELINE_STEPS.map(s => (
                <div
                  key={s.id}
                  style={{
                    width: 32, height: 4, borderRadius: 99,
                    background: stepsDone.includes(s.id)
                      ? 'var(--green)'
                      : pipelineStep === s.id
                        ? 'var(--teal)'
                        : 'var(--surface-2)',
                    transition: 'background 0.4s',
                  }}
                />
              ))}
            </div>

            <div style={{ fontSize: 13, color: 'var(--text-3)', maxWidth: 320, textAlign: 'center', lineHeight: 1.6 }}>
              Analysing your symptoms with GraphRAG and medical vector database…
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Main chat layout ── */}
      <div className="chat-layout page" style={{ paddingBottom: 0 }}>
        {/* ── Left sidebar: pipeline + patient info ── */}
        <aside className="sidebar layer">
          {/* Patient info */}
          <div className="sidebar-section">
            <div className="sidebar-label">Patient</div>
            <div className="patient-card">
              <div className="patient-name">
                {user?.full_name || user?.username || 'Guest'}
              </div>
              <div className="patient-id">
                ID: HB-{(user?.username || 'GUEST').toUpperCase().slice(0, 8)}
              </div>
              {user?.has_history && (
                <div className="patient-badge">
                  <span>●</span> History synced
                </div>
              )}
            </div>
          </div>

          {/* Pipeline steps */}
          <div className="sidebar-section">
            <div className="sidebar-label">Pipeline</div>
            <div className="pipeline">
              {PIPELINE_STEPS.map(s => {
                const Icon = s.icon
                const isDone = stepsDone.includes(s.id)
                const isActive = pipelineStep === s.id && !isDone
                const cls = isDone ? 'done' : isActive ? 'active' : 'pending'
                return (
                  <div key={s.id} className={`step ${cls}`}>
                    <div className="step-icon">
                      {isDone
                        ? <CheckCircle size={14} />
                        : <Icon size={14} />
                      }
                    </div>
                    <div className="step-info">
                      <div className="step-label">{s.label}</div>
                      <div className="step-sub">{s.sub}</div>
                    </div>
                    <div className="step-badge">
                      {isDone ? 'DONE' : isActive ? 'RUN' : 'WAIT'}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Context note */}
          <div className="sidebar-section" style={{ marginTop: 'auto' }}>
            <div style={{
              padding: 14,
              background: 'var(--amber-dim)',
              border: '1px solid rgba(251,191,36,0.18)',
              borderRadius: 10,
              fontSize: 12,
              color: 'rgba(251,191,36,0.7)',
              lineHeight: 1.6,
            }}>
              ℹ️ MediAssist will ask you 4-6 questions before generating your report. Answer as fully as you can.
            </div>
          </div>
        </aside>

        {/* ── Right: chat ── */}
        <main className="chat-area layer">
          <div className="chat-header">
            <div className="chat-title">Symptom Intake</div>
            <div className="chat-status">
              MediAssist · {messages.length - 1} exchange{messages.length !== 2 ? 's' : ''}
            </div>
          </div>

          {/* Messages */}
          <div className="messages">
            {messages.map((msg, i) => (
              <motion.div
                key={i}
                className={`msg ${msg.role}`}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
              >
                <div className="msg-avatar">
                  {msg.role === 'assistant' ? '🩺' : '👤'}
                </div>
                <div className="msg-bubble">{msg.content}</div>
              </motion.div>
            ))}

            {/* Typing indicator */}
            <AnimatePresence>
              {thinking && (
                <motion.div
                  className="msg assistant msg-typing"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                >
                  <div className="msg-avatar">🩺</div>
                  <div className="msg-bubble">
                    <div className="typing-dots">
                      <span /><span /><span />
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div ref={bottomRef} />
          </div>

          {/* Input area */}
          <div>
            <div className="input-bar">
              <textarea
                ref={textareaRef}
                className="input-field"
                placeholder="Type your response… (Enter to send, Shift+Enter for new line)"
                rows={1}
                value={input}
                onChange={handleInput}
                onKeyDown={handleKeyDown}
                disabled={thinking || pipelineRunning}
              />
              <button
                className="send-btn"
                onClick={send}
                disabled={!input.trim() || thinking || pipelineRunning}
              >
                <Send size={18} />
              </button>
            </div>
          </div>
        </main>
      </div>
    </>
  )
}
