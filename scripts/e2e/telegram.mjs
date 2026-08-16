/**
 * Sign Telegram `initData` the way Telegram does.
 *
 * The bot token stays in this process. Only the resulting `initData`
 * string is handed to the page, so the browser never holds the secret
 * that authenticates a Mini App launch.
 */
import { createHmac } from 'node:crypto';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? 'test-bot-token-for-verification-only';

export function sign(params) {
  const search = new URLSearchParams(params);
  const dataCheckString = [...search.entries()]
    .filter(([k]) => k !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  search.set('hash', createHmac('sha256', secret).update(dataCheckString).digest('hex'));
  return search.toString();
}
