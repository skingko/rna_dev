/** UX audit 2026-10-03: strings added by the nav fixes. */
export default {
  '这段对话已归档，恢复后才能在里面继续。': 'This conversation is archived. Restore it to continue there.',
  '这段对话所在的项目已归档，恢复后才能在里面继续。': 'This conversation’s project is archived. Restore it to continue there.',
  '原消息已不在对话中，已打开它所在的会话。': 'The original message is no longer in the conversation, so its conversation was opened instead.',
  '后台那项工作已经核对，可以重试刚才的请求。': 'The background work has been reviewed. You can retry the request now.',
  '后台有一项工作被打断，结果还没核对；核对之后才能继续这里的请求。': 'Background work was interrupted and its result hasn’t been reviewed yet. Review it to continue this request.',
  去核对: 'Review',
  '我之前说过要“{text}”，还要做吗？': 'I said I would “{text}”. Should I still do it?',
  '“{text}”还没做完，要我接着做吗？': '“{text}” isn’t done yet. Should I carry on?',
  '急停或更新结束后，会在输入框上方逐件问你。': 'Once the emergency stop or update ends, each one will be asked above the composer.',
  '这段对话暂停着，恢复后会在输入框上方逐件问你。': 'This conversation is paused. Once it resumes, each one will be asked above the composer.',
  '后台工作刚才还在停下，这一轮没有动工作区；现在可以重试。': 'Background work was still stopping, so this turn didn’t touch the workspace. You can retry now.',
  '另有 {n} 条来自已归档的对话，在收件箱里查看。': '{n} more from archived conversations {n|is|are} in the inbox.',
  '找不到项目文件夹，它可能被移动、改名或删除了。放回原处后再重试。': 'The project folder can’t be found. It may have been moved, renamed or deleted. Put it back, then retry.',
  '查看文件夹路径': 'Show folder path',
} as const satisfies Record<string, string>
