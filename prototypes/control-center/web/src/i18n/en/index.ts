/**
 * English catalog, split by area to keep merges small. Keys are the zh-CN
 * source strings; the merged object's keys define `MessageKey`.
 */
import common from './common'
import links from './links'
import archive from './archive'
import memory from './memory'
import settings from './settings'
import projects from './projects'
import evolution from './evolution'
import evolutionObservability from './evolution-observability'
import sweep1 from './sweep1'
import sweep2 from './sweep2'
import jev from './jev'
import workbench from './workbench'
import mind from './mind'
import preview from './preview'
import sidepanel from './sidepanel'
import tasks from './tasks'
import planRemaining from './plan-remaining'
import uxComposer from './ux-composer'
import uxTimeline from './ux-timeline'
import uxRuntime from './ux-runtime'
import uxAgents from './ux-agents'
import uxBackground from './ux-background'
import uxMind from './ux-mind'
import uxTasks from './ux-tasks'
import uxNav from './ux-nav'
import uxSettings from './ux-settings'
import uxTexts from './ux-texts'
import uxMisc from './ux-misc'
import workspace from './workspace'
import backgroundPanel from './background-panel'

export const en = {
  ...tasks,
  ...planRemaining,
  ...mind,
  ...common,
  ...links,
  ...archive,
  ...memory,
  ...settings,
  ...projects,
  ...evolution,
  ...evolutionObservability,
  ...sweep1,
  ...sweep2,
  ...jev,
  ...workbench,
  ...preview,
  ...sidepanel,
  ...uxComposer,
  ...uxTimeline,
  ...uxRuntime,
  ...uxAgents,
  ...uxBackground,
  ...uxMind,
  ...uxTasks,
  ...uxNav,
  ...uxSettings,
  ...uxTexts,
  ...uxMisc,
  ...workspace,
  ...backgroundPanel,
}
