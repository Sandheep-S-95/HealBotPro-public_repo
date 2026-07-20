/**
 * HistoryModal.jsx
 * Lets a patient encode their medical history into Pinecone
 * for enhanced future reports.
 */
import { useState } from 'react'
import { motion } from 'framer-motion'
import { X, Database } from 'lucide-react'
import axios from 'axios'

const API = import.meta.env.VITE_API_BASE || 'http://localhost:8002'

export default function HistoryModal({ user, authToken, onClose, onSuccess }) {
  const [text, setText] = useState('')
  const [file, setFile] = useState(null)
  const [loading, setLoading] = useState(false)
  const [loadingStage, setLoadingStage] = useState('') // 'reading' | 'encoding' | ''
  const [error, setError] = useState('')

  // Max PDF size: 4 MB (matches backend _MAX_PDF_BYTES guard)
  const MAX_PDF_MB = 4
  const MAX_PDF_BYTES = MAX_PDF_MB * 1024 * 1024

  const getErrorMessage = (err) => {
    const status = err.response?.status
    const detail = err.response?.data?.detail || err.message || ''

    if (status === 413 || detail.toLowerCase().includes('too large')) {
      return `PDF file is too large. Maximum allowed is ${MAX_PDF_MB} MB. Please compress it or split into smaller files.`
    }
    if (status === 400 && detail.toLowerCase().includes('scanned')) {
      return 'This PDF contains only scanned images with no readable text. Please use a text-based PDF or type your history manually.'
    }
    if (status === 400 && detail.toLowerCase().includes('password')) {
      return 'This PDF is password-protected. Please remove the password and try again, or type your history manually.'
    }
    if (status === 400 && detail.toLowerCase().includes('blank')) {
      return 'The PDF appears to be blank or empty. Please try a different file.'
    }
    if (status === 400 || detail.toLowerCase().includes('invalid file')) {
      return 'Could not read the PDF. Please try a different file or type your history manually.'
    }
    if (status === 504 || detail.toLowerCase().includes('too long')) {
      return 'The server timed out processing your PDF. Please try a shorter document.'
    }
    if (status === 500) {
      return `Server error: ${detail || 'An unexpected error occurred. Please try again.'}`
    }
    return detail || 'Failed to encode history. Please try again.'
  }

  const submit = async () => {
    if (!text.trim() && !file) return
    setLoading(true)
    setLoadingStage('')
    setError('')

    try {
      const uid = user?.username || user?.user_id || user?.id
      const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {}

      if (file) {
        // ── Client-side size guard ──────────────────────────────────────────
        if (file.size > MAX_PDF_BYTES) {
          setError(`PDF is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum allowed is ${MAX_PDF_MB} MB.`)
          setLoading(false)
          return
        }

        // ── Read file as base64 ─────────────────────────────────────────────
        setLoadingStage('reading')
        const base64Data = await new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.readAsDataURL(file)
          reader.onload = () => {
            // FileReader returns: "data:application/pdf;base64,<data>"
            // We take everything after the first comma
            const result = reader.result
            const commaIdx = result.indexOf(',')
            resolve(commaIdx !== -1 ? result.slice(commaIdx + 1) : result)
          }
          reader.onerror = () => reject(new Error('Failed to read PDF file.'))
        })

        // ── Upload to backend ───────────────────────────────────────────────
        setLoadingStage('encoding')
        await axios.post(`${API}/user/history/upload_pdf_base64`, {
          user_id: uid,
          filename: file.name,
          file_base64: base64Data
        }, { headers })

      } else {
        // Plain text path
        setLoadingStage('encoding')
        await axios.post(
          `${API}/user/history`,
          { user_id: uid, text },
          { headers }
        )
      }

      onSuccess()
    } catch (err) {
      console.error('History submit error:', err)
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
      setLoadingStage('')
    }
  }


  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(8,12,16,0.8)',
        backdropFilter: 'blur(10px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24, zIndex: 150,
      }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        className="glass"
        style={{ width: '100%', maxWidth: 480, padding: 32 }}
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Database size={18} color="var(--teal)" />
            <span style={{ fontWeight: 600, fontSize: 17 }}>Encode Medical History</span>
          </div>
          <button className="btn-ghost" style={{ padding: '6px 10px' }} onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <p style={{ fontSize: 14, color: 'var(--text-2)', marginBottom: 20, lineHeight: 1.7 }}>
          Enter any relevant medical history — past conditions, surgeries, chronic illnesses,
          family history, or current medications. This will be stored securely and used to
          improve future consultation reports.
        </p>

        <textarea
          style={{
            width: '100%', minHeight: 140, padding: '14px 16px',
            background: 'var(--bg-2)', border: '1px solid var(--border)',
            borderRadius: 12, color: 'var(--text)', fontSize: 15,
            fontFamily: 'var(--font-body)', resize: 'vertical', outline: 'none',
            lineHeight: 1.6, opacity: file ? 0.5 : 1
          }}
          placeholder="E.g. Diagnosed with Type 2 Diabetes in 2018. Currently on Metformin 500mg. Family history of hypertension. Appendectomy in 2012…"
          value={text}
          onChange={e => setText(e.target.value)}
          onFocus={e => e.target.style.borderColor = 'var(--teal)'}
          onBlur={e => e.target.style.borderColor = 'var(--border)'}
          disabled={!!file}
        />

        <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', background: 'var(--bg-2)', borderRadius: 12, border: '1px solid var(--border)' }}>
          <span style={{ fontSize: 13, color: 'var(--text-2)', fontWeight: 600 }}>OR UPLOAD PDF:</span>
          <input
            type="file"
            accept=".pdf"
            onChange={e => {
              setFile(e.target.files[0])
              if (e.target.files[0]) setText('')
            }}
            style={{ fontSize: 13, color: 'var(--text)' }}
          />
        </div>

        {error && (
          <div className="form-error" style={{ marginTop: 12 }}>{error}</div>
        )}

        <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
          <button
            className="btn-ghost"
            style={{ flex: 1, justifyContent: 'center' }}
            onClick={onClose}
            disabled={loading}
          >
            Cancel
          </button>
          <button
            className="btn-primary"
            style={{ flex: 1, justifyContent: 'center' }}
            disabled={loading || (!text.trim() && !file)}
            onClick={submit}
          >
            {loadingStage === 'reading'
              ? '📄 Reading PDF…'
              : loadingStage === 'encoding'
                ? '🔢 Encoding…'
                : 'Save to database'}
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}