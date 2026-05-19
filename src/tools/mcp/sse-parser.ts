/** Parsed Server-Sent Event. */
export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

/**
 * Incremental SSE parser for MCP HTTP+SSE transport.
 *
 * Parses `event`, `data`, and `id` fields per the SSE spec.
 */
export class SseParser {
  private buffer = '';
  private currentEvent: Partial<SseEvent> = {};

  /**
   * Feed raw text chunks from the SSE stream.
   *
   * @returns Complete events parsed from the buffer.
   */
  feed(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];

    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }

      if (line === '') {
        if (this.currentEvent.data !== undefined) {
          events.push({
            event: this.currentEvent.event,
            data: this.currentEvent.data,
            id: this.currentEvent.id,
          });
        }
        this.currentEvent = {};
      } else if (line.startsWith(':')) {
        // comment, ignore
      } else {
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) {
          value = value.slice(1);
        }

        switch (field) {
          case 'event':
            this.currentEvent.event = value;
            break;
          case 'data':
            this.currentEvent.data =
              this.currentEvent.data === undefined ? value : `${this.currentEvent.data}\n${value}`;
            break;
          case 'id':
            this.currentEvent.id = value;
            break;
          default:
            break;
        }
      }

      newlineIndex = this.buffer.indexOf('\n');
    }

    return events;
  }
}
