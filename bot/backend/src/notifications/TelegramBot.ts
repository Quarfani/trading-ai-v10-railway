import axios from 'axios';
import FormData from 'form-data';
import { Signal, SystemConfig, Trade } from '../types/trading.types';
import { Logger } from '../utils/Logger';
import { DiscordWebhook } from './DiscordWebhook';

export class TelegramBot {
  private logger = new Logger('Telegram');
  private discord = new DiscordWebhook();
  constructor(private config: SystemConfig) {}

  private get base() { return `https://api.telegram.org/bot${this.config.telegram.token}`; }

  async sendMessage(text: string): Promise<void> {
    this.discord.send(text.replace(/<[^>]+>/g, '')).catch(() => {});
    if (!this.config.telegram.token || !this.config.telegram.chatId) return;
    try {
      await axios.post(`${this.base}/sendMessage`,
        { chat_id: this.config.telegram.chatId, text, parse_mode: 'HTML' }, { timeout: 5000 });
    } catch (e: any) { this.logger.warn(`send failed: ${e.message}`); }
  }

  async sendPhoto(buffer: Buffer, caption: string): Promise<void> {
    if (!this.config.telegram.token || !this.config.telegram.chatId) return;
    try {
      // FormData statically imported above
      const form = new FormData();
      form.append('chat_id', this.config.telegram.chatId);
      form.append('caption', caption);
      form.append('photo', buffer, { filename: 'chart.png' });
      await axios.post(`${this.base}/sendPhoto`, form,
        { headers: form.getHeaders(), timeout: 15000 });
    } catch (e: any) { this.logger.warn(`photo failed: ${e.message}`); }
  }

  async notifySignal(s: Signal) {
    await this.sendMessage(
      `🔔 <b>SIGNAL</b>\n${s.symbol} <b>${s.side}</b>\n` +
      `Price: ${s.price}\nSL: ${s.sl}\nTP: ${s.tp}\n` +
      `Conf: ${(s.confidence*100).toFixed(0)}%\n${s.source}\n${s.reason}`);
  }

  async notifyTrade(t: Trade) {
    await this.sendMessage(
      `✅ <b>TRADE OPEN</b>\n${t.symbol} <b>${t.side}</b>\n` +
      `Vol: ${t.volume}\nEntry: ${t.entry}\nSL: ${t.sl}\nTP: ${t.tp}`);
  }

  async notifyClose(t: Trade) {
    const profit = t.profit ?? 0;
    const emoji = profit > 0 ? '💰' : '❌';
    await this.sendMessage(
      `${emoji} <b>TRADE CLOSED</b>\n${t.symbol} ${t.side}\n` +
      `Entry: ${t.entry}\nP/L: <b>${profit.toFixed(2)}</b>`);
  }
}
