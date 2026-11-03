import { ContextMessage } from './types.js';

/**
 * Estimate token count for a pool using the standard formula:
 * For each message: ceil(content.length / 4) + 4
 */
export function estimatePoolTokens(messages: ContextMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += Math.ceil(m.content.length / 4) + 4;
  }
  return total;
}

/**
 * Generate a deterministic summary from compacted messages.
 *
 * @param messages - Messages being compacted
 * @param trigger - Reason for compaction
 * @param poolName - Human-readable pool name
 * @returns Summary content (not a full message object)
 */
export function generateCompactSummary(
  messages: ContextMessage[],
  trigger: string,
  poolName: string
): string {
  const header = `Auto-compact from ${poolName} Pool: ${trigger}`;

  if (messages.length === 0) {
    return header;
  }

  // Extract key content using simple patterns
  const keyLines: string[] = [];

  const patterns: { pattern: RegExp; label: string }[] = [
    { pattern: /^(requirement|req\.?)(?:\s*[#-]?\s*\w+)?:/i, label: 'Requirement' },
    { pattern: /^(architecture|arch|design)(\s+decision)?[:\-—]/i, label: 'Architecture' },
    { pattern: /^(research|finding)(\s+finding)?[:\-—]\s*/i, label: 'Research' },
    { pattern: /^(given\s+.+\s+when\s+.+\s+then\b)/i, label: 'Acceptance' },
    { pattern: /^(acceptance\s+criteria|definition\s+of\s+done)/i, label: 'Acceptance' },
    { pattern: /^decision[:\-—]\s*/i, label: 'Decision' },
  ];

  for (const msg of messages) {
    if (msg.role === 'system') continue; // Skip generated content

    const lines = msg.content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      for (const { pattern, label } of patterns) {
        if (pattern.test(trimmed)) {
          // Truncate long lines
          const display = trimmed.length > 200 ? trimmed.slice(0, 197) + '...' : trimmed;
          keyLines.push(`[${label}] ${display}`);
          break;
        }
      }
    }
  }

  // Deduplicate and limit
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const line of keyLines) {
    const key = line.trim().toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(line);
    }
  }

  const summary = unique.length > 0
    ? `${header}\n\nKey points:\n${unique.slice(0, 10).join('\n')}`
    : header;

  // Truncate to reasonable size
  const maxLen = 2000;
  return summary.length > maxLen ? summary.slice(0, maxLen - 3) + '...' : summary;
}