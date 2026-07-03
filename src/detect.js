// Чистая классификация входящего RTM-сообщения: решает, нужно ли о нём уведомлять и каким видом.
// Никакой сети/таймеров/логгера — только логика «подходит ли сообщение под настройки».
// Это делает правило тривиально тестируемым (см. test/unit/detect.test.js) и отвязывает
// «что считать поводом для уведомления» от транспорта (PresenceKeeper).

// Slack кодирует канальные упоминания как <!here>, <!channel>, <!everyone> (иногда с |текстом).
const CHANNEL_WIDE_RE = /<!(here|channel|everyone)(\|[^>]*)?>/;

// classifyMessage(m, opts) -> { kind, keyword, channelType } если уведомлять, иначе null.
// opts: { myUserId, notifySelf, notifyDM, dmChannelPrefixes, notifyGroupDm,
//         notifyMentions, mentionChannelWide, notifyKeywords }
export function classifyMessage(m, opts) {
  if (m.subtype) return null; // правки/удаления/системные/ботовые
  if (!m.user || !m.text) return null;
  if (m.user === opts.myUserId && !opts.notifySelf) return null; // своё сообщение

  const ch = m.channel || '';
  const chType = m.channel_type; // 'im' | 'mpim' | 'channel' | 'group' | undefined
  const text = m.text;
  const lower = text.toLowerCase();

  // DM (1:1): по channel_type (надёжно) или по префиксу канала (запасной вариант).
  const isIM = chType === 'im' || (!chType && opts.dmChannelPrefixes.some((p) => ch.startsWith(p)));
  // Групповой DM (mpim): по channel_type или по префиксу 'G' как запасной вариант.
  const isMpim = chType === 'mpim' || (!chType && ch.startsWith('G'));

  const isDirectMention = Boolean(opts.myUserId && text.includes(`<@${opts.myUserId}>`));
  const isChannelWide = CHANNEL_WIDE_RE.test(text);
  const keyword = opts.notifyKeywords.find((k) => lower.includes(k));

  const wantDM = (opts.notifyDM && isIM) || (opts.notifyGroupDm && isMpim);
  const wantMention = opts.notifyMentions && (isDirectMention || (opts.mentionChannelWide && isChannelWide));
  const wantKeyword = Boolean(keyword);
  if (!wantDM && !wantMention && !wantKeyword) return null;

  // Приоритет вида уведомления: DM > упоминание > ключевое слово.
  let kind;
  if (wantDM) kind = isMpim && !isIM ? 'group_dm' : 'dm';
  else if (wantMention) kind = 'mention';
  else kind = 'keyword';

  const channelType = chType || (isIM ? 'im' : isMpim ? 'mpim' : 'channel');
  return { kind, keyword, channelType };
}
