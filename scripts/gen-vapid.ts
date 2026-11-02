import webpush from 'web-push';

/**
 * Generates a VAPID key pair for web push:
 *   pnpm vapid
 * Put the output into .env.local / the server environment. The private key is a secret — do not commit it.
 */
const keys = webpush.generateVAPIDKeys();
console.log('# Web push (VAPID) — добавь в .env.local или переменные окружения сервера');
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log('VAPID_SUBJECT=mailto:you@example.com');
console.log('# Приватный ключ — секрет: не коммить его в репозиторий.');
