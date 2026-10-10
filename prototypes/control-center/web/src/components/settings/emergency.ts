/**
 * The global emergency stop, shared by 设置 → 通用 and the top bar menu: the same second step before it stops, the
 * same words and the same request. The host switches off each project's 主动协作 and schedules and marks them
 * `pausedByEmergency`; releasing switches exactly those back on (contract C-h). Paused sessions stay paused.
 */
import { panelsApi } from '@/api/panels'
import { useApp } from '@/store/app-store'
import { reloadGlobals } from './globals-store'
import { t } from '@/i18n'

export const emergencyText = {
  /** The second step: what a confirmed stop halts. */
  confirm: () => t('确认后会立即停下：所有正在运行的对话、后台工作、各项目的主动协作和定时交付。草稿、队列和进度都会保留。'),
  on: () => t('急停已开启。解除后，因急停关闭的主动协作和定时交付会自动恢复；暂停的会话需要你手动继续。'),
  released: () => t('急停已解除。因急停关闭的主动协作和定时交付已恢复；暂停的会话可按需手动继续。'),
}

/** Turn the stop on or off; resolves to the line that says what happened. */
export async function setEmergency(stop: boolean) {
  await panelsApi.emergency(stop)
  useApp.setState({ emergency: stop })
  await reloadGlobals()
  return stop ? emergencyText.on() : emergencyText.released()
}
