import { useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowLeft, ShieldCheck } from 'lucide-react'
import { signInWithPopup } from 'firebase/auth'
import { auth, googleProvider } from '../firebase'

export default function Auth({ onLoginSuccess, onBack }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleGoogleSignIn = async () => {
    setLoading(true)
    setError('')
    try {
      googleProvider.setCustomParameters({ prompt: 'select_account' })
      const result = await signInWithPopup(auth, googleProvider)
      // The signed-in user info
      const user = result.user
      // Get the Firebase ID token
      const idToken = await user.getIdToken()
      
      // Pass the user info and token back to App.jsx
      // We map Firebase user properties to what the app expects
      onLoginSuccess({
        id: user.uid,
        username: user.email,
        full_name: user.displayName,
        role: 'patient'
      }, idToken)
      
    } catch (err) {
      console.error(err)
      setError(err.message || 'Authentication failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-page layer">
      <motion.div
        className="glass auth-card"
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        {/* Back */}
        <button className="btn-ghost" style={{ marginBottom: 28 }} onClick={onBack}>
          <ArrowLeft size={14} /> Back
        </button>

        {/* Icon */}
        <div style={{
          width: 52, height: 52,
          background: 'linear-gradient(135deg, var(--teal), #0d9488)',
          borderRadius: 14,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          marginBottom: 20,
        }}>
          <ShieldCheck size={26} color="#050a0a" />
        </div>

        <div className="auth-title">Welcome to HealBot</div>
        <div className="auth-sub">
          Sign in securely to access your AI medical assistant
        </div>

        {error && <div className="form-error" style={{marginTop: 10}}>{error}</div>}

        <button
          onClick={handleGoogleSignIn}
          className="btn-primary"
          style={{ width: '100%', justifyContent: 'center', marginTop: 24, background: '#ffffff', color: '#000' }}
          disabled={loading}
        >
          <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="G" style={{width: 18, marginRight: 8}} />
          {loading ? 'Signing in...' : 'Sign in with Google'}
        </button>
      </motion.div>
    </div>
  )
}
