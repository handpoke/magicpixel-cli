import { describe, expect, it } from 'vitest';
import { describeWorkingSet } from '../src/commands/connect.js';

describe('describeWorkingSet', () => {
  it('translates ** into plain language', () => {
    expect(describeWorkingSet('**')).toBe('all sprites in your game');
    expect(describeWorkingSet('**/*.png')).toBe('all sprites in your game');
  });

  it('leaves a specific folder glob as-is', () => {
    expect(describeWorkingSet('Sprites/Hero/**')).toBe('Sprites/Hero/**');
  });
});
