import type { DecodeOptions, ToonValue } from './types.js';
import { ToonDecodeError } from './types.js';
import { parseString, parseKey } from '../utils/string.js';

/**
 * Decode TOON format to value
 */
export function decode(toon: string, options: DecodeOptions = {}): ToonValue {
  // Section: Handle empty document
  if (toon.trim() === '') return {};

  const lines = toon.split('\n');
  
  // Section: Check for root-level primitive (single non-empty line)
  const nonEmptyLines = lines.filter(l => l.trim() !== '');
  if (nonEmptyLines.length === 1 && !nonEmptyLines[0].includes(':')) {
    return parsePrimitive(nonEmptyLines[0]);
  }

  // Section: Check for root array (starts with [)
  const firstLine = nonEmptyLines[0];
  if (firstLine.trim().startsWith('[')) {
    const parsed = parseRootArray(firstLine.trim(), lines, 0, options);
    return parsed.value;
  }

  const result = parseLines(lines, 0, options);
  return result.value;
}

interface ParseResult {
  value: ToonValue;
  linesConsumed: number;
}

interface ParseContext {
  options: DecodeOptions;
  inArray: boolean;
}

/**
 * Parse primitive value from string
 */
function parsePrimitive(str: string): ToonValue {
  const trimmed = str.trim();

  // Section: Handle quoted strings
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return parseString(trimmed);
  }

  // Section: Handle keywords
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;

  // Section: Handle numbers (including scientific notation)
  // Don't parse numbers with leading zeros (except 0 itself and 0.x)
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)) {
    // Check for leading zero (but allow 0, 0.x, -0, -0.x)
    if (/^-?0\d/.test(trimmed)) {
      // Leading zero - treat as string
      return trimmed;
    }
    return Number(trimmed);
  }

  // Section: Unquoted string
  return trimmed;
}

/**
 * Get indentation level
 */
function getIndentLevel(line: string): number {
  const match = line.match(/^(\s*)/);
  if (!match) return 0;
  return match[1].length;
}

/**
 * Detect delimiter from bracket notation
 * [3] → ','
 * [3\t] → '\t'
 * [3|] → '|'
 */
function detectDelimiter(bracketContent: string): ',' | '\t' | '|' {
  if (bracketContent.includes('\t')) return '\t';
  if (bracketContent.includes('|')) return '|';
  return ',';
}

/**
 * Parse inline array: key[count<delim>]: val<delim>val<delim>val
 */
function parseInlineArray(
  line: string,
  lineIndex: number
): { key: string; values: ToonValue[]; delimiter: ',' | '\t' | '|' } {
  // Parse key (quoted or unquoted)
  const keyResult = parseKey(line);
  if (!keyResult) {
    throw new ToonDecodeError('Invalid array key', lineIndex);
  }

  const { key, rest } = keyResult;

  // Parse bracket notation [count<delim>]:
  const bracketMatch = rest.match(/^\[([^\]]+)\]:\s*(.*)$/);
  if (!bracketMatch) {
    throw new ToonDecodeError('Invalid inline array format', lineIndex);
  }

  const bracketContent = bracketMatch[1];
  const valueStr = bracketMatch[2];
  const delimiter = detectDelimiter(bracketContent);

  // Parse count
  const countStr = bracketContent.replace(/[\t|]/g, '');
  const count = parseInt(countStr, 10);

  // Handle empty array
  if (count === 0) {
    return { key, values: [], delimiter };
  }

  // Parse values by splitting on delimiter (respecting quotes)
  const values = splitByDelimiter(valueStr, delimiter);

  if (values.length !== count) {
    throw new ToonDecodeError(
      `Array count mismatch: expected ${count}, got ${values.length}`,
      lineIndex
    );
  }

  // Parse each value as primitive
  const parsed = values.map((v) => parsePrimitive(v));

  return { key, values: parsed, delimiter };
}

/**
 * Split string by delimiter, respecting quoted strings
 */
function splitByDelimiter(
  str: string,
  delimiter: ',' | '\t' | '|'
): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;
  let escaped = false;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }

    if (char === '"') {
      current += char;
      inQuotes = !inQuotes;
      continue;
    }

    if (char === delimiter && !inQuotes) {
      values.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  values.push(current.trim());
  return values;
}

/**
 * Parse tabular array
 */
function parseTabular(
  header: string,
  lines: string[],
  startIndex: number,
  options: DecodeOptions
): ParseResult {
  // Parse key first (quoted or unquoted)
  const keyResult = parseKey(header);
  if (!keyResult) {
    throw new ToonDecodeError('Invalid tabular array key', startIndex);
  }

  const { rest } = keyResult;

  // Parse header: [count<delim>]{field1<delim>field2}:
  const match = rest.match(/^\[([^\]]+)\]\{([^}]+)\}:\s*$/);
  if (!match) {
    throw new ToonDecodeError('Invalid tabular array header', startIndex);
  }

  const bracketContent = match[1];
  const keysStr = match[2];
  const delimiter = detectDelimiter(bracketContent);

  // Parse count
  const countStr = bracketContent.replace(/[\t|]/g, '');
  const count = parseInt(countStr, 10);

  // Parse keys (split by delimiter, handle quoted keys)
  const keys = splitByDelimiter(keysStr, delimiter).map((k) =>
    parseString(k)
  );

  const result: Record<string, ToonValue>[] = [];
  let lineIndex = startIndex + 1;

  // Parse rows
  for (let i = 0; i < count; i++) {
    // Skip blank lines
    while (lineIndex < lines.length && lines[lineIndex].trim() === '') {
      // Strict mode: blank lines inside arrays not allowed
      if (options.strict && i > 0 && i < count) {
        throw new ToonDecodeError(
          'Blank lines not allowed inside arrays in strict mode',
          lineIndex + 1
        );
      }
      lineIndex++;
    }

    if (lineIndex >= lines.length) {
      throw new ToonDecodeError(`Expected ${count} rows, got ${i}`, lineIndex);
    }

    const line = lines[lineIndex];
    const values = parseRow(line, keys.length, delimiter);

    if (values.length !== keys.length) {
      throw new ToonDecodeError(
        `Row has ${values.length} values, expected ${keys.length}`,
        lineIndex
      );
    }

    const obj: Record<string, ToonValue> = {};
    for (let j = 0; j < keys.length; j++) {
      obj[keys[j]] = parsePrimitive(values[j]);
    }
    result.push(obj);

    lineIndex++;
  }

  // Section: Validate final count
  if (result.length !== count) {
    throw new ToonDecodeError(
      `Tabular array length mismatch: expected ${count} rows, got ${result.length}`,
      startIndex
    );
  }

  return {
    value: result,
    linesConsumed: lineIndex - startIndex,
  };
}

/**
 * Parse row with delimiter
 */
function parseRow(
  line: string,
  _expectedCount: number,
  delimiter: ',' | '\t' | '|' = ','
): string[] {
  const trimmed = line.trim();
  return splitByDelimiter(trimmed, delimiter);
}

/**
 * Parse root-level array
 */
function parseRootArray(
  header: string,
  lines: string[],
  startIndex: number,
  options: DecodeOptions
): ParseResult {
  // Section: Handle inline root array [count<delim>]: val,val,val
  const inlineMatch = header.match(/^\[([^\]]+)\]:\s*(.+)$/);
  if (inlineMatch) {
    const bracketContent = inlineMatch[1];
    const valueStr = inlineMatch[2];
    const delimiter = detectDelimiter(bracketContent);
    const countStr = bracketContent.replace(/[\t|]/g, '');
    const count = parseInt(countStr, 10);

    if (count === 0) {
      return { value: [], linesConsumed: 1 };
    }

    const values = splitByDelimiter(valueStr, delimiter);
    if (values.length !== count) {
      throw new ToonDecodeError(
        `Array count mismatch: expected ${count}, got ${values.length}`,
        startIndex
      );
    }

    return {
      value: values.map((v) => parsePrimitive(v)),
      linesConsumed: 1,
    };
  }

  // Section: Handle tabular root array [count<delim>]{fields}:
  const tabularMatch = header.match(/^\[([^\]]+)\]\{([^}]+)\}:\s*$/);
  if (tabularMatch) {
    const bracketContent = tabularMatch[1];
    const keysStr = tabularMatch[2];
    const delimiter = detectDelimiter(bracketContent);
    const countStr = bracketContent.replace(/[\t|]/g, '');
    const count = parseInt(countStr, 10);

    const keys = splitByDelimiter(keysStr, delimiter).map((k) =>
      parseString(k)
    );

    const result: Record<string, ToonValue>[] = [];
    let lineIndex = startIndex + 1;

    for (let i = 0; i < count; i++) {
      if (lineIndex >= lines.length) {
        throw new ToonDecodeError(
          `Expected ${count} rows, got ${i}`,
          lineIndex
        );
      }

      const line = lines[lineIndex];
      const values = parseRow(line, keys.length, delimiter);

      if (values.length !== keys.length) {
        throw new ToonDecodeError(
          `Row has ${values.length} values, expected ${keys.length}`,
          lineIndex
        );
      }

      const obj: Record<string, ToonValue> = {};
      for (let j = 0; j < keys.length; j++) {
        obj[keys[j]] = parsePrimitive(values[j]);
      }
      result.push(obj);

      lineIndex++;
    }

    // Section: Validate no extra rows
    if (lineIndex < lines.length) {
      const nextLine = lines[lineIndex];
      if (nextLine.trim() !== '' && getIndentLevel(nextLine) > 0) {
        throw new ToonDecodeError(
          `Tabular array has more rows than declared count ${count}`,
          lineIndex
        );
      }
    }

    return {
      value: result,
      linesConsumed: lineIndex - startIndex,
    };
  }

  // Section: Handle multiline root array [count<delim>]:
  const arrayMatch = header.match(/^\[([^\]]+)\]:\s*$/);
  if (arrayMatch) {
    const bracketContent = arrayMatch[1];
    const countStr = bracketContent.replace(/[\t|]/g, '');
    const count = parseInt(countStr, 10);

    if (count === 0) {
      return { value: [], linesConsumed: 1 };
    }

    // Check if list format
    const nextLineIndex = startIndex + 1;
    if (nextLineIndex < lines.length) {
      const nextLine = lines[nextLineIndex];
      const baseIndent = getIndentLevel(nextLine);
      const content = nextLine.trim();

      if (content.startsWith('- ') || content === '-') {
        return parseListFormat(lines, nextLineIndex, count, baseIndent, options);
      }
    }

    // Regular primitive array
    const result: ToonValue[] = [];
    let lineIndex = startIndex + 1;
    const baseIndent = getIndentLevel(lines[lineIndex]);

    while (result.length < count && lineIndex < lines.length) {
      const line = lines[lineIndex];
      if (line.trim() === '') {
        // Strict mode: blank lines inside arrays not allowed
        if (options.strict && result.length > 0 && result.length < count) {
          throw new ToonDecodeError(
            'Blank lines not allowed inside arrays in strict mode',
            lineIndex + 1
          );
        }
        lineIndex++;
        continue;
      }

      const indent = getIndentLevel(line);
      if (indent < baseIndent) break;

      const value = parsePrimitive(line);
      result.push(value);
      lineIndex++;
    }

    return {
      value: result,
      linesConsumed: lineIndex - startIndex,
    };
  }

  throw new ToonDecodeError('Invalid root array format', startIndex);
}

/**
 * Parse list format array (with hyphens)
 */
function parseListFormat(
  lines: string[],
  startIndex: number,
  count: number,
  baseIndent: number,
  options: DecodeOptions
): ParseResult {
  const result: ToonValue[] = [];
  let lineIndex = startIndex;

  while (result.length < count && lineIndex < lines.length) {
    const line = lines[lineIndex];
    
    // Check for blank lines
    if (line.trim() === '') {
      // In strict mode, blank lines inside arrays are not allowed
      if (options.strict && result.length > 0 && result.length < count) {
        throw new ToonDecodeError(
          'Blank lines not allowed inside arrays in strict mode',
          lineIndex + 1
        );
      }
      lineIndex++;
      continue;
    }

    const indent = getIndentLevel(line);
    const content = line.trim();

    // Check for list item marker
    if (indent === baseIndent && content.startsWith('- ')) {
      const itemContent = content.slice(2).trim();

      // Section: Handle empty list item
      if (itemContent === '') {
        result.push({});
        lineIndex++;
        continue;
      }

      // Section: Handle inline array as list item
      if (itemContent.match(/^\[[^\]]+\]:/)) {
        const parsed = parseRootArray(itemContent, lines, lineIndex, options);
        result.push(parsed.value);
        lineIndex += parsed.linesConsumed;
        continue;
      }

      // Section: Handle object with first field on hyphen line
      if (itemContent.includes(':')) {
        const obj: Record<string, ToonValue> = {};
        
        // Section: Check if first field is an inline array
        if (itemContent.match(/^("([^"\\]|\\.)*"|\w+)\[[^\]]+\]:\s*\S+/)) {
          const parsed = parseInlineArray(itemContent, lineIndex);
          obj[parsed.key] = parsed.values;
          lineIndex++;
        }
        // Section: Check if first field is tabular array
        else if (itemContent.match(/^("([^"\\]|\\.)*"|\w+)\[[^\]]+\]\{[^}]+\}:\s*$/)) {
          const keyResult = parseKey(itemContent);
          if (keyResult) {
            // Create temporary lines array for nested parsing
            const tempLines = lines.slice(lineIndex);
            const parsed = parseTabular(itemContent, lines, lineIndex, options);
            obj[keyResult.key] = parsed.value;
            lineIndex += parsed.linesConsumed;
          } else {
            lineIndex++;
          }
        }
        // Section: Check if first field is multiline array
        else if (itemContent.match(/^("([^"\\]|\\.)*"|\w+)\[[^\]]+\]:\s*$/)) {
          const keyResult = parseKey(itemContent);
          if (keyResult) {
            const parsed = parseArray(itemContent, lines, lineIndex, options);
            obj[keyResult.key] = parsed.value;
            lineIndex += parsed.linesConsumed;
          } else {
            lineIndex++;
          }
        }
        // Section: Regular key-value field
        else {
          const keyResult = parseKey(itemContent);
          if (keyResult) {
            const { key, rest } = keyResult;
            const colonMatch = rest.match(/^:\s*(.*)$/);
            
            if (colonMatch) {
              const valueStr = colonMatch[1].trim();

              if (valueStr === '') {
                // First field has nested value
                const nestedStart = lineIndex + 1;
                const nested = parseLines(lines, nestedStart, options);
                obj[key] = nested.value;
                lineIndex = nestedStart + nested.linesConsumed;
              } else {
                // First field has inline value
                obj[key] = parsePrimitive(valueStr);
                lineIndex++;
              }
            } else {
              lineIndex++;
            }
          } else {
            lineIndex++;
          }
        }

        // Parse additional fields at deeper indent
        while (lineIndex < lines.length) {
          const nextLine = lines[lineIndex];
          if (nextLine.trim() === '') {
            lineIndex++;
            continue;
          }

          const nextIndent = getIndentLevel(nextLine);
          if (nextIndent <= baseIndent) break;

          const nextContent = nextLine.trim();
          
          // Section: Check if field is inline array
          if (nextContent.match(/^("([^"\\]|\\.)*"|\w+)\[[^\]]+\]:\s*\S+/)) {
            const parsed = parseInlineArray(nextContent, lineIndex);
            obj[parsed.key] = parsed.values;
            lineIndex++;
            continue;
          }
          
          // Section: Check if field is tabular array
          if (nextContent.match(/^("([^"\\]|\\.)*"|\w+)\[[^\]]+\]\{[^}]+\}:\s*$/)) {
            const keyResult = parseKey(nextContent);
            if (keyResult) {
              const parsed = parseTabular(nextContent, lines, lineIndex, options);
              obj[keyResult.key] = parsed.value;
              lineIndex += parsed.linesConsumed;
            } else {
              break;
            }
            continue;
          }
          
          // Section: Check if field is multiline array
          if (nextContent.match(/^("([^"\\]|\\.)*"|\w+)\[[^\]]+\]:\s*$/)) {
            const keyResult = parseKey(nextContent);
            if (keyResult) {
              const parsed = parseArray(nextContent, lines, lineIndex, options);
              obj[keyResult.key] = parsed.value;
              lineIndex += parsed.linesConsumed;
            } else {
              break;
            }
            continue;
          }

          // Section: Regular key-value field
          const nextKeyResult = parseKey(nextContent);
          if (!nextKeyResult) break;

          const { key: nextKey, rest: nextRest } = nextKeyResult;
          const nextColonMatch = nextRest.match(/^:\s*(.*)$/);
          if (!nextColonMatch) break;

          const nextValueStr = nextColonMatch[1].trim();
          if (nextValueStr === '') {
            const nestedStart = lineIndex + 1;
            const nested = parseLines(lines, nestedStart, options);
            obj[nextKey] = nested.value;
            lineIndex = nestedStart + nested.linesConsumed;
          } else {
            obj[nextKey] = parsePrimitive(nextValueStr);
            lineIndex++;
          }
        }

        result.push(obj);
        continue;
      }

      // Section: Handle primitive value
      result.push(parsePrimitive(itemContent));
      lineIndex++;
      continue;
    }

    // Handle hyphen alone on line
    if (indent === baseIndent && content === '-') {
      result.push({});
      lineIndex++;
      continue;
    }

    // Unexpected content
    lineIndex++;
  }

  // Section: Validate final count
  if (result.length !== count) {
    throw new ToonDecodeError(
      `Array length mismatch: expected ${count}, got ${result.length}`,
      startIndex
    );
  }

  return {
    value: result,
    linesConsumed: lineIndex - startIndex,
  };
}

/**
 * Parse array declaration
 */
function parseArray(
  header: string,
  lines: string[],
  startIndex: number,
  options: DecodeOptions
): ParseResult {
  // Check if tabular format
  if (header.includes('{')) {
    return parseTabular(header, lines, startIndex, options);
  }

  // Parse key and bracket notation
  const keyResult = parseKey(header);
  if (!keyResult) {
    throw new ToonDecodeError('Invalid array header', startIndex);
  }

  const { rest } = keyResult;
  const bracketMatch = rest.match(/^\[([^\]]+)\]:\s*$/);
  if (!bracketMatch) {
    throw new ToonDecodeError('Invalid array header format', startIndex);
  }

  const bracketContent = bracketMatch[1];
  const countStr = bracketContent.replace(/[\t|]/g, '');
  const count = parseInt(countStr, 10);

  if (count === 0) {
    return { value: [], linesConsumed: 1 };
  }

  // Check if next line uses list format (starts with hyphen)
  const nextLineIndex = startIndex + 1;
  if (nextLineIndex < lines.length) {
    const nextLine = lines[nextLineIndex];
    const baseIndent = getIndentLevel(nextLine);
    const content = nextLine.trim();

    if (content.startsWith('- ') || content === '-') {
      return parseListFormat(lines, nextLineIndex, count, baseIndent, options);
    }
  }

  // Regular primitive array
  const result: ToonValue[] = [];
  let lineIndex = startIndex + 1;
  const baseIndent = getIndentLevel(lines[lineIndex]);

  while (result.length < count && lineIndex < lines.length) {
    const line = lines[lineIndex];
    if (line.trim() === '') {
      // Strict mode: blank lines inside arrays not allowed
      if (options.strict && result.length > 0 && result.length < count) {
        throw new ToonDecodeError(
          'Blank lines not allowed inside arrays in strict mode',
          lineIndex + 1
        );
      }
      lineIndex++;
      continue;
    }

    const indent = getIndentLevel(line);
    if (indent < baseIndent) break;

    const value = parsePrimitive(line);
    result.push(value);
    lineIndex++;
  }

  return {
    value: result,
    linesConsumed: lineIndex - startIndex,
  };
}

/**
 * Parse lines into value
 */
function parseLines(
  lines: string[],
  startIndex: number,
  options: DecodeOptions
): ParseResult {
  let lineIndex = startIndex;
  const result: Record<string, ToonValue> = {};

  // Section: Find base indentation
  let baseIndent = -1;
  for (let i = startIndex; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      baseIndent = getIndentLevel(lines[i]);
      break;
    }
  }

  if (baseIndent === -1) {
    return { value: null, linesConsumed: 0 };
  }

  while (lineIndex < lines.length) {
    const line = lines[lineIndex];

    // Skip blank lines
    if (line.trim() === '') {
      lineIndex++;
      continue;
    }

    const indent = getIndentLevel(line);

    // End of current object
    if (indent < baseIndent && lineIndex > startIndex) {
      break;
    }

    // Only process lines at current indent level
    if (indent !== baseIndent) {
      lineIndex++;
      continue;
    }

    const content = line.trim();

    // Section: Handle inline arrays (with values after colon)
    if (content.match(/^("([^"\\]|\\.)*"|\w+)\[[^\]]+\]:\s*\S+/)) {
      const parsed = parseInlineArray(content, lineIndex);
      result[parsed.key] = parsed.values;
      lineIndex++;
      continue;
    }

    // Section: Handle tabular arrays
    if (content.match(/^("([^"\\]|\\.)*"|\w+)\[[^\]]+\]\{[^}]+\}:\s*$/)) {
      const parsed = parseTabular(content, lines, lineIndex, options);
      const keyResult = parseKey(content);
      if (keyResult) {
        result[keyResult.key] = parsed.value;
      }
      lineIndex += parsed.linesConsumed;
      continue;
    }

    // Section: Handle arrays (multiline)
    if (content.match(/^("([^"\\]|\\.)*"|\w+)\[[^\]]+\]:\s*$/)) {
      const parsed = parseArray(content, lines, lineIndex, options);
      const keyResult = parseKey(content);
      if (keyResult) {
        result[keyResult.key] = parsed.value;
      }
      lineIndex += parsed.linesConsumed;
      continue;
    }

    // Section: Handle key: value
    if (content.includes(':')) {
      const keyResult = parseKey(content);
      if (!keyResult) {
        lineIndex++;
        continue;
      }

      const { key, rest } = keyResult;
      const colonMatch = rest.match(/^:\s*(.*)$/);
      if (!colonMatch) {
        lineIndex++;
        continue;
      }

      const valueStr = colonMatch[1].trim();

      if (valueStr === '') {
        // Nested object
        const nestedStart = lineIndex + 1;
        const nested = parseLines(lines, nestedStart, options);
        result[key] = nested.value;
        lineIndex = nestedStart + nested.linesConsumed;
      } else {
        // Primitive value
        result[key] = parsePrimitive(valueStr);
        lineIndex++;
      }
      continue;
    }

    // Standalone value (shouldn't happen in well-formed TOON)
    lineIndex++;
  }

  // Section: Return result
  const keys = Object.keys(result);
  if (keys.length === 0) {
    return { value: null, linesConsumed: lineIndex - startIndex };
  }

  return { value: result, linesConsumed: lineIndex - startIndex };
}
