import { FileText, Pin } from 'lucide-react';
import { cn } from '@/lib/utils';

const headerTabs = [
  { id: 'files' as const, label: 'Files', icon: FileText },
  { id: 'pins' as const, label: 'Pins', icon: Pin },
];

interface HeaderTabsProps {
  showPins?: boolean;
  showFiles?: boolean;
  onTogglePins?: () => void;
  onToggleFiles?: () => void;
  testIdPrefix?: string;
}

export function HeaderTabs({ showPins, showFiles, onTogglePins, onToggleFiles, testIdPrefix = '' }: HeaderTabsProps) {
  const prefix = testIdPrefix ? `${testIdPrefix}-` : '';

  return (
    <div className="flex items-center gap-0.5 px-4 pb-[6px]">
      {headerTabs.map((tab) => (
        <button
          key={tab.id}
          data-testid={`${prefix}header-tab-${tab.id}`}
          onClick={() => {
            if (tab.id === 'pins') onTogglePins?.();
            if (tab.id === 'files') onToggleFiles?.();
          }}
          className={cn(
            'flex items-center gap-1 rounded px-2 py-[3px] text-[13px] transition-colors',
            (tab.id === 'pins' && showPins) || (tab.id === 'files' && showFiles)
              ? 'bg-slack-active-tab text-slack-primary font-medium'
              : 'text-slack-secondary hover:bg-slack-hover hover:text-slack-primary'
          )}
        >
          <tab.icon className="h-[14px] w-[14px]" />
          <span>{tab.label}</span>
        </button>
      ))}
    </div>
  );
}
