import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { ArrowLeft, Clock, FileText, Database, RefreshCw } from 'lucide-react'
import axios from 'axios'
import ReactMarkdown from 'react-markdown'

const API = import.meta.env.VITE_API_BASE || 'http://localhost:8002'

export default function HistoryPage({ user, authToken, onBack, onAddHistory, refreshTrigger }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const fetchHistory = async (showLoading = true) => {
    if (showLoading) setLoading(true)
    try {
      const userId = user?.username || user?.user_id || user?.id
      const res = await axios.get(`${API}/user/${userId}/history`, {
        headers: { Authorization: `Bearer ${authToken}` }
      })
      setData(res.data)
      setError(null)
    } catch (err) {
      setError('Failed to load medical history.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    // When a new record is added, wait a bit for Pinecone to index
    if (refreshTrigger > 0) {
      setLoading(true)
      setTimeout(() => fetchHistory(false), 2500)
    } else {
      fetchHistory()
    }
  }, [user, authToken, refreshTrigger])

  return (
    <motion.div
      key="history-page"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className="page"
      style={{ paddingTop: 100, paddingBottom: 60 }}
    >
      <div className="container" style={{ maxWidth: 860 }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 32 }}>
          <div>
            <button className="btn-ghost" onClick={onBack} style={{ marginBottom: 16 }}>
              <ArrowLeft size={14} style={{ marginRight: 6 }} /> Back to Dashboard
            </button>
            <h1 style={{ margin: 0, fontSize: 28, fontWeight: 600 }}>My Medical History</h1>
            <p style={{ color: 'var(--text-2)', marginTop: 8, fontSize: 15 }}>
              Your encoded history and AI-generated clinical summary.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <button className="btn-ghost" onClick={() => fetchHistory(true)} title="Refresh data">
              <RefreshCw size={14} />
            </button>
            <button className="btn-primary" onClick={onAddHistory}>
              <Database size={14} style={{ marginRight: 6 }} />
              Add New Record
            </button>
          </div>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-2)' }}>
            <div className="spinner" style={{ margin: '0 auto 16px' }} />
            Loading your history...
          </div>
        ) : error ? (
          <div className="form-error">{error}</div>
        ) : (
          <div style={{ display: 'grid', gap: 24 }}>
            {/* AI Summary Card */}
            <div className="glass" style={{ padding: 32, borderTop: '3px solid var(--teal)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
                <FileText size={20} color="var(--teal)" />
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>AI Clinical Summary</h2>
              </div>
              <div className="markdown-body">
                <ReactMarkdown>{data.ai_summary}</ReactMarkdown>
              </div>
            </div>

            {/* Timeline */}
            <div>
              <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16, marginTop: 12 }}>
                Raw Encoded Records ({data.history.length})
              </h3>
              {data.history.length === 0 ? (
                <div className="glass" style={{ padding: 24, textAlign: 'center', color: 'var(--text-2)' }}>
                  No history records found.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {data.history.map((item, idx) => (
                    <div key={idx} className="glass" style={{ padding: 20 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-2)', fontSize: 13, marginBottom: 8 }}>
                        <Clock size={13} />
                        {item.date}
                      </div>
                      <div style={{ fontSize: 15, lineHeight: 1.6 }}>
                        {item.text}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </motion.div>
  )
}
