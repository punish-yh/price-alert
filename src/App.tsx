import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Toaster } from '@/components/ui/sonner'
import { api } from '@/lib/api'
import Dashboard from '@/pages/Dashboard'
import Login from '@/pages/Login'

export default function App() {
  const [user, setUser] = useState<string | null>(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    api
      .me()
      .then((r) => setUser(r.username))
      .catch(() => setUser(null))
      .finally(() => setChecking(false))
    const onExpired = () => setUser(null)
    window.addEventListener('auth:expired', onExpired)
    return () => window.removeEventListener('auth:expired', onExpired)
  }, [])

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        正在检查登录状态…
      </div>
    )
  }

  return (
    <>
      {user ? (
        <Dashboard username={user} onLogout={() => setUser(null)} />
      ) : (
        <Login onLogin={(u) => setUser(u)} />
      )}
      <Toaster richColors position="top-center" />
    </>
  )
}
