import { describe, expect, it } from 'vitest';
import { matchGlob } from '../src/util/globMatch.js';

describe('matchGlob', () => {
  it('matches an exact relative path case-insensitively', () => {
    expect(matchGlob('Assets/UI/hud.png', 'Assets/UI/hud.png')).toBe(true);
    expect(matchGlob('assets/ui/hud.png', 'Assets/UI/hud.png')).toBe(true);
    expect(matchGlob('Assets/UI/other.png', 'Assets/UI/hud.png')).toBe(false);
  });

  it('matches ** across folders and * within a segment', () => {
    expect(matchGlob('Assets/Sprites/Hero/idle.png', 'Sprites/Hero/**')).toBe(false);
    expect(matchGlob('Assets/Sprites/Hero/idle.png', 'Assets/Sprites/Hero/**')).toBe(true);
    expect(matchGlob('Sprites/Hero/idle.png', 'Sprites/Hero/**')).toBe(true);
    expect(matchGlob('Assets/Sprites/hero.png', 'Assets/Sprites/*.png')).toBe(true);
    expect(matchGlob('Assets/Sprites/Hero/idle.png', 'Assets/Sprites/*.png')).toBe(false);
  });
});
