import { describe, it, expect } from 'vitest';
import { generateSessionName } from './session-name';

const UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

describe('generateSessionName', () => {
  it('returns first 8 chars of UUID when prompt is null', () => {
    expect(generateSessionName(null, UUID)).toBe(UUID.slice(0, 8));
  });

  it('returns first 8 chars of UUID when prompt is empty string', () => {
    expect(generateSessionName('', UUID)).toBe(UUID.slice(0, 8));
  });

  it('returns the prompt unchanged when it is short', () => {
    expect(generateSessionName('Fix the auth bug', UUID)).toBe('Fix the auth bug');
  });

  it('returns prompt unchanged when exactly 60 chars', () => {
    const exactly60 = 'A'.repeat(60);
    expect(generateSessionName(exactly60, UUID)).toBe(exactly60);
  });

  it('truncates long prompts at word boundary and appends ...', () => {
    const long = 'Refactor the authentication module to use JWT tokens instead of session cookies for scalability';
    const result = generateSessionName(long, UUID);
    expect(result.endsWith('...')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(63); // 60 chars + '...'
  });

  it('truncates at 60 chars when no word boundary found', () => {
    const noSpaces = 'A'.repeat(80);
    const result = generateSessionName(noSpaces, UUID);
    expect(result).toBe('A'.repeat(60) + '...');
  });

  it('strips system-reminder XML tags and their content', () => {
    const prompt = '<system-reminder>You are an agent.\nIgnore this.</system-reminder>Write a poem';
    const result = generateSessionName(prompt, UUID);
    expect(result).toBe('Write a poem');
    expect(result).not.toContain('system-reminder');
    expect(result).not.toContain('You are an agent');
  });

  it('strips generic XML-like tags but keeps content', () => {
    const prompt = '<context>some data</context>Help me debug this';
    const result = generateSessionName(prompt, UUID);
    expect(result).not.toContain('<context>');
    expect(result).toContain('Help me debug this');
  });

  it('strips "Please " prefix', () => {
    expect(generateSessionName('Please help me write tests', UUID)).toBe('help me write tests');
  });

  it('strips "Can you " prefix', () => {
    expect(generateSessionName('Can you review this PR?', UUID)).toBe('review this PR?');
  });

  it('strips "Could you " prefix', () => {
    expect(generateSessionName('Could you fix the failing tests', UUID)).toBe('fix the failing tests');
  });

  it('strips "I want you to " prefix', () => {
    expect(generateSessionName('I want you to refactor this', UUID)).toBe('refactor this');
  });

  it('strips "I need you to " prefix', () => {
    expect(generateSessionName('I need you to write a migration', UUID)).toBe('write a migration');
  });

  it('collapses newlines to spaces', () => {
    const multiline = 'First line\nSecond line\nThird line';
    const result = generateSessionName(multiline, UUID);
    expect(result).not.toContain('\n');
    expect(result).toContain('First line');
  });

  it('falls back to UUID slice when only XML tags present', () => {
    const prompt = '<system-reminder>All content here</system-reminder>';
    expect(generateSessionName(prompt, UUID)).toBe(UUID.slice(0, 8));
  });

  it('trims leading/trailing whitespace', () => {
    expect(generateSessionName('  Write unit tests  ', UUID)).toBe('Write unit tests');
  });
});
