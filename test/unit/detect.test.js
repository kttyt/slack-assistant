import { describe, test, expect } from 'vitest';
import { classifyMessage } from '../../src/detect.js';

// Чистая функция — тестируем напрямую, без сокета/фейков.
const DEFAULTS = {
  myUserId: 'U_ME',
  notifySelf: false,
  notifyDM: true,
  dmChannelPrefixes: ['D'],
  notifyGroupDm: false,
  notifyMentions: true,
  mentionChannelWide: false,
  notifyKeywords: [],
};
const classify = (m, over = {}) => classifyMessage(m, { ...DEFAULTS, ...over });

describe('classifyMessage — фильтрация и вид уведомления', () => {
  /**
   * Что: прямое @-упоминание.
   * Вход: сообщение в канале с <@U_ME> (дефолтные настройки).
   * Поведение: распознаётся личное упоминание.
   * Ожидаем: kind='mention'.
   */
  test('прямое упоминание -> mention', () => {
    expect(classify({ channel: 'C1', user: 'U2', text: 'эй <@U_ME>' }).kind).toBe('mention');
  });

  /**
   * Что: DM по префиксу канала.
   * Вход: канал 'D9' без channel_type.
   * Поведение: префикс 'D' => IM.
   * Ожидаем: kind='dm'.
   */
  test('DM по префиксу канала -> dm', () => {
    expect(classify({ channel: 'D9', user: 'U2', text: 'привет' }).kind).toBe('dm');
  });

  /**
   * Что: DM по channel_type.
   * Вход: канал без DM-префикса, но channel_type='im'.
   * Поведение: channel_type приоритетнее префикса.
   * Ожидаем: kind='dm', channelType='im'.
   */
  test('DM по channel_type=im -> dm', () => {
    const hit = classify({ channel: 'X1', channel_type: 'im', user: 'U2', text: 'йо' });
    expect(hit.kind).toBe('dm');
    expect(hit.channelType).toBe('im');
  });

  /**
   * Что: групповой DM выключен по умолчанию.
   * Вход: channel_type='mpim', notifyGroupDm=false.
   * Поведение: mpim не уведомляет, пока не включён.
   * Ожидаем: null.
   */
  test('mpim без groupDm -> null', () => {
    expect(classify({ channel: 'G1', channel_type: 'mpim', user: 'U2', text: 'всем' })).toBe(null);
  });

  /**
   * Что: групповой DM включён.
   * Вход: channel_type='mpim', notifyGroupDm=true.
   * Поведение: mpim уведомляет отдельным видом.
   * Ожидаем: kind='group_dm'.
   */
  test('mpim с groupDm -> group_dm', () => {
    expect(classify({ channel: 'G1', channel_type: 'mpim', user: 'U2', text: 'всем' }, { notifyGroupDm: true }).kind).toBe('group_dm');
  });

  /**
   * Что: канальные упоминания по умолчанию выключены.
   * Вход: текст с <!channel>, mentionChannelWide=false.
   * Поведение: @channel не считается поводом.
   * Ожидаем: null.
   */
  test('@channel без channelWide -> null', () => {
    expect(classify({ channel: 'C1', user: 'U2', text: '<!channel> сбор' })).toBe(null);
  });

  /**
   * Что: канальные упоминания включены.
   * Вход: текст с <!here>, mentionChannelWide=true.
   * Поведение: @here распознаётся как упоминание.
   * Ожидаем: kind='mention'.
   */
  test('@here с channelWide -> mention', () => {
    expect(classify({ channel: 'C1', user: 'U2', text: '<!here> апдейт' }, { mentionChannelWide: true }).kind).toBe('mention');
  });

  /**
   * Что: срабатывание по ключевому слову.
   * Вход: keywords=['deploy'], текст содержит 'Deploy' (иной регистр).
   * Поведение: сравнение без учёта регистра; совпавшее слово в результате.
   * Ожидаем: kind='keyword', keyword='deploy'.
   */
  test('ключевое слово -> keyword', () => {
    const hit = classify({ channel: 'C1', user: 'U2', text: 'starting Deploy now' }, { notifyKeywords: ['deploy'] });
    expect(hit.kind).toBe('keyword');
    expect(hit.keyword).toBe('deploy');
  });

  /**
   * Что: приоритет DM над упоминанием.
   * Вход: DM-канал И текст с <@U_ME>.
   * Поведение: при нескольких совпадениях выбирается DM.
   * Ожидаем: kind='dm'.
   */
  test('DM + упоминание -> приоритет dm', () => {
    expect(classify({ channel: 'D9', user: 'U2', text: 'смотри <@U_ME>' }).kind).toBe('dm');
  });

  /**
   * Что: игнор собственных и служебных сообщений.
   * Вход: своё сообщение (U_ME) и сообщение с subtype; плюс сообщение без текста.
   * Поведение: отсекаются до классификации.
   * Ожидаем: null во всех случаях.
   */
  test('своё сообщение / subtype / пустой текст -> null', () => {
    expect(classify({ channel: 'D9', user: 'U_ME', text: 'моё' })).toBe(null);
    expect(classify({ channel: 'C1', user: 'U2', text: 'правка <@U_ME>', subtype: 'message_changed' })).toBe(null);
    expect(classify({ channel: 'D9', user: 'U2', text: '' })).toBe(null);
  });
});
