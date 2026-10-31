import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initI18n } from './lib/i18n'

// Register push notification service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// 번역 파일을 읽은 뒤에 그려서 번역 키가 깜빡이지 않게 한다
// 번역 초기화가 실패해도 앱은 그린다 (키가 그대로 보이더라도 사용은 가능해야 한다)
initI18n()
  .catch((err: unknown) => {
    console.warn('i18n init failed, rendering with fallback', err)
  })
  .finally(() => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
  })
