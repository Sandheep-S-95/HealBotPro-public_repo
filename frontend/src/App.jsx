/**
 * App.jsx – HealBot Pro v2
 *
 * Views:
 *   landing  → marketing/welcome page
 *   auth     → login / register
 *   intake   → conversational symptom chat (new!)
 *   report   → generated consultation report
 */

import { useState, useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Stethoscope, LogOut, Database, Activity, ArrowRight, Phone
} from 'lucide-react'
import axios from 'axios'

import Auth from './components/Auth'
import IntakeChat from './components/IntakeChat'
import CallInterface from './components/CallInterface'
import ReportView from './components/ReportView'
import HistoryModal from './components/HistoryModal'
import HistoryPage from './components/HistoryPage'
import { auth } from './firebase'
import { signOut } from 'firebase/auth'

const API = import.meta.env.VITE_API_BASE || 'http://localhost:8002'

export default function App() {
  const [view, setView] = useState('landing')      // landing | auth | intake | report
  const [user, setUser] = useState(null)
  const [authToken, setAuthToken] = useState(() => localStorage.getItem('hb_token'))
  const [report, setReport] = useState(null)
  const [showHistoryModal, setShowHistoryModal] = useState(false)
  const [historyRefresh, setHistoryRefresh] = useState(0)
  const [toast, setToast] = useState(null)

  // Toast helper
  const showToast = (msg, type = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  // Restore session
  useEffect(() => {
    if (authToken && !user) {
      axios.get(`${API}/users/me`, {
        headers: { Authorization: `Bearer ${authToken}` },
      })
        .then(res => {
          setUser(res.data)
          setView('intake')
        })
        .catch(() => {
          localStorage.removeItem('hb_token')
          setAuthToken(null)
        })
    }
  }, [])

  const handleLoginSuccess = (userData, token) => {
    setAuthToken(token)
    localStorage.setItem('hb_token', token)
    setUser(userData)
    setView('intake')
  }

  const handleLogout = async () => {
    try {
      await signOut(auth)
    } catch (e) {
      console.error("Error signing out:", e)
    }
    setUser(null)
    setAuthToken(null)
    localStorage.removeItem('hb_token')
    setReport(null)
    setView('landing')
  }

  const handleReportReady = (data) => {
    setReport(data)
    setView('report')
  }

  const handleNewSession = () => {
    setReport(null)
    setView('intake')
  }

  return (
    <div className="app-root">
      {/* Background effects (visible on non-landing pages) */}
      {view !== 'landing' && (
        <>
          <div className="bg-grid" />
          <div className="orb orb-1" />
          <div className="orb orb-2" />
        </>
      )}

      {/* ── Navbar ── */}
      <nav className="navbar">
        <div className="page">
          <div className="navbar-inner">
            {/* Brand */}
            <div className="brand" style={{ cursor: 'pointer' }} onClick={() => !user && setView('landing')}>
              <div className="brand-icon">
                <Stethoscope size={18} color="#050a0a" />
              </div>
              <span className="brand-name">HealBot<em>Pro</em></span>
            </div>

            {/* Right nav */}
            <div className="nav-links">
              {!user ? (
                null
              ) : (
                <>
                  {/* History button */}
                  <button className="btn-ghost" onClick={() => setView('history')}>
                    <Database size={13} />
                    My History
                  </button>

                  {/* Voice Call button */}
                  {view === 'intake' && (
                    <button className="btn-primary" onClick={() => setView('call')} style={{ padding: '6px 12px', fontSize: 12 }}>
                      <Phone size={13} style={{ marginRight: 6 }} />
                      Voice Call
                    </button>
                  )}

                  {/* User pill */}
                  <div className="user-pill">
                    <div className="user-dot" />
                    <div>
                      <div className="user-name">{user.full_name || user.username}</div>
                      <div className="user-role">{user.role}</div>
                    </div>
                  </div>

                  <button className="btn-ghost" onClick={handleLogout} title="Sign out">
                    <LogOut size={13} />
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </nav>

      {/* ── Views ── */}
      <AnimatePresence mode="wait">
        {view === 'landing' && (
          <Landing key="landing" onStart={() => setView('auth')} />
        )}
        {view === 'auth' && (
          <Auth
            key="auth"
            onLoginSuccess={handleLoginSuccess}
            onBack={() => setView('landing')}
          />
        )}
        {view === 'intake' && user && (
          <IntakeChat
            key="intake"
            user={user}
            authToken={authToken}
            onReportReady={handleReportReady}
          />
        )}
        {view === 'call' && user && (
          <CallInterface
            key="call"
            user={user}
            authToken={authToken}
            onReportReady={(data) => {
              handleReportReady(data)
              setView('report')
            }}
            onEndCall={() => setView('intake')}
          />
        )}
        {view === 'report' && report && (
          <ReportView
            key="report"
            report={report}
            user={user}
            onNewSession={handleNewSession}
          />
        )}
        {view === 'history' && user && (
          <HistoryPage
            key="history"
            user={user}
            authToken={authToken}
            refreshTrigger={historyRefresh}
            onBack={() => setView('intake')}
            onAddHistory={() => setShowHistoryModal(true)}
          />
        )}
      </AnimatePresence>

      {/* ── History Modal ── */}
      <AnimatePresence>
        {showHistoryModal && (
          <HistoryModal
            user={user}
            authToken={authToken}
            onClose={() => setShowHistoryModal(false)}
            onSuccess={() => {
              setShowHistoryModal(false)
              setUser(prev => ({ ...prev, has_history: true }))
              setHistoryRefresh(prev => prev + 1)
              showToast('Medical history encoded successfully!')
            }}
          />
        )}
      </AnimatePresence>

      {/* ── Toast ── */}
      <AnimatePresence>
        {toast && (
          <motion.div
            className={`toast ${toast.type}`}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
          >
            {toast.msg}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/* ─────────────────────────────────────────────────────
   LANDING PAGE
   ───────────────────────────────────────────────────── */
function Landing({ onStart }) {
  return (
    <motion.div
      key="landing-page"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.5 }}
    >
      <div className="landing layer">
        {/* Background */}
        <div className="bg-grid" style={{ opacity: 0.4 }} />
        <div className="orb orb-1" />
        <div className="orb orb-2" />

        <motion.div
          className="eyebrow"
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.1 }}
        >
          <div className="eyebrow-dot" />
          AI Clinical Decision Support · GraphRAG + Vector RAG
        </motion.div>

        <motion.h1
          className="landing-title"
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          Your symptoms,<br />
          <em>understood deeply.</em>
        </motion.h1>

        <motion.p
          className="landing-sub"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.35 }}
        >
          HealBot Pro has a conversation with you, gathers your full symptom picture,
          and generates a structured doctor's consultation brief in under 60 seconds —
          powered by Neo4j GraphRAG and Pinecone medical vectors.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.45 }}
        >
          <button className="btn-primary" onClick={onStart}>
            Start consultation <ArrowRight size={16} />
          </button>
        </motion.div>

        <motion.div
          className="stats-row"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6 }}
        >
          <div className="stat-item">
            <span className="stat-n">284k</span>
            <span className="stat-l">Medical vectors</span>
          </div>
          <div className="stat-item">
            <span className="stat-n">18k</span>
            <span className="stat-l">Graph nodes</span>
          </div>
          <div className="stat-item">
            <span className="stat-n">&lt;60s</span>
            <span className="stat-l">Per report</span>
          </div>
          <div className="stat-item">
            <span className="stat-n">GraphRAG</span>
            <span className="stat-l">Architecture</span>
          </div>
        </motion.div>

        {/* Feature cards */}
        <motion.div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 20, marginTop: 80, width: '100%', maxWidth: 860,
          }}
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.7 }}
        >
          {[
            {
              icon: '💬',
              title: 'Conversational Intake',
              desc: 'MediAssist asks targeted follow-up questions to build a complete clinical picture.',
            },
            {
              icon: '🕸️',
              title: 'Knowledge Graph',
              desc: '18k node Neo4j graph maps symptoms to conditions via clinical relationships.',
            },
            {
              icon: '📚',
              title: 'Medical RAG',
              desc: '284k Pinecone vectors retrieve evidence-based clinical context for each case.',
            },
            {
              icon: '🩺',
              title: 'Doctor\'s Brief',
              desc: 'LLaMA-3 70B synthesises a structured consultation report for the physician.',
            },
          ].map(f => (
            <div
              key={f.title}
              className="glass"
              style={{ padding: '24px 20px', textAlign: 'left' }}
            >
              <div style={{ fontSize: 28, marginBottom: 12 }}>{f.icon}</div>
              <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 8 }}>{f.title}</div>
              <div style={{ fontSize: 14, color: 'var(--text-2)', lineHeight: 1.65 }}>{f.desc}</div>
            </div>
          ))}
        </motion.div>
      </div>
    </motion.div>
  )
}
