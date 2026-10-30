import { create } from 'zustand';

type Permission = 'default' | 'granted' | 'denied' | 'unsupported';

interface NotificationState {
  permission: Permission;
  isSubscribed: boolean;
  isLoading: boolean;
  checkPermission: () => void;
  subscribe: () => Promise<void>;
  unsubscribe: () => Promise<void>;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker.ready;
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  permission: !('Notification' in window) ? 'unsupported' : (Notification.permission as Permission),
  isSubscribed: false,
  isLoading: false,

  checkPermission: () => {
    if (!('Notification' in window)) {
      set({ permission: 'unsupported' });
      return;
    }
    const perm = Notification.permission as Permission;
    set({ permission: perm });

    // Check if we have an active subscription
    if (perm === 'granted') {
      getRegistration().then((reg) => {
        if (!reg) return;
        reg.pushManager.getSubscription().then((sub) => {
          set({ isSubscribed: !!sub });
        });
      });
    }
  },

  subscribe: async () => {
    if (get().isLoading) return;
    set({ isLoading: true });

    try {
      // Fetch VAPID key
      const keyRes = await fetch('/push/vapid-key');
      if (!keyRes.ok) throw new Error('Push not configured on server');
      const { vapidPublicKey } = await keyRes.json();

      // Request permission (must be called from user gesture)
      const permission = await Notification.requestPermission();
      set({ permission: permission as Permission });
      if (permission !== 'granted') {
        set({ isLoading: false });
        return;
      }

      // Get SW registration and subscribe
      const reg = await getRegistration();
      if (!reg) throw new Error('Service worker not available');

      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });

      const json = subscription.toJSON();
      const token = localStorage.getItem('token');

      // Send subscription to backend
      const res = await fetch('/push/subscribe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          endpoint: json.endpoint,
          keys: json.keys,
        }),
      });

      if (!res.ok) throw new Error('Failed to register subscription');

      set({ isSubscribed: true, isLoading: false });
    } catch (err) {
      console.error('Push subscription failed:', err);
      set({ isLoading: false });
    }
  },

  unsubscribe: async () => {
    if (get().isLoading) return;
    set({ isLoading: true });

    try {
      const reg = await getRegistration();
      if (!reg) {
        set({ isSubscribed: false, isLoading: false });
        return;
      }

      const subscription = await reg.pushManager.getSubscription();
      if (subscription) {
        const endpoint = subscription.endpoint;
        await subscription.unsubscribe();

        const token = localStorage.getItem('token');
        await fetch('/push/subscribe', {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ endpoint }),
        }).catch(() => {});
      }

      set({ isSubscribed: false, isLoading: false });
    } catch (err) {
      console.error('Push unsubscribe failed:', err);
      set({ isLoading: false });
    }
  },
}));
