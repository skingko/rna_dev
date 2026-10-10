/** Deep links: inbox entries, digests and conversation positions. */
export default {
  '这段对话已不可用。': 'This conversation is no longer available.',
  '这条消息只在收件箱中，没有对应的对话位置。': 'This message was only filed in the inbox; it has no position in a conversation.',
  查看每日摘要: 'View daily digest', 在对话中定位: 'Show in conversation', 打开会话: 'Open conversation', 在收件箱查看: 'View in inbox',
} as const satisfies Record<string, string>
