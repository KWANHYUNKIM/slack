import { create } from 'zustand';

export interface Toast {
  id: number;
  message: string;
  kind: 'success' | 'error';
}

interface ToastState {
  toasts: Toast[];
  show: (message: string, kind?: Toast['kind']) => void;
  dismiss: (id: number) => void;
}

const TOAST_MS = 2500;
let nextId = 1;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  show: (message, kind = 'success') => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }));
    setTimeout(() => get().dismiss(id), TOAST_MS);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));
