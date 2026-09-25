import axios from 'axios';
import { Logger } from '../utils/Logger';

/** Optional Discord mirror — set DISCORD_WEBHOOK_URL in .env to enable. */
export class DiscordWebhook {
  private logger = new Logger('Discord');
  private url = process.env.DISCORD_WEBHOOK_URL ?? '';

  enabled() { return !!this.url; }

  async send(text: string): Promise<void> {
    if (!this.enabled()) return;
    try { await axios.post(this.url, { content: text }, { timeout: 5000 }); }
    catch (e: any) { this.logger.warn(`discord failed: ${e.message}`); }
  }
}
