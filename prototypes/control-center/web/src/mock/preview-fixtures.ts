/* Mock workspace files for the file preview (components/preview): one small
   fixture per format. Text fixtures join the mock file tree (`files`); binary
   ones are built on demand so the mock bundle stays small. */

export const DAILY_REPORT_PATH = 'reports/2026-09-28/daily.md'
export const PYTHON_PATH = 'scripts/analyze_fps.py'

export const DAILY_REPORT = `# 水墨飞鸟 · 每日报告（2026-09-28）

> 今日回归 **16/16** 通过；Redmi 9 帧率仍低于目标，已定位到透明排序。

## 概览

| 指标 | 昨日 | 今日 | 变化 |
| --- | ---: | ---: | :---: |
| 平均帧率（Redmi 9） | 38 fps | 41 fps | ▲ 3 |
| 首屏时间 | 1.92 s | 1.64 s | ▼ 0.28 |
| 包体积 | 612 kB | 598 kB | ▼ 14 kB |
| 回归用例 | 15/16 | 16/16 | ✅ |

## 完成事项

- [x] 芦苇穗头改为实例化渲染
- [x] HUD 分数印章层级修复（\`z-index: 30\`）
- [ ] 透明排序改为深度预排序
- [ ] 390px 宽度下的长路径截断复查

## 帧率分析

透明物体每帧重新排序，占用约 **4.1 ms**。分析脚本：\`scripts/analyze_fps.py\`，原始数据见 \`../../data/fps.csv\`。

\`\`\`python
def frame_budget(fps: float) -> float:
    return 1000.0 / fps
\`\`\`

![帧率趋势](../../shots/fps_trend.png)

## 风险

1. 实例化后 **iOS Safari 15** 需要回归一次。
2. 深度预排序可能影响半透明墨迹的叠加顺序。

---

*由 Rna 自动生成 · 下次报告：明天 09:00*
`

export const PYTHON = `"""Summarize per-device frame times from the nightly capture."""
from __future__ import annotations

import csv
import statistics
from dataclasses import dataclass
from pathlib import Path

TARGET_FPS = 55.0


@dataclass(frozen=True)
class Sample:
    device: str
    frame_ms: float


def load(path: Path) -> list[Sample]:
    with path.open(newline="", encoding="utf-8") as handle:
        return [Sample(row["device"], float(row["frame_ms"])) for row in csv.DictReader(handle)]


def summarize(samples: list[Sample]) -> dict[str, float]:
    by_device: dict[str, list[float]] = {}
    for sample in samples:
        by_device.setdefault(sample.device, []).append(sample.frame_ms)
    # Report the median fps so a single hitch does not dominate.
    return {device: round(1000 / statistics.median(times), 1) for device, times in by_device.items()}


if __name__ == "__main__":
    for device, fps in summarize(load(Path("data/fps.csv"))).items():
        flag = "OK" if fps >= TARGET_FPS else "SLOW"
        print(f"{device:<12} {fps:>6.1f} fps  {flag}")
`

export const JSON_CONFIG = JSON.stringify({
  name: 'ink-bird',
  version: '0.12.0',
  render: { antialias: true, pixelRatio: [1, 2], shadows: false, ink: { opacity: 0.6, bleed: 0.18, palette: ['#1d1a17', '#3c3833', '#9a3730'] } },
  levels: [
    { id: 'reed-marsh', length: 1200, bridges: 14, boss: false },
    { id: 'ink-cliff', length: 1800, bridges: 22, boss: true },
  ],
  telemetry: { enabled: true, sampleRate: 0.1, endpoint: null },
}, null, 2) + '\n'

export const CSV = `device,scene,frame_ms,draw_calls,memory_mb
Redmi 9,reed-marsh,24.4,182,312
Redmi 9,ink-cliff,26.1,204,338
Pixel 7,reed-marsh,11.2,182,280
Pixel 7,ink-cliff,12.9,204,301
iPhone 13,reed-marsh,9.8,176,254
iPhone 13,ink-cliff,10.6,198,266
"MacBook Air, M2",reed-marsh,6.9,176,420
"MacBook Air, M2",ink-cliff,7.4,198,436
`

export const HTML_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>墨跃 · 关卡说明</title>
  <style>
    body { font: 15px/1.7 -apple-system, "PingFang SC", sans-serif; margin: 0; background: #f3efe6; color: #1d1a17; }
    header { padding: 28px 32px 12px; border-bottom: 1px solid #d8d0c0; }
    h1 { margin: 0; font-size: 22px; letter-spacing: .04em; }
    main { padding: 20px 32px; display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 14px; }
    .card { background: #fffdf8; border-radius: 10px; padding: 14px 16px; box-shadow: 0 1px 2px rgba(0,0,0,.06); }
    .seal { color: #9a3730; font-weight: 600; }
  </style>
</head>
<body>
  <header><h1>墨跃 · 关卡说明</h1><p>跳跃时留下的墨痕会变成可以落脚的桥。</p></header>
  <main>
    <div class="card"><b>芦苇沼泽</b><p>14 座墨桥，节奏舒缓。</p></div>
    <div class="card"><b>墨崖</b><p>22 座墨桥，<span class="seal">含首领</span>。</p></div>
    <div class="card"><b>雨巷</b><p>筹备中。</p></div>
  </main>
  <script>document.body.dataset.scripted = 'yes'; alert('scripts must not run in preview')</script>
</body>
</html>
`

/** Text fixtures merged into the mock workspace tree. */
export const previewTextFiles: Record<string, string> = {
  [DAILY_REPORT_PATH]: DAILY_REPORT,
  [PYTHON_PATH]: PYTHON,
  'config/game.json': JSON_CONFIG,
  'data/fps.csv': CSV,
  'docs/levels.html': HTML_PAGE,
  'notes/todo.txt': '明天：\n- 复查 iOS Safari 15 的实例化渲染\n- 深度预排序原型\n',
}

/** Binary fixtures (built lazily) with their approximate listing sizes. */
export const previewBinarySizes: Record<string, number> = {
  'shots/fps_trend.png': 18_400,
  'shots/ui_start.png': 21_000,
  'docs/level-design.pdf': 1_100,
  'data/fps.xlsx': 16_800,
  'docs/brief.docx': 48_200,
  'assets/ink-brush.bin': 4_096,
}

async function chartPng(title: string, seed: number): Promise<Blob> {
  const width = 720, height = 405
  if (typeof OffscreenCanvas === 'undefined') return new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' })
  const canvas = new OffscreenCanvas(width, height)
  const g = canvas.getContext('2d')!
  g.fillStyle = '#f7f4ec'; g.fillRect(0, 0, width, height)
  g.fillStyle = '#1d1a17'; g.font = '600 22px -apple-system, sans-serif'; g.fillText(title, 32, 48)
  g.strokeStyle = '#d8d0c0'; g.lineWidth = 1
  for (let i = 0; i < 5; i++) { const y = 100 + i * 60; g.beginPath(); g.moveTo(32, y); g.lineTo(width - 32, y); g.stroke() }
  const series = [[38, 39, 37, 40, 41, 43, 41, 44], [52, 55, 56, 55, 58, 59, 60, 61]]
  const colors = ['#9a3730', '#2f5d8a']
  series.forEach((values, s) => {
    g.strokeStyle = colors[s]; g.lineWidth = 3; g.beginPath()
    values.forEach((v, i) => { const x = 48 + i * ((width - 96) / (values.length - 1)); const y = 340 - (v - 30 + seed) * 7; if (i) g.lineTo(x, y); else g.moveTo(x, y) })
    g.stroke()
  })
  return canvas.convertToBlob({ type: 'image/png' })
}

/** A minimal one-page PDF (Helvetica, ASCII text) with a correct xref table. */
function pdf(): Blob {
  const text = ['Ink Bird - Level design brief', 'Reed marsh: 14 ink bridges, calm rhythm.', 'Ink cliff: 22 ink bridges, boss encounter.', 'Frame budget target: 18 ms on Redmi 9.']
  const stream = `BT /F1 20 Tf 72 740 Td (${text[0]}) Tj /F1 12 Tf 0 -36 Td (${text[1]}) Tj 0 -20 Td (${text[2]}) Tj 0 -20 Td (${text[3]}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${object}\nendobj\n` })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Blob([body], { type: 'application/pdf' })
}

async function xlsx(): Promise<Blob> {
  const XLSX = await import('xlsx')
  const book = XLSX.utils.book_new()
  const rows = CSV.trim().split('\n').slice(1).map(line => {
    const cells = line.match(/("[^"]*"|[^,]+)/g)!.map(c => c.replace(/^"|"$/g, ''))
    return [cells[0], cells[1], Number(cells[2]), Number(cells[3]), Number(cells[4])]
  })
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['设备', '场景', '帧耗时 (ms)', 'Draw calls', '内存 (MB)'], ...rows]), '帧率')
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['日期', '回归通过', '回归总数'], ['2026-09-26', 14, 16], ['2026-09-27', 15, 16], ['2026-09-28', 16, 16]]), '回归')
  const out = XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}

const TEXT_TYPES: Record<string, string> = { md: 'text/markdown', json: 'application/json', csv: 'text/csv', html: 'text/html', py: 'text/x-python', txt: 'text/plain' }

/** Mock `/file/raw`: complete bytes for any fixture, or null when absent. */
export async function mockFileBlob(path: string): Promise<Blob | null> {
  if (path === 'shots/fps_trend.png') return chartPng('Redmi 9 / Pixel 7 · FPS trend', 0)
  if (path === 'shots/ui_start.png') return chartPng('Ink Bird · start screen', 4)
  if (path === 'docs/level-design.pdf') return pdf()
  if (path === 'data/fps.xlsx') return xlsx()
  if (path === 'docs/brief.docx') return new Blob([new Uint8Array(64)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
  if (path === 'assets/ink-brush.bin') return new Blob([new Uint8Array(4096)], { type: 'application/octet-stream' })
  const { files } = await import('./project-fixtures')
  const text = files[path]
  if (text === undefined) return null
  return new Blob([text], { type: `${TEXT_TYPES[path.split('.').at(-1) ?? ''] ?? 'text/plain'}; charset=utf-8` })
}
