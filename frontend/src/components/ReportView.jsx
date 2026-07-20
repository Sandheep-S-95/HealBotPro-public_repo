/**
 * ReportView.jsx
 * Displays the AI-generated doctor's consultation report
 * with extracted symptoms, diseases, and the full report body.
 */
import { motion } from 'framer-motion'
import { FileText, RefreshCcw, Download, Clock, Activity } from 'lucide-react'
import ReactMarkdown from 'react-markdown'

export default function ReportView({ report, user, onNewSession }) {
  const timestamp = new Date().toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })

  const handlePrint = () => window.print()

  return (
    <motion.div
      className="report-view layer"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
    >
      {/* Header */}
      <div className="report-header">
        <div className="report-eyebrow">AI Consultation Report · HealBot Pro</div>
        <h1 className="report-title">Doctor's Consultation Brief</h1>
        <div className="report-meta">
          <span className="report-meta-item">
            <Activity size={12} />
            Patient: {user?.full_name || user?.username || 'Guest'}
          </span>
          <span className="report-meta-item">
            <Clock size={12} />
            Generated: {timestamp}
          </span>
          <span className="report-meta-item">
            <FileText size={12} />
            ID: HB-{Math.random().toString(36).slice(2, 9).toUpperCase()}
          </span>
        </div>
      </div>

      {/* Findings grid */}
      <div className="report-findings">
        <div className="findings-card" style={{ background: 'var(--amber-dim)', border: '1px solid rgba(251,191,36,0.2)' }}>
          <div className="findings-label" style={{ color: 'var(--amber)' }}>
            Extracted Symptoms
          </div>
          <div className="tags-wrap">
            {report.symptoms?.length > 0
              ? report.symptoms.map(s => (
                  <span key={s} className="tag tag-amber">{s}</span>
                ))
              : <span style={{ fontSize: 13, color: 'var(--text-3)' }}>None detected</span>
            }
          </div>
        </div>

        <div className="findings-card" style={{ background: 'var(--teal-dim)', border: '1px solid var(--teal-glow)' }}>
          <div className="findings-label" style={{ color: 'var(--teal)' }}>
            Graph-Matched Conditions
          </div>
          <div className="tags-wrap">
            {report.diseases?.length > 0
              ? report.diseases.map(d => (
                  <span key={d} className="tag tag-teal">{d}</span>
                ))
              : <span style={{ fontSize: 13, color: 'var(--text-3)' }}>No direct graph matches</span>
            }
          </div>
        </div>
      </div>

      {/* Report body */}
      <div className="report-body">
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 10,
            marginBottom: 24, paddingBottom: 16,
            borderBottom: '1px solid var(--border)',
          }}
        >
          <div style={{
            width: 36, height: 36, borderRadius: 9,
            background: 'var(--teal-dim)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <FileText size={16} color="var(--teal)" />
          </div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Clinical Assessment</div>
            <div style={{ fontSize: 12, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
              GraphRAG · Pinecone · LLaMA-3 70B
            </div>
          </div>
        </div>

        <div className="report-text">
          <ReactMarkdown className="markdown-body">{report.report}</ReactMarkdown>
        </div>
      </div>

      {/* Actions */}
      <div className="report-actions">
        <button className="btn-primary" onClick={onNewSession}>
          <RefreshCcw size={15} />
          New consultation
        </button>
        <button className="btn-ghost" onClick={handlePrint}>
          <Download size={15} />
          Print / Save PDF
        </button>
      </div>

      {/* Disclaimer note */}
      <div style={{
        marginTop: 32,
        padding: '16px 20px',
        background: 'var(--rose-dim)',
        border: '1px solid rgba(251,113,133,0.2)',
        borderRadius: 12,
        fontSize: 13,
        color: 'rgba(251,113,133,0.8)',
        lineHeight: 1.7,
      }}>
        ⚕️ <strong>Disclaimer:</strong> This report is an AI-generated pre-consultation brief intended to assist the physician.
        It is NOT a diagnosis. All findings must be reviewed and confirmed by a qualified medical professional.
      </div>
    </motion.div>
  )
}
