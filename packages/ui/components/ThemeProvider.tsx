'use client';

import { useEffect } from 'react';
import useSWR from 'swr';

const fetcher = (url: string) => fetch(url).then((r) => r.json());

/**
 * Loads accent color from settings and applies it as a CSS variable override.
 * Renders nothing visible — just applies the theme.
 */
export function ThemeProvider() {
  const { data: settings } = useSWR('/api/settings', fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 60000,
  });

  const accent = settings?.theme_accent_color;

  // Apply light/dark mode from localStorage on mount
  useEffect(() => {
    const light = localStorage.getItem('unfirehose_light_mode') === 'true';
    document.documentElement.classList.toggle('light', light);
    document.documentElement.classList.toggle('dark', !light);
  }, []);

  useEffect(() => {
    if (!accent) return;
    document.documentElement.style.setProperty('--color-accent', accent);
    document.documentElement.style.setProperty('--color-assistant', accent);
    document.documentElement.style.setProperty('--selection-accent', accent + '40');

    return () => {
      document.documentElement.style.removeProperty('--color-accent');
      document.documentElement.style.removeProperty('--color-assistant');
      document.documentElement.style.removeProperty('--selection-accent');
    };
  }, [accent]);

  return null;
}
