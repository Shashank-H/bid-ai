const hiddenTag = /^<\s*(\/?)\s*(think|thinking|analysis|reasoning)\b[^>]*>$/i;

/** Hold incomplete tags across chunks so private reasoning never flashes in the UI. */
export class VisibleText {
  private buffer = '';
  private readonly hidden: string[] = [];

  push(text: string): string {
    this.buffer += text;
    let visible = '';

    while (this.buffer) {
      const start = this.buffer.indexOf('<');

      if (start === -1) {
        if (!this.hidden.length) visible += this.buffer;
        this.buffer = '';
        break;
      }

      if (!this.hidden.length) visible += this.buffer.slice(0, start);
      this.buffer = this.buffer.slice(start);
      const end = this.buffer.indexOf('>');

      if (end === -1) {
        // Bound a malicious/incomplete tag; hidden content stays discarded.
        if (this.buffer.length > 256) {
          const hidden = this.buffer.match(/^<\s*(think|thinking|analysis|reasoning)\b/i);
          if (!this.hidden.length && !hidden) visible += this.buffer;
          else if (!this.hidden.length && hidden) this.hidden.push(hidden[1]!.toLowerCase());
          this.buffer = '';
        }
        break;
      }

      const tag = this.buffer.slice(0, end + 1);
      this.buffer = this.buffer.slice(end + 1);
      const match = tag.match(hiddenTag);

      if (match) {
        if (!match[1]) this.hidden.push(match[2]!.toLowerCase());
        else if (this.hidden.at(-1) === match[2]!.toLowerCase()) this.hidden.pop();
      } else if (!this.hidden.length) visible += tag;
    }

    return visible;
  }

  finish(): string {
    const partial = this.buffer.replace(/^<\s*\/?\s*/, '').toLowerCase();
    const incompleteHidden =
      this.buffer.startsWith('<') &&
      ['think', 'thinking', 'analysis', 'reasoning'].some(
        (tag) => tag.startsWith(partial) || partial.startsWith(tag),
      );
    const visible = this.hidden.length || incompleteHidden ? '' : this.buffer;
    this.buffer = '';

    return visible;
  }
}
