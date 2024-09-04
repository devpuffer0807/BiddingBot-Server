import WebSocket from 'ws';
import { EventEmitter } from 'events';

// Color constants
const GREEN = '\x1b[32m';
const BLUE = '\x1b[34m';
const YELLOW = '\x1b[33m';
const MAGENTA = '\x1b[35m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

export default class ClientWebSocketAdapter extends EventEmitter {
  private ws!: WebSocket;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private retryCount = 0;
  private MAX_RETRIES = 5;
  private subscriptions: Set<string> = new Set();

  constructor(private url: string) {
    super();
  }

  public connect() {
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      console.log(GREEN + 'Connected to the proxy WebSocket server' + RESET);
      this.retryCount = 0;
      this.emit('open');

      // Resubscribe to all previous subscriptions
      this.subscriptions.forEach(marketplace => {
        this.subscribe(marketplace);
      });
    });

    this.ws.on('message', (data) => {
      const message = JSON.parse(data.toString());
      console.log(JSON.stringify(message, null, 2));
    });

    this.ws.on('error', (error) => {
      console.error(RED + 'WebSocket error:' + RESET, error);
      this.emit('error', error);
    });

    this.ws.on('close', (code, reason) => {
      console.log(YELLOW + `WebSocket closed with code ${code}. Reason: ${reason}` + RESET);
      this.emit('close', code, reason);
      this.attemptReconnect();
    });
  }

  private attemptReconnect() {
    if (this.retryCount < this.MAX_RETRIES) {
      const delay = Math.pow(2, this.retryCount) * 1000;
      console.log(YELLOW + `Attempting to reconnect in ${delay / 1000} seconds...` + RESET);
      this.reconnectTimeout = setTimeout(() => this.connect(), delay);
      this.retryCount++;
    } else {
      console.log(RED + 'Max retries reached. Giving up on reconnecting.' + RESET);
      this.emit('reconnectFailed');
    }
  }

  public subscribe(marketplace: string) {
    this.subscriptions.add(marketplace);
    if (this.ws.readyState === WebSocket.OPEN) {
      const subscribeMessage = { type: 'subscribe', marketplace };
      console.log(MAGENTA + 'Sending subscription:' + RESET, subscribeMessage);
      this.ws.send(JSON.stringify(subscribeMessage));
    } else {
      console.warn(YELLOW + `WebSocket is not open. Will subscribe to ${marketplace} when connected.` + RESET);
    }
  }

  public close() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }
    this.ws.close();
    this.removeAllListeners();
  }

  public sendMessage(marketplace: string, message: any) {
    const wrappedMessage = {
      type: 'message',
      marketplace,
      data: message
    };

    const sendWithRetry = (retries = 3, delay = 1000) => {
      if (this.ws.readyState === WebSocket.OPEN) {
        console.log(MAGENTA + 'Sending message:' + RESET, wrappedMessage);
        this.ws.send(JSON.stringify(wrappedMessage));
      } else if (retries > 0) {
        console.warn(YELLOW + `WebSocket is not open. Retrying in ${delay}ms...` + RESET);
        setTimeout(() => sendWithRetry(retries - 1, delay * 2), delay);
      } else {
        console.error(RED + `Failed to send message to ${marketplace} after multiple retries.` + RESET);
      }
    };

    sendWithRetry();
  }
}
