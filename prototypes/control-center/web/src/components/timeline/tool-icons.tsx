import {
  Database, FilePen, FilePlus2, FileText, FolderOpen, Globe, Link2, ListChecks, MessageCircleQuestion, MonitorPlay,
  Plug, Puzzle, Search, SquareTerminal, Users, Wrench, type LucideIcon,
} from 'lucide-react'
import type { ViewKind } from '@/lib/tools'

export const TOOL_ICONS: Record<ViewKind, LucideIcon> = {
  read: FileText,
  list: FolderOpen,
  write: FilePlus2,
  edit: FilePen,
  search: Search,
  command: SquareTerminal,
  web_search: Globe,
  web_fetch: Link2,
  skill: Puzzle,
  mcp: Plug,
  browser: MonitorPlay,
  question: MessageCircleQuestion,
  plan: ListChecks,
  preview: MonitorPlay,
  agent: Users,
  memory: Database,
  other: Wrench,
}

export function ToolIcon({ kind, className }: { kind: ViewKind; className?: string }) {
  const Icon = TOOL_ICONS[kind] ?? Wrench
  return <Icon className={className} strokeWidth={1.7} />
}
