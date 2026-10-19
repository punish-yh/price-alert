// 同时启动前端 (vite) 与后端 (uvicorn)，并把 npm run dev -- 的 CLI 参数（如 --port）转发给 vite
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const isWin = process.platform === 'win32'
const py = resolve(isWin ? '.venv/Scripts/python.exe' : '.venv/bin/python')
const cliArgs = process.argv.slice(2) // 转发 --port / --host 等参数给 vite

const children = []
let shuttingDown = false

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const c of children) {
    try {
      c.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }
  process.exit(code)
}

function run(name, cmd, args, useShell = false) {
  const child = spawn(cmd, args, { stdio: 'inherit', shell: useShell })
  children.push(child)
  child.on('exit', (code) => {
    if (!shuttingDown) {
      console.log(`[dev] ${name} 进程退出 (${code})，正在停止另一个进程…`)
      shutdown(code ?? 0)
    }
  })
  child.on('error', (err) => {
    console.error(`[dev] ${name} 启动失败:`, err.message)
    shutdown(1)
  })
  return child
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

if (existsSync(py)) {
  run('api', py, ['-m', 'uvicorn', 'backend.main:app', '--host', '127.0.0.1', '--port', '8787'])
} else {
  console.warn('[dev] 未找到 .venv，仅启动前端；后端请先创建虚拟环境并安装 backend/requirements.txt')
}
run('web', process.execPath, [resolve('node_modules/vite/bin/vite.js'), ...cliArgs])
