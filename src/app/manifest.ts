import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Life OS',
    short_name: 'Life OS',
    description: 'Личный адаптивный планировщик жизни',
    lang: 'ru',
    start_url: '/today',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f5f5f2',
    theme_color: '#2f6151',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Сегодня', url: '/today' },
      { name: 'Нужно поработать', url: '/today?extra=1' },
      { name: 'Быстрый ввод', url: '/today?capture=1' },
    ],
  };
}
