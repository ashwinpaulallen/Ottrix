import type { EvalReport, EvalResult } from './types.js';

/** Options for {@link EvalReporter.toConsole}. */
export interface EvalReporterOptions {
  /** Scores below this threshold are highlighted as failures. @defaultValue 0.5 */
  failureThreshold?: number;
}

/** Formats evaluation reports for console, JSON, Markdown, and CSV output. */
export class EvalReporter {
  private readonly failureThreshold: number;

  constructor(options: EvalReporterOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 0.5;
  }

  /** Pretty-print aggregate and per-entry results to the console. */
  toConsole(report: EvalReport): void {
    const lines: string[] = [];
    lines.push('');
    lines.push(`Evaluation: ${report.name}`);
    lines.push(`Agent: ${report.config.agentName} | Entries: ${report.results.length} | Duration: ${report.duration}ms`);
    lines.push('');

    lines.push('Aggregate scores:');
    lines.push(padRow(['Scorer', 'Mean', 'Median', 'Min', 'Max', 'StdDev', 'Count']));
    lines.push('-'.repeat(72));

    for (const [scorer, aggregate] of Object.entries(report.aggregates)) {
      lines.push(
        padRow([
          scorer,
          formatNumber(aggregate.mean),
          formatNumber(aggregate.median),
          formatNumber(aggregate.min),
          formatNumber(aggregate.max),
          formatNumber(aggregate.stdDev),
          String(aggregate.count),
        ]),
      );
    }

    lines.push('');
    lines.push('Per-entry results:');
    lines.push(padRow(['#', 'Input', 'Error', ...Object.keys(report.aggregates)]));
    lines.push('-'.repeat(96));

    report.results.forEach((result, index) => {
      const scoreCells = Object.keys(report.aggregates).map((scorer) => {
        const score = result.scores[scorer]?.score ?? 0;
        const formatted = formatNumber(score);
        return score < this.failureThreshold ? `${formatted}*` : formatted;
      });

      lines.push(
        padRow([
          String(index + 1),
          truncate(result.entry.input, 28),
          result.error ? 'yes' : 'no',
          ...scoreCells,
        ]),
      );
    });

    lines.push('');
    lines.push(`* scores below ${this.failureThreshold}`);
    console.log(lines.join('\n'));
  }

  /** Return a JSON-serializable copy of the report. */
  toJson(report: EvalReport): string {
    return JSON.stringify(report, null, 2);
  }

  /** Render the report as Markdown tables. */
  toMarkdown(report: EvalReport): string {
    const lines: string[] = [];
    lines.push(`# Evaluation: ${escapeMarkdown(report.name)}`);
    lines.push('');
    lines.push(`- **Agent:** ${escapeMarkdown(report.config.agentName)}`);
    lines.push(`- **Entries:** ${report.results.length}`);
    lines.push(`- **Duration:** ${report.duration}ms`);
    lines.push(`- **Timestamp:** ${new Date(report.timestamp).toISOString()}`);
    lines.push('');

    lines.push('## Aggregate scores');
    lines.push('');
    lines.push('| Scorer | Mean | Median | Min | Max | StdDev | Count |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');

    for (const [scorer, aggregate] of Object.entries(report.aggregates)) {
      lines.push(
        `| ${escapeMarkdown(scorer)} | ${formatNumber(aggregate.mean)} | ${formatNumber(aggregate.median)} | ${formatNumber(aggregate.min)} | ${formatNumber(aggregate.max)} | ${formatNumber(aggregate.stdDev)} | ${aggregate.count} |`,
      );
    }

    lines.push('');
    lines.push('## Results');
    lines.push('');
    const scorerHeaders = Object.keys(report.aggregates);
    lines.push(
      `| # | Input | Error | ${scorerHeaders.map(escapeMarkdown).join(' | ')} |`,
    );
    lines.push(`| ---: | --- | ---: | ${scorerHeaders.map(() => '---:').join(' | ')} |`);

    report.results.forEach((result, index) => {
      const cells = scorerHeaders.map((scorer) => formatNumber(result.scores[scorer]?.score ?? 0));
      lines.push(
        `| ${index + 1} | ${escapeMarkdown(truncate(result.entry.input, 40))} | ${result.error ? 'yes' : 'no'} | ${cells.join(' | ')} |`,
      );
    });

    return lines.join('\n');
  }

  /** Render per-entry scores as CSV. */
  toCsv(report: EvalReport): string {
    const scorerHeaders = Object.keys(report.aggregates);
    const header = ['index', 'input', 'expected', 'output', 'error', 'duration_ms', ...scorerHeaders];
    const rows = [header.map(csvEscape).join(',')];

    report.results.forEach((result, index) => {
      rows.push(formatCsvRow(result, index, scorerHeaders));
    });

    return rows.join('\n');
  }
}

function formatCsvRow(
  result: EvalResult,
  index: number,
  scorerHeaders: string[],
): string {
  return [
    String(index + 1),
    csvEscape(result.entry.input),
    csvEscape(result.entry.expectedOutput ?? ''),
    csvEscape(result.agentOutput.response),
    csvEscape(result.error ?? ''),
    String(result.duration),
    ...scorerHeaders.map((scorer) => formatNumber(result.scores[scorer]?.score ?? 0)),
  ].join(',');
}

function padRow(cells: string[]): string {
  const widths = [4, 30, 8, 10, 10, 10, 10, 10];
  return cells
    .map((cell, index) => cell.padEnd(widths[index] ?? 10))
    .join(' ')
    .trimEnd();
}

function formatNumber(value: number): string {
  return value.toFixed(3);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1)}…`;
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ')
    .replace(/\r/g, ' ')
    .replace(/`/g, '\\`')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/#/g, '\\#')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function csvEscape(value: string): string {
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const escaped = normalized.replace(/"/g, '""');
  if (/[",\n]/.test(escaped) || /^[=+\-@\t]/.test(escaped)) {
    return `"${escaped}"`;
  }
  return escaped;
}

export { csvEscape, escapeMarkdown };
