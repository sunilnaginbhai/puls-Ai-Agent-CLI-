import { Chalk } from 'chalk';
import { sanitizeOutput } from './sanitize.js';

function cellWidth(grapheme) {
    if (/^[\p{Mark}\u200d\ufe0e\ufe0f]+$/u.test(grapheme)) return 0;
    return /[\p{Extended_Pictographic}\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff01-\uff60\uffe0-\uffe6]/u.test(grapheme) ? 2 : 1;
}

function clip(text, width) {
    let used = 0;
    let result = '';
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(sanitizeOutput(text).replace(/\n/g, ' '))) {
        const cells = cellWidth(segment);
        if (used + cells > width) return result;
        result += segment;
        used += cells;
    }
    return result;
}

/** Own only the transient lines below readline and always restore its cursor. */
export class CommandMenu {
    constructor({ output, readline }) {
        this.output = output;
        this.readline = readline;
        this.visible = false;
    }

    position() {
        const current = this.readline.getCursorPos();
        const cursor = this.readline.cursor;
        this.readline.cursor = this.readline.line.length;
        const end = this.readline.getCursorPos();
        this.readline.cursor = cursor;
        return { down: Math.max(1, end.rows - current.rows + 1), column: current.cols, endRows: end.rows };
    }

    hide() {
        if (!this.visible) return;
        const { down, column } = this.position();
        this.output.write(`\u001b[${down}B\r\u001b[J\u001b[${down}A${column ? `\u001b[${column}C` : ''}`);
        this.visible = false;
    }

    render(matches, selected = 0) {
        this.hide();
        const columns = Math.max(8, Number(this.output.columns) || 80);
        const { down, column, endRows } = this.position();
        const capacity = Math.max(1, Math.min(18, (Number(this.output.rows) || 24) - endRows - 4));
        const first = Math.max(0, Math.min(selected - Math.floor(capacity / 2), matches.length - capacity));
        const visible = matches.slice(first, first + capacity);
        const color = new Chalk({ level: this.output.isTTY && !('NO_COLOR' in process.env) && !('NODE_DISABLE_COLORS' in process.env) && process.env.FORCE_COLOR !== '0' ? 1 : 0 });
        const nameWidth = Math.min(15, Math.max(8, ...visible.map((command) => command.name.length + 2)));
        const rows = visible.length ? visible.map((command, offset) => {
            const active = first + offset === selected;
            const text = clip(`${active ? '>' : ' '} ${command.name.padEnd(nameWidth)}${command.description}`, columns - 1);
            return active ? color.cyan.bold(text) : color.dim(text);
        }) : [color.dim(clip('  No matching commands', columns - 1))];
        const range = matches.length > capacity ? `  ${first + 1}-${first + visible.length}/${matches.length}` : '';
        rows.push(color.dim(clip(`  ↑↓ select · Enter choose · Tab fill · Esc close${range}`, columns - 1)));
        const distance = down + rows.length - 1;
        // Newlines reserve space and scroll when the prompt is already on the
        // terminal's bottom row. Cursor-down alone clamps there and would let
        // the first suggestion overwrite the command being edited.
        this.output.write(`${'\n'.repeat(down)}\r${rows.join('\r\n')}\r\u001b[${distance}A${column ? `\u001b[${column}C` : ''}`);
        this.visible = true;
        this.visibleCount = visible.length;
    }
}
