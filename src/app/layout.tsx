import type { Metadata, Viewport } from 'next';
import { Toaster } from '@/components/ui/Toaster';
import { ServiceWorkerRegistrar } from '@/components/shell/ServiceWorkerRegistrar';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Life OS', template: '%s · Life OS' },
  description: 'Личный адаптивный планировщик: план дня, переработки, еда, сон, тренировки и обзор недели.',
  applicationName: 'Life OS',
  appleWebApp: { capable: true, title: 'Life OS', statusBarStyle: 'default' },
  formatDetection: { telephone: false },
  icons: {
    icon: [{ url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180' }],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f5f2' },
    { media: '(prefers-color-scheme: dark)', color: '#101110' },
  ],
};

// Applies a saved theme override before paint; failures (private mode) fall back to the system theme.
const themeScript = `try{var t=localStorage.getItem('lifeos-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh antialiased">
        <Toaster>{children}</Toaster>
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
