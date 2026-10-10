/** UX audit 2026-10-03: strings added by the texts fixes. */
export default {
  // Project rhythm: lane reasons the SDK added for live conversation and user steering.
  '你正在对话，现在就跟进': 'You are in the conversation, so it follows up now',
  '你正在对话，几分钟内会跟进': 'You are in the conversation; it follows up within minutes',
  '你刚纠正或提出了改进，现在据此复盘': 'You just corrected it or asked for an improvement; reviewing that now',
  '你刚纠正或提出了改进，稍后据此复盘': 'You just corrected it or asked for an improvement; it reviews that shortly',
  // Host admission waits, mapped by reason in the web.
  '等待真实项目初始化': 'Waiting for real project setup',
  '项目尚未启用真实模型协作。': 'This project does not use real-model collaboration yet.',
  '等待项目初始化': 'Waiting for project setup',
  '项目能力初始化尚未完成，后台协作等待就绪。': 'Project capabilities are still being set up; background work waits until they are ready.',
  '后台暂缓 · 会话清理待完成': 'Background paused · session cleanup pending',
  '会话关联数据仍在清理，主动协作、定时交付与自动进化暂缓。清理完成后按原设置继续。': 'Data linked to a deleted conversation is still being cleaned up; proactive work, scheduled deliveries and self-evolution are paused and resume with your settings afterwards.',
  '当前模型仅支持交互式使用，请为后台协作选择支持自动运行的模型。': 'The current model is for interactive use only; choose a model that allows automatic runs for background work.',
  '项目后台模型配置不可用，请检查已选择的提供商、模型与推理档位。': "The project's background model setup is unavailable; check the selected provider, model and reasoning level.",
  '后台等待真实模型': 'Background waiting for a real model',
  '后台协作需要已配置的真实模型。': 'Background work needs a configured real model.',
  // Session-cleanup blockers in plain words.
  '有一份后台记录无法识别，等待核对后继续清理': 'A background record could not be recognized; cleanup continues after it is checked',
  '后台任务还在收尾，结束后继续清理': 'A background task is still finishing; cleanup continues when it ends',
  '会话清理还没完成': 'Session cleanup has not finished',
  '关联记录较多，正在分批清理': 'There are many linked records; cleaning up in batches',
  '有一条关联记录的位置无效，等待核对': 'A linked record has an invalid location; waiting for a check',
  '有一条关联记录是不安全的链接，等待核对': 'A linked record is an unsafe link; waiting for a check',
  '有一项会话清理需要你决定，详情在「已归档」里': 'A conversation cleanup needs your decision; see Archived for details',
  // Project mind: learning pause reasons.
  '有会话正在删除，相关证据清理完成前暂停': 'a conversation is being deleted; paused until its evidence is cleaned up',
  // Inbox: why a delivery was made quieter.
  '当时不适合打断你，先放进收件箱': 'It was not a good moment to interrupt you, so it went to the inbox',
  '你回来时消息较多，其余放进收件箱': 'Many messages were waiting when you came back; the rest went to the inbox',
  '已直接修正，在对话中等你确认': 'Fixed directly; waiting for your confirmation in the conversation',
} as const satisfies Record<string, string>
