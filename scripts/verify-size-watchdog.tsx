/**
 * Size watchdog regression (issue #1578): the Windows/Electron host runs the
 * CLI under ELECTRON_RUN_AS_NODE, which never delivers the tty 'resize'
 * event (and aborts on the tty handle's getWindowSize), so a window resize
 * is invisible to the renderer and per-cell diffs leave the reflowed screen
 * misaligned. The watchdog polls XTWINOPS 18 t instead; a changed answer must
 * re-layout and fully repaint at the reported size without any resize event.
 *
 * This drives the poll path end to end: the fake stdout keeps stale
 * columns/rows throughout (the broken host's behavior), the reply is fed
 * through the real stdin parser and querier, and the painted screen must
 * switch to the reported size.
 *
 * Run: node --import tsx/esm scripts/verify-size-watchdog.tsx
 */
process.env.DSH_TUI_SIZE_WATCHDOG = '1'
process.env.NODE_ENV = 'production'
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

import React from 'react'
import { PassThrough, Writable } from 'node:stream'
import xterm from '@xterm/headless'
import { render, AlternateScreen, Text, useTerminalSize } from '../src/ui.js'
import { ERASE_SCREEN } from '../src/ink/termio/csi.js'
import { settled, viewportLines } from './lib/term-test.mjs'

const COLS = 100
const ROWS = 30
const term = new xterm.Terminal({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
const screens: string[][] = []
let raw = ''

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
    raw += String(chunk)
    term.write(String(chunk), () => {
      screens.push(viewportLines(term))
      cb()
    })
  }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_c: unknown, _e: BufferEncoding, cb: () => void) {
    cb()
  }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() {
    return this
  }
  ref() {
    return this
  }
  unref() {
    return this
  }
}

function SizeProbe() {
  const { columns, rows } = useTerminalSize()
  return <Text>{`SIZE ${columns}x${rows}`}</Text>
}

let failed = 0
function check(name: string, ok: boolean) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`)
  if (!ok) failed += 1
}
const painted = () => screens.at(-1)?.join('\n') ?? ''

const stdout = new FakeStdout()
const stdin = new FakeStdin()
const app = await render(
  <AlternateScreen>
    <SizeProbe />
  </AlternateScreen>,
  {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false,
    patchConsole: false,
  },
)

check('初始帧按 100x30 布局', await settled(() => painted().includes('SIZE 100x30')))
check('看门狗发出 CSI 18 t 查询', await settled(() => raw.includes('\x1b[18t')))

// Answer XTWINOPS 18 t: CSI 8;rows;cols t → 20 rows, 60 columns. The fake
// stdout keeps reporting 100x30 (stale, exactly like the Electron host).
const responseAt = raw.length
stdin.write('\x1b[8;20;60t')
// 假终端没有 VT 引擎：补一条 DA1 应答，释放 querier 的 flush 哨兵（真实终端会答）。
stdin.write('\x1b[?1;2c')
check('无 resize 事件时按终端应答重排为 60x20', await settled(() => painted().includes('SIZE 60x20')))
check('重排走清屏 + 全量重绘', raw.slice(responseAt).includes(ERASE_SCREEN))

app.unmount()
process.exit(failed > 0 ? 1 : 0)
