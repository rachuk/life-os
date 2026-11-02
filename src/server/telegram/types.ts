/**
 * The subset of the Telegram Bot API update objects the bot reads. Everything is treated as
 * untrusted input: fields are optional unless Telegram guarantees them, and handlers check shapes.
 */
export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
  language_code?: string;
}

export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel' | string;
  username?: string;
}

export interface TgFile {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
}

export interface TgPhotoSize extends TgFile {
  width: number;
  height: number;
}

export interface TgVoice extends TgFile {
  duration?: number;
  mime_type?: string;
}

export interface TgDocument extends TgFile {
  file_name?: string;
  mime_type?: string;
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  voice?: TgVoice;
  audio?: TgVoice;
  video_note?: TgVoice;
  document?: TgDocument;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgChatMemberUpdated {
  chat: TgChat;
  from: TgUser;
  new_chat_member?: { status?: string };
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
  my_chat_member?: TgChatMemberUpdated;
}

export function isUpdate(v: unknown): v is TgUpdate {
  return !!v && typeof v === 'object' && Number.isSafeInteger((v as { update_id?: unknown }).update_id);
}
