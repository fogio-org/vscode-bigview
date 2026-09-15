import { describe, expect, it } from 'vitest';
import {
  customizationRules,
  jsonColorsFromRules,
  JSON_SCOPES,
  parseJsonc,
  resolveForeground,
  type TokenRule,
} from '../../src/core/textmateTheme';

describe('parseJsonc', () => {
  it('accepts comments, trailing commas and a BOM, leaving strings intact', () => {
    const text = `﻿{
      // line comment
      "name": "a // not a comment, /* nor this */",
      /* block
         comment */
      "list": [1, 2, 3,],
      "nested": { "x": "q\\"uote,}", },
    }`;
    expect(parseJsonc(text)).toEqual({ name: 'a // not a comment, /* nor this */', list: [1, 2, 3], nested: { x: 'q"uote,}' } });
  });

  it('drops a trailing comma followed by comments', () => {
    expect(parseJsonc('{"scope": ["a", "b", // "c",\n /* "d" */\n], "x": 1, /* end */ }')).toEqual({ scope: ['a', 'b'], x: 1 });
  });
});

describe('resolveForeground', () => {
  const rules: TokenRule[] = [
    { scope: 'string', settings: { foreground: '#00aa00' } },
    { scope: ['constant.numeric', 'constant.language'], settings: { foreground: '#0000ff' } },
    { scope: 'support.type.property-name', settings: { foreground: '#aa00aa' } },
    { scope: 'source.json meta.structure.dictionary.value.json constant.language', settings: { foreground: '#ff8800' } },
    { scope: 'string.quoted, invalid', settings: { foreground: 'red' } }, // not a hex color: ignored
    { settings: { foreground: '#123456' } }, // global settings without scope: ignored
  ];

  it('picks the deepest, most specific rule', () => {
    expect(resolveForeground(rules, JSON_SCOPES.key)).toBe('#aa00aa');
    expect(resolveForeground(rules, JSON_SCOPES.string)).toBe('#00aa00');
    expect(resolveForeground(rules, JSON_SCOPES.number)).toBe('#0000ff');
    expect(resolveForeground(rules, JSON_SCOPES.literal)).toBe('#ff8800');
  });

  it('later rules win ties; unmatched kinds stay undefined', () => {
    expect(resolveForeground([...rules, { scope: 'string', settings: { foreground: '#111111' } }], JSON_SCOPES.string)).toBe('#111111');
    expect(jsonColorsFromRules([{ scope: 'constant.numeric.json', settings: { foreground: '#2AACB8' } }])).toEqual({ number: '#2AACB8' });
  });

  it('falls back to a parent scope and requires descendant selectors to match ancestors in order', () => {
    expect(resolveForeground([{ scope: 'source.json', settings: { foreground: '#010101' } }], JSON_SCOPES.key)).toBe('#010101');
    expect(resolveForeground([{ scope: 'source.js string', settings: { foreground: '#020202' } }], JSON_SCOPES.string)).toBeUndefined();
    expect(resolveForeground([{ scope: 'meta.structure.dictionary.value.json source.json string', settings: { foreground: '#030303' } }], JSON_SCOPES.string)).toBeUndefined();
  });
});

describe('customizationRules', () => {
  it('reads simple keys, textMateRules and the section of the active theme', () => {
    const custom = {
      strings: '#aaaaaa',
      '[Dark Theme]': { numbers: { foreground: '#bbbbbb' }, textMateRules: [{ scope: 'support.type.property-name.json', settings: { foreground: '#cccccc' } }] },
      '[Other]': { strings: '#dddddd' },
    };
    const colors = jsonColorsFromRules([{ scope: 'string', settings: { foreground: '#000000' } }, ...customizationRules(custom, 'Dark Theme')]);
    expect(colors).toEqual({ key: '#cccccc', string: '#aaaaaa', number: '#bbbbbb' });
    expect(customizationRules(undefined, 'x')).toEqual([]);
  });
});
