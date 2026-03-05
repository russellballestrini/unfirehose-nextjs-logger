# 2956: Fix blackops tmux session naming

**Status:** closed (fixed)
**Project:** claude-sexy-logger
**Estimated:** 10m
**Todo IDs:** 2956

## Context

Session display names generated from first prompts sometimes show "(blackops session)" instead of meaningful names when the first prompt is a system/identity message rather than an actual user query.

## Plan

1. Check `src/lib/session-name.ts` — the `generateSessionName` function strips XML tags but may not handle the blackops identity preamble
2. Add pattern to skip common preamble patterns (orientation commands, identity blocks) and use the first real user prompt instead
3. Could also check if first_prompt starts with known system patterns and fallback to second message content

## Notes

Quick fix, under 15m. Can be done without human input.
